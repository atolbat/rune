import { createCompileContext, createExecutor, createCountingGL, compileDrawSpec } from '../src/index.ts'
import type { DrawSpec, CompiledCommand } from '../src/index.ts'
import {
  createUniformArena,
  createTapeWriter,
  createSegmentStore,
  createLiveCommand,
  buildFrame,
  writerView,
  signal,
  OpCode,
} from '@rune/core'
import type { SignalCell, TapeWriter, LiveCommand, SegmentStore } from '@rune/core'

/**
 * Theory H: renderer frame path — per-frame record versus live segments.
 * Both paths go through the full pipeline: tape write → zero-copy writerView →
 * executor → GL. Hypothesis: live with 2% dirty commands is radically cheaper
 * than a full rewrite even accounting for replay segments.
 */

const VERT = `#version 300 es
layout(location = 0) in vec3 position;
uniform mat4 u_mvp;
uniform vec4 u_tint;
uniform float u_alpha;
uniform vec3 u_offset;
void main() { gl_Position = u_mvp * vec4(position + u_offset, u_alpha); }`

const FRAG = `#version 300 es
precision mediump float;
out vec4 o; void main() { o = vec4(1.0); }`

const COMMANDS = 1000
const DIRTY_PER_FRAME = 20
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function makeSpec(index: number): DrawSpec {
  return {
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    pipeline: { depth: { test: 'less', write: true } },
    uniforms: {
      u_mvp: () => IDENTITY,
      u_tint: [1, 0.5, 0.25, 1],
      u_alpha: (index % 32) / 32,
      u_offset: [0, 0, 0],
    },
    count: 6,
  }
}

/** Path A: re-record() all commands every frame. */
function makeRecordWorld(): { runFrame(): void } {
  const arena = createUniformArena(1 << 20)
  const ctx = createCompileContext(arena, 'codegen')
  const commands: CompiledCommand[] = []
  const executor = createExecutor({
    gl: createCountingGL(), arena, commands, clears: [], uniformStrategy: 'per-call',
  })
  for (let i = 0; i < COMMANDS; i++) commands.push(compileDrawSpec(makeSpec(i), ctx))

  const writer = createTapeWriter(COMMANDS + 8)
  return {
    runFrame: () => {
      writer.reset()
      writer.emit(OpCode.BeginPass, 0, -1, 0, 0)
      for (const command of commands) command.record({}, {}, writer)
      writer.emit(OpCode.EndPass, 0, 0, 0, 0)
      executor.run(writerView(writer))
    },
  }
}

/** Path B: live commands; clean ones are emitted from a cache segment, dirty ones are rewritten. */
function makeLiveWorld(): { runFrame(): void } {
  const arena = createUniformArena(1 << 20)
  const ctx = createCompileContext(arena, 'codegen')
  const commands: CompiledCommand[] = []
  const segments: SegmentStore = createSegmentStore(COMMANDS)
  const executor = createExecutor({
    gl: createCountingGL(), arena, commands, clears: [], segments, uniformStrategy: 'per-call',
  })
  const writer = createTapeWriter(COMMANDS + 8)
  const deps: SignalCell<number>[] = []
  const lives: LiveCommand[] = []
  for (let i = 0; i < COMMANDS; i++) {
    const dep = signal(i)
    deps.push(dep)
    const command = compileDrawSpec(makeSpec(i), ctx)
    commands.push(command)
    lives.push(createLiveCommand(segments, w => command.record({}, {}, w), [dep]))
  }
  return {
    runFrame: () => {
      markDirty(deps, DIRTY_PER_FRAME)
      writer.reset()
      writer.emit(OpCode.BeginPass, 0, -1, 0, 0)
      buildFrame(lives, writer)
      writer.emit(OpCode.EndPass, 0, 0, 0, 0)
      executor.run(writerView(writer))
    },
  }
}

function markDirty(deps: readonly SignalCell<number>[], count: number): void {
  const step = Math.max(1, (deps.length / count) | 0)
  for (let i = 0; i < count; i++) {
    const dep = deps[(i * step) % deps.length]
    dep.value = dep.value + 1
  }
}

function bestOf(repeats: number, run: () => void): number {
  let best = Infinity
  for (let i = 0; i < repeats; i++) {
    const startedAt = performance.now()
    run()
    const elapsed = performance.now() - startedAt
    if (elapsed < best) best = elapsed
  }
  return best
}

const recordWorld = makeRecordWorld()
const liveWorld = makeLiveWorld()
for (let i = 0; i < 30; i++) { recordWorld.runFrame(); liveWorld.runFrame() }

const recordMs = bestOf(15, () => recordWorld.runFrame())
const liveMs = bestOf(15, () => liveWorld.runFrame())

console.log('── Theory H: renderer frame path (1000 commands, 20 dirty, full pipeline) ──')
console.log(`per-frame record : ${recordMs.toFixed(3)} ms/frame`)
console.log(`live segments    : ${liveMs.toFixed(3)} ms/frame`)
console.log(`live is ${(recordMs / liveMs).toFixed(1)}x faster`)
