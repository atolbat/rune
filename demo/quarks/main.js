// "quarks" demo — the three.quarks example suite, re-implemented on
//   @rune/particles + the rune renderer, one page with a carousel
//   (their vanilla.html format: ◀ ▶ through 14 demos).
//
// The Task 122 library surface this page exercises end to end:
//   shapes (hemisphere/donut/rectangle/grid + the classics), the image
//   seek targets (their TextureSequencer), the burst schedule with
//   cycle/interval/probability, prewarm, the live emitter origin at()
//   (follow), the billboard modes (vertical/horizontal/stretched/oriented),
//   the ATLAS (tiles + the ramp frame channel — FrameOverLife), TRAILS,
//   MESH particles with lit materials, the forces (collision planes,
//   simplex noise, the seek spring, SpeedOverLife), onRetire (sub
//   emitters), and the custom BLEND EQUATIONS (add/max/subtract) + the
//   SOFT_PARTICLES depth fade (a color-encoded depth prepass).
//
// The dist imports carry ?v=123 (the stale-cache guard — bump on release).
import { createRenderer, capsule, cube, plane, torusKnot } from '../../dist/rune.esm.js?v=123'
import {
  materialOf, TEXTURE, VERTEX_COLOR, ALPHA_CUTOFF, LAMBERT, FLAT_ALBEDO,
  DOUBLE_SIDED, PBR, pbrMask, SOFT_PARTICLES, PBR_ENV,
} from '../../dist/rune-materials.esm.js?v=123'
import { createParticles, createRamp, createSpawner } from '../../dist/rune-particles.esm.js?v=123'
import { decodePngRgba } from './png.mjs'

/* ─── the demo registry (their order) ─────────────────────────────────── */

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

const DEMOS = [muzzle, explosion, shapes, trail, sequencer, mesh, subemitter,
  noise, alphatest, plugin, billboard, soft, blending, follow]

/* ─── materials & pipelines ────────────────────────────────────────────── */

const SPRITE_MATERIAL = materialOf({ features: TEXTURE | VERTEX_COLOR })
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
// Task 122 — the custom equations (their CustomBlending demo: One/One ×
// Add/Max/Subtract).
const ONE_ADD = { depth: { test: 'less', write: false }, raster: { cull: 'none' }, blend: { src: 'one', dst: 'one', equation: 'add' } }
const ONE_MAX = { depth: { test: 'less', write: false }, raster: { cull: 'none' }, blend: { src: 'one', dst: 'one', equation: 'max' } }
const ONE_SUBTRACT = { depth: { test: 'less', write: false }, raster: { cull: 'none' }, blend: { src: 'one', dst: 'one', equation: 'subtract' } }
// Opaque scene meshes (the floor, the follow box, the soft-demo blobs).
const OPAQUE = { depth: { test: 'less', write: true }, raster: { cull: 'back' } }

/* ─── the procedural sprite atlas (4×4 tiles, 64 px each) ─────────────── */

/* ─── The three.quarks atlas: their texture1.png, exact bytes ───────────

   Decoded ONCE at module load (before any demo's make()) — the raw RGBA
   bytes, straight alpha by construction, no browser image semantics
   (the Task 118 lesson). The box: `loaded` is set for the whole session;
   `texture` is re-created per boot (the renderer owns GPU objects). The
   muzzle demo's layers resolve () => env.quarksAtlas?.texture at
   command-build time — always after this decode and after the boot's
   texture creation. */
