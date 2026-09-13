/**
 * Task 202 — THE HISTORY PASS BRICK: the two-pass HZB's phase 1, pinned on
 * the recording facades. The web-searched technique (Nanite: «the first
 * pass uses the HZB from last frame»; Aaltonen's two-phase occlusion; the
 * CryEngine coverage buffer), implemented with the no-reprojection twist —
 * the previous frame's visible set RE-RENDERED at the current camera.
 *
 *   · THE COMPOSITION (gate on): the prev-visible set draw FIRST (WG: the
 *     compact + the indirect draw over the list the last frame left
 *     behind; GL: the collapse draw over all records), then the occluder
 *     fill merging on top (no clear — the depth test is the merge);
 *   · THE IDENTITY GATE (gate off): the fill ALONE, with the clear — the
 *     recorded frame is CALL-FOR-CALL the depthPass brick's own (the
 *     parity gates' OFF leg stays byte-identical);
 *   · THE SUGAR: hizScene composes the history brick ONLY when the
 *     dictionary carries the `hist` column; frame({ history: true })
 *     routes through it, frame({ history: false }) keeps the Task-201
 *     shape;
 *   · A hist-less scene rides the brick too (the raw flag feed is the
 *     prev-visible set — the hysteresis region is the temporal policy's
 *     home, not the feedback's).
 */

