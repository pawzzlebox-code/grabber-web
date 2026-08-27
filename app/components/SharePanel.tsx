'use client'

// Share manager — upload a video, hand out a public link, revoke it later.
//
// Only you ever see this panel (it lives behind the site's token gate). The
// links it produces point at /s/<id>, the one path that's public, so the
// recipient can download that single file and reach nothing else.
//
// Uploads use XMLHttpRequest rather than fetch purely for the progress event:
// the uplink to the server runs around 0.5 MB/s, so a large file can take
// many minutes and a silent progress-less wait would look like a hang.

import { useCallback, useEffect, useRef, useState } from 'react'
import { UploadCloud, Trash2, Link as LinkIcon, Check, AlertCircle, X } from 'lucide-react'

interface Share {
  id: string
  name: string
  size: number
  createdAt: number
  expiresAt: number | null
  downloads: number
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

export default function SharePanel() {
  const [shares, setShares] = useState<Share[]>([])
  const [used, setUsed] = useState(0)
  const [quota, setQuota] = useState(0)
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [expiry, setExpiry] = useState('7')

  const fileRef = useRef<HTMLInputElement>(null)
  const xhrRef = useRef<XMLHttpRequest | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/shares', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setShares(data.shares || [])
      setUsed(data.usedBytes || 0)
      setQuota(data.maxTotalBytes || 0)
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])

  const upload = (file: File) => {
    setError(''); setUploading(true); setPercent(0)
    const xhr = new XMLHttpRequest()
    xhrRef.current = xhr
    xhr.open('POST', `/api/shares?name=${encodeURIComponent(file.name)}&expires=${expiry}`)
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setPercent(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      setUploading(false); xhrRef.current = null
      if (xhr.status >= 200 && xhr.status < 300) { setPercent(100); load(); setOpen(true) }
      else {
        try { setError(JSON.parse(xhr.responseText)?.error || `Upload failed (${xhr.status}).`) }
        catch { setError(`Upload failed (${xhr.status}).`) }
      }
    }
    xhr.onerror = () => { setUploading(false); xhrRef.current = null; setError('Upload failed — connection lost.') }
    xhr.onabort = () => { setUploading(false); xhrRef.current = null }
    xhr.send(file)
  }

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? Anyone holding the link will immediately lose access.`)) return
    try {
      const res = await fetch(`/api/shares/${id}`, { method: 'DELETE' })
      if (!res.ok) { setError('Could not delete that share.'); return }
      load()
    } catch { setError('Could not delete that share.') }
  }

  const copyLink = async (id: string) => {
    const link = `${window.location.origin}/s/${id}`
    try {
      await navigator.clipboard.writeText(link)
      setCopied(id)
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1800)
    } catch {
      window.prompt('Copy this link:', link)
    }
  }

  return (
    <section className="panel p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="pixel-head text-xs font-bold uppercase tracking-[0.24em]">Shared Files</h3>
        {quota > 0 && (
          <span className="text-[10px] text-text-muted tabular-nums">
            {formatSize(used)} / {formatSize(quota)}
          </span>
        )}
      </div>

      <p className="text-xs text-text-muted">
        Upload a video to get a public link. Anyone with that link can download it — they
        can&apos;t reach anything else on this site.
      </p>

      {!uploading ? (
        <div className="flex gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="flex-1 h-10 px-4 raised text-sm transition-colors flex items-center justify-center gap-2"
          >
            <UploadCloud size={16} />
            Upload a video
          </button>
          <select
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="inset-field h-10 px-2 text-xs"
            title="How long the link stays alive"
          >
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="never">Never</option>
          </select>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="tbar-track relative h-3 w-full overflow-hidden">
            <div className="absolute inset-y-0 left-0 tbar-fill text-[#5a9ee8] transition-all duration-200" style={{ width: `${percent}%` }} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary tabular-nums">Uploading… {percent}%</span>
            <button
              onClick={() => xhrRef.current?.abort()}
              className="text-[10px] uppercase tracking-wider text-text-muted hover:text-danger transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }}
      />

      {shares.length > 0 && (
        <div className="space-y-2 pt-1">
          {shares.map((s) => (
            <div key={s.id} className="panel p-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-text-primary truncate">{s.name}</p>
                <p className="text-[10px] text-text-muted mt-0.5 tabular-nums">
                  {formatSize(s.size)} · {s.downloads} download{s.downloads === 1 ? '' : 's'}
                  {s.expiresAt ? ` · until ${new Date(s.expiresAt).toLocaleDateString()}` : ' · no expiry'}
                </p>
              </div>
              <button
                onClick={() => copyLink(s.id)}
                className="h-9 w-9 grid place-items-center raised transition-colors"
                title="Copy public link"
                aria-label="Copy public link"
              >
                {copied === s.id ? <Check size={14} /> : <LinkIcon size={14} />}
              </button>
              <button
                onClick={() => remove(s.id, s.name)}
                className="h-9 w-9 grid place-items-center raised transition-colors"
                title="Delete share"
                aria-label="Delete share"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
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
