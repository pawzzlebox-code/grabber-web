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
      // Send current state immediately
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

      // Listen for updates
      const listener = (data: any) => {
        try {
          sendEvent(data)
          if (data.type === 'done' || data.type === 'error') {
            job.listeners.delete(listener)
            controller.close()
          }
        } catch {
          job.listeners.delete(listener)
        }
      }

      job.listeners.add(listener)

      // Cleanup on abort
      req.signal.addEventListener('abort', () => {
        job.listeners.delete(listener)
      })
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
