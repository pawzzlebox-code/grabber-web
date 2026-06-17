import { NextResponse } from 'next/server'
import { diskStats, downloadsDirBytes } from '@/lib/downloads'
import { photosDirBytes } from '@/lib/photos'

export const dynamic = 'force-dynamic'

// GET /api/disk — server disk usage. grabberBytes is the part the Clear
// button can actually free (downloads + photos temp dirs only).
export async function GET() {
  const stats = diskStats()
  const grabberBytes = downloadsDirBytes() + photosDirBytes()
  if (!stats) {
    return NextResponse.json({ available: false }, { headers: { 'Cache-Control': 'no-store' } })
  }
  return NextResponse.json({
    available: true,
    totalBytes: stats.totalBytes,
    freeBytes: stats.freeBytes,
    grabberBytes,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// POST /api/disk/clear handled in ./clear/route.ts — kept separate so the
// destructive action has its own path.
