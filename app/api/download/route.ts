import { NextRequest, NextResponse } from 'next/server'
import { startDownload } from '@/lib/downloads'
import { v4 as uuid } from 'uuid'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { url, formatId, title, thumbnail, playlistIndex, verticalPad, duration } = body

    if (!url) {
      return NextResponse.json({ error: 'Missing url' }, { status: 400 })
    }

    const id = uuid()
    startDownload(id, url, formatId, title, thumbnail, playlistIndex, verticalPad, duration)

    return NextResponse.json({ id })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to start download' }, { status: 500 })
  }
}
