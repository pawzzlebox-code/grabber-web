import { NextRequest, NextResponse } from 'next/server'
import { startPhotoJob } from '@/lib/photos'
import { v4 as uuid } from 'uuid'

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json()
    if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 })
    const id = uuid()
    startPhotoJob(id, url)
    return NextResponse.json({ id })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed' }, { status: 500 })
  }
}
