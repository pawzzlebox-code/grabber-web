// WebGPU-based video processor. Keeps frames GPU-resident via
// device.importExternalTexture() so the hardware encoder path stays active.
//
// Phase 3: full pipeline — decode → GPU → composite (letterbox + subtitles) → encode.
// Single fragment shader handles:
//   - Black bars outside the video rect (for 9:16 padding)
//   - Sampling the external video texture inside the video rect
//   - Alpha-blending a pre-rendered subtitle overlay texture on top
// The subtitle overlay is a small 2D canvas redrawn only when the active cue
// changes (roughly once every few seconds) and re-uploaded to a GPUTexture.

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
import type { ProcessOptions } from './webcodecs-processor'
import { computeLetterboxRect, drawSubtitleOnCanvas } from './webcodecs-processor'
import { parseSrt, findActiveSubtitle, type Subtitle } from './srt-parser'

// WebGPU types come from `lib.dom.d.ts` only when @webgpu/types is installed.
// Cast aggressively to any so the code compiles without that dep.
type GPUDeviceLike = any
type GPUCanvasContextLike = any
type GPURenderPipelineLike = any
type GPUBindGroupLayoutLike = any
type GPUSamplerLike = any
type GPUBufferLike = any
type GPUTextureLike = any

// Shader: letterbox + video + subtitle overlay in one fragment pass.
const SHADER_COMPOSITE = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> VSOut {
  let x = f32(i32(vid & 1u) << 2) - 1.0;
  let y = f32(i32(vid & 2u) << 1) - 1.0;
  var out: VSOut;
  out.pos = vec4f(x, y, 0.0, 1.0);
  // NDC y is up, texture v is down — flip v.
  out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

// videoRect = (x0, y0, x1, y1) in output UV space. The video fills this rect;
// outside of it, the canvas stays black (letterbox bars).
struct Uniforms {
  videoRect: vec4f,
}

@group(0) @binding(0) var videoTex: texture_external;
@group(0) @binding(1) var videoSamp: sampler;
@group(0) @binding(2) var subTex: texture_2d<f32>;
@group(0) @binding(3) var subSamp: sampler;
@group(0) @binding(4) var<uniform> uni: Uniforms;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  var base = vec4f(0.0, 0.0, 0.0, 1.0);
  let x0 = uni.videoRect.x;
  let y0 = uni.videoRect.y;
  let x1 = uni.videoRect.z;
  let y1 = uni.videoRect.w;
  if (in.uv.x >= x0 && in.uv.x < x1 && in.uv.y >= y0 && in.uv.y < y1) {
    let vidUV = vec2f((in.uv.x - x0) / (x1 - x0), (in.uv.y - y0) / (y1 - y0));
    base = textureSampleBaseClampToEdge(videoTex, videoSamp, vidUV);
  }
  let sub = textureSample(subTex, subSamp, in.uv);
  return vec4f(mix(base.rgb, sub.rgb, sub.a), 1.0);
}
`

interface GpuPipeline {
  device: GPUDeviceLike
  canvas: OffscreenCanvas
  gpuCtx: GPUCanvasContextLike
  renderPipeline: GPURenderPipelineLike
  bindGroupLayout: GPUBindGroupLayoutLike
  videoSampler: GPUSamplerLike
  subSampler: GPUSamplerLike
  uniformBuffer: GPUBufferLike
  subTexture: GPUTextureLike
  subCanvas: OffscreenCanvas
  subCtx: OffscreenCanvasRenderingContext2D
  format: string
  outW: number
  outH: number
}

async function initWebGpuPipeline(outW: number, outH: number): Promise<GpuPipeline> {
  const nav = navigator as any
  if (!nav.gpu) throw new Error('navigator.gpu not available')
  const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('No WebGPU adapter')
  const device = await adapter.requestDevice()

  const canvas = new OffscreenCanvas(outW, outH)
  const gpuCtx = canvas.getContext('webgpu') as GPUCanvasContextLike
  if (!gpuCtx) throw new Error('Failed to get webgpu canvas context')

  const format = nav.gpu.getPreferredCanvasFormat()
  gpuCtx.configure({ device, format, alphaMode: 'opaque' })

  const shaderModule = device.createShaderModule({ code: SHADER_COMPOSITE })

  const FRAGMENT_STAGE = 0x2
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: FRAGMENT_STAGE, externalTexture: {} },
      { binding: 1, visibility: FRAGMENT_STAGE, sampler: {} },
      { binding: 2, visibility: FRAGMENT_STAGE, texture: { sampleType: 'float' } },
      { binding: 3, visibility: FRAGMENT_STAGE, sampler: {} },
      { binding: 4, visibility: FRAGMENT_STAGE, buffer: { type: 'uniform' } },
    ],
  })

  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] })

  const renderPipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module: shaderModule, entryPoint: 'vs' },
    fragment: { module: shaderModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })

  const videoSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const subSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })

  // Uniform buffer holds videoRect (vec4f = 16 bytes)
  const UNIFORM_USAGE = 0x40 | 0x8 // UNIFORM | COPY_DST
  const uniformBuffer = device.createBuffer({ size: 16, usage: UNIFORM_USAGE })

  // Subtitle texture + staging canvas. Sized to match output so pixel positions
  // from drawSubtitleOnCanvas translate 1:1 into output space.
  const TEXTURE_USAGE = 0x4 | 0x10 | 0x2 // TEXTURE_BINDING | RENDER_ATTACHMENT | COPY_DST
  const subTexture = device.createTexture({
    size: [outW, outH, 1],
    format: 'rgba8unorm',
    usage: TEXTURE_USAGE,
  })

  const subCanvas = new OffscreenCanvas(outW, outH)
  const subCtx = subCanvas.getContext('2d', { alpha: true }) as OffscreenCanvasRenderingContext2D

  return {
    device, canvas, gpuCtx, renderPipeline, bindGroupLayout,
    videoSampler, subSampler, uniformBuffer, subTexture, subCanvas, subCtx,
    format, outW, outH,
  }
}

// --- Main pipeline ---

export async function processVideoGpu(videoBlob: Blob, options: ProcessOptions): Promise<Blob> {
  const subs: Subtitle[] = options.burnSubtitles && options.srt ? parseSrt(options.srt) : []

  options.onProgress(0, 'Reading video...')

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(videoBlob) })

  const vTrack = await input.getPrimaryVideoTrack()
  if (!vTrack) {
    input.dispose()
    throw new Error('No video track found in input')
  }
  const aTrack = await input.getPrimaryAudioTrack()

  const srcW = vTrack.displayWidth
  const srcH = vTrack.displayHeight
  const videoDuration = await vTrack.computeDuration()

  // Letterbox: either pad to 9:16 or pass through source dims (even-adjusted)
  const rect = computeLetterboxRect(srcW, srcH, options.padTo9x16)
  const { outW, outH, drawW, drawH, drawX, drawY } = rect

  // Init GPU pipeline
  const gpu = await initWebGpuPipeline(outW, outH)

  // Uniform data: video rect in UV space (0..1)
  const videoRectUV = new Float32Array([
    drawX / outW,          // x0
    drawY / outH,          // y0
    (drawX + drawW) / outW, // x1
    (drawY + drawH) / outH, // y1
  ])
  gpu.device.queue.writeBuffer(gpu.uniformBuffer, 0, videoRectUV)

  // Output side
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const canvasSource = new CanvasSource(gpu.canvas, {
    codec: 'avc',
    bitrate: QUALITY_HIGH,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
  })
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

  options.onProgress(5, 'Processing (GPU)...')

  let sourceFps = 30
  try {
    const stats = await vTrack.computePacketStats(50)
    if (stats.averagePacketRate > 0) sourceFps = stats.averagePacketRate
  } catch {}
  const estimatedTotalFrames = Math.max(1, Math.round(videoDuration * sourceFps))
  let frameIdx = 0

  const vSink = new VideoSampleSink(vTrack)

  // Track which subtitle cue is currently rendered on the subtitle texture so we
  // only re-upload when the active cue actually changes.
  let currentSubIndex = -2 // -1 = no sub, -2 = uninitialized (force first upload)

  // Clear the subtitle canvas once to transparent (initial state: no cue)
  gpu.subCtx.clearRect(0, 0, outW, outH)
  uploadCanvasToTexture(gpu.device, gpu.subCanvas, gpu.subTexture, outW, outH)

  const t0 = performance.now()

  try {
    for await (const sample of vSink.samples()) {
      const vf: VideoFrame = (sample as any).toVideoFrame?.() ?? (sample as any).videoFrame
      if (!vf) {
        sample.close()
        throw new Error('Could not extract VideoFrame from VideoSample')
      }

      // Update subtitle texture only when the active cue changes.
      if (options.burnSubtitles && subs.length > 0) {
        const ts = sample.microsecondTimestamp
        const activeIdx = findActiveIndex(subs, ts)
        if (activeIdx !== currentSubIndex) {
          gpu.subCtx.clearRect(0, 0, outW, outH)
          if (activeIdx >= 0) {
            drawSubtitleOnCanvas(gpu.subCtx, subs[activeIdx].text, outW, outH, drawY + drawH)
          }
          uploadCanvasToTexture(gpu.device, gpu.subCanvas, gpu.subTexture, outW, outH)
          currentSubIndex = activeIdx
        }
      }

      const externalTex = gpu.device.importExternalTexture({ source: vf })

      const bindGroup = gpu.device.createBindGroup({
        layout: gpu.bindGroupLayout,
        entries: [
          { binding: 0, resource: externalTex },
          { binding: 1, resource: gpu.videoSampler },
          { binding: 2, resource: gpu.subTexture.createView() },
          { binding: 3, resource: gpu.subSampler },
          { binding: 4, resource: { buffer: gpu.uniformBuffer } },
        ],
      })

      const commandEncoder = gpu.device.createCommandEncoder()
      const pass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: gpu.gpuCtx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      })
      pass.setPipeline(gpu.renderPipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
      gpu.device.queue.submit([commandEncoder.finish()])

      // Feed the GPU canvas back into mediabunny's encoder path.
      await canvasSource.add(sample.timestamp, sample.duration)

      sample.close()

      frameIdx++
      if (frameIdx % 60 === 0) {
        const pct = Math.min(94, Math.round((frameIdx / estimatedTotalFrames) * 94))
        const fps = frameIdx / ((performance.now() - t0) / 1000)
        options.onProgress(pct, `GPU ${fps.toFixed(0)} fps`)
      }
    }
  } finally {
    canvasSource.close()
  }

  const totalSec = (performance.now() - t0) / 1000
  const fps = frameIdx / totalSec
  console.log(`[WebGPU] Encoded ${frameIdx} frames in ${totalSec.toFixed(1)}s (${fps.toFixed(1)} fps)`)

  if (aTrack && audioSource) {
    options.onProgress(95, 'Copying audio...')
    try {
      const decoderConfig = await aTrack.getDecoderConfig()
      if (!decoderConfig) throw new Error('Could not read audio decoder config')

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
        if (audioPacketCount % 50 === 0) {
          options.onProgress(Math.min(98, 95 + Math.floor(audioPacketCount / 100)), 'Copying audio...')
          await new Promise(r => setTimeout(r, 0))
        }
      }
    } finally {
      audioSource.close()
    }
  }

  options.onProgress(99, 'Finalizing...')
  await output.finalize()
  input.dispose()

  const buffer = (output.target as BufferTarget).buffer
  if (!buffer) throw new Error('Output finalized but no buffer produced')
  if (buffer.byteLength < 1024) {
    throw new Error(`Output too small (${buffer.byteLength} bytes) — mux failed`)
  }

  options.onProgress(100, 'Done')
  return new Blob([buffer], { type: 'video/mp4' })
}

// --- helpers ---

function findActiveIndex(subs: Subtitle[], tsUs: number): number {
  for (let i = 0; i < subs.length; i++) {
    if (tsUs >= subs[i].start && tsUs <= subs[i].end) return i
  }
  return -1
}

function uploadCanvasToTexture(
  device: GPUDeviceLike,
  source: OffscreenCanvas,
  texture: GPUTextureLike,
  w: number,
  h: number,
): void {
  // copyExternalImageToTexture handles OffscreenCanvas → GPUTexture. On Safari
  // this does go through a CPU staging buffer for 2D canvases, but it only
  // runs when the subtitle cue changes (a few times per video), so it's cheap.
  device.queue.copyExternalImageToTexture(
    { source, flipY: false },
    { texture },
    [w, h, 1],
  )
}