import { describe, expect, it } from 'bun:test'
import { createDevice } from '../src/device.ts'
import type { GlAttrDecl, KernelShaders, PassShaders, SceneLayout } from '../src/device.ts'
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
const WGSL_LIST = `
struct Params { mvp: mat4x4<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@group(2) @binding(0) var<storage, read> scene: array<u32>;
@vertex fn vsMain(@location(0) corner: vec3<f32>, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
  let absIdx = scene[ii];
  let wo = 16u + absIdx * 12u;
  let c = vec3<f32>(bitcast<f32>(scene[wo]), bitcast<f32>(scene[wo + 1u]), bitcast<f32>(scene[wo + 2u]));
  let h = vec3<f32>(bitcast<f32>(scene[wo + 3u]), bitcast<f32>(scene[wo + 4u]), bitcast<f32>(scene[wo + 5u]));
  return params.mvp * vec4(c + h * (corner * 2.0 - 1.0), 1.0);
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
const GLSL_LIST_VS = `#version 300 es
layout(location=0) in vec3 a_corner;
layout(location=1) in vec3 a_c;
layout(location=2) in vec3 a_h;
layout(location=4) in float a_flag;
uniform mat4 u_mvp;
void main() {
  if (floor(a_flag) != 1.0 && floor(a_flag) != 4.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  gl_Position = u_mvp * vec4(a_c + a_h * (a_corner * 2.0 - 1.0), 1.0);
}`

const Z: PassShaders = {
  wg: { code: WGSL_PLAIN, attrs: [3] },
  gl: { vs: GLSL_VS, fs: GLSL_FS, attrs: [], lanes: [{ name: 'u_mvp', kind: 'mat4', words: 16 }] },
}
const HIST: PassShaders = {
  wg: { code: WGSL_LIST, attrs: [3] },
  gl: {
    vs: GLSL_LIST_VS, fs: GLSL_FS,
    attrs: [
      { location: 1, from: 'records', size: 3, stride: 48, offset: 0, divisor: 1 } satisfies GlAttrDecl,
      { location: 2, from: 'records', size: 3, stride: 48, offset: 12, divisor: 1 } satisfies GlAttrDecl,
      { location: 4, from: 'flags', size: 1, stride: 4, offset: 0, divisor: 1 } satisfies GlAttrDecl,
    ],
    lanes: [{ name: 'u_mvp', kind: 'mat4', words: 16 }],
  },
}
const PANEL: PassShaders = {
  wg: {
    code: `struct PanelParams { rect: vec4<f32>, info: vec4<f32> }
@group(0) @binding(0) var<uniform> params: PanelParams;
@vertex fn vsMain(@location(0) q: vec2<f32>) -> @builtin(position) vec4<f32> { return vec4(q, 0.0, 1.0); }
@fragment fn fsMain() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,
    attrs: [2],
  },
  gl: {
    vs: `#version 300 es
layout(location=0) in vec2 a_q;
uniform vec4 u_rect;
void main() { gl_Position = vec4(a_q, 0.0, 1.0); }`,
    fs: GLSL_FS,
    attrs: [],
    lanes: [{ name: 'u_rect', kind: 'vec4', words: 4 }, { name: 'u_info', kind: 'vec4', words: 4 }],
  },
}
const CULL: KernelShaders = {
  wg: {
    code: `struct P { mvp: mat4x4<f32>, misc: vec4<f32> }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read_write> scene: array<u32>;
@group(0) @binding(2) var<storage, read> pyramid: array<f32>;
@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) g: vec3<u32>) { }`,
    entry: 'cull',
    uniformBytes: 80,
  },
  gl: `#version 300 es
layout(location=0) in vec3 a_c;
layout(location=1) in vec3 a_h;
uniform vec4 u_mvp[4];
uniform vec4 u_misc;
out float v_flag;
void main() { v_flag = 1.0; }`,
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

/** the call-for-call compare, NORMALIZED over the program ids (the
 * feedback device builds two programs — the set + the fill — so the fill's
 * handle id differs from depthPass's single one; the MECHANICS — the pass
 * sequence, the binds, the draws — are what must match call for call). */
function normalizedTail(calls: string[], from: number): string[] {
  return calls.slice(from).map(c => c.replace(/use(Pipeline|Program)\(\d+\)/, 'use$1'))
}

describe('Task 202: the history pass — the WebGPU leg', () => {
  it('THE COMPOSITION (gate on): compact → the indirect prev-set draw (clear) → the fill draw (no clear)', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT)
    const pyramid = device.pyramid(8, 8)
    const mesh = device.geometry(BOX, IB)
    const hist = device.historyPass({ scene, mesh, pyramid, shaders: HIST, fill: Z })
    const before = calls.length
    hist.run({ camera: { mvp: MVP }, occluders: 2, gate: true })
    const tail = calls.slice(before)
    // the compact re-runs over the last frame's SMOOTHED verdicts — the
    // same list, the same args, the same indirect draw the color pass owns
    const compactIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',compact,'))
    const indirectIdx = tail.findIndex(c => c === 'drawIndexedIndirect(900003,32)')
    const fillIdx = tail.findIndex(c => c === 'drawIndexed(3,2)')
    expect(compactIdx).toBeGreaterThanOrEqual(0)
    expect(indirectIdx).toBeGreaterThan(compactIdx)
    expect(fillIdx).toBeGreaterThan(indirectIdx)
    // THE CLEAR CONTRACT: the set draw opens the tile's ONE pass with the
    // clear; the fill's re-bind is ELIDED (the facade's skip contract —
    // same target, pass open, no clear) — the fill draws in the SAME open
    // pass, merging through the depth test. One bind, two draws.
    const binds = tail.filter(c => c.startsWith('bindTarget('))
    expect(binds.length).toBe(1)
    expect(binds[0].endsWith(',1)')).toBe(true)
  })

  it('THE IDENTITY GATE (gate off): the recorded frame is CALL-FOR-CALL depthPass\'s own', async () => {
    // two fresh devices: one runs depthPass, the other runs the history
    // brick's identity leg — the recorded calls must be IDENTICAL
    const plain = await wgDevice()
    const plainScene = plain.device.scene(LAYOUT)
    const plainPyramid = plain.device.pyramid(8, 8)
    const plainMesh = plain.device.geometry(BOX, IB)
    const depth = plain.device.depthPass({ scene: plainScene, mesh: plainMesh, shaders: Z, pyramid: plainPyramid })
    const fb = await wgDevice()
    const fbScene = fb.device.scene(LAYOUT)
    const fbPyramid = fb.device.pyramid(8, 8)
    const fbMesh = fb.device.geometry(BOX, IB)
    const hist = fb.device.historyPass({ scene: fbScene, mesh: fbMesh, pyramid: fbPyramid, shaders: HIST, fill: Z })
    const beforePlain = plain.calls.length
    const beforeFb = fb.calls.length
    depth.run({ camera: { mvp: MVP }, occluders: 2 })
    hist.run({ camera: { mvp: MVP }, occluders: 2, gate: false })
    expect(normalizedTail(fb.calls, beforeFb)).toEqual(normalizedTail(plain.calls, beforePlain))
    // the single bind clears the tile — the prepass's own shape
    const binds = fb.calls.slice(beforeFb).filter(c => c.startsWith('bindTarget('))
    expect(binds.length).toBe(1)
    expect(binds[0].endsWith(',1)')).toBe(true)
  })

  it('a hist-less scene rides the brick too (the raw flag feed is the prev set)', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT_NOHIST)
    const pyramid = device.pyramid(8, 8)
    const mesh = device.geometry(BOX, IB)
    const hist = device.historyPass({ scene, mesh, pyramid, shaders: HIST, fill: Z })
    const before = calls.length
    hist.run({ camera: { mvp: MVP }, occluders: 1, gate: true })
    expect(calls.slice(before).some(c => c === 'drawIndexedIndirect(900003,32)')).toBe(true)
  })
})

