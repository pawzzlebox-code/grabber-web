// PUBLIC share page — the only screen someone without the site token can see.
//
// Filename, size, download button. No app UI, no links back into the site, no
// way to discover other files. A missing, revoked or expired token renders the
// same "link isn't valid" page as a made-up one.

import { getByShareToken } from '@/lib/gallery'

export const dynamic = 'force-dynamic'

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

export default function SharePage({ params }: { params: { id: string } }) {
  const item = getByShareToken(params.id)

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="app-shell w-full max-w-md p-6 space-y-5">
        <div className="text-center">
          <p className="pixel-head text-sm font-bold uppercase tracking-[0.24em]">Grabber</p>
          <p className="text-[10px] uppercase tracking-[0.18em] text-[#d3d7de] mt-1">Shared file</p>
        </div>

        {!item ? (
          <div className="panel p-5 text-center space-y-2">
            <p className="text-sm font-semibold text-text-primary">This link isn&apos;t valid</p>
            <p className="text-xs text-text-muted">
              It may have been deleted, revoked, or typed incorrectly.
            </p>
          </div>
        ) : (
          <>
            <div className="panel overflow-hidden">
              {item.thumbnail && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={item.thumbnail} alt="" className="w-full h-40 object-cover border-b-2 border-subtle" />
              )}
              <div className="p-4 space-y-1">
                <p className="text-sm font-semibold text-text-primary break-words">{item.title}</p>
                <p className="text-xs text-text-muted">{formatSize(item.size)}</p>
              </div>
            </div>

            <a
              href={`/s/${item.shareToken}/file`}
              className="raised w-full h-11 px-4 text-sm flex items-center justify-center gap-2 no-underline"
            >
              ▼ Download
            </a>

            <p className="text-[10px] text-center text-[#aebfd8] leading-relaxed">
              Large files can take a while. If the download stops partway,
              your browser can usually resume it.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
