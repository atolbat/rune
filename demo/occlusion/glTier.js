// occlusion/glTier.js — Task 197: THE WEBGL2 TIER of the Hi-Z demo — the
// COMMON GROUND between the backends.
//
// The honest mapping (why the Task-196 facade contracts cannot be pushed
// into WebGL2 1:1, and what rides in their place):
//
//   WebGPU (Task 196)                    WebGL2 (this tier)
//   ─────────────────────────────────    ─────────────────────────────────────
//   compute family with TEXTURE slots →  TRANSFORM-FEEDBACK pass (the
//   (zToMip0 + reduceL1..L9)             library's own GL compute substitute,
//                                        Task 132) for the CULL; the pyramid
//                                        reduces as FULLSCREEN FBO passes
//                                        (render-to-texture 2×2 MAX) — GL has
//                                        no compute stage at all
//   r32float storage tile               → 'r32f' data textures (Task 197's
//                                        GLTextureFormat growth) — one f32
//                                        per texel, NEAREST, renderable via
//                                        EXT_color_buffer_float
//   depth24plus target attachment       → depthBits: 32 → DEPTH_COMPONENT32F
//                                        (Task 197's createTarget growth) —
//                                        the attachment stores the EXACT f32
//                                        z gl_FragCoord.z computes, so the
//                                        cull-vs-attachment quantization gap
//                                        disappears
//   drawIndexedIndirect (GPU-written    → ONE drawElementsInstanced over ALL
//   instanceCount)                       instances + VERTEX COLLAPSE: the
//                                        vertex shader reads the TF-written
//                                        per-instance flag and clips
//                                        invisible instances to degenerate
//                                        positions — GPU-side visibility,
//                                        ZERO CPU sync (the Task-193
//                                        bit-discard pattern, GL-shaped)
//
// The pipeline mirrors the WG tier step for step:
//   1. z prepass: the occluders into the r32f tile, fs writes
//      gl_FragCoord.z (the EXACT depth value — GL's twin of WGSL's
//      @builtin(position).z); the DEPTH_COMPONENT32F attachment ('less')
//      keeps the NEAREST occluder per pixel.
//   2. the pyramid: level 0 IS the z tile; reduceL1..L9 fullscreen quads
//      (2×2 MAX — the farthest surface per tile, the SOUND test form).
//   3. the cull: ONE transform-feedback pass over N vertices —
//      gl_VertexID addresses the record; the vertex shader runs the SAME
//      8-corner test (frustum → near-straddle → Hi-Z with the mip-picked
//      ≤2×2 region, the 1e-5 conservative slack) and streams the verdict
//      flags (1 visible / 2 frustum / 3 occluded / 4 straddle) into a
//      buffer — the TF output becomes the color pass's per-instance
//      attribute (Task 140's dynamic stream-output contract).
//   4. the color pass: ONE indexed instanced draw of ALL instances; the
//      vertex shader collapses flag∉{1,4} to clip-space zero area.
//
// GL-side conventions the port had to translate (documented where they
// bite): NDC z spans [-1,1] (the SAME WebGPU-style projection matrix means
// the pyramid values live in D=(z_ndc+1)/2 — monotonic, consistent within
// the tier); FBO texel row 0 is the BOTTOM row (rect mapping py=(ny+1)/2·H
// — the WG tier's Y-flip lesson inverted); sampler arrays are indexed only
// through constant-index-expressions (the samplePyr loop).
import { createWebGL2Renderer } from '../../dist/rune.esm.js?v=197'
import {
  BOX_VERTS, BOX_INDICES, QUAD_STRIP_VERTS, HIZ_W, HIZ_H,
  LEVEL_DIMS, LEVELS, MAX_LEVEL,
} from './scene.js?v=197'

const SKY = [0.045, 0.055, 0.09, 1]
const LIGHT = [0.5, 0.8, 0.35]

/** Builds the WebGL2 Hi-Z tier. Throws an honest refusal when the GL
 *  stack cannot carry it (no WebGL2 context, no EXT_color_buffer_float). */
