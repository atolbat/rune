// forest/main.js — Task 223 — THE DENSE FOREST.
//
// «Используй ссылку и загрузи 3д модель дерева. Твоя задача сделать демо,
// наполненное этим деревом одним в густой лес. Учитывай, что дерево весьма
// большое и с полигонами, так что тебе надо всячески оптимизировать и
// придумать как хорошо окклюдить все.»
//
// THE SUBJECT: a single podocarp (free3d's «Podokarp tree N051218», the
// VLM-verified lower copy — 310k faces: 302k of unshared-triangle foliage
// + 8k of bark tubes), normalized to 12 m, instanced ~2.4k times into a
// dense forest over a rolling terrain. THE HERO MESH IS THE POINT — the
// demo's job is to draw a 155k-triangle tree NEAR YOU and still hold 60
// fps on a phone, and the whole stack below exists to make that honest.
//
// THE OPTIMIZATION STACK (every layer measured, none decorative):
//   · THE QUANTIZED FEED (Task 223, the engine's own new law): i16
//     positions + i8 normals + i16 uvs = 16 B/vertex against fp32's 32 —
//     the foliage soup is vertex-BANDWIDTH-bound (2.3 v/tri, no sharing);
//     the asset rides gzipped (7.0 MB) + DecompressionStream at load.
//   · THE NESTED LOD LADDER (the asset's own law): LOD0 45% of the leaves
//     (131k tris — the showcase near tree) → 18% → 5% → 1.5%+stem, every
//     coarser LOD a strict SUBSET of the finer (one seeded hash) — a
//     z-fill drawn at any coarser LOD can only UNDER-occlude, never
//     falsely cull (the subset law, by construction).
//   · THE CELLS + THE BANDS (the CPU side): trees sorted into 22 m cells
//     at build; per frame the frustum + distance bands turn cells into
//     contiguous RECORD RUNS — a handful of draws per band, zero
//     per-instance CPU work, zero readbacks.
//   · THE HI-Z TIER (the whole prior stack, live): the terrain's depth
//     is the pyramid's base layer, the trees' own LOD3 proxy depth fills
//     it (twice — the fresh fill, then the visible-set refine), the cull
//     kernel judges every tree's AABB, the K=6 hysteresis holds the
//     silhouette churn, and the verdict COLLAPSE rides the vertex shader
//     (a hidden tree costs its mesh fetch and nothing else).
//   · THE SINGLE-PASS PRESENT + THE MSAA SURFACE (Tasks 219/220): the
//     whole frame renders into the offscreen surface (4x where the GPU
//     can), ONE blit presents — the phone-proven shape.
//
// THE FRAME (the declared graph):
//   terrain-z → tree-z (LOD3 fill, all bands) → pyramid → cull#1
//   → tree-z-2 (LOD3, the visible set) → pyramid-2 → cull#2 → hysteresis
//   → terrain-color → tree-color (per band × material) → present
//
// window.__forest — the live counters (the smoke/gates read it);
// window.__forestGate — the boot validation's promise (the deterministic
// orbit autopilot + the laws).
import { createDevice, createFrameGraph, frustumPlanes, aabbOutsideFrustum } from '../../dist/rune.esm.js?v=223'
import { perspective, lookAt, mat4Mul } from '../occlusion/scene.js?v=203'
import { buildShaders } from '../occlusion/shaders.js?v=223'
import { terrainShaders } from '../walker/shaders-terrain.js?v=223'
import { createWorld, TERRAIN_SIZE, BANDS } from './world.js?v=223'
import { treeShaders } from './shaders.js?v=223'

const PARAMS = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
const BARE = PARAMS.has('bare')
const FORCE_SNAPSHOT = PARAMS.has('snapshot')
const MODE_PARAM = PARAMS.get('mode')
const N_PARAM = Number(PARAMS.get('trees')) || 2450

const SKY = [0.56, 0.66, 0.78]
const LIGHT = [0.45, 0.78, 0.42]
const HYST = 6

const democtl = { pause() {}, resume() {} }
const shell = window.RuneDemoShell.mount({
  layout: 'fullscreen',
  title: 'The dense forest — one tree, instanced',
  desc: 'ОДНО дерево (подокарп, 310k полигонов: 302k листвы + 8k коры), засаженное в густой лес ~2.4k инстансов — с полным стеком оптимизаций: квантованные вершины (i16/i8, 16 Б против 32), вложенная LOD-лестница (подмножества — z-fill консервативен по построению), клетки + дистанционные бэнды на CPU (ранги записей — единицы дро-коллов), Hi-Z пирамида (террейн + прокси-глубина деревьев дважды за кадр, вердикт-коллапс в вершинном шейдере, K=6 гистерезис), single-pass present + 4x MSAA сёрфас. Task 223.',
  hint: 'DRAG — орбита камеры · колесо/пинч — зум. Камера кружит по поляне в гуще леса: ближние деревья — полные 131k-треугольные LOD0, дальние дешевеют по лестнице и КУЛЛЯТСЯ друг за другом (счётчики drawn/occluded в HUD). Стой неподвижно — вердикты замирают (нулевые флипы).',
  defaults: { mode: MODE_PARAM === 'webgl2' ? 'webgl2' : 'webgpu' },
  onPause() { democtl.pause() },
  onResume() { democtl.resume() },
  onMode(mode) {
    const next = mode === 'webgl2' ? 'webgl2' : 'webgpu'
    void bootTier(next)
  },
})

const errors = []
// ── THE FIELD LOG (Task 224 — the phone report's «там нет ничего лога,
// только инфобокс сверху»): the shell's log panel lives behind the FAB
// sheet — on a phone in the field that is a HIDDEN drawer, and a
// present-lane death leaves the screen black with the evidence locked
// away. The HUD itself now carries the tail: the boot shape, the
// validation verdict, every failed law, and every device error ride the
// SCREEN — the channel that would have shown this round's own bug as
// on-screen text («a validation error killed the submit») instead of a
// bare black flicker.
const fieldLog = []
function fieldNote(tag, message) {
  fieldLog.push(`${tag} ${message}`)
  if (fieldLog.length > 5) fieldLog.shift()
}
function noteError(message) {
  errors.push(message)
  if (typeof window !== 'undefined') window.__forestErrs = errors.slice()
  fieldNote('ERR', message)
  shell.log.error(message)
}

