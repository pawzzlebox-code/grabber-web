// Registry of the currently-online Grabber desktop app. The desktop registers
// its cloudflared tunnel URL here on startup; the web UI (iPhone or otherwise)
// reads this URL and routes downloads through it instead of the droplet —
// turning the user's desktop GPU into a personal encode backend.
//
// Single-tenant by design — this is a personal tool, one owner, one desktop.
// POST is gated by COOKIE_SECRET (same env var the cookie sync endpoint uses)
// so random third parties can't hijack the registration; GET is public (the
// tunnel URL itself is a Cloudflare public URL, nothing secret about it).

import { NextRequest, NextResponse } from 'next/server'

const COOKIE_SECRET = process.env.COOKIE_SECRET || ''
const TTL_MS = 24 * 60 * 60 * 1000

let registered: { url: string; at: number } | null = null

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
    const { tunnelUrl } = await req.json()
    if (!tunnelUrl || typeof tunnelUrl !== 'string') {
      return NextResponse.json({ error: 'tunnelUrl required' }, { status: 400, headers: corsHeaders })
    }
    // Strip trailing slash so clients can concatenate paths safely
    const normalized = tunnelUrl.replace(/\/+$/, '')
    registered = { url: normalized, at: Date.now() }
    console.log('[desktop] registered', normalized)
    return NextResponse.json({ ok: true }, { headers: corsHeaders })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed' }, { status: 500, headers: corsHeaders })
  }
}

export async function GET() {
  if (!registered || Date.now() - registered.at > TTL_MS) {
    return NextResponse.json({ tunnelUrl: null }, { headers: corsHeaders })
  }
  return NextResponse.json({
    tunnelUrl: registered.url,
    ageSeconds: Math.floor((Date.now() - registered.at) / 1000),
  }, { headers: corsHeaders })
}

export async function DELETE(req: NextRequest) {
  if (COOKIE_SECRET) {
    const key = req.headers.get('x-cookie-key')
    if (key !== COOKIE_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
    }
  }
  registered = null
  return NextResponse.json({ ok: true }, { headers: corsHeaders })
}
