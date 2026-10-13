'use client'

// A gallery-dl job (carousel, photo post, album) as an ordinary download card.
// Its banner is a contact sheet: one tile per item, each a small progressive
// scan — static while queued, the item's 32px preview scanning in while the
// phone pulls the file, then the real picture. Videos iOS Photos would refuse
// carry a codec tag until the phone has re-encoded them. Every item starts
// ticked; the save button sends only the ticked ones.

import { useEffect, useState } from 'react'
import { X, Download } from 'lucide-react'
import { noiseTile } from '@/lib/scan-noise'

export interface PhotoFile {
  index: number
  name: string
  size: number
  kind?: 'photo' | 'video'
  codec?: string
  duration?: number
  thumb?: boolean
  poster?: boolean
}

export type PhotoItemState = 'arriving' | 'raw' | 'converting' | 'ready' | 'failed'
export interface PhotoItem { state: PhotoItemState; pct: number; stage?: string }

export interface PhotoCardJob {
  id: string
  url: string
  status: 'downloading' | 'done' | 'error'
  files: PhotoFile[]
  error?: string
  author?: string
  site?: string
  expected?: number
  // Every item pulled and processed — Save can fire synchronously.
  ready?: boolean
}

const SITE_NAMES: Record<string, string> = {
  instagram: 'Instagram', twitter: 'X', reddit: 'Reddit', pixiv: 'Pixiv',
  tumblr: 'Tumblr', imgur: 'Imgur', pinterest: 'Pinterest', facebook: 'Facebook',
}

function siteName(job: PhotoCardJob): string {
  if (job.site) return SITE_NAMES[job.site] || job.site.charAt(0).toUpperCase() + job.site.slice(1)
  try { return new URL(job.url).hostname.replace(/^www\./, '') } catch { return 'Post' }
}

// "Instagram post", or "Image link" for a pasted image URL (gallery-dl's
// directlink extractor), which isn't a post on any site.
function postLabel(job: PhotoCardJob): string {
  return job.site === 'directlink' ? 'Image link' : `${siteName(job)} post`
}

