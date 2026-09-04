// "vfx" demo — the game-VFX study: 24 demos on @rune/particles + the rune
//   renderer, one page with a carousel (◀ ▶ through the set).
//
// The library surface this page exercises end to end:
//   shapes (hemisphere/donut/rectangle/grid/path + the classics), the
//   image seek targets, the burst schedule with cycle/interval/probability,
//   prewarm, the live emitter origin at() + orient(), the billboard modes
//   (vertical/horizontal/stretched/oriented), the ATLAS (tiles + the ramp
//   frame channel — FrameOverLife), TRAILS, MESH particles with lit
//   materials, the forces (collision planes, simplex noise, the seek
//   spring, SpeedOverLife), onRetire (sub emitters), the custom BLEND
//   EQUATIONS (add/max/subtract/reverse-subtract) + the SOFT_PARTICLES
//   depth fade (a color-encoded depth prepass) + the GPU-static grass
//   field.
//
// EVERY sprite on this page is OURS — generated in this file (deterministic
// pure functions → raw RGBA uploads; no image assets, no browser
// premultiply semantics). The dist imports carry ?v=131 (the stale-cache
// guard — bump on release; Task 130 changed @rune/particles: the line lattice).
import { createRenderer, capsule, cube, plane, sphere, torusKnot } from '../../dist/rune.esm.js?v=131'
import {
  materialOf, TEXTURE, VERTEX_COLOR, ALPHA_CUTOFF, LAMBERT, FLAT_ALBEDO,
  DOUBLE_SIDED, PBR, pbrMask, SOFT_PARTICLES, PBR_ENV, OUTPUT_DITHER, BILLBOARD,
} from '../../dist/rune-materials.esm.js?v=131'
import { createParticles, createRamp, createSpawner, createGrassField } from '../../dist/rune-particles.esm.js?v=131'

/* ─── the demo registry (the carousel order) ────────────────────────────── */

import muzzle from './demos/muzzle.js'
import explosion from './demos/explosion.js'
import shapes from './demos/shapes.js'
import trail from './demos/trail.js'
import sequencer from './demos/sequencer.js'
import mesh from './demos/mesh.js'
import subemitter from './demos/subemitter.js'
import noise from './demos/noise.js'
import alphatest from './demos/alphatest.js'
import plugin from './demos/plugin.js'
import billboard from './demos/billboard.js'
import soft from './demos/soft.js'
import blending from './demos/blending.js'
import follow from './demos/follow.js'

// the rune originals #1 (the game-designer set, built on the emitter-motion
// family: inherit velocity, rate over distance, collide kill + splash events)
import rocket from './demos/rocket.js'
import storm from './demos/storm.js'
import slash from './demos/slash.js'
import vortex from './demos/vortex.js'
import fireflies from './demos/fireflies.js'

// the rune originals #2 (the GPU-static grass field, the endless wrapped
// dust, the procedural lightning bolts, the cutting laser)
import dust from './demos/dust.js'
import grass from './demos/grass.js'
import lightning from './demos/lightning.js'
import laser from './demos/laser.js'
import gpuEmbers from './demos/gpuEmbers.js'

const DEMOS = [muzzle, explosion, shapes, trail, sequencer, mesh, subemitter,
  noise, alphatest, plugin, billboard, soft, blending, follow,
  rocket, storm, slash, vortex, fireflies, dust, grass, lightning, laser, gpuEmbers]

/* ─── materials & pipelines ────────────────────────────────────────────── */

const SPRITE_MATERIAL = materialOf({ features: TEXTURE | VERTEX_COLOR })
// Task 131 — the INSTANCED-SPRITE twins: the same sprite family + the
// BILLBOARD vertex stage — the material's shader expands the quad on the
// GPU from the facade's 16-float instance records (render.draw:'instance').
// Every billboard layer of this page moves to these; the soup twins stay
// for the trail/mesh kinds and the library's LCD contract.
const BB_SPRITE_MATERIAL = materialOf({ features: TEXTURE | VERTEX_COLOR | BILLBOARD })
const BB_HAZE_MATERIAL = materialOf({ features: TEXTURE | VERTEX_COLOR | BILLBOARD | OUTPUT_DITHER })
const BB_LEAF_MATERIAL = materialOf({ features: TEXTURE | VERTEX_COLOR | BILLBOARD | ALPHA_CUTOFF })
const BB_SOFT_MATERIAL = materialOf({ features: TEXTURE | VERTEX_COLOR | BILLBOARD | SOFT_PARTICLES })
// the TRANSLUCENT-SPRITE material (the alpha-blended smokes and haze cards
// on the page): the sprite material + the OUTPUT_DITHER bit — now TWO-SIDED
// (Task 128): the ±0.5/255 rgb noise of Task 127 PLUS a 4×4 ordered Bayer
// dither on the OUTPUT ALPHA (±1.5/255). The alpha half is what kills the
// "transparency staircase": every blend rounds the destination to 8 bits,
// and a smooth low-alpha ramp crossing the quantization steps printed
// visible bands — jittering the source alpha decorrelates the per-pixel
// rounding and the steps average into smooth gradients.
const HAZE_MATERIAL = materialOf({ features: TEXTURE | VERTEX_COLOR | OUTPUT_DITHER })
// Task 126 — the LEAF MESH material (the alphatest demo's real 3D leaves):
// lit + alpha MASK + double-sided (their leave.glb material: alphaMode
// MASK @ 0.88, doubleSided, metallic 0)
const LEAF_LIT_MATERIAL = materialOf({ features: TEXTURE | VERTEX_COLOR | ALPHA_CUTOFF | LAMBERT | DOUBLE_SIDED })
const LEAF_MATERIAL = materialOf({ features: TEXTURE | VERTEX_COLOR | ALPHA_CUTOFF })
const SOFT_MATERIAL = materialOf({ features: TEXTURE | VERTEX_COLOR | SOFT_PARTICLES })
const LAMBERT_MATERIAL = materialOf({ features: FLAT_ALBEDO | LAMBERT | DOUBLE_SIDED })
// PBR mesh particles: the per-particle tint travels through the soup's
// VERTEX_COLOR (FLAT_ALBEDO would need a u_albedo uniform — the soup tint
// is the point of per-particle color). PBR_ENV — the analytic studio
// environment that makes metallic=1 read as metal (their envMap's stand-in).
const PBR_MATERIAL = materialOf({ features: pbrMask() | FLAT_ALBEDO | VERTEX_COLOR | PBR_ENV })

