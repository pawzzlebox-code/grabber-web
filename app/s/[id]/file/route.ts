// PUBLIC download endpoint — reachable without the site token.
//
// The unguessable 32-hex token in the URL is the only credential. A token that
// doesn't match returns a bare 404, so a wrong, revoked or expired link is
// indistinguishable from one that never existed.
//
// Range requests are honoured so a dropped transfer resumes instead of
// restarting — international throughput here is ~500 KB/s, which makes
// restarting a half-finished download genuinely painful.
//
// Responses are explicitly NOT cacheable: you can revoke or delete a share at
// any time, and an edge-cached copy would keep serving a file you removed.

import { NextRequest } from 'next/server'
import fs from 'fs'
import { getByShareToken, recordShareDownload } from '@/lib/gallery'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const item = getByShareToken(params.id)
  if (!item) return new Response('Not found', { status: 404 })
  if (!fs.existsSync(item.filePath)) return new Response('Not found', { status: 404 })

  const total = fs.statSync(item.filePath).size
  const range = req.headers.get('range')

  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName)}`,
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
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`
    }
  }

  // Count a download only for a full request from the start, so a browser
  // probing with range requests doesn't inflate the counter.
  if (status === 200) recordShareDownload(item.shareToken!)

  const nodeStream = fs.createReadStream(item.filePath, { start, end })
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
    headers: { ...headers, 'Content-Length': String(end - start + 1) },
  })
}
