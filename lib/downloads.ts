import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { dispatchDownload } from './ytdlp-pool'

export interface VideoInfo {
  id: string
  title: string
  thumbnail: string
  duration: number
  formats: { formatId: string; label: string; ext: string; filesize?: number }[]
  url: string
  playlistIndex?: number
}

export interface DownloadJob {
  id: string
  url: string
  title: string
  thumbnail: string
  status: 'pending' | 'downloading' | 'converting' | 'subtitling' | 'done' | 'error'
  percent: number
  speed: string
  eta: string
  totalSize: string
  filePath?: string
  fileName?: string
  error?: string
  listeners: Set<(data: any) => void>
  createdAt: number
  process?: ChildProcess
  cancel?: () => void
  duration?: number
  logs: string[]
  srt?: string
}

const downloads = new Map<string, DownloadJob>()
const TEMP_DIR = path.join(os.tmpdir(), 'grabber-downloads')

// Cookie file path — written by extension or upload
const COOKIE_FILE = path.join(TEMP_DIR, 'cookies.txt')

function cookieArgs(): string[] {
  if (fs.existsSync(COOKIE_FILE)) {
    return ['--cookies', COOKIE_FILE]
  }
  return []
}

function proxyArgs(url?: string): string[] {
  const proxy = process.env.PROXY_URL
  if (!proxy) return []
  // Skip proxy for sites where the Indian proxy causes issues
  if (url) {
    try {
      const host = new URL(url).hostname.replace('www.', '')
      if (['twitter.com', 'x.com', 't.co', 'instagram.com'].includes(host)) return []
    } catch {}
  }
  return ['--proxy', proxy]
}

export function getCookieStatus(): { exists: boolean; lines: number; domains: string[]; lastModified?: string } {
  if (!fs.existsSync(COOKIE_FILE)) return { exists: false, lines: 0, domains: [] }
  const content = fs.readFileSync(COOKIE_FILE, 'utf-8')
  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'))
  const domains = [...new Set(lines.map(l => l.split('\t')[0]).filter(Boolean))]
  const stat = fs.statSync(COOKIE_FILE)
  return { exists: true, lines: lines.length, domains, lastModified: stat.mtime.toISOString() }
}

export function saveCookies(cookiesTxt: string) {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true })
  }
  // Merge with existing cookies instead of overwriting
  const existingCookies = new Map<string, string>()
  if (fs.existsSync(COOKIE_FILE)) {
    for (const line of fs.readFileSync(COOKIE_FILE, 'utf-8').split('\n')) {
      if (line.startsWith('#') || !line.trim()) continue
      const parts = line.split('\t')
      if (parts.length >= 7) {
        existingCookies.set(`${parts[0]}|${parts[5]}|${parts[2]}`, line)
      }
    }
  }
  for (const line of cookiesTxt.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue
    const parts = line.split('\t')
    if (parts.length >= 7) {
      existingCookies.set(`${parts[0]}|${parts[5]}|${parts[2]}`, line)
    }
  }
  const merged = '# Netscape HTTP Cookie File\n' + Array.from(existingCookies.values()).join('\n') + '\n'
  fs.writeFileSync(COOKIE_FILE, merged, 'utf-8')
}

// Ensure temp dir exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true })
}

// Cleanup old files every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [id, job] of downloads) {
    // Remove completed/errored jobs after 30 minutes
    if (now - job.createdAt > 30 * 60 * 1000 && job.status !== 'downloading') {
      if (job.filePath && fs.existsSync(job.filePath)) {
        try { fs.unlinkSync(job.filePath) } catch {}
      }
      downloads.delete(id)
    }
  }
}, 10 * 60 * 1000)

// Disk-based orphan sweeper. The in-memory sweeper above only knows about
// jobs in the current process's `downloads` Map — pm2 restarts wipe it,
// leaving any in-flight files as permanent orphans. This walks TEMP_DIR
// every 10 min and deletes files older than 60 min regardless of Map
// state, preserving cookies.txt and any in-progress downloads.
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000
setInterval(() => {
  if (!fs.existsSync(TEMP_DIR)) return
  let entries: string[]
  try { entries = fs.readdirSync(TEMP_DIR) } catch { return }
  const now = Date.now()
  for (const name of entries) {
    if (name === 'cookies.txt') continue
    const full = path.join(TEMP_DIR, name)
    let stat: fs.Stats
    try { stat = fs.statSync(full) } catch { continue }
    if (!stat.isFile()) continue
    if (now - stat.mtimeMs < ORPHAN_MAX_AGE_MS) continue
    try {
      fs.unlinkSync(full)
      console.log(`[orphan-sweeper] deleted ${name} (age ${Math.round((now - stat.mtimeMs) / 60000)}min)`)
    } catch {}
  }
}, 10 * 60 * 1000)

