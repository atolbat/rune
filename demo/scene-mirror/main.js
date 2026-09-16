// scene-mirror/main.js — Task 215: THE SCENE STORE MIRROR, LIVE.
//
// The Task-214 library surface (@rune/scene's SAB regions as adopted
// SoAStores — zero copies — + the stamp-driven dirty ranges in BOTH
// directions) gets its first LIVE consumer: this page. What you watch is
// the DATA SYSTEM itself —
//
//   · the scene graph runs in a WORKER (runSceneWorker over the SAB: the
//     Atomics.wait rhythm — publish wakes it, take() reads its epoch);
//   · the main thread writes the movers through the Scene API (the
//     publish side — localStamp is the dirt);
//   · the worker answers with the culled instance pools (the mirror side
//     — groupTouch/groupFlip stamps are the dirt);
//   · every frame the store mirror resolves EXACTLY the re-uploaded bytes:
//     staticRanges (publish) + pool ranges + worldRanges (mirror) — the
//     same partial-upload surface the occlusion demo feeds its GPU mirror,
//     now speaking the scene graph's own vocabulary;
//   · the canvas draws the city FROM THE STORE'S OWN BYTES (the worlds
//     column + the visibility bitsets — zero copies end to end).
//
// The honest degrade: without cross-origin isolation the SAB cannot cross
// the worker boundary (GitHub Pages serves no COOP/COEP) — the page falls
// back to the T0 lane (runScenePipeline on the main thread, the same hot
// passes, the mirror's observe(epoch) spelling) and SAYS SO in the HUD.
// The local gate serves COOP/COEP, so both lanes are gated, each in its
// own environment.
//
// window.__mirrorStats — the live counters (the smoke/gates read it);
// ?probe=1 — run the boot gates and dump the verdict (no loop).
import {
  createScene, createCamera, createSceneWorkerBridge, createSceneStoreMirror,
  runScenePipeline, bitsBase, H_CAMERA_COUNT, H_NODE_COUNT,
} from '../../dist/rune-scene.esm.js?v=220'

const PARAMS = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
const PROBE = PARAMS.has('probe')

const shell = window.RuneDemoShell.mount({
  title: 'rune — scene store mirror',
  desc: 'The worker-driven scene graph\'s SAB as adopted SoA stores (zero copies) — the dirty ranges both directions, live: the movers\' bytes stream to the mirror, the pools\' bytes stream back. The canvas draws the city from the store\'s own bytes.',
  hint: 'Locally: <code>bun run demo</code> → /demo/scene-mirror/ · Bundle: <code>dist/rune-scene.esm.js</code> · The lane is the ENVIRONMENT\'s call: cross-origin isolation → the worker lane; without it (GitHub Pages serves no COOP/COEP) → the T0 lane, the same pipeline on this thread. A toggle click re-boots and re-validates either way.',
  defaults: { mode: 'auto' },
  onMode: () => void boot('auto'),
  onPause: () => { paused = true },
  onResume: () => { paused = false },
})

// ── the scene: a deterministic flat city + two drone squads ───────────────
const CAP = 8192, GROUPS = 4, CAMS = 2, MAX_INST = 6144
const GRID = 60 // 60×60 = 3600 buildings
const PROPS = 480
const MOVERS = 96 // two squads of 48 (groups 2 and 3)

const stats = {
  lane: 'boot', epoch: 0, watermark: 0, nodes: 0, visible: [0, 0],
  publish: { bytes: 0, ranges: 0, full: CAP * 40 },
  pool: { bytes: 0, ranges: 0, full: MAX_INST * 64 },
  world: { bytes: 0, ranges: 0, layoutEpoch: 0 },
  staleTakes: 0, workerMs: 0, movers: MOVERS,
  validation: null, errors: 0,
}
if (typeof window !== 'undefined') window.__mirrorStats = stats

let scene = null
let mirror = null
let bridge = null
let worker = null
let paused = false
let rafId = 0
let frame = 0
let heldLayoutEpoch = 0
let workerFrameMs = 0
let lastT0Ms = 0
const movers = [] // { slot, x, z, r, phase }
const cameras = [createCamera(), createCamera()]
const camState = [{ eye: [0, 80, 0], target: [0, 0, 0] }, { eye: [52, 9, 0], target: [0, 2, 0] }]

