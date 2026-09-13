// occlusion/main.js — Task 196: HIERARCHICAL Z-BUFFER OCCLUSION CULLING,
// the demo tier. The whole GPU-driven pipeline rides THE LIBRARY'S OWN
// facade contract (dist/rune.esm.js), driven directly in the executor's
// pinned order — the task193-bitdiscard gate pattern, promoted to a page:
//
//   ┌─ 1. THE Z PREPASS: the occluders (a city's buildings + ground) render
//   │     into an r32float TARGET — the fragment writes @builtin(position).z,
//   │     the EXACT depth-buffer value; the target's internal depth24plus
//   │     attachment (depth test 'less', write on) keeps the NEAREST
//   │     occluder per pixel — a hardware min-blend without blending.
//   │     [Task 196 contract: the pipeline TARGET-FORMAT axis — an r32float
//   │     target builds its own pipeline variant; pre-196 this draw died in
//   │     Dawn validation "Incompatible render targets".]
//   │
//   ├─ 2. THE HI-Z PYRAMID: one compute family over the facade's
//   │     createCompute — zToMip0 (textureLoad on the z tile through the
//   │     family's new TEXTURE slot, binding 6) + reduceL1..reduceLmax
//   │     (2×2 MAX-reduction per level — the farthest surface per tile,
//   │     the SOUND form of the occlusion test; packed into ONE buffer).
//   │     [Task 196 contract: compute-family texture bindings — read-only
//   │     'sampled'/'depth' kinds, slots 6.. after the buffer slots.]
//   │     The per-level constants are ENTRY POINTS, not uniforms — the
//   │     family uniform is frame-static BY DESIGN (the queue orders
//   │     writeBuffer before the submit that carries the dispatches, so a
//   │     per-dispatch uniform is impossible; per-dispatch state rides the
//   │     storage buffers or becomes an entry — the documented pattern).
//   │
//   ├─ 3. THE CULL KERNEL: every occludee's AABB projects to a conservative
//   │     screen rect; the mip level is picked by the rect size; up to 2×2
//   │     texels of that level give the region's max-reduced depth; the
//   │     box's NEAREST corner depth vs that max decides visibility. Frustum
//   │     first (all-8-corners-outside-one-plane), near-straddlers kept
//   │     visible and COUNTED (honest). The verdicts land as per-instance
//   │     flags; a DETERMINISTIC single-thread compaction sweep builds the
//   │     list, the stats and the indirect args — GPU-side, no CPU readback,
//   │     no atomics (a stable draw order: the parity gate depends on it).
//   │
//   └─ 4. THE GPU-DRIVEN DRAW: the color pass draws the occluders
//         (drawIndexed, useList=0) + ONE drawIndexedIndirect over the
//         kernel-written args (useList=1 — the vertex shader dereferences
//         the compacted list through the Task-193 group-2 storage slot).
//         [Task 196 contract: drawIndexedIndirect/drawIndirect — core
//         WebGPU, no probe; the buffer needs INDIRECT usage.]
//
//   THE HONEST GATES (all live in the page):
//   · PIXEL PARITY: Hi-Z ON vs OFF (frustum-only) render the SAME camera
//     into a surface — the sha256 of both readbacks must be IDENTICAL
//     (opaque + depth-tested rendering is order-independent, so culling
//     occluded boxes cannot change a single pixel). Run at boot (probe
//     mode) and on the Validate button (the current camera).
//   · THE ACCOUNTING INVARIANT: frustumCulled + occlusionCulled + drawn
//     === occludees — every instance lands in exactly one bucket.
//   · THE STATS: drawn(ON) < drawn(OFF), occlusionCulled > 0.
//   · onGpuError collects EVERYTHING (the log + __hizStats.errors).
//
//   THE PAGE: the scene is a city canyon — 23 occluders (ground, 20
//   buildings, 2 towers) and 16384 occludee boxes in the street and the
//   backyards; an orbiting camera reads the occlusion. WebGL2 keeps the
//   honest refusal (Hi-Z is compute — WebGPU only). On a SOFTWARE adapter
//   (SwiftShader/llvmpipe — the container class where the canvas present
//   kills the GPU process, the documented Task-175 death) the page
//   degrades to SNAPSHOT MODE: every frame renders into a surface and
//   blits into a 2D canvas — the full pipeline, zero presents.
//
//   window.__hizStats — the live counters (the smoke/gates read it);
//   window.__hizGate — the probe verdict (?probe=1: the validation only,
//   no rAF loop, no canvas — the container-safe channel).

import { createWebGpuRenderer } from '../../dist/rune.esm.js?v=196'

const PARAMS = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
const PROBE = PARAMS.has('probe')
const FORCE_SNAPSHOT = PARAMS.has('snapshot')
const OCCL = Math.max(256, Math.min(65536, Number(PARAMS.get('n')) || 16384))

// ── the demo shell ────────────────────────────────────────────────────────
// the late-bound pause/resume controller (the shell reads its callbacks
// from the mount options; the loop only exists after a successful boot)
const democtl = { pause() {}, resume() {} }
const shell = window.RuneDemoShell.mount({
  layout: 'page',
  title: 'Hi-Z occlusion culling',
  desc: 'Hierarchical Z-buffer culling, GPU-driven: a depth prepass, a compute-built min-Z pyramid, a cull kernel that compacts the visible set, one indirect draw — the whole rune facade contract, 16384 boxes behind a city of occluders.',
  hint: 'Drag — orbit · wheel — zoom · the buttons toggle the culling tiers and the pyramid view. The WebGL2 toggle is an honest refusal: the Hi-Z tier is compute, WebGPU only.',
  defaults: { mode: 'webgpu' },
  onPause() { democtl.pause() },
  onResume() { democtl.resume() },
  onMode(mode) {
    if (mode !== 'webgpu') {
      shell.log.info(`backend ${mode}: the Hi-Z tier is WebGPU compute — this experimental page stays on WebGPU (the scene needs the pyramid kernels; a WebGL2 occlusion tier would be a different, framebuffer-downsample contract)`)
    }
  },
})

const errors = []
function noteError(message) {
  errors.push(message)
  shell.log.error(message)
}

// ── mat4 (column-major, WebGPU NDC: z in [0,1], +y up-screen) ─────────────
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, far * near * nf, 0,
  ])
}
function lookAt(eye, target, up) {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2]
  let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
  let rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0]
  l = Math.hypot(rx, ry, rz); rx /= l; ry /= l; rz /= l
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
  return new Float32Array([
    rx, ux, -fx, 0,
    ry, uy, -fy, 0,
    rz, uz, -fz, 0,
    -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
    -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
    fx * eye[0] + fy * eye[1] + fz * eye[2],
    1,
  ])
}
function mat4Mul(a, b) {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = s
    }
  }
  return out
}

// ── the scene: a city canyon, seeded and deterministic ────────────────────
const K = 23 // occluders: ground + 20 buildings + 2 towers
const N = OCCL + K
const LIST_WORDS = OCCL
const FLAGS_OFF = OCCL // word offset of the per-instance verdict flags
const INST_OFF = 2 * OCCL // word offset of instance 0's record

let seed = 0x9e3779b9
function rng() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return (seed >>> 0) / 4294967296
}