// ── the asset: tree.bin.gz → the quantized LOD geometries + the textures ──
async function loadTree() {
  const res = await fetch(new URL('assets/tree.bin.gz', import.meta.url))
  if (!res.ok) throw new Error(`tree.bin.gz: HTTP ${res.status}`)
  const gzBuf = await res.arrayBuffer()
  let buf
  if (typeof DecompressionStream === 'function') {
    const stream = new Response(new Blob([gzBuf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    buf = new Uint8Array(await stream)
  } else {
    throw new Error('DecompressionStream is unavailable — the packed tree asset cannot load (a modern browser is required)')
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (magic !== 'FTRE') throw new Error(`tree.bin.gz: bad magic ${magic}`)
  const version = dv.getUint32(4, true)
  const lods = dv.getUint32(8, true)
  const mats = dv.getUint32(12, true)
  if (version !== 2) throw new Error(`tree.bin.gz: version ${version} (expected 2)`)
  const heads = []
  let off = 16
  for (let i = 0; i < lods * mats; i++) {
    const vertCount = dv.getUint32(off, true)
    const indexCount = dv.getUint32(off + 4, true)
    const posMin = [dv.getFloat32(off + 8, true), dv.getFloat32(off + 12, true), dv.getFloat32(off + 16, true)]
    const posMax = [dv.getFloat32(off + 20, true), dv.getFloat32(off + 24, true), dv.getFloat32(off + 28, true)]
    const uvMin = [dv.getFloat32(off + 32, true), dv.getFloat32(off + 36, true)]
    const uvMax = [dv.getFloat32(off + 40, true), dv.getFloat32(off + 44, true)]
    heads.push({ vertCount, indexCount, posMin, posMax, uvMin, uvMax })
    off += 48
  }
  const meshes = []
  if (mats !== 3) throw new Error(`tree.bin.gz: ${mats} materials (expected 3: bark/leaf/proxy)`)
  for (const h of heads) {
    const n = h.vertCount
    const posBytes = n * 8
    const nrmBytes = n * 4
    const uvBytes = n * 4
    const positions = new Int16Array(buf.buffer, buf.byteOffset + off, n * 4); off += posBytes
    const normals = new Int8Array(buf.buffer, buf.byteOffset + off, n * 4); off += nrmBytes
    const uvs = new Int16Array(buf.buffer, buf.byteOffset + off, n * 2); off += uvBytes
    const indices = new Uint32Array(buf.buffer, buf.byteOffset + off, h.indexCount * 3); off += h.indexCount * 12
    meshes.push({
      positions, normals, uvs, indices,
      vertexCount: n,
      posMin: h.posMin, posMax: h.posMax, uvMin: h.uvMin, uvMax: h.uvMax,
    })
  }
  // the textures: decode + CPU mip chains (the device uploads level by level)
  const chain = async url => {
    const r = await fetch(new URL(url, import.meta.url))
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
    const bm = await createImageBitmap(await r.blob())
    const out = [bm]
    let w = bm.width, hgt = bm.height, src = bm
    while (w > 1 || hgt > 1) {
      w = Math.max(1, w >> 1)
      hgt = Math.max(1, hgt >> 1)
      src = await createImageBitmap(src, { resizeWidth: w, resizeHeight: hgt, resizeQuality: 'low' })
      out.push(src)
    }
    return out
  }
  const [leafChain, barkChain] = await Promise.all([chain('assets/leaf.jpg'), chain('assets/bark.jpg')])
  return { lods, mats, meshes, leafChain, barkChain }
}

// ── the camera (orbit) ─────────────────────────────────────────────────────
const cam = { yaw: 0.6, pitch: 0.18, radius: 30, target: [0, 0, 0], fov: Math.PI / 3 }
let MVP = new Float32Array(16)
function cameraAt(aspect) {
  // the spherical orbit: pitch is the ELEVATION (sin up, cos out).
  // NOTE the scene.js math's own shape: perspective/lookAt/mat4Mul RETURN
  // new arrays (the walker's pinned lesson — a (out, a, b) call leaves the
  // out array ZEROED and every w-clip degenerate: all-straddle verdicts,
  // an empty screen)
  const cp = Math.cos(cam.pitch)
  const ex = cam.target[0] + Math.sin(cam.yaw) * cp * cam.radius
  const ey = cam.target[1] + Math.sin(cam.pitch) * cam.radius
  const ez = cam.target[2] + Math.cos(cam.yaw) * cp * cam.radius
  const eye = [ex, ey, ez]
  const fov = cam.fov * Math.min(1.5, Math.max(1, (16 / 9) / aspect))
  const PROJ = perspective(fov, aspect, 0.5, 420)
  const VIEW = lookAt(eye, cam.target, [0, 1, 0])
  MVP = mat4Mul(PROJ, VIEW)
  return { mvp: MVP, eye }
}

// ── the boot + the tier ────────────────────────────────────────────────────
let tier = null
let bootToken = 0
const stats = {
  backend: null, kind: null, frame: 0, presents: 0,
  drawn: -1, occluded: -1, frustumCulled: -1, total: 0,
  runs: [0, 0, 0, 0], instances: [0, 0, 0, 0],
  fps: 0, validation: null, checks: [], errors: 0,
  loadMs: 0, bytes: 0, tail: fieldLog,
}
if (typeof window !== 'undefined') window.__forest = stats

async function bootTier(backend) {
  const token = ++bootToken
  const t0 = performance.now()
  const asset = await loadTree()
  if (token !== bootToken) return
  stats.loadMs = Math.round(performance.now() - t0)

  if (tier !== null) { try { tier.dispose() } catch { /* already dead */ } tier = null }
  const stage = document.getElementById('stage') ?? document.body
  const bootCanvas = document.createElement('canvas')
  const device = await createDevice({
    backend,
    canvas: bootCanvas,
    clear: { color: SKY, depth: 1 },
    antialias: backend === 'webgl2',
    dprCap: 2,
    onError: noteError,
    onInfo: message => shell.log.info(message),
  })
  if (token !== bootToken) { device.dispose(); return }
  const FORCE_LIVE = PARAMS.has('live')
  const SNAPSHOT = backend === 'webgpu' && !FORCE_LIVE && (FORCE_SNAPSHOT || device.software)
  const MODE = SNAPSHOT ? 'snapshot' : 'live'
  if (SNAPSHOT) {
    // the documented container class: a software WG canvas present kills
    // the GPU process — the snapshot degrade (the tier's own ladder)
    shell.log.info('the software WG adapter — the snapshot degrade (zero canvas presents)')
  }

  // the surface: the stage's shape × the boot dpr, the caps' ladder
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1, 2)
  let SURF_W = Math.max(2, Math.round((stage.clientWidth || 480) * dpr))
  let SURF_H = Math.max(2, Math.round((stage.clientHeight || 270) * dpr))
  const CAP = device.software ? 155_520 : 1_048_576
  const area = SURF_W * SURF_H
  if (area > CAP) {
    const s = Math.sqrt(CAP / area)
    SURF_W = Math.max(2, Math.floor(SURF_W * s))
    SURF_H = Math.max(2, Math.floor(SURF_H * s))
  }
  let SAMPLES = device.software ? 1 : 4
  let surface = null
  for (;;) {
    try {
      surface = device.surface(SURF_W, SURF_H, { depth: true, samples: SAMPLES })
      break
    } catch (e) {
      if (SAMPLES === 1) throw e
      noteError(`the ${SAMPLES}x MSAA surface was refused (${e instanceof Error ? e.message : String(e)}) — the surface re-boots at 1x`)
      SAMPLES = 1
    }
  }

  // the world (the records + the cells) — the tree's own bounds feed the AABBs
  const treeBounds = {
    min: asset.meshes[1].posMin, // LOD0/leaf spans the whole tree
    max: asset.meshes[1].posMax,
  }
  // THE SOFTWARE LADDER: SwiftShader cannot carry the showcase bands (a
  // single LOD0 tree is 139k tris — the container legs would crawl); the
  // soft legs clamp the band radii (the LOD0 showcase shrinks to the
  // trees beside the camera, the far bands do the culling showcase)
  const SOFT = device.software
  if (SOFT) {
    BANDS[0] = 18; BANDS[1] = 48; BANDS[2] = 105
  }
  const world = createWorld(treeBounds, { trees: SOFT ? Math.min(N_PARAM, 320) : N_PARAM })
  stats.total = world.N

  // the scene + the bricks
  const sceneHandle = device.scene({
    total: world.N,
    occluders: 0,
    words: world.sceneWords,
    recordsF32: world.sceneF32.subarray(world.INST_OFF),
    flagsWord: world.FLAGS_OFF,
    histWord: world.HIST_OFF,
    recordsWord: world.INST_OFF,
    stride: world.STRIDE,
    fields: world.FIELDS,
  })
  const dict = buildShaders({ N: world.N, INST_OFF: world.INST_OFF, FLAGS_OFF: world.FLAGS_OFF, HIST_OFF: world.HIST_OFF, STRIDE: world.STRIDE, FIELDS: world.FIELDS }, { w: SURF_W, h: SURF_H })
  const tsh = treeShaders({ INST_OFF: world.INST_OFF, HIST_OFF: world.HIST_OFF, STRIDE: world.STRIDE })
  const pyramid = device.pyramid(SURF_W, SURF_H)
  const occl = device.occlusionPass({ scene: sceneHandle, pyramid, kernel: dict.cull })
  const smooth = device.hysteresisPass({ scene: sceneHandle, frames: HYST })
  const blitProg = device.program({ depth: { test: 'always', write: false }, cull: 'none', wg: dict.blit.wg, gl: dict.blit.gl })
  // THE PYRAMID VIEW (the field's own eyes — ?pyr=1 draws level 2's
  // max-reduced tile over the frame; the occlusion's own X-ray)
  const strip = PARAMS.has('pyr') ? device.debugStrip({ pyramid, shaders: dict.panel }) : null
  const terrainZProg = device.program({ depth: { test: 'less', write: true }, cull: 'back', wg: terrainShaders.z.wg, gl: terrainShaders.z.gl })
  const terrainColorProg = device.program({ depth: { test: 'less', write: true }, cull: 'back', wg: terrainShaders.color.wg, gl: terrainShaders.color.gl })
  const barkZProg = device.program({ depth: { test: 'less', write: true }, cull: 'back', wg: tsh.barkZ.wg, gl: tsh.barkZ.gl })
  const leafZProg = device.program({ depth: { test: 'less', write: true }, cull: 'none', wg: tsh.leafZ.wg, gl: tsh.leafZ.gl })
  const barkColorProg = device.program({ depth: { test: 'less', write: true }, cull: 'back', wg: tsh.barkColor.wg, gl: tsh.barkColor.gl })
  const leafColorProg = device.program({ depth: { test: 'less', write: true }, cull: 'none', wg: tsh.leafColor.wg, gl: tsh.leafColor.gl })
  const leafTex = device.texture(asset.leafChain, { wrap: 'repeat' })
  const barkTex = device.texture(asset.barkChain, { wrap: 'repeat' })

  // the meshes: [lod][mat] — mat 0 bark, 1 leaf, 2 THE OCCLUDER PROXY
  // (the canopy's solid core — depth-only, never colored)
  const mesh = (L, m) => asset.meshes[L * 3 + m]

  // the stage canvas
  let displayCanvas = null
  let snapshot2d = null
  if (MODE === 'snapshot') {
    displayCanvas = document.createElement('canvas')
    displayCanvas.width = SURF_W
    displayCanvas.height = SURF_H
    snapshot2d = displayCanvas.getContext('2d')
  } else {
    displayCanvas = bootCanvas
  }
  displayCanvas.id = 'hiz-canvas'
  displayCanvas.className = 'hiz-canvas'
  for (const c of stage.querySelectorAll('#hiz-canvas')) c.remove()
  stage.appendChild(displayCanvas)
  stage.appendChild(hud)
  attachControls(displayCanvas)

  // ── the uniform blocks (packed once per draw) ─────────────────────────
  const treeBlock = new Float32Array(40) // mvp 16 + misc 4 + posMin 4 + posScale 4 + uvA 4 + light 4 + cam 4
  const zBlock = new Float32Array(40)
  function packTree(block, m, mvp, base, collapse, eye) {
    block.set(mvp, 0)
    block[16] = base; block[17] = collapse ? 1 : 0; block[18] = 0; block[19] = 0
    block[20] = m.posMin[0]; block[21] = m.posMin[1]; block[22] = m.posMin[2]; block[23] = 0
    block[24] = m.posMax[0] - m.posMin[0]; block[25] = m.posMax[1] - m.posMin[1]; block[26] = m.posMax[2] - m.posMin[2]; block[27] = 0
    block[28] = m.uvMin[0]; block[29] = m.uvMin[1]; block[30] = m.uvMax[0]; block[31] = m.uvMax[1]
    block[32] = LIGHT[0]; block[33] = LIGHT[1]; block[34] = LIGHT[2]; block[35] = 0
    block[36] = eye[0]; block[37] = eye[1]; block[38] = eye[2]; block[39] = 0
  }

  // ── the bands walker: cells → runs, per LOD band ─────────────────────
  const planes = new Float32Array(24)
  function computeRuns(mvp, eye) {
    frustumPlanes(mvp, planes)
    const lists = [[], [], [], []]
    const { side, start, count, aabb } = world.cells
    for (let c = 0; c < side * side; c++) {
      if (count[c] === 0) continue
      const o = c * 6
      // the predicate's own shape: center + half extents
      const cx = (aabb[o] + aabb[o + 3]) * 0.5
      const cy = (aabb[o + 1] + aabb[o + 4]) * 0.5
      const cz = (aabb[o + 2] + aabb[o + 5]) * 0.5
      const hx = (aabb[o + 3] - aabb[o]) * 0.5
      const hy = (aabb[o + 4] - aabb[o + 1]) * 0.5
      const hz = (aabb[o + 5] - aabb[o + 2]) * 0.5
      if (aabbOutsideFrustum(planes, cx, cy, cz, hx, hy, hz)) continue
      // THE BAND DISTANCE = the AABB's NEAREST POINT to the eye (the cell
      // CENTER lies — a 24 m cell whose center sits 20 m out can hold the
      // trees 2 m from the eye; the box distance is the conservative
      // banding: a boundary tree rides the NEARER band, a superset for
      // the color and a subset-safe z-fill alike)
      const dx = Math.max(Math.abs(eye[0] - cx) - hx, 0)
      const dz = Math.max(Math.abs(eye[2] - cz) - hz, 0)
      const d = Math.hypot(dx, dz)
      const band = d < BANDS[0] ? 0 : d < BANDS[1] ? 1 : d < BANDS[2] ? 2 : 3
      lists[band].push(c)
    }
    const runs = []
    for (let b = 0; b < 4; b++) {
      const rr = []
      for (const c of lists[b]) {
        const s = start[c]
        const last = rr[rr.length - 1]
        if (last !== undefined && last.base + last.count === s) last.count += count[c]
        else rr.push({ base: s, count: count[c] })
      }
      runs.push(rr)
    }
    // THE SOFTWARE LOD0 CAP: a single showcase tree is 139k tris — the
    // software legs (SwiftShader: WG snapshot / GL) cannot carry a wall of
    // them (the container renderer dies). The soft legs keep at most SIX
    // band-0 trees (the nearest runs, trimmed mid-run); the real GPUs
    // (the phone, the desktop) run the full showcase.
    if (SOFT) {
      let budget = 6
      const trimmed = []
      for (const r of runs[0]) {
        if (budget <= 0) break
        if (r.count <= budget) { trimmed.push(r); budget -= r.count }
        else { trimmed.push({ base: r.base, count: budget }); budget = 0 }
      }
      runs[0] = trimmed
    }
    return runs
  }

  // ── the declared frame ────────────────────────────────────────────────
  const fg = createFrameGraph()
  const R = {
    scene: fg.resource({ name: 'scene', kind: 'buffer', bytes: world.sceneWords.length * 4, transient: false, external: sceneHandle, exported: true }),
    hiz: fg.resource({ name: 'hi-z', kind: 'texture', width: SURF_W, height: SURF_H, format: 'r32f', transient: false, external: pyramid }),
    terrainMesh: fg.resource({ name: 'terrain-mesh', kind: 'buffer', bytes: (world.terrainGeometry.positions.length + (world.terrainGeometry.normals?.length ?? 0) + (world.terrainGeometry.uvs?.length ?? 0)) * 4, transient: false, external: { mesh: true, vertexCount: world.terrainGeometry.vertexCount } }),
    treeMesh: fg.resource({ name: 'tree-meshes', kind: 'buffer', bytes: 0, transient: false, external: { mesh: true, vertexCount: 1 } }),
    target: fg.resource({ name: 'target', kind: 'texture', width: SURF_W, height: SURF_H, transient: false, external: surface }),
  }
  const endTilePass = () => { if (device.gpu !== null) device.gpu.endPass() }
  let lastFrame = null
  let lastReport = null
  // the kernel lane: WG compute / GL render (the tier's own law — the
  // cull/reduce mechanisms ride the backend's own lane)
  const KERNEL = device.backend === 'webgpu' ? 'compute' : 'render'
  fg.pass({
    name: 'terrain-z', kind: 'render', cost: 2,
    reads: [R.terrainMesh], writes: [R.hiz],
    execute: ({ props }) => {
      zBlock.set(props.camera.mvp, 0)
      device.drawMesh({ target: pyramid.zTarget, clear: true, program: terrainZProg, geometry: world.terrainGeometry, uniforms: zBlock })
      endTilePass()
    },
  })
  fg.pass({
    // phase 1 — the conservative occluder fill: EVERY frustum tree at the
    // LOD3 proxy (a strict subset of every band's color LOD — the pyramid
    // built from it can only UNDER-occlude, never falsely cull)
    name: 'tree-z', kind: 'render', cost: 3,
    reads: [R.scene, R.treeMesh, R.hiz], writes: [R.hiz],
    execute: ({ props }) => {
      // THE OCCLUDER LADDER: bands 0-2 at a CONSERVATIVE coarser LOD
      // (band0/1 → LOD1, band2 → LOD2 — every one a strict subset of the
      // band's color coverage: the pyramid can only UNDER-occlude); the
      // FAR band never writes depth (it occludes nothing behind it and
      // its crowd would cost more than the whole refine)
      for (let band = 0; band < 3; band++) {
        const lod = band <= 1 ? 1 : 2
        for (let m = 0; m < 2; m++) {
          const g = mesh(lod, m)
          for (const run of props.runs.byBand[band]) {
            packTree(treeBlock, g, props.camera.mvp, run.base, false, props.camera.eye)
            device.drawMeshInstanced({ target: pyramid.zTarget, clear: false, program: m === 0 ? barkZProg : leafZProg, geometry: g, uniforms: treeBlock, records: sceneHandle, baseInstance: run.base, instances: run.count })
          }
        }
      }
      // THE OCCLUDER PROXY (bands 0-2): the canopy's SOLID core — the
      // foliage is a sieve and a max-reduced pyramid can never cull behind
      // a hole; the core boxes make the near/mid trees real occluders
      {
        const g = mesh(0, 2)
        for (let band = 0; band < 3; band++) {
          for (const run of props.runs.byBand[band]) {
            packTree(treeBlock, g, props.camera.mvp, run.base, false, props.camera.eye)
            device.drawMeshInstanced({ target: pyramid.zTarget, clear: false, program: leafZProg, geometry: g, uniforms: treeBlock, records: sceneHandle, baseInstance: run.base, instances: run.count })
          }
        }
      }
      endTilePass()
    },
  })
  fg.pass({
    name: 'pyramid-reduce', kind: KERNEL, cost: 2,
    reads: [R.hiz], writes: [R.hiz],
    execute: () => pyramid.build(),
  })
  fg.pass({
    name: 'cull-verdicts', kind: KERNEL, cost: 1,
    reads: [R.scene, R.hiz], writes: [R.scene],
    execute: ({ props }) => occl.run({ camera: props.camera, gate: true }),
  })
  fg.pass({
    // phase 2 — THE TILE REBUILD: the terrain redraws FRESH (the phase-1
    // fill included the to-be-occluded trees — their depth must not pollute
    // the final pyramid), then the VISIBLE set merges (the verdict
    // collapse) — the two-pass HZB's own law, the walker's shape
    name: 'z-refine', kind: 'render', cost: 4,
    reads: [R.scene, R.terrainMesh, R.treeMesh, R.hiz], writes: [R.hiz],
    execute: ({ props }) => {
      zBlock.set(props.camera.mvp, 0)
      device.drawMesh({ target: pyramid.zTarget, clear: true, program: terrainZProg, geometry: world.terrainGeometry, uniforms: zBlock })
      // THE VISIBLE SET at its OWN color LOD (the exact coverage — the
      // strongest pyramid; bands 0-2 only, the far band never occludes)
      for (let band = 0; band < 3; band++) {
        for (let m = 0; m < 2; m++) {
          const g = mesh(band, m)
          for (const run of props.runs.byBand[band]) {
            packTree(treeBlock, g, props.camera.mvp, run.base, true, props.camera.eye)
            device.drawMeshInstanced({ target: pyramid.zTarget, clear: false, program: m === 0 ? barkZProg : leafZProg, geometry: g, uniforms: treeBlock, records: sceneHandle, baseInstance: run.base, instances: run.count })
          }
        }
      }
      // the visible set's own solid cores (the refine's occluders)
      {
        const g = mesh(0, 2)
        for (let band = 0; band < 3; band++) {
          for (const run of props.runs.byBand[band]) {
            packTree(treeBlock, g, props.camera.mvp, run.base, true, props.camera.eye)
            device.drawMeshInstanced({ target: pyramid.zTarget, clear: false, program: leafZProg, geometry: g, uniforms: treeBlock, records: sceneHandle, baseInstance: run.base, instances: run.count })
          }
        }
      }
      endTilePass()
    },
  })
  fg.pass({
    name: 'pyramid-reduce-2', kind: KERNEL, cost: 2,
    reads: [R.hiz], writes: [R.hiz],
    execute: () => pyramid.build(),
  })
  fg.pass({
    name: 'cull-verdicts-2', kind: KERNEL, cost: 1,
    reads: [R.scene, R.hiz], writes: [R.scene],
    execute: ({ props }) => occl.run({ camera: props.camera, gate: true }),
  })
  fg.pass({
    name: 'hysteresis', kind: KERNEL, cost: 1,
    reads: [R.scene], writes: [R.scene],
    execute: () => smooth.run({ gate: true }),
  })
  fg.pass({
    name: 'terrain-color', kind: 'render', cost: 3,
    reads: [R.terrainMesh], writes: [R.target],
    execute: ({ props }) => {
      const b = treeBlock
      b.set(props.camera.mvp, 0)
      b[16] = SURF_H; b[17] = 150; b[18] = 260; b[19] = 0 // misc: surfaceH, fogNear, fogFar (the terrain contract)
      b[20] = LIGHT[0]; b[21] = LIGHT[1]; b[22] = LIGHT[2]; b[23] = 0
      b[24] = props.camera.eye[0]; b[25] = props.camera.eye[1]; b[26] = props.camera.eye[2]; b[27] = 1
      device.drawMesh({ target: props.target, clear: true, program: terrainColorProg, geometry: world.terrainGeometry, uniforms: b })
      endTilePass()
    },
  })
  fg.pass({
    name: 'tree-color', kind: 'render', cost: 8,
    reads: [R.scene, R.treeMesh, R.target], writes: [R.target],
    execute: ({ props }) => {
      for (let band = 0; band < 4; band++) {
        for (let m = 0; m < 2; m++) {
          const g = mesh(band, m)
          for (const run of props.runs.byBand[band]) {
            packTree(treeBlock, g, props.camera.mvp, run.base, true, props.camera.eye)
            device.drawMeshInstanced({ target: props.target, clear: false, program: m === 0 ? barkColorProg : leafColorProg, geometry: g, uniforms: treeBlock, records: sceneHandle, baseInstance: run.base, instances: run.count, texture: m === 0 ? barkTex : leafTex })
          }
        }
      }
      if (strip !== null) strip.run({ target: props.target, level: 2 })
      endTilePass()
    },
  })
  let pendingStats = null
  let statsInFlight = false // THE 211 DISCIPLINE: one async readback at a
  // time on a live loop (a pile of concurrent mapAsync starves SwiftShader
  // WG — the consume used to clear pendingStats BEFORE the resolve, arming
  // a fresh read every cycle while the old ones hung)
  fg.pass({
    // THE STATS EXPORT (the copy lane — the tier's own): the readback rides
    // the frame's own graph, beside the color render. THE GATE reads the
    // POLICY PROP (a closure over a mutable would freeze at the first
    // compile — the cache never re-evaluates it; the framegraph's own law)
    name: 'read-stats', kind: 'copy', cost: 1,
    reads: [R.scene],
    // THE 211 DISCIPLINE, SHARPENED: the GL leg's flag sweep is a SYNC
    // readback (safe mid-loop); the WG leg's scene-storage readback
    // MID-LOOP is the poison — one hung mapAsync (the scene is bound in
    // the frame's unsubmitted passes) kills every later readback on the
    // device. The WG legs read ONLY on a paused loop (the validation's
    // own discipline); the HUD's drawn rides the GL legs and the
    // validation channel everywhere.
    when: props => props.wantStats === true && !statsInFlight,
    execute: () => {
      statsInFlight = true
      // THE COUNTS CHANNEL (Task 223's own law): the compact writes the
      // verdict counters into the ARGS buffer — an UNBOUND buffer whose
      // readback is the safe class on every queue; the scene-storage
      // readback mid-loop is the 211-class poison on software WG (one
      // hung mapAsync kills every later read — the field isolation's own
      // pinned lesson)
      if (device.runCullCompact(sceneHandle)) {
        device.submit()
        pendingStats = device.readCullStats(sceneHandle)
      } else {
        pendingStats = device.readCullStats(sceneHandle)
      }
    },
  })
  fg.pass({
    // THE FRAME BOUNDARY — a present-kind pass is a ROOT (the branch
    // culling's own anchor: without a root the whole frame is a dead
    // branch and leaves the compiled frame — the first smoke's lesson)
    name: 'present', kind: 'present', cost: 1,
    reads: [R.target],
    execute: () => {
      present()
      device.submit()
    },
  })

  // ── the snapshot present ──────────────────────────────────────────────
  let blitPending = false
  let blitLanded = 0
  let presentEvery = 1
  function present() {
    // THE PRESENT LEDGER: every invocation counts (the walker's own
    // witness). The frame's own law: presents === frameIndex (+1 mid-
    // frame) — a present() called anywhere else on the frame path doubles
    // the count and the regression is measurable from the field itself.
    stats.presents++
    if (MODE === 'snapshot') {
      // THE READBACK LANE'S AIR: the snapshot present reads the surface
      // EVERY frame on a 60fps software leg — an endless mapAsync chain
      // that starves every other readback (the stats/validation lanes
      // hung for 25s+ behind it). Present every 3rd frame: the software
      // degrade's honest budget, and the lane breathes.
      presentEvery = (presentEvery + 1) % 3
      if (presentEvery !== 0 || blitPending) return
      blitPending = true
      surface.read().then(result => {
        blitPending = false
        if (snapshot2d !== null && result.data.length === SURF_W * SURF_H * 4) {
          snapshot2d.putImageData(new ImageData(new Uint8ClampedArray(result.data.buffer, result.data.byteOffset, result.data.length), SURF_W, SURF_H), 0, 0)
          blitLanded++
        }
      }).catch(() => { blitPending = false })
    } else {
      device.blitToCanvas({ program: blitProg, surface })
    }
  }

  // ── the frame ─────────────────────────────────────────────────────────
  let frameIndex = 0
  let paused = false
  let validationActive = false // the validation owns the stats channel while it runs
  function frame() {
    if (paused) return
    const aspect = (stage.clientWidth || 480) / Math.max(1, stage.clientHeight || 270)
    const camera = cameraAt(aspect)
    const runs = computeRuns(camera.mvp, camera.eye)
    const all = []
    for (const rr of runs) all.push(...rr)
    const byBand = runs
    let instCount = [0, 0, 0, 0]
    for (let b = 0; b < 4; b++) for (const r of runs[b]) instCount[b] += r.count
    // the stats ride the graph's own copy lane (the queue order is the
    // write order — the readback lands after the frame's culls)
    const wantStats = frameIndex % 12 === 0 && !validationActive
    const props = { camera, runs: { all, byBand }, target: surface.targetId, wantStats }
    lastFrame = fg.compile(props)
    lastReport = lastFrame.run(props)
    // THE ONE-PRESENT LAW (Task 224 — the phone report's «постоянно мигает
    // на чёрный экран, потом появляется террейн, деревья могут появиться,
    // а могут и нет»): the present pass above IS the frame boundary — ONE
    // blit, submitted inside the frame that encoded it. A present() call
    // HERE was a SECOND canvas pass opened into a fresh encoder with no
    // submit of its own: the pass rode the NEXT frame's submit against an
    // EXPIRED canvas texture (getCurrentTexture() hands each frame its own
    // texture and the compositor expires it at the frame boundary), the
    // validation error killed the WHOLE submit — the next frame's own blit
    // included — and every other frame never presented. The phone's
    // overlay canvas answers a missed present with BLACK (the content-
    // black class, the canvas-pass law's own family — Tasks 198/219/221),
    // and the surviving frames carried the orbiting camera — terrain,
    // then a variable set of trees, then none. One frame, one blit, one
    // submit — the occlusion tier's own phone-proven boundary (tier.js's
    // present pass: blit + submit, nothing after).
    frameIndex++
    // the counters
    stats.frame = frameIndex
    stats.backend = backend
    stats.kind = MODE
    stats.runs = runs.map(r => r.length)
    stats.instances = instCount
    stats.errors = errors.length
    if (pendingStats !== null) {
      const p = pendingStats
      pendingStats = null
      p.then(s => {
        statsInFlight = false
        stats.drawn = s.drawn
        stats.occluded = s.occluded
        stats.frustumCulled = s.frustum
      }).catch(() => { statsInFlight = false })
    }
    requestAnimationFrame(frame)
  }
  stats.bytes = asset.meshes.reduce((a, m) => a + m.positions.byteLength + m.normals.byteLength + m.uvs.byteLength + m.indices.byteLength, 0)
  democtl.pause = () => { paused = true }
  democtl.resume = () => { if (paused) { paused = false; requestAnimationFrame(frame) } }

  tier = {
    device, backend, mode: MODE, surface, sceneHandle, pyramid, world,
    cameraAt, computeRuns, fg,
    beginValidationReads() { validationActive = true },
    endValidationReads() { validationActive = false },
    graphStats: () => lastFrame === null ? null : {
      live: lastFrame.passes.map(p => p.name),
      stats: { ...lastFrame.stats },
    },
    readStats: () => {
      if (pendingStats !== null) {
        const p = pendingStats
        pendingStats = null
        statsInFlight = false // the stolen promise releases the lane (the
        // copy pass's own consume never sees it — the in-flight gate would
        // stay latched and the HUD's drawn would freeze at -1 forever)
        return p
      }
      // WG: the args-buffer stats (the compact fills the counters — see
      // the copy lane's own note; NEVER the scene storage mid-loop)
      if (device.runCullCompact(sceneHandle)) {
        device.submit()
      }
      return device.readCullStats(sceneHandle)
    },
    readVerdicts: () => device.readVerdicts(sceneHandle),
    setCamera(yaw, pitch, radius) {
      cam.yaw = yaw; cam.pitch = pitch; cam.radius = radius
      cam.target[1] = world.terrainSampler(0, 0) + 5
      return cameraAt((stage.clientWidth || 480) / Math.max(1, stage.clientHeight || 270))
    },
    present,
    pause() { paused = true },
    resume() { democtl.resume() },
    frameNow: () => frameIndex,
    dispose() {
      paused = true
      try { device.dispose() } catch { /* gone */ }
    },
  }
  cam.target[1] = world.terrainSampler(0, 0) + 5
  if (typeof window !== 'undefined') window.__tier = tier
  // the boot shape rides the screen (the field log's first line): the
  // backend, the tier (live/snapshot), the soft flag, the surface, the load
  fieldNote('boot', `${backend} ${MODE}${device.software ? ' (soft)' : ''} · ${SURF_W}×${SURF_H}@${SAMPLES}x · ${stats.loadMs} ms · ${world.N} trees`)
  shell.markReady()
  requestAnimationFrame(frame)
  if (!BARE) void runValidation()
}

// ── the HUD (the walker's own pattern — a pre over the stage) ──────────────
const hud = document.createElement('pre')
hud.className = 'walker-hud'
// the HUD rides the body from module init — a load-time failure (the
// asset fetch, the boot refusal) must find the tail ALREADY on screen,
// not wait for a boot that never comes
if (typeof document !== 'undefined') document.body.appendChild(hud)
function refreshHud() {
  // THE FIELD LOG's tail (Task 224): the last lines ride the screen —
  // escaped (a device error message owns no HTML privileges here)
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const tail = fieldLog.map(l => esc(l)).join('\n')
  if (tier === null) {
    if (fieldLog.length > 0) hud.textContent = tail
    return
  }
  const [r0, r1, r2, r3] = stats.runs
  const [i0, i1, i2, i3] = stats.instances
  hud.innerHTML =
    `<b>forest</b> ${stats.backend} ${stats.kind} · frame ${stats.frame} · present ${stats.presents} · load ${stats.loadMs} ms` +
    (errors.length > 0 ? ` · <b>err ${errors.length}</b>` : '') +
    `\ntrees ${stats.drawn < 0 ? '…' : `${stats.drawn}/${stats.total}`} drawn · ${stats.occluded} occluded · ${stats.frustumCulled} frustum` +
    `\nLOD bands ${i0}/${i1}/${i2}/${i3} trees in ${r0}/${r1}/${r2}/${r3} runs` +
    (stats.validation === null ? '\nvalidation: running…' : `\nvalidation: ${stats.validation.pass ? 'PASS' : 'FAIL'} — ${stats.validation.checks} laws`)
    + (tail.length > 0 ? `\n${tail}` : '')
}

// ── the controls: orbit drag + wheel zoom + pinch ─────────────────────────
function attachControls(canvas) {
  let dragId = -1
  let lastX = 0, lastY = 0
  let pinchDist = -1
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') {
      if (dragId === -1) { dragId = e.pointerId; lastX = e.clientX; lastY = e.clientY }
    } else {
      dragId = e.pointerId; lastX = e.clientX; lastY = e.clientY
    }
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointermove', e => {
    if (e.pointerId !== dragId) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX; lastY = e.clientY
    cam.yaw -= dx * 0.005
    cam.pitch = Math.min(1.2, Math.max(-0.35, cam.pitch + dy * 0.004))
  })
  const release = e => { if (e.pointerId === dragId) dragId = -1; pinchDist = -1 }
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)
  canvas.addEventListener('wheel', e => {
    e.preventDefault()
    cam.radius = Math.min(120, Math.max(9, cam.radius * (1 + Math.sign(e.deltaY) * 0.08)))
  }, { passive: false })
  canvas.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
      if (pinchDist > 0) cam.radius = Math.min(120, Math.max(9, cam.radius * (pinchDist / d)))
      pinchDist = d
      e.preventDefault()
    }
  }, { passive: false })
  canvas.addEventListener('touchend', e => { if (e.touches.length < 2) pinchDist = -1 })
}