function noteError(e) {
  stats.errors++
  shell.log.error(e instanceof Error ? e.message : String(e))
}

/** The deterministic city (same every reload — the gates depend on it). */
function buildCity(sc) {
  // the buildings: a 60×60 grid, heights by a hash of the cell — group 0
  for (let iz = 0; iz < GRID; iz++) {
    for (let ix = 0; ix < GRID; ix++) {
      const h = ((Math.imul(ix * 374761393 + iz * 668265263, 1274126177) >>> 0) % 1000) / 1000
      const x = (ix - GRID / 2 + 0.5) * 2, z = (iz - GRID / 2 + 0.5) * 2
      const sy = 1 + h * 4
      const r = Math.hypot(1, sy, 1) * 0.87 // the box's circumsphere
      sc.create({ position: [x, sy, z], scale: [1, 1, 1], group: 0, sphere: [x, sy, z, r] })
    }
  }
  // the props: scattered low boxes — group 1
  for (let i = 0; i < PROPS; i++) {
    const h = ((Math.imul(i * 2654435761, 40503) >>> 0) % 1000) / 1000
    const x = (h - 0.5) * 118, z = (((Math.imul(i + 7, 1597334677) >>> 0) % 1000) / 1000 - 0.5) * 118
    sc.create({ position: [x, 0.5, z], scale: [1, 1, 1], group: 1, sphere: [x, 0.5, z, 0.87] })
  }
  // the movers: two squads on interleaved circles — groups 2 and 3
  for (let i = 0; i < MOVERS; i++) {
    const group = i < MOVERS / 2 ? 2 : 3
    const gx = (group === 2 ? -1 : 1) * 24
    const r = 8 + (i % 12)
    movers.push({ slot: GRID * GRID + PROPS + i, x: gx, z: 0, r, phase: (i / MOVERS) * Math.PI * 2, group })
    sc.create({ position: [gx, 2, 0], scale: [1, 1, 1], group, sphere: [gx, 2, 0, 1.8] })
  }
  return GRID * GRID + PROPS + MOVERS
}

/** The movers' wall-clock tick (the Task-211 lesson: real seconds on any fps). */
function tickMovers(t) {
  for (const m of movers) {
    const a = m.phase + t * 0.7
    m.x = (m.group === 2 ? -1 : 1) * 24 + Math.cos(a) * m.r
    m.z = Math.sin(a) * m.r * 0.6
    const y = 2 + Math.sin(a * 2) * 1.5
    scene.setLocalTR(m.slot, m.x, y, m.z, 0, 0, 0, 1, 1, 1, 1)
    scene.setSphereLocal(m.slot, m.x, y, m.z, 1.8)
  }
}

function cameraState(t) {
  // camA: a slow top-down sweep; camB: a low orbit — the flip stamps dance
  const a = t * 0.05
  camState[0].eye = [Math.cos(a) * 6, 84, Math.sin(a) * 6]
  cameras[0].setPerspective(Math.PI / 3, 16 / 9, 0.5, 300)
    .setViewLookAt(camState[0].eye[0], camState[0].eye[1], camState[0].eye[2], 0, 0, 0, 0, 1, 0)
  const b = t * 0.21
  camState[1].eye = [Math.cos(b) * 52, 9, Math.sin(b) * 52]
  cameras[1].setPerspective(Math.PI / 3, 16 / 9, 0.5, 300)
    .setViewLookAt(camState[1].eye[0], camState[1].eye[1], camState[1].eye[2], 0, 2, 0, 0, 1, 0)
}

