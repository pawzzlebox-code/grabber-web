// Transcribe an audio clip to SRT via Groq Whisper.
//
// Used by the Upload & Process panel: the browser extracts just the audio
// track from the user's local video and posts it here, so a 1 GB video costs
// a ~5 MB upload instead of shipping the whole file to the server. The video
// itself never leaves the device — only these captions come back.
//
// Uses /audio/translations (not /transcriptions) so non-English speech comes
// back as English, matching the "Burn English subtitles" behaviour elsewhere.

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Groq's free tier rejects payloads beyond ~25 MB; stay under it.
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

interface Segment { start: number; end: number; text: string }

function segmentsToSrt(segments: Segment[]): string {
  const stamp = (sec: number): string => {
    const ms = Math.floor((sec % 1) * 1000)
    const s = Math.floor(sec) % 60
    const m = Math.floor(sec / 60) % 60
    const h = Math.floor(sec / 3600)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
  }
  return segments
    .map((seg, i) => `${i + 1}\n${stamp(seg.start)} --> ${stamp(seg.end)}\n${seg.text.trim()}\n`)
    .join('\n')
}

export async function POST(req: NextRequest) {
  const key = process.env.GROQ_API_KEY
  if (!key) {
    return NextResponse.json({ error: 'Transcription is not configured on this server.' }, { status: 503 })
  }

  let audio: File | null = null
  try {
    const form = await req.formData()
    const value = form.get('audio')
    if (value instanceof File) audio = value
  } catch {
    return NextResponse.json({ error: 'Could not read the uploaded audio.' }, { status: 400 })
  }

  if (!audio) {
    return NextResponse.json({ error: 'No audio was uploaded.' }, { status: 400 })
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({
      error: `Audio is ${(audio.size / 1048576).toFixed(0)} MB — the limit is ${MAX_AUDIO_BYTES / 1048576} MB. Try a shorter video.`,
    }, { status: 413 })
  }

  try {
    const upstream = new FormData()
    upstream.append('file', audio, audio.name || 'audio.m4a')
    upstream.append('model', 'whisper-large-v3')
    upstream.append('response_format', 'verbose_json')

    const res = await fetch('https://api.groq.com/openai/v1/audio/translations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: upstream,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error('[transcribe] Groq error', res.status, detail.slice(0, 300))
      return NextResponse.json({ error: `Transcription failed (${res.status}).` }, { status: 502 })
    }

    const json = await res.json() as { segments?: Segment[] }
    const segments = json.segments || []
    if (segments.length === 0) {
      return NextResponse.json({ error: 'No speech was detected in this video.' }, { status: 422 })
    }

    return NextResponse.json({ srt: segmentsToSrt(segments), segments: segments.length })
  } catch (err: any) {
    console.error('[transcribe] failed:', err?.message)
    return NextResponse.json({ error: err?.message || 'Transcription failed.' }, { status: 500 })
  }
}
