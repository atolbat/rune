import { createPipelineCache } from '../src/index.ts'
import type { GpuPipelineDesc } from '../src/index.ts'

/**
 * Theory D: the strategy of pipeline cache keys.
 * Variant 1 (string): every frame rebuilds the structural key
 *   (field joins + concatenations) and goes into Map<string, id>.
 * Variant 2 (integer): the command stores a pipelineId; per frame — a flat
 *   array read + a dirty-flag check of the pipeline signals' versions.
 * Hypothesis: the integer path is an order of magnitude cheaper; the string one
 * is only needed for a reactive descriptor change.
 */

const COMMANDS = 1000
const FRAMES = 200

const DESCS: GpuPipelineDesc[] = Array.from({ length: COMMANDS }, (_, i) => ({
  depth: { test: 'less', write: i % 2 === 0 },
  blend: i % 3 === 0 ? { src: 'src-alpha', dst: 'one-minus-src-alpha' } : false,
  raster: { cull: i % 2 === 0 ? 'back' : 'front' },
}))

const cache = createPipelineCache()
const shaderIds = DESCS.map((_, i) => (i * 2654435761) >>> 0)
const cachedIds = DESCS.map((desc, i) => cache.idOf(desc, shaderIds[i])) // a preheated cache
const versions = new Uint32Array(COMMANDS) // versions of the commands' pipeline signals

function runStringKeys(): number {
  let sink = 0
  for (let i = 0; i < COMMANDS; i++) {
    const id = cache.idOf(DESCS[i], shaderIds[i])
    sink ^= id
  }
  return sink
}

function runIntegerRegistry(): number {
  let sink = 0
  for (let i = 0; i < COMMANDS; i++) {
    if (versions[i] !== 0) {
      versions[i] = 0 // the signal would have changed — the rare path
      sink ^= cache.idOf(DESCS[i], shaderIds[i])
      continue
    }
    sink ^= cachedIds[i] // the hot path: a flat array read
  }
  return sink
}

function bestOf(repeats: number, run: () => number): number {
  let best = Infinity
  for (let i = 0; i < repeats; i++) {
    const startedAt = performance.now()
    run()
    const elapsed = performance.now() - startedAt
    if (elapsed < best) best = elapsed
  }
  return best
}

// warm-up
for (let i = 0; i < 50; i++) { runStringKeys(); runIntegerRegistry() }

const stringMs = bestOf(FRAMES, runStringKeys)
const integerMs = bestOf(FRAMES, runIntegerRegistry)

console.log('── Theory D: pipeline cache keys, frame of 1000 commands ──')
console.log(`string keys          : ${stringMs.toFixed(4)} ms`)
console.log(`integer registry     : ${integerMs.toFixed(4)} ms`)
console.log(`integer is ${(stringMs / integerMs).toFixed(1)}x faster`)
