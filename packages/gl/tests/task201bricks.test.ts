/**
 * Task 201 — THE PASS BRICKS: the composable frame, pinned on the recording
 * facades. The user's ask («кирпичи, из которых я мог бы создать данный
 * куллинг — не одной строкой, а комбинацией фич») made a test:
 *
 *   · THE COMPOSITION: depthPass → pyramid.build() → occlusionPass →
 *     hysteresisPass → visiblePass (+ debugStrip) — each brick its own
 *     recorded pass, the scenario's recipe the ORDER of their run() calls;
 *   · THE LANE CONTRACT: each brick packs its own block (z 16 words / cull
 *     20 / color 28 / panel 8) — the scenario passes semantics, never
 *     offsets (the arena slots stay the Task-200 shape);
 *   · THE HYSTERESIS: a scene WITH a hist region gains the temporal pass
 *     (WG: one more compute; GL: one more transform pass, the hist pair
 *     ping-ponging) between the cull and the draw; a scene WITHOUT the
 *     region refuses honestly and the recorded frame stays the pre-201
 *     shape (byte-identical);
 *   · readVerdicts routes to the raw-verdict channel.
 */

import { describe, expect, it } from 'bun:test'
import { createDevice } from '../src/device.ts'
import type { KernelShaders, PassShaders, SceneLayout, SceneHandle } from '../src/device.ts'
import { createRecordingGPU } from '@rune/webgpu'
import { createRecordingGL } from '@rune/webgl2'
import type { GPUFacade } from '@rune/webgpu'
import type { GLFacade } from '@rune/webgl2'

const WORDS = new Uint32Array(8 + 4 + 4 + 4 * 12) // [list 8 | flags 4 | hist 4 | records 4×12]
const RECORDS = new Float32Array(WORDS.buffer).subarray(16) as Float32Array
const LAYOUT: SceneLayout = {
  total: 4,
  occluders: 1,
  words: WORDS,
  recordsF32: RECORDS,
  flagsWord: 8,
  histWord: 12,
  recordsWord: 16,
}
const LAYOUT_NOHIST: SceneLayout = {
  total: 4,
  occluders: 1,
  words: new Uint32Array(8 + 4 * 12),
  recordsF32: new Float32Array(new Uint32Array(8 + 4 * 12).buffer).subarray(8) as Float32Array,
  flagsWord: 8,
  recordsWord: 12,
}

const WGSL_PLAIN = `
struct Params { mvp: mat4x4<f32>, misc: vec4<f32>, light: vec4<f32>, cam: vec4<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@group(2) @binding(0) var<storage, read> scene: array<u32>;
@vertex fn vsMain(@location(0) corner: vec3<f32>, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
  return params.mvp * vec4(corner, 1.0);
}
@fragment fn fsMain() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`
const WGSL_QUAD = `
struct PanelParams { rect: vec4<f32>, info: vec4<f32> }
@group(0) @binding(0) var<uniform> params: PanelParams;
@vertex fn vsMain(@location(0) q: vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4(q, 0.0, 1.0);
}
@fragment fn fsMain() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`
const GLSL_VS = `#version 300 es
layout(location=0) in vec3 a_corner;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_corner, 1.0); }`
const GLSL_FS = `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(1.0); }`
const GLSL_QUAD_VS = `#version 300 es
layout(location=0) in vec2 a_q;
uniform vec4 u_rect;
void main() { gl_Position = vec4(a_q, 0.0, 1.0); }`
const GLSL_QUAD_FS = `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(1.0); }`

const CULL_WGSL = `struct P { mvp: mat4x4<f32>, misc: vec4<f32> }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read_write> scene: array<u32>;
@group(0) @binding(2) var<storage, read> pyramid: array<f32>;
@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) g: vec3<u32>) { }`
const CULL_GLSL = `#version 300 es
layout(location=0) in vec3 a_c;
layout(location=1) in vec3 a_h;
uniform vec4 u_mvp[4];
uniform vec4 u_misc;
out float v_flag;
void main() { v_flag = 1.0; }`

