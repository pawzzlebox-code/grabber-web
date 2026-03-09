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

function saveCookies(cookiesTxt: string) {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true })
  }
  fs.writeFileSync(COOKIE_FILE, cookiesTxt, 'utf-8')
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

export async function fetchVideoInfo(url: string): Promise<VideoInfo[]> {
  const twitter = isTwitterUrl(url)

  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--encoding', 'utf-8',
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

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString('utf-8') })
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf-8') })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`))
        return
      }
      try {
        // yt-dlp outputs one JSON object per line for multi-video
        const lines = stdout.trim().split('\n').filter(l => l.trim())
        const videos: VideoInfo[] = []

        for (let i = 0; i < lines.length; i++) {
          const json = JSON.parse(lines[i])
          videos.push({
            id: json.id,
            title: json.title || `Video ${i + 1}`,
            thumbnail: json.thumbnail || '',
            duration: json.duration || 0,
            formats: buildFormats(json, twitter),
            url: json.webpage_url || json.url || url,
            playlistIndex: lines.length > 1 ? i + 1 : undefined,
          })
        }

        if (videos.length === 0) {
          reject(new Error('No videos found'))
          return
        }

        resolve(videos)
      } catch (e) {
        reject(new Error('Failed to parse video info'))
      }
    })
  })
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
  const args = [
    '--newline',
    '--encoding', 'utf-8',
    '--no-mtime',
    ...cookieArgs(),
    '-o', path.join(TEMP_DIR, `${id}_%(title).80B.%(ext)s`),
    '--print', 'after_move:filepath',
  ]

  if (!twitter) {
    args.push('--no-playlist')
  } else if (playlistIndex !== undefined) {
    // Download specific video from multi-video tweet (1-indexed)
    args.push('--playlist-items', String(playlistIndex))
  }

  const defaultFmt = twitter ? 'b' : 'bv*+ba/b'
  if (formatId) {
    args.push('-f', formatId)
  } else {
    args.push('-f', defaultFmt)
  }

  args.push(url)

  const proc = spawn('yt-dlp', args, {
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  })

  job.process = proc
  let lastLine = ''

  proc.stdout.on('data', (data: Buffer) => {
    const text = data.toString('utf-8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      lastLine = trimmed

      // Progress: [download]  45.2% of ~150.00MiB at 5.20MiB/s ETA 00:15
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
    console.error('[yt-dlp]', data.toString('utf-8').trim())
  })

  proc.on('close', (code) => {
    job.process = undefined
    if (code === 0 && lastLine && !lastLine.startsWith('[')) {
      job.filePath = lastLine.trim()
      job.fileName = path.basename(job.filePath)
      job.status = 'done'
      job.percent = 100
      notify(job, { type: 'done', fileName: job.fileName })
    } else {
      job.status = 'error'
      job.error = `Download failed (exit code ${code})`
      notify(job, { type: 'error', message: job.error })
    }
  })

  return job
}

export function startDownloadWithCookies(id: string, url: string, cookiesTxt?: string): DownloadJob {
  // Save fresh cookies from extension
  if (cookiesTxt) {
    saveCookies(cookiesTxt)
  }
  return startDownload(id, url, 'bv*+ba/b')
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
