import { NextRequest, NextResponse } from 'next/server'
import { startDownloadWithCookies } from '@/lib/downloads'
import { v4 as uuid } from 'uuid'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { url, cookies } = body

    if (!url) {
      return NextResponse.json({ error: 'Missing url' }, { status: 400 })
    }

    const id = uuid()
    startDownloadWithCookies(id, url, cookies)

    return NextResponse.json({ id })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed' }, { status: 500 })
  }
}
