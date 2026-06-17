import { NextResponse } from 'next/server'
import { diskStats, downloadsDirBytes, reclaimDiskSpace } from '@/lib/downloads'
import { photosDirBytes, reclaimPhotoSpace } from '@/lib/photos'

export const dynamic = 'force-dynamic'

// POST /api/disk/clear — free space by deleting ONLY Grabber's completed/
// orphaned downloads + photos. Both reclaim functions are hard-scoped to
// their /tmp/grabber-* dirs, skip cookies.txt, and skip in-progress jobs.
// Nothing outside those temp dirs is ever touched.
export async function POST() {
  const freedDownloads = reclaimDiskSpace()
  const freedPhotos = reclaimPhotoSpace()
  const stats = diskStats()
  const grabberBytes = downloadsDirBytes() + photosDirBytes()
  return NextResponse.json({
    freedBytes: freedDownloads + freedPhotos,
    available: !!stats,
    totalBytes: stats?.totalBytes ?? 0,
    freeBytes: stats?.freeBytes ?? 0,
    grabberBytes,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