describe('Task 202: the history pass — the WebGL2 leg', () => {
  it('THE COMPOSITION (gate on): the collapse set draw (clear) → the fill draw (no clear), the two-element sequence', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT)
    const pyramid = device.pyramid(8, 8)
    const mesh = device.geometry(BOX, IB)
    const hist = device.historyPass({ scene, mesh, pyramid, shaders: HIST, fill: Z })
    const before = calls.length
    hist.run({ camera: { mvp: MVP }, occluders: 2, gate: true })
    const tail = calls.slice(before)
    // the collapse draw over ALL 4 records (the flag feed), then the fill
    // over the 2 occluders — two drawElements, in that order
    const draws = tail.filter(c => c.startsWith('drawElements('))
    expect(draws.length).toBe(2)
    expect(draws[0].includes(',3,4,u16')).toBe(true) // the prev-visible set
    expect(draws[1].includes(',3,2,u16')).toBe(true) // the occluder fill
  })

  it('THE IDENTITY GATE (gate off): the recorded frame is CALL-FOR-CALL depthPass\'s own', async () => {
    const plain = await glDevice()
    const plainScene = plain.device.scene(LAYOUT)
    const plainPyramid = plain.device.pyramid(8, 8)
    const plainMesh = plain.device.geometry(BOX, IB)
    const depth = plain.device.depthPass({ scene: plainScene, mesh: plainMesh, shaders: Z, pyramid: plainPyramid })
    const fb = await glDevice()
    const fbScene = fb.device.scene(LAYOUT)
    const fbPyramid = fb.device.pyramid(8, 8)
    const fbMesh = fb.device.geometry(BOX, IB)
    const hist = fb.device.historyPass({ scene: fbScene, mesh: fbMesh, pyramid: fbPyramid, shaders: HIST, fill: Z })
    const beforePlain = plain.calls.length
    const beforeFb = fb.calls.length
    depth.run({ camera: { mvp: MVP }, occluders: 2 })
    hist.run({ camera: { mvp: MVP }, occluders: 2, gate: false })
    expect(normalizedTail(fb.calls, beforeFb)).toEqual(normalizedTail(plain.calls, beforePlain))
  })

  it('a hist-less scene reads the RAW flag feed (no hist buffers were created)', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT_NOHIST)
    const pyramid = device.pyramid(8, 8)
    const mesh = device.geometry(BOX, IB)
    const hist = device.historyPass({ scene, mesh, pyramid, shaders: HIST, fill: Z })
    const before = calls.length
    hist.run({ camera: { mvp: MVP }, occluders: 1, gate: true })
    // the collapse draw over all 4 records happened — the raw flag buffer
    // is the feed; only the flag buffer exists (no hist pair)
    expect(calls.slice(before).some(c => c.startsWith('drawElements(') && c.includes(',3,4,u16'))).toBe(true)
    expect(calls.filter(c => c === 'createBuffer(4,dynamic)').length).toBe(1)
  })
})

describe('Task 202: the scenario sugar — the hist column composes the feedback', () => {
  it('hizScene with the hist column routes frame({ history: true }) through the feedback brick', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT)
    const hiz = device.hizScene({
      scene,
      shaders: { z: Z, color: Z, panel: PANEL, hist: HIST, cull: CULL },
      geometry: device.geometry(BOX, IB),
      pyramid: { width: 8, height: 8 },
    })
    const before = calls.length
    hiz.frame({ target: 0, camera: { mvp: MVP, eye: EYE }, occluders: 2, history: true })
    const tail = calls.slice(before)
    // the feedback ran: the compact + the indirect prev-set draw BEFORE the
    // cull kernel (the pyramid the kernel reads was built from the set)
    const compactIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',compact,'))
    const indirectIdx = tail.findIndex(c => c === 'drawIndexedIndirect(900003,32)')
    const cullIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',cull,'))
    const fillIdx = tail.findIndex(c => c === 'drawIndexed(3,2)')
    expect(compactIdx).toBeGreaterThanOrEqual(0)
    expect(indirectIdx).toBeGreaterThan(compactIdx)
    expect(fillIdx).toBeGreaterThan(indirectIdx)
    expect(cullIdx).toBeGreaterThan(fillIdx)
  })

  it('frame({ history: false }) keeps the Task-201 shape (no second draw before the cull)', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT)
    const hiz = device.hizScene({
      scene,
      shaders: { z: Z, color: Z, panel: PANEL, hist: HIST, cull: CULL },
      geometry: device.geometry(BOX, IB),
      pyramid: { width: 8, height: 8 },
    })
    const before = calls.length
    hiz.frame({ target: 0, camera: { mvp: MVP, eye: EYE }, occluders: 2, history: false })
    const tail = calls.slice(before)
    // ONE drawIndexed before the cull (the plain fill) — the feedback's
    // indirect draw is absent
    const fillIdx = tail.findIndex(c => c === 'drawIndexed(3,2)')
    const cullIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',cull,'))
    expect(fillIdx).toBeGreaterThanOrEqual(0)
    expect(cullIdx).toBeGreaterThan(fillIdx)
    expect(tail.slice(0, cullIdx).some(c => c === 'drawIndexedIndirect(900003,32)')).toBe(false)
  })

  it('a dictionary WITHOUT the hist column composes no feedback (the Task-200 recipe)', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT)
    const hiz = device.hizScene({
      scene,
      shaders: { z: Z, color: Z, panel: PANEL, cull: CULL },
      geometry: device.geometry(BOX, IB),
      pyramid: { width: 8, height: 8 },
    })
    const before = calls.length
    // history: true on a dict that carries no hist column — the honest
    // fallback is the plain prepass (the brick was never composed)
    hiz.frame({ target: 0, camera: { mvp: MVP, eye: EYE }, occluders: 2, history: true })
    const tail = calls.slice(before)
    const cullIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',cull,'))
    expect(cullIdx).toBeGreaterThanOrEqual(0)
    expect(tail.slice(0, cullIdx).some(c => c === 'drawIndexedIndirect(900003,32)')).toBe(false)
  })
})
