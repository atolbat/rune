/**
 * Task 200 — THE SCENARIO BRICK (hizScene): the dictionary + the handles
 * become a one-call frame. These tests pin the composition contract on the
 * recording facades:
 *
 *   · the BUILD: three programs from the dictionary (z / color / panel) +
 *     the culler — the same bricks the tier used to hand-assemble;
 *   · THE FRAME: the whole recipe in order (the z prepass over the POLICY
 *     count → the pyramid reduce → the cull kernel → the compact → the
 *     indirect/collapse draw), the packed block SIZES (16 / 20 / 28 words
 *     — the lane contract), and the pyramid debug strip (one quad per
 *     level, only when asked);
 *   · the SURFACE: the spec's {w, h} becomes the readback channel;
 *   · readStats routes to the scene's own counters.
 */

import { describe, expect, it } from 'bun:test'
import { createDevice } from '../src/device.ts'
import type { HizShaderDict, HizSceneFrame, HizSceneSpec, SceneLayout } from '../src/device.ts'
import { createRecordingGPU } from '@rune/webgpu'
import { createRecordingGL } from '@rune/webgl2'
import type { GPUFacade } from '@rune/webgpu'
import type { GLFacade } from '@rune/webgl2'

const WORDS = new Uint32Array(8 + 4 * 12) // [list 8 | flags 4 | records 4×12]
const RECORDS = new Float32Array(WORDS.buffer).subarray(8) as Float32Array
const LAYOUT: SceneLayout = {
  total: 4,
  occluders: 1,
  words: WORDS,
  recordsF32: RECORDS,
  flagsWord: 8,
  recordsWord: 12,
}

const WGSL_PLAIN = `
struct Params { mvp: mat4x4<f32>, misc: vec4<f32>, light: vec4<f32>, cam: vec4<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@group(2) @binding(0) var<storage, read> scene: array<u32>;
@vertex fn vsMain(@location(0) corner: vec3<f32>, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
  return params.mvp * vec4<f32>(corner, 1.0);
}
@fragment fn fsMain() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`
const WGSL_QUAD = `
struct PanelParams { rect: vec4<f32>, info: vec4<f32> }
@group(0) @binding(0) var<uniform> params: PanelParams;
@vertex fn vsMain(@location(0) q: vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(q, 0.0, 1.0);
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

const CULL_WGSL = `struct P { mvp: mat4x4<f32> }
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

/** The minimal scenario dictionary — the demo's buildShaders() shape. */
const DICT: HizShaderDict = {
  z: {
    wg: { code: WGSL_PLAIN, attrs: [3] },
    gl: { vs: GLSL_VS, fs: GLSL_FS, attrs: [], lanes: [{ name: 'u_mvp', kind: 'mat4', words: 16 }] },
  },
  color: {
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
  },
  panel: {
    wg: { code: WGSL_QUAD, attrs: [2] },
    gl: {
      vs: GLSL_QUAD_VS, fs: GLSL_QUAD_FS, attrs: [],
      lanes: [
        { name: 'u_rect', kind: 'vec4', words: 4 },
        { name: 'u_info', kind: 'vec4', words: 4 },
      ],
    },
  },
  cull: {
    wg: { code: CULL_WGSL, entry: 'cull', uniformBytes: 80 },
    gl: CULL_GLSL,
    lanes: [{ name: 'u_mvp[0]' }, { name: 'u_mvp[1]' }, { name: 'u_mvp[2]' }, { name: 'u_mvp[3]' }, { name: 'u_misc' }],
  },
}

const BOX = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0])
const IB = new Uint16Array([0, 1, 2])
const MVP = new Float32Array(16)
const EYE = [1, 2, 3]

// the fake renderers carry the Task-200 service boundary (the GL submit
// calls it — the manual-frame channel that replaced the destructive step)
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

function specOf(device: Awaited<ReturnType<typeof wgDevice>>['device']): HizSceneSpec {
  return {
    scene: device.scene(LAYOUT),
    shaders: DICT,
    geometry: device.geometry(BOX, IB),
    pyramid: { width: 8, height: 8 },
    surface: { width: 4, height: 4 },
    light: [0.5, 0.8, 0.35],
  }
}

const FRAME_BASE: HizSceneFrame = { target: 0, camera: { mvp: MVP, eye: EYE } }

