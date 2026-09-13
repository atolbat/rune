/**
 * Task 198 — THE COMMON BRICKS (device.ts): one facade, two backends, one
 * demo syntax. These tests pin the brick CONTRACTS on the recording
 * facades (the renderer objects are injected — the same channel the demos
 * would use for a headless boot):
 *
 *   WG leg: scene → ONE storage buffer over the words + the compact family;
 *           drawInstanced → bindStorageBuffer + drawIndexed (the storage-
 *           fetch feed); drawVisible → runCompute(compact) THEN
 *           drawIndexedIndirect (the compute-before-pass contract);
 *           drawQuad → the 6-vertex list + bindTexture; pyramid → the
 *           per-level r32f targets + the FBO reduce pipeline.
 *   GL leg: scene → the records buffer + the flag buffer; drawInstanced →
 *           the divisor attribute feed + drawElements; drawVisible →
 *           drawElements over ALL records (the collapse); culler → ONE
 *           transform pass with the neutral canvas target first (the
 *           feedback-loop lesson); readCullStats → the CPU sweep.
 *   The unified surface + the clear semantics: the GL canvas bind is
 *   followed by the explicit clear (the facade's canvas bind does not).
 */

import { describe, expect, it } from 'bun:test'
import { createDevice } from '../src/device.ts'
import type { SceneLayout, ProgramSpec, CullerSpec } from '../src/device.ts'
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
struct Params { mvp: mat4x4<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@group(2) @binding(0) var<storage, read> scene: array<u32>;
@vertex fn vsMain(@location(0) corner: vec3<f32>, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
  return params.mvp * vec4<f32>(corner, 1.0);
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

const CULL_WGSL = `struct P { mvp: mat4x4<f32> }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read_write> scene: array<u32>;
@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) g: vec3<u32>) { }`

const CULL_GLSL = `#version 300 es
layout(location=0) in vec3 a_c;
uniform vec4 u_mvp[4];
out float v_flag;
void main() { v_flag = 1.0; }`

function fakeWgRenderer(gpu: GPUFacade): unknown {
  return {
    gpu,
    surface: () => ({ targetId: 7, read: () => Promise.resolve({ width: 4, height: 4, data: new Uint8Array(64) }) }),
    dispose: () => {},
    step: () => {},
    resize: () => {},
  }
}

function fakeGlRenderer(gl: GLFacade): unknown {
  return {
    gl,
    surface: () => ({ targetId: 9, read: () => Promise.resolve({ width: 4, height: 4, data: new Uint8Array(64) }) }),
    dispose: () => {},
    step: () => {},
  }
}

const BOX = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0])
const IB = new Uint16Array([0, 1, 2])

async function wgDevice() {
  const recording = createRecordingGPU()
  const device = await createDevice({
    backend: 'webgpu',
    canvas: {} as never,
    clear: { color: [0.045, 0.055, 0.09, 1] },
    createWgRenderer: (async () => fakeWgRenderer(recording.gpu)) as never,
  })
  return { device, calls: recording.calls }
}

async function glDevice() {
  const recording = createRecordingGL()
  const device = await createDevice({
    backend: 'webgl2',
    canvas: {} as never,
    clear: { color: [0.045, 0.055, 0.09, 1] },
    createGlRenderer: (() => fakeGlRenderer(recording.gl)) as never,
  })
  return { device, calls: recording.calls }
}

const PROG_SPEC: ProgramSpec = {
  depth: { test: 'less', write: true },
  wg: { code: WGSL_PLAIN, attrs: [3] },
  gl: {
    vs: GLSL_VS,
    fs: GLSL_FS,
    attrs: [
      { location: 0, from: 'geometry', size: 3, stride: 12, offset: 0, divisor: 0 },
      { location: 1, from: 'records', size: 3, stride: 48, offset: 0, divisor: 1 },
    ],
    lanes: [{ name: 'u_mvp', kind: 'mat4', words: 16 }],
  },
}

const CULLER_SPEC: CullerSpec = {
  wgsl: CULL_WGSL,
  glsl: CULL_GLSL,
  lanes: [{ name: 'u_mvp[0]' }, { name: 'u_mvp[1]' }, { name: 'u_mvp[2]' }, { name: 'u_mvp[3]' }, { name: 'u_misc' }],
  uniformBytes: 80,
}

const U16 = new Float32Array(16)