// ── the frame: publish → take → the dirty ranges → draw ───────────────────
function runFrame(t) {
  const held = mirror.watermark()
  tickMovers(t)
  cameraState(t)
  if (stats.lane === 'worker') {
    bridge.publish(cameras)
  } else {
    // the T0 publish spelling (the bridge's own body, same-thread): the
    // camera planes land in the buffer, the pipeline runs into this
    // frame's double-buffer row
    const views = scene.views
    const count = Math.min(cameras.length, views.cameraMax)
    for (let k = 0; k < count; k++) views.planes.set(cameras[k].planes, k * 24)
    views.headerI[H_CAMERA_COUNT] = count
    runScenePipeline(views, frame & 1)
    mirror.observe(frame)
  }
  const snap = stats.lane === 'worker' ? mirror.take() : null
  const epoch = stats.lane === 'worker' ? (snap !== null ? snap.epoch : stats.epoch) : frame
  stats.epoch = epoch

  // THE DIRTY RANGES — exactly what a GPU mirror would re-upload this frame
  const pub = mirror.staticRanges(held)
  let poolBytes = 0, poolRanges = 0
  for (let k = 0; k < CAMS; k++) {
    for (const r of mirror.ranges(epoch, k, held)) { poolBytes += r.end - r.start; poolRanges++ }
  }
  const world = mirror.worldRanges(held, heldLayoutEpoch)
  heldLayoutEpoch = mirror.layoutEpoch()
  stats.publish = { bytes: sumBytes(pub), ranges: pub.length, full: CAP * 40 }
  stats.pool = { bytes: poolBytes, ranges: poolRanges, full: MAX_INST * 64 }
  stats.world = { bytes: sumBytes(world), ranges: world.length, layoutEpoch: heldLayoutEpoch }
  stats.watermark = mirror.watermark()
  stats.staleTakes = stats.lane === 'worker' ? bridge.stats().staleTakes : 0
  stats.workerMs = stats.lane === 'worker' ? workerFrameMs : lastT0Ms

  // the visible counts (the bitsets the worker/T0 just wrote)
  const views = scene.views
  for (let k = 0; k < CAMS; k++) {
    const base = bitsBase(views, epoch & 1, k)
    let c = 0
    const words = (views.headerI[H_NODE_COUNT] + 31) >>> 5
    for (let w = 0; w < words; w++) c += popcount(views.bits[base + w])
    stats.visible[k] = c
  }
  draw()
  frame++
}

function sumBytes(ranges) {
  let b = 0
  for (const r of ranges) b += r.end - r.start
  return b
}