export async function buildGlTier(deps) {
  const { scene, shell, noteError, stage, PROBE, attachControls } = deps
  const { K, N, INST_OFF, sceneF32 } = scene

  // ── the canvas: the GL tier presents directly (no snapshot dance — GL
  //    canvas draws kill nothing in the container; probe mode stays offscreen)
  let canvas
  if (PROBE) {
    canvas = document.createElement('canvas')
    canvas.width = 960
    canvas.height = 540
  } else {
    canvas = document.createElement('canvas')
    canvas.id = 'hiz-canvas'
    canvas.width = 960
    canvas.height = 540
    canvas.className = 'hiz-canvas'
    canvas.style.aspectRatio = '16 / 9'
    stage.appendChild(canvas)
    attachControls(canvas)
  }

  const renderer = createWebGL2Renderer({
    canvas,
    dpr: 1,
    clear: { color: SKY, depth: 1 },
    onGlError: noteError,
    observeResize: false,
    multiDraw: false, // the tier drives the facade directly — no batch tier
  })
  const gl = renderer.gl

  // ── resources ────────────────────────────────────────────────────────────
  const boxBuf = gl.createBuffer(BOX_VERTS)
  const quadBuf = gl.createBuffer(QUAD_STRIP_VERTS)
  const boxIb = gl.createElementBuffer(BOX_INDICES)
  // the instance records: 12 words (48 B) per record — c(3) h(3) col(3) pad(3);
  // the GL attributes ride the stride/offset contract (divisor 1 for the
  // instanced color pass, per-vertex for the TF cull pass over POINTS).
  const sceneBuf = gl.createBuffer(sceneF32.subarray(INST_OFF), 'static')
  // the TF output: one verdict flag per record — 'dynamic' (Task 140: the
  // stream-output buffer the SAME frame's draw consumes as an attribute).
  const flagBuf = gl.createBuffer(new Float32Array(N), 'dynamic')

  // the pyramid: level 0 IS the z tile; each level its own r32f texture +
  // target (the feedback-loop-safe shape — no mip-level attachment games).
  const pyrTex = []
  const pyrTarget = []
  const zTexId = gl.createTexture(HIZ_W, HIZ_H, { format: 'r32f' })
  pyrTex.push(zTexId)
  let zDepthBits = null
  let zTargetId = 0
  for (const bits of [32, 24, 16]) {
    try {
      zTargetId = gl.createTarget(zTexId, HIZ_W, HIZ_H, true, [1, 1, 1, 1], bits)
      zDepthBits = bits
      break
    } catch { /* the ladder tries the next precision */ }
  }
  if (zDepthBits === null) {
    throw new Error('rune: the r32f z-target could not attach (EXT_color_buffer_float missing? — the Hi-Z pyramid needs float render targets)')
  }
  if (zDepthBits !== 32) shell.log.info(`depth32f renderbuffer refused by the driver — the z prepass rides DEPTH_COMPONENT${zDepthBits === 24 ? 24 : 16} (the 1e-5 cull slack covers the quantization gap)`)
  for (let L = 1; L < LEVELS; L++) {
    const w = LEVEL_DIMS[L].w, h = LEVEL_DIMS[L].h
    const tex = gl.createTexture(w, h, { format: 'r32f' })
    pyrTex.push(tex)
    pyrTarget.push(gl.createTarget(tex, w, h, false, [0, 0, 0, 1]))
  }

  // ── GLSL ─────────────────────────────────────────────────────────────────
  // 1. the z prepass: gl_FragCoord.z IS the depth value — the exact tile
  //    the pyramid reduces (the GL twin of WGSL @builtin(position).z).
  const Z_VS = `#version 300 es
layout(location=0) in vec3 a_corner;
layout(location=1) in vec3 a_c;
layout(location=2) in vec3 a_h;
uniform mat4 u_mvp;
void main() {
  vec3 world = a_c + a_h * (a_corner * 2.0 - 1.0);
  gl_Position = u_mvp * vec4(world, 1.0);
}`
  const Z_FS = `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }`

  // 2. the reduce: fullscreen quad, out texel (x,y) = MAX of the 2×2 block
  //    of the previous level (clamped — odd dims reuse the edge texel).
  const REDUCE_VS = `#version 300 es
layout(location=0) in vec2 a_q;
void main() { gl_Position = vec4(a_q, 0.0, 1.0); }`
  const REDUCE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec4 u_dims; // x: wIn, y: hIn
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  int x0 = min(p.x, int(u_dims.x) - 1);
  int x1 = min(p.x + 1, int(u_dims.x) - 1);
  int y0 = min(p.y, int(u_dims.y) - 1);
  int y1 = min(p.y + 1, int(u_dims.y) - 1);
  float a = texelFetch(u_src, ivec2(x0, y0), 0).r;
  float b = texelFetch(u_src, ivec2(x1, y0), 0).r;
  float c = texelFetch(u_src, ivec2(x0, y1), 0).r;
  float d = texelFetch(u_src, ivec2(x1, y1), 0).r;
  o = vec4(max(max(a, b), max(c, d)), 0.0, 0.0, 1.0);
}`

  // 3. the cull (the WGSL kernel ported to a TF vertex pass): 8 corners →
  //    conservative rect + nearest depth + plane-outside counts; frustum →
  //    near-straddle → the Hi-Z test (mip by rect size, ≤2×2 taps, the
  //    1e-5 conservative slack). GL CONVENTIONS: NDC z ∈ [-1,1] → depth
  //    D=(z_ndc+1)*0.5; FBO row 0 is the BOTTOM row → py=(ny+1)*0.5*H.
  //    Verdict flags: 1 visible, 2 frustum, 3 occluded, 4 near-straddle.
  let LD_INIT = ''
  for (let L = 0; L < LEVELS; L++) LD_INIT += `ivec2(${LEVEL_DIMS[L].w}, ${LEVEL_DIMS[L].h}), `
  LD_INIT = LD_INIT.replace(/, $/, '')
  // GLSL ES 3.00: sampler arrays take ONLY true constant integral indices
  // (a loop index is NOT one — ANGLE rejects `u_pyr[l]` at compile). The
  // fetch chain unrolls one literal branch per level — legal everywhere.
  let PYR_BRANCHES = ''
  for (let L = 0; L < LEVELS; L++) PYR_BRANCHES += `  if (L == ${L}) { return texelFetch(u_pyr[${L}], p, 0).r; }\n`
  const CULL_GLSL = `#version 300 es
