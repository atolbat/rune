/**
 * M5-критерий готовности (досье §14.3, Таблица 16): «Кросс-поточный
 * сценарий на всех транспортах».
 *
 * Один и тот же сценарий — «игровой мир пишет сигнал + инстансные записи
 * фида, рендер-мир на границе кадра семплирует сигнал и заливает грязный
 * диапазон фида одним вызовом GPU» — выполняется на:
 *   T0 memory    same-thread (один мир — по определению);
 *   T1 sab+async НАСТОЯЩИЙ воркер (bun worker_threads) + SAB seqlock;
 *   T2 sab       НАСТОЯЩИЙ воркер + SAB без waitAsync;
 *   T3 msg       НАСТОЯЩИЙ воркер + сообщение кадра (ping-pong transferable).
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

/** Рендер-мир: WebGL2-рендерер с recording-фасадом + транспорт-клиент. */
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

describe('M5: кросс-поточный сценарий на всех транспортах', () => {
  it('T0 memory: один мир, синхронный сигнальный граф', () => {
    const { host, client } = createTransport({ mode: 'memory', names: NAMES })
    const { renderer, calls } = makeRenderer(client)
    expect(renderer.transport!.mode).toBe('memory')

    // Писатель — тот же мир: канал фида отдаёт renderer.feed (local-носитель).
    const feed = renderer.feed({ layout: LAYOUT, capacity: 8, mode: 'memory' })
    host.write('game.hp', 85)
    const batch = feed.channel!.push(2)
    batch.setVec3('position', 0, 1, 2, 3)
    batch.setFloat('radius', 0, 0.5)
    batch.setVec3('position', 1, 4, 5, 6)
    feed.channel!.publish()

    // T0: значение сигнала видно сразу (тот же граф).
    expect(client.shared('game.hp').value).toBe(85)
    renderer.step(16)
    expect(feed.count.value).toBe(2)
    expect(calls).toContain('updateBuffer(1,8,0)')
    renderer.dispose()
  })

  for (const mode of ['sab+async', 'sab'] as const) {
    it(`T ${mode}: настоящий воркер пишет сигнал+фид в общий SAB, рендер читает на границе кадра`, async () => {
      const worker = new Worker(new URL('./m5Worker.ts', import.meta.url), {
        workerData: { mode, names: NAMES, layout: LAYOUT, capacity: 8 },
      })
      const ready = (await nextMessage(worker)) as { type: string; descriptor: TransportDescriptor; feedId: number }
      expect(ready.type).toBe('ready')
      expect(ready.descriptor.signals).toBeDefined() // SAB реестра приехал

      // Рендер-мир: клиент по дескриптору (та же общая память).
      const client = attachTransport(ready.descriptor)
      const { renderer, calls } = makeRenderer(client)
      expect(renderer.transport!.mode).toBe(mode)

      const view = client.feed(1)
      expect(view).not.toBeNull()
      const feed = renderer.feed(view!)

      let hpSeen = -1
      client.shared('game.hp').subscribe(v => { hpSeen = v })

      // Воркер: кадр 1 — hp=85, 3 записи.
      worker.postMessage({ type: 'frame', hp: 85, records: 3 })
      await nextMessage(worker) // done

      // До границы кадра — зеркало молчит (эпоха не закрыта).
      expect(hpSeen).toBe(-1)
      renderer.step(16)

      // Сигнал семплирован, фид залит ОДНИМ вызовом, count-сигнал поднят.
      expect(hpSeen).toBe(85)
      expect(feed.count.value).toBe(3)
      expect(calls).toContain('updateBuffer(1,12,0)')
      const bytes = feed.storage.data
      expect(bytes[0]).toBe(0)       // position.x записи 0 (i=0 → 0)
      expect(bytes[1 * 4 + 3]).toBeCloseTo(0.35, 5) // radius записи 1 (0.25+0.1)

      // Кадр 2: воркер дописал — грязный диапазон [3,5).
      worker.postMessage({ type: 'frame', hp: 40, records: 2 })
      await nextMessage(worker)
      renderer.step(32)
      expect(hpSeen).toBe(40)
      expect(feed.count.value).toBe(5)
      expect(calls).toContain('updateBuffer(1,8,48)')
      // Запись 4 (вторая партия, i=1): position.x = 1*1.5, radius = 0.35.
      expect(bytes[4 * 4]).toBeCloseTo(1.5, 5)
      expect(bytes[4 * 4 + 3]).toBeCloseTo(0.35, 5)

      // Vertex-путь dual-bind: команда с feed-атрибутами.
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

  it('T3 msg: воркер шлёт сообщение кадра (дельты + ping-pong чанк)', async () => {
    const worker = new Worker(new URL('./m5Worker.ts', import.meta.url), {
      workerData: { mode: 'msg', names: NAMES, layout: LAYOUT, capacity: 8 },
    })
    const ready = (await nextMessage(worker)) as { type: string; descriptor: TransportDescriptor; feedId: number }
    expect(ready.type).toBe('ready')

    // Рендер-мир: клиент по схеме (без SAB — зеркала наполняются apply).
    const client = attachTransport(ready.descriptor)
    const { renderer, calls } = makeRenderer(client)
    expect(renderer.transport!.mode).toBe('msg')

    const view = client.feed(1)
    expect(view).not.toBeNull()
    const feed = renderer.feed(view!)

    let hpSeen = -1
    client.shared('game.hp').subscribe(v => { hpSeen = v })

    // Воркер: кадр — hp=60, 2 записи → сообщение кадра (transferable).
    worker.postMessage({ type: 'frame', hp: 60, records: 2 })
    const frameMessage = (await nextMessage(worker)) as { type: string; message: TransportFrameMessage }
    expect(frameMessage.type).toBe('frame')
    expect(frameMessage.message.deltas.length).toBe(1) // одна дельта: game.hp
    expect(frameMessage.message.chunks.length).toBe(1) // один чанк фида
    const done = (await nextMessage(worker)) as { type: string }
    expect(done.type).toBe('done') // дрен квитанции кадра

    // Доставка: apply сообщения до границы кадра.
    client.apply(frameMessage.message)
    renderer.step(16)

    expect(hpSeen).toBe(60)
    expect(feed.count.value).toBe(2)
    expect(calls).toContain('updateBuffer(1,8,0)')
    expect(feed.storage.data[0]).toBe(0) // запись 0: i=0
    expect(feed.storage.data[1 * 4 + 3]).toBeCloseTo(0.35, 5) // radius записи 1

    // Ping-pong: буферы возвращаются писателю (после загрузки в GPU).
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