const ADDITIVE = { depth: { test: 'less', write: false }, raster: { cull: 'none' }, blend: { src: 'src-alpha', dst: 'one' } }
const ALPHA = { depth: { test: 'less', write: false }, raster: { cull: 'none' }, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' } }
// the custom equations (One/One × Add/Max/Subtract — the blend-equation
// study). THE DIRECTIONS, measured on real hardware per backend
// (scripts/blend-probe.mjs + demo/particles/blend-probe-raw.html):
// 'subtract' = src − dst on BOTH backends (GL FUNC_SUBTRACT = WebGPU
// 'subtract' — full parity); the INTUITIVE "the sprite subtracts light
// from the scene" dark bite is 'reverse-subtract' = dst − src — that is
// what this pipeline asks for (src − dst over a dark floor reads as a
// bright core with hard black edges — technically faithful to the raw
// equation, visually just confusing).
const ONE_ADD = { depth: { test: 'less', write: false }, raster: { cull: 'none' }, blend: { src: 'one', dst: 'one', equation: 'add' } }
const ONE_MAX = { depth: { test: 'less', write: false }, raster: { cull: 'none' }, blend: { src: 'one', dst: 'one', equation: 'max' } }
const ONE_SUBTRACT = { depth: { test: 'less', write: false }, raster: { cull: 'none' }, blend: { src: 'one', dst: 'one', equation: 'reverse-subtract' } }
// Opaque scene meshes (the floor, the follow box, the soft-demo blobs).
const OPAQUE = { depth: { test: 'less', write: true }, raster: { cull: 'back' } }

/* ─── the procedural sprite atlas (4×4 tiles, 64 px each) ─────────────── */

const ATLAS_SIZE = 256
const TILE = 64

// Deterministic, pure-function tiles — no canvas, no ImageBitmap, no
// browser premultiply semantics (the Task 118 lesson): explicit RGBA bytes
// through texture.upload(). Straight alpha by construction.
function makeAtlasBytes() {
  const bytes = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4)
  const put = (tile, fn) => {
    const ox = (tile % 4) * TILE, oy = Math.floor(tile / 4) * TILE
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const u = (x + 0.5) / TILE - 0.5, v = (y + 0.5) / TILE - 0.5
        const [r, g, b, a] = fn(u, v, Math.hypot(u, v))
        // THE UNIVERSAL EDGE GUARD (Task 128 — the "quad boundaries every-
        // where" report): a tile that still carries non-zero alpha at its
        // border draws the QUAD's silhouette into the scene (the visible
        // square edge — THE most common sprite bug on this page) and bleeds
        // into its atlas neighbors under bilinear filtering. Every tile's
        // alpha is now faded to zero over the last 0.1 of u/v — a rounded-
        // square window with a margin wider than the bilinear kernel; the
        // shapes below all live inside it (the arrow/leaf were shrunk to
        // fit). Border pixels ≈ 0, no square edges, no cross-tile bleed —
        // for EVERY sprite on the page, by construction.
        // Task 129 — the guard covers RGB TOO: the live "the turret fire
        // shows its texture borders as a highlighted line" report is the
        // bilinear mixing at a shared border landing on (127,127,127,127)
        // when one side carries white-rgb/zero-alpha and the other zero-
        // rgb/white-alpha — a gray line that GLOWS under additive. Fading
        // both channels makes every mixed sample black, whatever blend
        // mode reads the tile. (The interior keeps the solid-white spark
        // convention — only the outer strip fades.)
        const guard = Math.min(1, Math.max(0, Math.min((0.5 - Math.abs(u)) / 0.1, (0.5 - Math.abs(v)) / 0.1)))
        const i = ((oy + y) * ATLAS_SIZE + ox + x) * 4
        bytes[i] = Math.round(r * guard); bytes[i + 1] = Math.round(g * guard)
        bytes[i + 2] = Math.round(b * guard); bytes[i + 3] = Math.round(a * guard)
      }
    }
  }
  const R = 255
  // 0: the classic soft glow (gaussian)
  put(0, (u, v, r) => [R, R, R, r >= 0.5 ? 0 : Math.round(255 * Math.exp(-5 * r * r / 0.25))])
  // 1: the tight spark core
  put(1, (u, v, r) => [R, R, R, r >= 0.5 ? 0 : Math.round(255 * Math.exp(-14 * r * r / 0.25))])
  // 2: the streak (a horizontal gradient — stretched billboards)
  put(2, (u, v) => [R, R, R, Math.round(255 * Math.max(0, 1 - Math.abs(v) * 5.5) * (1 - Math.abs(u) * 0.6))])
  // 3: the wide puff
  put(3, (u, v, r) => [R, R, R, r >= 0.5 ? 0 : Math.round(255 * Math.exp(-2.6 * r * r / 0.25))])
  // 4: the flash star (a gaussian + an anamorphic cross)
  put(4, (u, v, r) => {
    const core = r >= 0.5 ? 0 : Math.exp(-7 * r * r / 0.25)
    // the cross fades smoothly to its rim (the old hard r<0.48 cut left a
    // visible circular edge on every flash)
    const cross = Math.max(Math.exp(-90 * v * v), Math.exp(-90 * u * u)) * Math.max(0, 1 - Math.max(0, (r - 0.34) / 0.12))
    return [R, R, R, Math.min(255, Math.round(255 * (core + cross * 0.85)))]
  })
  // 5: the ring (a SOFT annulus + a faint filled interior — reads as a water
  // ripple at rest and a shockwave in motion; the old σ=0.08 wireframe ring
  // looked like a decal; the rim now fades before the tile edge — the
  // hard 0.33-alpha at the border drew the quad's square corners)
  put(5, (u, v, r) => {
    const ring = Math.exp(-Math.pow((r - 0.3) / 0.13, 2))
    const fill = r < 0.3 ? 0.32 * (1 - r / 0.3) : 0
    return [R, R, R, Math.round(255 * Math.min(1, ring + fill))]
  })
  // 6: the smoke puff (a blobby lobe — three offset gaussians)
  put(6, (u, v) => {
    const lobes = [[-0.13, 0.08, 0.16], [0.11, -0.05, 0.2], [0.02, 0.13, 0.13]]
    let a = 0
    for (const [lx, ly, lr] of lobes) {
      const dx = u - lx, dy = v - ly
      a += Math.exp(-(dx * dx + dy * dy) / (lr * lr))
    }
    return [R, R, R, Math.min(255, Math.round(215 * a))]
  })
  // 7: the arrow (a triangle pointing UP — the billboard-mode demo; the
  // base sits at v=-0.38 so the shape clears the edge guard's fade zone)
  put(7, (u, v) => {
    const inside = Math.abs(u) < (0.38 - v) * 0.58 && v < 0.26 && v > -0.38
    const soft = Math.abs(u) < (0.38 - v) * 0.58 + 0.03 && v < 0.29 && v > -0.41
    const a = inside ? 255 : soft ? 90 : 0
    return [R, R, R, a]
  })
  // 8: the leaf silhouette (an ellipse + a stem, the alpha-test demo;
  // sized to clear the edge guard — the old stem tip touched the border)
  put(8, (u, v) => {
    const ex = u / 0.4, ey = (v + 0.08) / 0.46
    const leaf = ex * ex + ey * ey < 1
    const stem = Math.abs(u) < 0.03 && v > 0.08 && v < 0.36
    const a = leaf || stem ? 255 : 0
    return [Math.round(190 + 40 * (0.5 - v)), R, Math.round(90 * (v + 0.5) + 30), a]
  })
  // 9: the bubble (a hard disc with a bright rim; sized inside the guard)
  put(9, (u, v, r) => {
    const disc = r < 0.38
    const rim = Math.exp(-Math.pow((r - 0.33) / 0.06, 2))
    const hi = Math.exp(-(((u + 0.14) ** 2 + (v - 0.14) ** 2)) / 0.01)
    const a = disc ? 130 : rim > 0.25 ? 220 : 0
    const bright = Math.min(255, Math.round(150 + 105 * (rim + hi)))
    return [bright, bright, bright, a]
  })
  // 10: the droplet (a small soft ellipse)
  put(10, (u, v) => {
    const ex = u / 0.24, ey = v / 0.34
    const a = ex * ex + ey * ey < 1 ? Math.round(220 * (1 - Math.sqrt(ex * ex + ey * ey) * 0.6)) : 0
    return [R, R, R, a]
  })
  // 11: the sparkle (thin four-ray star)
  put(11, (u, v) => {
    const rays = Math.max(Math.exp(-120 * v * v) * Math.exp(-14 * Math.abs(u)),
      Math.exp(-120 * u * u) * Math.exp(-14 * Math.abs(v)))
    return [R, R, R, Math.round(255 * rays)]
  })
  // 12: the snow flake (six rays)
  put(12, (u, v) => {
    const a = Math.atan2(v, u)
    let ray = 0
    for (let k = 0; k < 6; k++) {
      const ang = a - k * Math.PI / 3
      ray = Math.max(ray, Math.exp(-30 * Math.abs(Math.sin(ang)) ** 2) * Math.exp(-5 * Math.abs(Math.hypot(u, v))))
    }
    return [R, R, R, Math.round(255 * Math.min(1, ray))]
  })
  // 13: the rounded square glow (kept INSIDE the guard — reads as a soft
  // rounded-square patch, no hard rim)
  put(13, (u, v) => {
    const d = Math.max(Math.abs(u), Math.abs(v))
    return [R, R, R, Math.round(255 * Math.max(0, Math.exp(-Math.pow((d - 0.26) / 0.13, 2))))]
  })
  // 14: the noise puff (a hash-jittered blob — the soft demo smoke)
  put(14, (u, v) => {
    let a = 0
    for (let k = 0; k < 5; k++) {
      const ang = k * 1.256
      const lx = Math.cos(ang) * 0.12, ly = Math.sin(ang) * 0.1
      a += Math.exp(-(((u - lx) ** 2 + (v - ly) ** 2) / 0.05))
    }
    return [R, R, R, Math.min(255, Math.round(160 * a))]
  })
  // 15: the hard dot (a small solid disc)
  put(15, (u, v, r) => [R, R, R, r < 0.3 ? 255 : r < 0.34 ? 120 : 0])
  return bytes
}

/* ─── Mat4 scratch + helpers (the particles demo's formulas) ───────────── */

