/// <reference lib="webworker" />
// Web Worker that runs the WebCodecs video processor off the main thread.
// The main UI stays responsive while decode + encode + mux happen here.

import { processVideo, type ProcessOptions } from './webcodecs-processor'

type IncomingMessage = {
  type: 'process'
  videoBlob: Blob
  options: Omit<ProcessOptions, 'onProgress'>
}

type OutgoingMessage =
  | { type: 'progress'; pct: number; stage: string }
  | { type: 'done'; blob: Blob }
  | { type: 'error'; message: string }

function post(msg: OutgoingMessage) {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(msg)
}

self.addEventListener('message', async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data
  if (!msg || msg.type !== 'process') return

  try {
    const resultBlob = await processVideo(msg.videoBlob, {
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
