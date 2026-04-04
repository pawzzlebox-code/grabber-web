import { NextRequest, NextResponse } from 'next/server'
import { saveCookies } from '@/lib/downloads'

const COOKIE_SECRET = process.env.COOKIE_SECRET || ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-cookie-key',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function POST(req: NextRequest) {
  try {
    if (COOKIE_SECRET) {
      const key = req.headers.get('x-cookie-key')
      if (key !== COOKIE_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
      }
    }

    const { cookies } = await req.json()
    if (!cookies) {
      return NextResponse.json({ error: 'No cookies provided' }, { status: 400, headers: corsHeaders })
    }
    saveCookies(cookies)
    return NextResponse.json({ ok: true }, { headers: corsHeaders })
  } catch {
    return NextResponse.json({ error: 'Failed to save cookies' }, { status: 500, headers: corsHeaders })
  }
}