export function getDownload(id: string): DownloadJob | undefined {
  return downloads.get(id)
}

export function deleteDownload(id: string) {
  const job = downloads.get(id)
  if (!job) return
  if (job.filePath && fs.existsSync(job.filePath)) {
    try { fs.unlinkSync(job.filePath) } catch {}
  }
  downloads.delete(id)
  console.log(`[cleanup] Deleted job ${id}`)
}

export function getAllDownloads(): DownloadJob[] {
  return Array.from(downloads.values()).map(({ process, listeners, ...rest }) => rest as any)
}

function notify(job: DownloadJob, data: any) {
  // Persist log messages to job state so polling clients can retrieve them
  if (data.type === 'log' && data.message) {
    job.logs.push(`[${new Date().toLocaleTimeString()}] ${data.message}`)
    if (job.logs.length > 100) job.logs.shift()
  }
  for (const listener of job.listeners) {
    try { listener(data) } catch {}
  }
}

function isTwitterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return host === 'twitter.com' || host === 'x.com' || host === 't.co'
  } catch { return false }
}

function buildFormats(json: any, twitter: boolean): VideoInfo['formats'] {
  const seen = new Set<string>()
  const formats: VideoInfo['formats'] = []

  // Best quality — use 'b' for Twitter (pre-merged MP4s), broader fallback for others
  const bestFormat = twitter ? 'b' : 'bestvideo*+bestaudio/best'
  formats.push({ formatId: bestFormat, label: 'Best Quality', ext: 'mp4', filesize: undefined })

  const videoFormats = (json.formats || [])
    .filter((f: any) => f.vcodec !== 'none' && f.height)
    .sort((a: any, b: any) => (b.height || 0) - (a.height || 0))

  for (const f of videoFormats) {
    const key = `${f.height}p`
    if (!seen.has(key) && f.height >= 360) {
      seen.add(key)
      const fmtId = twitter
        ? `b[height<=${f.height}]`
        : `bestvideo[height<=${f.height}]+bestaudio/best[height<=${f.height}]`
      formats.push({ formatId: fmtId, label: key, ext: f.ext || 'mp4', filesize: f.filesize || undefined })
    }
  }

  if (!twitter) {
    formats.push({ formatId: 'ba', label: 'Audio Only', ext: 'webm', filesize: undefined })
  }

  return formats
}

function isChannelOrPlaylist(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.replace('www.', '')
    const p = u.pathname.toLowerCase()
    if (host === 'youtube.com' || host === 'youtu.be') {
      // Channel URLs: /@user, /c/name, /channel/id, /user/name
      if (p.startsWith('/@') || p.startsWith('/c/') || p.startsWith('/channel/') || p.startsWith('/user/')) return true
      // Pure playlist URL (not a video with list param)
      if (p === '/playlist') return true
    }
    return false
  } catch { return false }
}

export async function fetchVideoInfo(url: string, attempt = 0): Promise<VideoInfo[]> {
  if (isChannelOrPlaylist(url)) {
    throw new Error('Channel and playlist URLs are not supported. Please paste a link to a specific video.')
  }

  const twitter = isTwitterUrl(url)

  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-check-formats',
      '--encoding', 'utf-8',
      // Fake Chrome's TLS fingerprint via curl-cffi. Bypasses sites that
      // 410-block yt-dlp's stock Python urllib fingerprint (e.g. Pornhub).
      // Cheap and universally harmless on supported extractors.
      '--impersonate', 'chrome',
      ...proxyArgs(url),
      ...cookieArgs(),
    ]
    // Only use --no-playlist for non-Twitter URLs
    if (!twitter) args.unshift('--no-playlist')
    args.push(url)

    const proc = spawn('yt-dlp', args, {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    })

    let stdout = ''
    let stderr = ''

    // Timeout after 30 seconds for fetching info
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('Timed out fetching video info. Check the URL and try again.'))
    }, 30000)

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString('utf-8') })
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf-8') })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        console.error('[info] yt-dlp failed (attempt ' + (attempt + 1) + '):', stderr.slice(0, 500))
        // Retry up to 2 more times for transient errors
        if (attempt < MAX_RETRIES && isRetryable(stderr)) {
          console.log(`[info] Retrying (${attempt + 2}/${MAX_RETRIES + 1})...`)
          setTimeout(() => {
            fetchVideoInfo(url, attempt + 1).then(resolve).catch(reject)
          }, RETRY_DELAY_MS * (attempt + 1))
          return
        }
        const errorLine = stderr.split('\n').filter(l => l.includes('ERROR')).pop()
          || stderr.trim().split('\n').pop() || ''
        reject(new Error(errorLine.trim() || `yt-dlp exited with code ${code}`))
        return
      }
      try {
        // yt-dlp outputs one JSON object per line for multi-video
        // Filter to only JSON lines (skip progress/warning lines)
        const jsonLines = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'))
        const videos: VideoInfo[] = []

        for (let i = 0; i < jsonLines.length; i++) {
          const json = JSON.parse(jsonLines[i])
          videos.push({
            id: json.id,
            title: json.title || `Video ${i + 1}`,
            thumbnail: json.thumbnail || '',
            duration: json.duration || 0,
            formats: buildFormats(json, twitter),
            url: json.webpage_url || json.url || url,
            playlistIndex: jsonLines.length > 1 ? i + 1 : undefined,
          })
        }

        if (videos.length === 0) {
          reject(new Error('No videos found'))
          return
        }

        resolve(videos)
      } catch (e: any) {
        console.error('[info] parse error:', e?.message, 'stdout:', stdout.slice(0, 500))
        reject(new Error('Failed to parse video info'))
      }
    })
  })
}

