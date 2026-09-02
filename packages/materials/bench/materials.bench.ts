import { materialOf, resetMaterials, assemble, pbrMask, type AssembledMaterial, type PbrModelChoice } from '../src/index.ts'
import {
  SKIN, INSTANCED, NORMALMAP, TEXTURE, FLAT_ALBEDO, VERTEX_COLOR,
  DOUBLE_SIDED, ALPHA_CUTOFF, LAMBERT, MATCAP, EMISSIVE, FOG,
  PBR_MR_TEXTURE,
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

/** A few named PBR configurations (the sub-model matrix). */
const PBR_VARIANTS: Array<[name: string, choice: PbrModelChoice]> = [
  ['pbr default (ggx+smith+schlick+lambert)', {}],
  ['pbr karis (smith-schlick+burley)', { geometry: 'smith-schlick', diffuse: 'burley' }],
  ['pbr height-correlated', { geometry: 'smith-height' }],
  ['pbr oren-nayar (kelemen+exact)', { geometry: 'kelemen', fresnel: 'exact', diffuse: 'oren-nayar' }],
  ['pbr blinn (schlick)', { distribution: 'blinn-phong', geometry: 'implicit' }],
]

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
for (const [name, choice] of PBR_VARIANTS) {
  VARIANTS.push([name, pbrMask(choice) | FLAT_ALBEDO, 0])
}
VARIANTS.push(['pbr-house (tex+2s+mask)', pbrMask() | TEXTURE | DOUBLE_SIDED | ALPHA_CUTOFF, 0])
VARIANTS.push(['pbr-nmap (tex+nmap)', pbrMask() | TEXTURE | NORMALMAP, 0])
VARIANTS.push(['pbr-mr (flat+mr texture)', pbrMask() | FLAT_ALBEDO | PBR_MR_TEXTURE, 0])
VARIANTS.push(['pbr-skin (skin 67)', SKIN | pbrMask() | FLAT_ALBEDO | DOUBLE_SIDED, 67])

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

// ── 5. The full BRDF matrix: all 84 valid D×G×F×diffuse combinations ────────
// (the sub-model proof: every one is a distinct, minimal, lint-clean variant)
// Bit positions: D 11..13 (ggx, beckmann, blinn), G 14..19 (smith, schlick,
// height, implicit, neumann, kelemen), F 20..21 (schlick, exact), diff 22..24.
const D_G: Array<[d: number, g: number]> = [
  [11, 14], [11, 15], [11, 16], [11, 17], [11, 18], [11, 19],
  [12, 15], [12, 17], [12, 18], [12, 19],
  [13, 15], [13, 17], [13, 18], [13, 19],
]
const F = [20, 21]  // schlick, exact
const DIFF = [22, 23, 24]  // lambert, oren-nayar, burley
const SUB_BITS = (0b111 << 11) | (0b111111 << 14) | (0b11 << 20) | (0b111 << 22)
const PBR_CLEAR = pbrMask() & ~SUB_BITS
let brdfCount = 0
const brdfMs = bestOf(20, () => {
  for (const [dShift, gShift] of D_G) {
    for (const fShift of F) {
      for (const diffShift of DIFF) {
        const mask = PBR_CLEAR | (1 << dShift) | (1 << gShift) | (1 << fShift) | (1 << diffShift)
        assemble(mask | FLAT_ALBEDO, 0)
        brdfCount++
      }
    }
  }
})

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
console.log(`the 84-variant BRDF matrix   : ${brdfCount} assemblies in ${(brdfMs * 1000).toFixed(0)} µs ` +
  `(${(brdfMs * 1000 / brdfCount).toFixed(1)} µs per variant, best of 20)`)
