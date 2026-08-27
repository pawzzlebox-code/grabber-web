// Revoke a share. Owner-only (behind the token gate) — the public /s/ routes
// have no delete path of any kind.

import { NextRequest, NextResponse } from 'next/server'
import { deleteShare } from '@/lib/shares'

export const dynamic = 'force-dynamic'

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const ok = deleteShare(params.id)
  if (!ok) return NextResponse.json({ error: 'Share not found.' }, { status: 404 })
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
