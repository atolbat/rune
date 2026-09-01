import { createStub } from '../src/index.ts'
import type { DrawSpec } from '@rune/webgl2'
import { createUniformArena, createTapeWriter, signal } from '@rune/core'
import type { TapeWriter } from '@rune/core'

/**
 * Теория G: доставка кадров из воркера — полная арена против грязных диапазонов.
 * Гипотеза: в стационарном кадре меняется малая доля слотов (дизайн: кадр стоит
 * O(изменений)); dirty-доставка должна срезать и копирование, и объём transfer.
 * Сравниваем: copy 100% арены против копирования только грязного + учёт
 * пост-обработки (merge на главном мире).
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
world.stub.ship(world.writer, 'full') // прогрев значений

function measureShip(mode: 'full' | 'dirty'): number {
  return bestOf(30, () => {
    recordFrame(world, DIRTY_PER_FRAME) // свежие случайные → грязные слоты
    return mode === 'full' ? shipFull(world) : shipDirty(world)
  })
}

const fullMs = measureShip('full')
const dirtyMs = measureShip('dirty')
const fullBytes = world.stub.arena.usedBytes
recordFrame(world, DIRTY_PER_FRAME) // для честного подсчёта грязных байт
const dirtyRanges = world.stub.arena.dirtyRanges()
const dirtyBytes = dirtyRanges.reduce((sum, range) => sum + (range.to - range.from), 0)

console.log('── Теория G: доставка кадра из воркера (200 команд × 9 юниформов) ──')
console.log(`полная арена : ${fullMs.toFixed(4)} мс, ${(fullBytes / 1024).toFixed(1)} КБ на кадр`)
console.log(`только грязное: ${dirtyMs.toFixed(4)} мс, ${(dirtyBytes / 1024).toFixed(2)} КБ на кадр (${dirtyRanges.length} диапазона)`)
console.log(`dirty-доставка дешевле в ${(fullMs / dirtyMs).toFixed(1)} раза по CPU, ${(fullBytes / dirtyBytes).toFixed(0)} раз по байтам`)