const sceneWords = new Uint32Array(LIST_WORDS + OCCL + N * 12) // [list][flags][instance records]
const sceneF32 = new Float32Array(sceneWords.buffer)
const occluderBoxes = [] // for prop rejection
function putInstance(i, center, half, color) {
  const wo = INST_OFF + i * 12
  sceneF32[wo] = center[0]; sceneF32[wo + 1] = center[1]; sceneF32[wo + 2] = center[2]
  sceneF32[wo + 3] = half[0]; sceneF32[wo + 4] = half[1]; sceneF32[wo + 5] = half[2]
  sceneF32[wo + 6] = color[0]; sceneF32[wo + 7] = color[1]; sceneF32[wo + 8] = color[2]
}
// occluder 0: the ground slab
putInstance(0, [0, -0.25, 0], [60, 0.25, 70], [0.09, 0.10, 0.13])
occluderBoxes.push({ c: [0, -0.25, 0], h: [60, 0.25, 70] })
// occluders 1..20: the canyon's two building rows
let next = 1
for (let i = 0; i < 10; i++) {
  for (const side of [-1, 1]) {
    const hx = 2.7 + rng() * 0.7
    const hy = 8 + rng() * 7
    const hz = 2.7 + rng() * 0.7
    const c = [side * 8, hy, -54 + i * 12 + (rng() - 0.5) * 3]
    const shade = 0.24 + rng() * 0.1
    putInstance(next, c, [hx, hy, hz], [shade, shade * 1.08, shade * 1.3])
    occluderBoxes.push({ c, h: [hx, hy, hz] })
    next++
  }
}
// occluders 21..22: the two big towers (the strong occluders)
putInstance(21, [15, 11, -18], [5, 11, 5], [0.2, 0.23, 0.3])
occluderBoxes.push({ c: [15, 11, -18], h: [5, 11, 5] })
putInstance(22, [-15, 11, 18], [5, 11, 5], [0.2, 0.23, 0.3])
occluderBoxes.push({ c: [-15, 11, 18], h: [5, 11, 5] })

const PALETTE = [
  [1.0, 0.62, 0.27], [0.94, 0.38, 0.30], [0.27, 0.63, 0.60],
  [0.90, 0.85, 0.78], [0.52, 0.42, 0.75], [0.85, 0.55, 0.35],
]
function insideOccluder(x, y, z, pad) {
  for (const b of occluderBoxes) {
    if (Math.abs(x - b.c[0]) < b.h[0] + pad && Math.abs(y - b.c[1]) < b.h[1] + pad && Math.abs(z - b.c[2]) < b.h[2] + pad) return true
  }
  return false
}
for (let i = 0; i < OCCL; i++) {
  for (let tries = 0; ; tries++) {
    const street = rng() < 0.3
    const x = street ? (rng() * 2 - 1) * 4.0 : (12.5 + rng() * 30) * (rng() < 0.5 ? -1 : 1)
    const z = (rng() * 2 - 1) * 66
    let hx = 0.15 + rng() * 0.45, hy = hx, hz = hx
    if (rng() < 0.1) hy *= 2.5
    const y = hy + 0.03 + rng() * 2.5
    if (tries < 32 && insideOccluder(x, y, z, Math.max(hx, hy, hz) + 0.05)) continue
    const pal = PALETTE[(rng() * PALETTE.length) | 0]
    const j = 0.85 + rng() * 0.3
    putInstance(K + i, [x, y, z], [hx, hy, hz], [pal[0] * j, pal[1] * j, pal[2] * j])
    break
  }
}

// ── the box geometry (unit corners [0,1]³, 24 verts, 36 indices) ──────────
const BOX_VERTS = new Float32Array([
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
  0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1,
  0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1,
  0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1,
  1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1,
])
const BOX_INDICES = new Uint16Array([
  0, 2, 1, 2, 3, 1, 4, 5, 6, 5, 7, 6, 8, 9, 10, 9, 11, 10,
  12, 14, 13, 14, 15, 13, 16, 17, 18, 17, 19, 18, 20, 22, 21, 22, 23, 21,
])
const QUAD_VERTS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1])

// ── the render resolution + the Hi-Z (half-res, the standard practice) ────
const CANVAS_W = 960, CANVAS_H = 540
const HIZ_W = Math.ceil(CANVAS_W / 2), HIZ_H = Math.ceil(CANVAS_H / 2)
const LEVEL_DIMS = [{ w: HIZ_W, h: HIZ_H }]
for (;;) {
  const prev = LEVEL_DIMS[LEVEL_DIMS.length - 1]
  const w = Math.max(1, Math.ceil(prev.w / 2)), h = Math.max(1, Math.ceil(prev.h / 2))
  LEVEL_DIMS.push({ w, h })
  if (w === 1 && h === 1) break
}
const LEVELS = LEVEL_DIMS.length
const MAX_LEVEL = LEVELS - 1
const LEVEL_OFF = [0]
for (let L = 1; L < LEVELS; L++) LEVEL_OFF.push(LEVEL_OFF[L - 1] + LEVEL_DIMS[L - 1].w * LEVEL_DIMS[L - 1].h)
const PYRAMID_WORDS = LEVEL_OFF[LEVELS - 1] + LEVEL_DIMS[MAX_LEVEL].w * LEVEL_DIMS[MAX_LEVEL].h
// THE FAMILY GRID IS 1D (runCompute dispatches workgroups(x) — the
// particles contract): 2D tiles flatten a linear thread index
const flatWorkgroups = (w, h) => Math.ceil(w * h / 64)

// ── WGSL: the generated kernels and pipelines (constants baked) ───────────
const C = { OCCL, K, FLAGS_OFF, INST_OFF, HIZ_W, HIZ_H, MAX_LEVEL }

const Z_WGSL = `
struct ZParams { mvp: mat4x4<f32> }
@group(0) @binding(0) var<uniform> params: ZParams;
@group(2) @binding(0) var<storage, read> scene: array<u32>;
struct VOut { @builtin(position) pos: vec4<f32> }
@vertex fn vsMain(@location(0) corner: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
  let wo = ${C.INST_OFF}u + ii * 12u;
  let c = vec3<f32>(bitcast<f32>(scene[wo]), bitcast<f32>(scene[wo + 1u]), bitcast<f32>(scene[wo + 2u]));
  let h = vec3<f32>(bitcast<f32>(scene[wo + 3u]), bitcast<f32>(scene[wo + 4u]), bitcast<f32>(scene[wo + 5u]));
  let world = c + h * (corner * 2.0 - 1.0);
  var o: VOut;
  o.pos = params.mvp * vec4<f32>(world, 1.0);
  return o;
}
@fragment fn fsMain(i: VOut) -> @location(0) vec4<f32> {
  // @builtin(position).z IS the depth-buffer value — the exact tile the
  // pyramid reduces; no re-derivation, no precision drift.
  return vec4<f32>(i.pos.z, 0.0, 0.0, 1.0);
}`

