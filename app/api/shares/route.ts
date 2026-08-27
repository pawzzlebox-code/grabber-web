// Owner-only share management: list what's shared, upload a new file.
//
// Sits at /api/shares (plural) — deliberately distinct from the PUBLIC /s/
// routes. Only /s/ is exempted from the Cloudflare token gate, so everything
// here stays private to you.
//
// Uploads stream straight to disk rather than going through formData(): the
// droplet has ~220 MB of RAM free, and buffering a multi-hundred-MB upload
// would take it out.

import { NextRequest, NextResponse } from 'next/server'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import fs from 'fs'
import {
  listShares, newUploadTarget, commitShare, discardUpload,
  totalBytes, MAX_SHARE_BYTES, MAX_TOTAL_BYTES,
} from '@/lib/shares'

export const dynamic = 'force-dynamic'
export const maxDuration = 3600

export async function GET() {
  return NextResponse.json({
    shares: listShares(),
    usedBytes: totalBytes(),
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxFileBytes: MAX_SHARE_BYTES,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const rawName = req.nextUrl.searchParams.get('name') || 'video.mp4'
  const expiresParam = req.nextUrl.searchParams.get('expires') // days, or "never"
  const expiresInDays = expiresParam === 'never' ? null : Math.max(1, parseInt(expiresParam || '7', 10) || 7)

  const declared = parseInt(req.headers.get('content-length') || '0', 10)
  if (declared && declared > MAX_SHARE_BYTES) {
    return NextResponse.json({
      error: `File is ${(declared / 1073741824).toFixed(2)} GB — the per-file limit is ${MAX_SHARE_BYTES / 1073741824} GB.`,
    }, { status: 413 })
  }
  if (declared && totalBytes() + declared > MAX_TOTAL_BYTES) {
    return NextResponse.json({
      error: 'Not enough share space left. Delete an existing share and try again.',
    }, { status: 507 })
  }
  if (!req.body) {
    return NextResponse.json({ error: 'No file was uploaded.' }, { status: 400 })
  }

  const target = newUploadTarget(rawName)

  try {
    // Enforce the cap while streaming too — Content-Length is client-supplied
    // and a truncated or lying header shouldn't let an unbounded write through.
    let written = 0
    let aborted = false
    const source = Readable.fromWeb(req.body as any)
    source.on('data', (chunk: Buffer) => {
      written += chunk.length
      if (written > MAX_SHARE_BYTES && !aborted) {
        aborted = true
        source.destroy(new Error('Upload exceeded the per-file size limit.'))
      }
    })

    await pipeline(source, fs.createWriteStream(target.fullPath))

    const size = fs.statSync(target.fullPath).size
    if (size === 0) {
      discardUpload(target.fullPath)
      return NextResponse.json({ error: 'The uploaded file was empty.' }, { status: 400 })
    }

    const share = commitShare({
      id: target.id,
      storedName: target.storedName,
      rawName,
      size,
      mime: req.headers.get('content-type') || 'video/mp4',
      expiresInDays,
    })

    return NextResponse.json({ share })
  } catch (err: any) {
    discardUpload(target.fullPath)
    console.error('[shares] upload failed:', err?.message)
    return NextResponse.json({ error: err?.message || 'Upload failed.' }, { status: 500 })
  }
}