const Z: PassShaders = {
  wg: { code: WGSL_PLAIN, attrs: [3] },
  gl: { vs: GLSL_VS, fs: GLSL_FS, attrs: [], lanes: [{ name: 'u_mvp', kind: 'mat4', words: 16 }] },
}
const COLOR: PassShaders = {
  wg: { code: WGSL_PLAIN, attrs: [3] },
  gl: {
    vs: GLSL_VS, fs: GLSL_FS, attrs: [],
    lanes: [
      { name: 'u_mvp', kind: 'mat4', words: 16 },
      { name: 'u_misc', kind: 'vec4', words: 4 },
      { name: 'u_light', kind: 'vec4', words: 4 },
      { name: 'u_cam', kind: 'vec4', words: 4 },
    ],
  },
}
const PANEL: PassShaders = {
  wg: { code: WGSL_QUAD, attrs: [2] },
  gl: {
    vs: GLSL_QUAD_VS, fs: GLSL_QUAD_FS, attrs: [],
    lanes: [
      { name: 'u_rect', kind: 'vec4', words: 4 },
      { name: 'u_info', kind: 'vec4', words: 4 },
    ],
  },
}
const CULL: KernelShaders = {
  wg: { code: CULL_WGSL, entry: 'cull', uniformBytes: 80 },
  gl: CULL_GLSL,
  lanes: [{ name: 'u_mvp[0]' }, { name: 'u_mvp[1]' }, { name: 'u_mvp[2]' }, { name: 'u_mvp[3]' }, { name: 'u_misc' }],
}

const BOX = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0])
const IB = new Uint16Array([0, 1, 2])
const MVP = new Float32Array(16)
const EYE = [1, 2, 3]

function fakeWgRenderer(gpu: GPUFacade): unknown {
  return {
    gpu,
    surface: () => ({ targetId: 7, read: () => Promise.resolve({ width: 4, height: 4, data: new Uint8Array(64) }) }),
    dispose: () => {},
    step: () => {},
    service: () => {},
    resize: () => {},
  }
}
function fakeGlRenderer(gl: GLFacade): unknown {
  return {
    gl,
    surface: () => ({ targetId: 9, read: () => Promise.resolve({ width: 4, height: 4, data: new Uint8Array(64) }) }),
    dispose: () => {},
    step: () => {},
    service: () => {},
  }
}

async function wgDevice() {
  const recording = createRecordingGPU()
  const device = await createDevice({
    backend: 'webgpu',
    canvas: { width: 64, height: 111 } as never,
    clear: { color: [0.045, 0.055, 0.09, 1] },
    createWgRenderer: (async () => fakeWgRenderer(recording.gpu)) as never,
  })
  return { device, calls: recording.calls }
}
async function glDevice() {
  const recording = createRecordingGL()
  const device = await createDevice({
    backend: 'webgl2',
    canvas: { width: 64, height: 111 } as never,
    clear: { color: [0.045, 0.055, 0.09, 1] },
    createGlRenderer: (() => fakeGlRenderer(recording.gl)) as never,
  })
  return { device, calls: recording.calls }
}

/** THE COMPOSITION — the five bricks, the scenario's own recipe. */
function composeBricks(device: Awaited<ReturnType<typeof wgDevice>>['device'], scene: SceneHandle) {
  const pyramid = device.pyramid(8, 8)
  const mesh = device.geometry(BOX, IB)
  const depth = device.depthPass({ scene, mesh, shaders: Z, pyramid })
  const occl = device.occlusionPass({ scene, pyramid, kernel: CULL })
  const smooth = device.hysteresisPass({ scene, frames: 3 })
  const color = device.visiblePass({ scene, mesh, shaders: COLOR })
  const strip = device.debugStrip({ pyramid, shaders: PANEL })
  return {
    pyramid, mesh, depth, occl, smooth, color, strip,
    frame(call: { camera: { mvp: ArrayLike<number>; eye: ArrayLike<number> }; occluders?: number; gate?: boolean; hyst?: boolean; debug?: boolean; target?: number }) {
      const { camera, occluders = 2, gate = true, hyst = false, debug = false, target = 0 } = call
      depth.run({ camera, occluders })
      pyramid.build()
      occl.run({ camera, gate })
      smooth.run({ gate: hyst })
      color.run({ target, camera, light: [0.5, 0.8, 0.35] })
      if (debug) strip.run({ target })
    },
  }
}