let PYR_REDUCE = ''
for (let L = 1; L < LEVELS; L++) {
  const wi = LEVEL_DIMS[L - 1], wo = LEVEL_DIMS[L]
  const oi = LEVEL_OFF[L - 1], oo = LEVEL_OFF[L]
  PYR_REDUCE += `
@compute @workgroup_size(64)
fn reduceL${L}(@builtin(global_invocation_id) gid: vec3<u32>) {
  // THE FLAT 1D GRID (the family's dispatch contract): t = y * wOut + x
  let t = gid.x;
  if (t >= ${wo.w * wo.h}u) { return; }
  let x = t % ${wo.w}u;
  let y = t / ${wo.w}u;
  let x0 = min(x * 2u, ${wi.w - 1}u);
  let x1 = min(x * 2u + 1u, ${wi.w - 1}u);
  let y0 = min(y * 2u, ${wi.h - 1}u);
  let y1 = min(y * 2u + 1u, ${wi.h - 1}u);
  let a = pyramid[${oi}u + y0 * ${wi.w}u + x0];
  let b = pyramid[${oi}u + y0 * ${wi.w}u + x1];
  let c = pyramid[${oi}u + y1 * ${wi.w}u + x0];
  let d = pyramid[${oi}u + y1 * ${wi.w}u + x1];
  pyramid[${oo}u + t] = max(max(a, b), max(c, d));
}
`
}
const PYR_WGSL = `
@group(0) @binding(1) var<storage, read_write> pyramid: array<f32>;
@group(0) @binding(6) var zTex: texture_2d<f32>;
@compute @workgroup_size(64)
fn zToMip0(@builtin(global_invocation_id) gid: vec3<u32>) {
  // THE FLAT 1D GRID: thread t = y * HIZ_W + x (the family's dispatch is
  // one-dimensional — a 2D gid here silently covered only the first rows)
  let t = gid.x;
  if (t >= ${C.HIZ_W * C.HIZ_H}u) { return; }
  let x = t % ${C.HIZ_W}u;
  let y = t / ${C.HIZ_W}u;
  let z = textureLoad(zTex, vec2<i32>(vec2<u32>(x, y)), 0).r;
  pyramid[t] = z;
}
${PYR_REDUCE}`

let LEVEL_SWITCH = ''
for (let L = 0; L < LEVELS; L++) {
  LEVEL_SWITCH += `case ${L}u: { return vec3<u32>(${LEVEL_OFF[L]}u, ${LEVEL_DIMS[L].w}u, ${LEVEL_DIMS[L].h}u); }`
}
const CULL_WGSL = `
struct CullParams { mvp: mat4x4<f32>, misc: vec4<u32> }
@group(0) @binding(0) var<uniform> params: CullParams;
@group(0) @binding(1) var<storage, read_write> scene: array<u32>;
@group(0) @binding(2) var<storage, read> pyramid: array<f32>;
@group(0) @binding(3) var<storage, read_write> statsArgs: array<u32>;
fn levelInfo(L: u32) -> vec3<u32> {
  switch L {
    ${LEVEL_SWITCH}
    default: { return vec3<u32>(0u, 1u, 1u); }
  }
}
// THE VERDICT FLAGS (deterministic compaction — no atomics): 1 visible,
// 2 frustum-culled, 3 occluded, 4 visible-near-straddle (counted honestly)
@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= ${C.OCCL}u) { return; }
  let abs = ${C.K}u + i;
  let wo = ${C.INST_OFF}u + abs * 12u;
  let cx = bitcast<f32>(scene[wo]); let cy = bitcast<f32>(scene[wo + 1u]); let cz = bitcast<f32>(scene[wo + 2u]);
  let hx = bitcast<f32>(scene[wo + 3u]); let hy = bitcast<f32>(scene[wo + 4u]); let hz = bitcast<f32>(scene[wo + 5u]);
  // the 8 corners: conservative rect + nearest depth + plane-outside counts
  var x0 = 1e30; var x1 = -1e30; var y0 = 1e30; var y1 = -1e30;
  var minZ = 1e30; var minW = 1e30;
  var outL = 0u; var outR = 0u; var outB = 0u; var outT = 0u; var outN = 0u; var outF = 0u;
  for (var k = 0u; k < 8u; k = k + 1u) {
    let sx = f32(k & 1u) * 2.0 - 1.0;
    let sy = f32((k >> 1u) & 1u) * 2.0 - 1.0;
    let sz = f32((k >> 2u) & 1u) * 2.0 - 1.0;
    let clip = params.mvp * vec4<f32>(cx + sx * hx, cy + sy * hy, cz + sz * hz, 1.0);
    let w = clip.w;
    minW = min(minW, w);
    if (w > 1e-4) {
      let nx = clip.x / w; let ny = clip.y / w; let nz = clip.z / w;
      let px = (nx * 0.5 + 0.5) * f32(${C.HIZ_W});
      // WebGPU framebuffer rows grow DOWN from NDC +y (up): the tile's
      // row 0 is the TOP row — py = (1 - (ny*0.5+0.5)) * H. A naive
      // (ny*0.5+0.5) flips the rect vertically and the test samples the
      // wrong region (the parity gate catches it as false culls).
      let py = (0.5 - ny * 0.5) * f32(${C.HIZ_H});
      x0 = min(x0, px); x1 = max(x1, px);
      y0 = min(y0, py); y1 = max(y1, py);
      minZ = min(minZ, nz);
      if (nx < -1.0) { outL = outL + 1u; }
      if (nx > 1.0) { outR = outR + 1u; }
      if (ny < -1.0) { outB = outB + 1u; }
      if (ny > 1.0) { outT = outT + 1u; }
      if (nz < 0.0) { outN = outN + 1u; }
      if (nz > 1.0) { outF = outF + 1u; }
    }
  }
  // frustum: ALL corners outside the SAME plane → outside the frustum
  if (outL == 8u || outR == 8u || outB == 8u || outT == 8u || outN == 8u || outF == 8u) {
    scene[${C.FLAGS_OFF}u + i] = 2u;
    return;
  }
  // near-straddle: a corner at/behind the eye — the projection is
  // unreliable → keep it visible, counted honestly
  if (minW <= 1e-4) {
    scene[${C.FLAGS_OFF}u + i] = 4u;
    return;
  }
  // the Hi-Z test (toggled by the uniform — the OFF leg of the parity gate)
  if (params.misc.x == 1u) {
    var px0 = i32(floor(x0)); var px1 = i32(ceil(x1));
    var py0 = i32(floor(y0)); var py1 = i32(ceil(y1));
    px0 = max(px0, 0); py0 = max(py0, 0);
    px1 = min(px1, ${C.HIZ_W}); py1 = min(py1, ${C.HIZ_H});
    if (px1 > px0 && py1 > py0) {
      let rw = px1 - px0; let rh = py1 - py0;
      var L = i32(ceil(log2(f32(max(rw, rh)))));
      L = clamp(L, 0, ${C.MAX_LEVEL});
      let info = levelInfo(u32(L));
      let lw = info.y; let lh = info.z;
      var tx0 = u32(px0) >> u32(L); var tx1 = u32(px1 - 1) >> u32(L);
      var ty0 = u32(py0) >> u32(L); var ty1 = u32(py1 - 1) >> u32(L);
      tx1 = min(tx1, lw - 1u); ty1 = min(ty1, lh - 1u);
      // THE MAX-REDUCED TILE (the farthest surface in the region): the
      // SOUND form of the single-tap Hi-Z test. The box's NEAREST corner
      // vs the region's FARTHEST surface: nearest > farthest ⟹ EVERY pixel
      // of the region holds a surface closer than the box's nearest point
      // → fully occluded. (The widely-copied min-reduce + same compare is
      // UNSOUND: a close occluder in ONE corner of the rect culls a box
      // that pokes out elsewhere — this page's own pixel-parity gate
      // caught exactly that, 3/3 cameras, hashes diverging.)
      var zmax = -1.0;
      for (var ty = ty0; ty <= ty1; ty = ty + 1u) {
        for (var tx = tx0; tx <= tx1; tx = tx + 1u) {
          zmax = max(zmax, pyramid[info.x + ty * lw + tx]);
        }
      }
      // THE CONSERVATIVE SLACK: the cull compares f32 tile values, the
      // color pass's depth test rides the depth24plus attachment — a
      // borderline box (margin ~1e-6) can win the QUANTIZED depth battle
      // and show a sliver of pixels; culling it would change the image
      // (the parity gate's job is exactly this). 1e-5 of NDC depth makes
      // the decision robust against the f32↔24-bit quantization gap.
      if (minZ > zmax + 1e-5) {
        scene[${C.FLAGS_OFF}u + i] = 3u;
        return;
      }
    }
  }
  scene[${C.FLAGS_OFF}u + i] = 1u;
}
// THE DETERMINISTIC COMPACTION (single thread, ascending index — a
// production tier would ride a prefix-scan; the demo needs the STABLE
// draw order: the parity gate compares ON vs OFF frames, and an
// atomic-order flip at an equal-depth collision would fake a divergence).
// Also emits the stats + the indirect draw's instanceCount in the same
// sweep — no atomics anywhere in the family.
@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x != 0u) { return; }
  var out = 0u; var frustum = 0u; var occluded = 0u; var straddle = 0u;
  for (var i = 0u; i < ${C.OCCL}u; i = i + 1u) {
    let f = scene[${C.FLAGS_OFF}u + i];
    if (f == 1u || f == 4u) {
      scene[out] = ${C.K}u + i;
      out = out + 1u;
      if (f == 4u) { straddle = straddle + 1u; }
    } else if (f == 2u) {
      frustum = frustum + 1u;
    } else if (f == 3u) {
      occluded = occluded + 1u;
    }
  }
  statsArgs[0u] = out;
  statsArgs[1u] = frustum;
  statsArgs[2u] = occluded;
  statsArgs[3u] = straddle;
  // the indirect draw's instanceCount — [indexCount, instanceCount,
  // firstIndex, baseVertex, firstInstance] at word 8 (byte 32)
  statsArgs[9u] = out;
}
`
const COLOR_WGSL = `
struct ColorParams { mvp: mat4x4<f32>, misc: vec4<u32>, light: vec4<f32>, cam: vec4<f32> }
@group(0) @binding(0) var<uniform> params: ColorParams;
@group(2) @binding(0) var<storage, read> scene: array<u32>;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) world: vec3<f32>, @location(1) color: vec3<f32> }
@vertex fn vsMain(@location(0) corner: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
  // useList=0: the occluder draw (instance_index IS the record index);
  // useList=1: the indirect draw (instance_index dereferences the kernel's
  // compacted list — the GPU-driven indirection)
  let absIdx = select(ii, scene[ii], params.misc.x == 1u);
  let wo = ${C.INST_OFF}u + absIdx * 12u;
  let c = vec3<f32>(bitcast<f32>(scene[wo]), bitcast<f32>(scene[wo + 1u]), bitcast<f32>(scene[wo + 2u]));
  let h = vec3<f32>(bitcast<f32>(scene[wo + 3u]), bitcast<f32>(scene[wo + 4u]), bitcast<f32>(scene[wo + 5u]));
  let col = vec3<f32>(bitcast<f32>(scene[wo + 6u]), bitcast<f32>(scene[wo + 7u]), bitcast<f32>(scene[wo + 8u]));
  let world = c + h * (corner * 2.0 - 1.0);
  var o: VOut;
  o.pos = params.mvp * vec4<f32>(world, 1.0);
  o.world = world;
  o.color = col;
  return o;
}
@fragment fn fsMain(i: VOut) -> @location(0) vec4<f32> {
  // flat per-triangle normal from screen-space derivatives — no normals
  // in the records, the boxes are their own geometry
  let n = normalize(cross(dpdx(i.world), dpdy(i.world)));
  let l = max(dot(n, normalize(params.light.xyz)), 0.0);
  let dist = distance(i.world, params.cam.xyz);
  let fog = smoothstep(70.0, 200.0, dist);
  var col = i.color * (0.35 + 0.65 * l);
  col = mix(col, vec3<f32>(0.045, 0.055, 0.09), fog);
  return vec4<f32>(col, 1.0);
}`

