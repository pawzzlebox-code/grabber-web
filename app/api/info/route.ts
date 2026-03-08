import { NextRequest, NextResponse } from 'next/server'
import { fetchVideoInfo } from '@/lib/downloads'

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 })
  }

  try {
    const info = await fetchVideoInfo(url)
    return NextResponse.json(info)
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch info' }, { status: 500 })
  }
}
