/**
 * Scene graph worker for tests (bun worker_threads).
 * Protocol: {type:'scene-init', sab} → runSceneWorker (a blocking loop
 * on Atomics.wait) until CMD_STOP.
 */
import { parentPort } from 'node:worker_threads'
import { runSceneWorker } from '../src/index.ts'

const port = parentPort!

port.on('message', (message: unknown) => {
  const m = message as { type?: string; sab?: SharedArrayBuffer }
  if (m?.type === 'scene-init' && m.sab !== undefined) {
    // ready is sent BEFORE the blocking loop — Atomics.wait holds the thread.
    port.postMessage({ type: 'scene-ready' })
    runSceneWorker(m.sab, {
      onFrame(epoch, frameMs) {
        // Diagnostics not needed in tests; the hook is kept for debugging.
        void epoch; void frameMs
      },
    })
  }
})
