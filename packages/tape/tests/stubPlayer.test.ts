import { describe, expect, it } from 'bun:test'
import { createStub } from '../src/index.ts'
import { createTapePlayer } from '../src/index.ts'
import type { DrawSpec } from '@rune/webgl2'
import { createRecordingGL, createCompileContext, compileDrawSpec } from '@rune/webgl2'
import { createUniformArena, createTapeWriter, signal } from '@rune/core'

const VERT = `#version 300 es
in vec3 position;
uniform mat4 u_mvp;
uniform vec4 u_tint;
uniform float u_alpha;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`

const FRAG = `#version 300 es
precision mediump float;
out vec4 o; void main() { o = vec4(1.0); }`

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

const TINT = signal([1, 0.5, 0.25, 1] as const)

// Frame context for record(): the tests do not use dynamic values from
// time/dt/aspect, hence zeros (the structural type requires the fields).
const CTX = { time: 0, dt: 0, aspect: 1 } as const

function makeSpec(): DrawSpec {
  return {
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    pipeline: { depth: { test: 'less', write: true } },
    uniforms: {
      u_mvp: (p: any) => p.mvp,
      u_tint: TINT,
      u_alpha: (p: any) => p.alpha,
    },
    count: (p: any) => p.count,
  }
}

const PROPS = { mvp: IDENTITY, alpha: 0.8, count: 3 }

describe('stub → player (a cross-world frame)', () => {
  it('stub and main world slots match — the layout is deterministic', () => {
    const stub = createStub()
    const stubCommand = stub.command(makeSpec())

    const mainArena = createUniformArena(1 << 16)
    const mainCtx = createCompileContext(mainArena, 'interpret')
    const mainCommand = compileDrawSpec(makeSpec(), mainCtx)

    expect(stubCommand.bindings.map(b => b.slot.offset)).toEqual(
      mainCommand.bindings.map(b => b.slot.offset),
    )
  })

  it('a frame from the worker plays on the main world: uniform values arrive', () => {
    const stub = createStub()
    const stubCommand = stub.command(makeSpec())
    const writer = createTapeWriter(16)
    stubCommand.record(PROPS, CTX, writer)
    const frame = stub.ship(writer, 'full')

    // main world: the same compilation → the same ids and offsets
    const mainArena = createUniformArena(1 << 16)
    const mainCtx = createCompileContext(mainArena, 'interpret')
    const mainCommand = compileDrawSpec(makeSpec(), mainCtx)
    const { gl, calls } = createRecordingGL()
    const player = createTapePlayer({
      gl, arena: mainArena, commands: mainCtx.commands,
      clears: [{ color: [0, 0, 0, 1], depth: 1 }],
    })

    player.play(frame)

    expect(calls).toContain(`useProgram(${mainCommand.programId})`)
    expect(calls).toContain('uniformMatrix4fv(u_mvp)')        // mvp from the worker
    expect(calls).toContain('uniform4fv(u_tint)')              // tint from the worker
    expect(calls).toContain('uniform1f(u_alpha,0.8)')          // alpha from the worker (the value is visible in the recording)
    expect(calls).toContain('drawArrays(triangles,0,3,1)')
  })

  it('dirty mode delivers only the changed ranges', () => {
    const stub = createStub()
    const stubCommand = stub.command(makeSpec())
    const first = createTapeWriter(8)
    stubCommand.record(PROPS, CTX, first)
    stub.ship(first, 'full') // warm-up: the values are already in the stub arena

    stub.arena.clearDirty()
    const second = createTapeWriter(8)
    stubCommand.record({ ...PROPS, alpha: 0.9 }, CTX, second) // only alpha changes
    const frame = stub.ship(second, 'dirty')

    expect(frame.arena.byteLength).toBeGreaterThan(0)
    expect(frame.arena.byteLength).toBeLessThan(stub.arena.usedBytes)
  })

  it('a second frame without changes: the dirty frame is empty, no uniform calls', () => {
    const stub = createStub()
    const stubCommand = stub.command(makeSpec())

    const mainArena = createUniformArena(1 << 16)
    const mainCtx = createCompileContext(mainArena, 'interpret')
    compileDrawSpec(makeSpec(), mainCtx)
    const { gl, calls } = createRecordingGL()
    const player = createTapePlayer({ gl, arena: mainArena, commands: mainCtx.commands })

    const warmup = createTapeWriter(8)
    stubCommand.record(PROPS, CTX, warmup)
    player.play(stub.ship(warmup, 'full'))
    calls.length = 0

    const idle = createTapeWriter(8)
    stubCommand.record(PROPS, CTX, idle) // the same values — the arena is clean
    const frame = stub.ship(idle, 'dirty')
    expect(frame.arena.byteLength).toBe(0)

    player.play(frame)
    expect(calls).toEqual(['drawArrays(triangles,0,3,1)']) // draw only
  })
})
