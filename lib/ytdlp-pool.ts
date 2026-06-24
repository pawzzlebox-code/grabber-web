// Pool of long-running Python workers with yt_dlp pre-imported. Eliminates
// the Python interpreter + extractor-load cold-start (~500-1000ms) that the
// previous per-download `spawn('yt-dlp', ...)` path paid for every time.
//
// Communication is JSON-per-line over stdin/stdout. Each worker handles one
// download at a time; when all are busy, new jobs are queued.

import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import path from 'path'

const WORKER_SCRIPT = path.join(process.cwd(), 'workers', 'ytdlp_worker.py')
const POOL_SIZE = parseInt(process.env.YTDLP_POOL_SIZE || '2', 10)

export interface DownloadCommand {
  job_id: string
  url: string
  format: string
  outtmpl: string
  proxy?: string
  cookies?: string
  playlist_items?: string | number
  no_playlist: boolean
  // When true, the worker adds an FFmpegExtractAudio postprocessor so the
  // output is MP3 (192 kbps) instead of the raw audio container yt-dlp
  // would otherwise download (webm/m4a). Required for CapCut compatibility.
  audio_only?: boolean
}

export interface ProgressMsg {
  percent: number
  speed_bps: number
  eta: number
  total_bytes: number
  downloaded_bytes: number
}

// Metadata-only extraction command (no download). Routed through the same
// warm worker so it skips the cold Python+extractor startup a CLI spawn pays.
export interface ExtractInfoCommand {
  job_id: string
  url: string
  proxy?: string
  cookies?: string
  no_playlist: boolean
}

export interface WorkerMsg {
  type: 'ready' | 'status' | 'progress' | 'done' | 'error' | 'pong' | 'info'
  job_id?: string | null
  message?: string
  filepath?: string
  traceback?: string
  percent?: number
  speed_bps?: number
  eta?: number
  total_bytes?: number
  downloaded_bytes?: number
  info?: any
}

export interface JobCallbacks {
  onStatus?: (message: string) => void
  onProgress?: (p: ProgressMsg) => void
  onInfo?: (info: any) => void        // extract_info result
  onDone?: (filepath: string) => void // download result
  onError: (message: string, traceback?: string) => void
}

interface PooledWorker {
  proc: ChildProcessWithoutNullStreams
  ready: boolean
  busy: boolean
  currentJobId: string | null
  currentCb: JobCallbacks | null
  buffer: string
}

interface QueuedJob {
  jobId: string
  wire: string // pre-serialized JSON line to write to the worker's stdin
  cb: JobCallbacks
}

const workers: PooledWorker[] = []
const queue: QueuedJob[] = []

function spawnOne(): PooledWorker {
  const proc = spawn('python3', ['-u', WORKER_SCRIPT], {
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  })
  const w: PooledWorker = {
    proc,
    ready: false,
    busy: false,
    currentJobId: null,
    currentCb: null,
    buffer: '',
  }

  proc.stdout.on('data', (chunk: Buffer) => {
    w.buffer += chunk.toString('utf-8')
    const lines = w.buffer.split('\n')
    w.buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let msg: WorkerMsg
      try {
        msg = JSON.parse(trimmed)
      } catch {
        console.error('[ytdlp-worker] bad line:', trimmed.slice(0, 200))
        continue
      }
      handleMessage(w, msg)
    }
  })

  proc.stderr.on('data', (chunk: Buffer) => {
    // Python tracebacks / import warnings — keep visible in server logs
    const text = chunk.toString('utf-8').trim()
    if (text) console.error('[ytdlp-worker:stderr]', text)
  })

  proc.on('exit', (code, signal) => {
    console.error(`[ytdlp-worker] died code=${code} signal=${signal}`)
    const idx = workers.indexOf(w)
    if (idx >= 0) workers.splice(idx, 1)
    // If a job was in flight, fail it — Node-level retry in downloads.ts can
    // re-dispatch from scratch.
    if (w.currentCb) {
      try {
        w.currentCb.onError(`worker exited code=${code} signal=${signal}`)
      } catch {}
    }
    // Respawn to keep the pool at capacity
    setTimeout(() => {
      workers.push(spawnOne())
      drainQueue()
    }, 500)
  })

  return w
}