describe('Task 198: the common bricks — the WebGPU leg', () => {
  it('scene → ONE storage buffer over the words + the compact family', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT)
    expect(scene.total).toBe(4)
    expect(scene.occluders).toBe(1)
    expect(calls).toContain(`createExternalBuffer(${WORDS.byteLength},140)`) // STORAGE|COPY_DST|COPY_SRC (0x8C)
    expect(calls.some(c => c.startsWith('runCompute(') && c.includes('createCompute') === false)).toBe(false)
    expect(calls.filter(c => c.startsWith('createCompute(')).length).toBe(1) // the compact family
    expect(calls.some(c => c.startsWith('createCompute(16,900001+900004+900003)'))).toBe(true) // scene(rw) + placeholder(ro) + args(rw)
  })

  it('drawInstanced → storage fetch + drawIndexed; drawVisible → compact then indirect', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT)
    const prog = device.program(PROG_SPEC)
    const geometry = device.geometry(BOX, IB)
    device.drawInstanced({ target: 5, clear: true, program: prog, geometry, records: scene, uniforms: U16, instances: 1, indexCount: 3 })
    expect(calls).toContain('bindTarget(5,1)')
    expect(calls).toContain('bindStorageBuffer(900001)')
    expect(calls).toContain('drawIndexed(3,1)')

    const before = calls.length
    device.drawVisible({ target: 0, clear: true, program: prog, geometry, records: scene, uniforms: U16, indexCount: 3 })
    const tail = calls.slice(before)
    // THE CONTRACT: the compact runs BEFORE the render pass opens, the
    // indirect draw rides the args buffer at byte 32
    const compactIdx = tail.findIndex(c => c.startsWith('runCompute(') && c.includes(',compact,'))
    const passIdx = tail.findIndex(c => c.startsWith('bindTarget(0,'))
    expect(compactIdx).toBeGreaterThanOrEqual(0)
    expect(passIdx).toBeGreaterThan(compactIdx)
    expect(calls).toContain('drawIndexedIndirect(900003,32)')
  })

  it('pyramid → the STORAGE shape (the Task-196 form): z-tile + one compute family', async () => {
    const { device, calls } = await wgDevice()
    const pyr = device.pyramid(8, 8)
    expect(pyr.levels).toBe(4) // 8→4→2→1
    expect(pyr.dims[3]).toEqual({ w: 1, h: 1 })
    expect(pyr.offsets).toEqual([0, 64, 80, 84])
    expect(calls.filter(c => c === 'createTexture(8,8,r32float)').length).toBe(1)
    expect(calls).toContain('createTarget(1,8,8,depth)') // the z tile (level 0)
    // the storage buffer (65 words) + the reduce family with the z-tile slot
    expect(calls.some(c => c.startsWith('createExternalBuffer(340,140)'))).toBe(true) // 85 words
    const createCalls = calls.filter(c => c.startsWith('createCompute('))
    expect(createCalls.some(c => c.startsWith('createCompute(16,900003+tex:sampled@1)'))).toBe(true) // the storage + the z-tile slot

    const before = calls.length
    pyr.build()
    const tail = calls.slice(before)
    // zToMip0 (1 workgroup for 64 texels) + reduceL1..3 (the baked entries)
    expect(tail.some(c => c.startsWith('runCompute(1,zToMip0,4,1)'))).toBe(true)
    expect(tail.some(c => c.startsWith('runCompute(1,reduceL1,4,1)'))).toBe(true)
    expect(tail.some(c => c.startsWith('runCompute(1,reduceL3,4,1)'))).toBe(true)
  })

  it('occlusionCuller → the scene + pyramid STORAGE buffers (the Task-196 slots) + readCullStats', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT)
    const pyr = device.pyramid(8, 8)
    const culler = device.occlusionCuller(scene, pyr, CULLER_SPEC)
    const createCalls = calls.filter(c => c.startsWith('createCompute('))
    // the scene's compact + the pyramid's reduce + the culler family
    expect(createCalls.length).toBe(3)
    // THE SLOT MAP: the scene (rw) at binding 1 + the pyramid storage (ro) at
    // binding 2 — the facade's fixed [rw, ro, rw] types match the Task-196 form
    expect(createCalls[2]).toContain('900001+900008')

    const block = new Float32Array(20)
    culler.run(block)
    expect(calls.some(c => c.startsWith('runCompute(') && c.includes(',cull,20,'))).toBe(true) // ceil(4/64)=1 workgroup

    // the recording facade resolves an empty readback — the stats decode is
    // the real facade's path; the BRICK contract here is the args read call
    await device.readCullStats(scene).catch(() => undefined)
    expect(calls).toContain('readExternalBuffer(900003)')
  })

  it('submit ends the open pass and rolls the arena cursor', async () => {
    const { device, calls } = await wgDevice()
    const scene = device.scene(LAYOUT)
    const prog = device.program(PROG_SPEC)
    const geometry = device.geometry(BOX, IB)
    device.drawInstanced({ target: 0, clear: true, program: prog, geometry, records: scene, uniforms: U16, instances: 1, indexCount: 3 })
    device.submit()
    device.drawInstanced({ target: 0, clear: true, program: prog, geometry, records: scene, uniforms: U16, instances: 1, indexCount: 3 })
    device.submit()
    // two frames — the second frame's uniform block reuses slot 0 (the cursor rolled back at submit)
    const ups = calls.filter(c => c.startsWith('uploadUniforms('))
    expect(ups[0]).toBe('uploadUniforms(0,64)')
    expect(ups[ups.length - 1]).toBe('uploadUniforms(0,64)')
  })
})