// ── the boot validation (the deterministic orbit autopilot + the laws) ────
let validationDone = false
async function runValidation() {
  if (tier === null || validationDone) return
  validationDone = true
  const checks = []
  const check = (name, pass, detail = '') => {
    checks.push({ name, pass: pass === true, detail })
    stats.checks = checks.slice()
    stats.validation = { pass: checks.every(c => c.pass), checks: checks.length }
    if (!pass) {
      fieldNote('LAW', `${name} — ${detail}`)
      shell.log.error(`law failed: ${name} (${detail})`)
    }
  }
  const wait = frames => new Promise(resolve => {
    const target = tier.frameNow() + frames
    const poll = () => { tier.frameNow() >= target ? resolve() : setTimeout(poll, 60) }
    poll()
  })
  try {
    tier.beginValidationReads()
    const readWhilePaused = async fn => {
      // THE 211 DISCIPLINE: readbacks on a PAUSED loop (a live loop's
      // concurrent maps starve the software WG queue — the walker's own law)
      tier.pause()
      try {
        return await fn()
      } finally {
        tier.resume()
      }
    }
    // Phase A — the orbit sweep (the FULL loop on real GPUs; the SOFT legs
    // take the light branch — the elevated view draws a third of the wall
    // view's triangles and the container renderer dies under the heavy
    // one). The occlusion probe lands at the WALL LEVEL separately (the
    // eye in the canopy's own plane — the near crowns fill the view and
    // the far trees cull behind them; the elevated pitch sees over the
    // tops and the occlusion honestly reads zero)
    const SOFT_VAL = stats.total <= 340 // the software ladder's own cap
    const STEPS = SOFT_VAL ? 10 : 48
    const SWEEP_PITCH = SOFT_VAL ? 0.28 : 0.05
    tier.setCamera(0.6, SWEEP_PITCH, 30)
    let drawnMin = 1e9, drawnMax = -1, occludedMax = -1, frustumMax = -1
    for (let step = 0; step < STEPS; step++) {
      const yaw = 0.6 + (step / STEPS) * Math.PI * 2
      tier.setCamera(yaw, SWEEP_PITCH, 30)
      await wait(SOFT_VAL ? 3 : 4)
      const s = await readWhilePaused(() => tier.readStats())
      drawnMin = Math.min(drawnMin, s.drawn); drawnMax = Math.max(drawnMax, s.drawn)
      occludedMax = Math.max(occludedMax, s.occluded)
      frustumMax = Math.max(frustumMax, s.frustum)
    }
    // the occlusion probe: the wall level, one sample
    tier.setCamera(1.9, 0.05, 26)
    await wait(8)
    {
      const s = await readWhilePaused(() => tier.readStats())
      occludedMax = Math.max(occludedMax, s.occluded)
      drawnMin = Math.min(drawnMin, s.drawn)
      drawnMax = Math.max(drawnMax, s.drawn)
    }
    check('the drawn law — the forest renders (a healthy band, never all, never none)',
      drawnMin > stats.total * 0.03 && drawnMax < stats.total && drawnMax > 0,
      `drawn ${drawnMin}..${drawnMax} of ${stats.total}`)
    // the threshold scales with the forest: the real legs (2.4k trees,
    // full bands) measure in the hundreds; the software validation legs
    // (150 trees, clamped bands) honestly carry a handful — the MECHANISM
    // is the law, the count is the leg's own density
    check('the occlusion law — trees hide trees (the dense wall works)',
      occludedMax > (SOFT_VAL ? 4 : 20), `occluded max ${occludedMax}`)
    check('the frustum law — most of the forest is out of view',
      frustumMax > stats.total * 0.3, `frustum max ${frustumMax}`)
    // Phase B — the still-camera zero-flip law (Task 219's own). GL reads
    // the per-record verdicts (a SYNC readback — always safe); WG rides
    // the COUNTS channel (drawn/occluded/frustum/straddle — the scene
    // readback is the software-queue poison; a stable count set is the
    // honest zero-flip witness at the stats granularity)
    const WG = tier.backend === 'webgpu'
    tier.setCamera(1.1, 0.22, 26)
    await wait(8)
    let flips = 0
    let prev = null
    for (let f = 0; f < 10; f++) {
      if (WG) {
        const s = await readWhilePaused(() => tier.readStats())
        const key = `${s.drawn}/${s.frustum}/${s.occluded}/${s.straddle}`
        if (prev !== null && key !== prev) flips++
        prev = key
      } else {
        const v = await readWhilePaused(() => tier.readVerdicts())
        if (prev !== null) {
          for (let k = 0; k < v.length; k++) if (v[k] !== prev[k]) flips++
        }
        prev = v
      }
      await wait(1)
    }
    check('the still-camera zero-flip law — a frozen camera flips NO verdicts',
      flips === 0, `${flips} flips over 10 frames (${WG ? 'the counts channel' : 'the per-record verdicts'})`)
    // Phase C — the dive INTO the wall (radius 26 = the clearing's edge:
    // the eye among the first crowns — the LOD0 band's own showcase)
    tier.setCamera(1.1, 0.02, 26)
    await wait(8)
    const lodRuns = stats.runs[0]
    check('the LOD law — the near band carries runs (the full-detail trees)',
      lodRuns > 0, `LOD0 runs ${lodRuns}`)
    // the frame shape: the graph's live passes
    const g = tier.graphStats()
    check('the frame law — the declared passes live (terrain + trees + culls)',
      g !== null && g.live.includes('terrain-z') && g.live.includes('tree-z')
      && g.live.includes('cull-verdicts') && g.live.includes('tree-color'),
      g === null ? 'no graph' : g.live.join(','))
    check('zero page errors during the validation',
      errors.length === 0, errors.slice(0, 2).join(' | '))
  } catch (e) {
    check('the validation completed', false, e instanceof Error ? e.message : String(e))
  } finally {
    tier.endValidationReads()
  }
  const pass = checks.every(c => c.pass)
  stats.validation = { pass, checks: checks.length }
  fieldNote('valid', `${pass ? 'PASS' : 'FAIL'} — ${checks.filter(c => c.pass).length}/${checks.length} laws`)
  shell.log.info(`validation ${pass ? 'PASS' : 'FAIL'} — ${checks.filter(c => c.pass).length}/${checks.length} laws`)
  if (typeof window !== 'undefined' && window.__forestGate !== undefined && typeof window.__forestGate.resolve === 'function') {
    window.__forestGate.resolve({ pass, checks: checks.length, list: checks.slice() })
  }
}
if (typeof window !== 'undefined') {
  // the resolver, captured locally (the executor runs before the
  // assignment — window.__forestGate is undefined inside it; the walker's
  // own pinned lesson)
  let gateResolve = null
  const gate = new Promise(resolve => { gateResolve = resolve })
  gate.resolve = gateResolve
  window.__forestGate = gate
  window.addEventListener('error', e => {
    if (e && typeof e.message === 'string' && e.message.length > 0) noteError(`uncaught: ${e.message}`)
  })
  window.addEventListener('unhandledrejection', e => {
    const r = e && e.reason !== undefined ? e.reason : 'unknown'
    noteError(`unhandled rejection: ${r instanceof Error ? r.message : String(r)}`)
  })
}

// the HUD line (2 Hz — the walker's cadence)
setInterval(refreshHud, 500)

void bootTier(MODE_PARAM === 'webgl2' ? 'webgl2' : 'webgpu').catch(e => {
  noteError(`boot failed: ${e instanceof Error ? e.message : String(e)}`)
  if ((MODE_PARAM ?? 'webgpu') !== 'webgl2') {
    fieldNote('boot', 'the WebGPU boot refused — the WebGL2 leg takes over')
    shell.log.info('the WebGPU boot refused — the WebGL2 leg takes over')
    void bootTier('webgl2').catch(e2 => noteError(`the WebGL2 boot failed too: ${e2 instanceof Error ? e2.message : String(e2)}`))
  }
})
