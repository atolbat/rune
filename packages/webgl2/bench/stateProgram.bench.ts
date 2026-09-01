import {
  createCompileContext,
  compileDrawSpec,
  createCountingGL,
  createExecutor,
} from '../src/index.ts'
import type { DrawSpec } from '../src/index.ts'
import {
  createUniformArena,
  createTapeWriter,
  serializeTape,
  parseTape,
  signal,
  OpCode,
} from '@rune/core'
import type { TapeView } from '@rune/core'

/**
 * Теория A: state-программы — интерпретатор против codegen.
 * Гипотеза: codegen (инлайн-сравнения, без switch-диспетчера) быстрее
 * интерпретатора на кадре из тысяч draw. Победитель станет дефолтом.
 */

const VERT = `#version 300 es
in vec3 position;
uniform mat4 u_mvp;
uniform vec4 u_tint;
uniform float u_time;
uniform vec3 u_offset;
void main() { gl_Position = u_mvp * vec4(position + u_offset, u_time); }`

const FRAG = `#version 300 es
precision mediump float;
uniform vec4 u_tint;
out vec4 o; void main() { o = u_tint; }`

const DRAWS = 1000

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function makeSpec(): DrawSpec {
  return {
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    pipeline: {
      depth: { test: 'less', write: true },
      blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' },
      raster: { cull: 'back', frontFace: 'ccw' },
    },
    uniforms: {
      u_mvp: () => IDENTITY,
      u_tint: signal([1, 0.5, 0.25, 1] as const),
      u_time: 0.5,
      u_offset: [0.1, 0.2, 0.3],
    },
    count: 6,
  }
}

function measure(mode: 'interpret' | 'codegen', repeats: number): number {
  const arena = createUniformArena()
  const ctx = createCompileContext(arena, mode)
  const command = compileDrawSpec(makeSpec(), ctx)
  const gl = createCountingGL()
  const executor = createExecutor({
    gl,
    arena,
    commands: ctx.commands,
    clears: [],
    uniformStrategy: 'per-call',
  })

  const writer = createTapeWriter(DRAWS * 2 + 4)
  writer.emit(OpCode.BeginPass, 0, -1, 0, 0)
  for (let i = 0; i < DRAWS; i++) command.record({}, {}, writer)
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  const tape = parseTape(serializeTape(writer))

  warmUp(executor, tape)
  return bestOf(repeats, () => executor.run(tape))
}

function warmUp(executor: { run(tape: TapeView): void }, tape: TapeView): void {
  for (let i = 0; i < 60; i++) executor.run(tape)
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

const interpretMs = measure('interpret', 9)
const codegenMs = measure('codegen', 9)

console.log('── Теория A: state-программы, кадр из 1000 draw ──')
console.log(`интерпретатор : ${interpretMs.toFixed(3)} мс`)
console.log(`codegen       : ${codegenMs.toFixed(3)} мс`)
console.log(`codegen быстрее в ${(interpretMs / codegenMs).toFixed(2)} раза`)
