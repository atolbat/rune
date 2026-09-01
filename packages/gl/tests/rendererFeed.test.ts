import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/webgl2Renderer.ts'
import { createWebGpuRenderer } from '../src/webgpuRenderer.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createRecordingGPU } from '@rune/webgpu'
import { createTransport, createMsgFeedWriter } from '@rune/core'

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as unknown as HTMLCanvasElement
}

const LAYOUT = { position: 'float32x3', radius: 'float32' } as const
const STRIDE = 16 // байты записи

const VERT = `#version 300 es
layout(location=0) in vec3 inPos;
layout(location=1) in float inRadius;
void main() { gl_Position = vec4(inPos.xy * (0.5 + inRadius * 0.1), 0.0, 1.0); }`
const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(1.0, 0.5, 0.25, 1.0); }`

const WGSL = `
struct Uniforms { u_mvp: mat4x4<f32> };
@group(0) @binding(0) var<uniform> u: Uniforms;
struct VsOut { @builtin(position) pos: vec4<f32> };
@vertex fn vsMain(@location(0) inPos : vec3<f32>, @location(1) inRadius : f32) -> VsOut {
  var out: VsOut;
  out.pos = vec4<f32>(inPos.xy * (0.5 + inRadius * 0.1), 0.0, 1.0);
  return out;
}
@fragment fn fsMain() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.5, 0.25, 1.0); }`

describe('rendererFeed WebGL2 (dual-bind)', () => {
  function setup() {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    return { renderer, calls: recording.calls }
  }

  it('канал: T1/T2 SAB по умолчанию, count-сигнал, createBuffer один раз', () => {
    const { renderer, calls } = setup()
    const feed = renderer.feed({ layout: LAYOUT, capacity: 8 })
    expect(feed.channel).not.toBeNull()
    expect(feed.stride).toBe(STRIDE)
    expect(feed.capacity).toBe(8)
    expect(feed.count.value).toBe(0)

    // GPU-хранилище выделено сразу (capacity*stride байт = 128 = 32 float).
    expect(calls).toContain('createBuffer(32)')

    // Воркер пишет 3 записи, публикует.
    const batch = feed.channel!.push(3)
    batch.setVec3('position', 0, 1, 2, 3)
    batch.setVec3('position', 1, 4, 5, 6)
    batch.setFloat('radius', 1, 0.5)
    feed.channel!.publish()

    // Кадр: грязный диапазон [0,3) — ОДИН bufferSubData.
    renderer.step(16)
    expect(feed.count.value).toBe(3)
    expect(calls).toContain(`updateBuffer(1,12,0)`) // 12 float, byteOffset 0
    const updates = calls.filter(c => c.startsWith('updateBuffer')).length
    expect(updates).toBe(1) // один вызов на кадр

    // Второй кадр: +2 записи → грязный диапазон [3,5), byteOffset 48.
    const more = feed.channel!.push(2)
    more.setVec3('position', 0, 9, 9, 9)
    feed.channel!.publish()
    renderer.step(32)
    expect(feed.count.value).toBe(5)
    expect(calls).toContain(`updateBuffer(1,8,48)`) // 8 float, byteOffset 3*16

    // Без новых записей — аплоада нет.
    renderer.step(48)
    expect(calls.filter(c => c.startsWith('updateBuffer')).length).toBe(2)
    renderer.dispose()
  })

  it('vertex-путь: attribute() даёт stride/offset/bufferId, executor биндит интерливинг', () => {
    const { renderer, calls } = setup()
    const feed = renderer.feed({ layout: LAYOUT, capacity: 8 })
    const command = renderer.command({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: {
        inPos: feed.attribute('position'),
        inRadius: feed.attribute('radius'),
      },
      uniforms: { u_lightCount: feed.count },
      count: 3,
      instances: feed.count,
    })
    feed.channel!.push(3).setVec3('position', 0, 1, 0, 0)
    feed.channel!.publish()

    renderer.frame((_ctx, record) => record(command))
    renderer.step(16)

    // executor: внешний буфер фида с stride@offset (интерливинг записи 16 байт).
    expect(calls).toContain(`bindVertexBuffer(1,0,3,16@0)`)     // position: 3 компоненты @ 0
    expect(calls).toContain(`bindVertexBuffer(1,1,1,16@12)`)    // radius: 1 компонента @ 12
    // Свои буферы под feed-атрибуты НЕ создаются (внешний bufferId).
    expect(calls.filter(c => c.startsWith('createBuffer')).length).toBe(1)
    renderer.dispose()
  })

  it('T3 (msg): applyChunks → зеркало → sync одним bufferSubData, recycle', () => {
    const { renderer, calls } = setup()
    // Рендер-мир — читатель ping-pong; писатель имитируется createMsgFeedWriter.
    const feed = renderer.feed({ layout: LAYOUT, capacity: 8, mode: 'msg' })
    expect(feed.channel).toBeNull() // писатель живёт «в воркере»

    // «Воркер»: пишет и шлёт чанки.
    const writer = createMsgFeedWriter(1, { layout: LAYOUT, capacity: 8 })
    writer.feed.push(2).setVec3('position', 0, 7, 7, 7)
    writer.feed.publish()
    feed.applyChunks(writer.ship())

    renderer.step(16)
    expect(feed.count.value).toBe(2)
    expect(calls).toContain(`updateBuffer(1,8,0)`)

    // Ping-pong: вернуть буферы писателю.
    const recycled = feed.takeRecycled()
    expect(recycled.length).toBe(1)
    writer.reclaim(recycled)
    renderer.dispose()
  })

  it('transport-привязка: renderer.feed(client.feed(id)) — внешний SAB-view', () => {
    const { renderer, calls } = setup()
    const transport = createTransport({ mode: 'sab', names: ['game.hp'] })
    // Хост-транспорт создаёт фид; рендерер биндится к view читателя.
    const hostFeed = transport.host.createFeed({ layout: LAYOUT, capacity: 8 })
    const view = transport.client.feed(1)
    expect(view).not.toBeNull()
    const feed = renderer.feed(view!)
    expect(feed.channel).toBeNull() // писатель — host транспорта
    expect(feed.stride).toBe(STRIDE)

    // Запись через host-канал (SAB) видна рендереру без единого сообщения.
    hostFeed.push(2).setVec3('position', 0, 5, 5, 5)
    hostFeed.push(0)
    hostFeed.publish()
    renderer.step(16)
    expect(feed.count.value).toBe(2)
    expect(calls).toContain('updateBuffer(1,8,0)') // грязный диапазон одним вызовом
    renderer.dispose()
  })

  it('renderer.transport: проброс клиента + авто-семпл на границе кадра', () => {
    const recording = createRecordingGL()
    const transport = createTransport({ mode: 'sab', names: ['game.hp'] })
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      transport: transport.client,
    })
    expect(renderer.transport).not.toBeNull()
    expect(renderer.transport!.mode).toBe('sab')

    let hpSeen = -1
    renderer.transport!.shared('game.hp').subscribe(v => { hpSeen = v })
    transport.host.write('game.hp', 77)
    expect(hpSeen).toBe(-1) // до границы кадра — тишина
    renderer.step(16)
    expect(hpSeen).toBe(77) // sampleAll на эпохе — уведомление
    renderer.dispose()
  })
})

describe('rendererFeed WebGPU (dual-bind)', () => {
  async function setup() {
    const recording = createRecordingGPU()
    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async () => recording.gpu,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    return { renderer, calls: recording.calls }
  }

  it('sync: writeBuffer одним вызовом на кадр, count-сигнал', async () => {
    const { renderer, calls } = await setup()
    const feed = renderer.feed({ layout: LAYOUT, capacity: 8 })
    expect(feed.channel).not.toBeNull()

    feed.channel!.push(3).setVec3('position', 0, 1, 2, 3)
    feed.channel!.publish()
    renderer.step(16)
    expect(feed.count.value).toBe(3)
    // data.length = 8*4 float; byteLength = 3 записи * 16 байт = 48.
    expect(calls).toContain('syncVertexBuffer(32,48)')
    expect(calls.filter(c => c.startsWith('syncVertexBuffer')).length).toBe(1)

    feed.channel!.push(2).setFloat('radius', 0, 9)
    feed.channel!.publish()
    renderer.step(32)
    expect(calls).toContain('syncVertexBuffer(32,80)') // [0, 5 записей * 16)
    renderer.dispose()
  })

  it('vertex-путь: пайплайн с rich-слотами (stride@offset), биндинг общего view', async () => {
    const { renderer, calls } = await setup()
    const feed = renderer.feed({ layout: LAYOUT, capacity: 8 })
    const command = renderer.command({
      shader: { wgsl: WGSL },
      attributes: {
        inPos: feed.attribute('position'),   // stride 16, offset 0
        inRadius: feed.attribute('radius'),  // stride 16, offset 12
      },
      count: 3,
      instances: feed.count,
    })
    feed.channel!.push(3).setVec3('position', 0, 1, 0, 0)
    feed.channel!.publish()
    renderer.frame((_ctx, record) => record(command))
    renderer.step(16)

    // Пайплайн: интерливинг-слоты [3/16@0 x 1/16@12].
    expect(calls.some(c => c.includes('3/16@0x1/16@12'))).toBe(true)
    // Общий view биндится на оба слота (данные — стабильный mirror).
    expect(calls).toContain('bindVertexBuffer(0,32,3)')
    expect(calls).toContain('bindVertexBuffer(1,32,1)')
    void command
    renderer.dispose()
  })

  it('renderer.transport: проброс клиента + авто-семпл на границе кадра', async () => {
    const recording = createRecordingGPU()
    const transport = createTransport({ mode: 'sab', names: ['game.hp'] })
    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async () => recording.gpu,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      transport: transport.client,
    })
    expect(renderer.transport).not.toBeNull()
    expect(renderer.transport!.mode).toBe('sab')

    let hpSeen = -1
    renderer.transport!.shared('game.hp').subscribe(v => { hpSeen = v })
    transport.host.write('game.hp', 42)
    expect(hpSeen).toBe(-1)
    renderer.step(16)
    expect(hpSeen).toBe(42)
    renderer.dispose()
  })
})
