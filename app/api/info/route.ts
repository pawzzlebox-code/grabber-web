import { NextRequest, NextResponse } from 'next/server'
import { fetchVideoInfo } from '@/lib/downloads'

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 })
  }

  try {
    const videos = await fetchVideoInfo(url)
    // Return { videos: [...] } for multi-video support
    return NextResponse.json({ videos })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch info' }, { status: 500 })
  }
}
