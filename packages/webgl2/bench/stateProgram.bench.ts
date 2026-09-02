import { compileStateProgram, createGLShadow, createCountingGL } from '../src/index.ts'
import type { PipelineDesc, StateProgram, StateProgramGL } from '../src/index.ts'

/**
 * Theory A: state programs — interpreter versus codegen.
 * A frame of 1000 draws over two pipelines (a switch every 10th draw):
 * both modes produce the same GL traffic, only the dispatch differs.
 * The interpreter walks an action array with a switch dispatcher; codegen —
 * a specialized function with inline comparisons (turbo mode).
 *
 * Note: the draw-spec compile context's `mode` field is dead configuration
 * (compileDrawSpec ignores it); the honest interpreter/codegen split lives
 * here, in compileStateProgram.
 */

const OPAQUE: PipelineDesc = {
  depth: { test: 'less', write: true },
  raster: { cull: 'back', frontFace: 'ccw' },
}

const TRANSPARENT: PipelineDesc = {
  depth: { test: 'lequal', write: false },
  blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' },
}

const DRAWS = 1000
const SWITCH_EVERY = 10

interface World {
  run(): void
  readonly totalCalls: number
}

function makeWorld(mode: 'interpret' | 'codegen'): World {
  const gl = createCountingGL() as unknown as StateProgramGL
  const shadow = createGLShadow()
  const opaque = compileStateProgram(OPAQUE, 1, mode)
  const transparent = compileStateProgram(TRANSPARENT, 2, mode)
  const programs: StateProgram[] = [opaque, transparent]
  return {
    run: () => {
      for (let at = 0; at < DRAWS; at++) {
        programs[at % SWITCH_EVERY === 0 ? 1 : 0](gl, shadow)
      }
    },
    get totalCalls() { return (gl as { totalCalls: number }).totalCalls },
  }
}

function warmUp(world: World, repeats: number): void {
  for (let i = 0; i < repeats; i++) world.run()
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

const interpretWorld = makeWorld('interpret')
const codegenWorld = makeWorld('codegen')
warmUp(interpretWorld, 60)
warmUp(codegenWorld, 60)

const interpretMs = bestOf(15, () => interpretWorld.run())
const codegenMs = bestOf(15, () => codegenWorld.run())

console.log('── Theory A: state programs, frame of 1000 draws (switch every 10th) ──')
console.log(`interpreter   : ${interpretMs.toFixed(3)} ms`)
console.log(`codegen       : ${codegenMs.toFixed(3)} ms`)
console.log(`codegen is ${(interpretMs / codegenMs).toFixed(2)}x faster`)
console.log(`GL calls (must match): interpret ${interpretWorld.totalCalls}, codegen ${codegenWorld.totalCalls}`)
