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
}

export interface PhotoJob {
  id: string
  url: string
  status: 'downloading' | 'done' | 'error'
  files: PhotoFile[]
  error?: string
  createdAt: number
  proc?: ChildProcess
}

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
        job.files.push({
          name: path.basename(candidate),
          size,
          fullPath: candidate,
        })
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
