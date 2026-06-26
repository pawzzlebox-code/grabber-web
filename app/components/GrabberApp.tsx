'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ClipboardPaste, Download, Loader, CheckCircle, AlertCircle,
  X, Zap, Settings, ChevronDown, Trash2, RefreshCw
} from 'lucide-react'
import { isWebCodecsSupported } from '@/lib/webcodecs-processor'
import { runWorker } from '@/lib/webcodecs-client'

interface VideoInfo {
  id: string
  title: string
  thumbnail: string
  duration: number
  formats: { formatId: string; label: string; ext: string; filesize?: number | null }[]
  url: string
  playlistIndex?: number
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
}

// Persist settings in localStorage
// User-visible defaults. instantMode + useMyDesktop are gone — both are
// auto-selected at runtime: desktop wins if its tunnel is registered AND
// the user has a desktopKey saved; else WebCodecs if the browser supports
// it; else server-side. desktopKey moves to "Advanced" since most users
// won't configure it, and direct download joins it there.
const defaultSettings = { autoDetect: true, autoBest: true, verticalPad: false, burnSubtitles: false, directDownload: false, desktopKey: '', skipDesktop: false, photoMode: false }

// Above this size we never buffer the file into a JS Blob (for navigator.share
// / WebCodecs). Holding a few hundred MB in a tab OOM-crashes the renderer —
// iOS Safari dies near ~250MB, and even desktop tabs crash on multi-GB files
// (a 26-min 7Mbps video is ~1.3GB). Large files stream straight to disk via an
// <a download> instead, which uses ~no memory.
const MAX_INMEMORY_BYTES = 100 * 1024 * 1024 // 100 MB