// The single-glow sprite for the RIBBON layers (the trail demo): the
// ribbons sample the FULL texture (u along the length, v across the
// width), so the 4×4 atlas would print a grid of glows into every
// segment — this is one clean gaussian, 64×64, straight alpha by
// construction.
function makeGlowBytes() {
  const bytes = new Uint8Array(64 * 64 * 4)
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const u = (x + 0.5) / 64 - 0.5, v = (y + 0.5) / 64 - 0.5
      const r = Math.hypot(u, v)
      const a = r >= 0.5 ? 0 : Math.round(255 * Math.exp(-5 * r * r / 0.25))
      const i = (y * 64 + x) * 4
      bytes[i] = 255; bytes[i + 1] = 255; bytes[i + 2] = 255; bytes[i + 3] = a
    }
  }
  return bytes
}

/* ─── The ribbon texture (the weapon-arc streak) ───────────────────

   fillTrails maps u along the ribbon's LENGTH and v across its WIDTH —
   a radial glow (the 64×64 sprite) fades to black at every edge: the
   ribbon reads as a blob in its middle, not an ARC. This is a STREAK:
   bright along the whole u axis, a gaussian falloff across v (64×16,
   straight alpha by construction — rgb = white·alpha so additive AND
   alpha blend both work). */
function makeRibbonBytes() {
  const W = 64, H = 16
  const bytes = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = (y + 0.5) / H - 0.5
      const a = Math.exp(-(v * v) / 0.018)
      const i = (y * W + x) * 4
      bytes[i] = bytes[i + 1] = bytes[i + 2] = Math.round(255 * a)
      bytes[i + 3] = 255
    }
  }
  return bytes
}


/* ─── The dedicated VFX sprites (one purpose, one texture, no atlas bleed) ───
   The 4×4 atlas below serves the generic tiles, but the hero systems get
   DEDICATED textures: an atlas tile with non-zero alpha at its border
   BLEEDS into its neighbors under bilinear filtering — the visible
   "square edge" class. Each generator below keeps alpha strictly zero
   near every border (a margin wider than the bilinear kernel). */

/** A tiny deterministic value noise (bilinear-smooth, two octaves at the
 *  call site) — gives the procedural sprites their organic erosion. */
const vnoise = (x, y, seed) => {
  const h2 = (xi, yi) => {
    const v = Math.sin(xi * 127.1 + yi * 311.7 + seed * 74.7) * 43758.5453
    return v - Math.floor(v)
  }
  const xi = Math.floor(x), yi = Math.floor(y)
  const xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  return h2(xi, yi) * (1 - u) * (1 - v) + h2(xi + 1, yi) * u * (1 - v)
    + h2(xi, yi + 1) * (1 - u) * v + h2(xi + 1, yi + 1) * u * v
}

/* The SPARK (128×32): the dual-mode comet streak for stretched quads —
   a bright head at u=0 tapering along the length, a gaussian across, the
   tail pinching thin. rgb = SOLID WHITE, alpha = profile (the brightest
   dual-mode convention: an alpha-blend composites white·profile over the
   scene — a luminous streak, not a gray one; an additive pass adds
   white·profile — linear in the falloff. A white·profile rgb would have
   squared the falloff in alpha blends and read as faint gray drizzle —
   the "rainstorm nearly black" lesson). */
const SPARK_W = 128, SPARK_H = 32
function makeSparkBytes() {
  const bytes = new Uint8Array(SPARK_W * SPARK_H * 4)
  for (let y = 0; y < SPARK_H; y++) {
    for (let x = 0; x < SPARK_W; x++) {
      const u = (x + 0.5) / SPARK_W, v = (y + 0.5) / SPARK_H - 0.5
      const along = Math.pow(1 - u, 1.35) * (u < 0.985 ? 1 : 0)
      const sigma = 0.14 + 0.06 * u // the tail is slightly thinner
      const across = Math.exp(-(v * v) / (2 * sigma * sigma))
      // a faint hot core near the head
      const core = u < 0.3 ? Math.exp(-(v * v) / 0.004) * (1 - u / 0.3) * 0.7 : 0
      const a = Math.min(1, along * across + core)
      const i = (y * SPARK_W + x) * 4
      bytes[i] = bytes[i + 1] = bytes[i + 2] = 255
      bytes[i + 3] = Math.round(255 * a)
    }
  }
  return bytes
}

/* The FLASH (128×128): the impact star — a hot gaussian core, eight
   radial spikes, an anamorphic cross. rgb = white·profile, alpha = 255
   (the additive convention: the contribution IS the profile; the sprite
   never alpha-blends). The cross/rays now fade SMOOTHLY to zero before
   the border (the old hard r<0.46 cut printed a circular rim). */
const FLASH_N = 128
function makeFlashBytes() {
  const bytes = new Uint8Array(FLASH_N * FLASH_N * 4)
  const RAYS = 8
  for (let y = 0; y < FLASH_N; y++) {
    for (let x = 0; x < FLASH_N; x++) {
      const u = (x + 0.5) / FLASH_N - 0.5, v = (y + 0.5) / FLASH_N - 0.5
      const r = Math.hypot(u, v)
      const ang = Math.atan2(v, u)
      const core = r >= 0.5 ? 0 : Math.exp(-(r * r) / 0.016)
      // the shared smooth rim: 1 inside r=0.30, 0 at r=0.47
      const rim = Math.max(0, 1 - Math.max(0, (r - 0.30) / 0.17))
      let ray = 0
      for (let k = 0; k < RAYS; k++) {
        const d = Math.abs(Math.sin(ang - k * Math.PI / RAYS))
        const rayLen = 0.42 - (k % 2) * 0.1 // alternating long/short spikes
        if (r < rayLen) ray = Math.max(ray, Math.exp(-70 * d * d) * (1 - r / rayLen))
      }
      const cross = Math.max(Math.exp(-140 * v * v), Math.exp(-140 * u * u)) * rim * 0.55
      const a = Math.min(1, core + ray * rim + cross)
      const i = (y * FLASH_N + x) * 4
      bytes[i] = bytes[i + 1] = bytes[i + 2] = Math.round(255 * a)
      bytes[i + 3] = 255
    }
  }
  return bytes
}

/* The SMOKE ATLAS (256×256, 2×2 tiles of 128): four frames of an evolving
   puff — multi-lobe kernels ERODED by value noise (the smoke has visible
   STRUCTURE, not a uniform blur), each frame's lobes drifting wider and
   dimmer (the FrameOverLife animation). THE EDGE (Task 128 — the "visible
   quad boundaries" report): the old margin was a BOX ramp (min over the
   four border distances) — a literally square fade whose silhouette read
   as the quad's outline at full alpha cores. The edge is now a RADIAL
   falloff: full inside r=0.30, zero at r=0.47 — a round, smooth silhouette
   with a bilinear-safe margin (no cross-frame bleed either). rgb = white,
   alpha = profile — the alpha-blend convention (smoke is never additive). */
const SMOKE_ATLAS_N = 256, SMOKE_TILE = 128
function makeSmokeAtlasBytes() {
  const bytes = new Uint8Array(SMOKE_ATLAS_N * SMOKE_ATLAS_N * 4)
  // Task 129 — the FULL border guard (rgb AND alpha): smoke keeps SOLID
  // WHITE rgb (the alpha-blend convention), but a shared-border bilinear
  // mix of white-rgb with an adjacent tile's alpha payload lands on a
  // visible gray line under any additive reader. The outer strip of every
  // frame fades BOTH channels to black — cross-frame mixes are black by
  // construction.
  const borderGuard = (tu, tv) =>
    Math.min(1, Math.max(0, Math.min((0.5 - Math.abs(tu)) / 0.09, (0.5 - Math.abs(tv)) / 0.09)))
  for (let f = 0; f < 4; f++) {
    const ox = (f % 2) * SMOKE_TILE, oy = Math.floor(f / 2) * SMOKE_TILE
    // the lobes widen + fade as the frame advances (the puff ages)
    const spread = 1 + f * 0.22
    const gain = 1 - f * 0.16
    const lobes = [
      [-0.12 * spread, 0.06, 0.15 * spread],
      [0.1 * spread, -0.04, 0.18 * spread],
      [0.02, 0.12 * spread, 0.12 * spread],
      [-0.05, -0.1 * spread, 0.13 * spread],
    ]
    for (let y = 0; y < SMOKE_TILE; y++) {
      for (let x = 0; x < SMOKE_TILE; x++) {
        const tu = (x + 0.5) / SMOKE_TILE - 0.5, tv = (y + 0.5) / SMOKE_TILE - 0.5
        let k = 0
        for (const [lx, ly, lr] of lobes) {
          const dx = tu - lx, dy = tv - ly
          k += Math.exp(-(dx * dx + dy * dy) / (lr * lr))
        }
        // the erosion: two noise octaves modulate the density
        const n = vnoise(tu * 7 + 31, tv * 7 + 17, 3 + f) * 0.6
          + vnoise(tu * 15 + 7, tv * 15 + 53, 9 + f) * 0.4
        const erode = 0.62 + 0.38 * n * 2 // strong structure, not flat fog
        // THE RADIAL EDGE: 1 inside r=0.30 → 0 at r=0.47 (round silhouette,
        // zero well before the border — no square rim, no bilinear bleed)
        const r = Math.hypot(tu, tv)
        const edge = Math.max(0, 1 - Math.max(0, (r - 0.3) / 0.17))
        const a = Math.min(1, Math.max(0, k * gain * erode)) * edge
        const i = ((oy + y) * SMOKE_ATLAS_N + ox + x) * 4
        const guard = borderGuard(tu, tv)
        const w = Math.round(255 * guard)
        bytes[i] = bytes[i + 1] = bytes[i + 2] = w
        bytes[i + 3] = Math.round(255 * a * guard)
      }
    }
  }
  return bytes
}

