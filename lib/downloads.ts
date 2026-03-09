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

// Cookie browser setting (persisted in env or set via API)
let cookieBrowser: string = process.env.COOKIE_BROWSER || ''

export function setCookieBrowser(browser: string) { cookieBrowser = browser }
export function getCookieBrowser(): string { return cookieBrowser }

function cookieArgs(): string[] {
  if (cookieBrowser && cookieBrowser !== 'none') {
    return ['--cookies-from-browser', cookieBrowser]
  }
  // Check if a cookies.txt file exists
  const cookieFile = path.join(TEMP_DIR, 'cookies.txt')
  if (fs.existsSync(cookieFile)) {
    return ['--cookies', cookieFile]
  }
  return []
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

export async function fetchVideoInfo(url: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '--no-playlist',
      '--dump-json',
      '--encoding', 'utf-8',
      ...cookieArgs(),
      url
    ], {
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
        const json = JSON.parse(stdout)

        // Build format list — deduplicate by height for video, keep audio
        const seen = new Set<string>()
        const formats: VideoInfo['formats'] = []

        // Add best option
        formats.push({ formatId: 'bv*+ba/b', label: 'Best Quality', ext: 'mp4', filesize: undefined })

        // Video formats by resolution
        const videoFormats = (json.formats || [])
          .filter((f: any) => f.vcodec !== 'none' && f.height)
          .sort((a: any, b: any) => (b.height || 0) - (a.height || 0))

        for (const f of videoFormats) {
          const key = `${f.height}p`
          if (!seen.has(key) && f.height >= 360) {
            seen.add(key)
            formats.push({
              formatId: `bv[height<=${f.height}]+ba/b[height<=${f.height}]`,
              label: key,
              ext: f.ext || 'mp4',
              filesize: f.filesize || undefined,
            })
          }
        }

        // Audio only
        formats.push({ formatId: 'ba', label: 'Audio Only', ext: 'webm', filesize: undefined })

        resolve({
          id: json.id,
          title: json.title || 'Unknown',
          thumbnail: json.thumbnail || '',
          duration: json.duration || 0,
          formats,
          url,
        })
      } catch (e) {
        reject(new Error('Failed to parse video info'))
      }
    })
  })
}

export function startDownload(id: string, url: string, formatId?: string, title?: string, thumbnail?: string): DownloadJob {
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

  const args = [
    '--no-playlist',
    '--newline',
    '--encoding', 'utf-8',
    '--no-mtime',
    ...cookieArgs(),
    '-o', path.join(TEMP_DIR, `${id}_%(title).80B.%(ext)s`),
    '--print', 'after_move:filepath',
  ]

  if (formatId && formatId !== 'bv*+ba/b') {
    args.push('-f', formatId)
  } else {
    args.push('-f', 'bv*+ba/b')
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

export function cancelDownload(id: string) {
  const job = downloads.get(id)
  if (job?.process) {
    job.process.kill()
    job.status = 'error'
    job.error = 'Cancelled'
    notify(job, { type: 'error', message: 'Cancelled' })
  }
}
