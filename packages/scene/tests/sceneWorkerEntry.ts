/**
 * Воркер сценового графа для тестов (bun worker_threads).
 * Протокол: {type:'scene-init', sab} → runSceneWorker (блокирующий цикл
 * на Atomics.wait) до CMD_STOP.
 */
import { parentPort } from 'node:worker_threads'
import { runSceneWorker } from '../src/index.ts'

const port = parentPort!

port.on('message', (message: unknown) => {
  const m = message as { type?: string; sab?: SharedArrayBuffer }
  if (m?.type === 'scene-init' && m.sab !== undefined) {
    // ready уходит ДО блокирующего цикла — Atomics.wait держит поток.
    port.postMessage({ type: 'scene-ready' })
    runSceneWorker(m.sab, {
      onFrame(epoch, frameMs) {
        // Диагностика в тестах не нужна; хук оставлен для отладки.
        void epoch; void frameMs
      },
    })
  }
})
