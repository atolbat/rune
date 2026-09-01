/**
 * Игровой воркер M5-сценария (критерий готовности этапа M5 досье:
 * «кросс-поточный сценарий на всех транспортах»).
 *
 * Воркер — сторона-писатель (host транспорта): владеет слотами сигналов
 * и фидом. На каждый 'frame'-запрос: пишет сигнал game.hp, дописывает
 * записи фида, публикует.
 *   T1/T2 (SAB): данные лежат в общем буфере — рендер-мир читает сам.
 *   T3 (msg):    host.flush() → сообщение кадра (дельты + чанк фида),
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

// Дескриптор уезжает в рендер-мир: SAB-режимы несут буферы (общая память),
// T3 — только схему (данные поедут сообщениями кадра).
port.postMessage({ type: 'ready', descriptor: host.describe(), feedId: 1 })

port.on('message', (message: { type: string; hp?: number; records?: number; chunk?: { feedId: number; from: number; count: number; bytes: ArrayBuffer } }) => {
  if (message.type === 'frame') {
    // Игровая логика кадра: сигнал + инстансные записи.
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
        // Одно сообщение на кадр: дельты + чанк фида (transferable).
        const transferables = frameMessage.chunks.map(chunk => chunk.bytes)
        port.postMessage({ type: 'frame', message: frameMessage }, transferables)
      }
    }
    port.postMessage({ type: 'done' })
  }
  if (message.type === 'reclaim' && message.chunk !== undefined) {
    // Ping-pong: буфер вернулся в пул писателя.
    host.reclaim(message.chunk)
    port.postMessage({ type: 'reclaimed' })
  }
})