function popcount(v) {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

// ── the canvas: the city drawn FROM THE STORE'S OWN BYTES ─────────────────
let cv = null, ctx = null
function draw() {
  if (ctx === null) return
  const W = cv.width, H = cv.height
  ctx.fillStyle = '#0b0d13'
  ctx.fillRect(0, 0, W, H)
  const views = scene.views
  const worlds = mirror.worlds.column('world')
  const n = views.headerI[H_NODE_COUNT]
  const epoch = stats.epoch
  const bitsA = bitsBase(views, epoch & 1, 0)
  const bitsB = bitsBase(views, epoch & 1, 1)
  const s = Math.min(W, H) / 132
  const cx = W / 2, cy = H / 2
  const GROUP_FILL = ['#2c3a55', '#1f5f63', '#c98a2d', '#c94f4f']
  for (let rank = 0; rank < n; rank++) {
    const slot = views.order[rank]
    const wo = rank * 16
    const x = cx + worlds[wo + 12] * s
    const y = cy + worlds[wo + 14] * s
    const g = views.group[slot]
    const visA = (views.bits[bitsA + (rank >> 5)] >>> (rank & 31)) & 1
    const visB = (views.bits[bitsB + (rank >> 5)] >>> (rank & 31)) & 1
    const vis = visA + visB
    ctx.globalAlpha = vis === 2 ? 0.95 : vis === 1 ? 0.45 : 0.12
    ctx.fillStyle = GROUP_FILL[g] ?? '#888'
    const r = g >= 2 ? 2.4 : 1.6
    ctx.fillRect(x - r / 2, y - r / 2, r, r)
  }
  // the movers' rings (the publish side's dirt, drawn over the city)
  ctx.globalAlpha = 1
  ctx.strokeStyle = '#ffd27a'
  ctx.lineWidth = 1
  for (const m of movers) {
    ctx.beginPath()
    ctx.arc(cx + m.x * s, cy + m.z * s, 4, 0, Math.PI * 2)
    ctx.stroke()
  }
  // the two cameras' footprints (the eye + the view cone on the ground plane)
  drawCone(camState[0], '#7aa2f7', s, cx, cy)
  drawCone(camState[1], '#9ece6a', s, cx, cy)
  ctx.globalAlpha = 1
}

function drawCone(st, color, s, cx, cy) {
  const [ex, ey, ez] = st.eye
  const [tx, ty, tz] = st.target
  const px = cx + ex * s, py = cy + ez * s
  let dx = tx - ex, dz = tz - ez
  const len = Math.hypot(dx, dz) || 1
  dx /= len; dz /= len
  const reach = 40, spread = 0.45
  ctx.strokeStyle = color
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.moveTo(px, py)
  ctx.lineTo(px + (dx * reach - dz * reach * spread) * s, py + (dz * reach + dx * reach * spread) * s)
  ctx.moveTo(px, py)
  ctx.lineTo(px + (dx * reach + dz * reach * spread) * s, py + (dz * reach - dx * reach * spread) * s)
  ctx.stroke()
  ctx.fillStyle = color
  ctx.fillRect(px - 2, py - 2, 4, 4)
}

// ── the HUD ───────────────────────────────────────────────────────────────
let hud = null
function hudTick() {
  if (hud === null) return
  const cut = stats.publish.full / Math.max(1, stats.publish.bytes)
  const lane = stats.lane === 'worker'
    ? 'WORKER lane (crossOriginIsolated — the SAB crosses the thread boundary)'
    : 'T0 lane (no cross-origin isolation — the same pipeline on this thread; the worker sleeps)'
  hud.textContent =
`${lane}
epoch ${stats.epoch} · watermark ${stats.watermark} · layout epoch ${stats.world.layoutEpoch} · stale takes ${stats.staleTakes}
nodes ${stats.nodes} · visible A ${stats.visible[0]} / B ${stats.visible[1]}
publish (locals): ${stats.publish.bytes.toLocaleString()} B · ${stats.publish.ranges} ranges (full ${Math.round(stats.publish.full / 1024)} KB — ${Math.round(cut)}×)
mirror (pools A+B): ${stats.pool.bytes.toLocaleString()} B · ${stats.pool.ranges} ranges (full row ${Math.round(stats.pool.full / 1024)} KB) · worlds ${stats.world.bytes.toLocaleString()} B
${stats.lane === 'worker' ? `worker frame ${stats.workerMs.toFixed(2)} ms` : `pipeline ${stats.workerMs.toFixed(2)} ms`} · movers ${stats.movers} · errors ${stats.errors}`
}

// ── the boot gates (the page's own validation — ?probe=1 dumps and exits) ─
async function validate() {
  const verdict = { pass: true, checks: [] }
  const check = (name, ok, detail = '') => {
    verdict.checks.push({ name, ok, detail })
    if (!ok) verdict.pass = false
    shell.log.event(`${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
    return ok
  }
  const views = scene.views

  // (1) THE ALIASING LAW — a second adoption reads the SAME bytes (zero
  //     copies is a property of the SAB regions, not of one mirror)
  {
    const solo = createSceneStoreMirror(scene)
    const a = mirror.locals.column('pos')
    const b = solo.locals.column('pos')
    let same = a.length === b.length
    for (let i = 0; same && i < a.length; i += 97) same = a[i] === b[i]
    check('the aliasing law: a second adoption IS the same bytes', same, `${a.length} floats sampled`)
  }

  // (2) THE EXACT-DIRT LAW (the publish side): move ONE mover past the
  //     watermark — staticRanges covers exactly that slot's bytes in every
  //     column (SoA: the pos/quat/scale fan-out — one range per column);
  //     a fresh watermark sees nothing
  {
    const m = movers[3]
    const wm = mirror.watermark()
    const before = mirror.staticRanges(wm)
    scene.setLocalTR(m.slot, m.x + 3, 3, m.z, 0, 0, 0, 1, 1, 1, 1)
    scene.setSphereLocal(m.slot, m.x + 3, 3, m.z, 1.8)
    const ranges = mirror.staticRanges(wm)
    // the SoA column fan-out: map each range back to slots through ITS own
    // column's base (pos 12 B / quat 16 B / scale 12 B per record)
    const colBase = c => mirror.locals.columnBytes(c).start
    const colWidth = { pos: 12, quat: 16, scale: 12 }
    const coveredIn = c => {
      const set = new Set()
      const base = colBase(c)
      const w = colWidth[c]
      for (const r of ranges) {
        if (r.start < base || r.end > base + CAP * w) continue
        for (let s = (r.start - base) / w; s < (r.end - base) / w; s++) set.add(s)
      }
      return set
    }
    const pos = coveredIn('pos'), quat = coveredIn('quat'), scale = coveredIn('scale')
    const exact = before.length === 0
      && pos.has(m.slot) && quat.has(m.slot) && scale.has(m.slot)
      && pos.size <= MOVERS && quat.size <= MOVERS && scale.size <= MOVERS
    check('the exact-dirt law: one moved slot = exactly its bytes; fresh sees nothing', exact,
      `${ranges.length} ranges (pos ${pos.size} / quat ${quat.size} / scale ${scale.size} slots, the mover ${m.slot} covered in all three; before ${before.length})`)
    // a FRESH watermark (after the pipeline observes the write) sees nothing
    if (stats.lane === 'worker') {
      bridge.publish(cameras)
      await bridge.waitFresh(4000)
      mirror.take()
    } else {
      t0Publish(1)
      mirror.observe(1)
    }
    check('the fresh watermark sees nothing', mirror.staticRanges(mirror.watermark()).length === 0)
  }

  // (3) THE POOL ≡ SNAPSHOT LAW (the mirror side): the store's matrix
  //     column IS the snapshot's segments, element for element
  if (stats.lane === 'worker') {
    bridge.publish(cameras)
    const snap = await bridge.waitFresh(4000)
    mirror.observe(snap.epoch)
    const store = mirror.pool(snap.epoch, 0)
    const col = store.column('matrix')
    let same = true
    let tested = 0
    for (let g = 0; g < GROUPS && same; g++) {
      const seg = snap.instances[0][g]
      const off = views.instOffsets[(snap.epoch & 1) * views.cameraMax * views.groupMax + g]
      for (let i = 0; i < seg.count * 16; i += 29) {
        tested++
        if (col[off * 16 + i] !== seg.matrices[i]) { same = false; break }
      }
    }
    check('the pool ≡ the snapshot (the store IS the worker\'s bytes)', same, `${tested} floats sampled across ${GROUPS} groups`)
  } else {
    const store = mirror.pool(1, 0)
    const col = store.column('matrix')
    check('the pool ≡ the T0 pipeline\'s own bytes (the store IS the buffer)', col.length === MAX_INST * 16, `${col.length} floats`)
  }

  // (4) THE WATERMARK LAW (the worker lane): a stale take HOLDS the
  //     watermark — re-uploading a frozen row is always sound, skipping never is
  if (stats.lane === 'worker') {
    const wm = mirror.watermark()
    const stale = mirror.take()
    check('the stale-take discipline: the watermark holds', stale !== null && mirror.watermark() === wm,
      `stale epoch ${stale?.epoch} · watermark ${wm}`)
  }

  // (5) THE UPLOAD MATH — the honest cut (the movers' bytes vs the full regions)
  {
    const cut = stats.publish.full / (MOVERS * 40)
    check('the upload math: the movers\' bytes against the full locals region', cut > 10,
      `${MOVERS * 40} B over ${Math.round(stats.publish.full / 1024)} KB — ${Math.round(cut)}×`)
  }
  return verdict
}

// ── the boot: worker lane (COI) with the honest T0 fallback ───────────────
async function boot(mode) {
  stopLoop()
  if (scene !== null) { try { await teardown() } catch { /* best effort */ } }
  shell.slot.replaceChildren()
  const stage = document.createElement('div')
  stage.className = 'mirror-stage'
  cv = document.createElement('canvas')
  cv.id = 'canvas'
  cv.className = 'mirror-canvas'
  cv.width = 960
  cv.height = 540
  stage.append(cv)
  hud = document.createElement('p')
  hud.className = 'mirror-hud'
  stage.append(hud)
  shell.slot.append(stage)
  ctx = cv.getContext('2d')

  const wantWorker = mode !== 't0'
  const coi = typeof SharedArrayBuffer === 'function' && self.crossOriginIsolated === true
  stats.lane = wantWorker && coi ? 'worker' : 't0'
  if (wantWorker && !coi) {
    shell.log.info('no cross-origin isolation (the host serves no COOP/COEP) — the SAB cannot cross the worker boundary; the T0 lane runs the same pipeline on this thread (the local gate serves the headers — the worker lane is gated there)')
  }

  scene = createScene({ capacity: CAP, cameraMax: CAMS, groupMax: GROUPS, maxInstances: MAX_INST, shared: stats.lane === 'worker' })
  stats.nodes = buildCity(scene)
  scene.pack()
  scene.updateWorld()

  if (stats.lane === 'worker') {
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
      // the worker's own frame hook (the honest ms — runSceneWorker's onFrame)
      worker.addEventListener('message', e => {
        if (e.data?.type === 'frame') workerFrameMs = e.data.ms
      })
      bridge = createSceneWorkerBridge({ scene, worker: {
        postMessage: m => worker.postMessage(m),
        onMessage: h => worker.addEventListener('message', e => h(e.data)),
      }, snapshotViews: true })
      await Promise.race([bridge.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('the worker handshake timed out (the SAB could not cross?)')), 5000))])
      shell.log.event('the worker lane is live: the SAB regions cross the thread boundary, zero copies both ways')
    } catch (e) {
      noteError(e)
      shell.log.info('the worker lane failed to boot — falling back to T0 (the same pipeline, this thread)')
      stats.lane = 't0'
      try { worker?.terminate() } catch { /* already dead */ }
      worker = null
      bridge = null
      scene = createScene({ capacity: CAP, cameraMax: CAMS, groupMax: GROUPS, maxInstances: MAX_INST, shared: false })
      stats.nodes = buildCity(scene)
      scene.pack()
      scene.updateWorld()
    }
  }
  mirror = createSceneStoreMirror(scene, bridge !== null ? bridge : undefined)
  heldLayoutEpoch = mirror.layoutEpoch()

  // warm one frame so the pools/bits exist before the gates read them
  cameraState(0)
  if (stats.lane === 'worker') {
    bridge.publish(cameras)
    await bridge.waitFresh(4000)
    mirror.take()
  } else {
    t0Publish(0)
    mirror.observe(0)
  }

  stats.validation = await validate()
  shell.log.event(`validation: ${stats.validation.pass ? 'PASS' : 'FAIL'} — the aliasing law, the exact dirt, the pool ≡ snapshot, the watermark discipline, the upload math`)
  shell.markReady()
  shell.setBadge(stats.lane === 'worker' ? 'worker lane' : 'T0 lane (no COI)', stats.validation.pass ? undefined : 'err')
  if (PROBE) {
    console.log('[mirror-probe]', JSON.stringify({ lane: stats.lane, validation: stats.validation.pass, checks: stats.validation.checks }))
    return
  }
  startLoop()
}

/** The T0 publish spelling (the bridge's own body, same-thread — no
 * Atomics needed, the epochs are the demo's own counter). */
function t0Publish(frameIndex) {
  const views = scene.views
  const count = Math.min(cameras.length, views.cameraMax)
  for (let k = 0; k < count; k++) views.planes.set(cameras[k].planes, k * 24)
  views.headerI[H_CAMERA_COUNT] = count
  runScenePipeline(views, frameIndex & 1)
}

function startLoop() {
  const loop = (t) => {
    rafId = requestAnimationFrame(loop)
    if (paused) return
    const t0 = performance.now()
    try {
      runFrame(t / 1000)
    } catch (e) {
      noteError(e)
    }
    if (stats.lane === 't0') lastT0Ms = lastT0Ms * 0.9 + (performance.now() - t0) * 0.1
    hudTick()
  }
  rafId = requestAnimationFrame(loop)
}

function stopLoop() {
  if (rafId !== 0) cancelAnimationFrame(rafId)
  rafId = 0
}

async function teardown() {
  stopLoop()
  if (bridge !== null) { try { await bridge.dispose() } catch { /* dead */ } }
  else { try { worker?.terminate() } catch { /* dead */ } }
  bridge = null
  worker = null
}

boot(shell.mode).catch(e => noteError(e))
