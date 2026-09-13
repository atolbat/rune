// occlusion/shaders.js — Task 198: THE SHADER DICTIONARY — the per-language
// sources as DATA. This is the honest half of the common bricks: WGSL and
// GLSL ES 3.00 are different languages, so the sources stay two columns —
// but they implement ONE contract each, and the DRIVER code (tier.js) is
// written once. The device picks the column by backend.
//
// THE CONTRACTS (what every pair agrees on):
//   z      — corner + records → the r32f tile, fs writes the EXACT depth
//            (WGSL @builtin(position).z / GLSL gl_FragCoord.z)
//   cull   — N threads: thread i reads record i, runs the 8-corner test
//            (frustum → near-straddle → Hi-Z), writes ONE verdict word
//            (1 visible / 2 frustum / 3 occluded / 4 straddle). WG: the
//            scene storage at FLAGS_OFF + i; GL: the v_flag TF output.
//            Task 199: NOBODY short-circuits — every record is tested; the
//            occluder boundary is the per-frame POLICY (the prepass count).
//   color  — the lit + fogged image. WG: instance_index dereferences the
//            compacted LIST in the scene storage (the indirect draw); GL:
//            the per-instance attributes + the a_flag collapse.
//   panel  — one pyramid level as a tinted quad (the debug strip).
//   hist   — Task 202 — THE PREV-VISIBLE DEPTH PASS: the previous frame's
//            visible set, drawn DEPTH-ONLY into the pyramid tile at the
//            CURRENT camera (the two-pass HZB's phase 1). WG: the indirect
//            draw over the compacted list (whatever the last frame's
//            compact wrote is exactly what the last frame DREW); GL: the
//            collapse draw over all records reading the verdict feed.
//
// THE CONVENTIONS each language keeps its own (documented where they bite):
//   · WG framebuffer rows grow DOWN from NDC +y — GL FBO rows grow UP:
//     the cull rect maps py=(0.5-ny·0.5)·H on WG, py=(ny·0.5+0.5)·H on GL.
//   · WG NDC z ∈ [0,1] — GL [-1,1]: the GL depth D=(nz+1)·0.5 (monotonic,
//     consistent within the tier).
//   · The dFdy sign: GL fragment y grows UP → -dFdy matches the WG normal.
//   · THE DITHER (Task 198): an INTEGER hash over the pixel coordinates —
//     uint arithmetic wraps identically on every backend, so the dither is
//     BIT-EXACT cross-tier (GL mirrors y through u_misc.x = the target
//     height; WG reads @builtin(position).xy as-is). This kills the fog
//     banding — the «flickering gray triangles on the empty spaces» field
//     report — without adding a single cross-tier ULP.
import { HIZ_W, HIZ_H, LEVELS, MAX_LEVEL, LEVEL_DIMS, LEVEL_OFF } from './scene.js?v=203'

const SKY = 'vec3<f32>(0.045, 0.055, 0.09)'
const SKY_GLSL = 'vec3(0.045, 0.055, 0.09)'

/** The dictionary factory — the scenario's layout + constants bake in (N,
 *  the DECLARED record layout — stride + field offsets, the pyramid's level
 *  dims). ONE call, both backends' columns. Task 199: the record addressing
 *  is DERIVED from the declaration (a different scenario — a different
 *  declaration, the same kernel bodies), and the cull kernels no longer
 *  short-circuit the occluders — EVERY record is tested (sound with the
 *  max-reduced pyramid: a contributor's own footprint max ≥ its own front
 *  surface ≥ its nearest AABB corner — a builder never self-culls, and one
 *  occluder fully behind another is honestly culled). */