function loadSettings() {
  if (typeof window === 'undefined') return defaultSettings
  try {
    const s = localStorage.getItem('grabber-settings')
    return s ? { ...defaultSettings, ...JSON.parse(s) } : defaultSettings
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

function formatDuration(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }
  return `${m}:${String(sec).padStart(2, '0')}`
}

export default function GrabberApp() {
  const [url, setUrl] = useState('')
  const [videos, setVideos] = useState<VideoInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [downloads, setDownloads] = useState<DownloadJob[]>([])
  const [settings, setSettings] = useState(defaultSettings)
  const [showSettings, setShowSettings] = useState(false)
  const [selectedFormats, setSelectedFormats] = useState<Record<string, string>>({})
  const lastClipboard = useRef('')
  const autoTriggered = useRef(false)
  const [canShare, setCanShare] = useState(false)
  const [saveProgress, setSaveProgress] = useState<Record<string, number>>({})
  // Live transfer speed shown during the "Preparing" phase (phone pulling the
  // finished file from the server), keyed by download id, e.g. "10.2 MB/s".
  const [saveSpeed, setSaveSpeed] = useState<Record<string, string>>({})
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
  // job produces N files served as a grid, not one video file.
  interface PhotoFile { index: number; name: string; size: number }
  interface PhotoJob {
    id: string
    url: string
    status: 'downloading' | 'done' | 'error'
    files: PhotoFile[]
    error?: string
    // Prefetch state. iOS Safari requires navigator.share to be called
    // inside the SAME synchronous tap handler that originated the user
    // gesture — any await between tap and share() invalidates the
    // activation token. We pre-fetch every photo into memory as soon as
    // the job finishes, then `ready` flips true and Save can fire share
    // without any async work.
    prefetchPct?: number
    ready?: boolean
  }
  const [photoJobs, setPhotoJobs] = useState<PhotoJob[]>([])
  // Cached File[] per job, keyed by job id. Populated by the background
  // prefetch effect below.
  const photoCache = useRef<Record<string, File[]>>({})

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
  useEffect(() => {
    let cancelled = false
    const fetchUrl = async () => {
      try {
        const res = await fetch('/api/desktop', { cache: 'no-store' })
        const data = await res.json()
        if (!cancelled) setDesktopTunnelUrl(data.tunnelUrl || null)
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

  // SYNCHRONOUS save — see prefetch effect below for the cache. iOS will
  // reject navigator.share with "request not allowed" if anything awaits
  // between the user's tap and the share() call, so we never do.
  const handlePhotoSaveAll = (job: PhotoJob) => {
    const cached = photoCache.current[job.id]
    if (!cached || !job.ready) {
      setError('Files still preparing — wait for the green button.')
      return
    }
    if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: cached })) {
      // SYNCHRONOUS share inside the tap handler. No await between the user
      // gesture and navigator.share() — iOS invalidates the activation
      // token on any await, which is the error the user kept hitting.
      navigator.share({ files: cached }).catch((err: any) => {
        if (err?.name === 'AbortError') return
        setError(`Save failed: ${err?.message || err}`)
      })
    } else {
      // Non-share browsers (desktop): download each as a blob URL.
      for (const f of cached) {
        const url = URL.createObjectURL(f)
        const a = document.createElement('a')
        a.href = url
        a.download = f.name
        document.body.appendChild(a); a.click(); document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    }
  }

  // Background prefetch — fires whenever a photo job flips to `done`. Loads
  // every file into the photoCache so handlePhotoSaveAll can fire share
  // synchronously in the tap handler.
  const prefetchingRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const job of photoJobs) {
      if (job.status !== 'done' || job.ready || prefetchingRef.current.has(job.id)) continue
      prefetchingRef.current.add(job.id)
      ;(async () => {
        try {
          const files: File[] = []
          for (let i = 0; i < job.files.length; i++) {
            const meta = job.files[i]
            const r = await fetch(`/api/photos/${job.id}/file/${meta.index}`, { cache: 'no-store' })
            if (!r.ok) throw new Error(`fetch ${meta.name} HTTP ${r.status}`)
            const blob = await r.blob()
            files.push(new File([blob], meta.name, { type: blob.type || 'image/jpeg' }))
            setPhotoJobs(prev => prev.map(j => j.id === job.id
              ? { ...j, prefetchPct: Math.round(((i + 1) / job.files.length) * 100) }
              : j))
          }
          photoCache.current[job.id] = files
          setPhotoJobs(prev => prev.map(j => j.id === job.id ? { ...j, ready: true, prefetchPct: 100 } : j))
        } catch (err: any) {
          setPhotoJobs(prev => prev.map(j => j.id === job.id ? { ...j, error: err.message || 'Prefetch failed' } : j))
        } finally {
          prefetchingRef.current.delete(job.id)
        }
      })()
    }
  }, [photoJobs])

  const removePhotoJob = (id: string) => {
    fetch(`/api/photos/${id}`, { method: 'DELETE', cache: 'no-store' }).catch(() => {})
    setPhotoJobs(prev => prev.filter(j => j.id !== id))
  }

  // Start a gallery-dl job on the droplet. Skips metadata + format picking
  // entirely — just submits the URL and polls the job until files arrive.
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
      const newJob: PhotoJob = { id: data.id, url: u, status: 'downloading', files: [] }
      setPhotoJobs(prev => [newJob, ...prev])

      // Poll every 1s while downloading.
      const poll = async () => {
        try {
          const r = await fetch(`/api/photos/${data.id}`, { cache: 'no-store' })
          if (!r.ok) return
          const state = await r.json() as { status: PhotoJob['status']; files: PhotoFile[]; error?: string }
          setPhotoJobs(prev => prev.map(j => j.id === data.id ? {
            ...j, status: state.status, files: state.files, error: state.error,
          } : j))
          return state.status
        } catch {}
      }
      const interval = setInterval(async () => {
        const st = await poll()
        if (st === 'done' || st === 'error') clearInterval(interval)
      }, 1000)
      await poll()
    } catch (err: any) {
      log(`photos: error — ${err.message}`)
      setError(err.message || 'Failed to start photo job')
    }
  }, [])

  const fetchInfo = useCallback(async (videoUrl: string) => {
    if (!videoUrl.trim()) return
    // Photos mode: route the URL through gallery-dl instead of yt-dlp.
    if (settings.photoMode) {
      startPhotoJob(videoUrl)
      return
    }
    setLoading(true)
    setError('')
    setVideos([])
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
      const res = await fetch(`${apiBase()}/api/info?url=${encodeURIComponent(trimmedUrl)}`, {
        headers: apiHeaders(false),
        signal: ac.signal,
      })
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
      log(`fetchInfo: error — ${msg}`)
      setError(msg)
    } finally {
      clearTimeout(timeoutId)
      setLoading(false)
    }
    // Deps: apiBase/apiHeaders close over desktopTunnelUrl + desktopKey,
    // and the early-return for Photos mode closes over settings.photoMode
    // + startPhotoJob — all need to be in deps so the closure stays fresh.
  }, [desktopTunnelUrl, settings.desktopKey, settings.photoMode, startPhotoJob])

  const handleDownload = async (video: VideoInfo, formatId: string, formatLabel: string) => {
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

    // Pre-flight disk check — only for droplet-hosted downloads (the desktop
    // path uses the user's PC disk, which has ample room). Best-effort: many
    // YouTube formats report no filesize, in which case we skip the check and
    // rely on the server's floor. ×1.3 accounts for muxing/remux overhead.
    if (!apiBase()) {
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
          return
        }
      }
    }

    // Confirm processing path. If user wants desktop but it's not online,
    // ensureProcessingPath shows the modal and waits for a decision.
    const proceed = await ensureProcessingPath()
    if (!proceed) return

    // Wait for the WebCodecs probe to settle so the auto-pick is correct.
    const probed = webCodecsProbe.current ? await webCodecsProbe.current : false
    // Auto-pick: instant mode whenever desktop ISN'T being used AND the
    // browser supports WebCodecs. The server now hands back the raw file
    // and the client handles any required transcoding (codec mismatch,
    // pad to 9:16, burn subs) on the iPhone's hardware encoder — way
    // faster than the droplet's 1-vCPU libx264.
    const usingDesktop = !!apiBase()
    const useInstant = !usingDesktop && probed
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
            const needsCodecTranscode = !!state.sourceCodec
              && state.sourceCodec !== 'h264'
              && state.sourceCodec !== 'hevc'
            let isTwitter = false
            try {
              const h = new URL(video.url).hostname.replace(/^www\./, '')
              isTwitter = h === 'twitter.com' || h === 'x.com' || h === 't.co'
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
    }
  }

  // Pre-fetch file from server into cache (with progress), called automatically when download completes on mobile
  const prefetchFile = async (id: string, fileName: string) => {
    const fileUrl = `${apiBase()}/api/file/${id}`
    const name = fileName || 'video.mp4'
    try {
      setSaveProgress(prev => ({ ...prev, [id]: 0 }))
      const res = await fetch(fileUrl, { headers: apiHeaders(false) })
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
      setFileReady(prev => ({ ...prev, [id]: true }))
    } catch {
      // Prefetch failed — clear progress, user can tap to retry
      setSaveProgress(prev => { const n = { ...prev }; delete n[id]; return n })
    }
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

      // Same tiny-file guard as prefetchFile — bail before WebCodecs decodes garbage.
      if (rawBlob.size < 1024) {
        setError(`Got a ${rawBlob.size}-byte file — server likely returned a stream error. Try again or turn off Skip Desktop.`)
        return
      }

      // Step 2: WebCodecs worker — local pad + burn subs
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

      // Step 3: swap cached file with processed version, enable Save to Photos
      const outName = name.replace(/\.[^.]+$/, '') + '_processed.mp4'
      fileCache.current[id] = new File([processed], outName, { type: 'video/mp4' })
      setInstantProgress(prev => { const n = { ...prev }; delete n[id]; return n })
      setFileReady(prev => ({ ...prev, [id]: true }))
      delete cancelHandles.current[id]
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

    // 2. Tell server to kill child processes and delete the file
    try {
      await fetch(`${apiBase()}/api/cancel/${id}`, { method: 'POST', cache: 'no-store', headers: apiHeaders(false) })
    } catch (err) {
      console.error('[cancel] server request failed', err)
    }

    // 3. Clear any per-id progress state
    setSaveProgress(prev => { const n = { ...prev }; delete n[id]; return n })
    setSaveSpeed(prev => { const n = { ...prev }; delete n[id]; return n })
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

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header — three-column grid so the Build tag stays dead-center even
          when the title or settings icon change width. Build moved up here
          from the footer because iPhone's home indicator was getting in the
          way of tapping it for the debug panel. */}
      <header className="grid grid-cols-3 items-center px-4 py-3 border-b border-subtle">
        <div className="flex items-center gap-2">
          <Download size={20} className="text-accent" />
          <h1 className="text-base font-semibold text-text-primary">Grabber</h1>
        </div>
        <div className="text-center">
          <span onClick={() => { setShowDebug(s => !s); dumpServerDebug() }} className="text-xs text-text-muted cursor-pointer hover:text-text-secondary transition-colors px-3 py-1">
            Build 49
          </span>
        </div>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="h-10 w-10 grid place-items-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors justify-self-end focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </header>

      {/* Settings panel — slim 4-toggle default + Advanced disclosure */}
      {showSettings && (
        <div className="border-b border-subtle bg-surface px-4 py-4 space-y-4 animate-fade-in">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-text-muted">Settings</p>
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
              <div className="w-9 h-5 bg-surface-2 rounded-full peer peer-checked:bg-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <Zap size={14} className="text-accent" />
                <p className="text-sm font-medium text-text-primary">Auto best quality</p>
              </div>
              <p className="text-xs text-text-muted">Instantly downloads best quality when URL is detected</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input type="checkbox" checked={settings.autoBest} onChange={(e) => setSettings(s => ({ ...s, autoBest: e.target.checked }))} className="sr-only peer" />
              <div className="w-9 h-5 bg-surface-2 rounded-full peer peer-checked:bg-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">Pad to 9:16 vertical</p>
              <p className="text-xs text-text-muted">Adds black bars for Reels/TikTok</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input type="checkbox" checked={settings.verticalPad} onChange={(e) => setSettings(s => ({ ...s, verticalPad: e.target.checked }))} className="sr-only peer" />
              <div className="w-9 h-5 bg-surface-2 rounded-full peer peer-checked:bg-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">Burn English subtitles</p>
              <p className="text-xs text-text-muted">Auto-translates and burns subtitles into the video</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input type="checkbox" checked={settings.burnSubtitles} onChange={(e) => setSettings(s => ({ ...s, burnSubtitles: e.target.checked }))} className="sr-only peer" />
              <div className="w-9 h-5 bg-surface-2 rounded-full peer peer-checked:bg-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          {/* Photos mode — route URLs through gallery-dl instead of yt-dlp.
              For image posts, carousels, Pixiv illustrations, etc. */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">Photos mode</p>
              <p className="text-xs text-text-muted">Use gallery-dl for image posts & carousels</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input type="checkbox" checked={settings.photoMode} onChange={(e) => setSettings(s => ({ ...s, photoMode: e.target.checked }))} className="sr-only peer" />
              <div className="w-9 h-5 bg-surface-2 rounded-full peer peer-checked:bg-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
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
              <div className="w-9 h-5 bg-surface-2 rounded-full peer peer-checked:bg-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
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
                <div className="flex h-1.5 w-full rounded-md overflow-hidden bg-surface-2">
                  <div className="bg-text-muted/50 transition-all duration-300" style={{ width: `${pct(osBytes)}%` }} title="System (not clearable)" />
                  <div className="bg-accent transition-all duration-300" style={{ width: `${pct(grabberBytes)}%` }} title="Grabber downloads (clearable)" />
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
                  <div className="w-9 h-5 bg-surface-2 rounded-full peer peer-checked:bg-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
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
                  className="w-full h-10 px-3 text-xs bg-base border border-subtle rounded-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent font-mono"
                />
              </div>

              <p className="text-xs text-text-muted">
                Install the Grabber Helper Chrome extension for YouTube cookie sync
              </p>
            </div>
          )}
        </div>
      )}

      {/* Modal: desktop key set but tunnel offline */}
      {fallbackModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-surface rounded-lg p-5 max-w-sm w-full space-y-3 border border-subtle">
            <h3 className="text-base text-text-primary font-semibold">Desktop not online</h3>
            <p className="text-sm text-text-secondary">
              Your PC's Grabber app isn't reachable. Continue and process on this device instead?
            </p>
            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => { fallbackModal.resolve(false); setFallbackModal(null) }}
                className="h-10 px-4 text-sm font-medium rounded-md bg-surface-2 border border-subtle text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                Cancel
              </button>
              <button
                onClick={() => { setAcceptedFallback(true); fallbackModal.resolve(true); setFallbackModal(null) }}
                className="h-10 px-4 text-sm font-semibold rounded-md bg-accent hover:bg-accent-hover text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 px-4 py-6 max-w-lg mx-auto w-full space-y-4">
        {/* URL Input */}
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchInfo(url)}
              placeholder="Paste video URL..."
              className="flex-1 h-10 bg-surface border border-subtle rounded-sm px-4 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent transition-colors"
            />
            {/* Paste — ghost icon button */}
            <button
              onClick={handlePaste}
              className="h-10 w-10 grid place-items-center bg-surface-2 border border-subtle rounded-md text-text-secondary hover:text-text-primary active:bg-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title="Paste from clipboard"
            >
              <ClipboardPaste size={18} />
            </button>
          </div>
          <div className="flex gap-2">
            {/* Fetch — SECONDARY action: ghost/outline */}
            <button
              onClick={() => fetchInfo(url)}
              disabled={!url.trim() || loading}
              className="flex-1 h-10 px-4 bg-transparent border border-accent rounded-md text-sm font-medium text-accent hover:bg-accent-muted active:bg-accent-muted disabled:border-subtle disabled:text-text-muted disabled:hover:bg-transparent transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              {loading ? <Loader size={16} className="animate-spin" /> : <Download size={16} />}
              {loading ? 'Fetching…' : 'Fetch Video'}
            </button>
            {/* Reload — ghost icon button */}
            <button
              onClick={handleReload}
              disabled={loading}
              className="h-10 w-10 grid place-items-center bg-surface-2 border border-subtle rounded-md text-text-secondary hover:text-text-primary active:bg-surface disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title="Clear & paste new link"
            >
              <RefreshCw size={18} />
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 bg-danger/10 border border-danger/20 rounded-lg px-4 py-3 text-sm text-danger animate-fade-in">
            <AlertCircle size={16} className="flex-shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError('')} className="h-8 w-8 grid place-items-center rounded-md text-danger/60 hover:text-danger hover:bg-danger/10 transition-colors" title="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Video Info Cards — stacked for multi-video */}
        {videos.length > 0 && (
          <div className="space-y-3">
            {videos.length > 1 && (
              <p className="text-xs text-text-secondary">{videos.length} videos found</p>
            )}
            {videos.map((video, idx) => (
              <div key={video.id} className="bg-surface border border-subtle rounded-lg overflow-hidden animate-fade-in">
                {video.thumbnail && (
                  <img
                    src={video.thumbnail}
                    alt=""
                    className="w-full h-44 object-cover"
                  />
                )}
                <div className="p-4 space-y-4">
                  <div>
                    <h3 className="text-base font-semibold text-text-primary line-clamp-2">
                      {videos.length > 1 && <span className="text-accent mr-1.5">#{idx + 1}</span>}
                      {video.title}
                    </h3>
                    {video.duration > 0 && (
                      <p className="text-xs font-normal text-text-muted mt-1">{formatDuration(video.duration)}</p>
                    )}
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
                              className={`px-3 h-8 rounded-md text-xs font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                                selected
                                  ? 'bg-accent-muted text-accent border-accent'
                                  : 'bg-surface-2 text-text-secondary border-subtle hover:text-text-primary'
                              }`}
                            >
                              {f.label}
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
                        className="w-full h-10 px-4 bg-accent hover:bg-accent-hover rounded-md text-sm font-semibold text-white transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                      >
                        <Download size={16} />
                        Download{videos.length > 1 ? ` #${idx + 1}` : ''}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}

            {/* Download All button for multi-video */}
            {videos.length > 1 && !settings.autoBest && (
              <button
                onClick={() => {
                  for (const v of videos) {
                    const fmtId = selectedFormats[v.id] || v.formats[0]?.formatId
                    const fmt = v.formats.find(f => f.formatId === fmtId)
                    handleDownload(v, fmtId, fmt?.label || 'Best Quality')
                  }
                }}
                className="w-full h-10 px-4 bg-accent hover:bg-accent-hover rounded-md text-sm font-semibold text-white transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <Download size={16} />
                Download All ({videos.length} videos)
              </button>
            )}
          </div>
        )}

        {/* Photo jobs (gallery-dl) — separate section with grid layout. */}
        {photoJobs.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider">Photos</h3>
            {photoJobs.map((job) => (
              <div key={job.id} className="bg-surface border border-subtle rounded-lg p-3 animate-fade-in space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary truncate">{job.url}</p>
                    <p className="text-xs mt-0.5">
                      {job.status === 'downloading' && <span className="text-accent">Downloading… {job.files.length} so far</span>}
                      {job.status === 'done' && <span className="text-success">{job.files.length} files ready</span>}
                      {job.status === 'error' && <span className="text-danger">Failed — {job.error}</span>}
                    </p>
                  </div>
                  <button
                    onClick={() => removePhotoJob(job.id)}
                    className="h-8 w-8 grid place-items-center rounded-md text-text-muted hover:text-danger hover:bg-danger/10 transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
                    title="Remove"
                    aria-label="Remove"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Thumbnail grid — 3 cols, each tile is square. */}
                {job.files.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    {job.files.map((f) => (
                      <div key={f.index} className="relative aspect-square bg-surface-2 rounded-sm overflow-hidden border border-subtle">
                        <img
                          src={`/api/photos/${job.id}/file/${f.index}`}
                          alt={f.name}
                          loading="lazy"
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* Three button states:
                    1. Job still downloading → disabled "Wait — fetching…"
                    2. Job done but prefetching files into memory → "Preparing…"
                       (no tap possible — share would fail iOS gesture check)
                    3. Ready → tap-to-save (success) */}
                {job.status === 'downloading' && (
                  <button disabled className="w-full h-10 px-4 bg-surface-2 rounded-md text-sm font-medium text-text-muted">
                    Wait — still fetching…
                  </button>
                )}
                {job.status === 'done' && !job.ready && (
                  <div className="relative w-full h-10 bg-surface-2 rounded-md overflow-hidden">
                    {(job.prefetchPct || 0) > 0 ? (
                      <div className="absolute inset-y-0 left-0 bg-accent transition-all duration-200 rounded-md" style={{ width: `${job.prefetchPct}%` }} />
                    ) : (
                      <div className="animate-indeterminate bg-accent rounded-md" />
                    )}
                    <div className="relative flex items-center justify-center h-full gap-1.5">
                      <Loader size={14} className="animate-spin text-text-primary" />
                      <span className="text-xs font-medium text-text-primary">Preparing…{(job.prefetchPct || 0) > 0 ? ` ${job.prefetchPct}%` : ''}</span>
                    </div>
                  </div>
                )}
                {job.status === 'done' && job.ready && (
                  <button
                    onClick={() => handlePhotoSaveAll(job)}
                    className="w-full h-10 px-4 bg-success hover:brightness-110 rounded-md text-sm font-semibold text-white transition-all flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/50"
                  >
                    <Download size={16} />
                    Save all {job.files.length} to Photos
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Downloads */}
        {downloads.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider">Downloads</h3>
              {downloads.some(d => d.status !== 'downloading') && (
                <button
                  onClick={() => setDownloads(prev => prev.filter(d => d.status === 'downloading'))}
                  className="text-xs text-text-muted hover:text-text-secondary transition-colors"
                >
                  Clear completed
                </button>
              )}
            </div>
            {downloads.map((dl) => {
              const active = dl.status === 'downloading' || dl.status === 'converting' || dl.status === 'subtitling'
              const busy = active || saveProgress[dl.id] !== undefined || !!instantProgress[dl.id]
              return (
              <div
                key={dl.id}
                className="bg-surface border border-subtle rounded-lg p-3 animate-fade-in"
              >
                <div className="flex gap-3 items-center">
                  {dl.thumbnail && (
                    <img src={dl.thumbnail} alt="" className="w-14 h-10 object-cover rounded-sm flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-text-primary line-clamp-2">{dl.title}</p>
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        {active && (
                          <span className="h-8 w-8 grid place-items-center">
                            <Loader size={16} className="animate-spin text-accent" />
                          </span>
                        )}
                        {dl.status === 'done' && !busy && (
                          <span className="h-8 w-8 grid place-items-center" title="Completed">
                            <CheckCircle size={16} className="text-success" />
                          </span>
                        )}
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

                    <p className="text-xs text-text-muted mt-0.5">{dl.formatLabel}</p>

                    {active && (() => {
                      const label = dl.status === 'converting' ? 'Converting'
                        : dl.status === 'subtitling' ? 'Subtitles' : 'Downloading'
                      const determinate = dl.percent > 0
                      return (
                        <>
                          <div className="mt-2 relative w-full h-1.5 bg-surface-2 rounded-md overflow-hidden">
                            {determinate ? (
                              <div className="h-full bg-accent rounded-md transition-all duration-300" style={{ width: `${dl.percent}%` }} />
                            ) : (
                              <div className="animate-indeterminate bg-accent rounded-md" />
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-xs text-text-muted font-mono">
                            <span className="text-text-secondary">{determinate ? `${label}… ${dl.percent.toFixed(0)}%` : `${label}…`}</span>
                            {dl.totalSize && <span>{dl.totalSize}</span>}
                            {dl.speed && <span>{dl.speed}</span>}
                            {dl.eta && <span className="whitespace-nowrap">ETA {dl.eta}</span>}
                          </div>
                        </>
                      )
                    })()}

                    {dl.status === 'done' && (
                      <div className="mt-2">
                        {instantProgress[dl.id] ? (
                          // On-device processing — accent determinate bar.
                          <div className="relative w-full h-9 bg-surface-2 rounded-md overflow-hidden">
                            {instantProgress[dl.id].pct > 0 ? (
                              <div className="absolute inset-y-0 left-0 bg-accent transition-all duration-200 rounded-md" style={{ width: `${instantProgress[dl.id].pct}%` }} />
                            ) : (
                              <div className="animate-indeterminate bg-accent rounded-md" />
                            )}
                            <div className="relative flex items-center justify-center h-full gap-1.5">
                              <Loader size={14} className="animate-spin text-text-primary" />
                              <span className="text-xs font-medium text-text-primary">
                                {instantProgress[dl.id].stage}{instantProgress[dl.id].pct > 0 ? ` ${instantProgress[dl.id].pct}%` : ''}
                              </span>
                            </div>
                          </div>
                        ) : saveProgress[dl.id] !== undefined ? (
                          // Preparing the file for share — accent; indeterminate when -1.
                          <div className="relative w-full h-9 bg-surface-2 rounded-md overflow-hidden">
                            {saveProgress[dl.id] >= 0 ? (
                              <div className="absolute inset-y-0 left-0 bg-accent transition-all duration-200 rounded-md" style={{ width: `${saveProgress[dl.id]}%` }} />
                            ) : (
                              <div className="animate-indeterminate bg-accent rounded-md" />
                            )}
                            <div className="relative flex items-center justify-center h-full gap-1.5">
                              <Loader size={14} className="animate-spin text-text-primary" />
                              <span className="text-xs font-medium text-text-primary">
                                {saveProgress[dl.id] >= 0 ? `Preparing… ${saveProgress[dl.id]}%` : 'Preparing…'}
                                {saveSpeed[dl.id] ? ` · ${saveSpeed[dl.id]}` : ''}
                              </span>
                            </div>
                          </div>
                        ) : dl.directOnly ? (
                          // File too big for in-memory share — direct download to Files only.
                          <div className="space-y-2">
                            <button
                              onClick={() => triggerFileDownload(dl.id, dl.fileName || 'download')}
                              className="w-full h-10 px-4 bg-accent hover:bg-accent-hover rounded-md text-sm font-semibold text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                            >
                              Download to Files
                            </button>
                            <p className="text-xs text-text-muted text-center">
                              File too large for Save to Photos — saves to Files app instead
                            </p>
                          </div>
                        ) : canShare && fileReady[dl.id] ? (
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleSaveToPhotos(dl.id, dl.fileName || 'download')}
                              className="flex-1 h-10 px-4 bg-success hover:brightness-110 rounded-md text-sm font-semibold text-white transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/50"
                            >
                              Save to Photos
                            </button>
                            <button
                              onClick={() => handleDirectDownload(dl.id, dl.fileName || 'download')}
                              className="flex-1 h-10 px-4 bg-surface-2 border border-subtle hover:text-text-primary text-text-secondary rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                            >
                              Download
                            </button>
                          </div>
                        ) : canShare && !fileReady[dl.id] ? (
                          <button
                            onClick={() => prefetchFile(dl.id, dl.fileName || 'download')}
                            className="w-full h-10 px-4 bg-surface-2 border border-subtle hover:text-text-primary text-text-secondary rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                          >
                            Retry Prepare
                          </button>
                        ) : (
                          <button
                            onClick={() => triggerFileDownload(dl.id, dl.fileName || 'download')}
                            className="w-full h-10 px-4 bg-accent hover:bg-accent-hover rounded-md text-sm font-semibold text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                          >
                            Download Again
                          </button>
                        )}
                      </div>
                    )}

                    {dl.status === 'error' && dl.error && (
                      <p className="mt-1 text-xs text-danger">{dl.error}</p>
                    )}
                  </div>
                </div>
              </div>
            )})}
          </div>
        )}

        {/* Empty state */}
        {videos.length === 0 && !loading && downloads.length === 0 && (
          <div className="text-center py-12 text-text-muted">
            <Download size={40} strokeWidth={1} className="mx-auto mb-3" />
            <p className="text-sm text-text-secondary">Paste a video URL to get started</p>
            <p className="text-xs mt-1">Works with YouTube, TikTok, Instagram, and 1800+ sites</p>
            {settings.autoDetect && (
              <p className="text-xs mt-3 text-accent/70">
                Clipboard auto-detection is on
              </p>
            )}
          </div>
        )}
      </main>

      {/* Debug panel */}
      {showDebug && (
        <div className="border-t border-subtle bg-base px-4 py-2 max-h-48 overflow-y-auto">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-text-muted uppercase font-mono">Debug Log</span>
            <button onClick={() => setDebugLogs([])} className="text-xs text-text-muted hover:text-text-secondary">Clear</button>
          </div>
          <pre className="text-xs text-success font-mono whitespace-pre-wrap break-all">
            {debugLogs.length === 0 ? 'No logs yet — start a download to see polling + worker output.' : ''}
            {debugLogs.join('\n')}
          </pre>
        </div>
      )}

    </div>
  )
}