function clock(seconds?: number): string {
  if (!seconds || !isFinite(seconds)) return ''
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const pad3 = (n: number) => `${String(Math.round(Math.min(100, Math.max(0, n)))).padStart(3, '0')}%`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// Rows in the 32px preview: the reveal steps one row at a time.
const THUMB_ROWS = 32

function Tile({ jobId, file, item, willConvert, ticked, src, wide, noise, onToggle }: {
  jobId: string
  file?: PhotoFile
  item?: PhotoItem
  willConvert: boolean
  ticked: boolean
  // The pulled photo itself (an object URL); videos use their server poster.
  src?: string
  wide: boolean
  noise: string
  onToggle: () => void
}) {
  const state = file && item ? item.state : 'queued'
  const isVideo = file?.kind === 'video'
  const base = file ? `/api/photos/${jobId}/file/${file.index}` : ''
  const thumb = file?.thumb ? `${base}?v=thumb` : undefined
  const poster = file?.poster ? `${base}?v=poster` : undefined
  const crisp = isVideo ? poster : src
  const rows = item ? Math.floor((Math.min(100, item.pct) / 100) * THUMB_ROWS) : 0
  const rowP = (rows / THUMB_ROWS) * 100

  const gray = isVideo && willConvert && (state === 'raw' || state === 'converting')
  const scanning = state === 'arriving' || state === 'converting'
  const showThumb = !!thumb && (scanning || state === 'failed')
  const showCrisp = !!crisp && (state === 'ready' || (state === 'raw' && !gray))

  let chip = '', chipClass = ''
  if (scanning) chip = pad3(item!.pct)
  else if (gray) { chip = (file?.codec || 'video').toUpperCase(); chipClass = ' ptile-codec' }
  else if (state === 'failed') { chip = 'Lost'; chipClass = ' ptile-bad' }

  return (
    <div className={`ptile${wide ? ' ptile-wide' : ''}${state === 'ready' && !ticked ? ' ptile-off' : ''}`}>
      <div className="scan-layer scan-noise" style={noise ? { backgroundImage: `url(${noise})` } : undefined} />
      {gray && thumb && <img src={thumb} alt="" className="scan-layer scan-gray" />}
      {gray && <div className="scan-layer scan-dither" />}
      {showThumb && (
        <img
          src={thumb}
          alt=""
          className={`scan-layer${state === 'failed' ? ' scan-glitch' : ''}`}
          style={scanning ? { clipPath: `inset(0 0 ${100 - rowP}% 0)` } : undefined}
        />
      )}
      {scanning && rowP < 100 && <div className={`scan-hline${state === 'converting' ? ' scan-accent' : ''}`} style={{ top: `${rowP}%` }} />}
      {showCrisp && <img src={crisp} alt="" className="scan-layer scan-hires" />}
      {showCrisp && <div className="scan-layer scan-flash" />}
      {state === 'failed' && <div className="scan-layer scan-tint scan-bad" />}
      {chip && <span className={`ptile-badge ptile-tl${chipClass}`}>{chip}</span>}
      {isVideo && state !== 'queued' && state !== 'arriving' && (
        <span className="ptile-badge ptile-br">▶{file?.duration ? ` ${clock(file.duration)}` : ''}</span>
      )}
      {state === 'ready' && (
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={ticked}
          aria-label={`${ticked ? 'Untick' : 'Tick'} item ${(file?.index ?? 0) + 1}`}
          className={`cb-box ptile-check${ticked ? ' is-on' : ''}`}
        />
      )}
    </div>
  )
}

export default function PhotoCard({ job, items, unticked, willConvert, srcFor, canSavePhotos, onToggle, onSave, onDownload, onRemove }: {
  job: PhotoCardJob
  items: Record<number, PhotoItem>
  unticked: number[]
  willConvert: (f: PhotoFile) => boolean
  srcFor: (index: number) => string | undefined
  // iOS with file sharing: the share sheet is the way into Photos.
  canSavePhotos: boolean
  onToggle: (index: number) => void
  onSave: () => void
  onDownload: () => void
  onRemove: () => void
}) {
  const [noise, setNoise] = useState('')
  useEffect(() => { setNoise(noiseTile()) }, [])

  const off = new Set(unticked)
  // While gallery-dl is still listing, the post's own count sizes the sheet.
  const total = job.status === 'downloading'
    ? Math.max(job.files.length, job.expected || 0, 1)
    : Math.max(job.files.length, 1)
  const cols = total === 1 ? 1 : total === 2 ? 2 : 3

  const photos = job.files.filter(f => f.kind !== 'video').length
  const videos = job.files.length - photos
  const counts = [photos ? plural(photos, 'photo', 'photos') : '', videos ? plural(videos, 'video', 'videos') : '']
    .filter(Boolean).join(', ')

  let done = 0, arriving = 0, failed = 0, readyN = 0
  for (const f of job.files) {
    const it = items[f.index]
    if (!it) continue
    if (it.state === 'arriving') arriving += it.pct / 100
    else done++
    if (it.state === 'failed') failed++
    if (it.state === 'ready') readyN++
  }
  const toConvert = job.files.filter(willConvert)
  const converting = toConvert.find(f => items[f.index]?.state === 'converting')
  const selected = job.files.filter(f => items[f.index]?.state === 'ready' && !off.has(f.index))
  const sizeMB = job.files.reduce((n, f) => n + f.size, 0) / 1e6
  const nothingYet = job.status === 'error' && job.files.length === 0

  let stats: { text: string; bad?: boolean }[]
  if (nothingYet) {
    stats = [{ text: `Failed — ${job.error || 'nothing found'}`, bad: true }]
  } else if (converting) {
    const it = items[converting.index]
    stats = [
      { text: `Converting video ${toConvert.indexOf(converting) + 1} of ${toConvert.length}… ${Math.round(it.pct)}%` },
      ...(it.stage ? [{ text: it.stage }] : []),
    ]
  } else if (!job.ready) {
    const pct = ((done + arriving) / total) * 100
    stats = [{ text: `Downloading… ${Math.round(pct)}%` }, { text: `${done} of ${total}` }]
  } else {
    stats = [
      { text: `${readyN} ready` },
      { text: `${sizeMB.toFixed(1)} MB` },
      ...(failed ? [{ text: `${failed} failed`, bad: true }] : []),
      ...(selected.length < readyN ? [{ text: `${selected.length} ticked` }] : []),
    ]
  }
  if (job.status === 'error' && !nothingYet && job.error) stats.push({ text: job.error, bad: true })

  const busy = !job.ready && !nothingYet
  const title = `${job.author || postLabel(job)} · ${plural(total, 'item', 'items')}`
  const sub = job.author ? [postLabel(job), counts].filter(Boolean).join(' · ') : counts

  return (
    <div className="panel p-3 animate-fade-in">
      <div className="psheet" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {Array.from({ length: total }, (_, i) => {
          const file = job.files[i]
          return (
            <Tile
              key={i}
              jobId={job.id}
              file={file}
              item={file ? items[file.index] : undefined}
              willConvert={!!file && willConvert(file)}
              ticked={!file || !off.has(file.index)}
              src={file ? srcFor(file.index) : undefined}
              wide={total === 1}
              noise={noise}
              onToggle={() => file && onToggle(file.index)}
            />
          )
        })}
      </div>

      <div className="mt-3 flex gap-3 items-start">
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-normal text-text-secondary truncate">{title}</p>
            <button
              onClick={onRemove}
              className="h-8 w-8 mr-1 grid place-items-center rounded-md text-text-muted hover:text-danger hover:bg-danger/10 transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
              title={busy ? 'Cancel' : 'Remove from list'}
              aria-label={busy ? 'Cancel' : 'Remove from list'}
            >
              <X size={16} />
            </button>
          </div>
          {sub && <p className={`text-xs mt-1 ${job.ready ? 'text-text-secondary' : 'text-text-muted'}`}>{sub}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-xs text-text-muted font-mono">
            {stats.map((s, i) => (
              <span key={i} className={s.bad ? 'text-danger' : i === 0 ? 'text-text-secondary' : ''}>{s.text}</span>
            ))}
          </div>
        </div>
      </div>

      {job.ready && readyN > 0 && (canSavePhotos ? (
        <div className="mt-3 flex gap-2">
          <button
            onClick={onSave}
            disabled={selected.length === 0}
            className="flex-1 h-10 px-4 raised text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {selected.length === 0 ? 'Nothing ticked' : `Save ${selected.length === readyN ? 'all ' : ''}${selected.length} to Photos`}
          </button>
          <button
            onClick={onDownload}
            disabled={selected.length === 0}
            className="h-10 w-10 grid place-items-center raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            title="Save files"
            aria-label="Save files"
          >
            <Download size={16} />
          </button>
        </div>
      ) : (
        <button
          onClick={onDownload}
          disabled={selected.length === 0}
          className="mt-3 w-full h-10 px-4 raised text-sm transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <Download size={16} />
          {selected.length === 0 ? 'Nothing ticked' : `Download ${selected.length === readyN ? 'all ' : ''}${selected.length}`}
        </button>
      ))}
    </div>
  )
}
