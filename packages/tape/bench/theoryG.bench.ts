import { createStub } from '../src/index.ts'
import type { DrawSpec } from '@rune/webgl2'
import { createUniformArena, createTapeWriter, signal } from '@rune/core'
import type { TapeWriter } from '@rune/core'

/**
 * Theory G: frame delivery from a worker — the full arena versus dirty ranges.
 * Hypothesis: in a steady-state frame only a small fraction of the slots changes
 * (design: a frame costs O(changes)); dirty delivery should cut both the
 * copying and the transfer volume.
 * We compare: copying 100% of the arena versus copying only the dirty part +
 * accounting for post-processing (the merge on the main world).
 */

const VERT = `#version 300 es
in vec3 position;
uniform mat4 u_mvp;
uniform vec4 u_tint0; uniform vec4 u_tint1; uniform vec4 u_tint2; uniform vec4 u_tint3;
uniform float u_alpha0; uniform float u_alpha1; uniform float u_alpha2; uniform float u_alpha3;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`

const FRAG = `#version 300 es
precision mediump float;
out vec4 o; void main() { o = vec4(1.0); }`

const COMMANDS = 200
const DIRTY_PER_FRAME = 8

const TINT = signal([1, 0.5, 0.25, 1] as const)

function makeSpec(): DrawSpec {
  return {
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    uniforms: {
      u_mvp: (p: any) => p.mvp,
      u_tint0: TINT, u_tint1: TINT, u_tint2: TINT, u_tint3: TINT,
      u_alpha0: (p: any) => p.a0, u_alpha1: (p: any) => p.a1,
      u_alpha2: (p: any) => p.a2, u_alpha3: (p: any) => p.a3,
    },
    count: 6,
  }
}

interface World {
  readonly stub: ReturnType<typeof createStub>
  readonly commands: readonly ReturnType<ReturnType<typeof createStub>['command']>[]
  readonly writer: TapeWriter
  readonly props: any
}

function makeWorld(): World {
  const stub = createStub(1 << 20)
  const commands = []
  for (let i = 0; i < COMMANDS; i++) commands.push(stub.command(makeSpec()))
  const props = {
    mvp: IDENTITY, a0: 0.1, a1: 0.2, a2: 0.3, a3: 0.4,
  }
  return { stub, commands, writer: createTapeWriter(COMMANDS + 8), props }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function recordFrame(world: World, dirty: number): void {
  world.writer.reset()
  const alphas = ['a0', 'a1', 'a2', 'a3']
  for (let i = 0; i < COMMANDS; i++) {
    const props = i < dirty ? { ...world.props, [alphas[i % 4]]: Math.random() } : world.props
    world.commands[i].record(props, {}, world.writer)
  }
}

function shipFull(world: World): number {
  const startedAt = performance.now()
  world.stub.ship(world.writer, 'full')
  return performance.now() - startedAt
}

function shipDirty(world: World): number {
  const startedAt = performance.now()
  world.stub.ship(world.writer, 'dirty')
  return performance.now() - startedAt
}

function bestOf(repeats: number, run: () => number): number {
  let best = Infinity
  for (let i = 0; i < repeats; i++) {
    const elapsed = run()
    if (elapsed < best) best = elapsed
  }
  return best
}

const world = makeWorld()
recordFrame(world, COMMANDS)
world.stub.ship(world.writer, 'full') // warm up the values

function measureShip(mode: 'full' | 'dirty'): number {
  return bestOf(30, () => {
    recordFrame(world, DIRTY_PER_FRAME) // fresh random values → dirty slots
    return mode === 'full' ? shipFull(world) : shipDirty(world)
  })
}

const fullMs = measureShip('full')
const dirtyMs = measureShip('dirty')
const fullBytes = world.stub.arena.usedBytes
recordFrame(world, DIRTY_PER_FRAME) // for an honest count of the dirty bytes
const dirtyRanges = world.stub.arena.dirtyRanges()
const dirtyBytes = dirtyRanges.reduce((sum, range) => sum + (range.to - range.from), 0)

console.log('── Theory G: frame delivery from a worker (200 commands × 9 uniforms) ──')
console.log(`full arena  : ${fullMs.toFixed(4)} ms, ${(fullBytes / 1024).toFixed(1)} KB per frame`)
console.log(`dirty only  : ${dirtyMs.toFixed(4)} ms, ${(dirtyBytes / 1024).toFixed(2)} KB per frame (${dirtyRanges.length} ranges)`)
console.log(`dirty delivery is ${(fullMs / dirtyMs).toFixed(1)}x cheaper in CPU, ${(fullBytes / dirtyBytes).toFixed(0)}x in bytes`)
