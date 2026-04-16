import { NextResponse } from 'next/server'
import { cancelDownload } from '@/lib/downloads'

export const dynamic = 'force-dynamic'

// Cancel an in-flight download: kills the child process, deletes the output
// file from disk, removes the job from the registry. Idempotent.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    cancelDownload(params.id)
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Cancel failed' }, { status: 500 })
  }
}