/* The HAZE card (128×128): the fog layer's soft irregular cloud — three
   noise-eroded lobes, alpha strictly ZERO past r = 0.4 (the old atlas
   puff bled at its tile seam and drew a visible SQUARE rim on every
   card; the smooth single-lobe falloff at ~5% alpha read as flat banding
   ramps). rgb = white, alpha = profile. */
const HAZE_N = 128
function makeHazeBytes() {
  const bytes = new Uint8Array(HAZE_N * HAZE_N * 4)
  const lobes = [[-0.1, 0.07, 0.17], [0.09, -0.05, 0.2], [0.02, 0.11, 0.14]]
  for (let y = 0; y < HAZE_N; y++) {
    for (let x = 0; x < HAZE_N; x++) {
      const u = (x + 0.5) / HAZE_N - 0.5, v = (y + 0.5) / HAZE_N - 0.5
      const r = Math.hypot(u, v)
      let k = 0
      for (const [lx, ly, lr] of lobes) {
        const dx = u - lx, dy = v - ly
        k += Math.exp(-(dx * dx + dy * dy) / (lr * lr))
      }
      const n = vnoise(u * 6 + 5, v * 6 + 9, 11) * 0.6 + vnoise(u * 12 + 21, v * 12 + 3, 13) * 0.4
      const edge = 1 - Math.min(1, Math.max(0, (r - 0.28) / 0.12)) // 0 past r=0.4
      const a = Math.min(0.85, k * (0.55 + 0.45 * n)) * edge
      const i = (y * HAZE_N + x) * 4
      bytes[i] = bytes[i + 1] = bytes[i + 2] = 255
      bytes[i + 3] = Math.round(255 * a)
    }
  }
  return bytes
}

/* The MUZZLE SHEET (256×128, 4×2 tiles of 64): the frame-animated muzzle
   flash kit, all our own pixels —
     0: the tight flash star   1: the crossed fins (a 4-point star)
     2: the soft flash blob    3: the horizontal beam streak
     4..7: the smoke frames (evolving, zero-margin like the smoke atlas)
   The additive frames (0–3) use rgb = profile, alpha = 255 (the
   additive convention); the smoke frames use rgb = white, alpha =
   profile. Every frame keeps alpha/rgb strictly dark at its border. */
const MUZZLE_N_W = 256, MUZZLE_N_H = 128, MUZZLE_TILE = 64
function makeMuzzleSheetBytes() {
  const bytes = new Uint8Array(MUZZLE_N_W * MUZZLE_N_H * 4)
  const put = (f, fn) => {
    const ox = (f % 4) * MUZZLE_TILE, oy = Math.floor(f / 4) * MUZZLE_TILE
    for (let y = 0; y < MUZZLE_TILE; y++) {
      for (let x = 0; x < MUZZLE_TILE; x++) {
        const u = (x + 0.5) / MUZZLE_TILE - 0.5, v = (y + 0.5) / MUZZLE_TILE - 0.5
        const [r, g, b, a] = fn(u, v, Math.hypot(u, v), Math.atan2(v, u))
        // Task 129 — THE FULL BORDER GUARD (rgb AND alpha, every frame, BOTH
        // sides of every shared border). THE ROOT of the live report ("the
        // fire at the cannon shows the texture borders, the last pixels
        // read as a highlighted line"): the additive frames carry alpha 255
        // with rgb fading, while their smoke neighbors carry SOLID WHITE rgb
        // with alpha fading — a bilinear sample at the shared border mixes
        // the two and lands on ~(127,127,127,127), a gray line that ADDS
        // onto the scene. Fading both channels over the outer ~0.09 strip
        // makes every mixed sample black: no line, by construction, for
        // every blend mode that reads the sheet.
        const guard = Math.min(1, Math.max(0, Math.min((0.5 - Math.abs(u)) / 0.09, (0.5 - Math.abs(v)) / 0.09)))
        const i = ((oy + y) * MUZZLE_N_W + ox + x) * 4
        bytes[i] = Math.round(r * guard); bytes[i + 1] = Math.round(g * guard)
        bytes[i + 2] = Math.round(b * guard); bytes[i + 3] = Math.round(a * guard)
      }
    }
  }
  const V = 255
  // 0: the tight star (core + 6 short spikes)
  put(0, (u, v, r, ang) => {
    let core = r >= 0.5 ? 0 : Math.exp(-(r * r) / 0.02)
    let ray = 0
    for (let k = 0; k < 6; k++) {
      const d = Math.abs(Math.sin(ang - k * Math.PI / 6))
      if (r < 0.42) ray = Math.max(ray, Math.exp(-90 * d * d) * (1 - r / 0.42))
    }
    const a = Math.min(1, core + ray)
    return [V * a, V * a, V * a, 255]
  })
  // 1: the crossed fins (two orthogonal bars, soft edges — the bar ends
  // fade with the radius now; the old hard r<0.48 cut printed a circular
  // rim around the fins)
  put(1, (u, v, r) => {
    const bar = Math.max(Math.exp(-240 * v * v), Math.exp(-240 * u * u))
    const fade = Math.max(0, 1 - Math.max(0, (r - 0.3) / 0.16))
    const a = Math.min(1, bar * fade)
    return [V * a, V * a, V * a, 255]
  })
  // 2: the soft flash blob (a wide gaussian)
  put(2, (u, v, r) => {
    const a = r >= 0.5 ? 0 : Math.exp(-(r * r) / 0.09)
    return [V * a, V * a, V * a, 255]
  })
  // 3: the horizontal beam (full along u, gaussian across v, ends fade)
  put(3, (u, v) => {
    const endFade = Math.min(1, Math.min(0.5 + u, 0.5 - u) / 0.16)
    const a = Math.exp(-(v * v) / 0.016) * endFade
    return [V * a, V * a, V * a, 255]
  })
  // 4..7: the smoke frames (the smoke atlas recipe, smaller — with the
  // same RADIAL edge: no box silhouette, no cross-tile bleed)
  for (let f = 0; f < 4; f++) {
    const spread = 1 + f * 0.22, gain = 1 - f * 0.16
    const lobes = [[-0.13 * spread, 0.07, 0.16 * spread], [0.11 * spread, -0.05, 0.19 * spread], [0.03, 0.13 * spread, 0.13 * spread]]
    put(4 + f, (u, v) => {
      let k = 0
      for (const [lx, ly, lr] of lobes) {
        const dx = u - lx, dy = v - ly
        k += Math.exp(-(dx * dx + dy * dy) / (lr * lr))
      }
      const n = vnoise(u * 6 + 31, v * 6 + 17, 3 + f) * 0.6 + vnoise(u * 13 + 7, v * 13 + 53, 9 + f) * 0.4
      const r = Math.hypot(u, v)
      const edge = Math.max(0, 1 - Math.max(0, (r - 0.28) / 0.16))
      const a = Math.min(1, Math.max(0, k * gain * (0.62 + 0.76 * n))) * edge
      return [V, V, V, Math.round(255 * a)]
    })
  }
  return bytes
}

const M = () => new Float32Array(16)
const view = M()
const projection = M()
const mvp = M()
const MODEL = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
// The composed MODEL×VIEW×PROJECTION scratch (the scene meshes): the vertex
// shader consumes u_mvp = P·V·M — a `layer.model` alone does NOT move the
// mesh (gl_Position never sees u_model; that matrix only feeds the
// normals/worldPos). Without the composition a "translated" plane renders
// at the ORIGIN and occludes everything behind it.
const MODEL_MVP = M()
const BASIS = { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] }
// The camera orbit target (the follow demo moves it).
const TARGET = [0, 0.2, 0]

