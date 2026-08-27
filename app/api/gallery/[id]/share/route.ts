// Promote a file to a public share (POST), or revoke the link (DELETE).
//
// Sharing moves the file out of the temp directory and clears its expiry, so
// a link you handed out can't be deleted by the 24h sweeper. Revoking puts it
// back on the 24h clock without deleting anything.

import { NextRequest, NextResponse } from 'next/server'
import { shareItem, unshareItem } from '@/lib/gallery'

export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const item = shareItem(params.id)
  if (!item || !item.shareToken) {
    return NextResponse.json({ error: 'That file is no longer on the server.' }, { status: 404 })
  }
  return NextResponse.json({ token: item.shareToken, path: `/s/${item.shareToken}` }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const ok = unshareItem(params.id)
  if (!ok) return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
