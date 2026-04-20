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
  formats: { formatId: string; label: string; ext: string }[]
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
}

// Persist settings in localStorage
const defaultSettings = { autoDetect: true, autoBest: false, verticalPad: false, directDownload: false, burnSubtitles: false, instantMode: false }

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
  const fileCache = useRef<Record<string, File>>({})
  const [fileReady, setFileReady] = useState<Record<string, boolean>>({})
  const [debugLogs, setDebugLogs] = useState<string[]>([])
  const [showDebug, setShowDebug] = useState(false)
  const [webCodecsSupported, setWebCodecsSupported] = useState(false)
  const [instantProgress, setInstantProgress] = useState<Record<string, { pct: number; stage: string }>>({})
  // Tracks in-flight download IDs that can be cancelled. Holds AbortControllers + worker handles.
  const cancelHandles = useRef<Record<string, {
    stop: () => void
    abort?: AbortController
    worker?: { cancel: () => void }
  }>>({})

  useEffect(() => {
    isWebCodecsSupported().then(setWebCodecsSupported).catch(() => setWebCodecsSupported(false))
  }, [])

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

  const fetchInfo = useCallback(async (videoUrl: string) => {
    if (!videoUrl.trim()) return
    setLoading(true)
    setError('')
    setVideos([])
    setSelectedFormats({})
    autoTriggered.current = false

    try {
      const res = await fetch(`/api/info?url=${encodeURIComponent(videoUrl.trim())}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch')
      const vids: VideoInfo[] = data.videos || (data.id ? [data] : [])
      setVideos(vids)
      // Set default format for each video
      const defaults: Record<string, string> = {}
      for (const v of vids) {
        defaults[v.id] = v.formats[0]?.formatId || 'b'
      }
      setSelectedFormats(defaults)
    } catch (err: any) {
      setError(err.message || 'Failed to fetch video info')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleDownload = async (video: VideoInfo, formatId: string, formatLabel: string) => {
    // Direct download mode: browser fetches from source URL
    if (settings.directDownload) {
      try {
        const r = await fetch('/api/geturl', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: video.url,
          formatId,
          title: video.title,
          thumbnail: video.thumbnail,
          playlistIndex: video.playlistIndex,
          verticalPad: settings.verticalPad,
          duration: video.duration,
          burnSubtitles: settings.burnSubtitles,
          instantMode: settings.instantMode && webCodecsSupported,
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
          const r = await fetch(`/api/progress/${data.id}?logsSince=${logsSince}`, { cache: 'no-store' })
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
            const useInstant = settings.instantMode && webCodecsSupported && (settings.burnSubtitles || settings.verticalPad)
            if (useInstant) {
              // Instant mode: fetch raw video, process on-device with WebCodecs.
              // Server skips ffmpeg pad AND (if subs off) Groq — client does it all.
              prefetchAndProcess(data.id, state.fileName, state.srt || '', settings.verticalPad, settings.burnSubtitles)
            } else if (typeof navigator !== 'undefined' && 'share' in navigator) {
              prefetchFile(data.id, state.fileName)
            } else {
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
    const fileUrl = `/api/file/${id}`
    const name = fileName || 'video.mp4'
    try {
      setSaveProgress(prev => ({ ...prev, [id]: 0 }))
      const res = await fetch(fileUrl)
      const contentLength = res.headers.get('content-length')
      const total = contentLength ? parseInt(contentLength, 10) : 0

      let blob: Blob
      if (total && res.body) {
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let received = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          setSaveProgress(prev => ({ ...prev, [id]: Math.round((received / total) * 100) }))
        }
        const combined = new Uint8Array(received)
        let offset = 0
        for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length }
        blob = new Blob([combined])
      } else {
        setSaveProgress(prev => ({ ...prev, [id]: -1 }))
        blob = await res.blob()
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
    const fileUrl = `/api/file/${id}`
    const name = fileName || 'video.mp4'

    // Register abort controller for the fetch (cancel button can trigger this)
    const ac = new AbortController()
    const existing = cancelHandles.current[id] || { stop: () => {} }
    cancelHandles.current[id] = { ...existing, abort: ac }

    try {
      // Step 1: fetch raw video from server with progress (same as prefetchFile)
      setSaveProgress(prev => ({ ...prev, [id]: 0 }))
      const res = await fetch(fileUrl, { signal: ac.signal })
      const contentLength = res.headers.get('content-length')
      const total = contentLength ? parseInt(contentLength, 10) : 0
      let rawBlob: Blob
      if (total && res.body) {
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let received = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          setSaveProgress(prev => ({ ...prev, [id]: Math.round((received / total) * 100) }))
        }
        const combined = new Uint8Array(received)
        let offset = 0
        for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length }
        rawBlob = new Blob([combined], { type: 'video/mp4' })
      } else {
        setSaveProgress(prev => ({ ...prev, [id]: -1 }))
        rawBlob = await res.blob()
      }
      setSaveProgress(prev => { const n = { ...prev }; delete n[id]; return n })

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

    if (navigator.canShare && !navigator.canShare({ files: [safeFile] })) {
      setDebugLogs(prev => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] canShare() returned false`])
      return
    }

    try {
      await navigator.share({ files: [safeFile] })
      setDebugLogs(prev => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] Share sheet opened`])
    } catch (err: any) {
      setDebugLogs(prev => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] Share error: ${err?.name} - ${err?.message}`])
      if (err?.name === 'AbortError') return
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
    const fileUrl = `/api/file/${id}`
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
      await fetch(`/api/cancel/${id}`, { method: 'POST', cache: 'no-store' })
    } catch (err) {
      console.error('[cancel] server request failed', err)
    }

    // 3. Clear any per-id progress state
    setSaveProgress(prev => { const n = { ...prev }; delete n[id]; return n })
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
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a]">
        <div className="flex items-center gap-2">
          <Download size={20} className="text-sky-500" />
          <h1 className="text-base font-semibold">Grabber</h1>
        </div>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="p-2 rounded-lg hover:bg-[#1a1a1a] text-neutral-400 hover:text-white transition-colors"
        >
          <Settings size={18} />
        </button>
      </header>

      {/* Settings panel */}
      {showSettings && (
        <div className="border-b border-[#1a1a1a] bg-[#111] px-4 py-3 space-y-3 animate-fade-in">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white">Auto-detect clipboard</p>
              <p className="text-[11px] text-neutral-500">Automatically detects video URLs when you copy them</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input
                type="checkbox"
                checked={settings.autoDetect}
                onChange={(e) => setSettings(s => ({ ...s, autoDetect: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-[#333] rounded-full peer peer-checked:bg-sky-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <Zap size={14} className="text-sky-500" />
                <p className="text-sm text-white">Auto best quality</p>
              </div>
              <p className="text-[11px] text-neutral-500">Instantly downloads best quality when URL is detected</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input
                type="checkbox"
                checked={settings.autoBest}
                onChange={(e) => setSettings(s => ({ ...s, autoBest: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-[#333] rounded-full peer peer-checked:bg-sky-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white">Pad to 9:16 vertical</p>
              <p className="text-[11px] text-neutral-500">Adds black bars for Reels/TikTok</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input
                type="checkbox"
                checked={settings.verticalPad}
                onChange={(e) => setSettings(s => ({ ...s, verticalPad: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-[#333] rounded-full peer peer-checked:bg-purple-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white">Direct download</p>
              <p className="text-[11px] text-neutral-500">Faster, skips server. Won't work for geo-blocked sites</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input
                type="checkbox"
                checked={settings.directDownload}
                onChange={(e) => setSettings(s => ({ ...s, directDownload: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-[#333] rounded-full peer peer-checked:bg-orange-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white">Burn English subtitles</p>
              <p className="text-[11px] text-neutral-500">Auto-generates English subtitles and burns them into the video (any language to English)</p>
            </div>
            <label className="relative inline-flex cursor-pointer">
              <input
                type="checkbox"
                checked={settings.burnSubtitles}
                onChange={(e) => setSettings(s => ({ ...s, burnSubtitles: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-[#333] rounded-full peer peer-checked:bg-yellow-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          {webCodecsSupported && (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-white">⚡ Instant mode (WebCodecs)</p>
                <p className="text-[11px] text-neutral-500">Process on your device's hardware encoder — ~5s on iPhone. Works only with subtitles on.</p>
              </div>
              <label className="relative inline-flex cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.instantMode}
                  onChange={(e) => setSettings(s => ({ ...s, instantMode: e.target.checked }))}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-[#333] rounded-full peer peer-checked:bg-cyan-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
              </label>
            </div>
          )}

          <div className="pt-1">
            <p className="text-[10px] text-neutral-600">
              Install the Grabber Helper Chrome extension for YouTube support
            </p>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 px-4 py-6 max-w-lg mx-auto w-full space-y-4">
        {/* URL Input */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchInfo(url)}
              placeholder="Paste video URL..."
              className="flex-1 bg-[#1a1a1a] border border-[#262626] rounded-xl px-4 py-3 text-sm text-white placeholder-neutral-600 outline-none focus:border-sky-500 transition-colors"
            />
            <button
              onClick={handlePaste}
              className="px-4 py-3 bg-[#1a1a1a] border border-[#262626] rounded-xl text-neutral-400 hover:text-sky-500 hover:border-sky-500/50 transition-colors"
              title="Paste from clipboard"
            >
              <ClipboardPaste size={18} />
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => fetchInfo(url)}
              disabled={!url.trim() || loading}
              className="flex-1 py-3 bg-sky-500 hover:bg-sky-600 disabled:bg-[#262626] disabled:text-neutral-600 rounded-xl text-sm font-medium text-white transition-colors flex items-center justify-center gap-2"
            >
              {loading ? <Loader size={16} className="animate-spin" /> : <Download size={16} />}
              {loading ? 'Fetching...' : 'Fetch Video'}
            </button>
            <button
              onClick={handleReload}
              disabled={loading}
              className="px-4 py-3 bg-[#1a1a1a] border border-[#262626] hover:bg-sky-500 hover:border-sky-500 hover:text-white disabled:opacity-40 rounded-xl text-neutral-400 transition-colors"
              title="Clear & paste new link"
            >
              <RefreshCw size={18} />
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400 animate-fade-in">
            <AlertCircle size={16} />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError('')} className="text-red-400/60 hover:text-red-400">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Video Info Cards — stacked for multi-video */}
        {videos.length > 0 && (
          <div className="space-y-3">
            {videos.length > 1 && (
              <p className="text-xs text-neutral-400">{videos.length} videos found</p>
            )}
            {videos.map((video, idx) => (
              <div key={video.id} className="bg-[#1a1a1a] border border-[#262626] rounded-xl overflow-hidden animate-fade-in">
                {video.thumbnail && (
                  <img
                    src={video.thumbnail}
                    alt=""
                    className="w-full h-44 object-cover"
                  />
                )}
                <div className="p-4 space-y-3">
                  <div>
                    <h3 className="text-sm font-medium text-white line-clamp-2">
                      {videos.length > 1 && <span className="text-sky-500 mr-1.5">#{idx + 1}</span>}
                      {video.title}
                    </h3>
                    {video.duration > 0 && (
                      <p className="text-xs text-neutral-500 mt-1">{formatDuration(video.duration)}</p>
                    )}
                  </div>

                  {/* Format selector */}
                  {!settings.autoBest && (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {video.formats.map((f) => (
                          <button
                            key={f.formatId}
                            onClick={() => setSelectedFormats(prev => ({ ...prev, [video.id]: f.formatId }))}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                              (selectedFormats[video.id] || video.formats[0]?.formatId) === f.formatId
                                ? 'bg-sky-500 text-white'
                                : 'bg-[#262626] text-neutral-300 hover:bg-[#333]'
                            }`}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={() => {
                          const fmtId = selectedFormats[video.id] || video.formats[0]?.formatId
                          const fmt = video.formats.find(f => f.formatId === fmtId)
                          handleDownload(video, fmtId, fmt?.label || 'Best Quality')
                        }}
                        className="w-full py-2.5 bg-sky-500 hover:bg-sky-600 rounded-xl text-sm font-medium text-white transition-colors flex items-center justify-center gap-2"
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
                className="w-full py-3 bg-sky-500 hover:bg-sky-600 rounded-xl text-sm font-medium text-white transition-colors flex items-center justify-center gap-2"
              >
                <Download size={16} />
                Download All ({videos.length} videos)
              </button>
            )}
          </div>
        )}

        {/* Downloads */}
        {downloads.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Downloads</h3>
              {downloads.some(d => d.status !== 'downloading') && (
                <button
                  onClick={() => setDownloads(prev => prev.filter(d => d.status === 'downloading'))}
                  className="text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                  Clear completed
                </button>
              )}
            </div>
            {downloads.map((dl) => (
              <div
                key={dl.id}
                className="bg-[#1a1a1a] border border-[#262626] rounded-xl p-3 animate-fade-in"
              >
                <div className="flex gap-3">
                  {dl.thumbnail && (
                    <img src={dl.thumbnail} alt="" className="w-14 h-10 object-cover rounded flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs text-white truncate">{dl.title}</p>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {dl.status === 'downloading' && (
                          <Loader size={12} className="animate-spin text-sky-500" />
                        )}
                        {dl.status === 'converting' && (
                          <Loader size={12} className="animate-spin text-purple-500" />
                        )}
                        {dl.status === 'subtitling' && (
                          <Loader size={12} className="animate-spin text-yellow-500" />
                        )}
                        {dl.status === 'done' && (
                          <CheckCircle size={12} className="text-green-500" />
                        )}
                        {dl.status === 'error' && (
                          <AlertCircle size={12} className="text-red-500" />
                        )}
                        {/* Cancel button: while anything active (server download or client-side processing) */}
                        {(dl.status === 'downloading' || dl.status === 'converting' || dl.status === 'subtitling' ||
                          saveProgress[dl.id] !== undefined || instantProgress[dl.id]) && (
                          <button
                            onClick={() => handleCancelDownload(dl.id)}
                            className="p-0.5 text-red-500 hover:text-red-400 transition-colors"
                            title="Cancel + delete file"
                          >
                            <X size={12} />
                          </button>
                        )}
                        {/* Remove button: once terminal, no active work */}
                        {dl.status !== 'downloading' && dl.status !== 'converting' && dl.status !== 'subtitling' &&
                          saveProgress[dl.id] === undefined && !instantProgress[dl.id] && (
                          <button
                            onClick={() => removeDownload(dl.id)}
                            className="p-0.5 text-neutral-600 hover:text-neutral-300 transition-colors"
                            title="Remove"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    </div>

                    <p className="text-[10px] text-neutral-500">{dl.formatLabel}</p>

                    {(dl.status === 'downloading' || dl.status === 'converting' || dl.status === 'subtitling') && (
                      <>
                        <div className="mt-1.5 w-full bg-[#262626] rounded-full h-1">
                          <div
                            className={`h-1 rounded-full transition-all duration-300 ${dl.status === 'converting' ? 'bg-purple-500' : dl.status === 'subtitling' ? 'bg-yellow-500' : 'bg-sky-500'}`}
                            style={{ width: `${dl.percent}%` }}
                          />
                        </div>
                        <div className="flex gap-3 mt-1 text-[10px] text-neutral-500 font-mono">
                          {dl.percent > 0 && <span>{dl.percent.toFixed(1)}%</span>}
                          {dl.totalSize && <span>{dl.totalSize}</span>}
                          {dl.speed && <span>{dl.speed}</span>}
                          {dl.eta && <span>ETA {dl.eta}</span>}
                        </div>
                      </>
                    )}

                    {dl.status === 'done' && (
                      <div className="mt-1.5">
                        {instantProgress[dl.id] ? (
                          <div className="relative w-full h-9 bg-[#262626] rounded-lg overflow-hidden">
                            <div
                              className="absolute inset-y-0 left-0 bg-cyan-500 transition-all duration-200"
                              style={{ width: `${instantProgress[dl.id].pct}%` }}
                            />
                            <div className="relative flex items-center justify-center h-full gap-1.5">
                              <Loader size={12} className="animate-spin text-white" />
                              <span className="text-xs font-medium text-white">
                                ⚡ {instantProgress[dl.id].stage} {instantProgress[dl.id].pct}%
                              </span>
                            </div>
                          </div>
                        ) : saveProgress[dl.id] !== undefined ? (
                          <div className="relative w-full h-9 bg-[#262626] rounded-lg overflow-hidden">
                            {saveProgress[dl.id] >= 0 ? (
                              <div
                                className="absolute inset-y-0 left-0 bg-green-500 transition-all duration-200"
                                style={{ width: `${saveProgress[dl.id]}%` }}
                              />
                            ) : (
                              <div className="absolute inset-y-0 left-0 right-0 bg-green-500 animate-pulse" />
                            )}
                            <div className="relative flex items-center justify-center h-full gap-1.5">
                              <Loader size={12} className="animate-spin text-white" />
                              <span className="text-xs font-medium text-white">
                                {saveProgress[dl.id] >= 0
                                  ? `Preparing ${saveProgress[dl.id]}%`
                                  : 'Preparing...'}
                              </span>
                            </div>
                          </div>
                        ) : canShare && fileReady[dl.id] ? (
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => handleSaveToPhotos(dl.id, dl.fileName || 'download')}
                              className="flex-1 py-2 bg-green-500 hover:bg-green-600 rounded-lg text-xs font-medium text-white transition-colors"
                            >
                              Save to Photos
                            </button>
                            <button
                              onClick={() => handleDirectDownload(dl.id, dl.fileName || 'download')}
                              className="flex-1 py-2 bg-[#262626] hover:bg-[#333] rounded-lg text-xs font-medium text-neutral-300 transition-colors"
                            >
                              Download
                            </button>
                          </div>
                        ) : canShare && !fileReady[dl.id] ? (
                          <button
                            onClick={() => prefetchFile(dl.id, dl.fileName || 'download')}
                            className="w-full py-2 bg-[#262626] hover:bg-[#333] rounded-lg text-xs font-medium text-neutral-400 transition-colors"
                          >
                            Retry Prepare
                          </button>
                        ) : (
                          <button
                            onClick={() => triggerFileDownload(dl.id, dl.fileName || 'download')}
                            className="w-full py-2 bg-green-500 hover:bg-green-600 rounded-lg text-xs font-medium text-white transition-colors"
                          >
                            Download Again
                          </button>
                        )}
                      </div>
                    )}

                    {dl.status === 'error' && dl.error && (
                      <p className="mt-1 text-[10px] text-red-400">{dl.error}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {videos.length === 0 && !loading && downloads.length === 0 && (
          <div className="text-center py-12 text-neutral-600">
            <Download size={40} strokeWidth={1} className="mx-auto mb-3" />
            <p className="text-sm">Paste a video URL to get started</p>
            <p className="text-xs mt-1">Works with YouTube, TikTok, Instagram, and 1800+ sites</p>
            {settings.autoDetect && (
              <p className="text-xs mt-3 text-sky-500/60">
                Clipboard auto-detection is on
              </p>
            )}
          </div>
        )}
      </main>

      {/* Debug panel */}
      {showDebug && debugLogs.length > 0 && (
        <div className="border-t border-[#1a1a1a] bg-[#0a0a0a] px-4 py-2 max-h-48 overflow-y-auto">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-neutral-500 uppercase font-mono">Debug Log</span>
            <button onClick={() => setDebugLogs([])} className="text-[10px] text-neutral-600 hover:text-neutral-400">Clear</button>
          </div>
          <pre className="text-[10px] text-green-400 font-mono whitespace-pre-wrap break-all">
            {debugLogs.join('\n')}
          </pre>
        </div>
      )}

      {/* Footer */}
      <footer className="text-center py-3 text-[10px] text-neutral-700 border-t border-[#1a1a1a]">
        <span onClick={() => setShowDebug(s => !s)} className="cursor-pointer">Build 39</span>
      </footer>
    </div>
  )
}
