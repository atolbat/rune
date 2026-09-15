/**
 * Task 216 — THE PLAIN MESH DRAW (drawMesh), pinned on the recording
 * facades. The walker demo's terrain needs ONE non-instanced draw over
 * the @rune/prims parallel soup (positions/normals/uvs, no index); the
 * contracts:
 *
 *   · THE WG LEG: the program's attr slots bind the mesh's parallel
 *     arrays IN ORDER (slot 0 ← positions, 1 ← normals, 2 ← uvs — one
 *     bindVertexBuffer per slot, the keyed cache uploading once), and
 *     ONE draw(vertexCount, 1) lands.
 *   · THE GL LEG: the `from:'mesh'` decls bind their mesh-slot arrays
 *     with the declared location/size/stride (the mesh buffer cache:
 *     the SAME array re-binds the SAME buffer id), and ONE
 *     drawArrays('triangles', 0, vertexCount, 1) lands.
 *   · THE REFUSALS: a foreign program handle (not this device's own)
 *     throws the honest error on both legs.
 *   · THE VERTEX-COUNT OVERRIDE rides through.
 */

import { describe, expect, it } from 'bun:test'
import { createDevice } from '../src/device.ts'
import type { ProgramHandle } from '../src/device.ts'
import { createRecordingGPU } from '@rune/webgpu'
import { createRecordingGL } from '@rune/webgl2'
import type { GPUFacade } from '@rune/webgpu'
import type { GLFacade } from '@rune/webgl2'

// the mesh program: WG — three parallel slots (pos/normal/uv); GL — three
// `from:'mesh'` decls with their mesh slots. The uniforms: one mat4 lane.
const MESH_WGSL = `
struct P { mvp: mat4x4<f32>, light: vec4<f32> }
@group(0) @binding(0) var<uniform> p: P;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) n: vec3<f32>, @location(1) uv: vec2<f32> }
@vertex fn vsMain(@location(0) a_pos: vec3<f32>, @location(1) a_n: vec3<f32>, @location(2) a_uv: vec2<f32>) -> VOut {
  var o: VOut
  o.pos = p.mvp * vec4<f32>(a_pos, 1.0)
  o.n = a_n
  o.uv = a_uv
  return o
}
@fragment fn fsMain(v: VOut) -> @location(0) vec4<f32> { return vec4<f32>(0.5 + 0.5 * v.n, 1.0); }`
const MESH_GLSL_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_n;
layout(location=2) in vec2 a_uv;
uniform mat4 u_mvp;
out vec3 v_n; out vec2 v_uv;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); v_n = a_n; v_uv = a_uv; }`
const MESH_GLSL_FS = `#version 300 es
precision highp float;
in vec3 v_n; in vec2 v_uv;
out vec4 o;
void main() { o = vec4(0.5 + 0.5 * v_n, 1.0); }`

const POS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
const NRM = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0])
const UV = new Float32Array([0, 0, 1, 0, 0, 1])
const MESH = { positions: POS, normals: NRM, uvs: UV, vertexCount: 3 }
const BLOCK = new Float32Array(20) // mvp(16) + light(4)

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

describe('Task 216 — the plain mesh draw (drawMesh)', () => {
  it('WG: the parallel slots bind in order, one draw(vertexCount, 1)', async () => {
    const { device, calls } = await wgDevice()
    const prog = device.program({
      depth: { test: 'less', write: true },
      cull: 'back',
      wg: { code: MESH_WGSL, attrs: [3, 3, { size: 2, stride: 8, offset: 0 }] },
    })
    device.drawMesh({ target: 0, clear: true, program: prog, geometry: MESH, uniforms: BLOCK })
    device.submit()
    const text = calls.join('|')
    expect(text).toContain('bindVertexBuffer(0,9,3)') // positions — 9 floats
    expect(text).toContain('bindVertexBuffer(1,9,3)') // normals — 9 floats
    expect(text).toContain('bindVertexBuffer(2,6,3)') // uvs — 6 floats
    expect(text).toContain('draw(3,1)') // the whole soup, ONE instance
    // re-draw re-binds the same arrays (the keyed cache; the count rides)
    device.drawMesh({ target: 0, clear: false, program: prog, geometry: MESH, uniforms: BLOCK, vertexCount: 2 })
    device.submit()
    expect(calls.filter(c => c.startsWith('draw(')).length).toBe(2)
    expect(calls.filter(c => c.startsWith('draw('))[1]).toBe('draw(2,1)')
  })

  it('GL: the mesh decls bind their slots, one drawArrays triangle soup', async () => {
    const { device, calls } = await glDevice()
    const prog = device.program({
      depth: { test: 'less', write: true },
      cull: 'back',
      gl: {
        vs: MESH_GLSL_VS, fs: MESH_GLSL_FS,
        attrs: [
          { location: 0, from: 'mesh', mesh: 0, size: 3, stride: 12, offset: 0, divisor: 0 },
          { location: 1, from: 'mesh', mesh: 1, size: 3, stride: 12, offset: 0, divisor: 0 },
          { location: 2, from: 'mesh', mesh: 2, size: 2, stride: 8, offset: 0, divisor: 0 },
        ],
        lanes: [{ name: 'u_mvp', kind: 'mat4', words: 16 }],
      },
    })
    device.drawMesh({ target: 0, clear: true, program: prog, geometry: MESH, uniforms: BLOCK })
    const text = calls.join('|')
    expect(text).toContain('drawArrays(triangles,0,3,1)')
    const binds = calls.filter(c => c.startsWith('bindVertexBuffer('))
    expect(binds.length).toBe(3)
    // the second draw re-binds the SAME buffer ids (the mesh cache)
    const firstIds = binds.map(b => b.slice('bindVertexBuffer('.length).split(',')[0])
    device.drawMesh({ target: 0, clear: false, program: prog, geometry: MESH, uniforms: BLOCK, vertexCount: 2 })
    const binds2 = calls.filter(c => c.startsWith('bindVertexBuffer('))
    const secondIds = binds2.slice(3).map(b => b.slice('bindVertexBuffer('.length).split(',')[0])
    expect(secondIds).toEqual(firstIds)
    expect(calls.filter(c => c.startsWith('drawArrays('))[1]).toBe('drawArrays(triangles,0,2,1)')
  })

  it('the honest refusals: a foreign program handle throws', async () => {
    const wg = await wgDevice()
    const foreign: ProgramHandle = { backend: 'webgpu', depth: { test: 'less', write: true } }
    expect(() => wg.device.drawMesh({ target: 0, clear: true, program: foreign, geometry: MESH, uniforms: BLOCK })).toThrow()
    const gl = await glDevice()
    const foreignGl: ProgramHandle = { backend: 'webgl2', depth: { test: 'less', write: true } }
    expect(() => gl.device.drawMesh({ target: 0, clear: true, program: foreignGl, geometry: MESH, uniforms: BLOCK })).toThrow()
  })
})
