'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ClipboardPaste, Download, Loader, AlertCircle,
  X, Settings, ChevronDown, Trash2, RefreshCw, Images
} from 'lucide-react'
import { isWebCodecsSupported } from '@/lib/webcodecs-processor'
import { runWorker } from '@/lib/webcodecs-client'
import UploadPanel from './UploadPanel'
import GallerySheet from './GallerySheet'
import PhotoCard, { type PhotoCardJob, type PhotoFile, type PhotoItem } from './PhotoCard'
import { noiseTile } from '@/lib/scan-noise'

interface VideoInfo {
  id: string
  title: string
  thumbnail: string
  duration: number
  // directUrl: X only — the complete MP4 on the CDN, fetchable straight from
  // the browser (see startDirectDownload).
  formats: { formatId: string; label: string; ext: string; filesize?: number | null; best?: boolean; directUrl?: string }[]
  url: string
  playlistIndex?: number
  uploader?: string
  uploadDate?: string // YYYYMMDD
}

interface DownloadJob {
  id: string
  title: string
  thumbnail: string
  status: 'downloading' | 'converting' | 'subtitling' | 'done' | 'error'
  percent: number
  speed: string
  eta: string
  totalSize: string
  fileName?: string
  error?: string
  url: string
  formatLabel: string
  // Set when the file is too big for in-memory share-to-Photos and the
  // user should be offered a direct-download-to-Files button instead.
  directOnly?: boolean
  // The phone is fetching the file straight from the source's CDN; there is
  // no server-side job, so nothing to poll, cancel or re-fetch on the server.
  direct?: boolean
  // When the job was started here — orders video and photo cards in one list.
  startedAt?: number
  // Share of the "Downloading" bar given to the phone pulling the file from
  // the server. The server's download and that transfer show as one 0–100%
  // run when nothing happens between them; 0 keeps them as separate steps.
  xferShare?: number
}

// Persist settings in localStorage
// User-visible defaults. instantMode + useMyDesktop are gone — both are
// auto-selected at runtime: desktop wins if its tunnel is registered AND
// the user has a desktopKey saved; else WebCodecs if the browser supports
// it; else server-side. desktopKey moves to "Advanced" since most users
// won't configure it, and direct download joins it there.
const defaultSettings = { autoDetect: true, autoBest: true, verticalPad: false, burnSubtitles: false, directDownload: false, desktopKey: '', skipDesktop: false }

// Above this size we never buffer the file into a JS Blob (for navigator.share
// / WebCodecs). Holding a few hundred MB in a tab OOM-crashes the renderer —
// iOS Safari dies near ~250MB, and even desktop tabs crash on multi-GB files
// (a 26-min 7Mbps video is ~1.3GB). Large files stream straight to disk via an
// <a download> instead, which uses ~no memory.
const MAX_INMEMORY_BYTES = 450 * 1024 * 1024 // 450 MB

function loadSettings() {
  if (typeof window === 'undefined') return defaultSettings
  try {
    const s = localStorage.getItem('grabber-settings')
    // A photoMode key saved by older builds is dropped: photo posts now route
    // to gallery-dl on their own (fetchInfo).
    if (!s) return defaultSettings
    const saved = JSON.parse(s)
    delete saved.photoMode
    return { ...defaultSettings, ...saved }
  } catch { return defaultSettings }
}

function saveSettings(s: typeof defaultSettings) {
  if (typeof window !== 'undefined') localStorage.setItem('grabber-settings', JSON.stringify(s))
}

function isVideoUrl(text: string): boolean {
  if (!text || text.length > 500) return false
  try {
    const url = new URL(text.trim())
    const host = url.hostname.replace('www.', '')
    const videoHosts = [
      'youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com',
      'tiktok.com', 'instagram.com', 'twitter.com', 'x.com',
      'facebook.com', 'fb.watch', 'twitch.tv', 'reddit.com',
      'bilibili.com', 'nicovideo.jp', 'soundcloud.com',
    ]
    return videoHosts.some(h => host.includes(h)) || url.pathname.includes('watch') || url.pathname.includes('video')
  } catch { return false }
}

