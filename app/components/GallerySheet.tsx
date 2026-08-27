'use client'

// Gallery — everything currently on the server, as a slide-up sheet.
//
// Finished downloads stay for 24 hours, so this doubles as "what can I still
// do something with". Tapping Share promotes a file to permanent and hands
// back a public link; the file is already on the server, so the link is live
// instantly — no upload, which matters when the uplink runs at ~0.5 MB/s.

import { useCallback, useEffect, useState } from 'react'
import { X, Link as LinkIcon, Check, Trash2, Loader, ImageOff } from 'lucide-react'

interface GalleryItem {
  id: string
  title: string
  thumbnail: string
  fileName: string
  size: number
  createdAt: number
  expiresAt: number | null
  shareToken: string | null
  downloads: number
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

/** "expires in 5h" / "expires in 40m" — how long you've still got to act. */
function expiryLabel(expiresAt: number | null): string {
  if (expiresAt === null) return 'Kept until you delete it'
  const left = expiresAt - Date.now()
  if (left <= 0) return 'Expiring now'
  const hours = Math.floor(left / 3600_000)
  if (hours >= 1) return `Expires in ${hours}h`
  return `Expires in ${Math.max(1, Math.round(left / 60_000))}m`
}

export default function GallerySheet({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [used, setUsed] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/gallery', { cache: 'no-store' })
      if (!res.ok) throw new Error(`Could not load the gallery (${res.status}).`)
      const data = await res.json()
      setItems(data.items || [])
      setUsed(data.usedBytes || 0)
    } catch (err: any) {
      setError(err?.message || 'Could not load the gallery.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const share = async (item: GalleryItem) => {
    setBusyId(item.id); setError('')
    try {
      // Already shared → just copy the existing link again.
      const token = item.shareToken || (await (async () => {
        const res = await fetch(`/api/gallery/${item.id}/share`, { method: 'POST' })
        const data = await res.json().catch(() => ({} as any))
        if (!res.ok) throw new Error(data?.error || 'Could not create a link.')
        return data.token as string
      })())

      const link = `${window.location.origin}/s/${token}`
      try {
        await navigator.clipboard.writeText(link)
        setCopied(item.id)
        setTimeout(() => setCopied((c) => (c === item.id ? null : c)), 1800)
      } catch {
        window.prompt('Copy this link:', link)
      }
      load()
    } catch (err: any) {
      setError(err?.message || 'Could not create a link.')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (item: GalleryItem) => {
    const warning = item.shareToken
      ? `Delete "${item.title}"? Anyone holding the link will immediately lose access.`
      : `Delete "${item.title}" from the server?`
    if (!confirm(warning)) return
    setBusyId(item.id)
    try {
      const res = await fetch(`/api/gallery/${item.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Could not delete that file.')
      load()
    } catch (err: any) {
      setError(err?.message || 'Could not delete that file.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-backdrop-in" onClick={onClose} />
      <div
        className="absolute bottom-0 inset-x-0 mx-auto w-full max-w-lg sheet-panel max-h-[85vh] overflow-y-auto overscroll-contain px-4 pt-2 space-y-4 animate-sheet-up"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto h-1.5 w-10 bg-surface-2 border border-subtle" />

        <div className="flex items-center justify-between">
          <p className="pixel-head text-xs font-bold uppercase tracking-[0.24em]">Gallery</p>
          <span className="text-[10px] text-text-muted tabular-nums">
            {items.length} file{items.length === 1 ? '' : 's'} · {formatSize(used)}
          </span>
        </div>

        <p className="text-xs text-text-muted">
          Files on the server. Downloads are kept for 24 hours — share one and it stays
          until you delete it.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-text-secondary py-6 justify-center">
            <Loader size={14} className="animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <p className="text-xs text-text-muted text-center py-6">
            Nothing on the server right now. Downloads show up here automatically.
          </p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.id} className="panel p-2 flex items-center gap-3">
                <div className="w-20 h-12 flex-shrink-0 border-2 border-subtle bg-surface-2 grid place-items-center overflow-hidden">
                  {item.thumbnail
                    /* eslint-disable-next-line @next/next/no-img-element */
                    ? <img src={item.thumbnail} alt="" className="w-full h-full object-cover" />
                    : <ImageOff size={14} className="text-text-muted" />}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-text-primary truncate">{item.title}</p>
                  <p className="text-[10px] text-text-muted mt-0.5 tabular-nums">
                    {formatSize(item.size)} · {expiryLabel(item.expiresAt)}
                    {item.shareToken ? ` · ${item.downloads} download${item.downloads === 1 ? '' : 's'}` : ''}
                  </p>
                </div>

                <button
                  onClick={() => share(item)}
                  disabled={busyId === item.id}
                  className={`h-9 px-2.5 grid place-items-center transition-colors ${item.shareToken ? 'raised-sel' : 'raised'}`}
                  title={item.shareToken ? 'Copy public link' : 'Create a public link'}
                  aria-label={item.shareToken ? 'Copy public link' : 'Create a public link'}
                >
                  {busyId === item.id
                    ? <Loader size={14} className="animate-spin" />
                    : copied === item.id ? <Check size={14} /> : <LinkIcon size={14} />}
                </button>

                <button
                  onClick={() => remove(item)}
                  disabled={busyId === item.id}
                  className="h-9 px-2.5 grid place-items-center raised transition-colors"
                  title="Delete from server"
                  aria-label="Delete from server"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <p className="text-xs font-semibold text-danger">{error}</p>}

        <button onClick={onClose} className="w-full h-10 raised text-sm flex items-center justify-center gap-2">
          <X size={16} /> Close
        </button>
      </div>
    </div>
  )
}