describe('Task 201: the pass bricks — the WebGPU leg', () => {
  it('THE COMPOSITION: prepass → reduce → cull → hysteresis → compact → indirect, in order', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT)
    const bricks = composeBricks(device, scene)
    const before = calls.length
    bricks.frame({ camera: { mvp: MVP, eye: EYE }, occluders: 2 })
    const tail = calls.slice(before)
    const prepassIdx = tail.findIndex(c => c === 'drawIndexed(3,2)')
    const reduceIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',spd,'))
    const cullIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',cull,'))
    const hystIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',hysteresis,'))
    const compactIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',compact,'))
    const indirectIdx = tail.findIndex(c => c === 'drawIndexedIndirect(900003,32)')
    expect(prepassIdx).toBeGreaterThanOrEqual(0)
    expect(reduceIdx).toBeGreaterThan(prepassIdx)
    expect(cullIdx).toBeGreaterThan(reduceIdx)
    expect(hystIdx).toBeGreaterThan(cullIdx)
    expect(compactIdx).toBeGreaterThan(hystIdx)
    expect(indirectIdx).toBeGreaterThan(compactIdx)
    // THE LANE CONTRACT — the bricks pack their own blocks (z 16 words at
    // arena slot 0; color 28 words at the next 256-aligned slot)
    expect(tail).toContain('uploadUniforms(0,64)')
    expect(tail).toContain('uploadUniforms(256,112)')
    expect(tail.some(c => c.startsWith('runCompute(') && c.includes(',cull,20,'))).toBe(true)
    // the hysteresis kernel's u32 block: 4 words, N=4 workgroups
    expect(tail.some(c => c.startsWith('runCompute(') && c.includes(',hysteresis,4,'))).toBe(true)
  })

  it('the debug strip is a composable brick (opt-in, after the visible draw)', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT)
    const bricks = composeBricks(device, scene)
    const before = calls.length
    bricks.frame({ camera: { mvp: MVP, eye: EYE }, debug: true })
    const tail = calls.slice(before)
    const indirectIdx = tail.findIndex(c => c === 'drawIndexedIndirect(900003,32)')
    expect(indirectIdx).toBeGreaterThanOrEqual(0)
    // 8×8 pyramid → 4 levels → 4 panel quads, after the visible draw
    expect(tail.slice(indirectIdx).filter(c => c === 'draw(6,1)').length).toBe(4)
  })

  it('readVerdicts routes to the scene storage\'s raw-verdict slice', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT)
    await device.readVerdicts(scene).catch(() => undefined)
    // the flags region [8, 12) — the readback asks for (8+4)*4 bytes
    expect(calls.some(c => c.startsWith('readExternalBuffer(') && c.endsWith(',48)') || c.startsWith('readExternalBuffer(') && c.includes('900001'))).toBe(true)
  })
})