layout(location=0) in vec3 a_c;
layout(location=1) in vec3 a_h;
uniform vec4 u_mvp[4]; // column per vec4 — clip = x*u_mvp[0] + y*u_mvp[1] + z*u_mvp[2] + u_mvp[3]
uniform vec4 u_misc;   // x: hizOn, y: K (occluder count — always visible)
uniform vec4 u_dims;   // x: HIZ_W, y: HIZ_H, z: MAX_LEVEL, w: OCCL
uniform sampler2D u_pyr[${LEVELS}];
out float v_flag;

const ivec2 LD[${LEVELS}] = ivec2[${LEVELS}](${LD_INIT});

// the unrolled fetch: one literal branch per mip level
float pyrAt(int L, ivec2 p) {
${PYR_BRANCHES}  return -1.0;
}

void main() {
  int i = gl_VertexID;
  // the occluders ride the flag=1 lane — the WG tier draws them with a
  // separate classic draw; the GL tier's single instanced draw keeps them
  // always-visible (the honest equivalent, same pixel set).
  if (i < int(u_misc.y)) { v_flag = 1.0; return; }

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
      // GL: FBO texel row 0 = the BOTTOM row (NDC y=-1) — the WG tier's
      // Y-flip lesson, inverted for this backend.
      float px = (nx * 0.5 + 0.5) * u_dims.x;
      float py = (ny * 0.5 + 0.5) * u_dims.y;
      // GL NDC z spans [-1,1] — the depth value the attachment stores.
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
  if (u_misc.x == 1.0) {
    int px0 = max(int(floor(x0)), 0), px1 = min(int(ceil(x1)), int(u_dims.x));
    int py0 = max(int(floor(y0)), 0), py1 = min(int(ceil(y1)), int(u_dims.y));
    if (px1 > px0 && py1 > py0) {
      int rw = px1 - px0, rh = py1 - py0;
      int L = int(ceil(log2(float(max(rw, rh)))));
      L = clamp(L, 0, int(u_dims.z));
      int lw = LD[L].x, lh = LD[L].y;
      int tx0 = px0 >> L, tx1 = min((px1 - 1) >> L, lw - 1);
      int ty0 = py0 >> L, ty1 = min((py1 - 1) >> L, lh - 1);
      // THE MAX-REDUCED TILE (the farthest surface in the region) — the
      // SOUND form; the box's NEAREST corner vs that FARTHEST surface.
      float zmax = -1.0;
      for (int ty = ty0; ty <= ty1; ty++) {
        for (int tx = tx0; tx <= tx1; tx++) {
          zmax = max(zmax, pyrAt(L, ivec2(tx, ty)));
        }
      }
      // the 1e-5 conservative slack: the cull compares f32 tile values,
      // the color pass's depth test rides the attachment's precision.
      if (minD > zmax + 1e-5) {
        v_flag = 3.0; return;
      }
    }
  }
  v_flag = 1.0;
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0); // RASTERIZER_DISCARD is on; a defined position keeps every driver honest
}`

  // 4. the color pass: ONE instanced draw over ALL records; the vertex
  //    shader collapses invisible instances (flag ∉ {1, 4}) to a clip-space
  //    zero area — GPU-side visibility, zero CPU sync (the Task-193
  //    bit-discard pattern, GL-shaped: drawIndexedIndirect does not exist
  //    in WebGL2).
  const COLOR_VS = `#version 300 es