function mat4Perspective(out, fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2)
  out.fill(0)
  out[0] = f / aspect
  out[5] = f
  out[10] = far / (near - far)
  out[11] = -1
  out[14] = (far * near) / (near - far)
}

function mat4LookAt(out, ex, ey, ez, cx, cy, cz) {
  let zx = ex - cx, zy = ey - cy, zz = ez - cz
  let l = Math.hypot(zx, zy, zz) || 1
  zx /= l; zy /= l; zz /= l
  let xx = zz, xy = 0, xz = -zx
  l = Math.hypot(xx, xy, xz)
  if (l < 1e-6) { xx = 1; xy = 0; xz = 0; l = 1 }
  xx /= l; xz /= l
  const yx = zy * xz, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0
  out[12] = -(xx * ex + xy * ey + xz * ez)
  out[13] = -(yx * ex + yy * ey + yz * ez)
  out[14] = -(zx * ex + zy * ey + zz * ez)
  out[15] = 1
}

function mat4Multiply(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3]
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
  }
}

/* ─── State ────────────────────────────────────────────────────────────── */

let activeRenderer = null
let bootSeq = 0
let bootedOnce = false // the first successful boot (a re-boot re-makes the demo)
let demoIndex = 0
let state = null          // the current demo's state object
let rhythm = {}           // fresh per demo switch
let atlasTexture = null
let atlasUpload = null
let glowTexture = null // the single-glow ribbon sprite (the trail demo)
let ribbonTexture = null // the weapon-arc streak (the slash ribbon)
let sparkTexture = null // the comet streak (stretched quads)
let flashTexture = null // the impact star
let smokeAtlas = null // the 2×2 frame-animated smoke sheet
let hazeTexture = null // the fog card
let muzzleSheet = null // the 4×2 muzzle-flash kit
let layers = []           // the registered draw layers
let labels = []           // the world-anchored DOM labels
let labelLayer = null
let liveCanvas = null     // the current boot's canvas (the demos read the buffer size)
let cachedAspect = -1
let frameTime = 0

// the camera: orbit angles + distance
let camYaw = 0.55, camPitch = 0.25, camDist = 4.6
let presetOrbit = 0.08
let camTarget = [0, 0.2, 0]
const camEye = [0, 0, 0]
let statsAccum = 0
let dragging = false
let lastInteraction = 0

/* ─── Shell, pill, sheet, arrows ───────────────────────────────────────── */

const MODE_NAMES = { auto: 'Auto (WebGPU → WebGL2 fallback)', webgl2: 'WebGL2', webgpu: 'WebGPU' }

const shell = window.RuneDemoShell.mount({
  layout: 'fullscreen',
  title: 'rune — vfx demos',
  defaults: { mode: 'auto' },
  onMode: (mode) => void boot(mode),
  onPause: () => {
    activeRenderer?.stop()
    shell.log.event('Paused')
  },
  onResume: () => {
    activeRenderer?.start()
    shell.log.event('Resumed')
  },
})

const bar = document.createElement('div')
bar.className = 'pt-bar'
const prevBtn = document.createElement('button')
prevBtn.type = 'button'
prevBtn.className = 'pt-arrow'
prevBtn.textContent = '◀'
prevBtn.setAttribute('aria-label', 'Previous demo')
const pill = document.createElement('button')
pill.type = 'button'
pill.className = 'pt-pill'
pill.addEventListener('click', () => setSheetOpen(true))
const nextBtn = document.createElement('button')
nextBtn.type = 'button'
nextBtn.className = 'pt-arrow'
nextBtn.textContent = '▶'
nextBtn.setAttribute('aria-label', 'Next demo')
bar.append(prevBtn, pill, nextBtn)
prevBtn.addEventListener('click', () => switchDemo((demoIndex + DEMOS.length - 1) % DEMOS.length))
nextBtn.addEventListener('click', () => switchDemo((demoIndex + 1) % DEMOS.length))
bar.hidden = true

const sheet = document.createElement('div')
sheet.className = 'pt-sheet'
const sheetHead = document.createElement('div')
sheetHead.className = 'pt-head'
const sheetTitle = document.createElement('span')
sheetTitle.className = 'pt-title'
sheetTitle.textContent = 'vfx demos'
const sheetClose = document.createElement('button')
sheetClose.type = 'button'
sheetClose.className = 'pt-close'
sheetClose.textContent = '✕'
sheetClose.setAttribute('aria-label', 'Close')
sheetClose.addEventListener('click', () => setSheetOpen(false))
sheetHead.append(sheetTitle, sheetClose)

const rows = document.createElement('div')
rows.className = 'pt-rows'
const rowByIndex = new Map()
DEMOS.forEach((demo, index) => {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'pt-row'
  row.setAttribute('aria-pressed', String(index === demoIndex))
  const main = document.createElement('span')
  main.className = 'pt-main'
  const b = document.createElement('b')
  b.textContent = demo.title
  const sub = document.createElement('span')
  sub.className = 'pt-sub'
  sub.textContent = demo.sub
  main.append(b, sub)
  row.append(main)
  row.addEventListener('click', () => { switchDemo(index); setSheetOpen(false) })
  rows.append(row)
  rowByIndex.set(index, row)
})

const note = document.createElement('div')
note.className = 'pt-note'
note.innerHTML = 'Sim: <code>@rune/particles</code> · 24 demos · every sprite procedural · drag to orbit, pinch to zoom'
sheet.append(sheetHead, rows, note)

const dragHint = document.createElement('div')
dragHint.className = 'pt-hint'
dragHint.textContent = 'drag to orbit · pinch to zoom · ◀ ▶ switch demos'

let sheetOpen = false
function setSheetOpen(open) {
  sheetOpen = open
  sheet[open ? 'removeAttribute' : 'setAttribute']('hidden', '')
}

/* ─── The environment handed to every demo module ─────────────────────── */

const env = {
  renderer: null, // set at boot
  backend: 'auto',
  log: shell.log,
  atlasTexture: null, // set at boot
  atlasTiles: [4, 4],
  // the single-glow ribbon sprite (the trail demo's dedicated texture)
  glowTexture: null, // set at boot
  // the dedicated VFX sprites (generated in THIS file — see the generators):
  sparkTexture: null, // the dual-mode comet streak (stretched quads)
  flashTexture: null, // the impact star (core + spikes + cross)
  smokeAtlas: null, // the 2×2 frame-animated smoke sheet
  smokeAtlasTiles: [2, 2],
  hazeTexture: null, // the fog card (edge-safe, noise-eroded)
  muzzleSheet: null, // the 4×2 muzzle-flash kit
  muzzleTiles: [4, 2],
  materials: {
    sprite: SPRITE_MATERIAL, leaf: LEAF_MATERIAL, leafLit: LEAF_LIT_MATERIAL, soft: SOFT_MATERIAL,
    lambert: LAMBERT_MATERIAL, pbr: PBR_MATERIAL, haze: HAZE_MATERIAL,
    bbSprite: BB_SPRITE_MATERIAL, bbHaze: BB_HAZE_MATERIAL, bbLeaf: BB_LEAF_MATERIAL, bbSoft: BB_SOFT_MATERIAL,
  },
  pipelines: {
    additive: ADDITIVE, alpha: ALPHA,
    oneAdd: ONE_ADD, oneMax: ONE_MAX, oneSubtract: ONE_SUBTRACT,
    opaque: OPAQUE,
  },
  createParticles,
  createRamp,
  createSpawner,
  // Task 126 — the GPU-static vegetation field
  createGrassField,
  // The shared light (the LAMBERT/PBR scene meshes).
  LIGHT_DIR: [-0.35, 0.82, 0.45],
  LIGHT_COLOR: [1.05, 1.0, 0.92, 1],
  AMBIENT: [0.16, 0.18, 0.24, 1],
  // geometry for the scene meshes
  geometry: { capsule, cube, plane, sphere, torusKnot },

  /** Registers a particle layer: { facade, material, pipeline, textures?,
   *  uniforms?, render? (in the facade desc), id }. Returns the layer. */
  addLayer(layer) {
    layers.push(layer)
    return layer
  },

  /** A static scene-mesh command (the floor, the blobs, the box): builds
   *  the attributes from a prims geometry and a LIT material once. */
  addMesh(mesh) {
    const layer = { ...mesh, staticMesh: true }
    layers.push(layer)
    return layer
  },

  /** A world-anchored DOM label (the emitter-shapes demo). */
  label(text, x, y, z) {
    const el = document.createElement('div')
    el.className = 'fx-label'
    el.textContent = text
    labelLayer.append(el)
    const entry = { el, x, y, z }
    labels.push(entry)
    return entry
  },

  clearLabels() {
    for (const { el } of labels) el.remove()
    labels = []
  },

  /** Projects a world point to CSS pixels; writes [x, y, visible]. */
  project(x, y, z, out) {
    const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]
    const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]
    const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15]
    if (cw <= 0.001) { out[2] = 0; return false }
    out[0] = (cx / cw * 0.5 + 0.5) * env.width
    out[1] = (0.5 - cy / cw * 0.5) * env.height
    out[2] = 1
    return true
  },

  width: 0,
  height: 0,

  /** The per-demo camera default. */
  camera(cam) {
    const c = { yaw: 0.55, pitch: 0.25, dist: 5.2, orbit: 0.06, target: [0, 0.2, 0], ...cam }
    camYaw = c.yaw; camPitch = c.pitch; camDist = c.dist
    presetOrbit = c.orbit
    camTarget = c.target
  },
}

