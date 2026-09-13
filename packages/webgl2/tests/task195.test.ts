import { describe, expect, it } from 'bun:test'
import { createUniformArena, createTapeWriter, writerView, OpCode } from '@rune/core'
import { compileDrawSpec, createCompileContext, createExecutor, createRecordingGL } from '../src/index.ts'
import type { DrawSpec } from '../src/index.ts'
import { createRealGL } from '../src/realGL.ts'

/** Task 195 — THE RASTERIZATION-PARITY CONTRACT (the Task-194 follow-up).
 *
 * The Task-194 dig left the named candidate: the GL command compiler read
 * `raster?.cull ?? 'back'` while WebGPU maps an absent cull to 'none' (the
 * GPURenderPipelineDescriptor spec default), and `frontFace` was honored on
 * WebGPU (pipeline-baked, frontFace default 'ccw') but DROPPED on the whole
 * WebGL2 path (the DrawSpec type never declared it; realGL had no method).
 * A CW-wound spec with `raster: { cull: 'back', frontFace: 'cw' }` painted
 * on WebGPU and BLANKED on WebGL2 — the cross-backend hole the parity bench
 * scripts/task195-parity.mjs demonstrated leg by leg (leg C: 0 px on GL,
 * 8854 px on WG, identical stacks otherwise).
 *
 * These pins hold the fix at every layer:
 *   readState  — cull 'none' + frontFace 'ccw' defaults (the WG twin);
 *   executor   — setFrontFace asserted once per pass, cached between
 *                agreeing commands, re-asserted at every pass start;
 *   realGL     — 'cw'/'ccw' map to gl.CW/gl.CCW;
 *   sequence   — a spec without a pipeline produces the EXACT state-call
 *                sequence of the explicit neutral { cull:'none',
 *                frontFace:'ccw' } — default === explicit neutral. */

const VERT = `#version 300 es
layout(location = 0) in vec3 position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`

const FRAG = `#version 300 es
precision mediump float;
uniform vec4 u_tint;
out vec4 o_color;
void main() { o_color = u_tint; }`

function specOf(pipeline: DrawSpec['pipeline']): DrawSpec {
  return {
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    pipeline,
    uniforms: { u_mvp: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], u_tint: [1, 0.5, 0.25, 1] },
    count: 6,
  }
}

interface RichState {
  state: { cull: 'none' | 'back' | 'front'; frontFace: 'cw' | 'ccw' }
}

function stateOf(pipeline: DrawSpec['pipeline']): { cull: string; frontFace: string } {
  const arena = createUniformArena(1 << 16)
  const ctx = createCompileContext(arena, 'codegen')
  const command = compileDrawSpec(specOf(pipeline), ctx)
  const rich = command as unknown as RichState
  return { cull: rich.state.cull, frontFace: rich.state.frontFace }
}