describe('Task 200: hizScene — the scenario brick, the WebGPU leg', () => {
  it('ONE frame(): the recipe order + the packed block sizes (the lane contract)', async () => {
    const { device, calls } = await wgDevice()
    const hiz = device.hizScene(specOf(device))
    const before = calls.length
    hiz.frame({ ...FRAME_BASE, occluders: 2 })
    const tail = calls.slice(before)
    // THE RECIPE: the z-prepass draw (2 instances — the POLICY), the reduce
    // family, the cull kernel, the compact, then the indirect draw
    const prepassIdx = tail.findIndex(c => c === 'drawIndexed(3,2)')
    const reduceIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',zToMip0,'))
    const cullIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',cull,'))
    const compactIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',compact,'))
    const indirectIdx = tail.findIndex(c => c === 'drawIndexedIndirect(900003,32)')
    expect(prepassIdx).toBeGreaterThanOrEqual(0)
    expect(reduceIdx).toBeGreaterThan(prepassIdx)
    expect(cullIdx).toBeGreaterThan(reduceIdx)
    expect(compactIdx).toBeGreaterThan(cullIdx)
    expect(indirectIdx).toBeGreaterThan(compactIdx)
    // THE LANE CONTRACT: z 16 words (64B) at arena slot 0 · color 28 words
    // (112B) at the next 256-aligned slot (the cull's 20-word block rides
    // the compute facade's own uniform channel — see the cull runCompute)
    expect(tail).toContain('uploadUniforms(0,64)')
    expect(tail).toContain('uploadUniforms(256,112)')
    expect(tail.some(c => c.startsWith('runCompute(') && c.includes(',cull,20,'))).toBe(true)
  })

  it('the default policy is the scene\'s own occluders; the debug strip is opt-in', async () => {
    const { device, calls } = await wgDevice()
    const hiz = device.hizScene(specOf(device))
    const before = calls.length
    hiz.frame(FRAME_BASE)
    const tail = calls.slice(before)
    // the boot policy: LAYOUT.occluders = 1 → drawIndexed(3,1)
    expect(tail).toContain('drawIndexed(3,1)')
    // no panel quads unless asked
    expect(tail.some(c => c === 'draw(6,1)')).toBe(false)
    const before2 = calls.length
    hiz.frame({ ...FRAME_BASE, pyramidView: true })
    const tail2 = calls.slice(before2)
    // ONE 6-vertex quad per pyramid level (8×8 → 4 levels) — the reduce
    // family is COMPUTE on this leg, so every draw(6,1) is a panel
    expect(tail2.filter(c => c === 'draw(6,1)').length).toBe(4)
    expect(tail2.some(c => c.startsWith('uploadUniforms(') && c.endsWith(',32)'))).toBe(true) // a panel block (8 words)
  })

  it('the spec\'s surface becomes the readback channel; readStats routes to the counters', async () => {
    const { device, calls } = await wgDevice()
    const hiz = device.hizScene(specOf(device))
    expect(hiz.surface).not.toBe(null)
    expect(hiz.surface?.targetId).toBe(7)
    expect(hiz.surface?.width).toBe(4)
    await hiz.readStats().catch(() => undefined)
    expect(calls).toContain('readExternalBuffer(900003)')
    // a frame onto the surface keeps the mirror lane honest (the GL dither
    // twin reads it; WG ignores the lane — the BLOCK is the same either way)
    const before = calls.length
    hiz.frame({ ...FRAME_BASE, target: 7 })
    const tail = calls.slice(before)
    expect(tail).toContain('bindTarget(7,1)')
  })
})

describe('Task 200: hizScene — the scenario brick, the WebGL2 leg', () => {
  it('ONE frame(): the prepass POLICY count → the reduce quads → the TF cull → the collapse draw', async () => {
    const { device, calls } = await glDevice()
    const hiz = device.hizScene(specOf(device))
    const before = calls.length
    hiz.frame({ ...FRAME_BASE, occluders: 2 })
    const tail = calls.slice(before)
    // the build: THREE programs from the dictionary + the culler's pass
    expect(calls.filter(c => c.startsWith('createProgram(')).length).toBeGreaterThanOrEqual(3)
    expect(calls.some(c => c.startsWith('createTransformPass('))).toBe(true)
    // THE RECIPE: the prepass (2 instances), the reduce strip, the cull, the
    // collapse draw over ALL records — in order
    const prepassIdx = tail.findIndex(c => c.startsWith('drawElements(') && c.includes(',3,2,u16'))
    const reduceIdx = tail.findIndex(c => c === 'drawArrays(triangle-strip,0,4,1)')
    const cullIdx = tail.findIndex(c => c.startsWith('runTransformPass('))
    const visibleIdx = tail.findIndex(c => c.startsWith('drawElements(') && c.includes(',3,4,u16'))
    expect(prepassIdx).toBeGreaterThanOrEqual(0)
    expect(reduceIdx).toBeGreaterThan(prepassIdx)
    expect(cullIdx).toBeGreaterThan(reduceIdx)
    expect(visibleIdx).toBeGreaterThan(cullIdx)
    // the pass states: the depth passes cull the back faces (the winding
    // contract), the panels ride with depth 'always'
    expect(tail).toContain('setCull(back)')
  })

  it('the canvas frame clears explicitly; the debug strip quads ride the levels', async () => {
    const { device, calls } = await glDevice()
    const hiz = device.hizScene(specOf(device))
    const before = calls.length
    hiz.frame(FRAME_BASE)
    const tail = calls.slice(before)
    expect(tail).toContain('bindTarget(0,0)')
    expect(tail).toContain('clear(0.045,0.055,0.09,1;1)')
    const before2 = calls.length
    hiz.frame({ ...FRAME_BASE, pyramidView: true })
    const tail2 = calls.slice(before2)
    // the recipe's OWN strip quads (the 3 reduce passes) come FIRST; the
    // FOUR panel quads ride AFTER the visible draw
    const visibleIdx = tail2.findIndex(c => c.startsWith('drawElements(') && c.includes(',3,4,u16'))
    expect(visibleIdx).toBeGreaterThanOrEqual(0)
    const afterVisible = tail2.slice(visibleIdx)
    expect(afterVisible.filter(c => c === 'drawArrays(triangle-strip,0,4,1)').length).toBe(4)
  })

  it('readStats routes to the flag sweep; the surface rides the renderer\'s own', async () => {
    const { device, calls } = await glDevice()
    const hiz = device.hizScene(specOf(device))
    expect(hiz.surface?.targetId).toBe(9)
    await hiz.readStats().catch(() => undefined)
    expect(calls).toContain('readBuffer(2,4)')
  })
})

describe('Task 200: hizScene — the honest refusals', () => {
  it('a foreign scene handle (another device\'s) throws through the bricks', async () => {
    const a = await wgDevice()
    const b = await wgDevice()
    const spec = specOf(b.device)
    expect(() => a.device.hizScene({ ...spec, scene: spec.scene })).toThrow('not this device')
  })
})
