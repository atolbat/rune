/**
 * scripts/research208-search.mjs — the fresh web sweep for Task 208's two
 * research questions (re-created after the /tmp copy was lost; the 429
 * rate-limited first attempt is documented in graphics-research-208.md):
 *
 *   (A) further optimization of the two-pass HZB occluder machinery;
 *   (B) occlusion culling with arbitrary non-square geometry.
 *
 * Do-not-re-report list (the 205–207 page-verified corpus — search for what
 * is NEW on top of these, not for these again):
 *   bevy PR#17413 + PR#18711, Granite hiz.comp, GPUPrefixSums (b0nes164),
 *   kishimisu webgpu-radix-sort, Chrome-134 subgroups ship, Pettineo
 *   «To Early-Z or Not To Early-Z» (Apr 2025), VTK WebGPU occlusion culler
 *   (Clabault 2024), Momber two-pass HZB (Apr 2025), devsh reprojection gist,
 *   H-PLOC, Concurrent Binary Trees, k-DOP (HPG 2024), LiPaC, NeuralPVS,
 *   DOBB, Fused Collapsing, UBVH, Merged Nodes, HROC, MOC, tz-pyramid,
 *   CSSE WebGPU occlusion (2023), Koltun virtual occluders, Essafi fusion,
 *   Bartz–Klosowski–Staneker occluder simplification, Durand taxonomy.
 *
 * Usage: bun scripts/research208-search.mjs [outdir]
 * Paced (1 query / 6s); results land in <outdir>/r208-qNN.json + a flat digest.
 */
import ZAI from '/home/z/.bun/install/global/node_modules/z-ai-web-dev-sdk/dist/index.js'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

const outDir = process.argv[2] ?? '/home/z/my-project/rune/scripts/out/research208'
mkdirSync(outDir, { recursive: true })

// ── the queries (ranked: the freshest angles first, no re-reports) ──────────
const QUERIES = [
  // (A) the occluder pass
  { id: 'a1', q: 'GPU occlusion culling optimization 2025 hierarchical depth buffer', topic: 'A' },
  { id: 'a2', q: 'WebGPU occlusion culling 2025', topic: 'A' },
  { id: 'a3', q: 'GPU-driven rendering compaction prefix scan compute cull 2025', topic: 'A' },
  { id: 'a4', q: 'Hi-Z pyramid build optimization single pass compute shader', topic: 'A' },
  { id: 'a5', q: 'two-pass occlusion culling depth prepass cost optimization game engine', topic: 'A' },
  { id: 'a6', q: 'front to back sorting early-Z overdraw reduction GPU instancing 2025', topic: 'A' },
  { id: 'a7', q: 'wgpu occlusion culling example 2025', topic: 'A' },
  // (B) arbitrary non-square geometry
  { id: 'b1', q: 'oriented bounding box OBB occlusion culling GPU compute', topic: 'B' },
  { id: 'b2', q: 'convex hull visibility test GPU culling kernel', topic: 'B' },
  { id: 'b3', q: 'occlusion culling arbitrary mesh geometry non-box occluders', topic: 'B' },
  { id: 'b4', q: 'rotated box screen space bounds conservative rasterization culling', topic: 'B' },
  { id: 'b5', q: 'occluder proxy simplification depth-only prepass arbitrary geometry', topic: 'B' },
  { id: 'b6', q: 'k-DOP bounding volume GPU visibility test 2025', topic: 'B' },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

const zai = await ZAI.create()
const digest = []
let ok = 0, fail = 0

for (const { id, q, topic } of QUERIES) {
  const file = `${outDir}/r208-${id}.json`
  try {
    const t0 = Date.now()
    const results = await zai.functions.invoke('web_search', { query: q, num: 10 })
    writeFileSync(file, JSON.stringify({ id, q, topic, results }, null, 2))
    ok++
    const top = (results ?? []).slice(0, 6).map(r => `    ${r.host_name} · ${r.name} · ${r.date ?? '?'}`)
    digest.push(`[${id}] (${topic}) "${q}" — ${results?.length ?? 0} results (${Date.now() - t0}ms)\n${top.join('\n')}`)
    console.log(`[${id}] ok — ${results?.length ?? 0} results`)
  } catch (e) {
    fail++
    digest.push(`[${id}] (${topic}) "${q}" — FAIL: ${e.message}`)
    console.log(`[${id}] FAIL: ${e.message}`)
  }
  await sleep(6000) // the pacing that the first attempt still 429'd on — retry slower
}

writeFileSync(`${outDir}/digest.txt`, digest.join('\n\n') + '\n')
console.log(`\nsweep done: ${ok} ok, ${fail} failed → ${outDir}`)