describe('task 195: the rasterization-parity contract (GL === WG)', () => {
  it('readState defaults: an absent raster compiles to cull none + frontFace ccw (the WG twin)', () => {
    // The pre-195 GL compiled `?? 'back'` — an unspecified pipeline
    // back-culled on GL while painting on WG (parity bench leg A).
    expect(stateOf(undefined)).toEqual({ cull: 'none', frontFace: 'ccw' })
    expect(stateOf({})).toEqual({ cull: 'none', frontFace: 'ccw' })
    expect(stateOf({ raster: undefined })).toEqual({ cull: 'none', frontFace: 'ccw' })
  })

  it('readState passthrough: cull and frontFace ride the compiled state verbatim', () => {
    expect(stateOf({ raster: { cull: 'back', frontFace: 'cw' } })).toEqual({ cull: 'back', frontFace: 'cw' })
    expect(stateOf({ raster: { frontFace: 'cw' } })).toEqual({ cull: 'none', frontFace: 'cw' })
    expect(stateOf({ raster: { cull: 'front' } })).toEqual({ cull: 'front', frontFace: 'ccw' })
  })

  it('the executor asserts frontFace once per pass and switches exactly on change', () => {
    const arena = createUniformArena(1 << 16)
    const ctx = createCompileContext(arena, 'codegen')
    const commands = [
      compileDrawSpec(specOf(undefined), ctx), // default ccw
      compileDrawSpec(specOf(undefined), ctx), // same ccw — cached, no call
      compileDrawSpec(specOf({ raster: { frontFace: 'cw' } }), ctx), // switch
      compileDrawSpec(specOf(undefined), ctx), // switch back
    ]
    const { gl, calls } = createRecordingGL()
    const executor = createExecutor({ gl, arena, commands, clears: [], uniformStrategy: 'per-call' })
    const writer = createTapeWriter(64)
    const frame = (): void => {
      writer.reset()
      writer.emit(OpCode.BeginPass, 0, -1, 0, 0)
      for (const command of commands) command.record({}, { time: 0, dt: 1 / 60, aspect: 1 }, writer)
      writer.emit(OpCode.EndPass, 0, 0, 0, 0)
      executor.run(writerView(writer))
    }
    frame(); frame(); frame() // settle: programs, first-frame dirty uniforms
    calls.length = 0
    frame() // the pinned window
    const ff = calls.filter(c => c.startsWith('setFrontFace'))
    // Pass-start re-assert (ccw) + the two real switches — the pass-boundary
    // reset discipline of Task 75b, same as setCull/setBlend.
    expect(ff.join('\n')).toBe('setFrontFace(ccw)\nsetFrontFace(cw)\nsetFrontFace(ccw)')
    // and the draws all landed
    expect(calls.filter(c => c === 'drawArrays(triangles,0,6,1)').length).toBe(4)
  })

  it('default === explicit neutral: a spec without a pipeline emits the EXACT state sequence of { cull: none, frontFace: ccw }', () => {
    const run = (pipeline: DrawSpec['pipeline']): string[] => {
      const arena = createUniformArena(1 << 16)
      const ctx = createCompileContext(arena, 'codegen')
      const commands = [compileDrawSpec(specOf(pipeline), ctx)]
      const { gl, calls } = createRecordingGL()
      const executor = createExecutor({ gl, arena, commands, clears: [], uniformStrategy: 'per-call' })
      const writer = createTapeWriter(16)
      const frame = (): void => {
        writer.reset()
        writer.emit(OpCode.BeginPass, 0, -1, 0, 0)
        for (const command of commands) command.record({}, { time: 0, dt: 1 / 60, aspect: 1 }, writer)
        writer.emit(OpCode.EndPass, 0, 0, 0, 0)
        executor.run(writerView(writer))
      }
      frame(); frame(); frame()
      calls.length = 0
      frame()
      return calls.filter(c => c.startsWith('setDepthMode') || c.startsWith('setCull') || c.startsWith('setFrontFace') || c.startsWith('setBlend'))
    }
    // THE parity bench's unit twin (leg A vs leg B): bit-identical state
    // behavior — the contract that makes the default backend-independent.
    expect(run(undefined)).toEqual(run({ raster: { cull: 'none', frontFace: 'ccw' } }))
    expect(run(undefined)).toContain('setCull(none)')
    expect(run(undefined)).toContain('setFrontFace(ccw)')
  })
})

describe('task 195: realGL.setFrontFace (the raw wire)', () => {
  it("maps 'cw'/'ccw' to gl.CW/gl.CCW (gl.frontFace)", () => {
    const calls: string[] = []
    const gl = {
      CW: 0x900,
      CCW: 0x901,
      frontFace: (mode: number) => calls.push(`frontFace(0x${mode.toString(16)})`),
      getExtension: () => null,
    } as unknown as WebGL2RenderingContext
    const facade = createRealGL(gl)
    facade.setFrontFace('cw')
    facade.setFrontFace('ccw')
    facade.setFrontFace('cw')
    expect(calls.join('\n')).toBe('frontFace(0x900)\nfrontFace(0x901)\nfrontFace(0x900)')
  })
})
