import { NextRequest, NextResponse } from 'next/server'
import { saveCookies } from '@/lib/downloads'

export async function POST(req: NextRequest) {
  try {
    const { cookies } = await req.json()
    if (!cookies) {
      return NextResponse.json({ error: 'No cookies provided' }, { status: 400 })
    }
    saveCookies(cookies)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Failed to save cookies' }, { status: 500 })
  }
}
