import { NextRequest, NextResponse } from 'next/server'
import { getPhotoJob, cancelPhotoJob } from '@/lib/photos'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const job = getPhotoJob(params.id)
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({
    id: job.id,
    status: job.status,
    error: job.error,
    author: job.author,
    site: job.site,
    expected: job.expected,
    files: job.files.map((f, i) => ({
      index: i,
      name: f.name,
      size: f.size,
      kind: f.kind,
      codec: f.codec,
      duration: f.duration,
      thumb: !!f.thumbPath,
      poster: !!f.posterPath,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  cancelPhotoJob(params.id)
  return NextResponse.json({ ok: true })
}