const MAX_RETRIES = 2
const RETRY_DELAY_MS = 3000
const NON_RETRYABLE = ['login required', 'private video', 'not available', 'requires authentication', 'cookies']

function isRetryable(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return !NON_RETRYABLE.some(s => lower.includes(s))
}

function extractError(stderr: string, code: number | null): string {
  const errorLine = stderr.split('\n').filter(l => l.includes('ERROR')).pop()
    || stderr.trim().split('\n').pop() || ''
  return errorLine.trim() || `Download failed (exit code ${code})`
}

// ffmpeg mutex — only one ffmpeg job runs at a time to avoid OOM on small droplet
const ffmpegQueue: Array<() => void> = []
let ffmpegRunning = false

// Read just stream-0 codec name. Used to detect VP9 / AV1 sources that
// iOS Photos refuses to import even when wrapped in MP4.
function probeVideoCodec(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      filePath,
    ])
    let out = ''
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', () => resolve(out.trim().toLowerCase()))
    proc.on('error', () => resolve(''))
  })
}

// If the downloaded video is anything other than H.264 / HEVC, re-encode
// to H.264 so iOS Photos accepts it. No pad / no subs — pure codec-only
// transcode. Mirrors webserver.ts on the desktop side; only matters when
// neither pad nor subs already ran (those paths produce H.264 via libx264).
async function transcodeIfNotIosCompat(job: DownloadJob, onComplete: () => void): Promise<void> {
  const inputPath = job.filePath!

  function log(msg: string) {
    console.log('[transcode]', msg)
    notify(job, { type: 'log', message: msg })
  }

  const codec = await probeVideoCodec(inputPath)
  if (codec === 'h264' || codec === 'hevc') {
    log(`source codec=${codec} — iOS-compatible, skipping transcode`)
    onComplete()
    return
  }
  log(`source codec=${codec || 'unknown'} — transcoding to H.264 for iOS Photos`)

  await acquireFfmpegSlot()
  const finish = () => { releaseFfmpegSlot(); onComplete() }

  const outputPath = inputPath.replace(/\.[^.]+$/, '_h264.mp4')
  const args = [
    '-i', inputPath,
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '22',
    '-tune', 'fastdecode',
    '-threads', '0',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main', '-level', '4.0',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y',
    '-progress', 'pipe:1',
    outputPath,
  ]
  log(`Command: ffmpeg ${args.join(' ')}`)

  job.status = 'converting'
  job.percent = 0
  notify(job, { type: 'converting', percent: 0 })

  const proc = spawn('ffmpeg', args)
  job.process = proc

  proc.stdout.on('data', (data: Buffer) => {
    const text = data.toString()
    const m = text.match(/out_time_ms=(\d+)/)
    if (m && job.duration && job.duration > 0) {
      const sec = parseInt(m[1]) / 1_000_000
      job.percent = Math.min(99, Math.round((sec / job.duration) * 100))
      notify(job, { type: 'converting', percent: job.percent })
    }
  })
  let stderrBuf = ''
  proc.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString() })
  proc.on('error', (err) => {
    log(`ffmpeg spawn error: ${err.message}`)
    job.process = undefined
    finish()
  })
  proc.on('close', (code) => {
    job.process = undefined
    const outExists = fs.existsSync(outputPath)
    log(`ffmpeg exit ${code}, output exists: ${outExists}`)
    if (code === 0 && outExists) {
      try { fs.unlinkSync(inputPath) } catch {}
      job.filePath = outputPath
      job.fileName = path.basename(outputPath)
    } else {
      log(`STDERR: ${stderrBuf.slice(-500)}`)
      try { if (outExists) fs.unlinkSync(outputPath) } catch {}
    }
    finish()
  })
}

function acquireFfmpegSlot(): Promise<void> {
  return new Promise((resolve) => {
    const start = () => {
      ffmpegRunning = true
      resolve()
    }
    if (!ffmpegRunning) start()
    else ffmpegQueue.push(start)
  })
}