/* ─── The layer machinery: commands + the per-frame soup upload ───────── */

/** The billboard mode → the BILLBOARD uniform's mode index (u_bbA.x). */
const BB_MODE_INDEX = { camera: 0, vertical: 1, horizontal: 2, stretched: 3, oriented: 4 }

function buildLayerCommand(layer) {
  const soup = layer.facade.view(BASIS)
  // Task 131 — the DRAW FORMAT switch: an instance-mode facade (render.draw
  // === 'instance') packs 16-float records and needs the BILLBOARD material's
  // instanced command (one draw: 6 vertices × N instances).
  if (soup.draw === 'instance') return buildLayerInstanceCommand(layer, soup)
  const strideBytes = soup.stride * 4
  const layout = soup.layout
  // THE STALE-BINDING RESET (the WebGPU freeze root cause): a backend
  // switch re-boots the renderer, but the layer kept the OLD backend's
  // dynamic binding (glDyn from the disposed GL context / gpuDyn from the
  // destroyed device). The frame callback checks glDyn FIRST — a stale
  // glDyn would send every per-frame update into the dead GL context and
  // the NEW WebGPU vertex buffers would never update: the canvas froze on
  // the first-frame soup (a static picture that only "twitches" as the
  // draw count changes). Both bindings are cleared before the current
  // backend's is written — the dual-bind is always exactly one backend old
  // at most, never two.
  layer.glDyn = undefined
  layer.gpuDyn = undefined
  let bufferId
  if (activeRenderer.backend === 'webgpu') {
    layer.gpuDyn = activeRenderer.inner.gpu
  } else {
    const gl = activeRenderer.inner.gl
    bufferId = gl.createBuffer(soup.vertices)
    layer.glDyn = { gl, bufferId }
  }
  const attrs = {
    position: { data: soup.vertices, size: 3, stride: strideBytes, offset: layout.position.offset * 4, bufferId },
    uv: { data: soup.vertices, size: 2, stride: strideBytes, offset: layout.uv.offset * 4, bufferId },
    color: { data: soup.vertices, size: 4, stride: strideBytes, offset: layout.color.offset * 4, bufferId },
  }
  if (layout.normal !== undefined) {
    attrs.normal = { data: soup.vertices, size: 3, stride: strideBytes, offset: layout.normal.offset * 4, bufferId }
  }
  // A layer's texture may be a STATIC object or a RESOLVER FUNCTION
  // (evaluated here, at command-build time — after the renderer boot):
  // a resolver binds whatever texture object the CURRENT boot created
  // (the demo re-makes its GPU-owned sprites on every re-boot).
  const layerTexture = typeof layer.texture === 'function' ? layer.texture() : layer.texture
  const textures = { u_tex: layerTexture ?? atlasTexture, texTexture: layerTexture ?? atlasTexture, ...(layer.textures ?? {}) }
  const uniforms = {
    u_mvp: (p) => p.mvp,
    u_model: (p) => p.model,
    ...(layer.uniforms ?? {}),
  }
  layer.command = activeRenderer.command({
    id: `vfx:${layer.id ?? Math.random().toString(36).slice(2, 8)}`,
    shader: { glsl: layer.material.glsl, wgsl: layer.material.wgsl },
    pipeline: layer.pipeline,
    attributes: attrs,
    textures,
    uniforms,
    count: (p) => p.vertexCount ?? 0,
  })
  layer.soup = soup
}

/** Task 131 — the INSTANCED layer command: the facade's 16-float records as
 *  five instance-step attributes + the BILLBOARD uniforms (the mode, the
 *  spin, the stretch factors, the tile scales, the camera basis). The draw
 *  is ONE instanced call: 6 corners × the live instance count, the corner
 *  expansion on the GPU (the packer replaced the CPU bake). */
function buildLayerInstanceCommand(layer, soup) {
  const strideBytes = soup.stride * 4 // 64 — INSTANCE_STRIDE × 4
  const L = soup.instanceLayout
  // THE STALE-BINDING RESET (the same contract as the soup path — see
  // buildLayerCommand's comment): both dynamic bindings are cleared before
  // the current backend's is written.
  layer.glDyn = undefined
  layer.gpuDyn = undefined
  let bufferId
  if (activeRenderer.backend === 'webgpu') {
    layer.gpuDyn = activeRenderer.inner.gpu
  } else {
    const gl = activeRenderer.inner.gl
    bufferId = gl.createBuffer(soup.vertices)
    layer.glDyn = { gl, bufferId }
  }
  // The record fields → five instance attributes (the cross-package
  // contract: the material declares i_pos/i_vel/i_color/i_par/i_uv0).
  // Task 131 — THE GPU TIER: a layer with gpuBackend binds the EXTERNAL
  // records buffer (the compute pack's output — no data array upload, no
  // data-keyed cache); a CPU-pack layer binds its own buffer as before.
  const gpuTier = layer.gpuBackend !== undefined
  const recordsBufferId = gpuTier ? layer.gpuBackend.recordsBufferId : undefined
  const attr = (field) => ({
    data: soup.vertices, size: field.size, stride: strideBytes,
    offset: field.offset * 4, bufferId: gpuTier ? recordsBufferId : bufferId, step: 'instance',
  })
  const attrs = {
    i_pos: attr(L.pos), i_vel: attr(L.vel), i_color: attr(L.color),
    i_par: attr(L.par), i_uv0: attr(L.uv0),
  }
  const layerTexture = typeof layer.texture === 'function' ? layer.texture() : layer.texture
  const textures = { u_tex: layerTexture ?? atlasTexture, texTexture: layerTexture ?? atlasTexture, ...(layer.textures ?? {}) }
  // The BILLBOARD uniforms from the facade's resolved render desc + the
  // live camera basis (the basis resolvers read the module-level arrays —
  // zero allocation per frame).
  const r = layer.facade.render
  const spin = layer.facade.spin
  const mode = BB_MODE_INDEX[r.mode ?? 'camera'] ?? 0
  const tiles = r.tiles ?? [1, 1]
  const axisRandom = r.axis === undefined || r.axis === 'random' ? 1 : 0
  let axis = [0, 0, 1]
  if (!axisRandom) {
    const a = r.axis
    const al = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) || 1
    axis = [(a[0] ?? 0) / al, (a[1] ?? 0) / al, (a[2] ?? 0) / al]
  }
  const bbA = [mode, spin, r.speedFactor ?? 0, r.lengthFactor ?? 1]
  const bbB = [r.spin3d ?? 0, axisRandom, 1 / (tiles[0] || 1), 1 / (tiles[1] || 1)]
  const uniforms = {
    u_mvp: (p) => p.mvp,
    u_model: (p) => p.model,
    u_bbA: () => bbA,
    u_bbB: () => bbB,
    u_bbRight: () => BASIS.right,
    u_bbUp: () => BASIS.up,
    u_bbForward: () => BASIS.forward,
    u_bbAxis: () => axis,
    ...(layer.uniforms ?? {}),
  }
  layer.command = activeRenderer.command({
    id: `vfx:i:${layer.id ?? Math.random().toString(36).slice(2, 8)}`,
    shader: { glsl: layer.material.glsl, wgsl: layer.material.wgsl },
    pipeline: layer.pipeline,
    attributes: attrs,
    textures,
    uniforms,
    count: 6, // the two triangles of one quad — from gl_VertexID
    instances: (p) => p.instanceCount ?? 0,
  })
  layer.soup = soup
}

