import { NextRequest } from 'next/server'
import { getDownload } from '@/lib/downloads'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const job = getDownload(params.id)
  if (!job) {
    return new Response('Not found', { status: 404 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      // Send a 2KB padding comment first — defeats Cloudflare's buffering threshold
      // Many proxies buffer the first ~1KB of a streamed response before flushing
      const padding = ':' + ' '.repeat(2048) + '\n\n'
      controller.enqueue(encoder.encode(padding))

      const sendEvent = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      // Send initial state
      sendEvent({
        type: job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : 'progress',
        percent: job.percent,
        speed: job.speed,
        eta: job.eta,
        totalSize: job.totalSize,
        fileName: job.fileName,
        message: job.error,
      })

      // If already done or errored, close
      if (job.status === 'done' || job.status === 'error') {
        controller.close()
        return
      }

      // Keepalive ping every 2 seconds — forces stream flush through proxies
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(':ping\n\n'))
        } catch {
          clearInterval(keepalive)
        }
      }, 2000)

      // Listen for updates
      const listener = (data: any) => {
        try {
          sendEvent(data)
          if (data.type === 'done' || data.type === 'error') {
            clearInterval(keepalive)
            job.listeners.delete(listener)
            controller.close()
          }
        } catch {
          clearInterval(keepalive)
          job.listeners.delete(listener)
        }
      }

      job.listeners.add(listener)

      // Cleanup on abort
      req.signal.addEventListener('abort', () => {
        clearInterval(keepalive)
        job.listeners.delete(listener)
      })
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx
      'Content-Encoding': 'identity', // disable gzip buffering
    },
  })
}
