import { describe, expect, it } from 'bun:test'
import { createPortability, webgl2Adapter, webgpuAdapter } from '../src/index.ts'
import type { PortableSpec, BackendAdapter } from '../src/index.ts'
import { createTapeWriter, serializeTape, parseTape, signal, OpCode } from '@rune/core'
import { createCompileContext, compileDrawSpec } from '@rune/webgl2'
import { createUniformArena } from '@rune/core'
import { createWgpuContext, compileWgslSpec, createSliceArena } from '@rune/webgpu'

const GLSL_VERT = `#version 300 es
in vec3 position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`

const GLSL_FRAG = `#version 300 es
precision mediump float;
uniform vec4 u_tint;
uniform float u_alpha;
out vec4 o; void main() { o = u_tint * u_alpha; }`

const WGSL = `
struct Params {
  u_mvp: mat4x4<f32>,
  u_tint: vec4<f32>,
  u_alpha: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return params.u_tint; }`

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function makeSpec(): PortableSpec {
  return {
    shader: { glsl: { vertex: GLSL_VERT, fragment: GLSL_FRAG }, wgsl: WGSL },
    pipeline: { depth: { test: 'less', write: true }, raster: { cull: 'back' } },
    uniforms: {
      u_mvp: (p: any) => p.mvp,
      u_tint: signal([1, 0.5, 0.25, 1] as const),
      u_alpha: 0.8,
    },
    count: (p: any) => p.count,
  }
}

const PROPS = { mvp: IDENTITY, count: 3 }

function tapeOf(command: { record(p: any, c: any, w: any): void }) {
  const writer = createTapeWriter(8)
  command.record(PROPS, {}, writer)
  return parseTape(serializeTape(writer))
}

describe('portability harness', () => {
  it('the same spec yields the same binding names on both backends', () => {
    const gl = compileOn(webgl2Adapter(), makeSpec())
    const gpu = compileOn(webgpuAdapter(), makeSpec())
    expect(gl.bindings).toEqual(gpu.bindings)
    expect(gl.bindings).toEqual(['u_mvp', 'u_tint', 'u_alpha'])
  })

  it('tapes differ only in local ids: op/count/instances match', () => {
    const gl = compileOn(webgl2Adapter(), makeSpec())
    const gpu = compileOn(webgpuAdapter(), makeSpec())
    const a = tapeOf(gl)
    const b = tapeOf(gpu)
    expect(a.opCount).toBe(1)
    expect(b.opCount).toBe(1)
    expect(a.op[0]).toBe(b.op[0]) // Draw
    expect(a.b[0]).toBe(b.b[0])   // count
    expect(a.c[0]).toBe(b.c[0])   // instances
  })

  it('switchBackend recompiles live commands; the handle keeps working', () => {
    const harness = createPortability({ webgl2: webgl2Adapter(), webgpu: webgpuAdapter() })
    const command = harness.compile(makeSpec())
    expect(harness.backend).toBe('webgl2')
    const before = tapeOf(command)
    expect(before.op[0]).toBe(OpCode.Draw)

    const summary = harness.switchBackend('webgpu')
    expect(summary.recompiled).toBe(1)
    expect(summary.backend).toBe('webgpu')
    expect(harness.backend).toBe('webgpu')

    const after = tapeOf(command) // the same handle — a new compilation
    expect(after.op[0]).toBe(OpCode.Draw)
    expect(after.b[0]).toBe(before.b[0])
  })

  it('destroy excludes the command from replay', () => {
    const harness = createPortability({ webgl2: webgl2Adapter(), webgpu: webgpuAdapter() })
    const doomed = harness.compile(makeSpec())
    const keeper = harness.compile(makeSpec())
    harness.destroy(doomed)

    const summary = harness.simulateLoss()
    expect(summary.recompiled).toBe(1) // only the keeper
    expect(tapeOf(keeper).op[0]).toBe(OpCode.Draw)
  })

  it('simulateLoss and switchBackend — one mechanism (loss = switching to itself)', () => {
    const harness = createPortability({ webgl2: webgl2Adapter(), webgpu: webgpuAdapter() })
    harness.compile(makeSpec())
    const lost = harness.simulateLoss()
    expect(lost.recompiled).toBe(1)
    expect(lost.backend).toBe('webgl2')
    expect(harness.backend).toBe('webgl2')
  })

  it('the journal grows with declarations and destroy', () => {
    const harness = createPortability({ webgl2: webgl2Adapter(), webgpu: webgpuAdapter() })
    const first = harness.compile(makeSpec())
    harness.compile(makeSpec())
    harness.destroy(first)
    expect(harness.journal.length).toBe(3) // 2 declare + 1 destroy
  })
})

function compileOn(adapter: BackendAdapter, spec: PortableSpec) {
  const context = adapter.create()
  return adapter.compile(context, spec)
}

describe('reflection cache (theory F)', () => {
  it('repeated reflection of the same source returns the same object', async () => {
    const { reflectGlsl } = await import('@rune/core')
    const first = reflectGlsl(GLSL_VERT, GLSL_FRAG)
    const second = reflectGlsl(GLSL_VERT, GLSL_FRAG)
    expect(second).toBe(first)
  })

  it('compiling hundreds of commands with a shared shader does not parse the source again', () => {
    const arena = createUniformArena(1 << 20)
    const ctx = createCompileContext(arena, 'interpret')
    for (let i = 0; i < 200; i++) {
      compileDrawSpec({ ...makeSpecGl(), uniforms: { u_alpha: i / 200 } } as any, ctx)
    }
    expect(ctx.commands.length).toBe(200)
    expect(ctx.programs.size).toBe(1) // one program per source
  })
})

function makeSpecGl() {
  return {
    shader: { glsl: { vertex: GLSL_VERT, fragment: GLSL_FRAG } },
    count: 3,
  }
}
