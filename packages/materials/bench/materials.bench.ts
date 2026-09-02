import { materialOf, resetMaterials, assemble, type AssembledMaterial } from '../src/index.ts'
import {
  SKIN, INSTANCED, NORMALMAP, TEXTURE, FLAT_ALBEDO, VERTEX_COLOR,
  DOUBLE_SIDED, ALPHA_CUTOFF, LAMBERT, MATCAP, EMISSIVE, FOG,
} from '../src/index.ts'

/**
 * The assembly-pipeline benchmark.
 *
 * Four paths:
 *  1. COLD assembly — a brand-new feature combination (string build, once);
 *  2. CACHE HIT — materialOf on a cached combination (the per-frame path:
 *     one numeric Map probe, zero allocations);
 *  3. STRING-KEY baseline — the "big shader per material" alternative
 *     (compose a source string and probe a string-keyed Map) for scale;
 *  4. RETAINED FOOTPRINT — a cold batch of 200 distinct variants: after a
 *     full GC only the results may survive (the scratch is shared, nothing
 *     per-variant leaks). The factor vs the raw source bytes is the record
 *     overhead — ghost blocks would show up as growth here.
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
  ['matcap-flat', MATCAP | FLAT_ALBEDO, 0],
  ['matcap-tex-2s', MATCAP | TEXTURE | DOUBLE_SIDED, 0],
  ['matcap-nmap', MATCAP | TEXTURE | NORMALMAP, 0],
  ['foggy (tex+lambert+fog)', TEXTURE | LAMBERT | FOG, 0],
  ['vcolor (tex+lambert)', TEXTURE | LAMBERT | VERTEX_COLOR, 0],
  ['glow (flat+emissive)', FLAT_ALBEDO | EMISSIVE, 0],
  ['instanced (flat+lambert)', FLAT_ALBEDO | LAMBERT | INSTANCED, 0],
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

// ── 4. Retained footprint of a cold batch (the ghost-block check) ─────────
// 200 DISTINCT variants (the skin palette size differs), every source kept
// alive; a full GC before/after. Only the results may survive: the scratch
// lives at module level, the per-variant temps are unreachable by then.
// (Bun's process.memoryUsage().heapUsed is a constant stub — rss is the
// honest signal; it counts whole pages, so the factor is approximate.)
function retainedFootprint(): { factor: number; perVariant: number } | null {
  if (typeof Bun === 'undefined' || typeof Bun.gc !== 'function') return null
  const N = 200
  const keep: AssembledMaterial[] = []
  const sources = () => keep.reduce((sum, m) =>
    sum + m.glsl.vertex.length + m.glsl.fragment.length + m.wgsl.length, 0)
  Bun.gc(true)
  const before = process.memoryUsage().rss
  for (let i = 0; i < N; i++) keep.push(assemble(SKIN | LAMBERT | FLAT_ALBEDO | DOUBLE_SIDED, i + 1))
  Bun.gc(true)
  const after = process.memoryUsage().rss
  const retained = Math.max(0, after - before)
  return { factor: retained / Math.max(1, sources()), perVariant: retained / N }
}
const footprint = retainedFootprint()

// ── report ─────────────────────────────────────────────────────────────────
console.log('── Materials: the assembly pipeline ──')
console.log('cold assembly (one variant, best of 200):')
for (const [name, ms] of coldMs) console.log(`  ${name.padEnd(26)}: ${(ms * 1000).toFixed(1)} µs`)
console.log(`cache hit (numeric key)      : ${(hitMs * 1_000_000).toFixed(0)} ns / lookup`)
console.log(`string-key Map probe         : ${(stringMs * 1_000_000).toFixed(0)} ns / lookup`)
console.log(`numeric key is ${(stringMs / hitMs).toFixed(1)}x cheaper on the hot path`)
if (footprint === null) {
  console.log('retained footprint           : (Bun.gc unavailable here — skipped)')
} else {
  console.log(`retained after a cold batch  : ${footprint.perVariant.toFixed(0)} B / variant, ` +
    `${footprint.factor.toFixed(2)}x the source bytes (results only — the scratch is shared)`)
}
console.log(`variant count after warmup   : ${VARIANTS.length} combos share ${VARIANTS.length} shader pairs`)
