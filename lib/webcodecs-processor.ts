// WebCodecs in-browser video processor.
// Takes a video blob + SRT, optionally pads to 9:16 and burns subtitles,
// returns a processed MP4 blob. Uses the device's hardware encoder when available.

import {
  Input,
  BlobSource,
  ALL_FORMATS,
  Output,
  Mp4OutputFormat,
  BufferTarget,
  VideoSampleSink,
  EncodedPacketSink,
  CanvasSource,
  EncodedAudioPacketSource,
  QUALITY_HIGH,
} from 'mediabunny'
import { parseSrt, findActiveSubtitle, type Subtitle } from './srt-parser'

export interface ProcessOptions {
  padTo9x16: boolean
  burnSubtitles: boolean
  srt: string
  onProgress: (pct: number, stage: string) => void
}

/** Feature-detect WebCodecs video encode + decode support. */
export async function isWebCodecsSupported(): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    return false
  }
  try {
    const encSupport = await VideoEncoder.isConfigSupported({
      codec: 'avc1.4d401e',
      width: 720,
      height: 1280,
      framerate: 30,
      bitrate: 5_000_000,
      hardwareAcceleration: 'prefer-hardware',
    })
    const decSupport = await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E' })
    return !!(encSupport.supported && decSupport.supported)
  } catch {
    return false
  }
}

// --- Subtitle rendering ---