let quarksPng = null
try {
  quarksPng = await decodePngRgba('assets/texture1.png')
} catch (error) {
  // A missing asset (a misconfigured server) must not kill the page: the
  // muzzle demo falls back to the procedural atlas with a loud note.
  console.warn(`texture1.png: ${error instanceof Error ? error.message : String(error)}`)
}

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
        const i = ((oy + y) * ATLAS_SIZE + ox + x) * 4
        bytes[i] = r; bytes[i + 1] = g; bytes[i + 2] = b; bytes[i + 3] = a
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
    const cross = Math.max(Math.exp(-90 * v * v), Math.exp(-90 * u * u)) * (r < 0.48 ? 1 : 0)
    return [R, R, R, Math.min(255, Math.round(255 * (core + cross * 0.85)))]
  })
  // 5: the ring (an annulus)
  put(5, (u, v, r) => [R, R, R, Math.round(255 * Math.exp(-Math.pow((r - 0.3) / 0.08, 2)))])
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
  // 7: the arrow (a triangle pointing UP — the billboard-mode demo)
  put(7, (u, v) => {
    const inside = Math.abs(u) < (0.5 - v) * 0.62 && v < 0.32 && v > -0.5
    const soft = Math.abs(u) < (0.5 - v) * 0.62 + 0.03 && v < 0.35 && v > -0.53
    const a = inside ? 255 : soft ? 90 : 0
    return [R, R, R, a]
  })
  // 8: the leaf silhouette (an ellipse + a stem, the alpha-test demo)
  put(8, (u, v) => {
    const ex = u / 0.42, ey = (v + 0.1) / 0.55
    const leaf = ex * ex + ey * ey < 1
    const stem = Math.abs(u) < 0.03 && v > 0.1 && v < 0.5
    const a = leaf || stem ? 255 : 0
    return [Math.round(190 + 40 * (0.5 - v)), R, Math.round(90 * (v + 0.5) + 30), a]
  })
  // 9: the bubble (a hard disc with a bright rim)
  put(9, (u, v, r) => {
    const disc = r < 0.46
    const rim = Math.exp(-Math.pow((r - 0.4) / 0.07, 2))
    const hi = Math.exp(-(((u + 0.16) ** 2 + (v - 0.16) ** 2)) / 0.01)
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
  // 13: the rounded square glow
  put(13, (u, v) => {
    const d = Math.max(Math.abs(u), Math.abs(v))
    return [R, R, R, Math.round(255 * Math.max(0, Math.exp(-Math.pow((d - 0.3) / 0.14, 2))))]
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
let demoIndex = 0
let state = null          // the current demo's state object
let rhythm = {}           // fresh per demo switch
let atlasTexture = null
let atlasUpload = null
let glowTexture = null // the single-glow ribbon sprite (the trail demo)
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
  title: 'rune — quarks demos',
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
sheetTitle.textContent = 'three.quarks demos'
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
note.innerHTML = 'Sim: <code>@rune/particles</code> · 14 three.quarks examples · <a href="https://github.com/Alchemist0823/three.quarks" target="_blank" rel="noopener">the originals</a> · drag to orbit, pinch to zoom'
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
  // The original three.quarks atlas (assets/texture1.png): null when the
  // decode failed; { loaded: true, texture: T | null } otherwise — the
  // texture object is (re-)created at every renderer boot.
  quarksAtlas: quarksPng !== null ? { loaded: true, texture: null } : null,
  materials: {
    sprite: SPRITE_MATERIAL, leaf: LEAF_MATERIAL, soft: SOFT_MATERIAL,
    lambert: LAMBERT_MATERIAL, pbr: PBR_MATERIAL,
  },
  pipelines: {
    additive: ADDITIVE, alpha: ALPHA,
    oneAdd: ONE_ADD, oneMax: ONE_MAX, oneSubtract: ONE_SUBTRACT,
    opaque: OPAQUE,
  },
  createParticles,
  createRamp,
  createSpawner,
  // The shared light (the LAMBERT/PBR scene meshes).
  LIGHT_DIR: [-0.35, 0.82, 0.45],
  LIGHT_COLOR: [1.05, 1.0, 0.92, 1],
  AMBIENT: [0.16, 0.18, 0.24, 1],
  // geometry for the scene meshes
  geometry: { capsule, cube, plane, torusKnot },

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
    el.className = 'qk-label'
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

function buildLayerCommand(layer) {
  const soup = layer.facade.view(BASIS)
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
  // the quarks-atlas layers resolve () => env.quarksAtlas?.texture so the
  // command binds whatever texture the CURRENT boot created.
  const layerTexture = typeof layer.texture === 'function' ? layer.texture() : layer.texture
  const textures = { u_tex: layerTexture ?? atlasTexture, texTexture: layerTexture ?? atlasTexture, ...(layer.textures ?? {}) }
  const uniforms = {
    u_mvp: (p) => p.mvp,
    u_model: (p) => p.model,
    ...(layer.uniforms ?? {}),
  }
  layer.command = activeRenderer.command({
    id: `quarks:${layer.id ?? Math.random().toString(36).slice(2, 8)}`,
    shader: { glsl: layer.material.glsl, wgsl: layer.material.wgsl },
    pipeline: layer.pipeline,
    attributes: attrs,
    textures,
    uniforms,
    count: (p) => p.vertexCount ?? 0,
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
    id: `quarks:mesh:${layer.id ?? Math.random().toString(36).slice(2, 8)}`,
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
  // teardown the old demo
  if (state !== null && state.dispose !== undefined) {
    try { state.dispose() } catch (error) { shell.log.warn(`dispose: ${error instanceof Error ? error.message : String(error)}`) }
  }
  layers = []
  env.clearLabels()
  rhythm = {}
  frameTime = 0
  const demo = DEMOS[index]
  env.camera({ yaw: 0.55, pitch: 0.25, dist: 5.2, orbit: 0.06, target: [0, 0.2, 0] })
  if (demo.camera !== undefined) env.camera(demo.camera)
  state = demo.make(env)
  if (typeof window !== 'undefined') window.__quarksLayers = layers // the shots/debug handle
  shell.log.event(`Demo: ${demo.title} — ${demo.sub}`)
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
  // the original three.quarks atlas: re-created on THIS renderer (the
  // bytes were decoded once, at module load)
  if (quarksPng !== null) {
    const tex = activeRenderer.texture(quarksPng.width, quarksPng.height)
    const upload = tex.upload(quarksPng.data)
    env.quarksAtlas.texture = tex
    if (upload?.done !== undefined) void upload.done.catch(() => { /* the facade logs */ })
  }
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
    await attachAtlas()
    attachLayers()
    renderer.frame(frameCallback)
    if (seq !== bootSeq) return
    bar.hidden = false
    const backendName = renderer.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
    shell.setBadge(backendName, renderer.backend === 'webgpu' ? 'gpu' : 'gl')
    shell.log.info(`Backend: ${backendName}${renderer.backend === 'webgl2' && mode === 'auto' ? ' (fallback)' : ''}`)
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
shell.log.info('14 three.quarks demos on @rune/particles — the Task 122 surface: shapes, targets, trails, meshes, atlas, forces, blend equations, soft particles')
switchDemo(0)
void boot(shell.mode ?? 'auto')
