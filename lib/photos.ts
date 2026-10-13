// gallery-dl integration for the droplet — sister to lib/downloads.ts.
// Spawns gallery-dl, captures the saved-file paths as it works, exposes a
// PhotoJob state machine that the API routes serve.
//
// Output convention: gallery-dl prints "# <abs path>" per file it saves to
// stdout. We collect those paths, expose them to the client, and let the
// client fetch each via /api/photos/:id/file/:index.

import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

export interface PhotoFile {
  name: string
  size: number
  fullPath: string
  kind: 'photo' | 'video'
  // Videos only, from ffprobe shortly after the file lands. The phone uses the
  // codec to decide whether iOS Photos needs a re-encode (VP9/AV1 → H.264).
  codec?: string
  duration?: number
  // A 32px square preview, so the phone can draw the item's tile (pixelated,
  // scanning in) before the full file has arrived. Videos also get a poster
  // frame for the finished tile, since an <img> can't show an MP4.
  thumbPath?: string
  posterPath?: string
}

export interface PhotoJob {
  id: string
  url: string
  // 'done' is only set once every file has been probed and previewed — the
  // client stops polling at 'done', and needs each video's codec by then.
  status: 'downloading' | 'done' | 'error'
  files: PhotoFile[]
  error?: string
  createdAt: number
  proc?: ChildProcess
  // From gallery-dl's per-file metadata (--write-metadata).
  author?: string     // "@handle"
  site?: string       // gallery-dl category: instagram, twitter, …
  expected?: number   // items the post claims to have — a hint, it can overcount
  // Serialises ffprobe/ffmpeg work for this job: the droplet has one vCPU and
  // a carousel can land several files at once.
  prep?: Promise<void>
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv'])

const photoJobs = new Map<string, PhotoJob>()
const PHOTOS_DIR = path.join(os.tmpdir(), 'grabber-photos')
const COOKIE_FILE = path.join(os.tmpdir(), 'grabber-downloads', 'cookies.txt')

if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true })

// Cleanup old job dirs every 10 min; matches the existing downloads sweeper.
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000
setInterval(() => {
  if (!fs.existsSync(PHOTOS_DIR)) return
  const now = Date.now()
  let entries: string[]
  try { entries = fs.readdirSync(PHOTOS_DIR) } catch { return }
  for (const name of entries) {
    const full = path.join(PHOTOS_DIR, name)
    let stat: fs.Stats
    try { stat = fs.statSync(full) } catch { continue }
    if (now - stat.mtimeMs < ORPHAN_MAX_AGE_MS) continue
    try {
      fs.rmSync(full, { recursive: true, force: true })
      console.log(`[photos-sweeper] deleted ${name}`)
    } catch {}
  }
}, 10 * 60 * 1000)

// Total bytes used by the photos temp dir (recursive). Scoped to PHOTOS_DIR.
export function photosDirBytes(): number {
  let total = 0
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else { try { total += fs.statSync(full).size } catch {} }
    }
  }
  if (fs.existsSync(PHOTOS_DIR)) walk(PHOTOS_DIR)
  return total
}

// Manual reclaim — delete every photo job dir EXCEPT ones still downloading.
// Scoped strictly to PHOTOS_DIR. Returns bytes freed.
export function reclaimPhotoSpace(): number {
  let freed = 0
  if (!fs.existsSync(PHOTOS_DIR)) return 0
  const activeIds = new Set<string>()
  for (const [jid, j] of photoJobs) {
    if (j.status === 'downloading') activeIds.add(jid)
  }
  let entries: string[]
  try { entries = fs.readdirSync(PHOTOS_DIR) } catch { return 0 }
  for (const name of entries) {
    if (activeIds.has(name)) continue // job dir is named by id; keep in-progress
    const full = path.join(PHOTOS_DIR, name)
    try {
      // Sum sizes before removing for the freed total.
      const sizeOf = (p: string): number => {
        let s = 0
        let es: fs.Dirent[]
        try { es = fs.readdirSync(p, { withFileTypes: true }) } catch { try { return fs.statSync(p).size } catch { return 0 } }
        for (const e of es) {
          const fp = path.join(p, e.name)
          if (e.isDirectory()) s += sizeOf(fp)
          else { try { s += fs.statSync(fp).size } catch {} }
        }
        return s
      }
      freed += sizeOf(full)
      fs.rmSync(full, { recursive: true, force: true })
    } catch {}
  }
  // Drop reclaimed jobs from the registry.
  for (const [jid, j] of photoJobs) {
    if (j.status !== 'downloading') photoJobs.delete(jid)
  }
  return freed
}

function isTwitterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return host === 'twitter.com' || host === 'x.com' || host === 't.co'
  } catch { return false }
}

function cookieArgs(): string[] {
  if (!fs.existsSync(COOKIE_FILE)) return []
  try {
    if (fs.statSync(COOKIE_FILE).size === 0) return []
    const head = fs.readFileSync(COOKIE_FILE, { encoding: 'utf-8' }).slice(0, 60)
    if (!/Netscape HTTP Cookie File/i.test(head)) return []
  } catch { return [] }
  return ['--cookies', COOKIE_FILE]
}

function proxyArgs(url?: string): string[] {
  const proxy = process.env.PROXY_URL
  if (!proxy) return []
  if (url) {
    try {
      const host = new URL(url).hostname.replace('www.', '')
      // YouTube etc. bypass — same list as downloads.ts.
      const bypass = ['twitter.com', 'x.com', 't.co', 'instagram.com',
        'youtube.com', 'youtu.be', 'm.youtube.com']
      if (bypass.some(h => host === h || host.endsWith('.' + h))) return []
    } catch {}
  }
  return ['--proxy', proxy]
}

export function getPhotoJob(id: string): PhotoJob | undefined {
  return photoJobs.get(id)
}

export function deletePhotoJob(id: string) {
  const job = photoJobs.get(id)
  if (!job) return
  const dir = path.join(PHOTOS_DIR, id)
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  photoJobs.delete(id)
}

function freeDiskBytes(): number | null {
  try {
    const st = (fs as any).statfsSync?.(PHOTOS_DIR)
    if (st && typeof st.bavail === 'number' && typeof st.bsize === 'number') {
      return st.bavail * st.bsize
    }
  } catch {}
  return null
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args)
    let stdout = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('error', () => resolve({ code: -1, stdout }))
    proc.on('close', (code) => resolve({ code, stdout }))
  })
}

// gallery-dl writes "<file>.json" beside each file. One is enough for the post
// fields; keep trying until a file's metadata turns up.
function readMetadata(job: PhotoJob, file: PhotoFile) {
  if (job.author && job.site && job.expected) return
  try {
    const meta = JSON.parse(fs.readFileSync(file.fullPath + '.json', 'utf-8'))
    const handle = meta.username || meta.author?.name || meta.user?.name || meta.owner?.username
    if (handle && !job.author) job.author = '@' + String(handle).replace(/^@/, '')
    if (meta.category && !job.site) job.site = String(meta.category)
    if (Number(meta.count) > 0 && !job.expected) job.expected = Number(meta.count)
  } catch {}
}

function prepareFile(job: PhotoJob, file: PhotoFile) {
  job.prep = (job.prep || Promise.resolve()).then(async () => {
    readMetadata(job, file)
    if (file.kind === 'video') {
      const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', file.fullPath])
      try {
        const j = JSON.parse(probe.stdout)
        file.codec = j.streams?.[0]?.codec_name
        const d = parseFloat(j.format?.duration)
        if (isFinite(d)) file.duration = d
      } catch {}
      const poster = file.fullPath + '.poster.jpg'
      const p = await run('ffmpeg', ['-v', 'error', '-y', '-ss', '0.1', '-i', file.fullPath,
        '-frames:v', '1', '-vf', 'scale=480:-2', poster])
      if (p.code === 0 && fs.existsSync(poster)) file.posterPath = poster
    }
    const thumb = file.fullPath + '.thumb.jpg'
    const t = await run('ffmpeg', ['-v', 'error', '-y', '-i', file.posterPath || file.fullPath,
      '-frames:v', '1', '-vf', 'scale=32:32:force_original_aspect_ratio=increase,crop=32:32', thumb])
    if (t.code === 0 && fs.existsSync(thumb)) file.thumbPath = thumb
  }).catch(() => {})
}

