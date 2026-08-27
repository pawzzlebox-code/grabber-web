// PUBLIC share page — the only screen someone without the site token can see.
//
// It shows a filename, a size and a download button. No app UI, no links back
// into the site, no way to discover other shares. A missing, revoked or
// expired id renders the same "link isn't valid" page as a made-up one.

import { getShare } from '@/lib/shares'

export const dynamic = 'force-dynamic'

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

export default function SharePage({ params }: { params: { id: string } }) {
  const share = getShare(params.id)

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="app-shell w-full max-w-md p-6 space-y-5">
        <div className="text-center">
          <p className="pixel-head text-sm font-bold uppercase tracking-[0.24em]">Grabber</p>
          <p className="text-[10px] uppercase tracking-[0.18em] text-[#d3d7de] mt-1">Shared file</p>
        </div>

        {!share ? (
          <div className="panel p-5 text-center space-y-2">
            <p className="text-sm font-semibold text-text-primary">This link isn&apos;t valid</p>
            <p className="text-xs text-text-muted">
              It may have expired, been deleted, or been typed incorrectly.
            </p>
          </div>
        ) : (
          <>
            <div className="panel p-4 space-y-2">
              <p className="text-sm font-semibold text-text-primary break-all">{share.name}</p>
              <p className="text-xs text-text-muted">
                {formatSize(share.size)}
                {share.expiresAt
                  ? ` · available until ${new Date(share.expiresAt).toLocaleDateString()}`
                  : ''}
              </p>
            </div>

            <a
              href={`/s/${share.id}/file`}
              className="raised w-full h-11 px-4 text-sm flex items-center justify-center gap-2 no-underline"
            >
              ▼ Download
            </a>

            <p className="text-[10px] text-center text-[#aebfd8] leading-relaxed">
              Downloading may take a while on slow connections. If it stops partway,
              your browser can usually resume it.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