layout(location=0) in vec3 a_corner;
layout(location=1) in vec3 a_c;
layout(location=2) in vec3 a_h;
layout(location=3) in vec3 a_col;
layout(location=4) in float a_flag; // the TF-written verdict, per instance
uniform mat4 u_mvp;
out vec3 v_world;
out vec3 v_color;
void main() {
  if (a_flag != 1.0 && a_flag != 4.0) {
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
}`
  const COLOR_FS = `#version 300 es
precision highp float;
in vec3 v_world;
in vec3 v_color;
uniform vec3 u_light;
uniform vec3 u_cam;
out vec4 o;
void main() {
  // flat per-triangle normal from screen-space derivatives — the same
  // trick as the WG tier (no normals in the records). THE Y-FLIP: GL
  // fragment coordinates grow y UP, WGSL @builtin(position).y grows y
  // DOWN — dFdy is the derivative along OPPOSITE screen directions, and
  // an un-flipped cross() inverts the normal → the same face lights on
  // one backend and shades on the other (intra-tier parity holds either
  // way — only the cross-tier image gate sees it). Negating dFdy matches
  // the WG image.
  vec3 n = normalize(cross(dFdx(v_world), -dFdy(v_world)));
  float l = max(dot(n, normalize(u_light)), 0.0);
  float dist = distance(v_world, u_cam);
  float fog = smoothstep(70.0, 200.0, dist);
  vec3 col = v_color * (0.35 + 0.65 * l);
  col = mix(col, vec3(0.045, 0.055, 0.09), fog);
  o = vec4(col, 1.0);
}`

  // 5. the pyramid debug strip: one quad per level, texelFetch of that
  //    level's texture (bright = near).
  const PANEL_VS = `#version 300 es
layout(location=0) in vec2 a_q;
uniform vec4 u_rect;
out vec2 v_uv;
void main() {
  float x = mix(u_rect.x, u_rect.z, a_q.x * 0.5 + 0.5);
  float y = mix(u_rect.y, u_rect.w, a_q.y * 0.5 + 0.5);
  gl_Position = vec4(x, y, 0.0, 1.0);
  v_uv = a_q * 0.5 + 0.5;
}`
  const PANEL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_pyr;
uniform vec2 u_wh;
out vec4 o;
void main() {
  ivec2 t = ivec2(min(v_uv * u_wh, u_wh - 1.0));
  float z = texelFetch(u_pyr, t, 0).r;
  float v = clamp(1.0 - z, 0.0, 1.0); // tile-max: sky (1.0) renders black
  o = vec4(v * 0.9, v * 0.75, v * 0.55 + 0.1, 1.0);
}`

  const zProg = gl.createProgram(Z_VS, Z_FS)
  const reduceProg = gl.createProgram(REDUCE_VS, REDUCE_FS)
  const colorProg = gl.createProgram(COLOR_VS, COLOR_FS)
  const panelProg = gl.createProgram(PANEL_VS, PANEL_FS)

  // the cull TF pass: N vertices (gl_VertexID = the record), attributes
  // per-vertex (the points draw), the pyramid's LEVELS textures bound as
  // the sampler array, the packed uniform block (mvp columns + misc + dims).
  const CULL_UNIFORMS = [
    { name: 'u_mvp[0]', size: 4 }, { name: 'u_mvp[1]', size: 4 },
    { name: 'u_mvp[2]', size: 4 }, { name: 'u_mvp[3]', size: 4 },
    { name: 'u_misc', size: 4 }, { name: 'u_dims', size: 4 },
  ]
  const cullPass = gl.createTransformPass({
    vertex: CULL_GLSL,
    outputs: ['v_flag'],
    attributes: [
      { name: 'a_c', size: 3, stride: 48, offset: 0 },
      { name: 'a_h', size: 3, stride: 48, offset: 12 },
    ],
    textures: Array.from({ length: LEVELS }, (_, L) => `u_pyr[${L}]`),
    uniforms: CULL_UNIFORMS,
  })
  const cullU = new Float32Array(24)

  // ── the validation surface: depth24 (the WG surface's depth24plus twin —
  //    the cross-tier hash gate rides the same precision), ladder to 16.
  let surface = null
  let surfaceBits = null
  for (const bits of [24, 16]) {
    try {
      surface = renderer.surface({ width: 480, height: 270, depth: true, color: SKY, depthBits: bits })
      surfaceBits = bits
      break
    } catch { /* try the next rung */ }
  }
  if (surface === null) throw new Error('rune: the GL validation surface could not attach a depth renderbuffer')

  // the reduce pass uniform data (per level): (wIn, hIn, 0, 0)
  const reduceDims = []
  for (let L = 1; L < LEVELS; L++) {
    const wi = LEVEL_DIMS[L - 1]
    reduceDims.push(new Float32Array([wi.w, wi.h, 0, 0]))
  }
  // the panel rects + sizes
  const panelRects = []
  const panelWh = []
  for (let L = 0; L < LEVELS; L++) {
    const w = 2.0 / LEVELS
    panelRects.push(new Float32Array([-1 + L * w + 0.01, -0.97, -1 + (L + 1) * w - 0.01, -0.55]))
    panelWh.push(new Float32Array([LEVEL_DIMS[L].w, LEVEL_DIMS[L].h]))
  }

  // ── THE FRAME ────────────────────────────────────────────────────────────
  function renderTo(targetId, mvp, eye, hizOn, debug) {
    // 1. THE Z PREPASS — occluders into the r32f tile (nearest-z wins)
    gl.bindTarget(zTargetId, true)
    gl.setDepthMode('less', true)
    gl.setCull('none')
    gl.useProgram(zProg)
    gl.setUniformMatrix4(zProg, 'u_mvp', mvp)
    gl.bindVertexBuffer(boxBuf, 0, 3)
    gl.bindVertexBuffer(sceneBuf, 1, 3, 48, 0, 1)
    gl.bindVertexBuffer(sceneBuf, 2, 3, 48, 12, 1)
    gl.drawElements(boxIb, 36, K, true)
    // 2. THE PYRAMID — 2×2 MAX per level, fullscreen quads into each
    //    level's r32f target
    gl.useProgram(reduceProg)
    gl.setUniform1i(reduceProg, 'u_src', 0)
    gl.setDepthMode('always', false)
    gl.bindVertexBuffer(quadBuf, 0, 2)
    for (let L = 1; L < LEVELS; L++) {
      gl.bindTarget(pyrTarget[L - 1], true)
      gl.bindTexture(pyrTex[L - 1], 0)
      gl.setUniform4fv(reduceProg, 'u_dims', reduceDims[L - 1])
      gl.drawArrays('triangle-strip', 0, 4, 1)
    }
    // 3. THE CULL — one TF pass over N records → the verdict flags.
    //    THE NEUTRAL TARGET FIRST (the feedback-loop lesson): after the
    //    reduce loop the CURRENT FBO is the last pyramid target — its
    //    attachment (pyrTex[9]) is about to be bound to a sampler unit by
    //    the pass's texture bindings, and WebGL2 silently drops a draw
    //    whose sampler set overlaps the current framebuffer's attachments
    //    (the TF captured NOTHING, zero GL errors in the page's drain
    //    cadence — exactly this bug). The canvas (the default framebuffer,
    //    NO texture attachments) is the neutral, loop-free vantage.
    gl.bindTarget(0, false)
    cullU.set(mvp, 0)
    cullU[16] = hizOn ? 1 : 0; cullU[17] = K; cullU[18] = 0; cullU[19] = 0
    cullU[20] = HIZ_W; cullU[21] = HIZ_H; cullU[22] = MAX_LEVEL; cullU[23] = N
    gl.runTransformPass(cullPass, N, {
      bufferId: flagBuf,
      attribBuffers: [sceneBuf, sceneBuf],
      textures: pyrTex,
      uniformData: cullU,
    })
    // 4. THE COLOR PASS — ONE instanced draw, the vertex shader collapses
    //    the invisible instances (flag ∉ {1,4})
    if (targetId === 0) {
      gl.bindTarget(0, false)
      gl.clear(SKY, 1) // the GL facade's canvas bind does not clear — explicit
    } else {
      gl.bindTarget(targetId, true)
    }
    gl.setDepthMode('less', true)
    gl.useProgram(colorProg)
    gl.setUniformMatrix4(colorProg, 'u_mvp', mvp)
    gl.setUniform3fv(colorProg, 'u_light', lightArr)
    camArr[0] = eye[0]; camArr[1] = eye[1]; camArr[2] = eye[2]
    gl.setUniform3fv(colorProg, 'u_cam', camArr)
    gl.bindVertexBuffer(boxBuf, 0, 3)
    gl.bindVertexBuffer(sceneBuf, 1, 3, 48, 0, 1)
    gl.bindVertexBuffer(sceneBuf, 2, 3, 48, 12, 1)
    gl.bindVertexBuffer(sceneBuf, 3, 3, 48, 24, 1)
    gl.bindVertexBuffer(flagBuf, 4, 1, 4, 0, 1)
    gl.drawElements(boxIb, 36, N, true)
    if (debug) {
      gl.setDepthMode('always', false)
      gl.useProgram(panelProg)
      gl.setUniform1i(panelProg, 'u_pyr', 0)
      gl.bindVertexBuffer(quadBuf, 0, 2)
      for (let L = 0; L < LEVELS; L++) {
        gl.bindTexture(pyrTex[L], 0)
        gl.setUniform4fv(panelProg, 'u_rect', panelRects[L])
        gl.setUniform2fv(panelProg, 'u_wh', panelWh[L])
        gl.drawArrays('triangle-strip', 0, 4, 1)
      }
    }
  }

  function frame(mvp, eye, hizOn, debug) {
    renderTo(0, mvp, eye, hizOn, debug)
  }

  // ── stats readback (synchronous readBuffer — the GL tier's honest cost:
  //    a CPU stall, throttled by the caller; the WG tier reads async) ──────
  const flagScratch = new Float32Array(N)
  const lightArr = new Float32Array(LIGHT)
  const camArr = new Float32Array(3)
  function readStats() {
    const ok = gl.readBuffer(flagBuf, flagScratch)
    if (!ok) throw new Error('rune: the flag buffer readback was refused')
    let drawn = 0, frustum = 0, occluded = 0, straddle = 0
    // the first K flags are the occluders (always 1 — drawn unconditionally,
    // the WG tier's separate classic draw): the accounting invariant counts
    // OCCLUDEES only, so the occluder lane is skipped here.
    for (let i = K; i < N; i++) {
      const f = flagScratch[i]
      if (f === 1) drawn++
      else if (f === 2) frustum++
      else if (f === 3) occluded++
      else if (f === 4) { straddle++; drawn++ }
    }
    return { drawn, frustum, occluded, straddle, indirectCount: 0 }
  }

  if (typeof window !== 'undefined') {
    window.__hizDebug = { note: 'the WebGL2 tier is active — the WG diagnostics channel (pyramid/ztile/diff/trace) is WebGPU-only; reload without ?mode=webgl2' }
  }

  return {
    mode: 'webgl2',
    kind: PROBE ? 'probe' : 'live',
    tierLine: `WebGL2 — FBO pyramid + TF cull + vertex-collapse draw (z-depth ${zDepthBits === 32 ? '32f' : zDepthBits}, surface d${surfaceBits})`,
    drawsLine: `draws: 2 + ${LEVELS - 1} reduce quads · TF passes: 1 (cull, ${N} verts)`,
    canvas,
    surface,
    renderTo,
    frame,
    readStats,
    /** The GL error drain — the renderer's frame boundary (drainGlErrors);
     *  the tier's own loop calls it through frameBoundary(). */
    drain(nowMs) {
      try { renderer.step(nowMs) } catch { /* the frame-error path already went through onGlError */ }
    },
    dispose() {
      try { renderer.dispose() } catch { /* already dead */ }
      if (canvas.parentElement === stage) canvas.remove()
      if (typeof window !== 'undefined') window.__hizDebug = undefined
    },
  }
}