describe('Task 201: the pass bricks — the WebGL2 leg', () => {
  it('THE COMPOSITION: prepass → reduce quads → TF cull → TF hysteresis → collapse draw', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT)
    const bricks = composeBricks(device, scene)
    const before = calls.length
    bricks.frame({ camera: { mvp: MVP, eye: EYE }, occluders: 2 })
    const tail = calls.slice(before)
    const prepassIdx = tail.findIndex(c => c.startsWith('drawElements(') && c.includes(',3,2,u16'))
    const reduceIdx = tail.findIndex(c => c === 'drawArrays(triangle-strip,0,4,1)')
    const tfIdx = tail.map((c, i) => c.startsWith('runTransformPass(') ? i : -1).filter(i => i >= 0)
    const visibleIdx = tail.findIndex(c => c.startsWith('drawElements(') && c.includes(',3,4,u16'))
    expect(prepassIdx).toBeGreaterThanOrEqual(0)
    expect(reduceIdx).toBeGreaterThan(prepassIdx)
    expect(tfIdx.length).toBe(2) // the cull pass + the temporal pass
    expect(tfIdx[0]).toBeGreaterThan(reduceIdx)
    expect(tfIdx[1]).toBeGreaterThan(tfIdx[0])
    expect(visibleIdx).toBeGreaterThan(tfIdx[1])
    // the hist pair rides the scene (two dynamic buffers over the total)
    expect(calls.filter(c => c === 'createBuffer(4,dynamic)').length).toBeGreaterThanOrEqual(2)
  })

  it('the hysteresis pass ping-pongs (the two TF passes alternate output buffers)', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT)
    const bricks = composeBricks(device, scene)
    const before = calls.length
    bricks.frame({ camera: { mvp: MVP, eye: EYE } })
    bricks.frame({ camera: { mvp: MVP, eye: EYE } })
    const tail = calls.slice(before)
    const tfs = tail.filter(c => c.startsWith('runTransformPass('))
    expect(tfs.length).toBe(4)
    // the temporal passes (the 2nd and 4th TF calls) write different
    // buffers across the two frames — the ping-pong contract
    const bufOf = (s: string) => Number(s.match(/buf:(\d+)/)?.[1] ?? -1)
    const hyst1 = bufOf(tfs[1])
    const hyst2 = bufOf(tfs[3])
    expect(hyst1).not.toBe(hyst2)
  })

  it('readVerdicts routes to the flag-buffer sweep', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT)
    await device.readVerdicts(scene).catch(() => undefined)
    expect(calls).toContain('readBuffer(2,4)')
  })
})

describe('Task 201: the honest refusals + the byte-identical no-hist frame', () => {
  it('hysteresisPass refuses a scene without a hist region', async () => {
    const { device } = await wgDevice()
    const scene = device.scene(LAYOUT_NOHIST)
    expect(() => device.hysteresisPass({ scene, frames: 3 })).toThrow('no hist region')
    const gl = await glDevice()
    const glScene = gl.device.scene(LAYOUT_NOHIST)
    expect(() => gl.device.hysteresisPass({ scene: glScene, frames: 3 })).toThrow('no hist region')
  })

  it('a hist-less scene records the pre-201 frame shape (no temporal pass, one TF)', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT_NOHIST)
    const pyramid = device.pyramid(8, 8)
    const mesh = device.geometry(BOX, IB)
    const depth = device.depthPass({ scene, mesh, shaders: Z, pyramid })
    const occl = device.occlusionPass({ scene, pyramid, kernel: CULL })
    const color = device.visiblePass({ scene, mesh, shaders: COLOR })
    const before = calls.length
    depth.run({ camera: { mvp: MVP }, occluders: 2 })
    pyramid.build()
    occl.run({ camera: { mvp: MVP }, gate: true })
    color.run({ target: 0, camera: { mvp: MVP, eye: EYE } })
    const tail = calls.slice(before)
    // exactly ONE transform pass (the cull) — no temporal machinery
    expect(tail.filter(c => c.startsWith('runTransformPass(')).length).toBe(1)
    // no hist buffers were created for the scene
    expect(calls.filter(c => c === 'createBuffer(4,dynamic)').length).toBe(1) // the flag buffer only
  })

  it('hizScene on a hist-less scene composes NO smoothing (the Task-200 shape)', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT_NOHIST)
    const hiz = device.hizScene({
      scene,
      shaders: { z: Z, color: COLOR, panel: PANEL, cull: CULL },
      geometry: device.geometry(BOX, IB),
      pyramid: { width: 8, height: 8 },
    })
    const before = calls.length
    hiz.frame({ target: 0, camera: { mvp: MVP, eye: EYE }, occluders: 2 })
    const tail = calls.slice(before)
    // no hysteresis compute in the recipe
    expect(tail.some(c => c.startsWith('runCompute(') && c.includes(',hysteresis,'))).toBe(false)
    // the Task-200 order holds (prepass → reduce → cull → compact → indirect)
    const prepassIdx = tail.findIndex(c => c === 'drawIndexed(3,2)')
    const cullIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',cull,'))
    const compactIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',compact,'))
    expect(prepassIdx).toBeGreaterThanOrEqual(0)
    expect(cullIdx).toBeGreaterThan(prepassIdx)
    expect(compactIdx).toBeGreaterThan(cullIdx)
  })
})