function handleMessage(w: PooledWorker, msg: WorkerMsg) {
  if (msg.type === 'ready') {
    w.ready = true
    drainQueue()
    return
  }
  const cb = w.currentCb
  if (!cb) return // stray message

  switch (msg.type) {
    case 'status':
      cb.onStatus?.(msg.message || '')
      break
    case 'progress':
      cb.onProgress?.({
        percent: msg.percent || 0,
        speed_bps: msg.speed_bps || 0,
        eta: msg.eta || 0,
        total_bytes: msg.total_bytes || 0,
        downloaded_bytes: msg.downloaded_bytes || 0,
      })
      break
    case 'info':
      cb.onInfo?.(msg.info)
      finishJob(w)
      break
    case 'done':
      cb.onDone?.(msg.filepath || '')
      finishJob(w)
      break
    case 'error':
      cb.onError(msg.message || 'unknown error', msg.traceback)
      finishJob(w)
      break
  }
}

function finishJob(w: PooledWorker) {
  w.busy = false
  w.currentJobId = null
  w.currentCb = null
  drainQueue()
}

function drainQueue() {
  while (queue.length > 0) {
    const free = workers.find(x => x.ready && !x.busy)
    if (!free) return
    const job = queue.shift()!
    dispatchTo(free, job.jobId, job.wire, job.cb)
  }
}

function dispatchTo(w: PooledWorker, jobId: string, wire: string, cb: JobCallbacks) {
  w.busy = true
  w.currentJobId = jobId
  w.currentCb = cb
  try {
    w.proc.stdin.write(wire)
  } catch (err: any) {
    cb.onError(`worker stdin write failed: ${err?.message || err}`)
    finishJob(w)
  }
}

// Shared enqueue/dispatch for any command type. Returns a cancel function.
function submit(jobId: string, wire: string, cb: JobCallbacks): () => void {
  ensureInitialized()
  const free = workers.find(w => w.ready && !w.busy)
  if (free) {
    dispatchTo(free, jobId, wire, cb)
    return () => {
      if (free.currentJobId === jobId) {
        try { free.proc.kill('SIGKILL') } catch {}
      }
    }
  }
  queue.push({ jobId, wire, cb })
  return () => {
    const idx = queue.findIndex(q => q.jobId === jobId)
    if (idx >= 0) {
      queue.splice(idx, 1)
    } else {
      const assigned = workers.find(w => w.currentJobId === jobId)
      if (assigned) {
        try { assigned.proc.kill('SIGKILL') } catch {}
      }
    }
  }
}

let initialized = false
function ensureInitialized() {
  if (initialized) return
  initialized = true
  for (let i = 0; i < POOL_SIZE; i++) {
    workers.push(spawnOne())
  }
  console.log(`[ytdlp-pool] spawned ${POOL_SIZE} workers`)
}

/**
 * Dispatch a download to an idle worker, or queue if none are free.
 * Returns a cancel function that kills the worker assigned to this job
 * (forcing a respawn) — matches the previous CLI-kill behavior.
 */
export function dispatchDownload(cmd: DownloadCommand, cb: JobCallbacks): () => void {
  return submit(cmd.job_id, JSON.stringify({ type: 'download', ...cmd }) + '\n', cb)
}

/** Metadata-only extraction through the warm worker. cb.onInfo gets the info. */
export function dispatchExtractInfo(cmd: ExtractInfoCommand, cb: JobCallbacks): () => void {
  return submit(cmd.job_id, JSON.stringify({ type: 'extract_info', ...cmd }) + '\n', cb)
}

export function poolStats() {
  return {
    size: workers.length,
    ready: workers.filter(w => w.ready).length,
    busy: workers.filter(w => w.busy).length,
    queued: queue.length,
  }
}
