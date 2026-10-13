import { NextRequest } from 'next/server'
import { getPhotoJob } from '@/lib/photos'
import fs from 'fs'
import path from 'path'

function mime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const m: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  }
  return m[ext] || 'application/octet-stream'
}

// ?v=thumb — the 32px square preview; ?v=poster — a video's frame (both JPEG,
// made in lib/photos.ts prepareFile). No ?v — the file itself.
export async function GET(req: NextRequest, { params }: { params: { id: string; index: string } }) {
  const job = getPhotoJob(params.id)
  if (!job) return new Response('Not found', { status: 404 })
  const idx = parseInt(params.index, 10)
  const file = job.files[idx]
  if (!file) return new Response('File not found', { status: 404 })
  const variant = req.nextUrl.searchParams.get('v')
  const filePath = variant === 'thumb' ? file.thumbPath
    : variant === 'poster' ? file.posterPath
    : file.fullPath
  if (!filePath || !fs.existsSync(filePath)) return new Response('File not found', { status: 404 })

  const stat = fs.statSync(filePath)
  const stream = fs.createReadStream(filePath)
  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => controller.enqueue(chunk))
      stream.on('end', () => controller.close())
      stream.on('error', (err) => controller.error(err))
    },
    cancel() { stream.destroy() },
  })

  return new Response(webStream, {
    headers: {
      'Content-Type': mime(filePath),
      'Content-Length': String(stat.size),
      // No download header — we want inline so the browser can use the bytes
      // for navigator.share without forcing a separate save dialog.
    },
  })
}