const PANEL_WGSL = `
struct PanelParams { rect: vec4<f32>, info: vec4<u32> }
@group(0) @binding(0) var<uniform> params: PanelParams;
@group(2) @binding(0) var<storage, read> pyramid: array<f32>;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vsMain(@location(0) q: vec2<f32>) -> VOut {
  var o: VOut;
  let x = mix(params.rect.x, params.rect.z, q.x * 0.5 + 0.5);
  let y = mix(params.rect.y, params.rect.w, q.y * 0.5 + 0.5);
  o.pos = vec4<f32>(x, y, 0.0, 1.0);
  o.uv = q * 0.5 + 0.5;
  return o;
}
@fragment fn fsMain(i: VOut) -> @location(0) vec4<f32> {
  let tx = min(u32(i.uv.x * f32(params.info.y)), params.info.y - 1u);
  let ty = min(u32(i.uv.y * f32(params.info.z)), params.info.z - 1u);
  let z = pyramid[params.info.x + ty * params.info.y + tx];
  let v = clamp(1.0 - z, 0.0, 1.0); // tile-max: sky (1.0) renders black
  return vec4<f32>(v * 0.9, v * 0.75, v * 0.55 + 0.1, 1.0);
}`

// ── the page chrome: the stage canvas + the HUD ───────────────────────────
const stage = shell.slot
stage.parentElement.classList.add('hiz-stage')
const hud = document.createElement('pre')
hud.className = 'hiz-hud'
function makeCanvas(id, w, h, twoD) {
  const el = document.createElement('canvas')
  el.id = id
  el.width = w
  el.height = h
  el.className = 'hiz-canvas'
  if (!twoD) el.style.aspectRatio = '16 / 9'
  return el
}

// ── GPU boot ──────────────────────────────────────────────────────────────
let renderer = null
const bootCanvas = document.createElement('canvas')
bootCanvas.width = 960
bootCanvas.height = 540
let displayCanvas = null
let snapshot2d = null

try {
  for (let attempt = 0; attempt < 4 && renderer === null; attempt++) {
    try {
      renderer = await createWebGpuRenderer({
        canvas: bootCanvas,
        dpr: 1,
        clear: { color: [0.045, 0.055, 0.09, 1], depth: 1 },
        onGpuError: noteError,
      })
    } catch (error) {
      await new Promise(r => setTimeout(r, 900))
      if (attempt === 3) throw error
    }
  }
} catch (error) {
  shell.setBadge('WebGPU unavailable', 'err')
  shell.log.error(`WebGPU boot failed: ${error instanceof Error ? error.message : String(error)}`)
  if (typeof window !== 'undefined') {
    window.__hizStats = { mode: 'no-webgpu', errors: [String(error)] }
    window.__hizGate = { pass: false, bootFail: String(error) }
  }
  shell.markReady()
}