function releaseFfmpegSlot(): void {
  ffmpegRunning = false
  const next = ffmpegQueue.shift()
  if (next) next()
}

async function convertToVertical(job: DownloadJob, onComplete: () => void): Promise<void> {
  const inputPath = job.filePath!
  const outputPath = inputPath.replace(/\.[^.]+$/, '_vertical.mp4')

  function log(msg: string) {
    console.log('[ffmpeg]', msg)
    notify(job, { type: 'log', message: msg })
  }

  // Wait for ffmpeg slot so only one heavy operation runs at a time
  log('Waiting for ffmpeg slot...')
  await acquireFfmpegSlot()
  log('Got ffmpeg slot')

  // Wrap onComplete to release the slot
  const originalOnComplete = onComplete
  const finish = () => {
    releaseFfmpegSlot()
    originalOnComplete()
  }

  log(`Input: ${inputPath}`)
  log(`File exists: ${fs.existsSync(inputPath)}`)

  const probe = spawn('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', inputPath,
  ])
  let probeOut = ''
  let probeErr = ''
  probe.stdout.on('data', (d: Buffer) => { probeOut += d.toString() })
  probe.stderr.on('data', (d: Buffer) => { probeErr += d.toString() })
  probe.on('error', (err) => {
    log(`ffprobe spawn error: ${err.message}`)
    finish()
  })
  probe.on('close', (probeCode) => {
    log(`ffprobe exit code: ${probeCode}, stdout: "${probeOut.trim()}", stderr: "${probeErr.trim()}"`)

    const [wStr, hStr] = probeOut.trim().split(',')
    const w = parseInt(wStr) || 0
    const h = parseInt(hStr) || 0

    if (w === 0 || h === 0) {
      log(`Cannot detect dimensions (w=${w}, h=${h}), serving original`)
      finish()
      return
    }

    log(`Detected: ${w}x${h}, ratio: ${(w/h).toFixed(3)}`)

    if (w / h <= 9 / 16 + 0.01) {
      log(`Already vertical (ratio ${(w/h).toFixed(3)} <= 0.5725), skipping`)
      finish()
      return
    }

    // Scale down if wider than 720 to save memory, then pad to 9:16
    let outW = w
    let outH = h
    if (w > 720) {
      outW = 720
      outH = Math.ceil((h * 720 / w) / 2) * 2  // scale height proportionally, keep even
    }
    const padH = Math.ceil((outW * 16 / 9) / 2) * 2
    const yOffset = Math.floor((padH - outH) / 2)

    // Build filter: scale (if needed) + pad + force square pixels (setsar=1)
    // setsar=1 is critical — prevents Instagram showing grey due to non-square SAR
    let vf: string
    if (outW !== w) {
      vf = `scale=${outW}:${outH},pad=${outW}:${padH}:0:${yOffset}:black,setsar=1`
    } else {
      vf = `pad=${outW}:${padH}:0:${yOffset}:black,setsar=1`
    }

    log(`Converting: ${w}x${h} -> ${outW}x${padH}, yOffset=${yOffset}, filter="${vf}"`)
    log(`Output: ${outputPath}`)

    const ffmpegArgs = [
      '-i', inputPath,
      '-vf', vf,
      // superfast preset — ~2x faster than veryfast on the tiny droplet, still
      // respects -profile:v main (unlike ultrafast which forces Constrained
      // Baseline → Instagram shows grey). -threads 0 uses all CPU cores,
      // -tune fastdecode trades a bit of compression for encode speed.
      '-c:v', 'libx264', '-preset', 'superfast', '-crf', '22',
      '-tune', 'fastdecode',
      '-threads', '0',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'main', '-level', '4.0',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y',
      '-progress', 'pipe:1',
      outputPath,
    ]
    log(`Command: ffmpeg ${ffmpegArgs.join(' ')}`)

    const proc = spawn('ffmpeg', ffmpegArgs)
    job.process = proc
    job.status = 'converting'
    job.percent = 0
    notify(job, { type: 'converting', percent: 0 })

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      const timeMatch = text.match(/out_time_ms=(\d+)/)
      if (timeMatch && job.duration && job.duration > 0) {
        const currentSec = parseInt(timeMatch[1]) / 1000000
        const pct = Math.min(99, Math.round((currentSec / job.duration) * 100))
        job.percent = pct
        notify(job, { type: 'converting', percent: pct })
      }
    })

    let stderrBuf = ''
    proc.stderr.on('data', (data: Buffer) => { stderrBuf += data.toString() })

    proc.on('error', (err) => {
      log(`ffmpeg spawn error: ${err.message}`)
      job.process = undefined
      finish()
    })

    proc.on('close', (code) => {
      job.process = undefined
      const outExists = fs.existsSync(outputPath)
      log(`ffmpeg exit code: ${code}, output exists: ${outExists}`)
      if (code !== 0) {
        log(`STDERR: ${stderrBuf.slice(-500)}`)
      }
      if (code === 0 && outExists) {
        try { fs.unlinkSync(inputPath) } catch {}
        job.filePath = outputPath
        job.fileName = path.basename(outputPath)
        finish()
      } else {
        try { if (outExists) fs.unlinkSync(outputPath) } catch {}
        finish()
      }
    })
  })
}

