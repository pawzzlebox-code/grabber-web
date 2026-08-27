// PUBLIC download endpoint — reachable without the site token.
//
// The unguessable 32-hex id in the URL is the only credential. An id that
// doesn't match returns a bare 404, so a wrong or revoked link is
// indistinguishable from one that never existed.
//
// Range requests are honoured so a dropped transfer resumes instead of
// restarting — the link to this server is slow enough that restarting a
// half-finished multi-hundred-MB download is genuinely painful.
//
// Responses are explicitly NOT cacheable: you can revoke a share at any time,
// and an edge-cached copy would keep serving a file you deleted.

import { NextRequest } from 'next/server'
import fs from 'fs'
import { getShare, sharePath, recordDownload } from '@/lib/shares'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const share = getShare(params.id)
  if (!share) return new Response('Not found', { status: 404 })

  const filePath = sharePath(share)
  if (!fs.existsSync(filePath)) return new Response('Not found', { status: 404 })

  const total = fs.statSync(filePath).size
  const range = req.headers.get('range')
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(share.name)}`

  const baseHeaders: Record<string, string> = {
    'Content-Type': share.mime,
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store, must-revalidate',
  }

  let start = 0
  let end = total - 1
  let status = 200

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      if (m[1]) start = parseInt(m[1], 10)
      if (m[2]) end = parseInt(m[2], 10)
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        return new Response('Range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        })
      }
      status = 206
      baseHeaders['Content-Range'] = `bytes ${start}-${end}/${total}`
    }
  }

  // Only count a download when the whole file is requested from the start,
  // so a browser probing with a range request doesn't inflate the counter.
  if (status === 200) recordDownload(share.id)

  const nodeStream = fs.createReadStream(filePath, { start, end })
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(chunk))
      nodeStream.on('end', () => controller.close())
      nodeStream.on('error', (err) => controller.error(err))
    },
    cancel() { nodeStream.destroy() },
  })

  return new Response(webStream, {
    status,
    headers: { ...baseHeaders, 'Content-Length': String(end - start + 1) },
  })
}
