import { NextRequest, NextResponse } from 'next/server'
import { startDownloadWithCookies } from '@/lib/downloads'
import { v4 as uuid } from 'uuid'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { url, cookies } = body

    if (!url) {
      return NextResponse.json({ error: 'Missing url' }, { status: 400, headers: corsHeaders })
    }

    const id = uuid()
    startDownloadWithCookies(id, url, cookies)

    return NextResponse.json({ id }, { headers: corsHeaders })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed' }, { status: 500, headers: corsHeaders })
  }
}
