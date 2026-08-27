// Server gallery — everything currently sitting on the droplet.
//
// A finished download used to be deleted five minutes after it reached you.
// Now it lingers for 24 hours so you can come back and do something with it,
// and tapping Share promotes it to permanent: the file moves out of /tmp into
// this directory (where no sweeper can touch it) and gets a public token.
//
// The index is on disk, not in memory: the desktop registry taught us that a
// pm2 restart at 4am shouldn't silently erase state you can see in the UI.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

export interface GalleryItem {
  id: string                 // download job id
  title: string
  thumbnail: string
  fileName: string
  filePath: string
  size: number
  createdAt: number
  expiresAt: number | null   // null = kept until you delete it
  shareToken: string | null  // set once shared publicly
  downloads: number
}

const KEEP_DIR = path.join(os.homedir(), '.grabber-gallery')
const INDEX_FILE = path.join(KEEP_DIR, 'index.json')

/** How long an un-shared download stays on the server. */
export const RETENTION_MS = 24 * 60 * 60 * 1000

function ensureDir() {
  if (!fs.existsSync(KEEP_DIR)) fs.mkdirSync(KEEP_DIR, { recursive: true, mode: 0o700 })
}

function readIndex(): GalleryItem[] {
  ensureDir()
  try {
    if (!fs.existsSync(INDEX_FILE)) return []
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeIndex(items: GalleryItem[]) {
  ensureDir()
  fs.writeFileSync(INDEX_FILE, JSON.stringify(items, null, 2), 'utf-8')
}

/** Drop expired entries, and any whose file vanished from under us. */
export function sweep(): void {
  const now = Date.now()
  const all = readIndex()
  const live = all.filter((item) => {
    const gone = !fs.existsSync(item.filePath)
    const expired = item.expiresAt !== null && item.expiresAt < now
    if (expired && !gone) {
      try { fs.unlinkSync(item.filePath) } catch {}
    }
    return !expired && !gone
  })
  if (live.length !== all.length) writeIndex(live)
}

export function listGallery(): GalleryItem[] {
  sweep()
  return readIndex().sort((a, b) => b.createdAt - a.createdAt)
}

export function getItem(id: string): GalleryItem | null {
  sweep()
  return readIndex().find((i) => i.id === id) || null
}

/** Public lookup — the token is the only credential a recipient has. */
export function getByShareToken(token: string): GalleryItem | null {
  if (!/^[a-f0-9]{32}$/.test(token)) return null
  sweep()
  return readIndex().find((i) => i.shareToken === token) || null
}

/** Called when a download finishes, so the file shows up in the gallery. */
export function registerDownload(params: {
  id: string
  title: string
  thumbnail: string
  fileName: string
  filePath: string
}): void {
  try {
    if (!fs.existsSync(params.filePath)) return
    const all = readIndex()
    if (all.some((i) => i.id === params.id)) return
    all.push({
      id: params.id,
      title: params.title || params.fileName,
      thumbnail: params.thumbnail || '',
      fileName: params.fileName,
      filePath: params.filePath,
      size: fs.statSync(params.filePath).size,
      createdAt: Date.now(),
      expiresAt: Date.now() + RETENTION_MS,
      shareToken: null,
      downloads: 0,
    })
    writeIndex(all)
  } catch {}
}

/**
 * Promote to a permanent public share. The file is MOVED out of the temp
 * directory first — leaving it in /tmp would let the orphan sweeper (or a
 * reboot) delete a file someone is holding a link to.
 */
export function shareItem(id: string): GalleryItem | null {
  const all = readIndex()
  const item = all.find((i) => i.id === id)
  if (!item || !fs.existsSync(item.filePath)) return null

  if (!item.shareToken) item.shareToken = crypto.randomBytes(16).toString('hex')
  item.expiresAt = null

  const kept = path.join(KEEP_DIR, `${item.shareToken}${path.extname(item.fileName) || '.mp4'}`)
  if (path.resolve(item.filePath) !== path.resolve(kept)) {
    try {
      fs.renameSync(item.filePath, kept)
    } catch {
      // Cross-device rename fails (e.g. /tmp on a different mount) — copy.
      try { fs.copyFileSync(item.filePath, kept); fs.unlinkSync(item.filePath) } catch { return null }
    }
    item.filePath = kept
  }

  writeIndex(all)
  return item
}

/** Revoke the public link but keep the file (reverts to the 24h clock). */
export function unshareItem(id: string): boolean {
  const all = readIndex()
  const item = all.find((i) => i.id === id)
  if (!item) return false
  item.shareToken = null
  item.expiresAt = Date.now() + RETENTION_MS
  writeIndex(all)
  return true
}

export function deleteItem(id: string): boolean {
  const all = readIndex()
  const item = all.find((i) => i.id === id)
  if (!item) return false
  try { fs.unlinkSync(item.filePath) } catch {}
  writeIndex(all.filter((i) => i.id !== id))
  return true
}

export function recordShareDownload(token: string): void {
  const all = readIndex()
  const item = all.find((i) => i.shareToken === token)
  if (!item) return
  item.downloads++
  writeIndex(all)
}

export function galleryBytes(): number {
  return readIndex().reduce((sum, i) => sum + i.size, 0)
}
