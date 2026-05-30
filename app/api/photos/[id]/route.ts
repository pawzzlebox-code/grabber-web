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
    files: job.files.map((f, i) => ({
      index: i,
      name: f.name,
      size: f.size,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  cancelPhotoJob(params.id)
  return NextResponse.json({ ok: true })
}
