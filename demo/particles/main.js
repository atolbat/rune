// "particles" demo — @rune/particles, the CPU-simulated system, drawn as
//   camera-facing billboard soups on both backends.
//
// Flow: four presets (fountain / fireworks / galaxy / embers) built from
//   createParticles({ capacity, rate, spawner, ramp, forces, spin });
//   per frame: advance(dt) → billboards(basis) → ONE draw command with a
//   dynamic vertex count. The soup (pos3 / uv2 / color4, 6 verts per
//   particle, 36 B per vertex, interleaved in ONE Float32Array) is uploaded
//   per frame:
//     WebGL2 — renderer.inner.inner.gl.updateBuffer(bufferId, soup)
//              (the bufferId dual-bind of the feed path)
//     WebGPU — renderer.inner.gpu.syncVertexBuffer(soup, liveBytes)
//              (the feed's dirty-range write, keyed by the array itself)
// The material is the UNLIT pair from @rune/materials (TEXTURE |
//   VERTEX_COLOR — the texture multiplied by the per-vertex ramp tint);
//   the sprite is a canvas radial gradient (no download); blending comes
//   from the pipeline desc: additive for the glow presets, classic
//   src-alpha for the smoke preset.
// Camera: slow auto-orbit; drag to orbit, pinch / wheel to zoom. The
//   billboard basis (right / up) is taken from the VIEW matrix rows.
import { createRenderer } from '../../dist/rune.esm.js'
import { materialOf, TEXTURE, VERTEX_COLOR } from '../../dist/rune-materials.esm.js'
import { createParticles, createRamp } from '../../dist/rune-particles.esm.js'

/* ─── Materials: the unlit sprite pair × 2 blend modes ─────────────────── */

const SPRITE_MATERIAL = materialOf({ features: TEXTURE | VERTEX_COLOR })
// additive glow: the source color scaled by alpha lands on the target
const ADDITIVE_PIPELINE = {
  depth: { test: 'less', write: false },
  raster: { cull: 'none' },
  blend: { src: 'src-alpha', dst: 'one' },
}
// classic transparency: the smoke preset (soft dark puffs)
const ALPHA_PIPELINE = {
  depth: { test: 'less', write: false },
  raster: { cull: 'none' },
  blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' },
}

/* ─── Presets ──────────────────────────────────────────────────────────── */

const CAPACITY = 8192 // 8k particles = 1.77 MiB of soup per frame upload

const FIREWORKS_SPAWNER = {
  shape: { kind: 'sphere', origin: [0, 2.1, 0], radius: [0.03, 0.1] },
  velocity: { mode: 'radial' },
  speed: [3.4, 5.8],
  life: [1.5, 2.6],
  size: [0.07, 0.12],
  color: [[1, 1, 1, 1], [1, 0.7, 0.3, 1]],
  seed: 31,
}