// Convert Groq verbose_json segments to SRT format
function segmentsToSrt(segments: Array<{ start: number; end: number; text: string }>): string {
  const fmt = (sec: number): string => {
    const ms = Math.floor((sec % 1) * 1000)
    const s = Math.floor(sec) % 60
    const m = Math.floor(sec / 60) % 60
    const h = Math.floor(sec / 3600)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
  }
  return segments.map((seg, i) =>
    `${i + 1}\n${fmt(seg.start)} --> ${fmt(seg.end)}\n${seg.text.trim()}\n`
  ).join('\n')
}

async function burnSubtitlesFn(job: DownloadJob, onComplete: () => void): Promise<void> {
  const inputPath = job.filePath!
  const audioPath = path.join(TEMP_DIR, `${job.id}_audio.mp3`)
  const srtPath = path.join(TEMP_DIR, `${job.id}_subs.srt`)
  const outputPath = inputPath.replace(/\.[^.]+$/, '_subbed.mp4')

  function log(msg: string) {
    console.log('[subs]', msg)
    notify(job, { type: 'log', message: msg })
  }

  function cleanup() {
    try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath) } catch {}
    try { if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath) } catch {}
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY
  if (!GROQ_API_KEY) {
    log('GROQ_API_KEY not set — skipping subtitle burn')
    onComplete()
    return
  }

  // Serialize ffmpeg operations across all concurrent jobs
  log('Waiting for ffmpeg slot...')
  await acquireFfmpegSlot()
  log('Got ffmpeg slot')

  const originalOnComplete = onComplete
  const finish = () => {
    releaseFfmpegSlot()
    originalOnComplete()
  }

  try {
    // Step 1: Extract audio as MP3
    job.status = 'subtitling' as any
    notify(job, { type: 'subtitling', percent: 5, message: 'Extracting audio...' })
    log(`Extracting audio to ${audioPath}`)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-i', inputPath,
        '-vn',
        '-ar', '16000',
        '-ac', '1',
        '-b:a', '64k',
        '-y', audioPath,
      ])
      let err = ''
      proc.stderr.on('data', (d: Buffer) => { err += d.toString() })
      proc.on('error', (e) => reject(new Error(`ffmpeg spawn: ${e.message}`)))
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(audioPath)) resolve()
        else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`))
      })
    })

    const audioSize = fs.statSync(audioPath).size
    log(`Audio extracted: ${(audioSize / 1024 / 1024).toFixed(2)} MB`)

    if (audioSize > 20 * 1024 * 1024) {
      log('Audio exceeds 20 MB — too large for Groq free tier, skipping')
      cleanup()
      finish()
      return
    }

    // Step 2: Upload to Groq translations endpoint
    notify(job, { type: 'subtitling', percent: 25, message: 'Transcribing with Whisper...' })
    log('Calling Groq /audio/translations...')

    const audioBuffer = fs.readFileSync(audioPath)
    const formData = new FormData()
    formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'audio.mp3')
    formData.append('model', 'whisper-large-v3')
    // Groq translations endpoint only supports json/text/verbose_json (not srt)
    formData.append('response_format', 'verbose_json')

    const t0 = Date.now()
    const res = await fetch('https://api.groq.com/openai/v1/audio/translations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: formData,
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      log(`Groq error ${res.status}: ${errBody.slice(0, 300)}`)
      cleanup()
      finish()
      return
    }

    const json = await res.json() as { segments?: Array<{ start: number; end: number; text: string }>, text?: string }
    const segments = json.segments || []
    log(`Groq responded in ${Date.now() - t0}ms (${segments.length} segments)`)

    if (!segments.length) {
      log('No segments returned from Groq — skipping burn')
      cleanup()
      finish()
      return
    }

    const srtText = segmentsToSrt(segments)
    fs.writeFileSync(srtPath, srtText, 'utf-8')
    log(`Wrote ${srtText.length} chars of SRT to ${srtPath}`)

    // Step 3: Burn subtitles into video
    notify(job, { type: 'subtitling', percent: 50, message: 'Burning subtitles...' })
    log(`Burning subtitles to ${outputPath}`)

    // Escape the path for the subtitles filter (ffmpeg needs special escaping)
    // On Linux, forward slashes work fine; need to escape colons in Windows paths
    const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:')
    const vf = `subtitles=${escapedSrt}:force_style='Fontname=Arial,Fontsize=24,Bold=1,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=50'`

    const ffmpegArgs = [
      '-i', inputPath,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'main', '-level', '4.0',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y',
      '-progress', 'pipe:1',
      outputPath,
    ]
    log(`Command: ffmpeg ${ffmpegArgs.join(' ')}`)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', ffmpegArgs)
      job.process = proc
      job.status = 'subtitling' as any
      job.percent = 50
      notify(job, { type: 'subtitling', percent: 50, message: 'Burning subtitles...' })

      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString()
        const timeMatch = text.match(/out_time_ms=(\d+)/)
        if (timeMatch && job.duration && job.duration > 0) {
          const currentSec = parseInt(timeMatch[1]) / 1000000
          // ffmpeg progress maps to 50-99% of subtitle stage (50% was for prep work)
          const pct = 50 + Math.min(49, Math.round((currentSec / job.duration) * 49))
          job.percent = pct
          notify(job, { type: 'subtitling', percent: pct, message: 'Burning subtitles...' })
        }
      })

      let stderrBuf = ''
      proc.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString() })

      proc.on('error', (e) => reject(new Error(`ffmpeg spawn: ${e.message}`)))
      proc.on('close', (code) => {
        job.process = undefined
        const outExists = fs.existsSync(outputPath)
        log(`ffmpeg exit ${code}, output exists: ${outExists}`)
        if (code === 0 && outExists) {
          resolve()
        } else {
          log(`STDERR: ${stderrBuf.slice(-500)}`)
          try { if (outExists) fs.unlinkSync(outputPath) } catch {}
          reject(new Error(`ffmpeg burn failed (code ${code})`))
        }
      })
    })

    // Success: replace input with burned output
    try { fs.unlinkSync(inputPath) } catch {}
    job.filePath = outputPath
    job.fileName = path.basename(outputPath)
    log(`Success: ${outputPath}`)
  } catch (err: any) {
    log(`Error: ${err?.message || err}`)
    // Keep original file — fall through to finish()
  } finally {
    cleanup()
    finish()
  }
}

// Fast path for instant mode: extract audio, call Groq, store SRT on job.
// No video re-encoding — the browser will do that via WebCodecs.
async function generateSubtitlesOnly(job: DownloadJob, onComplete: () => void): Promise<void> {
  const inputPath = job.filePath!
  const audioPath = path.join(TEMP_DIR, `${job.id}_audio.mp3`)

  function log(msg: string) {
    console.log('[srt-only]', msg)
    notify(job, { type: 'log', message: msg })
  }

  function cleanup() {
    try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath) } catch {}
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY
  if (!GROQ_API_KEY) {
    log('GROQ_API_KEY not set — skipping SRT generation')
    onComplete()
    return
  }

  // Reuse the same ffmpeg slot mutex so we don't stack jobs
  log('Waiting for ffmpeg slot...')
  await acquireFfmpegSlot()
  log('Got ffmpeg slot')

  const finish = () => {
    releaseFfmpegSlot()
    onComplete()
  }

  try {
    // Step 1: Extract audio as small MP3 (fast, not a full re-encode)
    job.status = 'subtitling' as any
    job.speed = 'Extracting audio...'
    notify(job, { type: 'subtitling', percent: 20, message: 'Extracting audio...' })
    log(`Extracting audio to ${audioPath}`)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-i', inputPath,
        '-vn',
        '-ar', '16000',
        '-ac', '1',
        '-b:a', '64k',
        '-y', audioPath,
      ])
      let err = ''
      proc.stderr.on('data', (d: Buffer) => { err += d.toString() })
      proc.on('error', (e) => reject(new Error(`ffmpeg spawn: ${e.message}`)))
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(audioPath)) resolve()
        else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`))
      })
    })

    const audioSize = fs.statSync(audioPath).size
    log(`Audio extracted: ${(audioSize / 1024 / 1024).toFixed(2)} MB`)

    if (audioSize > 20 * 1024 * 1024) {
      log('Audio exceeds 20 MB — skipping Groq, instant mode will have no subs')
      cleanup()
      finish()
      return
    }

    // Step 2: Groq translation -> SRT
    job.speed = 'Transcribing with Whisper...'
    notify(job, { type: 'subtitling', percent: 60, message: 'Transcribing with Whisper...' })
    log('Calling Groq /audio/translations...')

    const audioBuffer = fs.readFileSync(audioPath)
    const formData = new FormData()
    formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'audio.mp3')
    formData.append('model', 'whisper-large-v3')
    formData.append('response_format', 'verbose_json')

    const t0 = Date.now()
    const res = await fetch('https://api.groq.com/openai/v1/audio/translations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: formData,
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      log(`Groq error ${res.status}: ${errBody.slice(0, 300)}`)
      cleanup()
      finish()
      return
    }

    const json = await res.json() as { segments?: Array<{ start: number; end: number; text: string }> }
    const segments = json.segments || []
    log(`Groq responded in ${Date.now() - t0}ms (${segments.length} segments)`)

    if (!segments.length) {
      log('No segments returned — instant mode will have no subs')
      cleanup()
      finish()
      return
    }

    job.srt = segmentsToSrt(segments)
    log(`Stored ${job.srt.length} chars of SRT on job`)
  } catch (err: any) {
    log(`Error: ${err?.message || err}`)
  } finally {
    cleanup()
    finish()
  }
}