export function startPhotoJob(id: string, url: string): PhotoJob {
  const jobDir = path.join(PHOTOS_DIR, id)
  if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true })

  const job: PhotoJob = {
    id,
    url,
    status: 'downloading',
    files: [],
    createdAt: Date.now(),
  }
  photoJobs.set(id, job)

  // Disk guard — same 100MB floor as video downloads (photos are tiny anyway).
  const free = freeDiskBytes()
  if (free !== null && free < 100 * 1024 * 1024) {
    job.status = 'error'
    job.error = `Server low on disk (${(free / 1e9).toFixed(1)}GB free) — try again shortly.`
    return job
  }

  const args = [
    url,
    '-d', jobDir,
    '--no-mtime',
    // Flatten so all files land directly in jobDir, no nested extractor
    // subdirs. Easier to enumerate + serve.
    '-D', jobDir,
    // "<file>.json" per file: the author, site and item count for the card.
    '--write-metadata',
    ...cookieArgs(),
    ...proxyArgs(url),
  ]
  // gallery-dl needs PYTHONUNBUFFERED=1 to flush stdout as it works; otherwise
  // Python block-buffers when stdout is piped and nothing emerges until exit.
  console.log('[photos] Spawning gallery-dl:', args.join(' '))

  const proc = spawn('gallery-dl', args, {
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  })
  job.proc = proc

  let stderr = ''

  proc.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString()
    for (const raw of chunk.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      // gallery-dl prefixes saved files with "# "; strip it.
      let candidate = line.startsWith('#') ? line.replace(/^#\s*/, '') : line
      if (candidate.startsWith('[')) continue
      // Accept absolute paths (Windows or POSIX style).
      if (/^([A-Za-z]:[\\/]|\/)/.test(candidate)) {
        if (!fs.existsSync(candidate)) continue
        let size = 0
        try { size = fs.statSync(candidate).size } catch {}
        const file: PhotoFile = {
          name: path.basename(candidate),
          size,
          fullPath: candidate,
          kind: VIDEO_EXT.has(path.extname(candidate).toLowerCase()) ? 'video' : 'photo',
        }
        job.files.push(file)
        prepareFile(job, file)
      }
    }
  })

  proc.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })

  proc.on('error', (err) => {
    console.error('[photos] spawn error:', err.message)
    job.status = 'error'
    job.error = (err as any).code === 'ENOENT'
      ? 'gallery-dl not installed on server'
      : err.message
    job.proc = undefined
    void isTwitterUrl
  })

  proc.on('close', (code) => {
    job.proc = undefined
    const finish = () => {
      // A file whose metadata wasn't written yet when it was first prepared.
      for (const f of job.files) readMetadata(job, f)
      if (code === 0 && job.files.length > 0) {
        job.status = 'done'
        console.log(`[photos] job ${id} done — ${job.files.length} files`)
      } else if (code === 0 && job.files.length === 0) {
        job.status = 'error'
        job.error = 'gallery-dl found nothing — site unsupported or content private'
      } else {
        job.status = 'error'
        const errLine = stderr.split('\n').filter(l => l.toLowerCase().includes('error')).pop()
          || stderr.trim().split('\n').pop() || ''
        job.error = errLine.trim() || `gallery-dl exited with code ${code}`
      }
    }
    // Wait for the last files' probes and previews before calling it done.
    ;(job.prep || Promise.resolve()).then(finish, finish)
  })

  return job
}

export function cancelPhotoJob(id: string) {
  const job = photoJobs.get(id)
  if (!job) return
  if (job.proc) {
    try { job.proc.kill('SIGINT') } catch {}
    job.proc = undefined
  }
  deletePhotoJob(id)
}
