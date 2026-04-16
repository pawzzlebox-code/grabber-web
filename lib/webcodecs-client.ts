// Main-thread helper that spawns the WebCodecs worker and returns a promise.
// Handles the message protocol + cleanup on success/failure.

import type { ProcessOptions } from './webcodecs-processor'

type WorkerIncoming =
  | { type: 'progress'; pct: number; stage: string }
  | { type: 'done'; blob: Blob }
  | { type: 'error'; message: string }

export interface WorkerHandle {
  promise: Promise<Blob>
  cancel: () => void
}

export function runWorker(
  videoBlob: Blob,
  options: Omit<ProcessOptions, 'onProgress'>,
  onProgress: (pct: number, stage: string) => void,
): WorkerHandle {
  const worker = new Worker(new URL('./webcodecs-worker.ts', import.meta.url), {
    type: 'module',
  })

  let cancelled = false

  const promise = new Promise<Blob>((resolve, reject) => {
    const cleanup = () => {
      try { worker.terminate() } catch {}
    }

    worker.onmessage = (event: MessageEvent<WorkerIncoming>) => {
      if (cancelled) return
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
      if (cancelled) return
      cleanup()
      reject(new Error(err.message || 'Worker error'))
    }

    worker.postMessage({
      type: 'process',
      videoBlob,
      options,
    })
  })

  return {
    promise,
    cancel: () => {
      cancelled = true
      try { worker.terminate() } catch {}
    },
  }
}
