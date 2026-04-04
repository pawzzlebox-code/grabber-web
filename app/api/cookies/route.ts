import { NextRequest, NextResponse } from 'next/server'
import { saveCookies } from '@/lib/downloads'

const COOKIE_SECRET = process.env.COOKIE_SECRET || ''

export async function POST(req: NextRequest) {
  try {
    // Require API key if COOKIE_SECRET is set on server
    if (COOKIE_SECRET) {
      const key = req.headers.get('x-cookie-key')
      if (key !== COOKIE_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    }

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
