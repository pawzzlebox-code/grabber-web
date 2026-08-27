// Delete a file from the server (owner-only). Removes the blob and the index
// entry, so any share link pointing at it stops working immediately.

import { NextRequest, NextResponse } from 'next/server'
import { deleteItem } from '@/lib/gallery'

export const dynamic = 'force-dynamic'

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const ok = deleteItem(params.id)
  if (!ok) return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