export function buildShaders(scene) {
  const { N, INST_OFF, FLAGS_OFF } = scene
  const STRIDE = scene.STRIDE ?? 12
  const F = scene.FIELDS ?? { center: 0, half: 3, color: 6 }
  const CENTER = F.center, HALF = F.half, COLOR = F.color
  const STRIDE_BYTES = STRIDE * 4

  // ── z: the depth prepass (records → the r32f tile) ──────────────────────
  const z = {
    wg: {
      code: `
struct ZParams { mvp: mat4x4<f32> }
@group(0) @binding(0) var<uniform> params: ZParams;
@group(2) @binding(0) var<storage, read> scene: array<u32>;
struct VOut { @builtin(position) pos: vec4<f32> }
@vertex fn vsMain(@location(0) corner: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
  let wo = ${INST_OFF}u + ii * ${STRIDE}u;
  let c = vec3<f32>(bitcast<f32>(scene[wo + ${CENTER}u]), bitcast<f32>(scene[wo + ${CENTER + 1}u]), bitcast<f32>(scene[wo + ${CENTER + 2}u]));
  let h = vec3<f32>(bitcast<f32>(scene[wo + ${HALF}u]), bitcast<f32>(scene[wo + ${HALF + 1}u]), bitcast<f32>(scene[wo + ${HALF + 2}u]));
  let world = c + h * (corner * 2.0 - 1.0);
  var o: VOut;
  o.pos = params.mvp * vec4<f32>(world, 1.0);
  return o;
}
@fragment fn fsMain(i: VOut) -> @location(0) vec4<f32> {
  // @builtin(position).z IS the depth-buffer value — the exact tile the
  // pyramid reduces; no re-derivation, no precision drift.
  return vec4<f32>(i.pos.z, 0.0, 0.0, 1.0);
}`,
      attrs: [3],
      hasTextures: false,
    },
    gl: {
      vs: `#version 300 es
layout(location=0) in vec3 a_corner;
layout(location=1) in vec3 a_c;
layout(location=2) in vec3 a_h;
uniform mat4 u_mvp;
void main() {
  vec3 world = a_c + a_h * (a_corner * 2.0 - 1.0);
  gl_Position = u_mvp * vec4(world, 1.0);
}`,
      fs: `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }`,
      attrs: [
        { location: 1, from: 'records', size: 3, stride: STRIDE_BYTES, offset: F.center * 4, divisor: 1 },
        { location: 2, from: 'records', size: 3, stride: STRIDE_BYTES, offset: F.half * 4, divisor: 1 },
      ],
      lanes: [{ name: 'u_mvp', kind: 'mat4', words: 16 }],
    },
  }

  // ── cull: the per-record verdict kernel (WG compute / GL TF) ────
  // Task 199 — THE POLICY-FREE KERNEL: nobody short-circuits. The WG leg
  // reads the pyramid from the STORAGE buffer (the Task-196 contract —
  // binding 2 read-only array<f32>, the levelInfo switch carries the baked
  // flat offsets); GL: the per-level r32f textures through the literal
  // sampler branches (GLSL ES 3.00 constant-index-expressions only).
  let WG_LEVEL_SWITCH = ''
  let GL_LD_INIT = ''
  let GL_PYR_FETCH = ''
  for (let L = 0; L < LEVELS; L++) {
    WG_LEVEL_SWITCH += `    case ${L}u: { return vec3<u32>(${LEVEL_OFF[L]}u, ${LEVEL_DIMS[L].w}u, ${LEVEL_DIMS[L].h}u); }\n`
    GL_LD_INIT += `ivec2(${LEVEL_DIMS[L].w}, ${LEVEL_DIMS[L].h}), `
    GL_PYR_FETCH += `  if (L == ${L}) { return texelFetch(u_pyr[${L}], p, 0).r; }\n`
  }
  GL_LD_INIT = GL_LD_INIT.replace(/, $/, '')
  const CORE_WGSL = `
  let i = gid.x;
  if (i >= ${N}u) { return; }
  // Task 199 — NO SHORT-CIRCUIT: every record is tested (the occluder
  // boundary is the POLICY — the per-frame prepass count — not a kernel
  // constant; the max-reduced pyramid makes self-test sound: the region
  // max over a builder's own footprint ≥ its own front surface ≥ its
  // nearest AABB corner, so a builder never self-culls)
  let wo = ${INST_OFF}u + i * ${STRIDE}u;
  let cx = bitcast<f32>(scene[wo + ${CENTER}u]); let cy = bitcast<f32>(scene[wo + ${CENTER + 1}u]); let cz = bitcast<f32>(scene[wo + ${CENTER + 2}u]);
  let hx = bitcast<f32>(scene[wo + ${HALF}u]); let hy = bitcast<f32>(scene[wo + ${HALF + 1}u]); let hz = bitcast<f32>(scene[wo + ${HALF + 2}u]);
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
      let px = (nx * 0.5 + 0.5) * f32(${HIZ_W});
      // WebGPU framebuffer rows grow DOWN from NDC +y (up): the tile's
      // row 0 is the TOP row — py = (1 - (ny*0.5+0.5)) * H.
      let py = (0.5 - ny * 0.5) * f32(${HIZ_H});
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
    scene[${FLAGS_OFF}u + i] = 2u;
    return;
  }
  // near-straddle: a corner at/behind the eye — keep visible, count honestly
  if (minW <= 1e-4) {
    scene[${FLAGS_OFF}u + i] = 4u;
    return;
  }
  // the Hi-Z test (toggled by the uniform — the OFF leg of the parity gate)
  if (params.misc.x > 0.5) {
    var px0 = i32(floor(x0)); var px1 = i32(ceil(x1));
    var py0 = i32(floor(y0)); var py1 = i32(ceil(y1));
    px0 = max(px0, 0); py0 = max(py0, 0);
    px1 = min(px1, ${HIZ_W}); py1 = min(py1, ${HIZ_H});
    // Task 200 — THE ONE-TEXEL GUARD (the cross-compiler ULP whetstone): the
    // projected rect rides fp32 mul/add chains the two compiler stacks may
    // contract differently (fma-vs-separate rounding); a ULP flip at an
    // integer boundary moves floor/ceil by one texel INWARD — the tile set
    // would lose the box's own edge texels, zmax under-reports, and a
    // VISIBLE box over-culls (the phone's city-parity FAIL). Widening by
    // one texel per side can only GROW the sampled max — conservative on
    // every backend, knife-edge-proof.
    px0 = max(px0 - 1, 0); py0 = max(py0 - 1, 0);
    px1 = min(px1 + 1, ${HIZ_W}); py1 = min(py1 + 1, ${HIZ_H});
    if (px1 > px0 && py1 > py0) {
      let rw = px1 - px0; let rh = py1 - py0;
      // Task 200 — THE INTEGER MIP (the log2 knife-edge): ceil(log2(s)) on an
      // exact power of two sits ONE rounding from ±1 mip on independent
      // compilers — a finer mip under-reports zmax (the over-cull), a
      // coarser one blurs the test. The COUNT FORM — the smallest L with
      // 2^L ≥ s — is ceil(log2(s)) exactly, in pure integer ops, and the
      // while-shift loop is the 100%-portable spelling (countLeadingZeros
      // is fine on Tint but ANGLE's ESSL3 table rejects findMSB — the
      // field-proven lesson: one loop shape, bit-identical on every
      // backend, ≤ 9 iterations for a half-res tile).
      let s = max(rw, rh);
      var L = 0;
      loop {
        if ((1u << u32(L)) >= u32(s)) { break; }
        L = L + 1;
      }
      L = min(L, ${MAX_LEVEL});
      let info = levelInfo(u32(L));
      let lw = i32(info.y); let lh = i32(info.z);
      let tx0 = u32(px0) >> u32(L); let tx1 = min(u32(px1 - 1) >> u32(L), u32(lw) - 1u);
      let ty0 = u32(py0) >> u32(L); let ty1 = min(u32(py1 - 1) >> u32(L), u32(lh) - 1u);
      // THE MAX-REDUCED TILE (the farthest surface in the region): the
      // SOUND form of the single-tap Hi-Z test — the box's NEAREST corner
      // vs the region's FARTHEST surface (the min-reduce + same compare is
      // UNSOUND: a close occluder in ONE corner culls a box that pokes out
      // elsewhere — this page's own pixel-parity gate caught exactly that).
      var zmax = -1.0;
      for (var ty = ty0; ty <= ty1; ty = ty + 1u) {
        for (var tx = tx0; tx <= tx1; tx = tx + 1u) {
          zmax = max(zmax, pyramid[info.x + ty * info.y + tx]);
        }
      }
      // THE CONSERVATIVE SLACK (1e-5 of NDC depth): the cull compares f32
      // tile values, the color pass's depth test rides the attachment's
      // own precision — a borderline box must never win the quantized battle.
      if (minZ > zmax + 1e-5) {
        scene[${FLAGS_OFF}u + i] = 3u;
        return;
      }
    }
  }
  scene[${FLAGS_OFF}u + i] = 1u;
`

  const cull = {
    wg: {
      code: `
struct CullParams { mvp: mat4x4<f32>, misc: vec4<f32> }
@group(0) @binding(0) var<uniform> params: CullParams;
@group(0) @binding(1) var<storage, read_write> scene: array<u32>;
@group(0) @binding(2) var<storage, read> pyramid: array<f32>;
fn levelInfo(L: u32) -> vec3<u32> {
  switch L {
${WG_LEVEL_SWITCH}    default: { return vec3<u32>(0u, 1u, 1u); }
  }
}
@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) gid: vec3<u32>) {
${CORE_WGSL}}`,
      entry: 'cull',
      uniformBytes: 80,
    },
    gl: `#version 300 es
layout(location=0) in vec3 a_c;
layout(location=1) in vec3 a_h;
uniform vec4 u_mvp[4]; // column per vec4 — clip = x*u_mvp[0] + y*u_mvp[1] + z*u_mvp[2] + u_mvp[3]
uniform vec4 u_misc;   // x: hizOn (the OFF leg of the parity gate)
uniform sampler2D u_pyr[${LEVELS}];
out float v_flag;

const ivec2 LD[${LEVELS}] = ivec2[${LEVELS}](${GL_LD_INIT});

// the unrolled fetch: one literal branch per mip level (GLSL ES 3.00
// sampler arrays take ONLY constant integral indices — a loop variable
// does not pass on ANGLE)
float pyrAt(int L, ivec2 p) {
${GL_PYR_FETCH}  return -1.0;
}

void main() {
  int i = gl_VertexID;
  // Task 199 — NO SHORT-CIRCUIT (the WG twin's comment): every record is
  // tested; the occluder boundary is the POLICY, and the GL leg's flag
  // short-circuit is gone with it. The GL draw collapses flag ∉ {1,4}.

  float x0 = 1e30, x1 = -1e30, y0 = 1e30, y1 = -1e30;
  float minD = 1e30, minW = 1e30;
  int outL = 0, outR = 0, outB = 0, outT = 0, outN = 0, outF = 0;
  for (int k = 0; k < 8; k++) {
    float sx = float(k & 1) * 2.0 - 1.0;
    float sy = float((k >> 1) & 1) * 2.0 - 1.0;
    float sz = float((k >> 2) & 1) * 2.0 - 1.0;
    vec4 clip = vec4(
      a_c.x + sx * a_h.x, a_c.y + sy * a_h.y, a_c.z + sz * a_h.z, 1.0);
    clip = clip.x * u_mvp[0] + clip.y * u_mvp[1] + clip.z * u_mvp[2] + u_mvp[3];
    float w = clip.w;
    minW = min(minW, w);
    if (w > 1e-4) {
      float nx = clip.x / w, ny = clip.y / w, nz = clip.z / w;
      // GL: FBO texel row 0 = the BOTTOM row — the WG tier's Y-flip lesson,
      // inverted for this backend; GL NDC z spans [-1,1] → D=(nz+1)*0.5.
      float px = (nx * 0.5 + 0.5) * float(${HIZ_W});
      float py = (ny * 0.5 + 0.5) * float(${HIZ_H});
      float d = (nz + 1.0) * 0.5;
      x0 = min(x0, px); x1 = max(x1, px);
      y0 = min(y0, py); y1 = max(y1, py);
      minD = min(minD, d);
      if (nx < -1.0) { outL++; }
      if (nx > 1.0) { outR++; }
      if (ny < -1.0) { outB++; }
      if (ny > 1.0) { outT++; }
      if (nz < -1.0) { outN++; }
      if (nz > 1.0) { outF++; }
    }
  }
  // frustum: ALL corners outside the SAME plane
  if (outL == 8 || outR == 8 || outB == 8 || outT == 8 || outN == 8 || outF == 8) {
    v_flag = 2.0; return;
  }
  // near-straddle: a corner at/behind the eye — keep visible, count honestly
  if (minW <= 1e-4) {
    v_flag = 4.0; return;
  }
  // the Hi-Z test (u_misc.x — the OFF leg of the parity gate)
  if (u_misc.x > 0.5) {
    int px0 = max(int(floor(x0)), 0), px1 = min(int(ceil(x1)), ${HIZ_W});
    int py0 = max(int(floor(y0)), 0), py1 = min(int(ceil(y1)), ${HIZ_H});
    // Task 200 — THE ONE-TEXEL GUARD (the WG twin's comment): one texel per
    // side, floor-and-ceil outward — the sampled max only grows, the
    // fma-contraction ULP knife-edge at the rect edges is absorbed.
    px0 = max(px0 - 1, 0); py0 = max(py0 - 1, 0);
    px1 = min(px1 + 1, ${HIZ_W}); py1 = min(py1 + 1, ${HIZ_H});
    if (px1 > px0 && py1 > py0) {
      int rw = px1 - px0, rh = py1 - py0;
      // Task 200 — THE INTEGER MIP: the COUNT FORM — the smallest L with
      // 2^L ≥ s — is ceil(log2(s)) exactly, pure integer ops, no builtins
      // (ANGLE's ESSL3 table rejects findMSB — the compile error the GL
      // tier's fallback field report carried). The while-shift is the WG
      // twin's exact loop shape — bit-identical verdicts everywhere.
      int s = max(rw, rh);
      int L = 0;
      while ((1 << L) < s) { L++; }
      L = min(L, ${MAX_LEVEL});
      int lw = LD[L].x, lh = LD[L].y;
      int tx0 = px0 >> L, tx1 = min((px1 - 1) >> L, lw - 1);
      int ty0 = py0 >> L, ty1 = min((py1 - 1) >> L, lh - 1);
      // THE MAX-REDUCED TILE — the SOUND form (the WG twin's comment)
      float zmax = -1.0;
      for (int ty = ty0; ty <= ty1; ty++) {
        for (int tx = tx0; tx <= tx1; tx++) {
          zmax = max(zmax, pyrAt(L, ivec2(tx, ty)));
        }
      }
      // the 1e-5 conservative slack
      if (minD > zmax + 1e-5) {
        v_flag = 3.0; return;
      }
    }
  }
  v_flag = 1.0;
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0); // RASTERIZER_DISCARD is on; a defined position keeps every driver honest
}`,
    lanes: [
      { name: 'u_mvp[0]' }, { name: 'u_mvp[1]' }, { name: 'u_mvp[2]' }, { name: 'u_mvp[3]' },
      { name: 'u_misc' },
    ],
  }

  // ── color: the lit + fogged image ───────────────────────────────────────
  const color = {
    wg: {
      code: `
struct ColorParams { mvp: mat4x4<f32>, misc: vec4<f32>, light: vec4<f32>, cam: vec4<f32> }
@group(0) @binding(0) var<uniform> params: ColorParams;
@group(2) @binding(0) var<storage, read> scene: array<u32>;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) world: vec3<f32>, @location(1) color: vec3<f32> }
@vertex fn vsMain(@location(0) corner: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
  // THE LIST INDIRECTION: the compact kernel wrote the stable ascending
  // visible list into the scene's word 0 region; the indirect draw's
  // instanceCount is GPU-written — the whole visible set, zero readbacks.
  let absIdx = scene[ii];
  let wo = ${INST_OFF}u + absIdx * ${STRIDE}u;
  let c = vec3<f32>(bitcast<f32>(scene[wo + ${CENTER}u]), bitcast<f32>(scene[wo + ${CENTER + 1}u]), bitcast<f32>(scene[wo + ${CENTER + 2}u]));
  let h = vec3<f32>(bitcast<f32>(scene[wo + ${HALF}u]), bitcast<f32>(scene[wo + ${HALF + 1}u]), bitcast<f32>(scene[wo + ${HALF + 2}u]));
  let col = vec3<f32>(bitcast<f32>(scene[wo + ${COLOR}u]), bitcast<f32>(scene[wo + ${COLOR + 1}u]), bitcast<f32>(scene[wo + ${COLOR + 2}u]));
  let world = c + h * (corner * 2.0 - 1.0);
  var o: VOut;
  o.pos = params.mvp * vec4<f32>(world, 1.0);
  o.world = world;
  o.color = col;
  return o;
}
@fragment fn fsMain(i: VOut) -> @location(0) vec4<f32> {
  // flat per-triangle normal from screen-space derivatives — no normals
  // in the records, the boxes are their own geometry. THE NaN GUARD: a
  // degenerate quad (a sub-pixel box at the far fog line) makes the cross
  // product zero-length; normalize(0) is NaN and NaN×anything poisons the
  // whole color (the framebuffer writes it as 255,255,255 — the white-blob
  // field report class). The rsqrt form clamps to a ZERO normal instead:
  // the face reads unlit, never NaN.
  let nv = cross(dpdx(i.world), dpdy(i.world));
  let n = nv * inverseSqrt(max(dot(nv, nv), 1e-20));
  let l = max(dot(n, normalize(params.light.xyz)), 0.0);
  let dist = distance(i.world, params.cam.xyz);
  // Task 198 — the fog band pulled to (55, 130): the far ground edge now
  // fully melts into the sky instead of a hard cut crawling at the horizon
  let fog = smoothstep(55.0, 130.0, dist);
  var col = i.color * (0.35 + 0.65 * l);
  col = mix(col, ${SKY}, fog);
  // Task 198 — THE CROSS-BACKEND DITHER: an INTEGER hash over the pixel
  // coordinates (bit-exact on every backend — uint arithmetic wraps
  // identically); kills the fog banding without cross-tier noise
  let pc = i.pos.xy;
  let h = (bitcast<u32>(pc.x) ^ bitcast<u32>(pc.y)) * 747796405u + 2891336453u;
  let dither = f32(h >> 16u) * (1.0 / 65535.0);
  col = col + vec3<f32>((dither - 0.5) * (1.0 / 255.0));
  return vec4<f32>(col, 1.0);
}`,
      attrs: [3],
      hasTextures: false,
    },
    gl: {
      vs: `#version 300 es
layout(location=0) in vec3 a_corner;
layout(location=1) in vec3 a_c;
layout(location=2) in vec3 a_h;
layout(location=3) in vec3 a_col;
layout(location=4) in float a_flag; // the TF-written verdict, per instance
uniform mat4 u_mvp;
out vec3 v_world;
out vec3 v_color;
void main() {
  // Task 201 — THE FLOOR DECODE: the flags feed carries the RAW verdict
  // (1..4) or the hist-encoded word (verdict + streak/32 — the temporal
  // policy's encoding); floor() answers both identically (the raw values
  // are exact integers, the encoded ones carry the streak in the fraction)
  if (floor(a_flag) != 1.0 && floor(a_flag) != 4.0) {
    // THE COLLAPSE: degenerate clip position — the instance's triangles
    // cover zero pixels; the submission cost stays fixed (no readback,
    // no per-frame CPU compaction).
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    v_world = vec3(0.0); v_color = vec3(0.0);
    return;
  }
  vec3 world = a_c + a_h * (a_corner * 2.0 - 1.0);
  gl_Position = u_mvp * vec4(world, 1.0);
  v_world = world;
  v_color = a_col;
}`,
      fs: `#version 300 es
precision highp float;
in vec3 v_world;
in vec3 v_color;
uniform vec4 u_misc;   // x: the target height — the dither's y mirror (a
                       // UNIFORM, not a varying: the exact bits matter, an
                       // interpolated value carries ±1 ULP and breaks the
                       // cross-backend bit-exactness of the integer hash)
uniform vec4 u_light;
uniform vec4 u_cam;
out vec4 o;
void main() {
  // flat per-triangle normal from screen-space derivatives — the same
  // trick as the WG tier. THE Y-FLIP: GL fragment coordinates grow y UP,
  // WGSL @builtin(position).y grows y DOWN — dFdy is the derivative along
  // OPPOSITE screen directions, and an un-flipped cross() inverts the
  // normal. Negating dFdy matches the WG image. THE NaN GUARD: the rsqrt
  // form (the WG twin's comment) — a degenerate quad clamps to a zero
  // normal, never NaN.
  vec3 nv = cross(dFdx(v_world), -dFdy(v_world));
  vec3 n = nv / sqrt(max(dot(nv, nv), 1e-20));
  float l = max(dot(n, normalize(u_light.xyz)), 0.0);
  float dist = distance(v_world, u_cam.xyz);
  // Task 198 — the fog band pulled to (55, 130) (the WG twin's comment)
  float fog = smoothstep(55.0, 130.0, dist);
  vec3 col = v_color * (0.35 + 0.65 * l);
  col = mix(col, ${SKY_GLSL}, fog);
  // Task 198 — THE CROSS-BACKEND DITHER: the mirrored pixel coordinates
  // (u_misc.x = the target height) match the WG top-down y EXACTLY, the
  // integer hash is bit-identical on both backends
  vec2 pc = vec2(gl_FragCoord.x, u_misc.x - gl_FragCoord.y);
  uint h = (floatBitsToUint(pc.x) ^ floatBitsToUint(pc.y)) * 747796405u + 2891336453u;
  float dither = float(h >> 16u) * (1.0 / 65535.0);
  col += (dither - 0.5) * (1.0 / 255.0);
  o = vec4(col, 1.0);
}`,
      attrs: [
        { location: 1, from: 'records', size: 3, stride: STRIDE_BYTES, offset: F.center * 4, divisor: 1 },
        { location: 2, from: 'records', size: 3, stride: STRIDE_BYTES, offset: F.half * 4, divisor: 1 },
        { location: 3, from: 'records', size: 3, stride: STRIDE_BYTES, offset: F.color * 4, divisor: 1 },
        { location: 4, from: 'flags', size: 1, stride: 4, offset: 0, divisor: 1 },
      ],
      lanes: [
        { name: 'u_mvp', kind: 'mat4', words: 16 },
        { name: 'u_misc', kind: 'vec4', words: 4 },
        { name: 'u_light', kind: 'vec4', words: 4 },
        { name: 'u_cam', kind: 'vec4', words: 4 },
      ],
    },
  }

  // ── hist: Task 202 — THE PREV-VISIBLE DEPTH PASS (the two-pass HZB's
  // phase 1 — Nanite's «the first pass uses the HZB from last frame»,
  // Aaltonen's two-phase occlusion, the CryEngine coverage-buffer family).
  // THE OPTIMIZATION BEYOND THE PAPERS: instead of REPROJECTING last
  // frame's depth texture (the gather + dilation heuristics, the
  // disocclusion holes a moving camera tears into it — the «don't even
  // dream of reprojecting last frame depth» lesson), this column
  // RE-RENDERS the previous frame's visible set at the CURRENT camera.
  // The occluder SET lags one frame; the occluder GEOMETRY is exact — no
  // reprojection error, no dilation, no stale near depth from a surface
  // that has since moved. Sound by construction: everything drawn here is
  // geometry that exists this frame at this camera, so a box the feedback
  // culls is behind a surface drawn THIS frame. The one-frame lag only
  // ever costs COVERAGE (a freshly disoccluded region has no history yet
  // — the K-wall fill pass covers it, and one frame later the set catches
  // up), never a pixel.
  const hist = {
    wg: {
      code: `
struct ZParams { mvp: mat4x4<f32> }
@group(0) @binding(0) var<uniform> params: ZParams;
@group(2) @binding(0) var<storage, read> scene: array<u32>;
struct VOut { @builtin(position) pos: vec4<f32> }
@vertex fn vsMain(@location(0) corner: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
  // THE LIST INDIRECTION (the color pass's own trick): instance ii = the
  // ii-th entry of the compacted visible list — whatever the LAST frame's
  // compact wrote is exactly what the last frame drew. A cold start (the
  // args buffer zeroed) draws zero instances — the honest first frame.
  let absIdx = scene[ii];
  let wo = ${INST_OFF}u + absIdx * ${STRIDE}u;
  let c = vec3<f32>(bitcast<f32>(scene[wo + ${CENTER}u]), bitcast<f32>(scene[wo + ${CENTER + 1}u]), bitcast<f32>(scene[wo + ${CENTER + 2}u]));
  let h = vec3<f32>(bitcast<f32>(scene[wo + ${HALF}u]), bitcast<f32>(scene[wo + ${HALF + 1}u]), bitcast<f32>(scene[wo + ${HALF + 2}u]));
  let world = c + h * (corner * 2.0 - 1.0);
  var o: VOut;
  o.pos = params.mvp * vec4<f32>(world, 1.0);
  return o;
}
@fragment fn fsMain(i: VOut) -> @location(0) vec4<f32> {
  // the EXACT depth — the z pass's own fragment (@builtin(position).z)
  return vec4<f32>(i.pos.z, 0.0, 0.0, 1.0);
}`,
      attrs: [3],
      hasTextures: false,
    },
    gl: {
      vs: `#version 300 es
layout(location=0) in vec3 a_corner;
layout(location=1) in vec3 a_c;
layout(location=2) in vec3 a_h;
layout(location=4) in float a_flag; // the PREVIOUS verdict (raw or encoded)
uniform mat4 u_mvp;
void main() {
  // the color pass's own collapse: the flag feed carries last frame's
  // verdicts (raw 1..4, or the hist-encoded word); floor() decodes both,
  // and a record not in the previous visible set collapses to nothing
  if (floor(a_flag) != 1.0 && floor(a_flag) != 4.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec3 world = a_c + a_h * (a_corner * 2.0 - 1.0);
  gl_Position = u_mvp * vec4(world, 1.0);
}`,
      fs: `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }`,
      attrs: [
        { location: 1, from: 'records', size: 3, stride: STRIDE_BYTES, offset: F.center * 4, divisor: 1 },
        { location: 2, from: 'records', size: 3, stride: STRIDE_BYTES, offset: F.half * 4, divisor: 1 },
        { location: 4, from: 'flags', size: 1, stride: 4, offset: 0, divisor: 1 },
      ],
      lanes: [{ name: 'u_mvp', kind: 'mat4', words: 16 }],
    },
  }

  // ── panel: the pyramid debug strip (one quad per level) ─────────────────
  // ONE info lane both backends: (offset, w, h, 0) — the WG reads the flat
  // offset into the storage pyramid; the GL clamps with (w, h) = .yz.
  const panel = {
    wg: {
      code: `
struct PanelParams { rect: vec4<f32>, info: vec4<f32> }
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
  let off = u32(params.info.x);
  let lw = u32(params.info.y);
  let lh = u32(params.info.z);
  let tx = min(u32(i.uv.x * f32(lw)), lw - 1u);
  let ty = min(u32(i.uv.y * f32(lh)), lh - 1u);
  let z = pyramid[off + ty * lw + tx];
  let v = clamp(1.0 - z, 0.0, 1.0); // tile-max: sky (1.0) renders black
  return vec4<f32>(v * 0.9, v * 0.75, v * 0.55 + 0.1, 1.0);
}`,
      attrs: [2],
      hasTextures: false,
    },
    gl: {
      vs: `#version 300 es
layout(location=0) in vec2 a_q;
uniform vec4 u_rect;
out vec2 v_uv;
void main() {
  float x = mix(u_rect.x, u_rect.z, a_q.x * 0.5 + 0.5);
  float y = mix(u_rect.y, u_rect.w, a_q.y * 0.5 + 0.5);
  gl_Position = vec4(x, y, 0.0, 1.0);
  v_uv = a_q * 0.5 + 0.5;
}`,
      fs: `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_pyr;
uniform vec4 u_info; // x: offset (unused here), y: w, z: h
out vec4 o;
void main() {
  ivec2 t = ivec2(min(v_uv * u_info.yz, u_info.yz - 1.0));
  float z = texelFetch(u_pyr, t, 0).r;
  float v = clamp(1.0 - z, 0.0, 1.0); // tile-max: sky (1.0) renders black
  o = vec4(v * 0.9, v * 0.75, v * 0.55 + 0.1, 1.0);
}`,
      attrs: [],
      lanes: [
        { name: 'u_rect', kind: 'vec4', words: 4 },
        { name: 'u_info', kind: 'vec4', words: 4 },
      ],
    },
  }

  return { z, cull, color, hist, panel }
}
