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

/** Feature-detect WebGPU with importExternalTexture support (needed for the
 *  zero-copy GPU compositing path). Safari 26+, Chrome 113+, Edge 113+.
 *  Logs a specific reason when it returns false so the debug panel shows
 *  what exactly is missing (helpful for users on iOS without Web Inspector). */
export async function isWebGpuSupported(): Promise<boolean> {
  try {
    const nav = globalThis.navigator as Navigator & { gpu?: { requestAdapter: (opts?: unknown) => Promise<unknown> } }
    if (!nav?.gpu) {
      console.log('[webgpu] navigator.gpu is undefined — browser/OS too old (need iOS 26+ / Safari 26+ / Chrome 113+)')
      return false
    }
    const adapter = await nav.gpu.requestAdapter()
    if (!adapter) {
      console.log('[webgpu] navigator.gpu present but requestAdapter() returned null — feature flag may be off (Safari → Settings → Feature Flags → WebGPU) or GPU is unsupported')
      return false
    }
    console.log('[webgpu] Adapter acquired — WebGPU available')
    return true
  } catch (err: any) {
    console.log('[webgpu] Detection threw:', err?.message || err)
    return false
  }
}

// --- Subtitle rendering ---

export function wrapText(text: string, maxCharsPerLine: number): string[] {
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

export function drawSubtitleOnCanvas(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  cw: number,
  ch: number,
  videoBottomY: number, // Y coordinate where the actual video frame ends (bottom edge of letterbox content)
) {
  const lines = wrapText(text, 30)
  // Font size scales with canvas height for readability on any resolution
  const fontSize = Math.max(22, Math.min(36, Math.round(ch * 0.028)))
  const lineHeight = Math.round(fontSize * 1.25)
  const outlineWidth = Math.max(4, Math.round(fontSize * 0.22))

  // Gap between the bottom of the video content and the top of the first subtitle line (~40px on a 1280-tall canvas)
  const gapBelowVideo = Math.round(ch * 0.03)

  // Position the FIRST line's baseline just below the video, then stack additional lines downward.
  // But never let subtitles run off the bottom of the canvas — clamp within a bottom safety margin.
  const minBottomMargin = Math.round(ch * 0.02)
  const blockHeight = lines.length * lineHeight
  let firstLineBaseline = videoBottomY + gapBelowVideo + lineHeight
  const maxBaseline = ch - minBottomMargin - (blockHeight - lineHeight)
  if (firstLineBaseline > maxBaseline) firstLineBaseline = maxBaseline

  ctx.save()
  ctx.font = `bold ${fontSize}px Arial, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  const cx = cw / 2
  // Draw lines top-down starting just below the video
  for (let i = 0; i < lines.length; i++) {
    const y = firstLineBaseline + i * lineHeight
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

export interface DrawRect {
  outW: number
  outH: number
  drawW: number
  drawH: number
  drawX: number
  drawY: number
}

export function computeLetterboxRect(srcW: number, srcH: number, pad: boolean): DrawRect {
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
  // `alpha: false` + `willReadFrequently: false` keeps the canvas GPU-backed
  // and avoids a GPU→CPU readback on each frame when copying to VideoFrame
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false })
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
    // Real-time latency mode: encoder prioritizes speed over quality, can drop
    // frames if it gets backed up. Big speedup on iOS VideoToolbox.
    latencyMode: 'realtime',
  })
  // Don't force frameRate: 30 here — let mediabunny use the source's native rate.
  // Forcing 30 caused re-sampling overhead for 24/60 fps sources.
  output.addVideoTrack(canvasSource)

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

  // Use actual source frame rate (not hardcoded 30) so progress is accurate.
  // computePacketStats scans a prefix of packets for a fast estimate.
  let sourceFps = 30
  try {
    const stats = await vTrack.computePacketStats(50)
    if (stats.averagePacketRate > 0) sourceFps = stats.averagePacketRate
  } catch {}

  const estimatedTotalFrames = Math.max(1, Math.round(videoDuration * sourceFps))
  let frameIdx = 0

  // Canvas only needs clearing when padding leaves black bars that could ghost
  const needsClear = options.padTo9x16 && (drawX > 0 || drawY > 0 || drawW < outW || drawH < outH)
  if (needsClear) {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, outW, outH)
  }

  const t0 = performance.now()
  let tDecode = 0, tDraw = 0, tEncode = 0

  try {
    for await (const sample of vSink.samples()) {
      const tA = performance.now()

      // Draw source frame at letterbox position (no need to clear every frame —
      // the frame itself covers the video area, black bars only change on padding transitions)
      sample.draw(ctx, drawX, drawY, drawW, drawH)

      // Subtitle overlay
      if (options.burnSubtitles && subs.length > 0) {
        const ts = sample.microsecondTimestamp
        const active = findActiveSubtitle(subs, ts)
        if (active) {
          drawSubtitleOnCanvas(ctx, active.text, outW, outH, drawY + drawH)
        }
      }

      const tB = performance.now()

      // Encode from canvas (mediabunny handles VideoFrame creation + encoder feeding)
      await canvasSource.add(sample.timestamp, sample.duration)

      const tC = performance.now()
      tDraw += (tB - tA)
      tEncode += (tC - tB)
      tDecode += (tA - (frameIdx === 0 ? t0 : 0))

      // Immediately release the decoded frame
      sample.close()

      frameIdx++
      // Progress + yield every 60 frames (was 10 — yielding 28x fewer times)
      if (frameIdx % 60 === 0) {
        const pct = Math.min(94, Math.round((frameIdx / estimatedTotalFrames) * 94))
        const fps = frameIdx / ((performance.now() - t0) / 1000)
        options.onProgress(pct, `Processing ${fps.toFixed(0)} fps`)
      }
    }
  } finally {
    canvasSource.close()
  }

  const totalSec = (performance.now() - t0) / 1000
  const fps = frameIdx / totalSec
  console.log(`[WebCodecs] Encoded ${frameIdx} frames in ${totalSec.toFixed(1)}s (${fps.toFixed(1)} fps) — draw=${tDraw.toFixed(0)}ms encode=${tEncode.toFixed(0)}ms`)

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
