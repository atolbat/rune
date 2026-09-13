// occlusion/wgTier.js — Task 197: the WebGPU tier of the Hi-Z demo,
// extracted from main.js (Task 196) into a swappable backend tier. The
// pipeline itself is UNCHANGED Task-196 code — the Task-197 changes:
//   · THE LIVE CANVAS WIRING FIX (197a): in live mode the renderer's own
//     bootCanvas is decorated, appended and presented — the pre-197 bug
//     presented into an offscreen canvas while the visible one never
//     received a pixel (the container always ran snapshot mode, the probe
//     never touched a canvas: no environment had ever seen the live path —
//     a real GPU meant a black stage with a live log; the field report).
//   · The tier contract { renderTo / frame / readStats / surface / dispose }
//     so the shell can boot EITHER backend against the same scene.
//
//   The pipeline (Task 196, the library's own facade contracts):
//   1. THE Z PREPASS: the occluders render into an r32float TARGET — the
//      fragment writes @builtin(position).z, the target's internal
//      depth24plus attachment (depth test 'less', write on) keeps the
//      NEAREST occluder per pixel — a hardware min-blend without blending.
//   2. THE HI-Z PYRAMID: one compute family over createCompute — zToMip0
//      (textureLoad through the family's TEXTURE slot, binding 6) +
//      reduceL1..reduceLmax (2×2 MAX-reduction per level — the farthest
//      surface per tile, the SOUND form of the occlusion test) packed into
//      ONE buffer; per-level constants are ENTRY POINTS (the family
//      uniform is frame-static by design).
//   3. THE CULL KERNEL: AABB → conservative screen rect → mip by rect size
//      → ≤2×2 texels → the box's NEAREST corner vs the region's FARTHEST
//      surface; frustum first, near-straddlers kept visible and COUNTED;
//      deterministic single-thread compaction (no atomics — a stable draw
//      order: the parity gate depends on it).
//   4. THE GPU-DRIVEN DRAW: drawIndexed (occluders, useList=0) + ONE
//      drawIndexedIndirect over the kernel-written args (useList=1 — the
//      vertex shader dereferences the compacted list through the Task-193
//      group-2 storage slot).
import { createWebGpuRenderer } from '../../dist/rune.esm.js?v=197'
import {
  BOX_VERTS, BOX_INDICES, QUAD_VERTS, HIZ_W, HIZ_H, cameraAt,
  LEVEL_DIMS, LEVELS, MAX_LEVEL, LEVEL_OFF, PYRAMID_WORDS,
} from './scene.js?v=197'

