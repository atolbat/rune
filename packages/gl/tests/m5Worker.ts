/**
 * Game worker of the M5 scenario (M5 readiness criterion of the dossier:
 * "a cross-thread scenario on all transports").
 *
 * The worker is the writer side (transport host): it owns the signal slots
 * and the feed. For each 'frame' request: writes the game.hp signal, appends
 * feed records, publishes.
 *   T1/T2 (SAB): the data lives in a shared buffer — the render world reads it itself.
 *   T3 (msg):    host.flush() → a frame message (deltas + feed chunk),
 *                transferable ping-pong.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { createTransportHost } from '../../core/src/index.ts'
import type { TransportMode } from '../../core/src/index.ts'

const port = parentPort!

interface WorkerSpec {
  readonly mode: TransportMode
  readonly names: readonly string[]
  readonly layout: Record<string, 'float32' | 'float32x2' | 'float32x3' | 'float32x4' | 'unorm8x4'>
  readonly capacity: number
}

const spec = workerData as WorkerSpec

const host = createTransportHost({ mode: spec.mode, names: spec.names })
const feed = host.createFeed({ layout: spec.layout, capacity: spec.capacity })

// The descriptor travels to the render world: SAB modes carry the buffers (shared memory),
// T3 — only the schema (the data will travel via frame messages).
port.postMessage({ type: 'ready', descriptor: host.describe(), feedId: 1 })

port.on('message', (message: { type: string; hp?: number; records?: number; chunk?: { feedId: number; from: number; count: number; bytes: ArrayBuffer } }) => {
  if (message.type === 'frame') {
    // Game logic of the frame: a signal + instance records.
    host.write('game.hp', message.hp ?? 0)
    const records = message.records ?? 0
    if (records > 0) {
      const batch = feed.push(records)
      for (let i = 0; i < records; i++) {
        batch.setVec3('position', i, i * 1.5, i * 0.5, -i)
        batch.setFloat('radius', i, 0.25 + i * 0.1)
      }
      feed.publish()
    }
    if (spec.mode === 'msg') {
      const frameMessage = host.flush()
      if (frameMessage !== null) {
        // One message per frame: deltas + a feed chunk (transferable).
        const transferables = frameMessage.chunks.map(chunk => chunk.bytes)
        port.postMessage({ type: 'frame', message: frameMessage }, transferables)
      }
    }
    port.postMessage({ type: 'done' })
  }
  if (message.type === 'reclaim' && message.chunk !== undefined) {
    // Ping-pong: the buffer returned to the writer pool.
    host.reclaim(message.chunk)
    port.postMessage({ type: 'reclaimed' })
  }
})
