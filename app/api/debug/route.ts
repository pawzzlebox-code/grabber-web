import { NextResponse } from 'next/server'
import { dumpDebugToTerminal } from '@/lib/downloads'

export const dynamic = 'force-dynamic'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-cookie-key',
  'Cache-Control': 'no-store',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

// GET/POST /api/debug — tapped from the Build number in the UI. Prints a full
// diagnostic block (jobs, errors, tracebacks, proxy, pool, disk) to the
// server terminal (pm2 logs / wherever the server runs) and also returns it as
// JSON so the on-page debug panel can show the same thing.
function handle() {
  const snapshot = dumpDebugToTerminal()
  return NextResponse.json(snapshot, { headers: corsHeaders })
}

export async function GET() {
  return handle()
}

export async function POST() {
  return handle()
}
