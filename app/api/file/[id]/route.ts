import { NextRequest } from 'next/server'
import { getDownload } from '@/lib/downloads'
import fs from 'fs'
import path from 'path'

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.webm': 'video/webm',
  }
  return mimes[ext] || 'application/octet-stream'
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const job = getDownload(params.id)

  if (!job || job.status !== 'done' || !job.filePath) {
    return new Response('Not found', { status: 404 })
  }

  if (!fs.existsSync(job.filePath)) {
    return new Response('File not found', { status: 404 })
  }

  const stat = fs.statSync(job.filePath)
  const fileName = job.fileName || 'download'
  const inline = req.nextUrl.searchParams.get('inline') === '1'
  const mime = inline ? getMimeType(job.filePath) : 'application/octet-stream'
  const disposition = inline ? 'inline' : `attachment; filename="${encodeURIComponent(fileName)}"`

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

  return new Response(webStream, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': disposition,
      'Content-Length': String(stat.size),
    },
  })
}