const PRESETS = {
  fountain: {
    title: 'Fountain',
    sub: 'cone emitter · gravity · drag · additive',
    pipeline: ADDITIVE_PIPELINE,
    make: () => createParticles({
      capacity: CAPACITY,
      rate: 1500,
      ramp: createRamp([
        { t: 0, size: 1.4, r: 0.85, g: 0.95, b: 1, a: 0 },
        { t: 0.12, size: 1, r: 1, g: 1, b: 1, a: 1 },
        { t: 1, size: 0.25, r: 0.35, g: 0.55, b: 1, a: 0 },
      ]),
      forces: { gravity: [0, -9.5, 0], drag: 0.15, turbulence: 0 },
      spin: 0,
      spawner: {
        shape: { kind: 'cone', origin: [0, -0.6, 0], axis: [0, 1, 0], halfAngle: 0.16, baseRadius: 0.12, length: [0, 0.05] },
        velocity: { mode: 'lobe' },
        speed: [3.4, 4.4],
        life: [1.3, 2.1],
        size: [0.06, 0.13],
        color: [[1, 1, 1, 1], [0.6, 0.8, 1, 0.9]],
        seed: 7,
      },
    }),
  },

  fireworks: {
    title: 'Fireworks',
    sub: 'sphere bursts · gravity · additive',
    pipeline: ADDITIVE_PIPELINE,
    spawner: FIREWORKS_SPAWNER,
    // rate 0 — the demo timer fires the bursts
    make: () => createParticles({
      capacity: CAPACITY,
      rate: 0,
      ramp: createRamp([
        { t: 0, size: 1.2, r: 1, g: 1, b: 1, a: 1 },
        { t: 0.55, size: 1, r: 1, g: 0.8, b: 0.4, a: 0.9 },
        { t: 1, size: 0.1, r: 1, g: 0.3, b: 0.1, a: 0 },
      ]),
      forces: { gravity: [0, -1.8, 0], drag: 0.05, turbulence: 0 },
      spin: 0,
      spawner: FIREWORKS_SPAWNER,
    }),
    // the burst rhythm: every ~1 s a shell with a fresh seed (a new shape,
    // a new color mix)
    burstEvery: 1.05,
    burstCount: 420,
  },

  galaxy: {
    title: 'Galaxy',
    sub: 'disc + tangential orbits · drag · additive',
    pipeline: ADDITIVE_PIPELINE,
    make: () => createParticles({
      capacity: CAPACITY,
      rate: 900,
      ramp: createRamp([
        { t: 0, size: 0.3, r: 1, g: 0.9, b: 1, a: 0 },
        { t: 0.2, size: 1, r: 1, g: 0.9, b: 1, a: 0.85 },
        { t: 1, size: 0.6, r: 0.4, g: 0.5, b: 1, a: 0 },
      ]),
      forces: { gravity: [0, 0, 0], drag: 0.22, turbulence: 0 },
      spin: 0,
      spawner: {
        // the disc + TANGENTIAL velocity: particles are born orbiting,
        // the drag slowly spirals them inward — a galaxy without forces
        shape: { kind: 'disc', origin: [0, 0.1, 0], axis: [0, 1, 0], radius: [1.2, 3.1] },
        velocity: { mode: 'tangential' },
        speed: [0.55, 0.95],
        life: [4.5, 7],
        size: [0.08, 0.16],
        color: [[1, 0.85, 0.7, 1], [0.55, 0.65, 1, 1]],
        seed: 97,
      },
    }),
  },

  embers: {
    title: 'Embers',
    sub: 'buoyancy · turbulence · growing smoke · alpha',
    pipeline: ALPHA_PIPELINE,
    make: () => createParticles({
      capacity: CAPACITY,
      rate: 240,
      ramp: createRamp([
        { t: 0, size: 0.35, r: 1, g: 0.75, b: 0.4, a: 0 },
        { t: 0.15, size: 0.7, r: 1, g: 0.6, b: 0.25, a: 0.85 },
        { t: 1, size: 2.2, r: 0.25, g: 0.2, b: 0.22, a: 0 },
      ]),
      // positive gravity = buoyancy here (the axis is up); turbulence = wander
      forces: { gravity: [0, 0.45, 0], drag: 0.7, turbulence: 1.1 },
      spin: 0.7,
      spawner: {
        shape: { kind: 'disc', origin: [0, -0.5, 0], axis: [0, 1, 0], radius: [0.02, 0.2] },
        velocity: { mode: 'axis' },
        speed: [0.5, 1.1],
        life: [2.5, 4.5],
        size: [0.12, 0.22],
        color: [[1, 0.8, 0.5, 1], [0.8, 0.35, 0.15, 0.8]],
        seed: 5,
      },
    }),
  },
}

const PRESET_ORDER = ['fountain', 'fireworks', 'galaxy', 'embers']

/* ─── The sprite: a canvas radial gradient (no download) ───────────────── */

function makeSpriteBitmap() {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  // a soft glow: white core → transparent rim (NON-premultiplied semantics
  // on upload; the pipeline blends with 'src-alpha')
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.6, 'rgba(255,255,255,0.22)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  return createImageBitmap(canvas)
}

/* ─── Mat4 scratch + helpers (the model-viewer's formulas) ─────────────── */

const M = () => new Float32Array(16)
const view = M()
const projection = M()
const mvp = M()
const MODEL = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
// The billboard basis — written from the view matrix rows each frame.
const BASIS = { right: [1, 0, 0], up: [0, 1, 0] }

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
  // z = normalize(eye - center); x = normalize(up × z); y = z × x
  let zx = ex - cx, zy = ey - cy, zz = ez - cz
  let l = Math.hypot(zx, zy, zz) || 1
  zx /= l; zy /= l; zz /= l
  let xx = zz, xy = 0, xz = -zx // up = (0,1,0)
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

/* ─── State (before the UI build — the rows read currentPresetId) ───────── */

let activeRenderer = null
let bootSeq = 0
let currentPresetId = 'fountain'
let particles = null          // the @rune/particles facade
let drawCommand = null        // the soup draw command
let glDyn = null              // WebGL2: { gl, bufferId } for updateBuffer
let gpuDyn = null             // WebGPU: the GPUFacade for syncVertexBuffer
let soupTexture = null        // the sprite texture handle
let burstTimer = 0            // the fireworks rhythm
let cachedAspect = -1

// the camera: orbit angles + distance
let camYaw = 0.55
let camPitch = 0.25
let camDist = 4.6
const camEye = [0, 0, 0]
let statsAccum = 0
let dragging = false
let lastInteraction = 0

/* ─── Shell, pill, sheet ────────────────────────────────────────────────── */

const MODE_NAMES = { auto: 'Auto (WebGPU → WebGL2 fallback)', webgl2: 'WebGL2', webgpu: 'WebGPU' }