// Format a bytes-per-second rate like "10.2 MB/s" / "850 KB/s".
function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec < 0) return ''
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`
}

// Seconds → "0:42" / "12:05", for transfer ETAs.
function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return ''
  const s = Math.ceil(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// instagram.com/p/<code>, also the instagram.com/<user>/p/<code> form.
function isInstagramPostUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.)?instagram\.com\/(?:[^/?#]+\/)?p\/[\w-]+/i.test(url)
}

// A link straight to an image file. yt-dlp's generic extractor "succeeds" on
// these with no formats at all, so they'd show as a broken video card;
// gallery-dl's directlink extractor saves them properly.
function isImageLink(url: string): boolean {
  try { return /\.(jpe?g|png|webp|gif|heic|avif)$/i.test(new URL(url).pathname) } catch { return false }
}

// yt-dlp's wordings for "this post has no video" — see fetchInfo.
const NO_VIDEO_HERE = /no video could be found|there is no video|unsupported url/i

function isTwitterUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '')
    return h === 'twitter.com' || h === 'x.com' || h === 't.co'
  } catch { return false }
}

// Direct-from-CDN downloads, in parallel byte ranges like aria2c: one
// connection to X's CDN tops out around 3 MiB/s from Pakistan, several
// together go faster. Small files use fewer pieces — each costs a round trip.
const DIRECT_PIECES = 6
const DIRECT_MIN_PIECE = 2 * 1024 * 1024

class DirectTooBigError extends Error {}

// X's CDN answers 403 to any request whose Referer is another site (hotlink
// protection) but serves the same request with no Referer at all — and CORS
// only needs the Origin header, which is sent regardless. Verified with curl:
// Referer downloadanyvideo.click → 403, none → 206.
const NO_REFERRER: ReferrerPolicy = 'no-referrer'

async function fetchInPieces(
  url: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number, bytesPerSec: number) => void,
): Promise<Blob> {
  // The CDN allows Range but doesn't expose Content-Range to scripts, so the
  // total size has to come from a HEAD's Content-Length.
  const head = await fetch(url, { method: 'HEAD', signal, referrerPolicy: NO_REFERRER })
  if (!head.ok) throw new Error(`CDN HTTP ${head.status}`)
  const total = parseInt(head.headers.get('content-length') || '0', 10)
  if (total > MAX_INMEMORY_BYTES) throw new DirectTooBigError(`${total} bytes`)
  if (!total) {
    const r = await fetch(url, { signal, referrerPolicy: NO_REFERRER })
    if (!r.ok) throw new Error(`CDN HTTP ${r.status}`)
    return await r.blob()
  }

  const pieces = Math.max(1, Math.min(DIRECT_PIECES, Math.ceil(total / DIRECT_MIN_PIECE)))
  const size = Math.ceil(total / pieces)
  const parts: BlobPart[][] = Array.from({ length: pieces }, () => [])
  const t0 = performance.now()
  let received = 0
  let lastUi = 0
  const report = (force = false) => {
    const now = performance.now()
    if (!force && now - lastUi < 300) return
    lastUi = now
    onProgress(received, total, received / Math.max(0.001, (now - t0) / 1000))
  }

  await Promise.all(parts.map(async (chunks, i) => {
    const start = i * size
    const end = Math.min(total, start + size) - 1
    for (let attempt = 0; ; attempt++) {
      let got = 0
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal, referrerPolicy: NO_REFERRER })
        // A 200 here means the Range was ignored and the whole file is coming
        // — fatal with several pieces, since each would fetch everything.
        if (r.status !== 206 && !(r.status === 200 && pieces === 1)) throw new Error(`CDN HTTP ${r.status}`)
        if (!r.body) throw new Error('No response body')
        const reader = r.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          got += value.length
          received += value.length
          report()
        }
        if (got !== end - start + 1) throw new Error(`Piece ${i} came back short`)
        return
      } catch (err) {
        if (signal.aborted || attempt >= 2) throw err
        // Retry this piece from scratch; take its partial bytes back out of the total.
        received -= got
        chunks.length = 0
      }
    }
  }))
  report(true)
  // Hand the chunks straight to Blob, in order — no manual concat, so there
  // is never a second full-size copy in memory.
  return new Blob(parts.flat(), { type: 'video/mp4' })
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }
  return `${m}:${String(sec).padStart(2, '0')}`
}

// Compact byte size for the format-picker buttons, e.g. "402 MB" / "1.3 GB".
// True decimal conversion (1000-based) so "MB" means MB — matches the
// server's formatBytes used in the download cards.
function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

// Fire a short device vibration (download start / done). Works on Android +
// desktop with a vibration motor; iOS Safari doesn't support the Vibration
// API, so it's a harmless no-op there.
function haptic(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern) } catch {}
}

// iOS/iPadOS detection — "Save to Photos" is iOS vocabulary; other platforms
// get a neutral "Share". (iPadOS 13+ masquerades as Mac, hence the touch check.)
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

// yt-dlp upload_date (YYYYMMDD) → "Mar 12, 2026". Empty string on bad input.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatUploadDate(d?: string): string {
  if (!d || !/^\d{8}$/.test(d)) return ''
  const m = parseInt(d.slice(4, 6), 10)
  if (m < 1 || m > 12) return ''
  return `${MONTHS[m - 1]} ${parseInt(d.slice(6, 8), 10)}, ${d.slice(0, 4)}`
}

// ── Progressive-scan banner ────────────────────────────────────────────────
// A download card's thumbnail doubles as its progress bar: the picture arrives
// row by row over static while downloading, gets a colour pass while
// converting, is wiped toward the phone while preparing, and locks in with a
// CRT flash once ready. Styles live in globals.css under .scan-*.

type ScanMode = 'tuning' | 'download' | 'convert' | 'prepare' | 'ready' | 'error'

// The low-res canvases are what give the pixel look; the full-res thumbnail
// only takes over in the ready state.
const SCAN_W = 96
const SCAN_H = 54

// Colour bars stand in until the thumbnail loads, and for good when a site
// gives none.
function drawTestBars(ctx: CanvasRenderingContext2D) {
  const top = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0']
  const low = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0']
  const bw = SCAN_W / top.length
  const split = Math.round(SCAN_H * 0.72)
  top.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(Math.floor(i * bw), 0, Math.ceil(bw), split) })
  low.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(Math.floor(i * bw), split, Math.ceil(bw), SCAN_H - split) })
}

function ScanBanner({ thumbnail, mode, pct, chip, className = '' }: {
  thumbnail?: string
  mode: ScanMode
  /** 0–100; 0 or less plays the indeterminate version of the mode. */
  pct: number
  chip: string
  className?: string
}) {
  const colorRef = useRef<HTMLCanvasElement>(null)
  const grayRef = useRef<HTMLCanvasElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [noise, setNoise] = useState('')

  useEffect(() => { setNoise(noiseTile()) }, [])

  // Drawing a cross-origin image taints the canvas, which only blocks reading
  // pixels back — nothing here does, so no CORS is needed from thumbnail hosts.
  useEffect(() => {
    const canvases = [colorRef.current, grayRef.current].filter((c): c is HTMLCanvasElement => !!c)
    const paint = (img?: HTMLImageElement) => {
      for (const cv of canvases) {
        const ctx = cv.getContext('2d')
        if (!ctx) continue
        if (!img) { drawTestBars(ctx); continue }
        // Centre-crop to 16:9 so tall or square thumbnails still fill the banner.
        const sw = img.naturalWidth, sh = img.naturalHeight
        const cw = Math.min(sw, (sh * 16) / 9), ch = (cw * 9) / 16
        ctx.drawImage(img, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, SCAN_W, SCAN_H)
      }
    }
    paint()
    setLoaded(false)
    if (!thumbnail) return
    let alive = true
    const img = new Image()
    img.onload = () => { if (alive) { paint(img); setLoaded(true) } }
    img.src = thumbnail
    return () => { alive = false }
  }, [thumbnail])

  const det = pct > 0
  // Quantise to whole canvas rows/columns so the reveal steps like a scan
  // instead of sliding.
  const clamped = Math.min(100, pct)
  const rowP = det ? (Math.floor((clamped / 100) * SCAN_H) / SCAN_H) * 100 : 0
  const colP = det ? (Math.floor((clamped / 100) * SCAN_W) / SCAN_W) * 100 : 0

  const showColor = mode === 'download' ? det : mode !== 'tuning'
  const colorClip = mode === 'download' || (mode === 'convert' && det)
    ? { clipPath: `inset(0 0 ${100 - rowP}% 0)` }
    : undefined
  const colorAnim = mode === 'convert' && !det ? ' scan-sweep-y' : mode === 'error' ? ' scan-glitch' : ''

  return (
    <div className={`scan-banner ${className}`} data-mode={mode} aria-hidden>
      <div className="scan-layer scan-noise" style={noise ? { backgroundImage: `url(${noise})` } : undefined} />
      <canvas ref={grayRef} width={SCAN_W} height={SCAN_H} className="scan-layer scan-gray" hidden={mode !== 'convert'} />
      {mode === 'convert' && <div className="scan-layer scan-dither" />}
      <canvas ref={colorRef} width={SCAN_W} height={SCAN_H} className={`scan-layer${colorAnim}`} style={colorClip} hidden={!showColor} />
      {(mode === 'tuning' || (mode === 'download' && !det)) && <div className="scan-roll" />}
      {mode === 'download' && det && rowP < 100 && <div className="scan-hline" style={{ top: `${rowP}%` }} />}
      {mode === 'convert' && (det
        ? <div className="scan-hline scan-accent" style={{ top: `${rowP}%` }} />
        : <div className="scan-hline scan-accent scan-line-y" />)}
      {mode === 'prepare' && (det ? (
        <>
          <div className="scan-layer scan-tint" style={{ clipPath: `inset(0 ${100 - colP}% 0 0)` }} />
          <div className="scan-vline" style={{ left: `${colP}%` }} />
        </>
      ) : (
        <>
          <div className="scan-layer scan-tint scan-sweep-x" />
          <div className="scan-vline scan-line-x" />
        </>
      ))}
      {mode === 'error' && <div className="scan-layer scan-tint scan-bad" />}
      {mode === 'ready' && loaded && thumbnail && <img src={thumbnail} alt="" className="scan-layer scan-hires" />}
      {mode === 'ready' && <div className="scan-layer scan-flash" />}
      <span className={`scan-chip${mode === 'ready' ? ' scan-ok' : mode === 'error' ? ' scan-bad' : ''}`}>{chip}</span>
    </div>
  )
}

// "042%" — fixed width, so the chip doesn't twitch as the number climbs.
const scanPct = (n: number) => `${String(Math.round(Math.min(100, Math.max(0, n)))).padStart(3, '0')}%`
// "Encode 042%", or "Encode…" before there's a number to show.
const scanChip = (label: string, n: number) => (n > 0 ? `${label} ${scanPct(n)}` : `${label}…`)

// A link straight to a media file, rather than a page a site extractor knows
// how to read. These need the referring page's headers to fetch server-side,
// so the UI offers a Referer field when it sees one.
function isDirectMediaUrl(raw: string): boolean {
  const value = raw.trim()
  if (!/^https?:\/\//i.test(value)) return false
  try {
    const path = new URL(value).pathname.toLowerCase()
    return /\.(m3u8|mpd|mp4|mkv|webm|mov|m4v|ts|flv)$/.test(path) || path.includes('/m3u8')
  } catch {
    return false
  }
}

// 5×7 bitmap glyphs for the hero wordmark — drawn on canvas so the pixels
// stay hard-edged at any DPR (a webfont would anti-alias).
const WORDMARK_GLYPHS: Record<string, string[]> = {
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
}

// GRABBER wordmark in the console-logo style: two-tone blue pixel letters
// with a hard dark shadow, followed by three red/yellow/green slashes.
function PixelWordmark() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const word = 'GRABBER'
    const s = 5, gap = 1, shadow = 1
    const wordCols = word.length * (5 + gap) - gap
    const slashCols = 3 * 3 + 6
    const cols = wordCols + 2 + slashCols + shadow
    const rows = 7 + shadow + 1
    const dpr = 2
    cv.width = cols * s * dpr
    cv.height = rows * s * dpr
    cv.style.width = `${cols * s}px`
    cv.style.height = `${rows * s}px`
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    const drawWord = (ox: number, oy: number, fill: (row: number) => string) => {
      let x0 = ox
      for (const ch of word) {
        const glyph = WORDMARK_GLYPHS[ch]
        for (let r = 0; r < 7; r++)
          for (let c = 0; c < 5; c++)
            if (glyph[r][c] === '1') {
              ctx.fillStyle = fill(r)
              ctx.fillRect((x0 + c) * s, (oy + r) * s, s, s)
            }
        x0 += 5 + gap
      }
    }
    const drawSlashes = (ox: number, oy: number, color?: string) => {
      const colors = ['#d94f5c', '#e0bd4a', '#4fc455']
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = color ?? colors[i]
        for (let r = 0; r < 7; r++) {
          ctx.fillRect((ox + i * 3 + (6 - r)) * s, (oy + r) * s, 2 * s, s)
        }
      }
    }
    drawWord(shadow, shadow, () => '#22262e')
    drawSlashes(wordCols + 2 + shadow, shadow, '#22262e')
    drawWord(0, 0, (r) => (r < 4 ? '#7fc4f2' : '#4c8fd9'))
    drawSlashes(wordCols + 2, 0)
  }, [])
  return <canvas ref={ref} className="mx-auto" style={{ imageRendering: 'pixelated' }} role="img" aria-label="Grabber" />
}

export default function GrabberApp() {
  const [url, setUrl] = useState('')
  // Optional Referer for direct media links (.m3u8/.mp4 pasted straight in).
  // Those CDNs usually check the referring page's headers, which a browser
  // sends for free but a server-side fetch has to be told.
  const [referer, setReferer] = useState('')
  const [videos, setVideos] = useState<VideoInfo[]>([])
  // Videos whose download has been handed to the server. Their result card is
  // hidden from then on — the download card's banner already shows the same
  // thumbnail, so keeping both just doubles the picture.
  const [queuedVideoIds, setQueuedVideoIds] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [downloads, setDownloads] = useState<DownloadJob[]>([])
  const [settings, setSettings] = useState(defaultSettings)
  const [showSettings, setShowSettings] = useState(false)
  const [showGallery, setShowGallery] = useState(false)
  const [selectedFormats, setSelectedFormats] = useState<Record<string, string>>({})
  const lastClipboard = useRef('')
  const autoTriggered = useRef(false)
  const [canShare, setCanShare] = useState(false)
  const [saveProgress, setSaveProgress] = useState<Record<string, number>>({})
  // Live transfer speed shown during the "Preparing" phase (phone pulling the
  // finished file from the server), keyed by download id, e.g. "10.2 MB/s".
  const [saveSpeed, setSaveSpeed] = useState<Record<string, string>>({})
  // ETA for that same transfer, e.g. "2:41" — the long part of a no-desktop job.
  const [saveEta, setSaveEta] = useState<Record<string, string>>({})
  const fileCache = useRef<Record<string, File>>({})
  // iOS Safari leaks navigator.share state across calls — once a share throws
  // InvalidStateError the state is stuck until the tab reloads. Track whether
  // a share is currently in flight so repeat taps don't pile on, and detect
  // the stuck-state via the error to fall back to blob-URL download.
  const shareInFlight = useRef(false)
  const shareStateBroken = useRef(false)
  const [fileReady, setFileReady] = useState<Record<string, boolean>>({})
  const [debugLogs, setDebugLogs] = useState<string[]>([])
  const [showDebug, setShowDebug] = useState(false)
  const [webCodecsSupported, setWebCodecsSupported] = useState(false)
  // The probe is async. If Fetch fires before it resolves, we'd send
  // instantMode=false to the server (making it do the pad) and THEN the
  // client would try to pad the already-padded video. We gate Fetch on
  // this promise to avoid that race.
  const webCodecsProbe = useRef<Promise<boolean> | null>(null)
  // When Use-My-Desktop is on and a tunnel URL is registered on the droplet,
  // all /api/download /api/progress/:id /api/file/:id /api/cancel/:id calls
  // are routed to the tunnel instead of the droplet. The desktop's local HTTP
  // server exposes the same endpoints, so no other code needs to change.
  const [desktopTunnelUrl, setDesktopTunnelUrl] = useState<string | null>(null)
  // Once the user agrees to "process on this device" because the desktop
  // wasn't reachable, don't bug them again until the page reloads.
  const [acceptedFallback, setAcceptedFallback] = useState(false)
  // Resolver pattern: when ensureProcessingPath finds desktop missing, it
  // pops this modal and awaits the user's choice via the resolve callback.
  const [fallbackModal, setFallbackModal] = useState<{ resolve: (ok: boolean) => void } | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [instantProgress, setInstantProgress] = useState<Record<string, { pct: number; stage: string }>>({})
  // Tracks in-flight download IDs that can be cancelled. Holds AbortControllers + worker handles.
  const cancelHandles = useRef<Record<string, {
    stop: () => void
    abort?: AbortController
    worker?: { cancel: () => void }
  }>>({})

  // Photo jobs (gallery-dl). Separate state from `downloads` (which is for
  // yt-dlp video jobs) because the data shape is different — a single photo
  // job produces N files — but rendered in the same Downloads list.
  //
  // iOS Safari requires navigator.share to be called inside the SAME
  // synchronous tap handler as the gesture — any await between tap and
  // share() invalidates the activation token. So every file is pulled into
  // memory first (pumpPhotoJob), and `ready` flips true once Save can fire
  // share without any async work.
  type PhotoJob = PhotoCardJob & { startedAt: number }
  const [photoJobs, setPhotoJobs] = useState<PhotoJob[]>([])
  // Per job, per file index: where the phone is with that item.
  const [photoItems, setPhotoItems] = useState<Record<string, Record<number, PhotoItem>>>({})
  // Per job: file indexes the user unticked. Everything starts ticked.
  const [photoUnticked, setPhotoUnticked] = useState<Record<string, number[]>>({})
  // Pulled (and, for videos, re-encoded) files per job, by file index.
  const photoCache = useRef<Record<string, (File | undefined)[]>>({})
  // Object URLs for pulled photos, so tiles show the real picture without
  // fetching it a second time over a slow link.
  const photoUrls = useRef<Record<string, Record<number, string>>>({})
  // The server's view of each job, read by pumpPhotoJob as files appear.
  const photoServer = useRef<Record<string, { status: PhotoJob['status']; files: PhotoFile[] }>>({})
  // Abort handles for a job's pulls and its current re-encode.
  const photoAbort = useRef<Record<string, { ac: AbortController; worker?: { cancel: () => void } }>>({})

  // Server disk usage (shown in Settings). grabberBytes = the clearable part
  // (downloads + photos temp dirs); the rest is OS/swap and can't be touched.
  const [diskInfo, setDiskInfo] = useState<{ freeBytes: number; totalBytes: number; grabberBytes: number } | null>(null)
  const [clearingDisk, setClearingDisk] = useState(false)
  const fetchDiskInfo = useCallback(async () => {
    try {
      const r = await fetch('/api/disk', { cache: 'no-store' })
      const d = await r.json()
      if (d.available) setDiskInfo({ freeBytes: d.freeBytes, totalBytes: d.totalBytes, grabberBytes: d.grabberBytes })
    } catch {}
  }, [])
  const clearDisk = async () => {
    setClearingDisk(true)
    try {
      const r = await fetch('/api/disk/clear', { method: 'POST', cache: 'no-store' })
      const d = await r.json()
      if (d.available) setDiskInfo({ freeBytes: d.freeBytes, totalBytes: d.totalBytes, grabberBytes: d.grabberBytes })
    } catch {} finally { setClearingDisk(false) }
  }

  useEffect(() => {
    webCodecsProbe.current = isWebCodecsSupported().catch(() => false)
    webCodecsProbe.current.then(setWebCodecsSupported)
  }, [])

  // Always poll for a registered desktop tunnel — auto-route to it whenever
  // available + the user has the cookie key configured. No toggle needed.
  // Cloudflared boots ~10s after Share-with-iPhone is enabled, and its URL
  // rotates on every desktop restart, so refresh every 20s + on focus.
  //
  // A registered desktop is only used once this phone has actually reached
  // it. Registration says the PC is up; it says nothing about this phone —
  // Tailscale off, or a DNS app that can't resolve the tailnet name — and
  // routing to an unreachable PC turned every request into "Load failed".
  // Unreachable is treated like unregistered, so everything falls back to
  // the server (and the existing "desktop unavailable" prompt) on its own.
  useEffect(() => {
    let cancelled = false
    const reachable = async (base: string) => {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 4000)
      try {
        // Any HTTP answer counts — /ping without the key is a 401, which still
        // proves the route. No custom headers, so no CORS preflight.
        await fetch(`${base}/ping`, { cache: 'no-store', signal: ac.signal })
        return true
      } catch {
        return false
      } finally {
        clearTimeout(t)
      }
    }
    const fetchUrl = async () => {
      try {
        const res = await fetch('/api/desktop', { cache: 'no-store' })
        const data = await res.json()
        const url: string | null = data.tunnelUrl || null
        const ok = !!url && await reachable(url)
        if (!cancelled) setDesktopTunnelUrl(ok ? url : null)
      } catch {
        if (!cancelled) setDesktopTunnelUrl(null)
      }
    }
    fetchUrl()
    const interval = setInterval(fetchUrl, 20_000)
    const onFocus = () => fetchUrl()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // All API calls route through this. Returns the desktop tunnel URL when
  // both a tunnel is registered AND the user has saved a desktop key (the
  // implicit "I want to use my desktop" signal). Otherwise '' = same-origin.
  // skipDesktop forces the same-origin path even when the desktop is up — a
  // per-session escape hatch for "just download it on my phone, don't bounce
  // through the PC."
  const apiBase = () =>
    (!settings.skipDesktop && desktopTunnelUrl && settings.desktopKey)
      ? desktopTunnelUrl
      : ''

  // Desktop endpoints require the cookie key for auth; droplet doesn't care.
  const apiHeaders = (json: boolean): Record<string, string> => {
    const h: Record<string, string> = {}
    if (json) h['Content-Type'] = 'application/json'
    if (!settings.skipDesktop && desktopTunnelUrl && settings.desktopKey) {
      h['x-cookie-key'] = settings.desktopKey
    }
    return h
  }

  // Before any download, decide where it'll be processed. If the user has
  // a desktopKey saved (implying "I want my desktop") but the tunnel isn't
  // up, prompt them once per session: continue on-device, or cancel.
  const ensureProcessingPath = async (): Promise<boolean> => {
    if (settings.skipDesktop) return true // user explicitly opted out for this session
    const wantsDesktop = !!settings.desktopKey
    const desktopUp = !!desktopTunnelUrl
    if (!wantsDesktop) return true       // user never configured desktop, no expectation
    if (desktopUp) return true           // happy path
    if (acceptedFallback) return true    // already chose on-device this session
    return new Promise<boolean>((resolve) => setFallbackModal({ resolve }))
  }

  useEffect(() => {
    // Check if browser supports sharing files (not just text/URLs)
    // navigator.share exists on desktop Chrome too, but canShare({files}) is mobile-only
    try {
      const testFile = new File([''], 'test.mp4', { type: 'video/mp4' })
      const supported = typeof navigator !== 'undefined'
        && !!navigator.canShare
        && navigator.canShare({ files: [testFile] })
      setCanShare(supported)
    } catch {
      setCanShare(false)
    }
  }, [])

  // Load settings on mount
  useEffect(() => {
    setSettings(loadSettings())
  }, [])

  // Refresh server disk usage whenever the Settings panel is opened.
  useEffect(() => {
    if (showSettings) fetchDiskInfo()
  }, [showSettings, fetchDiskInfo])

  // While the settings sheet is open: lock the page behind it (otherwise
  // scrolling the sheet also scrolls the homepage) and close on Escape.
  useEffect(() => {
    if (!showSettings) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowSettings(false) }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [showSettings])

  // Save settings on change
  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  // Clipboard auto-detection
  useEffect(() => {
    if (!settings.autoDetect) return

    const checkClipboard = async () => {
      try {
        // Clipboard API requires focus + secure context
        if (!document.hasFocus()) return
        const text = await navigator.clipboard.readText()
        if (text && text !== lastClipboard.current && isVideoUrl(text)) {
          lastClipboard.current = text
          setUrl(text.trim())
          // Auto-fetch info
          fetchInfo(text.trim())
        }
      } catch {
        // Permission denied or not supported — silent
      }
    }

    const onVisChange = () => {
      if (document.visibilityState === 'visible') checkClipboard()
    }

    window.addEventListener('focus', checkClipboard)
    document.addEventListener('visibilitychange', onVisChange)

    checkClipboard()

    return () => {
      window.removeEventListener('focus', checkClipboard)
      document.removeEventListener('visibilitychange', onVisChange)
    }
  }, [settings.autoDetect])

  // Auto-download best quality when info is fetched and autoBest is on
  useEffect(() => {
    if (settings.autoBest && videos.length > 0 && !autoTriggered.current) {
      autoTriggered.current = true
      for (const v of videos) {
        const bestFmt = v.formats[0]
        if (bestFmt) handleDownload(v, bestFmt.formatId, bestFmt.label)
      }
    }
  }, [videos, settings.autoBest])

  // Ticked, finished files of a job, in post order.
  const photoSelection = (job: PhotoJob): File[] => {
    const cache = photoCache.current[job.id] || []
    const items = photoItems[job.id] || {}
    const off = new Set(photoUnticked[job.id] || [])
    return job.files
      .filter(f => items[f.index]?.state === 'ready' && !off.has(f.index))
      .map(f => cache[f.index])
      .filter((f): f is File => !!f)
  }

  // SYNCHRONOUS save — pumpPhotoJob has already pulled everything into
  // memory. iOS rejects navigator.share with "request not allowed" if
  // anything awaits between the user's tap and the share() call.
  const handlePhotoSaveAll = (job: PhotoJob) => {
    const files = photoSelection(job)
    if (!job.ready || files.length === 0) {
      setError('Files still preparing — wait for the Save button.')
      return
    }
    if (typeof navigator !== 'undefined' && navigator.canShare?.({ files })) {
      navigator.share({ files }).catch((err: any) => {
        if (err?.name === 'AbortError') return
        setError(`Save failed: ${err?.message || err}`)
      })
    } else {
      handlePhotoDownloadAll(job)
    }
  }

  // Plain browser downloads for every ticked file — the reliable path on
  // desktop, where the share sheet either doesn't exist or opens a useless
  // OS flyout. Staggered clicks so Chrome's multi-download throttle shows
  // its "allow multiple downloads" prompt instead of silently dropping files.
  const handlePhotoDownloadAll = (job: PhotoJob) => {
    const files = photoSelection(job)
    if (!job.ready || files.length === 0) {
      setError('Files still preparing — wait for the Save button.')
      return
    }
    files.forEach((f, i) => {
      setTimeout(() => {
        const url = URL.createObjectURL(f)
        const a = document.createElement('a')
        a.href = url
        a.download = f.name
        document.body.appendChild(a); a.click(); document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 2000)
      }, i * 250)
    })
  }

  const togglePhotoTick = (jobId: string, index: number) => {
    setPhotoUnticked(prev => {
      const off = new Set(prev[jobId] || [])
      if (off.has(index)) off.delete(index)
      else off.add(index)
      return { ...prev, [jobId]: [...off] }
    })
  }

  // Which items the phone re-encodes before saving. Same rule as video
  // downloads: only on iOS (everything else plays VP9/AV1 natively), for any
  // codec Photos won't import, and for every X video — X's H.264 still trips
  // Photos with its non-square SAR (see the poll handler's isTwitter note).
  const photoWillConvert = (url: string) => (f: PhotoFile) =>
    f.kind === 'video' && isIOS()
    && (isTwitterUrl(url) || (!!f.codec && f.codec !== 'h264' && f.codec !== 'hevc'))

  // Pull each file to the phone as soon as the server has it, one at a time,
  // so tiles fill in during the download instead of all at the end. Then
  // re-encode the videos Photos would refuse. Reads the server's state from
  // photoServer (the poll keeps it current), never from React state, so the
  // loop can run across many renders.
  const pumpPhotoJob = async (id: string, url: string) => {
    const ctl: { ac: AbortController; worker?: { cancel: () => void } } = { ac: new AbortController() }
    photoAbort.current[id] = ctl
    const cache: (File | undefined)[] = []
    photoCache.current[id] = cache
    photoUrls.current[id] = {}
    const log = (msg: string) => setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] photos: ${msg}`])
    const setItem = (i: number, v: PhotoItem) =>
      setPhotoItems(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [i]: v } }))
    const aborted = () => ctl.ac.signal.aborted

    for (let i = 0; !aborted(); ) {
      const srv = photoServer.current[id]
      if (!srv) return
      const meta = srv.files[i]
      if (!meta) {
        if (srv.status === 'downloading') { await new Promise(r => setTimeout(r, 400)); continue }
        break
      }
      setItem(i, { state: 'arriving', pct: 0 })
      try {
        const r = await fetch(`/api/photos/${id}/file/${meta.index}`, { cache: 'no-store', signal: ctl.ac.signal })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const total = parseInt(r.headers.get('content-length') || '0', 10)
        const type = r.headers.get('content-type') || 'application/octet-stream'
        const chunks: BlobPart[] = []
        if (r.body && total) {
          const reader = r.body.getReader()
          let got = 0
          let lastUi = 0
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            got += value.length
            const now = performance.now()
            if (now - lastUi > 250) { lastUi = now; setItem(i, { state: 'arriving', pct: (got / total) * 100 }) }
          }
        } else {
          chunks.push(await r.blob())
        }
        const file = new File(chunks, meta.name, { type })
        cache[i] = file
        if (meta.kind !== 'video') photoUrls.current[id][i] = URL.createObjectURL(file)
        setItem(i, { state: 'raw', pct: 100 })
      } catch (err: any) {
        if (aborted()) return
        log(`couldn't fetch ${meta.name}: ${err?.message || err}`)
        setItem(i, { state: 'failed', pct: 0 })
      }
      i++
    }
    if (aborted()) return

    const files = photoServer.current[id]?.files || []
    const willConvert = photoWillConvert(url)
    const canConvert = webCodecsProbe.current ? await webCodecsProbe.current : false
    for (const f of files) {
      if (aborted()) return
      const src = cache[f.index]
      if (!src || !willConvert(f)) continue
      if (!canConvert) {
        log(`${f.name} is ${f.codec || 'video'}, which Photos may refuse — this browser can't re-encode it`)
        continue
      }
      setItem(f.index, { state: 'converting', pct: 0 })
      log(`re-encoding ${f.name} (${f.codec || 'video'}) on device`)
      try {
        const handle = runWorker(
          src,
          { padTo9x16: false, burnSubtitles: false, srt: '' },
          (pct, stage) => setItem(f.index, { state: 'converting', pct, stage }),
          (msg) => log(`[worker] ${msg}`),
        )
        ctl.worker = handle
        const out = await handle.promise
        ctl.worker = undefined
        cache[f.index] = new File([out], f.name.replace(/\.[^.]+$/, '') + '.mp4', { type: 'video/mp4' })
        setItem(f.index, { state: 'ready', pct: 100 })
      } catch (err: any) {
        ctl.worker = undefined
        if (aborted()) return
        log(`couldn't re-encode ${f.name}: ${err?.message || err}`)
        setItem(f.index, { state: 'failed', pct: 0 })
      }
    }
    if (aborted()) return

    // Anything still 'raw' needed no work: it's final as it is.
    setPhotoItems(prev => {
      const items = { ...(prev[id] || {}) }
      for (const k of Object.keys(items)) {
        if (items[+k].state === 'raw') items[+k] = { state: 'ready', pct: 100 }
      }
      return { ...prev, [id]: items }
    })
    setPhotoJobs(prev => prev.map(j => j.id === id ? { ...j, ready: true } : j))
    haptic([15, 40, 15])
    delete photoAbort.current[id]
  }

  const removePhotoJob = (id: string) => {
    const ctl = photoAbort.current[id]
    if (ctl) {
      try { ctl.ac.abort() } catch {}
      try { ctl.worker?.cancel() } catch {}
      delete photoAbort.current[id]
    }
    for (const u of Object.values(photoUrls.current[id] || {})) URL.revokeObjectURL(u)
    delete photoUrls.current[id]
    delete photoCache.current[id]
    delete photoServer.current[id]
    fetch(`/api/photos/${id}`, { method: 'DELETE', cache: 'no-store' }).catch(() => {})
    setPhotoJobs(prev => prev.filter(j => j.id !== id))
    setPhotoItems(prev => { const n = { ...prev }; delete n[id]; return n })
    setPhotoUnticked(prev => { const n = { ...prev }; delete n[id]; return n })
  }

  // Start a gallery-dl job on the droplet. Skips metadata + format picking
  // entirely — submits the URL, polls the job, and pulls files as they land.
  const startPhotoJob = useCallback(async (rawUrl: string) => {
    const u = rawUrl.trim()
    if (!u) return
    setError('')
    const log = (msg: string) => setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] ${msg}`])
    log(`photos: starting ${u}`)
    try {
      const res = await fetch('/api/photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: u }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'failed')
      const newJob: PhotoJob = { id: data.id, url: u, status: 'downloading', files: [], startedAt: Date.now() }
      photoServer.current[data.id] = { status: 'downloading', files: [] }
      setPhotoJobs(prev => [newJob, ...prev])

      // Poll every 1s until the server is done. 'done' arrives only after
      // every file has been probed, so each video's codec is known by then.
      const poll = async () => {
        try {
          const r = await fetch(`/api/photos/${data.id}`, { cache: 'no-store' })
          if (!r.ok) return
          const state = await r.json() as {
            status: PhotoJob['status']; files: PhotoFile[]; error?: string
            author?: string; site?: string; expected?: number
          }
          if (!photoServer.current[data.id]) return 'gone'
          photoServer.current[data.id] = { status: state.status, files: state.files }
          setPhotoJobs(prev => prev.map(j => j.id === data.id ? {
            ...j, status: state.status, files: state.files, error: state.error,
            author: state.author, site: state.site, expected: state.expected,
          } : j))
          return state.status
        } catch {}
      }
      const interval = setInterval(async () => {
        const st = await poll()
        if (st === 'done' || st === 'error' || st === 'gone') clearInterval(interval)
      }, 1000)
      await poll()
      pumpPhotoJob(data.id, u)
    } catch (err: any) {
      log(`photos: error — ${err.message}`)
      setError(err.message || 'Failed to start photo job')
    }
    // pumpPhotoJob only touches refs and state setters, so the first render's
    // copy is as good as any later one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchInfo = useCallback(async (videoUrl: string) => {
    if (!videoUrl.trim()) return
    // Instagram post links (/p/) are photos or carousels far more often than
    // not, and gallery-dl takes every item, videos included. Reels stay on
    // yt-dlp. Direct image links go the same way.
    if (isInstagramPostUrl(videoUrl.trim()) || isImageLink(videoUrl.trim())) {
      startPhotoJob(videoUrl)
      return
    }
    setLoading(true)
    setError('')
    setVideos([])
    setQueuedVideoIds(new Set())
    setSelectedFormats({})
    autoTriggered.current = false

    const log = (msg: string) => setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] ${msg}`])
    const target = apiBase() || 'droplet'
    const trimmedUrl = videoUrl.trim()
    log(`fetchInfo: ${trimmedUrl} → ${target}`)

    // Abort if the server hasn't responded in 45s. The droplet's yt-dlp side
    // has a 30s timeout, so 45s leaves room for network jitter without leaving
    // the user staring at a spinner forever on a region-blocked URL.
    const ac = new AbortController()
    const timeoutId = setTimeout(() => ac.abort(), 45_000)

    try {
      const refQ = referer.trim() ? `&referer=${encodeURIComponent(referer.trim())}` : ''
      const path = `/api/info?url=${encodeURIComponent(trimmedUrl)}${refQ}`
      let res: Response
      try {
        res = await fetch(`${apiBase()}${path}`, { headers: apiHeaders(false), signal: ac.signal })
      } catch (netErr: any) {
        // The PC stopped answering since the last reachability check: drop
        // it for now (the next poll re-checks) and ask the server instead.
        if (!apiBase() || netErr?.name === 'AbortError') throw netErr
        log(`fetchInfo: desktop unreachable (${netErr?.message || netErr}) — using the server`)
        setDesktopTunnelUrl(null)
        res = await fetch(path, { signal: ac.signal })
      }
      log(`fetchInfo: HTTP ${res.status}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch')
      const vids: VideoInfo[] = data.videos || (data.id ? [data] : [])
      if (vids.length === 0) {
        log('fetchInfo: server returned 0 videos — likely region-blocked or extractor failed')
        throw new Error('No videos returned (region-blocked, private, or extractor failed)')
      }
      log(`fetchInfo: ${vids.length} video(s) returned`)
      setVideos(vids)
      // Set default format for each video
      const defaults: Record<string, string> = {}
      for (const v of vids) {
        defaults[v.id] = v.formats[0]?.formatId || 'b'
      }
      setSelectedFormats(defaults)
    } catch (err: any) {
      const msg = err?.name === 'AbortError'
        ? 'Timed out after 45s — server probably stuck on this URL'
        : err.message || 'Failed to fetch video info'
      // yt-dlp saying there's simply no video here (a photo tweet, an image
      // post, an album on a site it doesn't know) hands the link to
      // gallery-dl. Only those exact wordings: a region block or a private
      // post should still read as that.
      if (err?.name !== 'AbortError' && NO_VIDEO_HERE.test(msg)) {
        log(`fetchInfo: no video in this post — trying gallery-dl`)
        startPhotoJob(trimmedUrl)
        return
      }
      log(`fetchInfo: error — ${msg}`)
      setError(msg)
    } finally {
      clearTimeout(timeoutId)
      setLoading(false)
    }
    // Deps: apiBase/apiHeaders close over desktopTunnelUrl + desktopKey;
    // startPhotoJob is stable (empty deps).
  }, [desktopTunnelUrl, settings.desktopKey, startPhotoJob])

  const handleDownload = async (video: VideoInfo, formatId: string, formatLabel: string, opts: { noDirect?: boolean } = {}) => {
    haptic(10) // light tap on download start (Android/desktop; no-op on iOS)
    // Direct download mode: browser fetches from source URL
    if (settings.directDownload) {
      try {
        const r = await fetch(`${apiBase()}/api/geturl`, {
          method: 'POST',
          headers: apiHeaders(true),
          body: JSON.stringify({ url: video.url, formatId }),
        })
        const data = await r.json()
        if (!r.ok) throw new Error(data.error || 'Failed')
        const a = document.createElement('a')
        a.href = data.url
        a.download = `${video.title}.mp4`.replace(/[^\w.\-]/g, '_')
        a.target = '_blank'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        return
      } catch (err: any) {
        setError(err.message || 'Direct download failed')
        return
      }
    }

    // From here on a download card will replace this video's result card, so
    // hide the card now — before the awaits below, or auto-best would flash it.
    // Every way out that doesn't start a job puts it back for a retry.
    setQueuedVideoIds(prev => new Set(prev).add(video.id))
    const unqueue = () => setQueuedVideoIds(prev => {
      const next = new Set(prev)
      next.delete(video.id)
      return next
    })

    // X without the desktop: the phone fetches the file from X's CDN itself
    // (see startDirectDownload). Not with subtitle burning — that needs the
    // server's Whisper transcript. Decided here so the server disk check below
    // doesn't block a download the server will never hold.
    const pick = video.formats.find(f => f.formatId === formatId)
    const tryDirect = !apiBase() && !!pick?.directUrl && !settings.burnSubtitles && !opts.noDirect

    // Pre-flight disk check — only for droplet-hosted downloads (the desktop
    // path uses the user's PC disk, which has ample room). Best-effort: many
    // YouTube formats report no filesize, in which case we skip the check and
    // rely on the server's floor. ×1.3 accounts for muxing/remux overhead.
    if (!apiBase() && !tryDirect) {
      const fmt = video.formats.find(f => f.formatId === formatId)
      const estBytes = fmt?.filesize ? fmt.filesize * 1.3 : 0
      if (estBytes > 0) {
        let free = diskInfo?.freeBytes
        if (free === undefined) {
          try {
            const r = await fetch('/api/disk', { cache: 'no-store' })
            const d = await r.json()
            if (d.available) { free = d.freeBytes; setDiskInfo({ freeBytes: d.freeBytes, totalBytes: d.totalBytes, grabberBytes: d.grabberBytes }) }
          } catch {}
        }
        if (free !== undefined && estBytes > free) {
          const gb = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`
          setError(`Not enough server space — need ~${gb(estBytes)}, only ${gb(free)} free. Clear space in Settings or pick a lower quality.`)
          unqueue()
          return
        }
      }
    }

    // Confirm processing path. If user wants desktop but it's not online,
    // ensureProcessingPath shows the modal and waits for a decision.
    const proceed = await ensureProcessingPath()
    if (!proceed) { unqueue(); return }

    // Wait for the WebCodecs probe to settle so the auto-pick is correct.
    const probed = webCodecsProbe.current ? await webCodecsProbe.current : false
    // Auto-pick: instant mode whenever desktop ISN'T being used AND the
    // browser supports WebCodecs. The server now hands back the raw file
    // and the client handles any required transcoding (codec mismatch,
    // pad to 9:16, burn subs) on the iPhone's hardware encoder — way
    // faster than the droplet's 1-vCPU libx264.
    const usingDesktop = !!apiBase()
    const useInstant = !usingDesktop && probed

    // On iOS an X file must be re-encoded before Photos accepts it, which the
    // direct path can only do on-device — so it needs WebCodecs there.
    if (tryDirect && !usingDesktop && pick?.directUrl && (probed || !isIOS())) {
      startDirectDownload(video, formatId, pick.directUrl, formatLabel, probed)
      return
    }

    // One "Downloading" bar covers the server's download and the phone's pull,
    // weighted by roughly how long each takes (the PC is fast both ways; the
    // droplet downloads in seconds but reaches Pakistan at ~1 MiB/s). When the
    // server converts in between, a single bar would have to run backwards
    // through the conversion, so the pull stays its own short step instead.
    const serverConverts = useInstant
      ? settings.burnSubtitles
      : isTwitterUrl(video.url) || settings.verticalPad || settings.burnSubtitles
    const xferShare = serverConverts ? 0 : usingDesktop ? 0.2 : 0.9

    try {
      const res = await fetch(`${apiBase()}/api/download`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          url: video.url,
          formatId,
          title: video.title,
          thumbnail: video.thumbnail,
          playlistIndex: video.playlistIndex,
          verticalPad: settings.verticalPad,
          duration: video.duration,
          burnSubtitles: settings.burnSubtitles,
          instantMode: useInstant,
          referer: referer.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      const job: DownloadJob = {
        id: data.id,
        title: video.title,
        thumbnail: video.thumbnail,
        status: 'downloading',
        percent: 0, speed: '', eta: '', totalSize: '',
        url: video.url,
        formatLabel,
        xferShare,
        startedAt: Date.now(),
      }

      setDownloads(prev => [job, ...prev])

      // Poll for progress (SSE doesn't work through Cloudflare free tunnel)
      console.log('[poll] Starting polling for', data.id)
      let logsSince = 0
      let stopped = false
      let donePrefetched = false

      // Register a cancel handle for this job — lets handleCancelDownload stop us
      cancelHandles.current[data.id] = {
        stop: () => { stopped = true },
      }
      const poll = async () => {
        if (stopped) return
        try {
          const r = await fetch(`${apiBase()}/api/progress/${data.id}?logsSince=${logsSince}`, { cache: 'no-store', headers: apiHeaders(false) })
          if (!r.ok) {
            console.error('[poll] HTTP', r.status)
            return
          }
          const state = await r.json()
          console.log('[poll]', state.status, state.percent + '%', state.speed)

          // Append new logs to debug panel
          if (state.logs && state.logs.length) {
            setDebugLogs(prev => [...prev.slice(-80), ...state.logs])
            logsSince = state.logsTotal
          }

          setDownloads(prev => prev.map(d => {
            if (d.id !== data.id) return d
            const next = {
              ...d,
              status: state.status,
              percent: state.percent,
              speed: state.speed || '',
              eta: state.eta || '',
              totalSize: state.totalSize || '',
              fileName: state.fileName || d.fileName,
              error: state.error || d.error,
              // A conversion nobody predicted (e.g. a VP9 source) sits between
              // the download and the pull; show the pull as its own step rather
              // than send the merged bar back to where the download stopped.
              xferShare: state.status === 'converting' || state.status === 'subtitling' ? 0 : d.xferShare,
            }
            return next
          }))

          if (state.status === 'done' && !donePrefetched) {
            donePrefetched = true
            const usingDesktop = !settings.skipDesktop && !!(desktopTunnelUrl && settings.desktopKey)
            // WebCodecs handles four jobs locally: 9:16 pad, subtitle burn,
            // codec transcode (when source isn't iOS-Photos-compatible —
            // VP9/AV1), AND iOS-fixup for Twitter (H.264 source but with
            // non-square SAR + odd profile that iOS Photos rejects).
            //
            // Both compatibility re-encodes are iOS-ONLY. Desktop and Android
            // browsers play VP9/AV1 natively, so re-encoding there is pure
            // loss: it costs minutes and throws away quality (a 2160p AV1
            // download came back as an 8 MB blur). Pad and subtitles are
            // explicit user requests, so those still run everywhere.
            const ios = isIOS()
            const needsCodecTranscode = ios
              && !!state.sourceCodec
              && state.sourceCodec !== 'h264'
              && state.sourceCodec !== 'hevc'
            let isTwitter = false
            try {
              const h = new URL(video.url).hostname.replace(/^www\./, '')
              isTwitter = ios && (h === 'twitter.com' || h === 'x.com' || h === 't.co')
            } catch {}
            const needsWebCodecs = settings.burnSubtitles || settings.verticalPad || needsCodecTranscode || isTwitter
            const useInstant = !usingDesktop && webCodecsSupported && needsWebCodecs
            if (needsCodecTranscode) {
              setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] source codec=${state.sourceCodec} — transcoding on device via WebCodecs`])
            } else if (isTwitter) {
              setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] twitter source — re-encoding on device via WebCodecs for iOS Photos`])
            }
            const fileBytes = state.fileSize || 0
            const tooBigForMemory = fileBytes > MAX_INMEMORY_BYTES
            if (tooBigForMemory) {
              setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] File is ${(fileBytes / 1048576).toFixed(0)}MB (> ${MAX_INMEMORY_BYTES / 1048576}MB) — downloading directly to disk instead of buffering in memory`])
            }
            if (useInstant && !tooBigForMemory) {
              // Instant mode: fetch raw video, process on-device with WebCodecs.
              prefetchAndProcess(data.id, state.fileName, state.srt || '', settings.verticalPad, settings.burnSubtitles)
            } else if (!tooBigForMemory && typeof navigator !== 'undefined' && 'share' in navigator) {
              prefetchFile(data.id, state.fileName)
            } else {
              // Large file (or no share support): stream straight to disk via an
              // <a download>. Buffering a 400MB+/1GB+ file into a JS Blob (for
              // share/WebCodecs) OOM-crashes the tab — white flash + reload.
              triggerFileDownload(data.id, state.fileName)
            }
          }

          if (state.status === 'done' || state.status === 'error') {
            stopped = true
            // Buzz on finish: a short double-tap for success, a longer one for error.
            haptic(state.status === 'done' ? [15, 40, 15] : [60, 40, 60])
            console.log('[poll] Terminal state reached, stopping')
            return
          }
        } catch (err) {
          console.error('[poll] Error', err)
        }
      }

      // Poll every 500ms
      const interval = setInterval(() => {
        if (stopped) {
          clearInterval(interval)
          return
        }
        poll()
      }, 500)
      // Immediate first poll
      poll()
    } catch (err: any) {
      setError(err.message || 'Failed to start download')
      unqueue()
    }
  }

  // X straight from its CDN to the phone: no server job, so downloading and
  // "send to phone" are the same step. Any failure before the file is in hand
  // falls back to the server path, so the user still gets the video.
  const startDirectDownload = async (video: VideoInfo, formatId: string, directUrl: string, formatLabel: string, canProcess: boolean) => {
    const id = `direct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const log = (msg: string) => setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] ${msg}`])
    const ac = new AbortController()
    cancelHandles.current[id] = { stop: () => {}, abort: ac }
    const job: DownloadJob = {
      id,
      title: video.title,
      thumbnail: video.thumbnail,
      status: 'downloading',
      percent: 0, speed: '', eta: '', totalSize: '',
      url: video.url,
      formatLabel,
      direct: true,
      startedAt: Date.now(),
    }
    setDownloads(prev => [job, ...prev])
    log(`direct: ${formatLabel} from ${new URL(directUrl).host}`)

    let blob: Blob
    try {
      blob = await fetchInPieces(directUrl, ac.signal, (received, total, bps) => {
        setDownloads(prev => prev.map(d => d.id !== id ? d : {
          ...d,
          percent: (received / total) * 100,
          speed: formatSpeed(bps),
          eta: formatEta((total - received) / bps),
          totalSize: `${(total / 1048576).toFixed(2)}MiB`,
        }))
      })
    } catch (err: any) {
      // Cancelled: handleCancelDownload has already marked the card.
      if (ac.signal.aborted) return
      log(err instanceof DirectTooBigError
        ? `direct: too big to hold in memory (${err.message}) — using the server`
        : `direct: failed (${err?.message || err}) — using the server`)
      delete cancelHandles.current[id]
      setDownloads(prev => prev.filter(d => d.id !== id))
      handleDownload(video, formatId, formatLabel, { noDirect: true })
      return
    }

    haptic([15, 40, 15])
    const name = `${(video.title || 'video').slice(0, 80)}.mp4`
    setDownloads(prev => prev.map(d => d.id !== id ? d : {
      ...d, status: 'done' as const, percent: 100, speed: '', eta: '', fileName: name,
    }))
    log(`direct: done, ${(blob.size / 1048576).toFixed(1)} MB`)

    // X files need the iOS-compat re-encode before Photos takes them, same as
    // on the server path; elsewhere only an explicit 9:16 pad needs the worker.
    if (canProcess && (isIOS() || settings.verticalPad)) {
      try {
        await processOnDevice(id, blob, name, '', settings.verticalPad, false)
        return
      } catch (err: any) {
        if (err?.name === 'AbortError' || /cancel/i.test(err?.message || '')) return
        log(`direct: device processing failed (${err?.message || err}) — keeping the original file`)
        setInstantProgress(prev => { const n = { ...prev }; delete n[id]; return n })
      }
    }
    fileCache.current[id] = new File([blob], name, { type: 'video/mp4' })
    setFileReady(prev => ({ ...prev, [id]: true }))
    delete cancelHandles.current[id]
  }

  // Pre-fetch file from server into cache (with progress), called automatically when download completes on mobile
  const prefetchFile = async (id: string, fileName: string) => {
    const fileUrl = `${apiBase()}/api/file/${id}`
    const name = fileName || 'video.mp4'
    // Register an abort handle so the X button actually stops the transfer —
    // without this, cancelling during "Preparing…" only updated the card while
    // the fetch kept pulling the whole file in the background.
    const ac = new AbortController()
    const existing = cancelHandles.current[id] || { stop: () => {} }
    cancelHandles.current[id] = { ...existing, abort: ac }
    try {
      setSaveProgress(prev => ({ ...prev, [id]: 0 }))
      const res = await fetch(fileUrl, { headers: apiHeaders(false), signal: ac.signal })
      const contentLength = res.headers.get('content-length')
      const total = contentLength ? parseInt(contentLength, 10) : 0

      // Safety net: never buffer a large file into memory (OOM-crashes the
      // tab). If it's over the limit, abandon the stream and hand off to a
      // plain <a download> that writes straight to disk. Covers the manual
      // "Save to Photos" tap and any retry, not just the auto path above.
      if (total > MAX_INMEMORY_BYTES) {
        try { await res.body?.cancel() } catch {}
        setSaveProgress(prev => { const n = { ...prev }; delete n[id]; return n })
        triggerFileDownload(id, fileName)
        return
      }

      let blob: Blob
      if (total && res.body) {
        const reader = res.body.getReader()
        const chunks: BlobPart[] = []
        let received = 0
        const t0 = performance.now()
        let lastUi = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          const now = performance.now()
          if (now - lastUi > 300) {
            lastUi = now
            const bps = received / ((now - t0) / 1000)
            setSaveProgress(prev => ({ ...prev, [id]: Math.round((received / total) * 100) }))
            setSaveSpeed(prev => ({ ...prev, [id]: formatSpeed(bps) }))
            setSaveEta(prev => ({ ...prev, [id]: formatEta((total - received) / bps) }))
          }
        }
        setSaveProgress(prev => ({ ...prev, [id]: 100 }))
        // Hand the chunks straight to Blob — no manual concat. Saves a 2nd
        // full-size copy in memory; iOS Safari OOM-kills the tab around
        // ~250 MB peak, which a 100 MB video could hit with double-buffering.
        blob = new Blob(chunks, { type: 'video/mp4' })
      } else {
        setSaveProgress(prev => ({ ...prev, [id]: -1 }))
        blob = await res.blob()
      }

      // Reject suspiciously small files — server-side guard already rejects
      // < 1 KB but defend in depth in case it slips through.
      if (blob.size < 1024) {
        setError(`Got a ${blob.size}-byte file — server likely returned a stream error. Try again or turn off Skip Desktop.`)
        setSaveProgress(prev => { const n = { ...prev }; delete n[id]; return n })
        return
      }

      const ext = name.split('.').pop()?.toLowerCase()
      const mime = ext === 'webm' ? 'video/webm' : 'video/mp4'
      fileCache.current[id] = new File([blob], name, { type: mime })
      setSaveProgress(prev => { const n = { ...prev }; delete n[id]; return n })
      setSaveSpeed(prev => { const n = { ...prev }; delete n[id]; return n })
      setSaveEta(prev => { const n = { ...prev }; delete n[id]; return n })
      setFileReady(prev => ({ ...prev, [id]: true }))
    } catch {
      // Prefetch failed or was cancelled — clear progress, user can tap to retry
      setSaveProgress(prev => { const n = { ...prev }; delete n[id]; return n })
      setSaveSpeed(prev => { const n = { ...prev }; delete n[id]; return n })
      setSaveEta(prev => { const n = { ...prev }; delete n[id]; return n })
    }
  }

  // Run the WebCodecs worker on a file already in memory, then cache the
  // result for Save to Photos. Throws on failure or cancel; callers decide
  // the fallback.
  const processOnDevice = async (id: string, rawBlob: Blob, name: string, srt: string, padTo9x16: boolean, burnSubtitles: boolean) => {
    setInstantProgress(prev => ({ ...prev, [id]: { pct: 0, stage: 'Starting device encoder...' } }))
    setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] Instant mode: starting WebCodecs worker (${(rawBlob.size / 1024 / 1024).toFixed(1)} MB)`])

    const handle = runWorker(
      rawBlob,
      { padTo9x16, burnSubtitles, srt },
      (pct, stage) => {
        setInstantProgress(prev => ({ ...prev, [id]: { pct, stage } }))
      },
      (msg) => {
        // Worker console.log / warn / error forwarded to our on-screen debug panel
        setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] [worker] ${msg}`])
      },
    )
    // Register worker in cancel handles so the cancel button can terminate it
    const existingHandle = cancelHandles.current[id] || { stop: () => {} }
    cancelHandles.current[id] = { ...existingHandle, worker: handle }
    const processed = await handle.promise

    setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] Instant mode done: ${(processed.size / 1024 / 1024).toFixed(1)} MB`])

    // Swap the cached file for the processed version, enable Save to Photos
    const outName = name.replace(/\.[^.]+$/, '') + '_processed.mp4'
    fileCache.current[id] = new File([processed], outName, { type: 'video/mp4' })
    setInstantProgress(prev => { const n = { ...prev }; delete n[id]; return n })
    setFileReady(prev => ({ ...prev, [id]: true }))
    delete cancelHandles.current[id]
  }

  // Instant mode: fetch raw video from server, then process locally via WebCodecs worker.
  // Shows green "Preparing..." during fetch, then cyan "Processing on device..." during encode.
  const prefetchAndProcess = async (id: string, fileName: string, srt: string, padTo9x16: boolean, burnSubtitles: boolean) => {
    const fileUrl = `${apiBase()}/api/file/${id}`
    const name = fileName || 'video.mp4'

    // Register abort controller for the fetch (cancel button can trigger this)
    const ac = new AbortController()
    const existing = cancelHandles.current[id] || { stop: () => {} }
    cancelHandles.current[id] = { ...existing, abort: ac }

    try {
      // Step 1: fetch raw video from server with progress (same as prefetchFile)
      setSaveProgress(prev => ({ ...prev, [id]: 0 }))
      const res = await fetch(fileUrl, { signal: ac.signal, headers: apiHeaders(false) })
      const contentLength = res.headers.get('content-length')
      const total = contentLength ? parseInt(contentLength, 10) : 0
      let rawBlob: Blob
      if (total && res.body) {
        const reader = res.body.getReader()
        const chunks: BlobPart[] = []
        let received = 0
        const t0 = performance.now()
        let lastUi = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          const now = performance.now()
          if (now - lastUi > 300) {
            lastUi = now
            const bps = received / ((now - t0) / 1000)
            setSaveProgress(prev => ({ ...prev, [id]: Math.round((received / total) * 100) }))
            setSaveSpeed(prev => ({ ...prev, [id]: formatSpeed(bps) }))
            setSaveEta(prev => ({ ...prev, [id]: formatEta((total - received) / bps) }))
          }
        }
        // Skip manual concat — see prefetchFile for the iOS Safari OOM rationale.
        rawBlob = new Blob(chunks, { type: 'video/mp4' })
      } else {
        setSaveProgress(prev => ({ ...prev, [id]: -1 }))
        rawBlob = await res.blob()
      }
      setSaveProgress(prev => { const n = { ...prev }; delete n[id]; return n })
      setSaveSpeed(prev => { const n = { ...prev }; delete n[id]; return n })
      setSaveEta(prev => { const n = { ...prev }; delete n[id]; return n })

      // Same tiny-file guard as prefetchFile — bail before WebCodecs decodes garbage.
      if (rawBlob.size < 1024) {
        setError(`Got a ${rawBlob.size}-byte file — server likely returned a stream error. Try again or turn off Skip Desktop.`)
        return
      }

      // Steps 2–3: WebCodecs worker — local pad + burn subs — then Save to Photos.
      await processOnDevice(id, rawBlob, name, srt, padTo9x16, burnSubtitles)
    } catch (err: any) {
      // If cancelled, the fetch / worker was aborted intentionally — don't fall through
      if (err?.name === 'AbortError' || /cancel/i.test(err?.message || '')) {
        setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] Cancelled by user`])
        return
      }
      console.error('[instant] failed:', err)
      setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] Instant mode error: ${err?.message || err}`])
      // Clear instant progress, keep saveProgress clear too
      setInstantProgress(prev => { const n = { ...prev }; delete n[id]; return n })
      setSaveProgress(prev => { const n = { ...prev }; delete n[id]; return n })
      // Fall back to plain prefetch so user can at least download the un-processed video
      prefetchFile(id, fileName)
    }
  }

  // Called from user tap — must be synchronous (no awaits before navigator.share)
  const handleSaveToPhotos = async (id: string, fileName: string) => {
    const cached = fileCache.current[id]
    if (!cached) {
      // A direct download only ever existed in memory; the server has no copy.
      if (id.startsWith('direct-')) {
        setError('That video is no longer in memory. Download it again.')
        return
      }
      setDebugLogs(prev => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] Save: no cached file, re-fetching`])
      prefetchFile(id, fileName)
      return
    }

    // Rebuild file with a safe filename (strip emojis/special chars that break navigator.share)
    const safeName = (cached.name || 'video.mp4').replace(/[^\w.\-]/g, '_').replace(/_+/g, '_')
    const safeFile = new File([cached], safeName, { type: 'video/mp4' })

    setDebugLogs(prev => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] Save: ${safeName} (${Math.round(safeFile.size / 1024)}KB)`])

    // Once iOS Safari's share state is broken, navigator.share() throws
    // InvalidStateError forever (only a tab reload clears it). Skip straight
    // to the blob-URL download in that case so the user still gets the file.
    if (shareStateBroken.current) {
      setDebugLogs(prev => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] Safari share stuck — using download fallback`])
      handleDirectDownload(id, fileName)
      return
    }

    if (shareInFlight.current) {
      setDebugLogs(prev => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] Share already pending — ignoring tap`])
      return
    }

    if (navigator.canShare && !navigator.canShare({ files: [safeFile] })) {
      setDebugLogs(prev => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] canShare() returned false`])
      handleDirectDownload(id, fileName)
      return
    }

    shareInFlight.current = true
    try {
      await navigator.share({ files: [safeFile] })
      setDebugLogs(prev => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] Share sheet opened`])
    } catch (err: any) {
      setDebugLogs(prev => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] Share error: ${err?.name} - ${err?.message}`])
      if (err?.name === 'AbortError') return
      if (err?.name === 'InvalidStateError') {
        // Safari's share state is stuck — every subsequent share() will throw
        // until the tab reloads. Mark it broken so future taps take the fallback.
        shareStateBroken.current = true
        handleDirectDownload(id, fileName)
      }
    } finally {
      shareInFlight.current = false
    }
  }

  // Direct download from cached file — uses blob URL so it works on mobile too
  const handleDirectDownload = (id: string, fileName: string) => {
    const cached = fileCache.current[id]
    if (cached) {
      const safeName = (cached.name || fileName || 'video.mp4').replace(/[^\w.\-]/g, '_').replace(/_+/g, '_')
      const blobUrl = URL.createObjectURL(cached)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = safeName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
      return
    }
    triggerFileDownload(id, fileName)
  }

  // Desktop fallback — normal browser download
  const triggerFileDownload = (id: string, fileName: string) => {
    // For desktop-routed downloads we have to pass the cookie key via the
    // URL — Safari strips custom headers from <a download> navigations,
    // so the desktop's webserver would 401 without an inline key.
    const usingDesktop = !settings.skipDesktop && !!(desktopTunnelUrl && settings.desktopKey)
    const keyParam = usingDesktop ? `?key=${encodeURIComponent(settings.desktopKey)}` : ''
    const fileUrl = `${apiBase()}/api/file/${id}${keyParam}`
    const name = fileName || 'video.mp4'
    const a = document.createElement('a')
    a.href = fileUrl
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        setUrl(text.trim())
        fetchInfo(text.trim())
      }
    } catch {
      inputRef.current?.focus()
    }
  }

  const inputRef = useRef<HTMLInputElement>(null)

  const handleReload = async () => {
    // Clear everything first
    setUrl('')
    setVideos([])
    setQueuedVideoIds(new Set())
    setError('')
    setDownloads([])
    setSaveProgress({})
    setSaveSpeed({})
    setFileReady({})
    fileCache.current = {}
    autoTriggered.current = false

    // Try to read clipboard and auto-paste
    try {
      const text = await navigator.clipboard.readText()
      if (text?.trim()) {
        const clipUrl = text.trim()
        setUrl(clipUrl)
        fetchInfo(clipUrl)
        return
      }
    } catch {
      // Clipboard API not available (iOS Safari, permission denied, etc.)
    }

    // Fallback: focus input so user can paste manually
    inputRef.current?.focus()
  }

  const removeDownload = (id: string) => {
    setDownloads(prev => prev.filter(d => d.id !== id))
  }

  // Tapping the Build number asks whichever backend is doing the work (the
  // droplet when Skip Desktop is on, else the desktop) to print a full
  // diagnostic block — jobs, errors, Python tracebacks, proxy, pool, disk —
  // to ITS terminal. Also mirrors the snapshot into the on-page debug panel
  // and the browser console so it's visible without terminal access.
  const dumpServerDebug = async () => {
    const stamp = new Date().toLocaleTimeString()
    setDebugLogs(prev => [...prev.slice(-80), `[${stamp}] Build tapped → requesting server diagnostic dump (${apiBase() || 'droplet'})...`])
    try {
      const res = await fetch(`${apiBase()}/api/debug`, { method: 'POST', cache: 'no-store', headers: apiHeaders(false) })
      if (!res.ok) {
        setDebugLogs(prev => [...prev.slice(-80), `[${stamp}] debug dump failed: HTTP ${res.status} (no /api/debug on this backend?)`])
        return
      }
      const snap = await res.json()
      console.log('[debug] server snapshot:', snap)
      const failed = (snap.jobs || []).filter((j: any) => j.status === 'error')
      setDebugLogs(prev => [
        ...prev.slice(-80),
        `[${stamp}] dumped to server terminal — proxy=${snap.env?.proxyUrl || 'NONE'} pool=${JSON.stringify(snap.pool)} jobs=${snap.jobCount}`,
        ...failed.map((j: any) => `[${stamp}]   FAILED ${j.url} → ${j.error || 'unknown'}`),
      ])
    } catch (err: any) {
      setDebugLogs(prev => [...prev.slice(-80), `[${stamp}] debug dump error: ${err?.message || err}`])
    }
  }

  const handleCancelDownload = async (id: string) => {
    setDebugLogs(prev => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] Cancelling ${id}`])

    // 1. Stop local polling, abort fetches, terminate worker
    const handle = cancelHandles.current[id]
    if (handle) {
      try { handle.stop() } catch {}
      try { handle.abort?.abort() } catch {}
      try { handle.worker?.cancel() } catch {}
      delete cancelHandles.current[id]
    }

    // 2. Tell server to kill child processes and delete the file — unless the
    //    phone was fetching from the CDN itself, when there's no server job.
    if (!id.startsWith('direct-')) {
      try {
        await fetch(`${apiBase()}/api/cancel/${id}`, { method: 'POST', cache: 'no-store', headers: apiHeaders(false) })
      } catch (err) {
        console.error('[cancel] server request failed', err)
      }
    }

    // 3. Clear any per-id progress state
    setSaveProgress(prev => { const n = { ...prev }; delete n[id]; return n })
    setSaveSpeed(prev => { const n = { ...prev }; delete n[id]; return n })
    setSaveEta(prev => { const n = { ...prev }; delete n[id]; return n })
    setInstantProgress(prev => { const n = { ...prev }; delete n[id]; return n })
    setFileReady(prev => { const n = { ...prev }; delete n[id]; return n })
    delete fileCache.current[id]

    // 4. Update the download card — mark cancelled
    setDownloads(prev => prev.map(d => d.id === id ? {
      ...d,
      status: 'error' as any,
      error: 'Cancelled',
      speed: '',
      eta: '',
      totalSize: '',
    } : d))
  }

  // Video and photo jobs share the Downloads list, newest first.
  const feed: ({ kind: 'video'; t: number; dl: DownloadJob } | { kind: 'photo'; t: number; job: PhotoJob })[] = [
    ...downloads.map(dl => ({ kind: 'video' as const, t: dl.startedAt || 0, dl })),
    ...photoJobs.map(job => ({ kind: 'photo' as const, t: job.startedAt, job })),
  ].sort((a, b) => b.t - a.t)

  // Only terminal jobs: converting/subtitling videos and photo jobs still
  // pulling or re-encoding are active work, not "completed".
  const clearCompleted = () => {
    setDownloads(prev => prev.filter(d => d.status !== 'done' && d.status !== 'error'))
    for (const j of photoJobs) if (j.ready || j.status === 'error') removePhotoJob(j.id)
  }

  return (
    <div className="min-h-screen flex flex-col items-center sm:px-4 sm:py-6">
      {/* App shell — the whole app lives in a molded slate box centered on
          the black page (full-bleed on phones, boxed from sm: up). */}
      <div className="app-shell w-full max-w-lg flex-1 flex flex-col overflow-hidden">
      {/* Toolbar — beveled console strip: tappable Build tag (debug panel),
          live clock, raised Settings button. Build lives here because
          iPhone's home indicator was getting in the way of tapping it. */}
      <header className="w-full px-3 pt-3">
        <div className="toolbar flex items-center justify-between gap-2 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-primary">
          <button
            onClick={() => setShowGallery(true)}
            className="raised px-2.5 py-1 text-[10px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            title="Files on the server"
          >
            <span className="inline-flex items-center gap-1.5"><Images size={12} /> Gallery</span>
          </button>
          <span onClick={() => { setShowDebug(s => !s); dumpServerDebug() }} className="cursor-pointer hover:text-danger transition-colors py-1.5">
            Build {process.env.NEXT_PUBLIC_BUILD || 'dev'}
          </span>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="raised px-2.5 py-1 text-[10px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            title="Settings"
          >
            <span className="inline-flex items-center gap-1.5"><Settings size={12} /> Settings</span>
          </button>
        </div>
      </header>

      {/* Gallery — same slide-up treatment as Settings. Lists what's actually
          on the server so it can be shared or deleted from one place. */}
      {showGallery && <GallerySheet onClose={() => setShowGallery(false)} />}

      {/* Settings — bottom sheet: slides up over the page like a native app
          instead of shoving the content down. Tap the dimmed backdrop (or the
          gear again) to close. */}
      {showSettings && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-backdrop-in"
            onClick={() => setShowSettings(false)}
          />
          <div
            className="absolute bottom-0 inset-x-0 mx-auto w-full max-w-lg sheet-panel max-h-[85vh] overflow-y-auto overscroll-contain px-4 pt-2 space-y-4 animate-sheet-up"
            style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
          >
          {/* Grab handle — signals "this is a sheet" */}
          <div className="mx-auto h-1.5 w-10 bg-surface-2 border border-subtle" />
          <div className="flex items-center justify-between">
            <p className="pixel-head text-xs font-bold uppercase tracking-[0.24em]">Settings</p>
            <button
              onClick={() => setSettings(s => ({ ...defaultSettings, desktopKey: s.desktopKey }))}
              className="text-xs uppercase tracking-wider text-text-muted hover:text-accent transition-colors"
            >
              Reset
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">Auto-detect clipboard</p>
              <p className="text-xs text-text-muted">Automatically detects video URLs when you copy them</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input type="checkbox" checked={settings.autoDetect} onChange={(e) => setSettings(s => ({ ...s, autoDetect: e.target.checked }))} className="sr-only peer" />
              <div className="cb-box" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">Auto best quality</p>
              <p className="text-xs text-text-muted">Instantly downloads best quality when URL is detected</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input type="checkbox" checked={settings.autoBest} onChange={(e) => setSettings(s => ({ ...s, autoBest: e.target.checked }))} className="sr-only peer" />
              <div className="cb-box" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">Pad to 9:16 vertical</p>
              <p className="text-xs text-text-muted">Adds black bars for Reels/TikTok</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input type="checkbox" checked={settings.verticalPad} onChange={(e) => setSettings(s => ({ ...s, verticalPad: e.target.checked }))} className="sr-only peer" />
              <div className="cb-box" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">Burn English subtitles</p>
              <p className="text-xs text-text-muted">Auto-translates and burns subtitles into the video</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input type="checkbox" checked={settings.burnSubtitles} onChange={(e) => setSettings(s => ({ ...s, burnSubtitles: e.target.checked }))} className="sr-only peer" />
              <div className="cb-box" />
            </label>
          </div>

          {/* Skip-desktop override. Greyed out until a desktopKey is set —
              if no desktop is configured there's nothing to skip. */}
          <div className={`flex items-center justify-between ${!settings.desktopKey ? 'opacity-40' : ''}`}>
            <div>
              <p className="text-sm font-medium text-text-primary">Skip desktop</p>
              <p className="text-xs text-text-muted">Bypass your PC for this session — process on phone/server instead</p>
            </div>
            <label className={`relative inline-flex ${settings.desktopKey ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
              <input
                type="checkbox"
                disabled={!settings.desktopKey}
                checked={settings.skipDesktop}
                onChange={(e) => setSettings(s => ({ ...s, skipDesktop: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="cb-box" />
            </label>
          </div>

          {/* Live status of where this download will run */}
          <div className="text-xs text-text-muted pt-2 border-t border-subtle">
            {settings.skipDesktop && settings.desktopKey
              ? <>Skipping desktop — {webCodecsSupported ? 'processing on this device (WebCodecs)' : 'processing on the Grabber server'}</>
              : desktopTunnelUrl && settings.desktopKey
                ? <>Routing through your desktop (NVENC) — <span className="text-success">{new URL(desktopTunnelUrl).hostname}</span></>
                : webCodecsSupported
                  ? 'Processing on this device (WebCodecs)'
                  : 'Processing on the Grabber server'}
          </div>

          {/* Server disk usage — sleek bar. The accent segment is the part
              Clear can free (Grabber downloads/photos); the muted segment is
              OS/swap and is untouchable. */}
          {diskInfo && (() => {
            const { totalBytes, freeBytes, grabberBytes } = diskInfo
            const fmt = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0, Math.round(b / 1e6))} MB`
            const used = Math.max(0, totalBytes - freeBytes)
            const osBytes = Math.max(0, used - grabberBytes)
            const pct = (b: number) => totalBytes > 0 ? Math.min(100, (b / totalBytes) * 100) : 0
            return (
              <div className="pt-3 border-t border-subtle space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-text-secondary">Server disk</p>
                  <p className="text-xs text-text-muted font-mono">{fmt(freeBytes)} free of {fmt(totalBytes)}</p>
                </div>
                <div className="tbar-track flex h-3 w-full overflow-hidden">
                  <div className="bg-[#5a6273] transition-all duration-300" style={{ width: `${pct(osBytes)}%` }} title="System (not clearable)" />
                  <div className="tbar-fill text-[#4fc455] transition-all duration-300" style={{ width: `${pct(grabberBytes)}%` }} title="Grabber downloads (clearable)" />
                </div>
                <button
                  onClick={clearDisk}
                  disabled={clearingDisk || grabberBytes < 1024 * 1024}
                  className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary disabled:text-text-muted disabled:hover:text-text-muted transition-colors"
                  title="Deletes finished downloads & photos only — never system files"
                >
                  {clearingDisk
                    ? <><Loader size={12} className="animate-spin" /> Clearing…</>
                    : grabberBytes >= 1024 * 1024
                      ? <><Trash2 size={12} /> Clear {fmt(grabberBytes)} of downloads</>
                      : <><Trash2 size={12} /> Nothing to clear</>}
                </button>
              </div>
            )
          })()}

          {/* Advanced — collapsed by default */}
          <button
            onClick={() => setShowAdvanced(s => !s)}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
          >
            <ChevronDown size={14} className={`transition-transform ${showAdvanced ? '' : '-rotate-90'}`} />
            Advanced
          </button>

          {showAdvanced && (
            <div className="space-y-4 pl-3 border-l border-subtle">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-text-primary">Direct download</p>
                  <p className="text-xs text-text-muted">Skips server entirely (Grabber Helper extension only)</p>
                </div>
                <label className="relative inline-flex cursor-pointer">
                  <input type="checkbox" checked={settings.directDownload} onChange={(e) => setSettings(s => ({ ...s, directDownload: e.target.checked }))} className="sr-only peer" />
                  <div className="cb-box" />
                </label>
              </div>

              <div>
                <p className="text-sm font-medium text-text-primary">Desktop cookie key</p>
                <p className="text-xs text-text-muted mb-2">Routes downloads through your PC's NVENC if set + the desktop app is online</p>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Optional"
                  value={settings.desktopKey}
                  onChange={(e) => setSettings(s => ({ ...s, desktopKey: e.target.value }))}
                  style={{ WebkitTextSecurity: 'disc' } as any}
                  className="w-full h-10 px-3 text-xs inset-field focus:outline-none font-mono"
                />
              </div>

              <p className="text-xs text-text-muted">
                Install the Grabber Helper Chrome extension for YouTube cookie sync
              </p>
            </div>
          )}
          </div>
        </div>
      )}

      {/* Modal: desktop key set but tunnel offline */}
      {fallbackModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="panel p-5 max-w-sm w-full space-y-3">
            <h3 className="text-base text-text-primary font-semibold">Desktop not online</h3>
            <p className="text-sm text-text-secondary">
              Your PC's Grabber app isn't reachable. Continue and process on this device instead?
            </p>
            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => { fallbackModal.resolve(false); setFallbackModal(null) }}
                className="h-10 px-4 text-sm raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                Cancel
              </button>
              <button
                onClick={() => { setAcceptedFallback(true); fallbackModal.resolve(true); setFallbackModal(null) }}
                className="h-10 px-4 text-sm raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 px-4 py-5 w-full space-y-4">
        {/* Hero — pixel wordmark + tagline */}
        <div className="text-center pb-1">
          <PixelWordmark />
          <p className="pixel-head text-[11px] font-bold uppercase tracking-[0.22em] mt-2">Paste a link to begin.</p>
        </div>

        {/* URL Input */}
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchInfo(url)}
              placeholder='Paste a video or post URL...'
              className="flex-1 h-10 inset-field px-4 text-sm outline-none transition-colors"
            />
            {/* Paste — ghost icon button */}
            <button
              onClick={handlePaste}
              className="h-10 w-10 grid place-items-center raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title="Paste link"
              aria-label="Paste link"
            >
              <ClipboardPaste size={18} />
            </button>
          </div>

          {/* Direct media links only. A .m3u8/.mp4 pasted straight in usually
              comes from a CDN that checks the referring page's headers — a
              browser sends those automatically, a server fetch has to be told.
              Hidden for normal site URLs, where the extractor handles it. */}
          {isDirectMediaUrl(url) && (
            <div className="space-y-1">
              <input
                type="url"
                value={referer}
                onChange={(e) => setReferer(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && fetchInfo(url)}
                placeholder="Referer — the page this link came from (optional)"
                className="w-full h-9 inset-field px-3 text-xs outline-none transition-colors"
              />
              <p className="text-[10px] text-text-muted">
                Direct link detected. If it fails, paste the page URL above — many CDNs
                reject requests without it. Signed links can also be IP-bound or expire.
              </p>
            </div>
          )}

          <div className="flex gap-2">
            {/* Fetch — PRIMARY action: the first thing a visitor taps, so it
                gets the solid accent treatment. */}
            <button
              onClick={() => fetchInfo(url)}
              disabled={!url.trim() || loading}
              className="flex-1 h-10 px-4 raised text-sm transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              {loading ? <Loader size={16} className="animate-spin" /> : <Download size={16} />}
              {loading ? 'Fetching…' : 'Fetch'}
            </button>
            {/* Reload — ghost icon button */}
            <button
              onClick={handleReload}
              disabled={loading}
              className="h-10 w-10 grid place-items-center raised disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title="Start over — clear & paste new link"
              aria-label="Start over — clear and paste new link"
            >
              <RefreshCw size={18} />
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="panel flex items-center gap-2 px-4 py-3 text-sm font-semibold text-danger animate-fade-in">
            <AlertCircle size={16} className="flex-shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError('')} className="h-8 w-8 grid place-items-center rounded-md text-danger/60 hover:text-danger hover:bg-danger/10 transition-colors" title="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Upload & Process — the local-file counterpart to the URL box above.
            Hidden once a URL fetch is in play so the two flows never compete
            for attention. */}
        {videos.length === 0 && !loading && (
          <>
            <UploadPanel />
          </>
        )}

        {/* Skeleton while fetching — a ghost of the result card so the wait
            reads as progress instead of a frozen page. */}
        {loading && videos.length === 0 && (
          <div className="panel overflow-hidden animate-fade-in" aria-hidden>
            <ScanBanner mode="tuning" pct={0} chip="Tuning…" className="h-44 aspect-auto border-0" />
            <div className="p-4 space-y-3">
              <div className="h-3.5 w-2/5 bg-surface-2 rounded animate-pulse" />
              <div className="h-4 w-4/5 bg-surface-2 rounded animate-pulse" />
              <div className="flex gap-2">
                <div className="h-8 w-28 bg-surface-2 rounded-md animate-pulse" />
                <div className="h-8 w-24 bg-surface-2 rounded-md animate-pulse" />
                <div className="h-8 w-24 bg-surface-2 rounded-md animate-pulse" />
              </div>
              <div className="h-10 w-full bg-surface-2 rounded-md animate-pulse" />
            </div>
          </div>
        )}

        {/* Video Info Cards — stacked for multi-video */}
        {videos.some(v => !queuedVideoIds.has(v.id)) && (
          <div className="space-y-3">
            {videos.length > 1 && (
              <p className="pixel-head text-xs font-bold uppercase tracking-[0.18em]">{videos.length} videos found</p>
            )}
            {videos.map((video, idx) => queuedVideoIds.has(video.id) ? null : (
              <div key={video.id} className="panel overflow-hidden animate-fade-in">
                {video.thumbnail && (
                  <div className="relative">
                    <img
                      src={video.thumbnail}
                      alt=""
                      className="w-full h-44 object-cover"
                    />
                    {video.duration > 0 && (
                      <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/75 text-white text-[11px] font-semibold tabular-nums leading-none">
                        {formatDuration(video.duration)}
                      </span>
                    )}
                  </div>
                )}
                <div className="p-4 space-y-4">
                  <div className="space-y-1">
                    {/* Metadata row — the fastest way to confirm you grabbed the
                        right post: author + date (duration lives on the thumbnail
                        pill; it only appears here when there's no thumbnail). */}
                    {(video.uploader || formatUploadDate(video.uploadDate) || (video.duration > 0 && !video.thumbnail)) && (
                      <p className="text-sm font-medium text-text-primary flex flex-wrap items-center gap-x-1.5">
                        {videos.length > 1 && <span className="text-accent">#{idx + 1}</span>}
                        {video.uploader && <span>{video.uploader}</span>}
                        {formatUploadDate(video.uploadDate) && (
                          <><span className="text-text-muted">·</span><span className="text-text-secondary font-normal">{formatUploadDate(video.uploadDate)}</span></>
                        )}
                        {video.duration > 0 && !video.thumbnail && (
                          <><span className="text-text-muted">·</span><span className="text-text-secondary font-normal">{formatDuration(video.duration)}</span></>
                        )}
                      </p>
                    )}
                    <h3 className={`line-clamp-2 ${video.uploader ? 'text-sm font-normal text-text-secondary' : 'text-base font-semibold text-text-primary'}`}>
                      {videos.length > 1 && !video.uploader && <span className="text-accent mr-1.5">#{idx + 1}</span>}
                      {video.title}
                    </h3>
                  </div>

                  {/* Format selector */}
                  {!settings.autoBest && (
                    <>
                      <div className="flex flex-wrap gap-2">
                        {video.formats.map((f) => {
                          const selected = (selectedFormats[video.id] || video.formats[0]?.formatId) === f.formatId
                          return (
                            <button
                              key={f.formatId}
                              onClick={() => setSelectedFormats(prev => ({ ...prev, [video.id]: f.formatId }))}
                              className={`px-3 h-8 rounded-md text-xs border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                                selected
                                  ? 'raised-sel font-semibold'
                                  : 'raised font-medium'
                              }`}
                            >
                              {f.label}
                              {/* Two-tone hierarchy in both states: bright resolution,
                                  muted size — on the filled pill that's black at ~70%. */}
                              {f.filesize ? <span className={`ml-1 font-normal ${selected ? 'text-white/80' : 'opacity-60'}`}>· {formatSize(f.filesize)}</span> : null}
                              {f.best && f.label !== 'Best Quality' ? (
                                <span className={`ml-1.5 text-[10px] font-semibold uppercase tracking-wide ${selected ? 'text-white/70' : 'text-danger'}`}>Best</span>
                              ) : null}
                            </button>
                          )
                        })}
                      </div>
                      <button
                        onClick={() => {
                          const fmtId = selectedFormats[video.id] || video.formats[0]?.formatId
                          const fmt = video.formats.find(f => f.formatId === fmtId)
                          handleDownload(video, fmtId, fmt?.label || 'Best Quality')
                        }}
                        className="w-full h-10 px-4 raised text-sm transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                      >
                        <Download size={16} />
                        Download{videos.length > 1 ? ` #${idx + 1}` : ''}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}

            {/* Download All button for multi-video — only the ones not
                already started, so a second tap can't queue duplicates. */}
            {videos.filter(v => !queuedVideoIds.has(v.id)).length > 1 && !settings.autoBest && (
              <button
                onClick={() => {
                  for (const v of videos) {
                    if (queuedVideoIds.has(v.id)) continue
                    const fmtId = selectedFormats[v.id] || v.formats[0]?.formatId
                    const fmt = v.formats.find(f => f.formatId === fmtId)
                    handleDownload(v, fmtId, fmt?.label || 'Best Quality')
                  }
                }}
                className="w-full h-10 px-4 raised text-sm transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <Download size={16} />
                Download All ({videos.filter(v => !queuedVideoIds.has(v.id)).length} videos)
              </button>
            )}
          </div>
        )}

        {/* Downloads — video jobs and photo/carousel jobs in one list, newest first. */}
        {feed.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="pixel-head text-xs font-bold uppercase tracking-[0.24em]">Downloads</h3>
              {/* Only terminal jobs are clearable — converting/subtitling are
                  still active work, not "completed". */}
              {(downloads.some(d => d.status === 'done' || d.status === 'error') || photoJobs.some(j => j.ready || j.status === 'error')) && (
                <button
                  onClick={clearCompleted}
                  className="pixel-head text-[10px] font-bold uppercase tracking-[0.14em] hover:text-[#ffd54a] hover:underline transition-colors"
                >
                  Clear completed
                </button>
              )}
            </div>
            {feed.map((entry) => {
              if (entry.kind === 'photo') {
                const job = entry.job
                return (
                  <PhotoCard
                    key={job.id}
                    job={job}
                    items={photoItems[job.id] || {}}
                    unticked={photoUnticked[job.id] || []}
                    willConvert={photoWillConvert(job.url)}
                    srcFor={(i) => photoUrls.current[job.id]?.[i]}
                    canSavePhotos={isIOS() && canShare}
                    onToggle={(i) => togglePhotoTick(job.id, i)}
                    onSave={() => handlePhotoSaveAll(job)}
                    onDownload={() => handlePhotoDownloadAll(job)}
                    onRemove={() => removePhotoJob(job.id)}
                  />
                )
              }
              const dl = entry.dl
              const active = dl.status === 'downloading' || dl.status === 'converting' || dl.status === 'subtitling'
              const busy = active || saveProgress[dl.id] !== undefined || !!instantProgress[dl.id]
              const device = instantProgress[dl.id]
              const prep = saveProgress[dl.id]
              // The server's download and the phone's pull read as one
              // "Downloading" run: the first (1 - share) of the bar is the
              // server, the rest is the pull (see xferShare in handleDownload).
              const share = dl.xferShare || 0
              const mergedPull = share > 0 && dl.status === 'done' && !device && prep !== undefined
              const dlPct = dl.status === 'downloading' ? dl.percent * (1 - share)
                : mergedPull ? (1 - share) * 100 + Math.max(0, prep ?? 0) * share
                : 0
              // What the banner draws — same priority order as the action area.
              const scan: { mode: ScanMode; pct: number; chip: string } =
                dl.status === 'error' ? { mode: 'error', pct: 0, chip: 'Signal lost' }
                : dl.status === 'downloading' ? { mode: 'download', pct: dlPct, chip: dlPct > 0 ? scanPct(dlPct) : 'Starting…' }
                : active ? { mode: 'convert', pct: dl.percent, chip: scanChip(dl.status === 'subtitling' ? 'Subs' : 'Encode', dl.percent) }
                : device ? { mode: 'convert', pct: device.pct, chip: scanChip('Device', device.pct) }
                : mergedPull ? { mode: 'download', pct: dlPct, chip: scanPct(dlPct) }
                : prep !== undefined ? { mode: 'prepare', pct: prep, chip: scanChip('→ Phone', prep) }
                : { mode: 'ready', pct: 100, chip: 'Ready' }
              return (
              <div
                key={dl.id}
                className="panel p-3 animate-fade-in"
              >
                <ScanBanner thumbnail={dl.thumbnail} mode={scan.mode} pct={scan.pct} chip={scan.chip} />
                <div className="mt-3 flex gap-3 items-start">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      {/* Receipt, not headline — match the result card's demoted
                          title treatment, single line. */}
                      <p className="text-sm font-normal text-text-secondary truncate">{dl.title}</p>
                      {/* mr-1 lines this 32px control's center up with the 40px
                          icon button at the card's right edge below. */}
                      <div className="flex items-start gap-0.5 flex-shrink-0 mr-1">
                        {/* Done state is shown inline in the status line below —
                            no corner icon, so the card has one clear signal. */}
                        {dl.status === 'error' && (
                          <span className="h-8 w-8 grid place-items-center" title="Failed">
                            <AlertCircle size={16} className="text-danger" />
                          </span>
                        )}
                        {/* Cancel: while anything active (download or client-side processing) */}
                        {busy && (
                          <button
                            onClick={() => handleCancelDownload(dl.id)}
                            className="h-8 w-8 grid place-items-center rounded-md text-text-muted hover:text-danger hover:bg-danger/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
                            title="Cancel download"
                            aria-label="Cancel download"
                          >
                            <X size={16} />
                          </button>
                        )}
                        {/* Remove: once terminal, no active work */}
                        {!busy && (
                          <button
                            onClick={() => removeDownload(dl.id)}
                            className="h-8 w-8 grid place-items-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                            title="Remove from list"
                            aria-label="Remove from list"
                          >
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* "Downloaded", not "Saved" — at this point the file is only
                        fetched (server + browser memory); nothing persists to the
                        device until the user taps Share / Save file. */}
                    {dl.status === 'done' && !busy ? (
                      <p className="text-xs text-text-secondary mt-1">
                        Downloaded · {dl.formatLabel}{dl.totalSize ? ` · ${dl.totalSize}` : ''}
                      </p>
                    ) : (
                      <p className="text-xs text-text-muted mt-1">{dl.formatLabel}</p>
                    )}

                    {active && (() => {
                      const label = dl.status === 'converting' ? 'Converting'
                        : dl.status === 'subtitling' ? 'Subtitles' : 'Downloading'
                      const shown = dl.status === 'downloading' ? dlPct : dl.percent
                      const determinate = shown > 0
                      // No bar here — the banner above is the progress bar. When
                      // the phone's pull dominates (no desktop), the server's own
                      // ETA would claim seconds for a wait of minutes, so it's
                      // left out until the pull starts and has its own.
                      return (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-xs text-text-muted font-mono">
                          <span className="text-text-secondary">{determinate ? `${label}… ${shown.toFixed(0)}%` : `${label}…`}</span>
                          {dl.totalSize && <span>{dl.totalSize}</span>}
                          {dl.speed && <span>{dl.speed}</span>}
                          {dl.eta && share < 0.5 && <span className="whitespace-nowrap">ETA {dl.eta}</span>}
                        </div>
                      )
                    })()}

                    {/* On-device processing, then the phone pulling the file. The
                        banner draws both; these lines carry the numbers. */}
                    {device ? (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-xs text-text-muted font-mono">
                        <span className="text-text-secondary">{device.stage}{device.pct > 0 ? ` ${device.pct}%` : ''}</span>
                      </div>
                    ) : mergedPull ? (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-xs text-text-muted font-mono">
                        <span className="text-text-secondary">{`Downloading… ${dlPct.toFixed(0)}%`}</span>
                        {saveSpeed[dl.id] && <span>{saveSpeed[dl.id]}</span>}
                        {saveEta[dl.id] && <span className="whitespace-nowrap">ETA {saveEta[dl.id]}</span>}
                      </div>
                    ) : prep !== undefined && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-xs text-text-muted font-mono">
                        <span className="text-text-secondary">{prep >= 0 ? `Preparing… ${prep}%` : 'Preparing…'}</span>
                        {saveSpeed[dl.id] && <span>{saveSpeed[dl.id]}</span>}
                      </div>
                    )}

                    {dl.status === 'error' && dl.error && (
                      <p className="mt-1 text-xs text-danger">{dl.error}</p>
                    )}
                  </div>
                </div>

                {/* Action area sits OUTSIDE the thumbnail row — full card width,
                    12px below the status line. */}
                {/* Buttons only once nothing is in flight — while processing or
                    preparing, the banner and status line show the progress. */}
                {dl.status === 'done' && !device && prep === undefined && (
                  <div className="mt-3">
                        {dl.directOnly ? (
                          // File too big for in-memory share — direct download to Files only.
                          <div className="space-y-2">
                            <button
                              onClick={() => triggerFileDownload(dl.id, dl.fileName || 'download')}
                              className="w-full h-10 px-4 raised text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                            >
                              Save file
                            </button>
                            <p className="text-xs text-text-muted text-center">
                              File too large for Save to Photos — saves to Files app instead
                            </p>
                          </div>
                        ) : canShare && fileReady[dl.id] ? (
                          // One primary action (blue family — green is reserved for
                          // the done indicator), file export demoted to an icon.
                          // "Save to Photos" is iOS vocabulary; elsewhere say Share.
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleSaveToPhotos(dl.id, dl.fileName || 'download')}
                              className="flex-1 h-10 px-4 raised text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                            >
                              {isIOS() ? 'Save to Photos' : 'Share'}
                            </button>
                            <button
                              onClick={() => handleDirectDownload(dl.id, dl.fileName || 'download')}
                              className="h-10 w-10 grid place-items-center raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                              title="Save file"
                              aria-label="Save file"
                            >
                              <Download size={16} />
                            </button>
                          </div>
                        ) : canShare && !fileReady[dl.id] && !dl.direct ? (
                          <button
                            onClick={() => prefetchFile(dl.id, dl.fileName || 'download')}
                            className="w-full h-10 px-4 raised text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                          >
                            Retry Prepare
                          </button>
                        ) : (
                          <button
                            onClick={() => handleDirectDownload(dl.id, dl.fileName || 'download')}
                            className="w-full h-10 px-4 raised text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                          >
                            Save file
                          </button>
                        )}
                  </div>
                )}
              </div>
            )})}
          </div>
        )}

        {/* Empty state */}
        {videos.length === 0 && !loading && feed.length === 0 && (
          <div className="text-center py-12">
            <Download size={40} strokeWidth={1.5} className="mx-auto mb-3 text-[#f4f5f7]" style={{ filter: 'drop-shadow(1.5px 1.5px 0 #22262e)' }} />
            <p className="pixel-head text-sm font-bold uppercase tracking-[0.14em]">
              Paste a link to get started
            </p>
            <p className="text-xs mt-2 text-[#d3d7de]">
              Videos, photos and carousels from YouTube, TikTok, Instagram, X and 1800+ sites
            </p>
            {settings.autoDetect && (
              <p className="text-xs mt-3 text-[#aebfd8]">
                Clipboard auto-detection is on
              </p>
            )}
          </div>
        )}
      </main>

      {/* Debug panel */}
      {showDebug && (
        <div className="border-t-2 border-subtle bg-[#1a1d24] px-4 py-2 max-h-48 overflow-y-auto">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-[#e0bd4a] uppercase tracking-[0.2em] font-mono">Debug Log</span>
            <button onClick={() => setDebugLogs([])} className="text-xs text-[#8b93a5] hover:text-white">Clear</button>
          </div>
          <pre className="text-xs text-[#4fc455] font-mono whitespace-pre-wrap break-all">
            {debugLogs.length === 0 ? 'No logs yet — start a download to see polling + worker output.' : ''}
            {debugLogs.join('\n')}
          </pre>
        </div>
      )}
      </div>

    </div>
  )
}
