// task193-bitdiscard — THE BIT-DISCARD LIVE GATE (Task 193, theory A).
//
// The Task-189 probe proved the WGSL semantics with hand-rolled pipelines;
// this gate proves the PRODUCTION FACADE on the container's real WebGPU
// stack (SwiftShader + Vulkan, through the dist bundle): buildPipeline's
// group-2 read-only-storage layout (with the EMPTY group 1 for the
// texture-less command), the bindStorageBuffer memo path, and the draw —
//   A. THE CPU-COLLECT PATH: the visible instances compacted CPU-side
//      (k×16 matrices + k×4 colors), drawn as k instances;
//   B. THE BIT-DISCARD PATH: ALL n instances from the full rank-ordered
//      record; the VERTEX shader reads the member's visibility bit from
//      the storage (@group(2) @binding(0)) and collapses the invisible to
//      clip.
//
// WHY THE FACADE IS DRIVEN DIRECTLY (not renderer.frame/step): this
// container's SwiftShader stack kills the GPU process on the FIRST CANVAS
// PRESENT (the documented Task-175 "devices die unwatched right after
// their first present" — task174's canvas-hash gates currently ride that
// flake as parity-of-blanks). The renderer's step ALWAYS opens the canvas
// pass, so the gate drives the facade's public methods in the EXECUTOR'S
// pinned order (packages/webgpu/tests/task193webgpu.test.ts): bindTarget →
// ensurePipeline → usePipeline → uploadUniforms → bindUniforms →
// bindStorageBuffer → bindVertexBuffer × slots → draw → endPass → submit —
// over a SURFACE target (no canvas pass, no present). The verdict channel
// is the surface readback (Task 80 — copyTextureToBuffer), the honest one.
//
// THE VERDICT: identical pixels (SHA-256 over the readbacks) + the painted
// count ≥ the visible count + zero GPU errors.
// Exit 0 — live-verified; 1 — it broke.
// Usage: bun scripts/task193-bitdiscard.mjs
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK193BD_PORT ?? 8179)