const shell = window.RuneDemoShell.mount({
  layout: 'fullscreen',
  title: 'rune — particles',
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

const pill = document.createElement('button')
pill.type = 'button'
pill.className = 'pt-pill'
pill.hidden = true
pill.addEventListener('click', () => setSheetOpen(true))

const sheet = document.createElement('div')
sheet.className = 'pt-sheet'
const sheetHead = document.createElement('div')
sheetHead.className = 'pt-head'
const sheetTitle = document.createElement('span')
sheetTitle.className = 'pt-title'
sheetTitle.textContent = 'Presets'
const sheetClose = document.createElement('button')
sheetClose.type = 'button'
sheetClose.className = 'pt-close'
sheetClose.textContent = '✕'
sheetClose.setAttribute('aria-label', 'Close')
sheetClose.addEventListener('click', () => setSheetOpen(false))
sheetHead.append(sheetTitle, sheetClose)

const rows = document.createElement('div')
rows.className = 'pt-rows'
const rowById = new Map()
for (const id of PRESET_ORDER) {
  const preset = PRESETS[id]
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'pt-row'
  row.setAttribute('aria-pressed', String(id === currentPresetId))
  const main = document.createElement('span')
  main.className = 'pt-main'
  const b = document.createElement('b')
  b.textContent = preset.title
  const sub = document.createElement('span')
  sub.className = 'pt-sub'
  sub.textContent = preset.sub
  main.append(b, sub)
  row.append(main)
  row.addEventListener('click', () => { switchPreset(id); setSheetOpen(false) })
  rows.append(row)
  rowById.set(id, row)
}

const note = document.createElement('div')
note.className = 'pt-note'
note.innerHTML = 'Simulation: <code>@rune/particles</code> (CPU, zero allocations per frame) · one draw call · drag to orbit, pinch to zoom'
sheet.append(sheetHead, rows, note)

const dragHint = document.createElement('div')
dragHint.className = 'pt-hint'
dragHint.textContent = 'drag to orbit · pinch to zoom'

let sheetOpen = true
function setSheetOpen(open) {
  sheetOpen = open
  sheet[open ? 'removeAttribute' : 'setAttribute']('hidden', '')
}

/* ─── The frame ────────────────────────────────────────────────────────── */

function frameCallback(ctx, record) {
  // auto-orbit: paused while dragging and for 1.5 s after
  if (!dragging && performance.now() - lastInteraction > 1500) camYaw += ctx.dt * 0.08

  if (ctx.aspect !== cachedAspect) {
    cachedAspect = ctx.aspect
    mat4Perspective(projection, Math.PI / 3.2, ctx.aspect, 0.1, 100)
  }
  camEye[0] = Math.sin(camYaw) * Math.cos(camPitch) * camDist
  camEye[1] = Math.sin(camPitch) * camDist + 0.4
  camEye[2] = Math.cos(camYaw) * Math.cos(camPitch) * camDist
  mat4LookAt(view, camEye[0], camEye[1], camEye[2], 0, 0.2, 0)
  mat4Multiply(mvp, projection, view)

  // The billboard basis: the view matrix ROWS (right, up) — the quads are
  // built in the camera plane, so they always face the eye.
  BASIS.right[0] = view[0]; BASIS.right[1] = view[4]; BASIS.right[2] = view[8]
  BASIS.up[0] = view[1]; BASIS.up[1] = view[5]; BASIS.up[2] = view[9]

  // ── simulate ──
  particles.advance(ctx.dt)
  // the fireworks rhythm: fresh shells with fresh seeds
  const preset = PRESETS[currentPresetId]
  if (preset.burstEvery !== undefined) {
    burstTimer -= ctx.dt
    if (burstTimer <= 0) {
      burstTimer = preset.burstEvery
      // a per-burst seed + a shifted origin — the sphere burst pattern and
      // the color mix both re-roll. This recompiles the spawner (a closure
      // + one object, ~once per second; the per-frame path stays clean).
      particles.burst(preset.burstCount, {
        ...preset.spawner,
        seed: (Math.random() * 0x7fffffff) | 0,
        shape: {
          kind: 'sphere',
          origin: [(Math.random() - 0.5) * 2.4, 1.7 + Math.random() * 0.9, (Math.random() - 0.5) * 2.4],
          radius: [0.03, 0.1],
        },
      })
    }
  }

  // ── bake the billboard soup ──
  const soupView = particles.billboards(BASIS)
  const vertexCount = soupView.vertexCount
  const liveBytes = vertexCount * 36

  // ── upload the soup (the feed dual-bind path, per backend) ──
  if (glDyn !== null) glDyn.gl.updateBuffer(glDyn.bufferId, soupView.vertices)
  if (gpuDyn !== null && vertexCount > 0) gpuDyn.syncVertexBuffer(soupView.vertices, liveBytes)

  // ── one draw ──
  if (drawCommand !== null && vertexCount > 0) record(drawCommand, { mvp, model: MODEL, vertexCount })

  // the stats pill (~4 Hz)
  statsAccum += ctx.dt
  if (statsAccum > 0.25) {
    statsAccum = 0
    updatePill(vertexCount)
  }
}

function updatePill(vertexCount) {
  const preset = PRESETS[currentPresetId]
  const stats = particles.stats()
  const live = document.createElement('span')
  live.className = 'pt-live'
  live.textContent = `${stats.count.toLocaleString('en-US')} / ${stats.capacity.toLocaleString('en-US')} · ${vertexCount.toLocaleString('en-US')} verts`
  pill.textContent = `${preset.title} · `
  pill.append(live)
}

/* ─── Input: orbit + zoom ──────────────────────────────────────────────── */

const pointers = new Map()

function clampDist(d) { return Math.min(9, Math.max(2.2, d)) }

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
      camPitch = Math.min(1.2, Math.max(-0.15, camPitch + dy * 0.006))
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
}

/* ─── Boot / attach ────────────────────────────────────────────────────── */

function switchPreset(id) {
  currentPresetId = id
  for (const [rowId, row] of rowById) row.setAttribute('aria-pressed', String(rowId === id))
  particles = PRESETS[id].make()
  burstTimer = 0
  drawCommand = null // until (re)attached — the soup reference changed
  glDyn = null
  gpuDyn = null
  shell.log.event(`Preset: ${PRESETS[id].title} — ${PRESETS[id].sub}`)
  updatePill(0)
  // a live renderer: rebind the command to the NEW soup array (the old
  // buffer stays in the facade — bounded by the preset count, freed on
  // renderer dispose)
  if (activeRenderer !== null) void attachCommand()
}

async function attachSprite() {
  const sprite = await makeSpriteBitmap()
  soupTexture = activeRenderer.texture(sprite.width, sprite.height)
  soupTexture.uploadImage(sprite)
}

async function attachCommand() {
  const preset = PRESETS[currentPresetId]
  // The soup command: three interleaved attribute views into ONE
  // Float32Array (the facade's vertex buffer, capacity-sized, stable).
  const soup = particles.billboards(BASIS).vertices
  // The dynamic upload path, per backend:
  //   WebGL2 — a facade buffer + updateBuffer per frame (bufferId dual-bind)
  //   WebGPU — the facade's syncVertexBuffer (keyed by the soup array)
  glDyn = null
  gpuDyn = null
  let bufferId
  if (activeRenderer.backend === 'webgpu') {
    gpuDyn = activeRenderer.inner.gpu
  } else {
    const gl = activeRenderer.inner.gl
    bufferId = gl.createBuffer(soup)
    glDyn = { gl, bufferId }
  }
  const attrs = {
    position: { data: soup, size: 3, stride: 36, offset: 0, bufferId },
    uv: { data: soup, size: 2, stride: 36, offset: 12, bufferId },
    color: { data: soup, size: 4, stride: 36, offset: 20, bufferId },
  }

  drawCommand = activeRenderer.command({
    id: `particles:${currentPresetId}`,
    shader: { glsl: SPRITE_MATERIAL.glsl, wgsl: SPRITE_MATERIAL.wgsl },
    pipeline: preset.pipeline,
    attributes: attrs,
    textures: { u_tex: soupTexture, texTexture: soupTexture },
    uniforms: { u_mvp: (p) => p.mvp, u_model: (p) => p.model },
    count: (p) => p.vertexCount ?? 0,
  })
}

async function boot(mode) {
  const seq = ++bootSeq
  if (activeRenderer !== null) {
    try { activeRenderer.dispose() } catch { /* the context may have died with the canvas */ }
    activeRenderer = null
    drawCommand = null
    glDyn = null
    gpuDyn = null
  }
  shell.slot.replaceChildren()
  const canvas = document.createElement('canvas')
  canvas.id = 'canvas'
  shell.slot.append(canvas, pill, sheet, dragHint)
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
    await attachSprite()
    await attachCommand()
    renderer.frame(frameCallback)
    if (seq !== bootSeq) return
    pill.hidden = false
    const backendName = renderer.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
    shell.setBadge(backendName, renderer.backend === 'webgpu' ? 'gpu' : 'gl')
    shell.log.info(`Backend: ${backendName}${renderer.backend === 'webgl2' && mode === 'auto' ? ' (fallback)' : ''}`)
  } catch (error) {
    if (seq !== bootSeq) return
    const message = error instanceof Error ? error.message : String(error)
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
switchPreset('fountain')
setSheetOpen(true) // first visit: the preset sheet is the entry point
void boot(shell.mode ?? 'auto')