describe('Task 198: the common bricks — the WebGL2 leg', () => {
  it('scene → the records buffer (static) + the flag buffer (dynamic)', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT)
    expect(scene.total).toBe(4)
    expect(calls).toContain(`createBuffer(${RECORDS.length})`)
    expect(calls).toContain('createBuffer(4,dynamic)')
  })

  it('drawInstanced → the divisor attribute feed + drawElements', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT)
    const prog = device.program(PROG_SPEC)
    const geometry = device.geometry(BOX, IB)
    device.drawInstanced({ target: 5, clear: true, program: prog, geometry, records: scene, uniforms: U16, instances: 1, indexCount: 3 })
    expect(calls).toContain('bindTarget(5,1)')
    expect(calls).toContain('setDepthMode(less,true)')
    expect(calls).toContain('uniformMatrix4fv(u_mvp)')
    expect(calls).toContain('bindVertexBuffer(1,1,3,48@0,!i)') // the records attr, divisor 1
    expect(calls.some(c => c.startsWith('drawElements(') && c.includes(',3,1,u16'))).toBe(true)
  })

  it('the canvas pass clears explicitly (the facade canvas bind does not)', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT)
    const prog = device.program(PROG_SPEC)
    const geometry = device.geometry(BOX, IB)
    device.drawInstanced({ target: 0, clear: true, program: prog, geometry, records: scene, uniforms: U16, instances: 1, indexCount: 3 })
    expect(calls).toContain('bindTarget(0,0)')
    expect(calls).toContain('clear(0.045,0.055,0.09,1;1)')
  })

  it('drawVisible → drawElements over ALL records (the collapse)', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT)
    const prog = device.program(PROG_SPEC)
    const geometry = device.geometry(BOX, IB)
    device.drawVisible({ target: 0, clear: true, program: prog, geometry, records: scene, uniforms: U16, indexCount: 3 })
    expect(calls.some(c => c.startsWith('drawElements(') && c.includes(',3,4,u16'))).toBe(true)
  })

  it('occlusionCuller → ONE transform pass; the neutral canvas target first', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT)
    const pyr = device.pyramid(8, 8)
    const culler = device.occlusionCuller(scene, pyr, CULLER_SPEC)
    expect(calls).toContain('createTransformPass(out:1,attrs:2,tex:4,uni:5)')

    const before = calls.length
    const block = new Float32Array(20)
    culler.run(block)
    const tail = calls.slice(before)
    // THE FEEDBACK-LOOP LESSON: the neutral canvas bind precedes the pass
    expect(tail[0]).toBe('bindTarget(0,0)')
    expect(tail.some(c => c.startsWith('runTransformPass(') && c.includes(',4,buf:'))).toBe(true)
  })

  it('pyramid → the z-target depth ladder (32 first) + the reduce strip quads', async () => {
    const { device, calls } = await glDevice()
    const pyr = device.pyramid(8, 8)
    expect(pyr.levels).toBe(4)
    expect(calls).toContain('createTarget(1,8,8,depth,d32)')
    const before = calls.length
    pyr.build()
    const tail = calls.slice(before)
    expect(tail.filter(c => c === 'drawArrays(triangle-strip,0,4,1)').length).toBe(3)
    expect(tail.some(c => c === 'bindTexture(1,0)')).toBe(true)
  })

  it('readCullStats → the flag readback + the occludee-only sweep', async () => {
    const { device, calls } = await glDevice()
    const scene = device.scene(LAYOUT)
    const stats = await device.readCullStats(scene)
    // flags are all 0 (never culled) — the occluder lane is skipped, 0 drawn
    expect(stats).toEqual({ drawn: 0, frustum: 0, occluded: 0, straddle: 0 })
    expect(calls).toContain('readBuffer(2,4)')
  })
})

describe('Task 198: the honest refusals', () => {
  it('a program spec without the backend\'s leg throws loudly', async () => {
    const { device } = await wgDevice()
    expect(() => device.program({ depth: { test: 'less', write: true }, gl: PROG_SPEC.gl })).toThrow('no wg leg')
    const gl = await glDevice()
    expect(() => gl.device.program({ depth: { test: 'less', write: true }, wg: PROG_SPEC.wg })).toThrow('no gl leg')
  })
})