const server = Bun.serve({
  port,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/gate.html') {
      return new Response(GATE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(await file.text(), { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
  },
})

const GATE_HTML = `<!doctype html>
<html><body style="margin:0;background:#222">
<canvas id="c" width="256" height="256" style="width:256px;height:256px"></canvas>
<script type="module">
import { createWebGpuRenderer } from '/dist/rune.esm.js?v=193b'

// ── the fixture: 2048 instances on a 64×32 grid, seeded 45% visibility ─────
const N = 2048
const COLS = 64, ROWS = 32
let s = 0x1234567
const rng = () => { s = (s ^ (s >>> 15)) * 2246822519; s = (s ^ (s >>> 13)) * 3266489917; return ((s ^= s >>> 16) >>> 0) / 4294967296 }
const worldFull = new Float32Array(N * 16)   // rank-ordered, column-major rows
const colorsFull = new Float32Array(N * 4)
const bits = new Uint32Array((N + 31) >> 5)
const visibleOf = new Uint8Array(N)
let k = 0
for (let r = 0; r < N; r++) {
  const col = r % COLS, row = (r / COLS) | 0
  const x = (col - COLS / 2 + 0.5) * 10, y = (row - ROWS / 2 + 0.5) * 8
  const o = r * 16
  worldFull[o] = 2; worldFull[o + 5] = 2; worldFull[o + 10] = 1; worldFull[o + 15] = 1
  worldFull[o + 12] = x; worldFull[o + 13] = y
  colorsFull[r * 4] = 0.3 + rng() * 0.7
  colorsFull[r * 4 + 1] = 0.3 + rng() * 0.7
  colorsFull[r * 4 + 2] = 0.3 + rng() * 0.7
  colorsFull[r * 4 + 3] = 1
  const vis = rng() < 0.45
  if (vis) { bits[r >> 5] |= 1 << (r & 31); visibleOf[r] = 1; k++ }
}
// the CPU collect stand-in (the exact compaction B removes from the frame)
const worldCompact = new Float32Array(k * 16)
const colorsCompact = new Float32Array(k * 4)
const collect = () => {
  let j = 0
  for (let r = 0; r < N; r++) {
    if (visibleOf[r] === 0) continue
    worldCompact.set(worldFull.subarray(r * 16, r * 16 + 16), j * 16)
    colorsCompact.set(colorsFull.subarray(r * 4, r * 4 + 4), j * 4)
    j++
  }
  return j
}
collect()
for (let i = 0; i < 200; i++) collect() // warm
const t0 = performance.now()
for (let i = 0; i < 1000; i++) collect()
const collectUsPerCall = (performance.now() - t0) / 1000 * 1000

// the ortho MVP (column-major) — the grid fills the surface
const l = -320, r = 320, b = -128, t = 128
const MVP = [2/(r-l),0,0,0, 0,2/(t-b),0,0, 0,0,-1,0, -(r+l)/(r-l),-(t+b)/(t-b),0,1]
const QUAD = new Float32Array([-1,-1, 1,-1, -1,1, 1,-1, 1,1, -1,1])

const COMMON = \`
struct Params { u_mvp: mat4x4<f32>, u_rank0: u32 }
@group(0) @binding(0) var<uniform> params: Params;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32> }
@fragment fn fsMain(i: VOut) -> @location(0) vec4<f32> { return i.color; }
\`
const VS_HEAD = \`
@vertex fn vsMain(@location(0) corner: vec2<f32>, @location(1) m0: vec4<f32>, @location(2) m1: vec4<f32>, @location(3) m2: vec4<f32>, @location(4) m3: vec4<f32>, @location(5) tint: vec4<f32>\`
const VS_TAIL = \`) -> VOut {
  let model = mat4x4<f32>(m0, m1, m2, m3);
  var o: VOut;
  o.pos = params.u_mvp * model * vec4<f32>(corner, 0.0, 1.0);
  o.color = tint;
  return o;
}\`
// A: the classic collect path — k compacted instances, no storage
const WGSL_A = COMMON + VS_HEAD + VS_TAIL
// B: the bit-discard path — all n instances, the filter collapses the rest
const WGSL_B = COMMON + \`
@group(2) @binding(0) var<storage, read> sceneBits: array<u32>;
\` + VS_HEAD + \`, @builtin(instance_index) ii: u32\` + VS_TAIL.replace(
  'o.pos = params.u_mvp * model * vec4<f32>(corner, 0.0, 1.0)',
  \`let rank = params.u_rank0 + ii;
  let word = sceneBits[rank >> 5u];
  let visible = (word & (1u << (rank & 31u))) != 0u;
  o.pos = params.u_mvp * model * vec4<f32>(corner, 0.0, 1.0);
  if (!visible) { o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0); }\`)

const errors = []
// the uniform bytes: u_mvp (16 floats) + u_rank0 (u32) — 80 bytes, the
// reflection's own layout (mat4 at 0, u32 at 64)
const uniformBytes = (rankBase) => {
  const buf = new Uint8Array(80)
  const f = new Float32Array(buf.buffer, 0, 16)
  f.set(MVP)
  new Uint32Array(buf.buffer, 64, 1)[0] = rankBase
  return buf
}

async function boot() {
  let renderer = null
  for (let attempt = 0; attempt < 4 && renderer === null; attempt++) {
    try {
      // BOOT ONLY (configure — no start/step: the renderer's step always
      // opens the CANVAS pass, and a canvas present kills this stack's GPU
      // process — the documented Task-175 unwatched-death; the gate drives
      // the facade directly over a SURFACE instead)
      renderer = await createWebGpuRenderer({
        canvas: document.querySelector('#c'),
        clear: { color: [0.05, 0.06, 0.09, 1], depth: 1 },
        onGpuError: m => errors.push(m),
      })
    } catch (e) {
      window.__bootErr = String(e)
      await new Promise(r2 => setTimeout(r2, 900))
    }
  }
  if (renderer === null) throw new Error(window.__bootErr ?? 'boot failed')
  const gpu = renderer.gpu
  const surface = renderer.surface({ width: 256, height: 256 })
  window.__read = () => surface.read()

  // the vertex layouts (the executor's attr order): position (vertex step)
  // + 4 matrix columns (instance, stride 64) + tint (instance, stride 16)
  const ATTRS = [
    { size: 2, stride: 8, offset: 0, step: 'vertex' },
    { size: 4, stride: 64, offset: 0, step: 'instance' },
    { size: 4, stride: 64, offset: 16, step: 'instance' },
    { size: 4, stride: 64, offset: 32, step: 'instance' },
    { size: 4, stride: 64, offset: 48, step: 'instance' },
    { size: 4, stride: 16, offset: 0, step: 'instance' },
  ]

  // the draw — the facade driven in the EXECUTOR'S pinned order (the
  // task193webgpu.test.ts stream: bindTarget → ensurePipeline → usePipeline
  // → uploadUniforms → bindUniforms → [bindStorageBuffer] → the vertex
  // buffers → draw → endPass → submit)
  const drawMode = (mode) => {
    const world = mode === 'a' ? worldCompact : worldFull
    const colors = mode === 'a' ? colorsCompact : colorsFull
    const instances = mode === 'a' ? k : N
    const pipelineId = mode === 'a' ? 1 : 2
    const wgsl = mode === 'a' ? WGSL_A : WGSL_B
    gpu.bindTarget(surface.targetId, true)
    gpu.ensurePipeline(pipelineId, wgsl, ATTRS, false, {})
    gpu.usePipeline(pipelineId)
    gpu.uploadUniforms(0, uniformBytes(0))
    gpu.bindUniforms(0)
    if (mode === 'b') gpu.bindStorageBuffer(window.__bitsId)
    gpu.bindVertexBuffer(0, QUAD, 2)
    gpu.bindVertexBuffer(1, world, 4)
    gpu.bindVertexBuffer(2, world, 4)
    gpu.bindVertexBuffer(3, world, 4)
    gpu.bindVertexBuffer(4, world, 4)
    gpu.bindVertexBuffer(5, colors, 4)
    gpu.draw(6, instances)
    gpu.endPass()
    gpu.submit()
  }

  // the bits storage: ONE external buffer, written once (a live scene
  // writes it per epoch — writeExternalBuffer; the SAB views are legal
  // sources, the queue snapshots at call time — the Task-185 contract)
  const words = (N + 31) >> 5
  const bitsId = gpu.createExternalBuffer(words * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
  gpu.writeExternalBuffer(bitsId, bits)
  window.__bitsId = bitsId

  drawMode('a')
  const pixelsA = (await surface.read()).data
  // then B: the bit-discard path (the same surface, re-cleared)
  drawMode('b')
  const pixelsB = (await surface.read()).data
  window.__result = { visibleCount: k, instances: N, collectUsPerCall, errors, pixelsA, pixelsB }
}
boot().catch(e => {
  window.__result = { bootFail: String(e && e.message || e), errors, visibleCount: k, instances: N }
})
</script>
</body></html>`

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failed = false
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)))
  await page.goto(`http://localhost:${port}/gate.html`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 120_000 })
  const result = await page.evaluate(() => {
    const r = window.__result
    if (r.pixelsA !== undefined) {
      // the pixel payloads travel as plain arrays over the structured clone
      return { ...r, pixelsA: undefined, pixelsB: undefined, lenA: r.pixelsA.length, lenB: r.pixelsB.length }
    }
    return r
  })
  if (result.bootFail !== undefined) {
    console.log(`[task193-bd] BOOT FAILED on the WG stack: ${String(result.bootFail).slice(0, 300)}`)
    failed = true
  } else {
    console.log(`[task193-bd] fixture: n=${result.instances} instances, visible k=${result.visibleCount} (${(result.visibleCount * 100 / result.instances).toFixed(1)}%)`)
    console.log(`[task193-bd] GPU errors: ${result.errors.length}${result.errors.length > 0 ? ' — ' + result.errors.slice(0, 4).join(' | ').slice(0, 400) : ''}`)
    if (result.errors.length > 0) failed = true

    // THE PIXEL VERDICT — the surface readbacks (Task 80: RGBA, tight, top-down)
    const pixelsA = new Uint8Array(await page.evaluate(() => window.__result.pixelsA))
    const pixelsB = new Uint8Array(await page.evaluate(() => window.__result.pixelsB))
    const bufA = Buffer.from(pixelsA)
    const bufB = Buffer.from(pixelsB)
    const hashA = createHash('sha256').update(bufA).digest('hex')
    const hashB = createHash('sha256').update(bufB).digest('hex')
    const same = hashA === hashB && bufA.length === 256 * 256 * 4
    console.log(`[task193-bd] pixel parity (CPU collect vs bit-discard, surface readback): ${same ? 'IDENTICAL' : 'DIFFERS'} (a=${hashA.slice(0, 12)} b=${hashB.slice(0, 12)}, ${bufA.length} bytes)`)
    if (!same) failed = true
    // the painted count — the surface's default clear (0.07, 0.08, 0.11)
    const painted = { a: 0, b: 0 }
    for (let i = 0; i < bufA.length; i += 4) {
      if (Math.abs(bufA[i] - 18) + Math.abs(bufA[i + 1] - 20) + Math.abs(bufA[i + 2] - 28) > 12) painted.a++
      if (Math.abs(bufB[i] - 18) + Math.abs(bufB[i + 1] - 20) + Math.abs(bufB[i + 2] - 28) > 12) painted.b++
    }
    console.log(`[task193-bd] painted pixels — A: ${painted.a}, B: ${painted.b} (${result.visibleCount} visible quads)`)
    if (painted.a < result.visibleCount || painted.b < result.visibleCount) {
      console.log('[task193-bd] FAIL — a surface is blank (the draws never landed)')
      failed = true
    }
    if (painted.a !== painted.b) {
      console.log('[task193-bd] FAIL — the painted counts diverge (the filter is not bit-exact)')
      failed = true
    }

    // the honest trade
    console.log(`[task193-bd] the CPU collect B removes: ${result.collectUsPerCall?.toFixed(1)}µs per call at ${result.instances} instances (scales with n)`)
    console.log(`[task193-bd] the GPU cost B adds: ${result.instances - result.visibleCount} wasted vertex invocations per draw (${(100 * (result.instances - result.visibleCount) / result.instances).toFixed(1)}% of n at ${(result.visibleCount * 100 / result.instances).toFixed(0)}% visibility)`)
    console.log('[task193-bd] the scene-side source: gpuInstanceSource(views, cam, buffer, g) + INSTANCE_BIT_FILTER_WGSL (the documented contract); the renderer spec: { storage: { bufferId } }')
  }
} catch (error) {
  console.error(`[task193-bd] gate crashed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  await browser.close()
  server.stop()
}

console.log(failed ? '\nTASK 193 BIT-DISCARD GATE: FAIL' : '\nTASK 193 BIT-DISCARD GATE: PASS')
process.exit(failed ? 1 : 0)