// ── the tier decision: software adapter → snapshot mode (no presents) ─────
if (renderer !== null) {

  const ADAPTER_INFO = (() => {
    try {
      const info = renderer?.gpu?.adapter?.info
      if (info === undefined || info === null) return ''
      return `${info.description ?? ''} ${info.architecture ?? ''} ${info.vendor ?? ''}`
    } catch { return '' }
  })()
  const SOFTWARE_GPU = /swiftshader|software|llvmpipe|basic render/i.test(ADAPTER_INFO)
  const SNAPSHOT = FORCE_SNAPSHOT || SOFTWARE_GPU
  const MODE = PROBE ? 'probe' : SNAPSHOT ? 'snapshot' : 'live'
  if (SOFTWARE_GPU) shell.log.info(`software adapter detected (${ADAPTER_INFO.trim() || 'unknown'}) — snapshot mode: every frame renders into a surface and blits into a 2D canvas, the full pipeline with zero canvas presents (the documented container class where a present kills the software GPU process)`)
  if (renderer !== null && MODE !== 'probe') {
    displayCanvas = makeCanvas('hiz-canvas', 960, 540, SNAPSHOT)
    stage.appendChild(displayCanvas)
    stage.appendChild(hud)
    if (SNAPSHOT) snapshot2d = displayCanvas.getContext('2d')
  }

  // ── the resources (the facade's own contracts, nothing private) ───────────
  const gpu = renderer?.gpu
  const USAGE = { STORAGE: 0x80, INDIRECT: 0x100, COPY_SRC: 0x4, COPY_DST: 0x8 }
  const sceneId = gpu.createExternalBuffer(sceneWords.byteLength, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC) // COPY_SRC — the diagnostics list readback
  gpu.writeExternalBuffer(sceneId, sceneWords)
  const pyramidId = gpu.createExternalBuffer(PYRAMID_WORDS * 4, USAGE.STORAGE | USAGE.COPY_SRC) // COPY_SRC — the debug readback channel
  const statsArgsId = gpu.createExternalBuffer(64, USAGE.STORAGE | USAGE.INDIRECT | USAGE.COPY_SRC | USAGE.COPY_DST)
  // the args tail (word 8 = byte 32): [indexCount=36, instanceCount(GPU),
  // firstIndex=0, baseVertex=0, firstInstance=0]
  const argsInit = new Uint32Array(16)
  argsInit[8] = 36
  gpu.writeExternalBuffer(statsArgsId, argsInit)
  const ARGS_BYTE = 32

  // the z tile: r32float TARGET with a depth attachment — the prepass
  const zTexId = gpu.createTexture(HIZ_W, HIZ_H, 'r32float')
  const zTargetId = gpu.createTarget(zTexId, HIZ_W, HIZ_H, true, [1, 1, 1, 1])

  // the validation/snapshot surface (canvas format + depth — the honest
  // readback channel, Task 80)
  const SURF_W = 480, SURF_H = 270
  const surface = renderer.surface({ width: SURF_W, height: SURF_H, depth: true, color: [0.045, 0.055, 0.09, 1] })

  // pipelines: z prepass (r32float target — the Task-196 format axis),
  // color (canvas/surface format + the group-2 scene storage), pyramid panels
  gpu.ensurePipeline(1, Z_WGSL, [3], false, { depth: { test: 'less', write: true } })
  gpu.ensurePipeline(2, COLOR_WGSL, [3], false, { depth: { test: 'less', write: true } })
  gpu.ensurePipeline(3, PANEL_WGSL, [2], false, {})

  // compute families: the pyramid (z tile texture slot + rw pyramid buffer),
  // the cull (scene rw / pyramid ro / statsArgs rw)
  const PYR_COMPUTE = gpu.createCompute(PYR_WGSL, 16, [pyramidId], [{ kind: 'sampled', textureId: zTexId }])
  const CULL_COMPUTE = gpu.createCompute(CULL_WGSL, 80, [sceneId, pyramidId, statsArgsId])
  const CULL_WG = Math.ceil(OCCL / 64)

  // ── the debug hooks (the diagnostics channel — probe scripts read the
// pyramid and the z tile directly; harmless in production) ─────────────────
if (typeof window !== 'undefined') {
  window.__hizDebug = {
    async pyramid() {
      const f = await gpu.readExternalBuffer(pyramidId, 1024)
      return Array.from(new Float32Array(f.buffer, 0, 256), v => +v.toFixed(4))
    },
    async pyramidAt(level) {
      const off = LEVEL_OFF[level]
      const f = await gpu.readExternalBuffer(pyramidId, off * 4 + 64)
      return Array.from(new Float32Array(f.buffer, off * 4, 16), v => +v.toFixed(4))
    },
    async ztile() {
      try {
        const px = new Uint8Array(await gpu.readTargetPixels(zTargetId))
        const out = []
        for (let i = 0; i < 16; i++) out.push(+new Float32Array(px.buffer, i * 4, 1)[0].toFixed(4))
        return out
      } catch (e) { return `readback refused: ${e instanceof Error ? e.message : String(e)}` }
    },
    stats: () => readStats(),
    async diff(yaw = 1.45, pitch = 0.38, dist = 42) {
      // PAUSE the live loop — the diff's frames must not interleave
      paused = true
      cancelAnimationFrame(rafId)
      try {
      const { eye, mvp } = cameraAt(yaw, pitch, dist)
      runFrame(surface.targetId, mvp, eye, 1, false)
      const sOn = await readStats()
      const fOn = await gpu.readExternalBuffer(sceneId, Math.max(4, sOn.drawn * 4))
      const listOn = Array.from(new Uint32Array(fOn.buffer, 0, sOn.drawn))
      runFrame(surface.targetId, mvp, eye, 0, false)
      const sOff = await readStats()
      const fOff = await gpu.readExternalBuffer(sceneId, Math.max(4, sOff.drawn * 4))
      const listOff = Array.from(new Uint32Array(fOff.buffer, 0, sOff.drawn))
      const onSet = new Set(listOn)
      const culled = listOff.filter(abs => !onSet.has(abs))
      const pyr = new Float32Array((await gpu.readExternalBuffer(pyramidId, PYRAMID_WORDS * 4)).buffer, 0, PYRAMID_WORDS)
      const analyze = (abs) => {
        const wo = INST_OFF + abs * 12
        const c = [sceneF32[wo], sceneF32[wo + 1], sceneF32[wo + 2]]
        const h = [sceneF32[wo + 3], sceneF32[wo + 4], sceneF32[wo + 5]]
        let x0 = 1e30, x1 = -1e30, y0 = 1e30, y1 = -1e30, minZ = 1e30
        for (let k = 0; k < 8; k++) {
          const sx = (k & 1) * 2 - 1, sy = ((k >> 1) & 1) * 2 - 1, sz = ((k >> 2) & 1) * 2 - 1
          const cx4 = c[0] + sx * h[0], cy4 = c[1] + sy * h[1], cz4 = c[2] + sz * h[2]
          const X = mvp[0] * cx4 + mvp[4] * cy4 + mvp[8] * cz4 + mvp[12]
          const Y = mvp[1] * cx4 + mvp[5] * cy4 + mvp[9] * cz4 + mvp[13]
          const Z = mvp[2] * cx4 + mvp[6] * cy4 + mvp[10] * cz4 + mvp[14]
          const W = mvp[3] * cx4 + mvp[7] * cy4 + mvp[11] * cz4 + mvp[15]
          if (W > 1e-4) {
            const px = (X / W * 0.5 + 0.5) * HIZ_W
            const py = (0.5 - Y / W * 0.5) * HIZ_H
            x0 = Math.min(x0, px); x1 = Math.max(x1, px)
            y0 = Math.min(y0, py); y1 = Math.max(y1, py)
            minZ = Math.min(minZ, Z / W)
          }
        }
        const px0 = Math.max(0, Math.floor(x0)), px1 = Math.min(HIZ_W, Math.ceil(x1))
        const py0 = Math.max(0, Math.floor(y0)), py1 = Math.min(HIZ_H, Math.ceil(y1))
        if (px1 <= px0 || py1 <= py0) return { abs, degenerate: true }
        let L = Math.max(0, Math.min(MAX_LEVEL, Math.ceil(Math.log2(Math.max(px1 - px0, py1 - py0)))))
        const off = LEVEL_OFF[L], lw = LEVEL_DIMS[L].w, lh = LEVEL_DIMS[L].h
        const tx0 = px0 >> L, tx1 = Math.min((px1 - 1) >> L, lw - 1)
        const ty0 = py0 >> L, ty1 = Math.min((py1 - 1) >> L, lh - 1)
        let zmaxP = -1
        for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) zmaxP = Math.max(zmaxP, pyr[off + ty * lw + tx])
        let zmax0 = -1
        if (suspicious.length < 4 && (px1 - px0) * (py1 - py0) <= 4096) {
          for (let py = py0; py < py1; py++) for (let px = px0; px < px1; px++) zmax0 = Math.max(zmax0, pyr[py * HIZ_W + px])
        }
        return { abs, c: c.map(v => +v.toFixed(1)), rect: [px0, py0, px1, py1], L, minZ: +minZ.toFixed(5), zmaxP: +zmaxP.toFixed(5), zmax0: zmax0 < 0 ? -1 : +zmax0.toFixed(5), pyrCull: minZ > zmaxP, bruteCull: zmax0 < 0 ? null : minZ > zmax0 }
      }
      const suspicious = []
      const pyramidUnderreports = []
      let checked = 0
      let minMargin = 1e9
      for (const abs of culled) {
        const a = analyze(abs)
        checked++
        const margin = a.minZ - a.zmaxP
        if (margin < minMargin) minMargin = margin
        if (!a.pyrCull) suspicious.push(a) // GPU culled, CPU says keep — precision/kernel divergence
        if (a.bruteCull === false) pyramidUnderreports.push(a)
        if (suspicious.length >= 8 && pyramidUnderreports.length >= 8) break
      }
      return { drawnOn: sOn.drawn, drawnOff: sOff.drawn, culledCount: culled.length, checked, minMargin: +minMargin.toFixed(8), suspiciousCount: suspicious.length, suspicious: suspicious.slice(0, 8), underreportCount: pyramidUnderreports.length, underreport: pyramidUnderreports.slice(0, 8) }
      } finally {
        paused = false
        rafId = requestAnimationFrame(loop)
      }
    },
    async trace() {
      const f = await gpu.readExternalBuffer(pyramidId, PYRAMID_WORDS * 4)
      const pyr = new Float32Array(f.buffer, 0, PYRAMID_WORDS)
      const mvp = lastFrame?.mvp
      if (mvp === undefined) return { error: 'no frame yet' }
      const out = []
      for (let i = 0; i < 6; i++) {
        const wo = INST_OFF + (K + i) * 12
        const c = [sceneF32[wo], sceneF32[wo + 1], sceneF32[wo + 2]]
        const h = [sceneF32[wo + 3], sceneF32[wo + 4], sceneF32[wo + 5]]
        let x0 = 1e30, x1 = -1e30, y0 = 1e30, y1 = -1e30, minZ = 1e30
        for (let k = 0; k < 8; k++) {
          const sx = (k & 1) * 2 - 1, sy = ((k >> 1) & 1) * 2 - 1, sz = ((k >> 2) & 1) * 2 - 1
          const cx4 = c[0] + sx * h[0], cy4 = c[1] + sy * h[1], cz4 = c[2] + sz * h[2]
          const X = mvp[0] * cx4 + mvp[4] * cy4 + mvp[8] * cz4 + mvp[12]
          const Y = mvp[1] * cx4 + mvp[5] * cy4 + mvp[9] * cz4 + mvp[13]
          const Z = mvp[2] * cx4 + mvp[6] * cy4 + mvp[10] * cz4 + mvp[14]
          const W = mvp[3] * cx4 + mvp[7] * cy4 + mvp[11] * cz4 + mvp[15]
          if (W > 1e-4) {
            const nx = X / W, ny = Y / W, nz = Z / W
            const px = (nx * 0.5 + 0.5) * HIZ_W
            const py = (0.5 - ny * 0.5) * HIZ_H
            x0 = Math.min(x0, px); x1 = Math.max(x1, px)
            y0 = Math.min(y0, py); y1 = Math.max(y1, py)
            minZ = Math.min(minZ, nz)
          }
        }
        const px0 = Math.max(0, Math.floor(x0)), px1 = Math.min(HIZ_W, Math.ceil(x1))
        const py0 = Math.max(0, Math.floor(y0)), py1 = Math.min(HIZ_H, Math.ceil(y1))
        let L = Math.max(0, Math.min(MAX_LEVEL, Math.ceil(Math.log2(Math.max(px1 - px0, py1 - py0, 1)))))
        const off = LEVEL_OFF[L], lw = LEVEL_DIMS[L].w, lh = LEVEL_DIMS[L].h
        const tx0 = px0 >> L, tx1 = Math.min((px1 - 1) >> L, lw - 1)
        const ty0 = py0 >> L, ty1 = Math.min((py1 - 1) >> L, lh - 1)
        let zmax = -1
        for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) zmax = Math.max(zmax, pyr[off + ty * lw + tx])
        out.push({ i, center: c.map(v => +v.toFixed(2)), rect: [px0, py0, px1, py1], L, minZ: +minZ.toFixed(5), zmax: +zmax.toFixed(5), wouldCull: minZ > zmax })
      }
      const levels = []
      for (let L = 0; L < LEVELS; L++) {
        const off = LEVEL_OFF[L]
        levels.push({ L, w: LEVEL_DIMS[L].w, h: LEVEL_DIMS[L].h, first: +pyr[off].toFixed(4), mid: +pyr[off + (LEVEL_DIMS[L].w * LEVEL_DIMS[L].h >> 1)].toFixed(4) })
      }
      return { boxes: out, levels }
    },
  }
}