export function startDownload(id: string, url: string, formatId?: string, title?: string, thumbnail?: string, playlistIndex?: number, verticalPad?: boolean, duration?: number, burnSubtitles?: boolean, instantMode?: boolean): DownloadJob {
  const job: DownloadJob = {
    id, url,
    title: title || 'Downloading...',
    thumbnail: thumbnail || '',
    status: 'downloading',
    percent: 0, speed: '', eta: '', totalSize: '',
    listeners: new Set(),
    createdAt: Date.now(),
    duration: duration || 0,
    logs: [],
  }
  downloads.set(id, job)

  const twitter = isTwitterUrl(url)
  const defaultFmt = twitter ? 'b' : 'bestvideo*+bestaudio/best'

  // Instant-feel status set the moment the job is created, before the warm
  // worker even wakes up. User sees "Contacting host.com..." within ~0ms.
  let hostname = ''
  try { hostname = new URL(url).hostname.replace(/^www\./, '') } catch {}
  job.speed = hostname ? `Contacting ${hostname}...` : 'Starting...'
  notify(job, { type: 'status', message: job.speed })

  const proxy = process.env.PROXY_URL
    && !(hostname && ['twitter.com', 'x.com', 't.co', 'instagram.com'].includes(hostname))
    ? process.env.PROXY_URL : undefined
  const cookies = fs.existsSync(COOKIE_FILE) ? COOKIE_FILE : undefined

  function attemptDownload(attempt: number, useFallbackFormat: boolean = false) {
    job.percent = 0
    job.eta = ''
    let lastError = ''
    // YouTube's format manifest rotates between metadata fetch + download
    // start, so the formatId the phone selected (e.g. "137+bestaudio") may
    // already be invalid. On "Requested format is not available", retry
    // once with a resilient best-available chain.
    const fallbackFmt = "bv*[vcodec~='^(avc|h264)']+ba/b[vcodec~='^(avc|h264)']/bv*+ba/b"
    const activeFormat = useFallbackFormat ? fallbackFmt : (formatId || defaultFmt)

    // Stall detector: if no progress event fires within 90s, the stream
    // fetch is almost certainly being throttled/RSTed by YouTube/CDN.
    // Kill the worker and surface a clear error rather than letting the
    // user stare at "Extracting..." indefinitely.
    let lastProgressAt = Date.now()
    const STALL_TIMEOUT_MS = 90 * 1000
    let cancelFnLocal: (() => void) | null = null
    const stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS && job.status === 'downloading') {
        clearInterval(stallTimer)
        if (cancelFnLocal) {
          try { cancelFnLocal() } catch {}
        }
        job.status = 'error'
        job.error = 'Stream stalled (90s no progress) — datacenter IP likely blocked. Turn off Skip Desktop or try a different video.'
        notify(job, { type: 'error', message: job.error })
      }
    }, 10_000)

    const cancelFn = dispatchDownload(
      {
        job_id: id,
        url,
        format: activeFormat,
        outtmpl: path.join(TEMP_DIR, `${id}_%(title).80B.%(ext)s`),
        proxy,
        cookies,
        playlist_items: (!twitter || playlistIndex === undefined) ? undefined : playlistIndex,
        no_playlist: !twitter,
      },
      {
        onStatus: (message) => {
          job.speed = message
          notify(job, { type: 'status', message })
        },
        onProgress: (p) => {
          lastProgressAt = Date.now()
          job.percent = p.percent
          job.speed = formatSpeed(p.speed_bps)
          job.eta = formatEta(p.eta)
          job.totalSize = formatBytes(p.total_bytes)
          notify(job, {
            type: 'progress',
            percent: job.percent,
            totalSize: job.totalSize,
            speed: job.speed,
            eta: job.eta,
          })
        },
        onDone: (filepath) => {
          clearInterval(stallTimer)
          job.cancel = undefined
          if (!filepath) {
            job.status = 'error'
            job.error = 'no filepath returned'
            notify(job, { type: 'error', message: job.error })
            return
          }
          // Reject suspiciously small outputs — yt-dlp sometimes writes a
          // YouTube error page or a partial-RST stub and reports success.
          // Anything under 1 KB is not a real video.
          try {
            const sz = fs.statSync(filepath).size
            if (sz < 1024) {
              try { fs.unlinkSync(filepath) } catch {}
              job.status = 'error'
              job.error = `Server returned a ${sz}-byte file — likely blocked or RSTed mid-stream. Try without Skip Desktop.`
              notify(job, { type: 'error', message: job.error })
              return
            }
          } catch {}
          job.filePath = filepath
          job.fileName = path.basename(filepath)

          const isVideo = formatId !== 'ba'

          const runDone = () => {
            job.status = 'done'
            job.percent = 100
            notify(job, { type: 'done', fileName: job.fileName! })
          }

          // Instant mode: client does ALL re-encoding (pad, subtitle burn, both).
          // Server only runs Groq when subtitles are requested — otherwise hand
          // over the raw downloaded file untouched.
          if (instantMode && isVideo) {
            if (burnSubtitles) {
              generateSubtitlesOnly(job, runDone)
            } else {
              runDone()
            }
            return
          }

          const runBurn = () => {
            if (burnSubtitles && isVideo) {
              burnSubtitlesFn(job, runDone)
            } else if (isVideo && !verticalPad) {
              // No pad, no subs — verify the codec is iOS-Photos-compatible.
              // pad/subs paths already re-encode to H.264 via libx264, so
              // this only matters when nothing else touched the file.
              transcodeIfNotIosCompat(job, runDone)
            } else {
              runDone()
            }
          }

          if (verticalPad && isVideo) {
            convertToVertical(job, runBurn)
          } else {
            runBurn()
          }
        },
        onError: (message, traceback) => {
          clearInterval(stallTimer)
          job.cancel = undefined
          lastError = message
          if (traceback) console.error('[ytdlp-pool trace]', traceback)
          // Stale formatId — immediately retry with the resilient
          // H.264-preferred chain instead of using a retry slot.
          if (!useFallbackFormat && /Requested format is not available/i.test(message)) {
            console.log(`[ytdlp-pool] Format "${activeFormat}" stale, retrying with H.264-preferred fallback`)
            job.speed = 'Format rotated, retrying...'
            notify(job, { type: 'status', message: job.speed })
            setTimeout(() => attemptDownload(attempt, true), 200)
            return
          }
          if (attempt < MAX_RETRIES && isRetryable(message)) {
            const nextAttempt = attempt + 1
            console.log(`[ytdlp-pool] Retrying (${nextAttempt + 1}/${MAX_RETRIES + 1}): ${message.slice(0, 120)}`)
            notify(job, { type: 'retry', attempt: nextAttempt + 1, maxRetries: MAX_RETRIES + 1 })
            setTimeout(() => attemptDownload(nextAttempt), RETRY_DELAY_MS * (nextAttempt))
          } else {
            job.status = 'error'
            job.error = lastError || 'Download failed'
            notify(job, { type: 'error', message: job.error })
          }
        },
      },
    )
    cancelFnLocal = cancelFn
    job.cancel = cancelFn
  }

  attemptDownload(0)
  return job
}

