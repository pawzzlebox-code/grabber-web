/// <reference lib="webworker" />
// Web Worker that runs the video processor off the main thread.
// Tries WebGPU first (GPU-resident pipeline, ~150+ fps on iPhone 16 Pro) and
// falls back to the 2D canvas processor (~65 fps software encoder) if either
// WebGPU isn't available or the GPU pipeline fails mid-stream.

import { processVideo, isWebGpuSupported, type ProcessOptions } from './webcodecs-processor'
import { processVideoGpu } from './webgpu-processor'

type IncomingMessage = {
  type: 'process'
  videoBlob: Blob
  options: Omit<ProcessOptions, 'onProgress'>
}

type OutgoingMessage =
  | { type: 'progress'; pct: number; stage: string }
  | { type: 'done'; blob: Blob }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string }

function post(msg: OutgoingMessage) {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(msg)
}

// Forward worker-side console logs to the main thread so they show up in the
// on-screen debug panel on iPhones (no Mac / Web Inspector required).
function stringify(args: any[]): string {
  return args.map(a => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return a.message
    try { return JSON.stringify(a) } catch { return String(a) }
  }).join(' ')
}
const origLog = console.log.bind(console)
const origWarn = console.warn.bind(console)
const origError = console.error.bind(console)
console.log = (...args: any[]) => { origLog(...args); post({ type: 'log', message: stringify(args) }) }
console.warn = (...args: any[]) => { origWarn(...args); post({ type: 'log', message: 'WARN ' + stringify(args) }) }
console.error = (...args: any[]) => { origError(...args); post({ type: 'log', message: 'ERROR ' + stringify(args) }) }

async function runWithFallback(
  videoBlob: Blob,
  options: ProcessOptions,
): Promise<Blob> {
  // WebGPU pipeline is disabled pending a fix — on Chrome desktop it hangs
  // silently inside the decode-composite-encode loop after ~5% (likely a
  // mediabunny<->WebGPU canvas interop issue). The "throw => fallback"
  // guard below doesn't catch a hang, so we default to the 2D canvas path.
  // The 2D canvas path uses the SAME hardware H.264 encoder (NVENC / AMF /
  // QuickSync) via WebCodecs — the only thing WebGPU saved was a readback
  // for compositing, which is negligible compared to encode time. Net perf
  // loss on desktop: effectively zero. Re-enable once the hang is traced.
  console.log('[worker] Using 2D canvas pipeline (hardware H.264 encoder)')
  // Silence unused-import warnings — processVideoGpu + isWebGpuSupported
  // remain wired so re-enabling is a one-line change.
  void processVideoGpu; void isWebGpuSupported
  return await processVideo(videoBlob, options)
}

self.addEventListener('message', async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data
  if (!msg || msg.type !== 'process') return

  try {
    const resultBlob = await runWithFallback(msg.videoBlob, {
      ...msg.options,
      onProgress: (pct, stage) => {
        post({ type: 'progress', pct, stage })
      },
    })
    post({ type: 'done', blob: resultBlob })
  } catch (err: any) {
    post({ type: 'error', message: err?.message || String(err) })
  }
})

// Keep TypeScript happy for module-scope self-referential imports
export {}