/** Builds the WebGPU Hi-Z tier. Throws on an honest boot failure. */
export async function buildWgTier(deps) {
  const { scene, shell, noteError, stage, hud, PROBE, FORCE_SNAPSHOT, attachControls, pauseLoop, resumeLoop } = deps
  const { K, N, occl: OCCL, FLAGS_OFF, INST_OFF, sceneWords, sceneF32 } = scene

  // ── GPU boot (4 attempts — the GPU-process storm channel) ────────────────
  let renderer = null
  const bootCanvas = document.createElement('canvas')
  bootCanvas.width = 960
  bootCanvas.height = 540
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

  // ── the tier decision: software adapter → snapshot mode (no presents) ────
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

  let displayCanvas = null
  let snapshot2d = null
  if (MODE !== 'probe') {
    if (SNAPSHOT) {
      displayCanvas = document.createElement('canvas')
      displayCanvas.id = 'hiz-canvas'
      displayCanvas.width = 960
      displayCanvas.height = 540
      displayCanvas.className = 'hiz-canvas'
      stage.appendChild(displayCanvas)
      snapshot2d = displayCanvas.getContext('2d')
    } else {
      // Task 197a — THE LIVE CANVAS IS THE RENDERER'S CANVAS: the frames
      // present into bootCanvas, so bootCanvas itself goes on the stage.
      // (Pre-197: a fresh displayCanvas was appended and NEVER drawn into —
      // the present went to the offscreen bootCanvas: live mode = a black
      // stage. Snapshot mode blitted into its own 2D canvas and probe mode
      // used no canvas at all, so every gate ran green while the only path
      // a real GPU ever takes rendered nothing.)
      displayCanvas = bootCanvas
      displayCanvas.id = 'hiz-canvas'
      displayCanvas.className = 'hiz-canvas'
      displayCanvas.style.aspectRatio = '16 / 9'
      stage.appendChild(displayCanvas)
    }
    attachControls(displayCanvas)
  }

  // ── the resources (the facade's own contracts, nothing private) ─────────
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

  // ── WGSL: the generated kernels and pipelines (constants baked) ─────────
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
  const flatWorkgroups = (w, h) => Math.ceil(w * h / 64)

  // ── the debug hooks (the diagnostics channel — probe scripts read the
  // pyramid and the z tile directly; harmless in production) ───────────────
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
        pauseLoop()
        try {
          const { eye, mvp } = cameraAt(yaw, pitch, dist)
          renderTo(surface.targetId, mvp, eye, 1, false)
          const sOn = await readStats()
          const fOn = await gpu.readExternalBuffer(sceneId, Math.max(4, sOn.drawn * 4))
          const listOn = Array.from(new Uint32Array(fOn.buffer, 0, sOn.drawn))
          renderTo(surface.targetId, mvp, eye, 0, false)
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
          resumeLoop()
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

  // ── the uniform blocks (the UBO arena: 256-aligned dynamic offsets) ─────
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

  // ── THE FRAME: z prepass → pyramid → cull+compact+emitArgs → color+draw ──
  let lastFrame = null
  function renderTo(targetId, mvp, eye, hizOn, debug) {
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
    // 2. THE PYRAMID — mip0 from the tile, then 2×2 max per level (the
    // per-level constants are ENTRY POINTS — the family uniform is
    // frame-static by design)
    gpu.runCompute(PYR_COMPUTE, 'zToMip0', PYR_U, flatWorkgroups(HIZ_W, HIZ_H))
    for (let L = 1; L < LEVELS; L++) {
      gpu.runCompute(PYR_COMPUTE, `reduceL${L}`, PYR_U, flatWorkgroups(LEVEL_DIMS[L].w, LEVEL_DIMS[L].h))
    }
    // 3. THE CULL — test+compact+emitArgs (dispatch order is a WebGPU
    // guarantee; the args land without a CPU readback)
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

  // ── stats readback (async, throttled — the HUD + __hizStats) ─────────────
  async function readStats() {
    const f = await gpu.readExternalBuffer(statsArgsId, 52)
    const u = new Uint32Array(f.buffer, 0, 13)
    return { drawn: u[0], frustum: u[1], occluded: u[2], straddle: u[3], indirectCount: u[9] }
  }

  let blitPending = false
  function blitSnapshot() {
    if (blitPending) return
    blitPending = true
    surface.read().then(result => {
      blitPending = false
      if (snapshot2d !== null && result.data.length === 480 * 270 * 4) {
        snapshot2d.putImageData(new ImageData(new Uint8ClampedArray(result.data.buffer, result.data.byteOffset, result.data.length), 480, 270), 0, 0)
      }
    }).catch(() => { blitPending = false })
  }

  function frame(mvp, eye, hizOn, debug) {
    renderTo(SNAPSHOT ? surface.targetId : 0, mvp, eye, hizOn, debug)
    if (SNAPSHOT) blitSnapshot()
  }

  return {
    mode: 'webgpu',
    kind: MODE, // 'probe' | 'snapshot' | 'live'
    tierLine: 'WebGPU — compute family + drawIndexedIndirect (GPU-driven)',
    drawsLine: `draws: 2 (1 indirect) · dispatches: ${2 + LEVELS}`,
    canvas: displayCanvas,
    surface,
    renderTo,
    frame,
    readStats,
    drain: null,
    dispose() {
      try { renderer.dispose() } catch { /* a lost device is already dead */ }
      if (displayCanvas !== null && displayCanvas.parentElement === stage) displayCanvas.remove()
      if (typeof window !== 'undefined' && window.__hizDebug !== undefined && window.__hizDebug !== null && 'pyramid' in window.__hizDebug) {
        window.__hizDebug = undefined
      }
    },
  }
}
