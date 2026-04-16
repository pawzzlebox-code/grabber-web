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
  const gpuOk = await isWebGpuSupported().catch(() => false)
  if (gpuOk) {
    try {
      console.log('[worker] Using WebGPU pipeline')
      return await processVideoGpu(videoBlob, options)
    } catch (err: any) {
      console.warn('[worker] WebGPU failed, falling back to 2D canvas:', err?.message || err)
      // Surface this to the user so they see the path switch, not a silent failure
      try { options.onProgress(0, 'GPU path failed, retrying with canvas...') } catch {}
    }
  } else {
    console.log('[worker] WebGPU unavailable — using 2D canvas pipeline')
  }
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
