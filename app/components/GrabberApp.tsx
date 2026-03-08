'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ClipboardPaste, Download, Loader, CheckCircle, AlertCircle,
  X, Zap, Settings, ChevronDown, Trash2, RefreshCw
} from 'lucide-react'

interface VideoInfo {
  id: string
  title: string
  thumbnail: string
  duration: number
  formats: { formatId: string; label: string; ext: string }[]
  url: string
}

interface DownloadJob {
  id: string
  title: string
  thumbnail: string
  status: 'downloading' | 'done' | 'error'
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
function loadSettings() {
  if (typeof window === 'undefined') return { autoDetect: true, autoBest: false }
  try {
    const s = localStorage.getItem('grabber-settings')
    return s ? JSON.parse(s) : { autoDetect: true, autoBest: false }
  } catch { return { autoDetect: true, autoBest: false } }
}

function saveSettings(s: { autoDetect: boolean; autoBest: boolean }) {
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
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [downloads, setDownloads] = useState<DownloadJob[]>([])
  const [settings, setSettings] = useState({ autoDetect: true, autoBest: false })
  const [showSettings, setShowSettings] = useState(false)
  const [selectedFormat, setSelectedFormat] = useState('bv*+ba/b')
  const lastClipboard = useRef('')
  const autoTriggered = useRef(false)

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

    // Check on focus
    window.addEventListener('focus', checkClipboard)
    // Also check on visibility change (for mobile)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkClipboard()
    })

    // Initial check
    checkClipboard()

    return () => {
      window.removeEventListener('focus', checkClipboard)
    }
  }, [settings.autoDetect])

  // Auto-download best quality when info is fetched and autoBest is on
  useEffect(() => {
    if (settings.autoBest && videoInfo && !autoTriggered.current) {
      autoTriggered.current = true
      handleDownload('bv*+ba/b', 'Best Quality')
    }
  }, [videoInfo, settings.autoBest])

  const fetchInfo = useCallback(async (videoUrl: string) => {
    if (!videoUrl.trim()) return
    setLoading(true)
    setError('')
    setVideoInfo(null)
    autoTriggered.current = false

    try {
      const res = await fetch(`/api/info?url=${encodeURIComponent(videoUrl.trim())}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch')
      setVideoInfo(data)
      setSelectedFormat('bv*+ba/b')
    } catch (err: any) {
      setError(err.message || 'Failed to fetch video info')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleDownload = async (formatId: string, formatLabel: string) => {
    if (!videoInfo) return

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: videoInfo.url,
          formatId,
          title: videoInfo.title,
          thumbnail: videoInfo.thumbnail,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      const job: DownloadJob = {
        id: data.id,
        title: videoInfo.title,
        thumbnail: videoInfo.thumbnail,
        status: 'downloading',
        percent: 0, speed: '', eta: '', totalSize: '',
        url: videoInfo.url,
        formatLabel,
      }

      setDownloads(prev => [job, ...prev])

      // Connect to SSE for progress
      const evtSource = new EventSource(`/api/progress/${data.id}`)
      evtSource.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        setDownloads(prev => prev.map(d => {
          if (d.id !== data.id) return d
          if (msg.type === 'progress') {
            return { ...d, percent: msg.percent, speed: msg.speed, eta: msg.eta, totalSize: msg.totalSize }
          }
          if (msg.type === 'done') {
            // Trigger file download
            triggerFileDownload(data.id, msg.fileName)
            return { ...d, status: 'done', percent: 100, fileName: msg.fileName }
          }
          if (msg.type === 'error') {
            return { ...d, status: 'error', error: msg.message }
          }
          return d
        }))
        if (msg.type === 'done' || msg.type === 'error') {
          evtSource.close()
        }
      }
      evtSource.onerror = () => {
        evtSource.close()
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start download')
    }
  }

  const triggerFileDownload = (id: string, fileName: string) => {
    const a = document.createElement('a')
    a.href = `/api/file/${id}`
    a.download = fileName || 'download'
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
      // Fallback: just focus the input
    }
  }

  const handleQuickGrab = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text?.trim()) return
      const clipUrl = text.trim()
      setUrl(clipUrl)
      setLoading(true)
      setError('')
      setVideoInfo(null)
      autoTriggered.current = false

      const res = await fetch(`/api/info?url=${encodeURIComponent(clipUrl)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch')

      setVideoInfo(data)
      setSelectedFormat('bv*+ba/b')

      if (settings.autoBest) {
        autoTriggered.current = true
        // Need to pass info directly since state hasn't updated yet
        const startRes = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: clipUrl, formatId: 'bv*+ba/b', title: data.title, thumbnail: data.thumbnail }),
        })
        const dlData = await startRes.json()
        if (!startRes.ok) throw new Error(dlData.error)

        const job: DownloadJob = {
          id: dlData.id, title: data.title, thumbnail: data.thumbnail,
          status: 'downloading', percent: 0, speed: '', eta: '', totalSize: '',
          url: clipUrl, formatLabel: 'Best Quality',
        }
        setDownloads(prev => [job, ...prev])

        const evtSource = new EventSource(`/api/progress/${dlData.id}`)
        evtSource.onmessage = (event) => {
          const msg = JSON.parse(event.data)
          setDownloads(prev => prev.map(d => {
            if (d.id !== dlData.id) return d
            if (msg.type === 'progress') return { ...d, percent: msg.percent, speed: msg.speed, eta: msg.eta, totalSize: msg.totalSize }
            if (msg.type === 'done') { triggerFileDownload(dlData.id, msg.fileName); return { ...d, status: 'done', percent: 100, fileName: msg.fileName } }
            if (msg.type === 'error') return { ...d, status: 'error', error: msg.message }
            return d
          }))
          if (msg.type === 'done' || msg.type === 'error') evtSource.close()
        }
        evtSource.onerror = () => evtSource.close()
      }
    } catch (err: any) {
      setError(err.message || 'Failed to grab video')
    } finally {
      setLoading(false)
    }
  }

  const removeDownload = (id: string) => {
    setDownloads(prev => prev.filter(d => d.id !== id))
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
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 px-4 py-6 max-w-lg mx-auto w-full space-y-4">
        {/* URL Input */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
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
              onClick={handleQuickGrab}
              disabled={loading}
              className="px-4 py-3 bg-[#1a1a1a] border border-[#262626] hover:bg-sky-500 hover:border-sky-500 hover:text-white disabled:opacity-40 rounded-xl text-neutral-400 transition-colors"
              title="Paste & auto-download"
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

        {/* Video Info Card */}
        {videoInfo && (
          <div className="bg-[#1a1a1a] border border-[#262626] rounded-xl overflow-hidden animate-fade-in">
            {videoInfo.thumbnail && (
              <img
                src={videoInfo.thumbnail}
                alt=""
                className="w-full h-44 object-cover"
              />
            )}
            <div className="p-4 space-y-3">
              <div>
                <h3 className="text-sm font-medium text-white line-clamp-2">{videoInfo.title}</h3>
                {videoInfo.duration > 0 && (
                  <p className="text-xs text-neutral-500 mt-1">{formatDuration(videoInfo.duration)}</p>
                )}
              </div>

              {/* Format selector */}
              {!settings.autoBest && (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {videoInfo.formats.map((f) => (
                      <button
                        key={f.formatId}
                        onClick={() => setSelectedFormat(f.formatId)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          selectedFormat === f.formatId
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
                      const fmt = videoInfo.formats.find(f => f.formatId === selectedFormat)
                      handleDownload(selectedFormat, fmt?.label || 'Best Quality')
                    }}
                    className="w-full py-2.5 bg-sky-500 hover:bg-sky-600 rounded-xl text-sm font-medium text-white transition-colors flex items-center justify-center gap-2"
                  >
                    <Download size={16} />
                    Download
                  </button>
                </>
              )}
            </div>
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
                        {dl.status === 'done' && (
                          <CheckCircle size={12} className="text-green-500" />
                        )}
                        {dl.status === 'error' && (
                          <AlertCircle size={12} className="text-red-500" />
                        )}
                        {dl.status !== 'downloading' && (
                          <button
                            onClick={() => removeDownload(dl.id)}
                            className="p-0.5 text-neutral-600 hover:text-neutral-300 transition-colors"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    </div>

                    <p className="text-[10px] text-neutral-500">{dl.formatLabel}</p>

                    {dl.status === 'downloading' && (
                      <>
                        <div className="mt-1.5 w-full bg-[#262626] rounded-full h-1">
                          <div
                            className="bg-sky-500 h-1 rounded-full transition-all duration-300"
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
                        <button
                          onClick={() => triggerFileDownload(dl.id, dl.fileName || 'download')}
                          className="text-[10px] text-sky-500 hover:text-sky-400 font-medium transition-colors"
                        >
                          Download again
                        </button>
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
        {!videoInfo && !loading && downloads.length === 0 && (
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

      {/* Footer */}
      <footer className="text-center py-3 text-[10px] text-neutral-700 border-t border-[#1a1a1a]">
        Powered by yt-dlp
      </footer>
    </div>
  )
}
