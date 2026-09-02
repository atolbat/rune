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
const STRIDE = 16 // record bytes

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

  it('channel: T1/T2 SAB by default, the count signal, createBuffer once', () => {
    const { renderer, calls } = setup()
    const feed = renderer.feed({ layout: LAYOUT, capacity: 8 })
    expect(feed.channel).not.toBeNull()
    expect(feed.stride).toBe(STRIDE)
    expect(feed.capacity).toBe(8)
    expect(feed.count.value).toBe(0)

    // The GPU storage is allocated immediately (capacity*stride bytes = 128 = 32 floats).
    expect(calls).toContain('createBuffer(32)')

    // The worker writes 3 records, publishes.
    const batch = feed.channel!.push(3)
    batch.setVec3('position', 0, 1, 2, 3)
    batch.setVec3('position', 1, 4, 5, 6)
    batch.setFloat('radius', 1, 0.5)
    feed.channel!.publish()

    // Frame: the dirty range [0,3) — ONE bufferSubData.
    renderer.step(16)
    expect(feed.count.value).toBe(3)
    expect(calls).toContain(`updateBuffer(1,12,0)`) // 12 float, byteOffset 0
    const updates = calls.filter(c => c.startsWith('updateBuffer')).length
    expect(updates).toBe(1) // one call per frame

    // Second frame: +2 records → the dirty range [3,5), byteOffset 48.
    const more = feed.channel!.push(2)
    more.setVec3('position', 0, 9, 9, 9)
    feed.channel!.publish()
    renderer.step(32)
    expect(feed.count.value).toBe(5)
    expect(calls).toContain(`updateBuffer(1,8,48)`) // 8 float, byteOffset 3*16

    // No new records — no upload.
    renderer.step(48)
    expect(calls.filter(c => c.startsWith('updateBuffer')).length).toBe(2)
    renderer.dispose()
  })

  it('vertex path: attribute() gives stride/offset/bufferId, the executor binds the interleaving', () => {
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

    // executor: the feed's external buffer with stride@offset (a 16-byte record interleaving).
    expect(calls).toContain(`bindVertexBuffer(1,0,3,16@0)`)     // position: 3 components @ 0
    expect(calls).toContain(`bindVertexBuffer(1,1,1,16@12)`)    // radius: 1 component @ 12
    // No own buffers are created for feed attributes (an external bufferId).
    expect(calls.filter(c => c.startsWith('createBuffer')).length).toBe(1)
    renderer.dispose()
  })

  it('T3 (msg): applyChunks → mirror → sync with a single bufferSubData, recycle', () => {
    const { renderer, calls } = setup()
    // The render world is the ping-pong reader; the writer is simulated by createMsgFeedWriter.
    const feed = renderer.feed({ layout: LAYOUT, capacity: 8, mode: 'msg' })
    expect(feed.channel).toBeNull() // the writer lives "in the worker"

    // "Worker": writes and sends chunks.
    const writer = createMsgFeedWriter(1, { layout: LAYOUT, capacity: 8 })
    writer.feed.push(2).setVec3('position', 0, 7, 7, 7)
    writer.feed.publish()
    feed.applyChunks(writer.ship())

    renderer.step(16)
    expect(feed.count.value).toBe(2)
    expect(calls).toContain(`updateBuffer(1,8,0)`)

    // Ping-pong: return the buffers to the writer.
    const recycled = feed.takeRecycled()
    expect(recycled.length).toBe(1)
    writer.reclaim(recycled)
    renderer.dispose()
  })

  it('transport binding: renderer.feed(client.feed(id)) — an external SAB-view', () => {
    const { renderer, calls } = setup()
    const transport = createTransport({ mode: 'sab', names: ['game.hp'] })
    // The host transport creates the feed; the renderer binds to the reader's view.
    const hostFeed = transport.host.createFeed({ layout: LAYOUT, capacity: 8 })
    const view = transport.client.feed(1)
    expect(view).not.toBeNull()
    const feed = renderer.feed(view!)
    expect(feed.channel).toBeNull() // the writer is the transport's host
    expect(feed.stride).toBe(STRIDE)

    // A write through the host channel (SAB) is visible to the renderer without a single message.
    hostFeed.push(2).setVec3('position', 0, 5, 5, 5)
    hostFeed.push(0)
    hostFeed.publish()
    renderer.step(16)
    expect(feed.count.value).toBe(2)
    expect(calls).toContain('updateBuffer(1,8,0)') // the dirty range with one call
    renderer.dispose()
  })

  it('renderer.transport: passing the client through + auto-sample at the frame boundary', () => {
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
    expect(hpSeen).toBe(-1) // before the frame boundary — silence
    renderer.step(16)
    expect(hpSeen).toBe(77) // sampleAll on the epoch — notification
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

  it('sync: writeBuffer with a single call per frame, the count signal', async () => {
    const { renderer, calls } = await setup()
    const feed = renderer.feed({ layout: LAYOUT, capacity: 8 })
    expect(feed.channel).not.toBeNull()

    feed.channel!.push(3).setVec3('position', 0, 1, 2, 3)
    feed.channel!.publish()
    renderer.step(16)
    expect(feed.count.value).toBe(3)
    // data.length = 8*4 floats; byteLength = 3 records * 16 bytes = 48.
    expect(calls).toContain('syncVertexBuffer(32,48)')
    expect(calls.filter(c => c.startsWith('syncVertexBuffer')).length).toBe(1)

    feed.channel!.push(2).setFloat('radius', 0, 9)
    feed.channel!.publish()
    renderer.step(32)
    expect(calls).toContain('syncVertexBuffer(32,80)') // [0, 5 records * 16)
    renderer.dispose()
  })

  it('vertex path: a pipeline with rich slots (stride@offset), binding the shared view', async () => {
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

    // Pipeline: interleaving slots [3/16@0 x 1/16@12].
    expect(calls.some(c => c.includes('3/16@0x1/16@12'))).toBe(true)
    // The shared view is bound to both slots (the data is a stable mirror).
    expect(calls).toContain('bindVertexBuffer(0,32,3)')
    expect(calls).toContain('bindVertexBuffer(1,32,1)')
    void command
    renderer.dispose()
  })

  it('renderer.transport: passing the client through + auto-sample at the frame boundary', async () => {
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
