import { NextRequest } from 'next/server'
import { getDownload } from '@/lib/downloads'
import fs from 'fs'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const job = getDownload(params.id)

  if (!job || job.status !== 'done' || !job.filePath) {
    return new Response('Not found', { status: 404 })
  }

  if (!fs.existsSync(job.filePath)) {
    return new Response('File not found', { status: 404 })
  }

  const stat = fs.statSync(job.filePath)
  const stream = fs.createReadStream(job.filePath)
  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => controller.enqueue(chunk))
      stream.on('end', () => controller.close())
      stream.on('error', (err) => controller.error(err))
    },
    cancel() {
      stream.destroy()
    }
  })

  const fileName = job.fileName || 'download'

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
      'Content-Length': String(stat.size),
    },
  })
}
