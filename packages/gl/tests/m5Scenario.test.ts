/**
 * M5 readiness criterion (dossier §14.3, Table 16): "A cross-thread
 * scenario on all transports".
 *
 * The same scenario — "the game world writes a signal + instance feed
 * records, the render world at the frame boundary samples the signal and
 * uploads the feed's dirty range with a single GPU call" — runs on:
 *   T0 memory    same-thread (one world — by definition);
 *   T1 sab+async a REAL worker (bun worker_threads) + SAB seqlock;
 *   T2 sab       a REAL worker + SAB without waitAsync;
 *   T3 msg       a REAL worker + a frame message (ping-pong transferable).
 */
import { describe, expect, it } from 'bun:test'
import { Worker } from 'node:worker_threads'
import { createWebGL2Renderer } from '../src/webgl2Renderer.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createTransport, attachTransport } from '@rune/core'
import type { TransportDescriptor, TransportFeedChunk, TransportFrameMessage } from '@rune/core'

const LAYOUT = { position: 'float32x3', radius: 'float32' } as const
const NAMES = ['game.hp', 'app.visibility'] as const

const VERT = `#version 300 es
layout(location=0) in vec3 inPos;
layout(location=1) in float inRadius;
void main() { gl_Position = vec4(inPos.xy * (0.5 + inRadius * 0.1), 0.0, 1.0); }`
const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(1.0, 0.5, 0.25, 1.0); }`

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as unknown as HTMLCanvasElement
}

function nextMessage(worker: Worker): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    worker.once('message', resolve as (value: Record<string, unknown>) => void)
  })
}

/** Render world: a WebGL2 renderer with a recording facade + a transport client. */
function makeRenderer(transport: ConstructorParameters<typeof Object>[0] | null) {
  const recording = createRecordingGL()
  const renderer = createWebGL2Renderer({
    canvas: fakeCanvas(),
    createGL: () => recording.gl,
    observeResize: false,
    now: () => 0,
    requestFrame: () => () => {},
    ...(transport !== null ? { transport: transport as never } : {}),
  })
  return { renderer, calls: recording.calls }
}

describe('M5: a cross-thread scenario on all transports', () => {
  it('T0 memory: one world, a synchronous signal graph', () => {
    const { host, client } = createTransport({ mode: 'memory', names: NAMES })
    const { renderer, calls } = makeRenderer(client)
    expect(renderer.transport!.mode).toBe('memory')

    // The writer is the same world: renderer.feed returns the feed channel (a local carrier).
    const feed = renderer.feed({ layout: LAYOUT, capacity: 8, mode: 'memory' })
    host.write('game.hp', 85)
    const batch = feed.channel!.push(2)
    batch.setVec3('position', 0, 1, 2, 3)
    batch.setFloat('radius', 0, 0.5)
    batch.setVec3('position', 1, 4, 5, 6)
    feed.channel!.publish()

    // T0: the signal value is visible immediately (the same graph).
    expect(client.shared('game.hp').value).toBe(85)
    renderer.step(16)
    expect(feed.count.value).toBe(2)
    expect(calls).toContain('updateBuffer(1,8,0)')
    renderer.dispose()
  })

  for (const mode of ['sab+async', 'sab'] as const) {
    it(`T ${mode}: a real worker writes the signal+feed into the shared SAB, the renderer reads at the frame boundary`, async () => {
      const worker = new Worker(new URL('./m5Worker.ts', import.meta.url), {
        workerData: { mode, names: NAMES, layout: LAYOUT, capacity: 8 },
      })
      const ready = (await nextMessage(worker)) as { type: string; descriptor: TransportDescriptor; feedId: number }
      expect(ready.type).toBe('ready')
      expect(ready.descriptor.signals).toBeDefined() // the registry's SAB has arrived

      // Render world: a client from the descriptor (the same shared memory).
      const client = attachTransport(ready.descriptor)
      const { renderer, calls } = makeRenderer(client)
      expect(renderer.transport!.mode).toBe(mode)

      const view = client.feed(1)
      expect(view).not.toBeNull()
      const feed = renderer.feed(view!)

      let hpSeen = -1
      client.shared('game.hp').subscribe(v => { hpSeen = v })

      // Worker: frame 1 — hp=85, 3 records.
      worker.postMessage({ type: 'frame', hp: 85, records: 3 })
      await nextMessage(worker) // done

      // Before the frame boundary — the mirror is silent (the epoch is not closed).
      expect(hpSeen).toBe(-1)
      renderer.step(16)

      // The signal is sampled, the feed is uploaded with ONE call, the count signal is raised.
      expect(hpSeen).toBe(85)
      expect(feed.count.value).toBe(3)
      expect(calls).toContain('updateBuffer(1,12,0)')
      const bytes = feed.storage.data
      expect(bytes[0]).toBe(0)       // position.x of record 0 (i=0 → 0)
      expect(bytes[1 * 4 + 3]).toBeCloseTo(0.35, 5) // radius of record 1 (0.25+0.1)

      // Frame 2: the worker appended — the dirty range [3,5).
      worker.postMessage({ type: 'frame', hp: 40, records: 2 })
      await nextMessage(worker)
      renderer.step(32)
      expect(hpSeen).toBe(40)
      expect(feed.count.value).toBe(5)
      expect(calls).toContain('updateBuffer(1,8,48)')
      // Record 4 (second batch, i=1): position.x = 1*1.5, radius = 0.35.
      expect(bytes[4 * 4]).toBeCloseTo(1.5, 5)
      expect(bytes[4 * 4 + 3]).toBeCloseTo(0.35, 5)

      // Vertex path dual-bind: a command with feed attributes.
      const command = renderer.command({
        shader: { glsl: { vertex: VERT, fragment: FRAG } },
        attributes: {
          inPos: feed.attribute('position'),
          inRadius: feed.attribute('radius'),
        },
        count: 5,
        instances: feed.count,
      })
      renderer.frame((_ctx, record) => record(command))
      renderer.step(48)
      expect(calls).toContain('bindVertexBuffer(1,0,3,16@0)')
      expect(calls).toContain('bindVertexBuffer(1,1,1,16@12)')

      renderer.dispose()
      await worker.terminate()
    }, 15000)
  }

  it('T3 msg: the worker sends a frame message (deltas + a ping-pong chunk)', async () => {
    const worker = new Worker(new URL('./m5Worker.ts', import.meta.url), {
      workerData: { mode: 'msg', names: NAMES, layout: LAYOUT, capacity: 8 },
    })
    const ready = (await nextMessage(worker)) as { type: string; descriptor: TransportDescriptor; feedId: number }
    expect(ready.type).toBe('ready')

    // Render world: a client from the schema (no SAB — the mirrors are filled by apply).
    const client = attachTransport(ready.descriptor)
    const { renderer, calls } = makeRenderer(client)
    expect(renderer.transport!.mode).toBe('msg')

    const view = client.feed(1)
    expect(view).not.toBeNull()
    const feed = renderer.feed(view!)

    let hpSeen = -1
    client.shared('game.hp').subscribe(v => { hpSeen = v })

    // Worker: frame — hp=60, 2 records → a frame message (transferable).
    worker.postMessage({ type: 'frame', hp: 60, records: 2 })
    const frameMessage = (await nextMessage(worker)) as { type: string; message: TransportFrameMessage }
    expect(frameMessage.type).toBe('frame')
    expect(frameMessage.message.deltas.length).toBe(1) // one delta: game.hp
    expect(frameMessage.message.chunks.length).toBe(1) // one feed chunk
    const done = (await nextMessage(worker)) as { type: string }
    expect(done.type).toBe('done') // drain of the frame receipt

    // Delivery: apply the message before the frame boundary.
    client.apply(frameMessage.message)
    renderer.step(16)

    expect(hpSeen).toBe(60)
    expect(feed.count.value).toBe(2)
    expect(calls).toContain('updateBuffer(1,8,0)')
    expect(feed.storage.data[0]).toBe(0) // record 0: i=0
    expect(feed.storage.data[1 * 4 + 3]).toBeCloseTo(0.35, 5) // radius of record 1

    // Ping-pong: the buffers return to the writer (after the GPU upload).
    const recycled = client.takeRecycled() as TransportFeedChunk[]
    expect(recycled.length).toBe(1)
    for (const chunk of recycled) {
      worker.postMessage({ type: 'reclaim', chunk }, [chunk.bytes])
    }
    const reclaimed = await nextMessage(worker)
    expect(reclaimed.type).toBe('reclaimed')

    renderer.dispose()
    await worker.terminate()
  }, 15000)
})
