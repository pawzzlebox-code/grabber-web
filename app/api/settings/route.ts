import { NextRequest, NextResponse } from 'next/server'
import { setCookieBrowser, getCookieBrowser } from '@/lib/downloads'

export async function GET() {
  return NextResponse.json({ cookieBrowser: getCookieBrowser() })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (body.cookieBrowser !== undefined) {
    setCookieBrowser(body.cookieBrowser)
  }
  return NextResponse.json({ cookieBrowser: getCookieBrowser() })
}