function buildMeshCommand(layer) {
  // A static scene mesh: the prims geometry feeds plain attributes (the
  // executor creates the buffers once — no per-frame upload).
  const geo = layer.geometry
  const textures = { ...(layer.textures ?? {}) }
  const uniforms = {
    u_mvp: (p) => p.mvp,
    u_model: (p) => p.model ?? MODEL,
    u_lightDir: () => env.LIGHT_DIR,
    u_lightColor: () => env.LIGHT_COLOR,
    u_ambient: () => env.AMBIENT,
    u_camPos: (p) => p.camPos,
    ...(layer.uniforms ?? {}),
  }
  const attrs = {
    position: { data: geo.positions, size: 3 },
    normal: { data: geo.normals, size: 3 },
    uv: { data: geo.uvs, size: 2 },
  }
  layer.command = activeRenderer.command({
    id: `vfx:mesh:${layer.id ?? Math.random().toString(36).slice(2, 8)}`,
    shader: { glsl: layer.material.glsl, wgsl: layer.material.wgsl },
    pipeline: layer.pipeline ?? OPAQUE,
    attributes: attrs,
    textures,
    uniforms,
    count: geo.vertexCount,
  })
}

function attachLayers() {
  for (const layer of layers) {
    if (layer.commandBuilt) continue
    if (layer.record !== undefined) { layer.commandBuilt = true; continue } // a raw layer — nothing to build
    if (layer.staticMesh === true) buildMeshCommand(layer)
    else buildLayerCommand(layer)
    layer.commandBuilt = true
  }
}

/* ─── The frame ───────────────────────────────────────────────────────── */

function frameCallback(ctx, record) {
  // auto-orbit: paused while dragging and for 1.5 s after
  if (!dragging && performance.now() - lastInteraction > 1500) camYaw += ctx.dt * presetOrbit

  if (ctx.aspect !== cachedAspect) {
    cachedAspect = ctx.aspect
    mat4Perspective(projection, Math.PI / 3.2, ctx.aspect, 0.1, 200)
  }
  camEye[0] = camTarget[0] + Math.sin(camYaw) * Math.cos(camPitch) * camDist
  camEye[1] = camTarget[1] + Math.sin(camPitch) * camDist
  camEye[2] = camTarget[2] + Math.cos(camYaw) * Math.cos(camPitch) * camDist
  mat4LookAt(view, camEye[0], camEye[1], camEye[2], camTarget[0], camTarget[1], camTarget[2])
  mat4Multiply(mvp, projection, view)

  // The billboard basis: the view matrix ROWS (right, up, forward) — the
  // quads are built in the camera plane; forward feeds the stretched/
  // trail/vertical modes.
  BASIS.right[0] = view[0]; BASIS.right[1] = view[4]; BASIS.right[2] = view[8]
  BASIS.up[0] = view[1]; BASIS.up[1] = view[5]; BASIS.up[2] = view[9]
  BASIS.forward[0] = -view[2]; BASIS.forward[1] = -view[5]; BASIS.forward[2] = -view[10]

  env.width = ctx.size[0]
  env.height = ctx.size[1]
  frameTime += ctx.dt
  // the frame tick (the shots gate samples it): a slow rasterizer can
  // take > 300 ms per frame — the gate waits for a NEW tick between its
  // screenshot pair instead of a fixed window (which would sample the
  // same frame twice and read a live canvas as FROZEN)
  if (typeof window !== 'undefined') window.__vfxFrame = (window.__vfxFrame ?? 0) + 1

  // ── the demo's own logic (advance, camera overrides, prepasses) ──
  const frameCtx = {
    dt: ctx.dt, time: frameTime, mvp, view, projection, basis: BASIS,
    camEye, camTarget, record, backend: activeRenderer.backend,
    width: env.width, height: env.height, dpr: window.devicePixelRatio,
    canvas: liveCanvas,
    // The composed P·V·M for MANUAL mesh layers (the follow demo's flying
    // box): gl_Position wants the model folded INTO the mvp.
    modelMvp: (model) => { mat4Multiply(MODEL_MVP, mvp, model); return MODEL_MVP },
  }
  if (state.frame !== undefined) state.frame(frameCtx, rhythm)

  // ── bake + upload + draw every layer, in registration order ──
  let liveVerts = 0
  for (const layer of layers) {
    // a RAW layer (the soft demo's depth prepass): the demo owns the record
    if (layer.record !== undefined) {
      layer.record(frameCtx)
      continue
    }
    if (layer.staticMesh === true) {
      // a manual layer (the follow demo's moving box) records itself with
      // its own dynamic model matrix
      if (layer.manual !== true) {
        mat4Multiply(MODEL_MVP, mvp, layer.model ?? MODEL)
        record(layer.command, { mvp: MODEL_MVP, model: layer.model ?? MODEL, camPos: camEye })
      }
      continue
    }
    const soup = layer.facade.view(BASIS)
    if (soup.draw === 'instance') {
      // Task 131 — the instanced path: upload the LIVE RECORD PREFIX (16
      // floats × instanceCount — a subarray, the rendererFeed pattern),
      // draw 6 corners × the instance count through the BB command.
      const instanceCount = soup.instanceCount
      if (instanceCount > 0) {
        const liveFloats = instanceCount * soup.stride
        if (layer.glDyn !== undefined) layer.glDyn.gl.updateBuffer(layer.glDyn.bufferId, soup.vertices.subarray(0, liveFloats))
        else if (layer.gpuDyn !== undefined) layer.gpuDyn.syncVertexBuffer(soup.vertices, liveFloats * 4)
        record(layer.command, { mvp, model: MODEL, camPos: camEye, instanceCount, ...(layer.props?.(frameCtx) ?? {}) })
        liveVerts += instanceCount * 6
      }
      continue
    }
    const vertexCount = soup.vertexCount
    const liveBytes = vertexCount * soup.stride * 4
    if (layer.glDyn !== undefined) layer.glDyn.gl.updateBuffer(layer.glDyn.bufferId, soup.vertices)
    else if (layer.gpuDyn !== undefined && vertexCount > 0) layer.gpuDyn.syncVertexBuffer(soup.vertices, liveBytes)
    if (vertexCount > 0) {
      record(layer.command, { mvp, model: MODEL, camPos: camEye, vertexCount, ...(layer.props?.(frameCtx) ?? {}) })
      liveVerts += vertexCount
    }
  }

  // ── the world labels (project + place) ──
  if (labels.length > 0) {
    const out = [0, 0, 0]
    for (const l of labels) {
      if (env.project(l.x, l.y, l.z, out)) {
        l.el.style.transform = `translate(${out[0].toFixed(1)}px, ${out[1].toFixed(1)}px) translate(-50%, -140%)`
        l.el.style.opacity = '1'
      } else {
        l.el.style.opacity = '0'
      }
    }
  }

  // the stats pill (~4 Hz)
  statsAccum += ctx.dt
  if (statsAccum > 0.25) {
    statsAccum = 0
    updatePill(liveVerts)
  }
}

function updatePill(vertexCount) {
  const demo = DEMOS[demoIndex]
  let live = 0
  for (const layer of layers) if (layer.facade !== undefined) live += layer.facade.count
  const span = document.createElement('span')
  span.className = 'pt-live'
  span.textContent = `${live.toLocaleString('en-US')} particles · ${vertexCount.toLocaleString('en-US')} verts`
  pill.textContent = `${demo.title} · `
  pill.append(span)
}

/* ─── Input: orbit + zoom (the particles demo's machinery) ───────────── */

const pointers = new Map()

function clampDist(d) { return Math.min(16, Math.max(1.4, d)) }

function bindInput(canvas) {
  let pinchStartDist = 0
  let pinchStartCam = camDist
  canvas.style.touchAction = 'none'
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    dragging = true
    lastInteraction = performance.now()
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y)
      pinchStartCam = camDist
    }
    try { canvas.setPointerCapture(e.pointerId) } catch { /* best-effort */ }
  })
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId)
    if (p === undefined) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    p.x = e.clientX; p.y = e.clientY
    lastInteraction = performance.now()
    if (pointers.size === 1) {
      camYaw -= dx * 0.006
      camPitch = Math.min(1.25, Math.max(-0.35, camPitch + dy * 0.006))
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d > 1) camDist = clampDist(pinchStartCam * (pinchStartDist / d))
    }
  })
  const lift = (e) => {
    pointers.delete(e.pointerId)
    if (pointers.size === 0) dragging = false
    lastInteraction = performance.now()
  }
  canvas.addEventListener('pointerup', lift)
  canvas.addEventListener('pointercancel', lift)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    camDist = clampDist(camDist * (1 + e.deltaY * 0.0012))
    lastInteraction = performance.now()
  }, { passive: false })
  // keyboard: ← → switch demos (the desktop carousel)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') switchDemo((demoIndex + DEMOS.length - 1) % DEMOS.length)
    else if (e.key === 'ArrowRight') switchDemo((demoIndex + 1) % DEMOS.length)
  })
}

