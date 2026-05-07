import { NextRequest, NextResponse } from 'next/server'
import { getDownload } from '@/lib/downloads'
import fs from 'fs'

export const dynamic = 'force-dynamic'

// Polling endpoint — returns current job state as plain JSON.
// We use polling instead of SSE because Cloudflare free tunnel
// (trycloudflare.com) buffers streaming responses and drops SSE events.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const job = getDownload(params.id)
  if (!job) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const logsSinceParam = _req.nextUrl.searchParams.get('logsSince')
  const logsSince = logsSinceParam ? parseInt(logsSinceParam) : 0
  const newLogs = job.logs.slice(logsSince)

  // Stat the on-disk file once download is done so the client can decide
  // whether to share-to-Photos (small) or stream-to-Files (large).
  let fileSize: number | undefined
  if (job.status === 'done' && job.filePath) {
    try { fileSize = fs.statSync(job.filePath).size } catch {}
  }

  return NextResponse.json({
    id: job.id,
    status: job.status,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    totalSize: job.totalSize,
    fileName: job.fileName,
    fileSize,
    error: job.error,
    logs: newLogs,
    logsTotal: job.logs.length,
    srt: job.srt,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
