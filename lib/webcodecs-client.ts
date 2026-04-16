// Main-thread helper that spawns the WebCodecs worker and returns a promise.
// Handles the message protocol + cleanup on success/failure.

import type { ProcessOptions } from './webcodecs-processor'

type WorkerIncoming =
  | { type: 'progress'; pct: number; stage: string }
  | { type: 'done'; blob: Blob }
  | { type: 'error'; message: string }

export function runWorker(
  videoBlob: Blob,
  options: Omit<ProcessOptions, 'onProgress'>,
  onProgress: (pct: number, stage: string) => void,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    // Next.js / Webpack 5 bundles this worker via the URL-constructor pattern
    const worker = new Worker(new URL('./webcodecs-worker.ts', import.meta.url), {
      type: 'module',
    })

    const cleanup = () => {
      try { worker.terminate() } catch {}
    }

    worker.onmessage = (event: MessageEvent<WorkerIncoming>) => {
      const msg = event.data
      switch (msg.type) {
        case 'progress':
          try { onProgress(msg.pct, msg.stage) } catch {}
          return
        case 'done':
          cleanup()
          resolve(msg.blob)
          return
        case 'error':
          cleanup()
          reject(new Error(msg.message))
          return
      }
    }

    worker.onerror = (err) => {
      cleanup()
      reject(new Error(err.message || 'Worker error'))
    }

    // Kick off the job
    worker.postMessage({
      type: 'process',
      videoBlob,
      options,
    })
  })
}