/* ─── Demo switching ──────────────────────────────────────────────────── */

function switchDemo(index) {
  if (index === demoIndex && state !== null) return
  demoIndex = index
  for (const [i, row] of rowByIndex) row.setAttribute('aria-pressed', String(i === index))
  activateDemo('switch')
}

/** (Re)makes the current demo: teardown + fresh state. `why` — 'switch' or
 *  'reboot' (a renderer re-boot: every demo-owned GPU object — the soft
 *  demo's DEPTH-PREPASS SURFACE, its raw prepass commands — must be
 *  re-created on the NEW backend. Before this, a backend toggle left the
 *  soft demo recording commands compiled on the DEAD renderer and binding
 *  a texture from a disposed surface: a GL INVALID_OPERATION every frame
 *  and an empty prepass on WebGPU.) */
function activateDemo(why) {
  // teardown the old demo
  if (state !== null && state.dispose !== undefined) {
    try { state.dispose() } catch (error) { shell.log.warn(`dispose: ${error instanceof Error ? error.message : String(error)}`) }
  }
  layers = []
  env.clearLabels()
  rhythm = {}
  frameTime = 0
  const demo = DEMOS[demoIndex]
  env.camera({ yaw: 0.55, pitch: 0.25, dist: 5.2, orbit: 0.06, target: [0, 0.2, 0] })
  if (demo.camera !== undefined) env.camera(demo.camera)
  if (typeof window !== 'undefined') window.__vfxCounters = {} // the probe handle (fresh per demo)
  state = demo.make(env)
  if (typeof window !== 'undefined') window.__vfxLayers = layers // the shots/debug handle
  shell.log.event(`Demo: ${demo.title} — ${demo.sub}${why === 'reboot' ? ' · re-made on the new backend' : ''}`)
  updatePill(0)
  // a live renderer: build the commands for the new layers
  if (activeRenderer !== null) attachLayers()
}

/* ─── Boot / attach ───────────────────────────────────────────────────── */

async function attachAtlas() {
  atlasTexture = activeRenderer.texture(ATLAS_SIZE, ATLAS_SIZE)
  atlasUpload = atlasTexture.upload(makeAtlasBytes())
  env.atlasTexture = atlasTexture
  glowTexture = activeRenderer.texture(64, 64)
  glowTexture.upload(makeGlowBytes())
  env.glowTexture = glowTexture
  // the weapon-arc streak (Task 126 — the slash ribbon): bright along u,
  // a gaussian across v — a radial glow leaves a ribbon dark at its ends
  ribbonTexture = activeRenderer.texture(64, 16)
  ribbonTexture.upload(makeRibbonBytes())
  env.ribbonTexture = ribbonTexture
  // the dedicated VFX sprites — OUR pixels, one upload each, per boot
  sparkTexture = activeRenderer.texture(SPARK_W, SPARK_H)
  sparkTexture.upload(makeSparkBytes())
  env.sparkTexture = sparkTexture
  flashTexture = activeRenderer.texture(FLASH_N, FLASH_N)
  flashTexture.upload(makeFlashBytes())
  env.flashTexture = flashTexture
  smokeAtlas = activeRenderer.texture(SMOKE_ATLAS_N, SMOKE_ATLAS_N)
  smokeAtlas.upload(makeSmokeAtlasBytes())
  env.smokeAtlas = smokeAtlas
  hazeTexture = activeRenderer.texture(HAZE_N, HAZE_N)
  hazeTexture.upload(makeHazeBytes())
  env.hazeTexture = hazeTexture
  muzzleSheet = activeRenderer.texture(MUZZLE_N_W, MUZZLE_N_H)
  muzzleSheet.upload(makeMuzzleSheetBytes())
  env.muzzleSheet = muzzleSheet
}

async function boot(mode) {
  const seq = ++bootSeq
  if (activeRenderer !== null) {
    try { activeRenderer.dispose() } catch { /* the context may have died with the canvas */ }
    activeRenderer = null
    for (const layer of layers) layer.commandBuilt = false
  }
  shell.slot.replaceChildren()
  labelLayer = document.createElement('div')
  labelLayer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;'
  const canvas = document.createElement('canvas')
  canvas.id = 'canvas'
  shell.slot.append(labelLayer, canvas, bar, sheet, dragHint)
  liveCanvas = canvas
  if (state === null) switchDemo(0)
  bindInput(canvas)
  canvas.addEventListener('pointerdown', () => dragHint.classList.add('pt-gone'), { once: true })
  setTimeout(() => dragHint.classList.add('pt-gone'), 8000)

  shell.log.event(`Booting: “${MODE_NAMES[mode] ?? mode}”`)
  try {
    const renderer = createRenderer({
      canvas,
      backend: mode === 'auto' ? undefined : mode,
      clear: { color: [0.015, 0.02, 0.035, 1], depth: 1 },
      onGlError: (message) => shell.log.warn(`GL: ${message}`),
      onGpuError: (message) => shell.log.warn(`GPU: ${message}`),
    })
    await renderer.start()
    if (seq !== bootSeq) { renderer.dispose(); return }
    activeRenderer = renderer
    env.renderer = renderer
    env.backend = renderer.backend
    // Task 131 — the probe handle: the GPU facade (the state-buffer
    // readback gates read the sim's own memory through it)
    if (typeof window !== 'undefined' && renderer.backend === 'webgpu') window.__vfxGpuFacade = renderer.inner.gpu
    await attachAtlas()
    // A RE-boot (a backend toggle) with a live demo: the demo state owns
    // renderer-bound objects (the soft demo's surface + prepass commands)
    // — re-make it on THIS backend. The FIRST boot already made demo 0
    // above (before the renderer existed — its commands build below).
    if (state !== null && bootedOnce) activateDemo('reboot')
    attachLayers()
    renderer.frame(frameCallback)
    if (seq !== bootSeq) return
    bar.hidden = false
    const backendName = renderer.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
    shell.setBadge(backendName, renderer.backend === 'webgpu' ? 'gpu' : 'gl')
    shell.log.info(`Backend: ${backendName}${renderer.backend === 'webgl2' && mode === 'auto' ? ' (fallback)' : ''}`)
    bootedOnce = true
    if (atlasUpload?.done !== undefined) void atlasUpload.done.catch(() => { /* logged by the facade */ })
  } catch (error) {
    if (seq !== bootSeq) return
    const message = error instanceof Error ? error.message : String(error)
    // Auto mode: the label PROMISES "WebGPU → WebGL2 fallback" — honor it.
    // A WebGPU boot can die late (the adapter exists but the device or the
    // first configure fails — driver-dependent); retry once on WebGL2
    // instead of leaving a dead canvas behind.
    if (mode === 'auto') {
      shell.log.warn(`WebGPU boot failed (${message.slice(0, 120)}) — falling back to WebGL2`)
      void boot('webgl2')
      return
    }
    shell.setBadge(mode === 'webgpu' ? 'WebGPU unavailable' : 'startup failed', 'err')
    shell.log.error(`Boot on “${mode}” failed: ${message}`)
    if (mode === 'webgpu') {
      shell.log.info('This is not a library error — the backend is missing in this browser. Switch the toggle to Auto or WebGL2.')
    }
    return
  }
  shell.log.event('Rendering started')
  const live = shell.slot.querySelector('canvas')
  shell.log.info(`Canvas: ${live.clientWidth}×${live.clientHeight} css-px, DPR ${window.devicePixelRatio}`)
  shell.markReady()
}

/* ─── Go ───────────────────────────────────────────────────────────────── */

shell.log.info(`WebGL2: ${typeof WebGL2RenderingContext !== 'undefined' ? 'present in the browser' : 'missing'}`)
shell.log.info('24 demos on @rune/particles — the library surface end to end + the rune originals + the GPU compute tier (160k embers on WebGPU)')
switchDemo(0)
void boot(shell.mode ?? 'auto')
