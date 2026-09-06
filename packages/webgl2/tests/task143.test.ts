import { describe, expect, it } from 'bun:test'
import { createUniformArena, createTapeWriter, writerView, OpCode } from '@rune/core'
import { compileDrawSpec, createCompileContext, createExecutor, createRecordingGL } from '../src/index.ts'
import type { DrawSpec } from '../src/index.ts'

// Task 143 — the state-key precompute's regression pin: the executor's GL call
// SEQUENCE must be unchanged by the compile-time keys (same re-asserts, same
// skips, same Task-122 equation split, same Task-75b pass-start re-assert).

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

describe('task 143: precompiled state keys (the executor cache compare)', () => {
  it('the steady-state GL call sequence is EXACTLY the per-draw draws (no state churn, no re-asserts)', () => {
    const arena = createUniformArena(1 << 16)
    const ctx = createCompileContext(arena, 'codegen')
    const commands = [
      compileDrawSpec(specOf({ depth: { test: 'less', write: true } }), ctx),
      compileDrawSpec(specOf({ depth: { test: 'less', write: true } }), ctx),
      compileDrawSpec(specOf({ depth: { test: 'lequal', write: true } }), ctx),
      compileDrawSpec(specOf({ depth: { test: 'less', write: false }, raster: { cull: 'front' } }), ctx),
      compileDrawSpec(specOf({ depth: { test: 'less', write: true } }), ctx),
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
    // Steady state: 5 draws, 1 pass start (bindTarget+clear+state re-asserts),
    // 1 useProgram, and the state switches ONLY where the key actually changes:
    // [less→less skip] [less→lequal setDepth] [lequal→less setDepth + cull front]
    // [cull front→none... command 4 has cull front; command 5 default back]
    const stateCalls = calls.filter(c => c.startsWith('setDepthMode') || c.startsWith('setCull') || c.startsWith('setBlend'))
    expect(stateCalls.join('\n')).toBe([
      // BeginPass re-assert: command 1 (less/true, cull back, blend off)
      'setDepthMode(less,true)',
      'setCull(back)',
      'setBlend(off,off,add)',
      // command 2: identical key → all three skipped
      // command 3: depth key changes
      'setDepthMode(lequal,true)',
      // command 4: depth back + cull front
      'setDepthMode(less,false)',
      'setCull(front)',
      // command 5: depth back + cull back
      'setDepthMode(less,true)',
      'setCull(back)',
    ].join('\n'))
    expect(calls.filter(c => c === 'drawArrays(triangles,0,6,1)').length).toBe(5)
    expect(calls.filter(c => c === 'useProgram(1)').length).toBe(1)
  })

  it('the Task-122 equation split: same factors, different equation — the blend RE-ASSERTS', () => {
    const arena = createUniformArena(1 << 16)
    const ctx = createCompileContext(arena, 'codegen')
    const commands = [
      compileDrawSpec(specOf({ blend: { src: 'one', dst: 'one', equation: 'add' } }), ctx),
      compileDrawSpec(specOf({ blend: { src: 'one', dst: 'one', equation: 'max' } }), ctx),
      compileDrawSpec(specOf({ blend: { src: 'one', dst: 'one', equation: 'add' } }), ctx),
    ]
    const { gl, calls } = createRecordingGL()
    const executor = createExecutor({ gl, arena, commands, clears: [], uniformStrategy: 'per-call' })
    const writer = createTapeWriter(32)
    const frame = (): void => {
      writer.reset()
      writer.emit(OpCode.BeginPass, 0, -1, 0, 0)
      for (const command of commands) command.record({}, { time: 0, dt: 1 / 60, aspect: 1 }, writer)
      writer.emit(OpCode.EndPass, 0, 0, 0, 0)
      executor.run(writerView(writer))
    }
    frame(); frame()
    calls.length = 0
    frame()
    const blends = calls.filter(c => c.startsWith('setBlend'))
    // Pass start re-asserts (add), the max command flips, the third flips back
    expect(blends.join('\n')).toBe([
      'setBlend(one,one,add)',
      'setBlend(one,one,max)',
      'setBlend(one,one,add)',
    ].join('\n'))
  })

  it('the depth key folds test+write: same test, different write — the depth re-asserts', () => {
    const arena = createUniformArena(1 << 16)
    const ctx = createCompileContext(arena, 'codegen')
    const commands = [
      compileDrawSpec(specOf({ depth: { test: 'less', write: true } }), ctx),
      compileDrawSpec(specOf({ depth: { test: 'less', write: false } }), ctx),
    ]
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
    frame(); frame()
    calls.length = 0
    frame()
    const depths = calls.filter(c => c.startsWith('setDepthMode'))
    expect(depths.join('\n')).toBe('setDepthMode(less,true)\nsetDepthMode(less,false)')
  })
})