function wrapText(text: string, maxCharsPerLine: number): string[] {
  // Collapse newlines from SRT into spaces, then word-wrap
  const words = text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
    } else if ((current + ' ' + word).length <= maxCharsPerLine) {
      current += ' ' + word
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

function drawSubtitleOnCanvas(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  cw: number,
  ch: number,
) {
  const lines = wrapText(text, 30)
  // Font size scales with canvas height for readability on any resolution
  const fontSize = Math.max(22, Math.min(36, Math.round(ch * 0.028)))
  const lineHeight = Math.round(fontSize * 1.25)
  const bottomMargin = Math.round(ch * 0.06)
  const outlineWidth = Math.max(4, Math.round(fontSize * 0.22))

  ctx.save()
  ctx.font = `bold ${fontSize}px Arial, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  const cx = cw / 2
  // Stack lines upward from bottom
  for (let i = 0; i < lines.length; i++) {
    const y = ch - bottomMargin - (lines.length - 1 - i) * lineHeight
    // Thick black outline first
    ctx.lineWidth = outlineWidth
    ctx.strokeStyle = '#000000'
    ctx.strokeText(lines[i], cx, y)
    // White fill on top
    ctx.fillStyle = '#ffffff'
    ctx.fillText(lines[i], cx, y)
  }
  ctx.restore()
}

// --- Letterbox math (scale-fit into 9:16 canvas) ---

interface DrawRect {
  outW: number
  outH: number
  drawW: number
  drawH: number
  drawX: number
  drawY: number
}

function computeLetterboxRect(srcW: number, srcH: number, pad: boolean): DrawRect {
  if (!pad) {
    // Keep source dimensions (must be even for H.264)
    const outW = srcW % 2 === 0 ? srcW : srcW - 1
    const outH = srcH % 2 === 0 ? srcH : srcH - 1
    return { outW, outH, drawW: outW, drawH: outH, drawX: 0, drawY: 0 }
  }
  // Target 9:16
  const outW = 720
  const outH = 1280
  const srcAspect = srcW / srcH
  const tgtAspect = outW / outH
  let drawW: number, drawH: number, drawX: number, drawY: number
  if (srcAspect > tgtAspect) {
    // Source is wider — fit width, letterbox top/bottom
    drawW = outW
    drawH = Math.floor((outW / srcAspect) / 2) * 2
    drawX = 0
    drawY = Math.floor((outH - drawH) / 2)
  } else {
    // Source is taller — fit height, pillar left/right
    drawH = outH
    drawW = Math.floor((outH * srcAspect) / 2) * 2
    drawX = Math.floor((outW - drawW) / 2)
    drawY = 0
  }
  return { outW, outH, drawW, drawH, drawX, drawY }
}

// --- Main pipeline ---

export async function processVideo(videoBlob: Blob, options: ProcessOptions): Promise<Blob> {
  const subs: Subtitle[] = options.burnSubtitles && options.srt ? parseSrt(options.srt) : []

  options.onProgress(0, 'Reading video...')

  // ---------- Read side ----------
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(videoBlob),
  })

  const vTrack = await input.getPrimaryVideoTrack()
  if (!vTrack) {
    input.dispose()
    throw new Error('No video track found in input')
  }
  const aTrack = await input.getPrimaryAudioTrack()

  const srcW = vTrack.displayWidth
  const srcH = vTrack.displayHeight
  const videoDuration = await vTrack.computeDuration()

  // Compute output dimensions + where to draw the source frame
  const rect = computeLetterboxRect(srcW, srcH, options.padTo9x16)
  const { outW, outH, drawW, drawH, drawX, drawY } = rect

  // Canvas + context
  const canvas = new OffscreenCanvas(outW, outH)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) {
    input.dispose()
    throw new Error('Failed to get 2D context for OffscreenCanvas')
  }

  // ---------- Write side ----------
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
  })

  const canvasSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: QUALITY_HIGH,
    hardwareAcceleration: 'prefer-hardware',
  })
  output.addVideoTrack(canvasSource, { frameRate: 30 })

  let audioSource: EncodedAudioPacketSource | null = null
  if (aTrack) {
    const audioCodec = aTrack.codec
    if (audioCodec) {
      audioSource = new EncodedAudioPacketSource(audioCodec)
      output.addAudioTrack(audioSource)
    }
  }

  await output.start()

  // ---------- Decode loop ----------
  options.onProgress(5, 'Processing frames...')
  const vSink = new VideoSampleSink(vTrack)

  // Estimate total frames for progress
  const estimatedTotalFrames = Math.max(1, Math.round(videoDuration * 30))
  let frameIdx = 0

  try {
    for await (const sample of vSink.samples()) {
      // Clear canvas to black (for padding and to avoid ghosting)
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, outW, outH)

      // Draw source frame at letterbox position
      sample.draw(ctx, drawX, drawY, drawW, drawH)

      // Subtitle overlay
      if (options.burnSubtitles && subs.length > 0) {
        const ts = sample.microsecondTimestamp
        const active = findActiveSubtitle(subs, ts)
        if (active) {
          drawSubtitleOnCanvas(ctx, active.text, outW, outH)
        }
      }

      // Encode from canvas (mediabunny handles VideoFrame creation + encoder feeding)
      await canvasSource.add(sample.timestamp, sample.duration)

      // Immediately release the decoded frame
      sample.close()

      frameIdx++
      if (frameIdx % 10 === 0) {
        // Frames 0-95% of the bar; reserve 95-99% for audio + finalize
        const pct = Math.min(94, Math.round((frameIdx / estimatedTotalFrames) * 94))
        options.onProgress(pct, 'Processing frames...')
        // Yield briefly so messages can flow and GC can run
        await new Promise(r => setTimeout(r, 0))
      }
    }
  } finally {
    canvasSource.close()
  }

  // ---------- Audio passthrough ----------
  if (aTrack && audioSource) {
    options.onProgress(95, 'Copying audio...')
    try {
      // First audio packet MUST include decoderConfig meta so the muxer can
      // properly set up the AAC track header. Without this, the audio track
      // is malformed and the resulting MP4 is broken (tiny / won't play).
      const decoderConfig = await aTrack.getDecoderConfig()
      if (!decoderConfig) {
        throw new Error('Could not read audio decoder config from input track')
      }

      const aSink = new EncodedPacketSink(aTrack)
      let first = true
      let audioPacketCount = 0
      for await (const packet of aSink.packets()) {
        if (first) {
          await audioSource.add(packet, { decoderConfig })
          first = false
        } else {
          await audioSource.add(packet)
        }
        audioPacketCount++
        // Emit progress every 50 packets so user sees something during audio copy
        if (audioPacketCount % 50 === 0) {
          options.onProgress(Math.min(98, 95 + Math.floor(audioPacketCount / 100)), 'Copying audio...')
          await new Promise(r => setTimeout(r, 0))
        }
      }
    } finally {
      audioSource.close()
    }
  }

  // ---------- Finalize ----------
  options.onProgress(99, 'Finalizing...')
  await output.finalize()
  input.dispose()

  const buffer = (output.target as BufferTarget).buffer
  if (!buffer) {
    throw new Error('Output finalized but no buffer produced')
  }

  // Sanity check: a valid MP4 with video+audio should be many KB at minimum.
  // If we got back < 1 KB, something went wrong in the pipeline (usually the
  // audio/video track setup) and we'd rather fail loudly than save garbage.
  if (buffer.byteLength < 1024) {
    throw new Error(`Output too small (${buffer.byteLength} bytes) — mux failed, likely audio track config issue`)
  }

  options.onProgress(100, 'Done')
  return new Blob([buffer], { type: 'video/mp4' })
}
