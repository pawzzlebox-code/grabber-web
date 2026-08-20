'use client'

// Upload & Process — run a video already on the device through the same
// pipeline the downloader uses (9:16 pad, burned captions, H.264 remux).
//
// Everything except transcription happens in the browser via WebCodecs, so the
// video never uploads. That matters a lot here: the server sits in New York
// and the link to it tops out around 0.5 MB/s, whereas local processing runs
// at device speed no matter how big the file is. Only when captions are
// requested does anything leave the machine, and then it's just the extracted
// audio track (~1 MB/min), not the video.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, Loader, AlertCircle, X, Download } from 'lucide-react'
import { runWorker } from '@/lib/webcodecs-client'
import { extractAudioTrack } from '@/lib/extract-audio'
import { isWebCodecsSupported } from '@/lib/webcodecs-processor'

// Above this the tab risks an out-of-memory crash: processing holds the source
// and the encoded result in memory at once. iOS Safari gives up far sooner
// than desktop, so it gets a lower bar.
const SOFT_LIMIT_DESKTOP = 700 * 1024 * 1024
const SOFT_LIMIT_IOS = 250 * 1024 * 1024

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

export default function UploadPanel() {
  const [file, setFile] = useState<File | null>(null)
  const [padTo9x16, setPadTo9x16] = useState(false)
  const [burnSubtitles, setBurnSubtitles] = useState(false)
  const [toH264, setToH264] = useState(true)
  const [srtText, setSrtText] = useState('')
  const [srtName, setSrtName] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ blob: Blob; name: string } | null>(null)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [dragging, setDragging] = useState(false)

  const cancelRef = useRef<(() => void) | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const srtInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    isWebCodecsSupported().then(setSupported).catch(() => setSupported(false))
  }, [])

  // Nothing selected means nothing to do — the worker always outputs H.264, so
  // "convert" alone is a valid (transcode-only) job.
  const canProcess = !!file && (padTo9x16 || burnSubtitles || toH264) && !busy

  const reset = useCallback(() => {
    cancelRef.current?.()
    cancelRef.current = null
    setFile(null); setResult(null); setError(''); setStage(''); setPercent(0)
    setSrtText(''); setSrtName(''); setBusy(false)
  }, [])

  const chooseFile = (f: File | undefined | null) => {
    if (!f) return
    if (!f.type.startsWith('video/') && !/\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(f.name)) {
      setError('That does not look like a video file.')
      return
    }
    const limit = isIOS() ? SOFT_LIMIT_IOS : SOFT_LIMIT_DESKTOP
    if (f.size > limit) {
      setError(`${formatSize(f.size)} is too large to process in the browser on this device (limit ${formatSize(limit)}).`)
      return
    }
    setError(''); setResult(null); setFile(f)
  }

  const loadSrt = async (f: File | undefined | null) => {
    if (!f) return
    try {
      const text = await f.text()
      if (!/-->/.test(text)) {
        setError('That file does not look like an SRT subtitle file.')
        return
      }
      setSrtText(text); setSrtName(f.name); setError(''); setBurnSubtitles(true)
    } catch {
      setError('Could not read that subtitle file.')
    }
  }

  const process = async () => {
    if (!file) return
    setBusy(true); setError(''); setResult(null); setPercent(0)

    try {
      let srt = srtText

      // No SRT supplied → extract the audio locally and have the server
      // transcribe just that.
      if (burnSubtitles && !srt) {
        setStage('Extracting audio…')
        const audio = await extractAudioTrack(file)
        setStage(`Transcribing ${formatSize(audio.blob.size)} of audio…`)
        const form = new FormData()
        form.append('audio', new File([audio.blob], audio.fileName, { type: audio.blob.type }))
        const res = await fetch('/api/transcribe', { method: 'POST', body: form })
        const data = await res.json().catch(() => ({} as any))
        if (!res.ok) throw new Error(data?.error || `Transcription failed (${res.status}).`)
        srt = data.srt || ''
        if (!srt) throw new Error('No captions were produced for this video.')
      }

      setStage('Starting encoder…')
      const handle = runWorker(
        file,
        { padTo9x16, burnSubtitles: burnSubtitles && !!srt, srt },
        (pct, s) => { setPercent(pct); setStage(s) },
      )
      cancelRef.current = handle.cancel
      const processed = await handle.promise
      cancelRef.current = null

      const base = file.name.replace(/\.[^.]+$/, '')
      const suffix = [padTo9x16 ? 'vertical' : '', burnSubtitles && srt ? 'subbed' : ''].filter(Boolean).join('-')
      setResult({ blob: processed, name: `${base}${suffix ? '-' + suffix : ''}.mp4` })
      setStage('Done')
      setPercent(100)
    } catch (err: any) {
      if (err?.message) setError(err.message)
      setStage('')
    } finally {
      setBusy(false)
    }
  }

  // iOS hands files to Photos through the share sheet. navigator.share must be
  // called synchronously inside the tap — any await first and iOS revokes the
  // user-activation token.
  const saveResult = () => {
    if (!result) return
    const outFile = new File([result.blob], result.name, { type: 'video/mp4' })
    if (isIOS() && typeof navigator !== 'undefined' && navigator.canShare?.({ files: [outFile] })) {
      navigator.share({ files: [outFile] }).catch((err: any) => {
        if (err?.name !== 'AbortError') setError(`Save failed: ${err?.message || err}`)
      })
      return
    }
    const url = URL.createObjectURL(result.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = result.name
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  if (supported === false) {
    return (
      <section className="panel p-4">
        <h3 className="pixel-head text-xs font-bold uppercase tracking-[0.24em]">Upload &amp; Process</h3>
        <p className="text-xs text-text-secondary mt-2">
          This browser cannot encode video locally (WebCodecs is unavailable), so uploads can&apos;t be processed here.
          Chrome, Edge, or Safari 17+ will work.
        </p>
      </section>
    )
  }

  return (
    <section className="panel p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="pixel-head text-xs font-bold uppercase tracking-[0.24em]">Upload &amp; Process</h3>
        {file && !busy && (
          <button onClick={reset} className="text-[10px] uppercase tracking-wider text-text-secondary hover:text-danger transition-colors">
            Clear
          </button>
        )}
      </div>

      {!file ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files?.[0]) }}
          onClick={() => fileInputRef.current?.click()}
          className={`inset-field grid place-items-center gap-2 py-8 cursor-pointer transition-colors ${dragging ? 'brightness-125' : ''}`}
        >
          <Upload size={26} className="text-white" />
          <p className="text-xs text-white uppercase tracking-wider">Drop a video here</p>
          <p className="text-[10px] text-[#8b93a5]">or tap to choose a file</p>
        </div>
      ) : (
        <div className="text-xs text-text-primary break-all">
          <span className="font-semibold">{file.name}</span>
          <span className="text-text-muted"> · {formatSize(file.size)}</span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => chooseFile(e.target.files?.[0])}
      />

      {file && (
        <>
          <div className="space-y-3">
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <div>
                <p className="text-sm font-medium text-text-primary">Pad to 9:16 vertical</p>
                <p className="text-xs text-text-muted">Adds black bars for Reels/TikTok</p>
              </div>
              <span className="relative inline-flex">
                <input type="checkbox" checked={padTo9x16} disabled={busy} onChange={(e) => setPadTo9x16(e.target.checked)} className="sr-only peer" />
                <span className="cb-box" />
              </span>
            </label>

            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <div>
                <p className="text-sm font-medium text-text-primary">Burn English subtitles</p>
                <p className="text-xs text-text-muted">
                  {srtName ? `Using ${srtName}` : 'Auto-transcribes the audio, then burns it in'}
                </p>
              </div>
              <span className="relative inline-flex">
                <input type="checkbox" checked={burnSubtitles} disabled={busy} onChange={(e) => setBurnSubtitles(e.target.checked)} className="sr-only peer" />
                <span className="cb-box" />
              </span>
            </label>

            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <div>
                <p className="text-sm font-medium text-text-primary">Convert to H.264 MP4</p>
                <p className="text-xs text-text-muted">Makes VP9/AV1 files play on iPhone</p>
              </div>
              <span className="relative inline-flex">
                <input type="checkbox" checked={toH264} disabled={busy} onChange={(e) => setToH264(e.target.checked)} className="sr-only peer" />
                <span className="cb-box" />
              </span>
            </label>

            {burnSubtitles && (
              <button
                onClick={() => srtInputRef.current?.click()}
                disabled={busy}
                className="text-[10px] uppercase tracking-wider text-text-secondary hover:text-text-primary transition-colors"
              >
                {srtName ? 'Use a different .srt' : 'Or use my own .srt file'}
              </button>
            )}
            <input
              ref={srtInputRef}
              type="file"
              accept=".srt,text/plain"
              className="hidden"
              onChange={(e) => loadSrt(e.target.files?.[0])}
            />
          </div>

          {busy ? (
            <div className="space-y-2">
              <div className="tbar-track relative h-3 w-full overflow-hidden">
                {percent > 0
                  ? <div className="absolute inset-y-0 left-0 tbar-fill text-[#5a9ee8] transition-all duration-200" style={{ width: `${percent}%` }} />
                  : <div className="animate-indeterminate tbar-fill text-[#5a9ee8]" />}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-text-secondary flex items-center gap-1.5">
                  <Loader size={12} className="animate-spin" /> {stage}
                </span>
                <button
                  onClick={reset}
                  className="text-[10px] uppercase tracking-wider text-text-muted hover:text-danger transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : result ? (
            <div className="flex gap-2">
              <button onClick={saveResult} className="flex-1 h-10 px-4 raised text-sm transition-colors flex items-center justify-center gap-2">
                <Download size={16} />
                {isIOS() ? 'Save to Photos' : `Save ${formatSize(result.blob.size)}`}
              </button>
              <button onClick={reset} className="h-10 w-10 grid place-items-center raised transition-colors" title="Start over" aria-label="Start over">
                <X size={16} />
              </button>
            </div>
          ) : (
            <button
              onClick={process}
              disabled={!canProcess}
              className="w-full h-10 px-4 raised text-sm transition-colors flex items-center justify-center gap-2"
            >
              <Upload size={16} />
              Process video
            </button>
          )}
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs font-semibold text-danger">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="text-danger/70 hover:text-danger" aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}
    </section>
  )
}
