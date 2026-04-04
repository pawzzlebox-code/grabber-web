import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

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
  status: 'pending' | 'downloading' | 'done' | 'error'
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

export function getDownload(id: string): DownloadJob | undefined {
  return downloads.get(id)
}

export function getAllDownloads(): DownloadJob[] {
  return Array.from(downloads.values()).map(({ process, listeners, ...rest }) => rest as any)
}

function notify(job: DownloadJob, data: any) {
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

  // Best quality — use 'b' for Twitter (pre-merged MP4s), 'bv*+ba/b' for others
  const bestFormat = twitter ? 'b' : 'bv*+ba/b'
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
        : `bv[height<=${f.height}]+ba/b[height<=${f.height}]`
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
      '--encoding', 'utf-8',
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

export function startDownload(id: string, url: string, formatId?: string, title?: string, thumbnail?: string, playlistIndex?: number): DownloadJob {
  const job: DownloadJob = {
    id, url,
    title: title || 'Downloading...',
    thumbnail: thumbnail || '',
    status: 'downloading',
    percent: 0, speed: '', eta: '', totalSize: '',
    listeners: new Set(),
    createdAt: Date.now(),
  }
  downloads.set(id, job)

  const twitter = isTwitterUrl(url)
  const baseArgs = [
    '--newline',
    '--encoding', 'utf-8',
    '--no-mtime',
    ...proxyArgs(url),
    ...cookieArgs(),
    '-o', path.join(TEMP_DIR, `${id}_%(title).80B.%(ext)s`),
    '--print', 'after_move:filepath',
  ]

  if (!twitter) {
    baseArgs.push('--no-playlist')
  } else if (playlistIndex !== undefined) {
    baseArgs.push('--playlist-items', String(playlistIndex))
  }

  const defaultFmt = twitter ? 'b' : 'bv*+ba/b'
  baseArgs.push('-f', formatId || defaultFmt)
  baseArgs.push(url)

  function attemptDownload(attempt: number) {
    const proc = spawn('yt-dlp', baseArgs, {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    })

    job.process = proc
    job.percent = 0
    job.speed = ''
    job.eta = ''
    let lastLine = ''
    let stderrOutput = ''

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        lastLine = trimmed

        const match = trimmed.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\S+)\s+at\s+([\d.]+\S+)\s+ETA\s+(\S+)/)
        if (match) {
          job.percent = parseFloat(match[1])
          job.totalSize = match[2]
          job.speed = match[3]
          job.eta = match[4]
          notify(job, { type: 'progress', percent: job.percent, totalSize: job.totalSize, speed: job.speed, eta: job.eta })
        }
      }
    })

    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf-8').trim()
      stderrOutput += text + '\n'
      console.error('[yt-dlp]', text)
    })

    proc.on('close', (code) => {
      job.process = undefined
      if (code === 0 && lastLine && !lastLine.startsWith('[')) {
        job.filePath = lastLine.trim()
        job.fileName = path.basename(job.filePath)
        job.status = 'done'
        job.percent = 100
        notify(job, { type: 'done', fileName: job.fileName })
      } else if (attempt < MAX_RETRIES && isRetryable(stderrOutput)) {
        // Retry after delay
        const nextAttempt = attempt + 1
        console.log(`[yt-dlp] Retrying (${nextAttempt + 1}/${MAX_RETRIES + 1})...`)
        notify(job, { type: 'retry', attempt: nextAttempt + 1, maxRetries: MAX_RETRIES + 1 })
        setTimeout(() => attemptDownload(nextAttempt), RETRY_DELAY_MS * (nextAttempt))
      } else {
        job.status = 'error'
        job.error = extractError(stderrOutput, code)
        notify(job, { type: 'error', message: job.error })
      }
    })
  }

  attemptDownload(0)
  return job
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
  if (job?.process) {
    job.process.kill()
    job.status = 'error'
    job.error = 'Cancelled'
    notify(job, { type: 'error', message: 'Cancelled' })
  }
}
