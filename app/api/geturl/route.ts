import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'

// Returns the direct video URL so the browser can download it itself,
// bypassing the server (faster, saves server bandwidth).
export async function POST(req: NextRequest) {
  try {
    const { url, formatId } = await req.json()
    if (!url) {
      return NextResponse.json({ error: 'Missing url' }, { status: 400 })
    }

    const args = ['--get-url', '--no-playlist']
    if (formatId) args.push('-f', formatId)
    args.push(url)

    const directUrl = await new Promise<string>((resolve, reject) => {
      const proc = spawn('yt-dlp', args)
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      const timeout = setTimeout(() => { proc.kill(); reject(new Error('Timeout')) }, 30000)
      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) {
          // yt-dlp may output multiple URLs (one per format) — first is best
          resolve(stdout.trim().split('\n')[0])
        } else {
          reject(new Error(stderr.split('\n').filter(l => l.includes('ERROR')).pop() || 'Failed'))
        }
      })
    })

    return NextResponse.json({ url: directUrl })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed' }, { status: 500 })
  }
}