// ── the uniform blocks (the UBO arena: 256-aligned dynamic offsets) ───────
  const zBlock = new Uint8Array(64)
  const zF = new Float32Array(zBlock.buffer)
  const colorA = new Uint8Array(96) // offset 0 — useList=0 (the occluder draw)
  const colorB = new Uint8Array(96) // offset 256 — useList=1 (the indirect draw)
  const colorAF = new Float32Array(colorA.buffer)
  const colorBF = new Float32Array(colorB.buffer)
  const colorAU = new Uint32Array(colorA.buffer)
  const colorBU = new Uint32Array(colorB.buffer)
  const LIGHT = [0.5, 0.8, 0.35]
  function packColor(block, blockF, blockU, mvp, eye, useList) {
    blockF.set(mvp, 0)
    blockU[16] = useList; blockU[17] = 0; blockU[18] = 0; blockU[19] = 0
    blockF[20] = LIGHT[0]; blockF[21] = LIGHT[1]; blockF[22] = LIGHT[2]; blockF[23] = 0
    blockF[24] = eye[0]; blockF[25] = eye[1]; blockF[26] = eye[2]; blockF[27] = 1
  }
  const cullBlock = new Uint8Array(80)
  const cullF = new Float32Array(cullBlock.buffer)
  const cullU = new Uint32Array(cullBlock.buffer)
  const PYR_U = new Float32Array(4)

  // the pyramid debug panels: one uniform block per level (offset 512+L*256)
  const PANEL_BLOCKS = []
  for (let L = 0; L < LEVELS; L++) {
    const b = new Uint8Array(32)
    const f = new Float32Array(b.buffer)
    const u = new Uint32Array(b.buffer)
    const w = 2.0 / LEVELS
    f[0] = -1 + L * w + 0.01; f[1] = -0.97; f[2] = -1 + (L + 1) * w - 0.01; f[3] = -0.55
    u[4] = LEVEL_OFF[L]; u[5] = LEVEL_DIMS[L].w; u[6] = LEVEL_DIMS[L].h; u[7] = 0
    PANEL_BLOCKS.push(b)
    gpu.uploadUniforms(512 + L * 256, b)
  }

  // ── THE FRAME: z prepass → pyramid → cull+compact+emitArgs → color+draw ───
  // Three submits per frame — the queue orders them (and the writeBuffer of
  // the uniform blocks between them), so each phase observes the previous
  // one's output. This is the facade's own multi-submit lifecycle (submit()
  // finishes the encoder; the next bindTarget/runCompute opens a fresh one).
  let lastFrame = null
  function runFrame(targetId, mvp, eye, hizOn, debug) {
    lastFrame = { mvp, eye, hizOn }
    // 1. THE Z PREPASS — occluders into the r32float tile (nearest-z wins)
    zF.set(mvp, 0)
    gpu.uploadUniforms(0, zBlock)
    gpu.bindTarget(zTargetId, true)
    gpu.usePipeline(1)
    gpu.bindUniforms(0)
    gpu.bindStorageBuffer(sceneId)
    gpu.bindVertexBuffer(0, BOX_VERTS, 3)
    gpu.bindIndexBuffer(BOX_INDICES)
    gpu.drawIndexed(36, K)
    gpu.endPass()
    gpu.submit()
    // 2. THE PYRAMID — mip0 from the tile, then 2×2 min per level (the
    // per-level constants are ENTRY POINTS — the family uniform is
    // frame-static by design)
    gpu.runCompute(PYR_COMPUTE, 'zToMip0', PYR_U, flatWorkgroups(HIZ_W, HIZ_H))
    for (let L = 1; L < LEVELS; L++) {
      gpu.runCompute(PYR_COMPUTE, `reduceL${L}`, PYR_U, flatWorkgroups(LEVEL_DIMS[L].w, LEVEL_DIMS[L].h))
    }
    // 3. THE CULL — reset → test+compact → emitArgs (dispatch order is a
    // WebGPU guarantee; the args land without a CPU readback)
    cullF.set(mvp, 0)
    cullU[16] = hizOn ? 1 : 0

    gpu.runCompute(CULL_COMPUTE, 'cull', cullF, CULL_WG)
    gpu.runCompute(CULL_COMPUTE, 'compact', cullF, 1)
    gpu.submit()
    // 4. THE COLOR PASS — occluders (classic) + the visible set (indirect)
    packColor(colorA, colorAF, colorAU, mvp, eye, 0)
    packColor(colorB, colorBF, colorBU, mvp, eye, 1)
    gpu.uploadUniforms(0, colorA)
    gpu.uploadUniforms(256, colorB)
    gpu.bindTarget(targetId, true)
    gpu.usePipeline(2)
    gpu.bindStorageBuffer(sceneId)
    gpu.bindVertexBuffer(0, BOX_VERTS, 3)
    gpu.bindIndexBuffer(BOX_INDICES)
    gpu.bindUniforms(0)
    gpu.drawIndexed(36, K)
    gpu.bindUniforms(256)
    gpu.drawIndexedIndirect(statsArgsId, ARGS_BYTE)
    if (debug) {
      gpu.usePipeline(3)
      gpu.bindVertexBuffer(0, QUAD_VERTS, 2)
      gpu.bindStorageBuffer(pyramidId)
      for (let L = 0; L < LEVELS; L++) {
        gpu.bindUniforms(512 + L * 256)
        gpu.draw(6, 1)
      }
    }
    gpu.endPass()
    gpu.submit()
  }

  // ── stats readback (async, throttled — the HUD + __hizStats) ──────────────
  async function readStats() {
    const f = await gpu.readExternalBuffer(statsArgsId, 52)
    const u = new Uint32Array(f.buffer, 0, 13)
    return { drawn: u[0], frustum: u[1], occluded: u[2], straddle: u[3], indirectCount: u[9] }
  }
  const stats = { mode: MODE, total: N, occluders: K, occludees: OCCL, hizW: HIZ_W, hizH: HIZ_H, levels: LEVELS, hizOn: 1, frustumCulled: 0, occlusionCulled: 0, drawn: 0, nearStraddle: 0, drawCalls: 2, dispatches: 2 + LEVELS, msAvg: 0, validation: null, errors }
  if (typeof window !== 'undefined') window.__hizStats = stats

  // ── the parity gate: Hi-Z ON vs OFF must render IDENTICAL pixels ──────────
  async function sha256hex(bytes) {
    const subtle = typeof crypto !== 'undefined' && crypto.subtle !== undefined ? crypto.subtle : null
    if (subtle === null) return null // the page still byte-compares
    const digest = await subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
  }
  const VAL_CAMERAS = [
    { yaw: 0.55, pitch: 0.28, dist: 34 },
    { yaw: 1.45, pitch: 0.38, dist: 42 },
    { yaw: 2.6, pitch: 0.22, dist: 30 },
  ]
  function cameraAt(yaw, pitch, dist) {
    const eye = [
      Math.cos(pitch) * Math.sin(yaw) * dist,
      5.5 + Math.sin(pitch) * dist,
      Math.cos(pitch) * Math.cos(yaw) * dist,
    ]
    const mvp = mat4Mul(perspective(Math.PI / 3, 16 / 9, 0.5, 300), lookAt(eye, [0, 5.5, 0], [0, 1, 0]))
    return { eye, mvp }
  }
  async function validate() {
    const cameras = []
    let allOk = true
    for (const cam of VAL_CAMERAS) {
      const { eye, mvp } = cameraAt(cam.yaw, cam.pitch, cam.dist)
      runFrame(surface.targetId, mvp, eye, 1, false)
      const on = await surface.read()
      const onStats = await readStats()
      runFrame(surface.targetId, mvp, eye, 0, false)
      const off = await surface.read()
      const offStats = await readStats()
      const hashOn = await sha256hex(on.data)
      const hashOff = await sha256hex(off.data)
      const byteIdentical = hashOn !== null && hashOn === hashOff
        ? true
        : (on.data.length === off.data.length && on.data.every((v, i) => v === off.data[i]))
      const invariantOn = onStats.frustum + onStats.occluded + onStats.drawn === OCCL
      const invariantOff = offStats.frustum + offStats.occluded + offStats.drawn === OCCL
      const ok = byteIdentical && invariantOn && invariantOff && onStats.drawn < offStats.drawn && onStats.occluded > 0
      allOk = allOk && ok
      cameras.push({
        yaw: cam.yaw, hashOn, hashOff, parity: byteIdentical ? 'IDENTICAL' : 'DIFFERS',
        drawnOn: onStats.drawn, drawnOff: offStats.drawn,
        frustumOn: onStats.frustum, frustumOff: offStats.frustum,
        occludedOn: onStats.occluded, occludedOff: offStats.occluded,
        straddleOn: onStats.straddle, invariantOn, invariantOff, ok,
      })
      shell.log.event(`parity @yaw ${cam.yaw.toFixed(2)}: ${byteIdentical ? 'IDENTICAL' : 'DIFFERS'} (${hashOn?.slice(0, 12) ?? 'n/a'}) · drawn ON ${onStats.drawn} / OFF ${offStats.drawn} · frustum ${onStats.frustum} · occluded ${onStats.occluded}`)
      if (!byteIdentical) shell.log.error(`pixel parity FAILED @yaw ${cam.yaw} — Hi-Z culled a VISIBLE box (hash ${hashOn} vs ${hashOff})`)
      if (!invariantOn || !invariantOff) shell.log.error(`accounting invariant FAILED @yaw ${cam.yaw} — frustum+occluded+drawn must equal ${OCCL}`)
      if (onStats.drawn >= offStats.drawn || onStats.occluded === 0) shell.log.error(`the occlusion is not culling @yaw ${cam.yaw} (drawn ON ${onStats.drawn}, OFF ${offStats.drawn}, occluded ${onStats.occluded})`)
    }
    const verdict = { pass: allOk && errors.length === 0, cameras, errors: errors.length }
    stats.validation = verdict
    shell.log.event(`validation: ${verdict.pass ? 'PASS' : 'FAIL'} — pixel parity over ${cameras.length} cameras, the accounting invariant, the culling effect${errors.length > 0 ? `, ${errors.length} GPU errors` : ''}`)
    return verdict
  }

  // ── the camera + the live loop ────────────────────────────────────────────
  const cam = { yaw: 0.9, pitch: 0.3, dist: 38, auto: 0.1 }
  let dragging = false
  let lastX = 0
  let lastY = 0
  if (displayCanvas !== null) {
    displayCanvas.style.touchAction = 'none'
    displayCanvas.addEventListener('pointerdown', e => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      displayCanvas.setPointerCapture(e.pointerId)
    })
    displayCanvas.addEventListener('pointermove', e => {
      if (!dragging) return
      cam.yaw -= (e.clientX - lastX) * 0.006
      cam.pitch = Math.max(-0.15, Math.min(1.2, cam.pitch + (e.clientY - lastY) * 0.004))
      lastX = e.clientX
      lastY = e.clientY
    })
    displayCanvas.addEventListener('pointerup', () => { dragging = false })
    displayCanvas.addEventListener('wheel', e => {
      e.preventDefault()
      cam.dist = Math.max(12, Math.min(120, cam.dist * (1 + Math.sign(e.deltaY) * 0.08)))
    }, { passive: false })
  }

  let hizOn = true
  let showPyramid = false
  let paused = false
  let rafId = 0
  let frameIndex = 0
  let lastT = 0
  let msAvg = 0
  let blitPending = false

  function refreshHud() {
    const pct = (100 * stats.drawn / OCCL).toFixed(1)
    hud.innerHTML =
      `instances <b>${N}</b> (occluders ${K} · occludees ${OCCL})\n` +
      `frustum-culled ${stats.frustumCulled} · <b>occlusion-culled ${stats.occlusionCulled}</b>\n` +
      `drawn <b>${stats.drawn}</b> (${pct}%) · near-straddle ${stats.nearStraddle}\n` +
      `Hi-Z ${HIZ_W}x${HIZ_H} · ${LEVELS} mips · tier <b>${hizOn ? 'ON' : 'OFF'}</b>\n` +
      `draws: 2 (1 indirect) · dispatches: ${stats.dispatches}\n` +
      `frame ${msAvg.toFixed(1)} ms CPU · ${MODE}`
  }

  async function maybeReadStats() {
    if (frameIndex % 12 !== 0 && frameIndex > 2) return
    try {
      const s = await readStats()
      stats.frustumCulled = s.frustum
      stats.occlusionCulled = s.occluded
      stats.drawn = s.drawn
      stats.nearStraddle = s.straddle
      stats.hizOn = hizOn ? 1 : 0
      stats.msAvg = +msAvg.toFixed(2)
      refreshHud()
    } catch { /* a lost device surfaces through the storm channel */ }
  }

  function blitSnapshot() {
    if (blitPending) return
    blitPending = true
    surface.read().then(result => {
      blitPending = false
      if (snapshot2d !== null && result.data.length === SURF_W * SURF_H * 4) {
        snapshot2d.putImageData(new ImageData(new Uint8ClampedArray(result.data.buffer, result.data.byteOffset, result.data.length), SURF_W, SURF_H), 0, 0)
      }
    }).catch(() => { blitPending = false })
  }

  function loop(t) {
    rafId = requestAnimationFrame(loop)
    if (lastT > 0) {
      const dt = t - lastT
      if (dt < 250) msAvg = msAvg * 0.95 + dt * 0.05
    }
    lastT = t
    frameIndex++
    if (!dragging) cam.yaw += cam.auto * 0.016
    const { eye, mvp } = cameraAt(cam.yaw, cam.pitch, cam.dist)
    runFrame(SNAPSHOT ? surface.targetId : 0, mvp, eye, hizOn ? 1 : 0, showPyramid)
    if (SNAPSHOT) blitSnapshot()
    void maybeReadStats()
  }

  // ── the controls ──────────────────────────────────────────────────────────
  const controls = document.createElement('div')
  controls.className = 'hiz-controls'
  const toolbar = document.querySelector('.rd-toolbar')
  if (toolbar !== null) toolbar.appendChild(controls)
  function tierButton(label, pressed, onToggle) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.setAttribute('aria-pressed', String(pressed))
    b.addEventListener('click', () => {
      const next = b.getAttribute('aria-pressed') !== 'true'
      b.setAttribute('aria-pressed', String(next))
      onToggle(next)
    })
    controls.appendChild(b)
    return b
  }
  tierButton('Hi-Z culling: ON', true, on => {
    hizOn = on
    shell.log.event(`Hi-Z tier ${on ? 'ON (frustum + occlusion)' : 'OFF (frustum only)'} — watch the drawn count`)
    refreshHud()
  })
  tierButton('Pyramid view: OFF', false, on => {
    showPyramid = on
    shell.log.event(`the Hi-Z pyramid debug strip ${on ? 'ON' : 'OFF'} — ${LEVELS} mip levels, bright = near`)
  })
  const valButton = document.createElement('button')
  valButton.type = 'button'
  valButton.textContent = 'Validate pixel parity'
  valButton.addEventListener('click', () => {
    if (paused) return
    paused = true
    cancelAnimationFrame(rafId)
    valButton.textContent = 'Validating…'
    validate().then(verdict => {
      valButton.textContent = verdict.pass ? 'Validate pixel parity — PASS' : 'Validate pixel parity — FAIL'
      setTimeout(() => { valButton.textContent = 'Validate pixel parity' }, 4000)
    }).catch(e => {
      noteError(`validation crashed: ${e instanceof Error ? e.message : String(e)}`)
      valButton.textContent = 'Validate pixel parity'
    }).finally(() => {
      paused = false
      if (MODE !== 'probe') rafId = requestAnimationFrame(loop)
    })
  })
  controls.appendChild(valButton)

  // the shell's pause/resume — the late-bound controller above
  democtl.pause = () => {
    paused = true
    cancelAnimationFrame(rafId)
  }
  democtl.resume = () => {
    if (paused) {
      paused = false
      rafId = requestAnimationFrame(loop)
    }
  }

  // ── boot: probe → the gate; live/snapshot → the loop ─────────────────────
  shell.setBadge(SOFTWARE_GPU ? 'WebGPU (software)' : 'WebGPU')
  if (MODE === 'probe') {
    const verdict = await validate()
    window.__hizGate = { ...verdict, stats: { ...stats } }
    shell.log.event(`probe gate: ${verdict.pass ? 'PASS' : 'FAIL'} (window.__hizGate)`)
  } else {
    const bootVerdict = await validate()
    void bootVerdict
    refreshHud()
    rafId = requestAnimationFrame(loop)
  }
  shell.markReady()
}
