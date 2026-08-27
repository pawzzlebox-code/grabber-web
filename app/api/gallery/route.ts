// Owner-only: what's currently sitting on the server.
//
// Behind the Cloudflare token gate. Only the /s/ routes are public, so a
// recipient with one share link can never enumerate anything else here.

import { NextResponse } from 'next/server'
import { listGallery, galleryBytes, RETENTION_MS } from '@/lib/gallery'
import { diskStats } from '@/lib/downloads'

export const dynamic = 'force-dynamic'

export async function GET() {
  const stats = diskStats()
  return NextResponse.json({
    items: listGallery(),
    usedBytes: galleryBytes(),
    retentionMs: RETENTION_MS,
    freeBytes: stats?.freeBytes ?? 0,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
