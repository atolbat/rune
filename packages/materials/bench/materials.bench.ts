import { materialOf, resetMaterials, assemble } from '../src/index.ts'
import { SKIN, LAMBERT, TEXTURE, NORMALMAP, FLAT_ALBEDO, DOUBLE_SIDED, ALPHA_CUTOFF } from '../src/index.ts'

/**
 * The assembly-pipeline benchmark.
 *
 * Three paths:
 *  1. COLD assembly — a brand-new feature combination (string build, once);
 *  2. CACHE HIT — materialOf on a cached combination (the per-frame path:
 *     one numeric Map probe, zero allocations);
 *  3. STRING-KEY baseline — the "big shader per material" alternative
 *     (compose a source string and probe a string-keyed Map) for scale.
 *
 * The lesson of the repo's Theory D applies here too: the variant registry
 * must be numeric. The cache hit is what a frame actually pays.
 */

const VARIANTS: Array<[name: string, features: number, joints: number]> = [
  ['unlit-flat', FLAT_ALBEDO, 0],
  ['lambert-flat', FLAT_ALBEDO | LAMBERT, 0],
  ['lambert-flat-2s', FLAT_ALBEDO | LAMBERT | DOUBLE_SIDED, 0],
  ['lambert-tex', TEXTURE | LAMBERT, 0],
  ['house (tex+mask+2s)', TEXTURE | LAMBERT | DOUBLE_SIDED | ALPHA_CUTOFF, 0],
  ['nefertiti (tex+nmap+2s)', TEXTURE | NORMALMAP | LAMBERT | DOUBLE_SIDED, 0],
  ['samba (skin 67)', SKIN | LAMBERT | FLAT_ALBEDO | DOUBLE_SIDED, 67],
  ['samba-32 (skin 32)', SKIN | LAMBERT | FLAT_ALBEDO | DOUBLE_SIDED, 32],
]

function bestOf(repeats: number, run: () => void): number {
  let best = Infinity
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now()
    run()
    const dt = performance.now() - t0
    if (dt < best) best = dt
  }
  return best
}

// ── 1. Cold assembly ───────────────────────────────────────────────────────
const coldMs: Array<[string, number]> = []
for (const [name, features, joints] of VARIANTS) {
  const ms = bestOf(200, () => { assemble(features, joints) })
  coldMs.push([name, ms])
}

// ── 2. Cache hit (the per-frame path) ──────────────────────────────────────
resetMaterials()
for (const [, features, joints] of VARIANTS) materialOf({ features, jointCount: joints })
const hitMs = bestOf(100_000, () => {
  for (const [, features, joints] of VARIANTS) materialOf({ features, jointCount: joints })
}) / VARIANTS.length

// ── 3. String-key baseline (the per-material shader dictionary) ───────────
const stringCache = new Map<string, { glsl: unknown }>()
for (const [, features, joints] of VARIANTS) {
  const m = assemble(features, joints)
  stringCache.set(`${features}:${joints}`, { glsl: m.glsl })
}
const stringMs = bestOf(100_000, () => {
  for (const [, features, joints] of VARIANTS) stringCache.get(`${features}:${joints}`)
}) / VARIANTS.length

// ── report ─────────────────────────────────────────────────────────────────
console.log('── Materials: the assembly pipeline ──')
console.log('cold assembly (one variant, best of 200):')
for (const [name, ms] of coldMs) console.log(`  ${name.padEnd(26)}: ${(ms * 1000).toFixed(1)} µs`)
console.log(`cache hit (numeric key)      : ${(hitMs * 1_000_000).toFixed(0)} ns / lookup`)
console.log(`string-key Map probe         : ${(stringMs * 1_000_000).toFixed(0)} ns / lookup`)
console.log(`numeric key is ${(stringMs / hitMs).toFixed(1)}x cheaper on the hot path`)
console.log(`variant count after warmup   : ${VARIANTS.length} (8 combos share ${VARIANTS.length} shader pairs)`)