function formatBytes(bytes: number): string {
  if (!bytes) return ''
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 10 ? 0 : 1)}${units[i]}`
}

function formatSpeed(bps: number): string {
  if (!bps) return ''
  return `${formatBytes(bps)}/s`
}

function formatEta(seconds: number): string {
  if (!seconds || seconds < 0) return ''
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function startDownloadWithCookies(id: string, url: string, cookiesTxt?: string): DownloadJob {
  if (cookiesTxt) {
    saveCookies(cookiesTxt)
  }
  const defaultFmt = isTwitterUrl(url) ? 'b' : 'bv*+ba/b'
  return startDownload(id, url, defaultFmt)
}

export function cancelDownload(id: string) {
  const job = downloads.get(id)
  if (!job) return

  // 1a. Ask the ytdlp pool to drop/kill this job's worker, if any
  if (job.cancel) {
    try { job.cancel() } catch {}
    job.cancel = undefined
  }
  // 1b. Kill any active child process (ffmpeg, etc.) — yt-dlp runs in the pool
  if (job.process) {
    try { job.process.kill('SIGKILL') } catch {}
    job.process = undefined
  }

  // 2. Delete the output video file if it exists
  if (job.filePath && fs.existsSync(job.filePath)) {
    try { fs.unlinkSync(job.filePath) } catch {}
  }

  // 3. Mark cancelled + notify listeners (so polling clients get the signal)
  job.status = 'error'
  job.error = 'Cancelled'
  job.srt = undefined
  notify(job, { type: 'error', message: 'Cancelled' })

  // 4. Remove from the downloads Map so /api/file/:id returns 404 for it
  downloads.delete(id)
  console.log(`[cancel] Killed job ${id} + deleted file`)
}
