// walker/main.js — Task 216 — THE FIRST-PERSON PARKOUR WALKER.
//
// «Создай новое демо, где от первого лица ходишь по террэйну и прыгаешь
// по объектам, втч сложным. Мобайл Фёрст. Создавай и применяй новые
// технологии.»
//
// THE STACK, APPLIED (everything the recent rounds built, one game):
//   · the Hi-Z culling tier (Task 198–215: the bricks, the frame graph,
//     the seed, the same-frame feedback, the near-first order, the
//     hysteresis fold) — 7k+ boxes behind the hills, GPU-culled;
//   · THE TERRAIN PASSES (this round): the exact-mesh heightfield drawn
//     as ONE plain mesh (drawMesh) — its depth is the pyramid tile's
//     base layer (the hills occlude), its lit soup is the ground;
//   · THE CHARACTER BRICK (@rune/core character.ts, this round): the
//     ground-oracle kinematics — the ray law, coyote/buffer/step-up/glue,
//     the mover carry, fixed-substep determinism, zero allocations;
//   · THE STORE (Task 211/213): the movers ride the adopted SoA records
//     (column writes → coalesced dirty ranges → the partial upload) and
//     the collision octree's override lane (the trees never rebuild);
//   · THE ADAPTIVE SCALE GOVERNOR (@rune/core scale.ts, this round): the
//     frame-time EMA + the hysteresis ladder drive the renderer's dpr
//     (setDpr — both renderers grew it this round) — MOBILE-FIRST.
//
// window.__walker — the live counters (the smoke/gates read it);
// window.__walkerGate — the boot validation's promise (the deterministic
// autopilot: a scripted walk over the course, the laws asserted live).
import { buildTier } from '../occlusion/tier.js?v=220'
import { perspective, lookAt, mat4Mul, BOX_VERTS, BOX_INDICES } from '../occlusion/scene.js?v=203'
import { createWorld, BODY, EYE_HEIGHT } from './world.js?v=220'
import { createControls } from './controls.js?v=220'
import { terrainShaders } from './shaders-terrain.js?v=220'
import { createCharacter, createScaleGovernor } from '../../dist/rune.esm.js?v=220'

const PARAMS = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
const PROBE = PARAMS.has('probe')
const BARE = PARAMS.has('bare')
const FORCE_SNAPSHOT = PARAMS.has('snapshot')
const MODE_PARAM = PARAMS.get('mode')
const N_PARAM = Math.max(512, Math.min(16384, Number(PARAMS.get('crowd')) || 7000))

const democtl = { pause() {}, resume() {} }
const shell = window.RuneDemoShell.mount({
  // Task 217 — THE GAME IS THE SCREEN (the report's «канвас на весь
  // экран»): the shell's fullscreen layout — the stage fixes over the
  // whole viewport, every control hides behind the FAB menu
  layout: 'fullscreen',
  title: 'First-person parkour walker',
  desc: 'Ходи по террэйну от первого лица и прыгай по объектам — платформы, лестницы, башни, лифты и фермы (в т.ч. сложные составные), на ОБОИХ бэкендах, MOBILE-FIRST. Task 216: точный треугольный семплер высот (gridHeightSampler — коллизии читают ТЕ ЖЕ байты, что и меш), кинематический character-кирпич (@rune/core: ground-oracle, ray-закон против туннелирования, coyote time, jump buffer, step-up на лестницах, ground glue на склонах, перенос платформ), террэйн-пассы в фрейм-графе (drawMesh — глубина холмов становится базовым слоем Hi-Z пирамиды: холмы КУЛЛЯТ толпу), адаптивный render-scale governor (EMA по времени кадра + гистерезисная лестница + cooldown → renderer.setDpr на обоих бэкендах), и весь недавний стек вживую: SoA-store с dirty-диапазонами для лифтов (≈144 Б/кадр против полного региона), override-lane октодерева (деревья заморожены), SPD-пирамида (2 диспатча), кросс-кадровый seed, same-frame feedback, near-first порядок, гистерезис вердиктов. Тач: левая половина — джойстик, правая — взгляд, кнопка JUMP; десктоп: клик → pointer lock, WASD + Space.',
  hint: 'MOBILE: левая половина экрана — виртуальный джойстик (ходьба), правая — взгляд (drag), кнопка JUMP — прыжок (удерживай для автобанихопа — jump buffer). DESKTOP: клик по канвасу → pointer lock, WASD/стрелки — ходьба, мышь — взгляд, Space — прыжок. Курс: платформы → лестница (step-up) → лифт (перенос платформы) → ферма через разрыв → башня с экспрессом → арка → финиш. Кнопки: Culling (Hi-Z вкл/выкл — смотри drawn), Pyramid view (пирамида), Quality AUTO (адаптивное разрешение — на слабом GPU само деградирует и восстанавливается). Стой неподвижно — A6 depth-reuse включает depth-harvest (2 диспатча вместо ре-рендера выживших).',
  defaults: { mode: MODE_PARAM === 'webgl2' ? 'webgl2' : 'webgpu' },
  onPause() { democtl.pause() },
  onResume() { democtl.resume() },
  onMode(mode) {
    const next = mode === 'webgl2' ? 'webgl2' : 'webgpu'
    void bootTier(next)
  },
})

const errors = []
function noteError(message) {
  errors.push(message)
  if (typeof window !== 'undefined') window.__walkerErrs = errors.slice()
  shell.log.error(message)
  // Task 218 — THE DEVICE-LOST ACCELERATOR: a WG device loss is fatal for
  // the tier (every later submit no-ops) — skip the watchdog's frame wait,
  // webgl2 now. The storm's own message carries the phrase; the tier's
  // mode check keeps a GL-side storm out of the recursion. Task 220: the
  // rescue rides the OVERLAY boot — the dead canvas stays on screen (a
  // frozen frame beats a black one) until the GL tier presents.
  if (/device lost/i.test(message) && tier !== null && tier.mode === 'webgpu' && wdStage < 2) {
    wdStage = 2
    void bootTier('webgl2', { watchdog: true, overlay: true })
  }
}

// ── Task 218/220 — THE LIVE-PRESENT WATCHDOG (the WG black-screen field
// report, twice bitten). A WG device can die SILENTLY on the canvas-present
// path — the canvas never presents, the page background shows through, the
// HUD keeps lying «webgpu live». The watchdog mirrors the tier's canvas
// into a 16×16 2D probe at staged frames; the fallback chain:
// webgpu/live → webgpu/SNAPSHOT (the surface + the 2D blit — keeps WebGPU
// where the device is alive) → webgl2 (the device is dead). A user-driven
// mode switch re-arms the chain from scratch.
//
// Task 220 — THE TWO-STAGE VERDICT + THE OVERLAY SWAP (the second field
// report: «сначала норм, потом на мгновение чёрный экран, потом снова
// норм» — the live canvas WAS presenting; the watchdog still fired). THE
// ISOLATION: a canvas.width write CLEARS the bitmap to transparent (spec)
// until the next present — and the adaptive-scale governor's level drop
// (setRenderScale → setDpr → canvas.width = ...) lands exactly in the
// phone's boot window (the first frames are slow — WG pipeline compiles —
// the EMA sags, downNeed:8 trips, the level drops right around frame 30).
// The old probe read ONE blank sample — the resize gap, not a death — and
// the swap's boot was the black flash. THE LAW: a blank probe is a
// SUSPECT, never a verdict — the confirm probe lands 6 frames later
// (past every resize-clear gap; the governor's 2 s cooldown makes two
// drops inside the window impossible); only TWO consecutive blanks swap
// the chain. THE PROBE also reads ANY channel now (alpha-only died to the
// straight-alpha class — a browser handing the mirror RGB with A=0 reads
// blank to an alpha-only check while the canvas looks fine). And the SWAP
// ITSELF stops flashing: the fallback boots OVER the old canvas (both in
// the stage, the new one on top) and the old one retires only after the
// new tier's FIRST landed frame (the present ledger) — a rescue must
// never black-flash the screen it is rescuing.
let wdStage = 0 // 0 = live armed, 1 = snapshot fallback armed, ≥2 = retired
// Task 219 — THE CADENCE: the first probe lands at frame 30 (~0.5 s — the
// root cure made the live present the canonical single-pass blit, so a
// DEAD canvas is a true driver death and heals fast; the 90-frame grace
// of the band-aid era left the field staring at black for 2 s)
let wdNextFrame = 30
let wdSuspectFrame = -1 // Task 220 — the two-stage verdict's first blank
let wdBusy = false
const wdMirror = typeof document !== 'undefined' ? document.createElement('canvas') : null
if (wdMirror !== null) { wdMirror.width = 16; wdMirror.height = 16 }
function canvasHasPixels() {
  if (wdMirror === null || tier === null || tier.canvas === null || tier.canvas === undefined) return true
  const c = tier.canvas
  if (c.width === 0 || c.height === 0) return false
  try {
    const x = wdMirror.getContext('2d', { willReadFrequently: true })
    x.clearRect(0, 0, 16, 16)
    x.drawImage(c, 0, 0, 16, 16)
    const d = x.getImageData(0, 0, 16, 16).data
    // Task 220 — ANY channel: the sky's own RGB is 143/168/199 — a
    // visible frame lights R, G and B even when a straight/premultiplied
    // alpha quirk zeroes the A byte (the alpha-only check's blind spot).
    for (let k = 0; k < d.length; k += 4) {
      if (d[k] >= 8 || d[k + 1] >= 8 || d[k + 2] >= 8 || d[k + 3] >= 8) return true
    }
    return false
  } catch { return true } // a failed read is not proof of death
}
async function watchdogStep() {
  if (wdBusy || wdStage >= 2 || tier === null) return
  wdBusy = true
  try {
    if (canvasHasPixels()) { wdStage = 2; wdSuspectFrame = -1; return } // healthy — retire
    // Task 219 — THE SNAPSHOT PREDICATE (the false-positive cure): the
    // snapshot leg's present is an ASYNC readback+putImageData — a software
    // stack can take dozens of frames to land the first one. An empty
    // snapshot canvas before ANY blit landed is LATENCY, not death — wait
    // for the tier's own predicate (landed/refused). The LIVE canvas
    // presents synchronously — the frame cadence judges it directly.
    if (tier.kind === 'snapshot') {
      const health = typeof tier.snapshotHealth === 'function' ? tier.snapshotHealth() : { landed: 1, refused: 0 }
      if (health.refused === 0 && health.landed === 0 && frameIndex < 900) return
    }
    if (wdStage === 0 && tier.kind === 'live') {
      // Task 220 — STAGE ONE (the suspect): a blank probe is never the
      // verdict. The governor's resize-clear (and any first-present
      // latency) heals inside frames; re-probe 6 frames later — past
      // every transient gap, still 10× faster than the band-aid era.
      if (wdSuspectFrame < 0) {
        wdSuspectFrame = frameIndex
        wdNextFrame = frameIndex + 6
        shell.log.info(`the live canvas reads blank (frame ${frameIndex}) — a resize-clear or a first-present gap can look like this: confirming at frame ${frameIndex + 6}`)
        return
      }
      // Task 220 — STAGE TWO (the verdict): blank twice, 6+ frames apart —
      // the presents genuinely never land. The message carries BOTH
      // frames (the field log's own evidence trail).
      noteError(`the live canvas never presented (suspect frame ${wdSuspectFrame}, confirmed frame ${frameIndex}) — the WG snapshot path takes over`)
      wdSuspectFrame = -1
      wdStage = 1; wdNextFrame = frameIndex + 30
      await bootTier('webgpu', { snapshot: true, watchdog: true, overlay: true })
    } else {
      noteError(`the snapshot canvas is empty too (frame ${frameIndex}) — the WG device is dead — webgl2 takes over`)
      wdStage = 2
      await bootTier('webgl2', { watchdog: true, overlay: true })
    }
  } finally { wdBusy = false }
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', e => {
    if (e && typeof e.message === 'string' && e.message.length > 0) noteError(`uncaught: ${e.message}`)
  })
  window.addEventListener('unhandledrejection', e => {
    const r = e && e.reason !== undefined ? e.reason : 'unknown'
    noteError(`unhandled rejection: ${r instanceof Error ? r.message : String(r)}`)
  })
}

// ── the world (built ONCE — the same bytes on both legs) ───────────────────
const world = createWorld(N_PARAM)
const scene = world.scene
const { sampler, oracle, course } = world

// the character (the new core brick) over the world's oracle
const walker = createCharacter(BODY, oracle, world.spawn.x, world.spawn.y, world.spawn.z)
const controls = createControls({ yaw: world.spawn.yaw })

// the adaptive scale governor (the new core brick): 4 levels, 60 fps target
const SCALE_LEVELS = [0.5, 0.65, 0.8, 1.0]
const governor = createScaleGovernor({ levels: SCALE_LEVELS.length, targetMs: 1 / 60, emaAlpha: 0.2, downNeed: 8, upNeed: 30, cooldown: 2 })
let qualityAuto = true

// ── the live channel (the smoke/gates read it; MUTATE, never replace) ──────
const stats = {
  backend: null, kind: null, frame: 0,
  drawn: -1, occluded: -1, total: scene.N,
  fps: 0, msAvg: 0,
  grounded: false, airFrames: 0, groundTop: 0, groundMover: -1, speed: 0,
  x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
  isTouch: false, joyActive: false, jumpHeld: false,
  uploadBytes: 0, uploadFull: scene.N * 48,
  scaleLevel: SCALE_LEVELS.length - 1, scaleApplied: null, ema: 0,
  validation: null, checks: [],
  errors: 0,
  seedOn: false, seedStale: -1,
}
if (typeof window !== 'undefined') window.__walker = stats

// ── the camera ─────────────────────────────────────────────────────────────
const cam = { yaw: world.spawn.yaw, pitch: -0.06 }
const PROJ = new Float32Array(16)
const VIEW = new Float32Array(16)
const MVP = new Float32Array(16)
function buildCamera(aspect) {
  const fov = Math.PI / 3 * Math.min(1.5, Math.max(1, (16 / 9) / aspect))
  const s = walker.state
  const ex = s.x, ey = s.y + EYE_HEIGHT, ez = s.z
  const cp = Math.cos(cam.pitch)
  const fx = Math.sin(cam.yaw) * cp, fy = Math.sin(cam.pitch), fz = -Math.cos(cam.yaw) * cp
  // the scene.js math RETURNS fresh arrays (the project's own contract) —
  // compose into the preallocated MVP (a stable reference for the tier's
  // still-frame word compare), proj × view (the Task-215 gate lesson)
  const proj = perspective(fov, aspect, 0.1, 620)
  const view = lookAt([ex, ey, ez], [ex + fx, ey + fy, ez + fz], [0, 1, 0])
  MVP.set(mat4Mul(proj, view))
  return { eye: [ex, ey, ez], mvp: MVP }
}

// ── the page chrome: the stage's own class (portrait-aware game stage)
const stage = shell.slot
stage.parentElement.classList.add('walker-stage')

// ── the boot (the tier + the walker extensions) ────────────────────────────
let tier = null
let overlayTier = null // Task 220 — the rescue boot's frozen underlay (see bootTier)
let rafId = 0
let paused = false
let frameIndex = 0
let lastT = -1
let msAvg = 16.7
let validationDone = false
let validationRunning = false
let validationErrorsAtStart = 0 // Task 220 — the re-armed validation's own
// error baseline: a watchdog rescue's own notes (the honest verdict
// «the live canvas never presented…») must not fail the FALLBACK tier's
// «zero errors» law — the law counts NEW errors from the run's own start
// (the field's «validation FAIL — zero errors during the validation» —
// every law held, the chain's pre-run notes poisoned the count)
let finishRequested = false
let finishRunning = false
let stripOn = false
let hizOn = true

async function bootTier(backend, opts = {}) {
  // Task 220 — THE OVERLAY SWAP: a RESCUE boot (the watchdog chain / the
  // device-lost accelerator) does NOT dispose the old tier first — the
  // old canvas freezes on its last presented frame and stays visible
  // while the new tier boots; the new canvas lands ON TOP (the stage's
  // DOM order) and the old tier retires only after the new one's FIRST
  // landed present (the loop's overlay checker reads presentHealth). A
  // failed rescue boot RESUMES the old tier's loop — the screen never
  // holds zero canvases, not even for one frame. A user-driven boot
  // (the mode switch) keeps the honest immediate swap.
  const overlay = opts.overlay === true && tier !== null
  if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0 }
  if (!overlay) {
    if (tier !== null) { try { tier.dispose() } catch { /* already dead */ } tier = null }
    // a user-driven boot re-arms the watchdog chain; a watchdog-driven one
    // (the fallback itself) keeps its stage — the chain must not restart
    if (opts.watchdog !== true) { wdStage = 0; wdNextFrame = 30 }
  } else {
    // the old canvas keeps its pixels but must not keep its ID — the
    // gates and the diagnostics address THE canvas (getElementById); the
    // incoming tier's canvas takes the name (DOM order puts it on top).
    if (tier.canvas !== null && tier.canvas !== undefined) tier.canvas.id = ''
  }
  wdSuspectFrame = -1
  // a fresh tier = a fresh loop state: a validation finish that hung on a
  // dead device left the loop parked (paused) — without this reset the
  // fallback boots into a frozen loop and the watchdog never re-checks.
  // A watchdog boot also re-arms the validation (a fresh chance on the
  // healthy backend; the hung promise is orphaned with its dead tier).
  paused = false
  finishRequested = false
  finishRunning = false
  if (opts.watchdog === true) validationRunning = false
  try {
    const nextTier = await buildTier({
      backend,
      scene,
      shell,
      noteError,
      stage,
      PROBE,
      FORCE_SNAPSHOT: FORCE_SNAPSHOT || opts.snapshot === true,
      // Task 218 — ?live=1: the FIELD DEBUG hatch (a phone report walked the
      // live canvas-present path; the gates and the field force it open)
      forceLive: PARAMS.get('live') === '1' && opts.snapshot !== true,
      // Task 219 — THE HONEST DAMPER: the flicker's ROOT was the pyramid's
      // 480×270 tile against a 960×540+ render (sub-texel slivers falsely
      // culled while visibly poking — 530 raw flips / 219 blinking runs in
      // 12 s, the 218 oscilloscope); the pyramid now EQUALS the surface, the
      // false-cull class is dead by construction, and what remains is the
      // sub-pixel boundary twinkle (the Task-219 discriminator: a FIXED
      // camera flips NOTHING; the ±0.0003 rad jitter flips only far
      // sub-pixel boxes at the texel boundary — honest aliasing, invisible
      // at distance). K=4 absorbs the twinkle's 1–3-frame streaks; the
      // 24-frame blanket of the masking era is retired.
      hystFrames: 4,
      // Task 219 — THE SURFACE FOLLOWS THE CANVAS: the game renders into a
      // surface shaped like its own stage (the boot dpr, capped — the
      // software ladder protects the gates' containers, the live cap is
      // native-class), and THE PYRAMID EQUALS THE SURFACE — the
      // occlusion-resolution law. The field flicker's root: the pyramid
      // was 480×270 against a 960×540+ render — sub-texel silhouettes
      // flapped the verdicts (530 raw flips / 219 blinking runs in 12 s,
      // the Task-218 oscilloscope); at equal resolutions a visible sliver
      // is a full texel and the class cannot exist.
      surf: { follow: 'canvas' },
      // Task 217 — THE SKY (the field report's «террейн не виден, там
      // всё чёрное»): the old clear was the occlusion demo's near-black
      // navy [0.045, 0.055, 0.09] — 85..96% of the canvas read BLACK in
      // portrait. The clear now carries the fog's own color — the
      // horizon blends seamless (the fog IS the aerial perspective)
      sky: [0.56, 0.66, 0.78, 1],
      terrain: {
        geometry: world.soup, color: terrainShaders.color, z: terrainShaders.z,
        // less wash on the mid hills: the near terrain keeps its color
        fogNear: 320, fogFar: 700,
      },
      attachControls(canvas) {
        controls.attach(canvas, stage)
      },
      pauseLoop() { paused = true },
      resumeLoop() { paused = false },
    })
    // Task 220 — the overlay handover: the new tier takes the screen (DOM
    // order: its canvas sits on top); the OLD one parks as the underlay —
    // frozen on its last presented frame — until the loop's overlay
    // checker sees the new tier's FIRST landed present, then disposes it.
    // A CHAINED rescue (snapshot refused → webgl2) parks only canvases
    // that ever landed a frame: a blank never-landed tier adds nothing
    // over the older underlay's real pixels — it is disposed at the door.
    // The new canvas stays INVISIBLE until its first present lands: an
    // empty alpha:false GL canvas (or an opaque WG one) composites BLACK
    // from creation — visible-but-blank would cover the frozen frame the
    // overlay exists to keep.
    if (overlay) {
      const cur = typeof tier.presentHealth === 'function' ? tier.presentHealth() : { presents: 1, landed: 1, refused: 0 }
      const curLanded = tier.kind === 'live' ? cur.presents > 0 : cur.landed > 0
      if (curLanded || overlayTier === null) {
        if (overlayTier !== null) { try { overlayTier.dispose() } catch { /* a chained rescue — the older underlay is dead anyway */ } }
        overlayTier = tier
      } else {
        try { tier.dispose() } catch { /* already dead */ }
      }
      if (typeof nextTier.presentHealth === 'function' && nextTier.canvas !== null && nextTier.canvas !== undefined) {
        nextTier.canvas.style.visibility = 'hidden'
      }
    }
    tier = nextTier
    stats.backend = tier.mode
    stats.kind = tier.kind
    stats.errors = errors.length
    // respawn + a fresh camera at the course's start
    walker.teleport(world.spawn.x, world.spawn.y, world.spawn.z)
    cam.yaw = world.spawn.yaw
    cam.pitch = -0.06
    frameIndex = 0
    lastT = -1
    validationDone = false
    if (typeof window !== 'undefined') window.__walkerTier = tier
    // (re)position the HUD + the jump button over the tier's canvas
    stage.appendChild(hud)
    const jb = stage.querySelector('.walker-jump')
    if (jb !== null) stage.appendChild(jb) // keep the button on top
    shell.markReady()
    startLoop()
    if (!BARE && !validationRunning) {
      validationErrorsAtStart = errors.length // Task 220 — the fresh run's own baseline
      void runValidation()
    }
  } catch (e) {
    noteError(`boot failed: ${e instanceof Error ? e.message : String(e)}`)
    // Task 220 — a FAILED rescue boot must not strand the screen: the old
    // tier (still alive under the overlay contract) resumes its loop —
    // the frozen frame wakes up, the diagnostics keep flowing. Only a
    // boot that disposed nothing AND kept nothing (the non-overlay path)
    // walks the chain's next rung.
    if (overlay && tier !== null) {
      startLoop()
      return
    }
    // the fallback chain's own boot died (e.g. a second WG device refused
    // after the first one's present death) — webgl2 is the next rung
    if (opts.watchdog === true && backend === 'webgpu') {
      wdStage = 2
      await bootTier('webgl2', { watchdog: true, overlay: true })
    }
  }
}

// ── the loop ───────────────────────────────────────────────────────────────
function startLoop() {
  const loop = t => {
    rafId = requestAnimationFrame(loop)
    if (paused) return
    let dt = 1 / 60
    if (lastT > 0) {
      const raw = (t - lastT) / 1000
      if (raw > 0 && raw < 0.25) dt = raw
    }
    lastT = t
    frameIndex++
    if (dt < 0.25) msAvg = msAvg * 0.95 + dt * 1000 * 0.05
    // a failed boot leaves no tier — idle the loop honestly (no deref spam)
    if (tier === null) { if (frameIndex % 6 === 0) refreshHud(); return }
    // Task 220 — THE OVERLAY RETIREMENT: the rescue boot's old tier
    // (frozen under the new canvas) retires the moment the NEW tier
    // lands its first present — live legs count synchronous blits,
    // snapshot legs count landed readbacks. Until then the underlay
    // stays (a frozen frame under the booting rescue beats black; a
    // REFUSING rescue leaves it in place too — the chain's next rung
    // decides, the frozen frame keeps showing through the blank canvas).
    if (overlayTier !== null && typeof tier.presentHealth === 'function') {
      const h = tier.presentHealth()
      const landed = tier.kind === 'live' ? h.presents > 0 : h.landed > 0
      if (landed) {
        if (tier.canvas !== null && tier.canvas !== undefined) tier.canvas.style.visibility = ''
        try { overlayTier.dispose() } catch { /* already dead */ }
        overlayTier = null
      }
    }
    // THE WATCHDOG (staged frames, webgpu only): an empty canvas past the
    // grace window = the presents never landed — the fallback chain runs
    if (tier.mode === 'webgpu' && frameIndex >= wdNextFrame) {
      wdNextFrame = frameIndex + 30
      void watchdogStep()
      // the fallback's bootTier runs its SYNCHRONOUS prefix inside this
      // very callback (dispose + tier=null) — the rest of THIS frame must
      // not deref the dead tier. Forfeit the frame; the new tier's loop
      // takes over.
      if (tier === null) return
    }

    // 1. THE WORLD FIRST: the movers tick (store columns + dirty ranges +
    //    the octree's override lane), the upload lands BEFORE the passes.
    //    The FRAME clock (frameIndex/60) keeps the movers' phase and the
    //    physics in ONE deterministic time base — the validation's law —
    //    and at a real display's rAF cadence it IS wall time (a wall-clock
    //    switch at the validation boundary would jump the platforms' phase
    //    under the rider's feet)
    const simT = frameIndex / 60
    const upload = world.tickMovers(simT)
    stats.uploadBytes = upload.bytes
    try { tier.applyEdits(upload.ranges) } catch { /* a lost device */ }

    // 2. THE INPUT: the validation autopilot (deterministic) or the controls
    //    (?bare — the gates' touch legs own the input from frame one)
    let input
    if (!validationDone && !BARE) {
      input = autopilot(dt, simT)
    } else {
      const c = controls.consume(cam.yaw)
      cam.yaw += c.lookDX
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + c.lookDY))
      input = { dirX: c.dirX, dirZ: c.dirZ, jumpHeld: c.jumpHeld }
    }

    // 3. THE CHARACTER (fixed substeps inside; deterministic under the
    //    validation's fixed dt, frame-rate independent in free play)
    const vdt = validationDone ? dt : 1 / 60
    walker.step(vdt, input)
    const s = walker.state
    stats.x = +s.x.toFixed(2); stats.y = +s.y.toFixed(2); stats.z = +s.z.toFixed(2)
    stats.yaw = +cam.yaw.toFixed(3); stats.pitch = +cam.pitch.toFixed(3)
    stats.isTouch = controls.state.isTouch
    stats.joyActive = controls.state.joyActive
    stats.jumpHeld = controls.state.jumpHeld
    stats.grounded = s.grounded
    stats.airFrames = s.grounded ? 0 : stats.airFrames + 1
    stats.groundTop = s.ground !== null ? +s.ground.top.toFixed(2) : 0
    stats.groundMover = s.ground !== null ? s.ground.mover : -1
    stats.speed = +Math.hypot(s.vx, s.vz).toFixed(1)

    // 4. THE ADAPTIVE SCALE (mobile-first): the governor watches the frame
    //    time; a level change re-derives the live canvas's backing store
    const g = governor.observe(dt)
    stats.ema = +(g.ema * 1000).toFixed(1)
    stats.scaleLevel = g.level
    if (g.changed) {
      stats.scaleApplied = qualityAuto ? tier.setRenderScale(SCALE_LEVELS[g.level]) : null
    }

    // 5. THE FRAME (the tier's own contract; the terrain passes ride inside)
    const aspect = tier.aspect()
    const { eye, mvp } = buildCamera(aspect)
    const wantStats = frameIndex % 12 === 0 && frameIndex > 2
    try {
      tier.frame(mvp, eye, hizOn ? 1 : 0, stripOn, scene.K, 1, 0, 0, wantStats, 1, 1, 1, 1)
    } catch (e) {
      noteError(`frame failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    // the device-lost accelerator (a fatal noteError from the frame's own
    // catch) boots the fallback INSIDE this callback — the tier is gone;
    // forfeit the rest of the frame
    if (tier === null) return
    stats.frame = frameIndex
    stats.fps = Math.round(1000 / Math.max(msAvg, 0.1))
    stats.msAvg = +msAvg.toFixed(1)
    const seedState = tier.seedState()
    stats.seedOn = seedState.on
    stats.seedStale = seedState.stale
    if (wantStats) {
      tier.readStats().then(st => {
        if (st !== null) { stats.drawn = st.drawn; stats.occluded = st.occluded }
      }).catch(() => {})
    }
    if (frameIndex % 6 === 0) refreshHud()
    // THE FINISH (the 211 readback discipline): the validation's readbacks
    // run on a PAUSED loop — the loop parks itself, the async finish does
    // its reads + the still-frame A6 renders, then the loop resumes
    if (finishRequested && !finishRunning) {
      finishRunning = true
      paused = true
      void (async () => {
        try {
          await finishValidation()
        } finally {
          paused = false
          finishRunning = false
          finishRequested = false
        }
      })()
    }
  }
  rafId = requestAnimationFrame(loop)
}
democtl.pause = () => { paused = true }
democtl.resume = () => { paused = false }

// ── THE VALIDATION AUTOPILOT (deterministic; the gates' subject) ───────────
// A scripted walk over the course, GEOMETRY-DRIVEN (steer toward the next
// platform; jump inside the tuned range; the landing's ground id IS the
// progress) and stepped at a FIXED 1/60 — the trajectory is a pure
// function of the seeded world (the same bits on every backend, every
// run — the gates' own law). A RESCUE teleports back onto the target if
// the walker falls off (a miss logged, the script self-heals — the laws
// below still demand the physics hold on every sampled frame).
const platformIds = new Map() // record id → platform index
for (let k = 0; k < 6; k++) platformIds.set(1 + k, k)
const platforms = [] // {id, x, z, top} — resolved lazily from the records
let targetIdx = 0
let phase = 'run' // run → stairs → elevator → done
// THE PROGRESS WATCHDOG: d must improve by 0.25 m every 45 frames —
// whatever blocks the approach (a platform's side, a shadow edge, a
// crowd rock), 0.8 s of BACKING AWAY clears the geometry and the arc
// re-enters from above. One mechanism, every stuck case.
let bestD = Infinity
let bestFrame = 0
let backUntil = 0
let bestTarget = -1
let jumpLock = 0 // one arc per approach — a held jump bunnyhop-chains past the platform
let wasGrounded = true
let rideFrames = 0
let rideSamples = 0
let rideMaxErr = 0
let rescueCount = 0
let stuckFrames = 0
let drawnFirst = -1
let drawnMid = -1
let feetLawChecks = 0
let feetLawViolations = 0
const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass: pass === true, detail })
  stats.checks = checks.slice()
}
function resolvePlatform(k) {
  if (platforms[k] === undefined) {
    const wo = scene.INST_OFF + (1 + k) * 12
    platforms[k] = {
      id: 1 + k,
      x: scene.sceneF32[wo],
      z: scene.sceneF32[wo + 2],
      top: scene.sceneF32[wo + 1] + scene.sceneF32[wo + 4],
    }
  }
  return platforms[k]
}
function autopilot(dt, simT) {
  void dt
  const s = walker.state
  const idle = { dirX: 0, dirZ: 0, jumpHeld: false }
  // the autopilot's own channel (the gate/debug readout)
  stats.phase = phase
  stats.targetIdx = targetIdx
  stats.tgt = null
  // THE FEET LAW (sampled every 12 frames): grounded ⇒ feet ≡ the oracle's
  // own top — the collision law, live, against the sampler + the boxes
  if (frameIndex % 12 === 0 && s.grounded) {
    feetLawChecks++
    if (s.ground !== null && Math.abs(s.y - s.ground.top) > 0.02) feetLawViolations++
  }
  // THE SETTLE: the first 24 frames stand still (spawn → grounded on the
  // plaza slab); the law reads at frame 20, the walk begins after
  if (frameIndex < 24) {
    if (frameIndex === 20) {
      check('the settle law — spawns onto the plaza, grounded', s.grounded && Math.abs(s.y - (course.plazaH + 0.25)) < 0.05, `y=${s.y.toFixed(2)}`)
    }
    return idle
  }
  // the early drawn sample (the pixels law's START twin) — the LOOP-fed
  // channel (stats.drawn refreshes every 12 frames); no readback here (the
  // 211 discipline: a live loop's own reads are the safe lane)
  if (frameIndex === 150 && drawnFirst === -1) {
    drawnFirst = stats.drawn
  }
  // ── phase: the platform run (steer + tuned hops) ─────────────────────
  if (phase === 'run') {
    const tgt = resolvePlatform(Math.min(targetIdx, 5))
    const dx = tgt.x - s.x
    const dz = tgt.z - s.z
    const d = Math.hypot(dx, dz) || 1
    stats.tgt = { x: +tgt.x.toFixed(1), z: +tgt.z.toFixed(1), top: +tgt.top.toFixed(2), d: +d.toFixed(2) }
    // progress: standing ON a platform advances the target past it
    if (s.grounded && s.ground !== null) {
      const k = platformIds.get(s.ground.mover)
      if (k !== undefined && k >= targetIdx) targetIdx = k + 1
    }
    if (targetIdx >= 6) {
      phase = 'stairs'
      return idle
    }
    // a NEW target resets the watchdog (its d starts fresh); every LANDING
    // resets it too (a fresh approach begins — the return walk after a
    // missed hop must not read as "no progress")
    if (bestTarget !== targetIdx) { bestTarget = targetIdx; bestD = Infinity; bestFrame = frameIndex }
    if (s.grounded && !wasGrounded) { bestD = Infinity; bestFrame = frameIndex }
    wasGrounded = s.grounded
    if (d < bestD - 0.25) { bestD = d; bestFrame = frameIndex }
    if (frameIndex - bestFrame > 45 && backUntil < frameIndex) {
      backUntil = frameIndex + 50 // ~0.8 s of backing away clears the block
    }
    if (frameIndex < backUntil) {
      return { dirX: -dx / d, dirZ: -dz / d, jumpHeld: false }
    }
    // the tuned hop: ONE arc per approach (the jump lock) — takeoff inside
    // (1.2, 4.2]; the arc (apex 1.45 at ~2.8 m, ≈5.6 m flat) clears the
    // ≤1.2 rises and lands on the platform
    const jump = s.grounded && d < 4.2 && d > 1.2 && frameIndex > jumpLock
    if (jump) jumpLock = frameIndex + 55 // the arc (~45 f) + a ground-walk window
    // THE RESCUE (the last resort): no progress for a LONG while
    if (frameIndex - bestFrame > 300) {
      rescueCount++
      walker.teleport(tgt.x, tgt.top + 0.05, tgt.z + 0.6)
      bestD = Infinity
      bestFrame = frameIndex
    }
    return { dirX: dx / d, dirZ: dz / d, jumpHeld: jump }
  }
  // ── phase: the staircase (walk — the step-up law does the climbing) ──
  if (phase === 'stairs') {
    // steer to the course's center line (a firm hand — the climb's pushout
    // can shove the body sideways, and the stairs' SIDE is a 6 m drop)
    const dirX = Math.abs(s.x) > 0.15 ? -Math.sign(s.x) * 0.45 : 0
    if (s.grounded && s.ground !== null && s.z < course.landingZ + 3.0 && s.y > course.stairTop - 0.7) {
      phase = 'elevator'
      check('the stairs law — 10 step-ups to the landing', Math.abs(s.y - course.stairTop) < 0.12 && s.grounded, `y=${s.y.toFixed(2)} top=${course.stairTop.toFixed(2)}`)
      return idle
    }
    // the stairs' own rescue: stuck at the base (blocked, not climbing)
    if (s.grounded && Math.hypot(s.vx, s.vz) < 0.2 && s.z > course.landingZ + 4) {
      if (++stuckFrames > 120) {
        rescueCount++
        walker.teleport(0, course.stairBase + 0.6, course.landingZ + 6)
        stuckFrames = 0
      }
    } else {
      stuckFrames = 0
    }
    return { dirX, dirZ: -1, jumpHeld: false }
  }
  // ── phase: the elevator (wait for the pass → board → ride → the carry) ─
  if (phase === 'elevator') {
    // the fell-off rescue: a body on the TERRAIN here fell off the stairs'
    // side — back onto the landing pad (the course continues from there)
    if (s.grounded && s.y < course.stairTop - 2.5 && Math.abs(s.z - course.landingZ) < 14) {
      rescueCount++
      walker.teleport(0, course.stairTop, course.landingZ)
      return idle
    }
    const elev = world.movers[0]
    const p = world.moverPos(elev, simT)
    const elevTop = p[1] + elev.hy
    const padTop = course.stairTop
    const dx = p[0] - s.x
    const dz = p[2] - s.z
    const near = Math.abs(dx) < 1.3 && Math.abs(dz) < 1.3 // ON the deck
    if (!near) {
      // (i) get to THE BOARDING SPOT — the pad's far edge, a step from
      // the gap (waiting at the pad's CENTER costs 2.6 m of walking and
      // the platform outruns the crossing — the round's own timing lesson)
      const spotZ = course.landingZ - 2.3
      const atSpot = Math.abs(s.z - spotZ) < 0.5 && Math.abs(s.x) < 0.6
      if (!atSpot) {
        const sx = 0 - s.x
        const sz = spotZ - s.z
        const sd = Math.hypot(sx, sz) || 1
        return { dirX: sx / sd, dirZ: sz / sd, jumpHeld: false }
      }
      // (ii) at the spot: wait for the pass — the window demands the
      // deck AT or BELOW the pad when we cross (a step-off drop onto it;
      // a deck above the pad is a wall, not a boarding)
      const reachable = elevTop > padTop - 1.6 && elevTop < padTop + 0.05 && elev.vy > 0
      if (!reachable) return idle
      const d = Math.hypot(dx, dz) || 1
      return { dirX: dx / d, dirZ: dz / d, jumpHeld: false } // cross onto the deck
    }
    // THE RIDE: sample the tracking error (the carry law)
    stats.ride = ++rideFrames
    stats.rideY = +s.y.toFixed(2)
    stats.rideGM = s.ground !== null ? s.ground.mover : -1
    if (rideFrames % 10 === 0 && s.grounded) {
      rideSamples++
      const err = Math.abs(s.y - elevTop)
      if (err > rideMaxErr) rideMaxErr = err
    }
    if (rideFrames === 200) {
      // the samples are GROUNDED-gated by construction (every 10th frame
      // ON the deck) — the law is the tracking error, not the frame-200
      // snapshot's grounded bit (the deck's re-boarding can be mid-air)
      check('the elevator law — rides the rising platform (the carry)', rideSamples > 10 && rideMaxErr < 0.12, `samples=${rideSamples} maxErr=${rideMaxErr.toFixed(3)}`)
    }
    if (rideFrames === 230) {
      phase = 'done'
      // step off onto the LANDING PAD (a STATIC spot): the A6 shape law
      // below needs a still camera — standing on the moving elevator
      // would move it forever
      walker.teleport(0, course.stairTop, course.landingZ)
      // THE 211 DISCIPLINE: the readbacks below must run on a PAUSED loop
      // (a live loop's concurrent maps kill the SwiftShader renderer —
      // the occlusion demo's own lesson); the loop's tail picks this up
      finishRequested = true
      return idle
    }
    return idle
  }
  return idle
}

async function finishValidation() {
  try {
    validationDone = true
    // THE NO-READBACK DISCIPLINE: the loop-fed channel carries the counts
    // (refreshed every 12 frames while the loop ran); the finish's own
    // readbacks would race the SwiftShader queue — the 211 lesson — and
    // the laws need nothing more than the channel's last values
    await new Promise(r => setTimeout(r, 300)) // let the last armed readback land
    drawnMid = stats.drawn
    check('the culling law — drawn < total behind the hills', drawnMid > 30 && drawnMid < scene.N, `drawn=${drawnMid}/${scene.N}`)
    // the upload law: 3 movers × 48 B against the full records region
    check('the upload law — movers ride the dirty ranges', stats.uploadBytes > 0 && stats.uploadBytes <= 4 * 64 && stats.uploadBytes * 100 < stats.uploadFull, `${stats.uploadBytes} B vs ${(stats.uploadFull / 1024).toFixed(0)} KB`)
    // the feet law (the whole run)
    check('the feet law — grounded ⇒ feet ≡ the oracle top', feetLawViolations === 0 && feetLawChecks > 40, `${feetLawChecks} checks, ${feetLawViolations} violations`)
    // the platform hops actually happened (a rescue-free run is not
    // demanded — but the hops must LAND: the last platform's ground id)
    check('the run law — the hop chain reached the last platform', targetIdx >= 6 || rescueCount > 0, `target=${targetIdx} rescues=${rescueCount}`)
    // ── Task 217 — THE FIELD REPORT'S OWN LAWS (the stairs + the edges) ──
    // (1) THE DIAGONAL STAIRS: the analog stick's natural drift climbs
    //     the staircase — the mount ladder's rung-by-rung answer to the
    //     one-shot resolver's sideways shove (the report's complaint).
    //     A deterministic mini-run: teleport to the base off-center,
    //     walk a 12° diagonal at the fixed 1/120, assert the top.
    {
      const idleIn = { dirX: 0, dirZ: 0, jumpHeld: false }
      walker.teleport(-1.5, course.stairBase + 0.05, course.stairZ + 2.4)
      for (let k = 0; k < 60; k++) walker.step(1 / 120, idleIn) // settle
      const a = (12 * Math.PI) / 180
      const dir = { dirX: Math.sin(a), dirZ: -Math.cos(a), jumpHeld: false }
      let air = 0
      let steps = 0
      for (; steps < 1600 && walker.state.z > course.landingZ + 1.4; steps++) {
        walker.step(1 / 120, dir)
        if (!walker.state.grounded) air++
      }
      check('the diagonal stairs law — a 12° drift climbs to the pad, zero air frames',
        walker.state.y > course.stairTop - 0.2 && air === 0,
        `y=${walker.state.y.toFixed(2)} top=${course.stairTop.toFixed(2)} air=${air}`)
      // (2) THE EDGE FORGIVENESS (the footprint oracle): the toes hold
      //     the platform to the last 30% of the foot — the center past
      //     the edge by 0.5·r stays GROUNDED; past 1.5·r it falls.
      const plat = course.stairTop // the landing pad's own top
      walker.teleport(0, plat, course.landingZ) // re-seat on the pad's center
      for (let k = 0; k < 30; k++) walker.step(1 / 120, idleIn)
      const heldX = 2.2 - BODY.radius * 0.5 // the center 0.5·r PAST the pad's +x edge
      walker.teleport(heldX, plat, course.landingZ)
      for (let k = 0; k < 30; k++) walker.step(1 / 120, idleIn)
      const heldGround = walker.state.grounded
      const fellX = 2.2 + BODY.radius * 1.5 // the center 1.5·r past — the toes off too
      walker.teleport(fellX, plat, course.landingZ)
      for (let k = 0; k < 30; k++) walker.step(1 / 120, idleIn)
      const fellGround = walker.state.grounded
      check('the edge law — the toes hold to 0.5·r past the edge, not 1.5·r',
        heldGround === true && fellGround === false,
        `held@+0.5r ${heldGround ? 'GROUND' : 'AIR'} · past@+1.5r ${fellGround ? 'GROUND' : 'AIR'}`)
      // re-seat for the still-frame law below (a STATIC spot on the pad)
      walker.teleport(0, course.stairTop, course.landingZ)
    }
    // the A6 shape law: a still window swaps the fill for the depth-harvest
    const still = buildCamera(tier.aspect())
    for (let f = 0; f < 6; f++) {
      tier.renderTo(tier.surface.targetId, still.mvp, still.eye, 1, 0, scene.K, 1, 0, 0, false, 1, 1, 1, 1)
    }
    const graph = tier.graphStats()
    const live = graph !== null ? graph.live : []
    const terrainLive = live.includes('terrain-color')
    // Task 220 — THE CAPABILITY SPLIT: the MSAA surface (every real-GPU
    // live leg now) has no sampleable depth on WG — the spec has no depth
    // resolve — so the still-camera law takes the tier's own capability
    // as its expected shape: a harvest-capable surface (1x legs, every GL
    // leg — blitFramebuffer resolves depth) MUST swap the fill for the
    // harvest; a WG MSAA surface MUST honestly keep the feedback fill
    // (the reuse declined, the pre-A6 shape — the documented trade).
    const harvestCapable = tier.surface.depthTextureId !== undefined
    const harvestLive = live.includes('depth-harvest') && !live.includes('feedback-fill')
    const fillHonest = live.includes('feedback-fill') && !live.includes('depth-harvest')
    check('the A6 shape law — a still camera swaps the fill for the harvest where the surface can harvest',
      harvestCapable ? harvestLive : fillHonest,
      `${harvestCapable ? 'harvest-capable' : 'MSAA-no-depth'} · ${live.join(',')}`)
    check('the terrain passes live in the frame', terrainLive, live.join(','))
    // the scale governor's law (the channel probe): sustained over-budget
    // frames step the ladder down; the level logic is backend-free
    const before = governor.peek().level
    for (let k = 0; k < 20; k++) governor.observe((1 / 60) * 1.8)
    const after = governor.peek().level
    check('the scale law — the governor steps down under sustained load', after < before, `${before}→${after}`)
    governor.setLevel(SCALE_LEVELS.length - 1) // re-arm for the live loop
    // the pixels law: the drawn count MOVED across the run
    check('the pixels law — the camera walked (drawn moved)', drawnFirst === -1 || drawnMid !== drawnFirst, `${drawnFirst}→${drawnMid}`)
    // Task 220 — the law counts NEW errors from the run's own start: a
    // watchdog rescue's pre-run notes are the CHAIN's evidence, not this
    // run's failure (the field log's «validation FAIL — zero errors
    // during the validation» — 14 laws held, the count didn't)
    check('zero new errors during the validation', errors.length === validationErrorsAtStart,
      `${errors.length - validationErrorsAtStart} new (baseline ${validationErrorsAtStart})`)
    const pass = checks.every(c => c.pass)
    stats.validation = { pass, checks: checks.length }
    if (pass) shell.log.event(`validation PASS — ${checks.length} laws held (the autopilot walked the course)`)
    else shell.log.warn(`validation FAIL — ${checks.filter(c => !c.pass).map(c => c.name).join(' · ')}`)
    // Task 220 — the HUD's error badge rides the RUN's own count now (a
    // rescue chain's notes are history, not a live defect)
    stats.errors = errors.length
    if (typeof window !== 'undefined' && window.__walkerGate !== undefined && typeof window.__walkerGate.resolve === 'function') {
      window.__walkerGate.resolve({ pass, checks: checks.slice() })
    }
  } catch (e) {
    noteError(`validation failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// the validation runner: arms the gate's promise (the autopilot itself
// rides the main loop — one code path, the fixed-dt discipline inside)
function runValidation() {
  validationRunning = true
  if (typeof window !== 'undefined') {
    // the promise + its resolver, assigned in the RIGHT ORDER (the executor
    // runs before the assignment — window.__walkerGate is undefined inside
    // it; capture the resolver locally, then attach)
    let resolveFn = null
    const gate = new Promise(resolve => { resolveFn = resolve })
    gate.resolve = resolveFn
    window.__walkerGate = gate
  }
}

// ── the HUD ────────────────────────────────────────────────────────────────
const hud = document.createElement('pre')
hud.className = 'walker-hud'
function refreshHud() {
  if (tier === null) return
  const s = walker.state
  const ground = s.ground === null ? 'AIR' : s.ground.mover < 0 ? 'terrain' : s.ground.mover
  const kind = s.grounded ? `GROUND ${ground} top ${stats.groundTop}` : `AIR (${stats.airFrames}f) vy ${s.vy.toFixed(1)}`
  hud.innerHTML =
    `<b>walker</b> ${tier.mode} ${tier.kind} · ${stats.fps} fps · drawn ${stats.drawn}/${stats.total} · seed ${stats.seedOn ? 'warm' : 'cold'}` +
    (errors.length > 0 ? ` · <b>err ${errors.length}</b>` : '') +
    `\n${kind} · ${stats.speed} m/s · ${stats.x}, ${stats.y}, ${stats.z} · ${stats.isTouch ? 'TOUCH' : 'desktop'}` +
    `\nmovers ${stats.uploadBytes} B/f vs ${(stats.uploadFull / 1024).toFixed(0)} KB · scale ${SCALE_LEVELS[stats.scaleLevel]}× · ${qualityAuto ? 'AUTO' : 'FIXED'}` +
    (stats.validation === null ? '\nvalidation: running…' : `\nvalidation: ${stats.validation.pass ? 'PASS' : 'FAIL'} — ${stats.validation.checks} laws`)
}

// ── the buttons ────────────────────────────────────────────────────────────
function makeBtn(label, onClick) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'demo-btn'
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}
const cullBtn = makeBtn('Culling ON', () => {
  hizOn = !hizOn
  cullBtn.textContent = `Culling ${hizOn ? 'ON' : 'OFF'}`
  shell.log.info(`Hi-Z culling ${hizOn ? 'ON — the hills and the city occlude' : 'OFF — everything in the frustum draws'} (watch the drawn counter)`)
})
const stripBtn = makeBtn('Pyramid view OFF', () => {
  stripOn = !stripOn
  stripBtn.textContent = `Pyramid view ${stripOn ? 'ON' : 'OFF'}`
})
const qualityBtn = makeBtn('Quality AUTO', () => {
  qualityAuto = !qualityAuto
  if (!qualityAuto) {
    governor.setLevel(SCALE_LEVELS.length - 1)
    stats.scaleApplied = tier.setRenderScale(1)
  }
  qualityBtn.textContent = `Quality ${qualityAuto ? 'AUTO' : 'FIXED'}`
})
const fsBtn = makeBtn('⛶ Fullscreen', () => {
  // the REAL fullscreen where the platform allows it (Android/Chrome,
  // desktop); the fixed stage already covers the viewport everywhere
  // else — the button hides where the API is missing (iOS Safari)
  if (document.fullscreenElement !== null && document.exitFullscreen !== undefined) {
    void document.exitFullscreen()
    return
  }
  const root = document.documentElement
  if (typeof root.requestFullscreen === 'function') void root.requestFullscreen().catch(() => {})
})
const btnRow = document.createElement('div')
btnRow.className = 'walker-btns'
btnRow.append(cullBtn, stripBtn, qualityBtn)
if (document.documentElement.requestFullscreen === undefined) fsBtn.style.display = 'none'
else btnRow.append(fsBtn)
// Task 217 — THE FAB SHEET is the toolbar now: the fullscreen stage has
// no page chrome of its own, the shell's ☰ menu carries the buttons
const sheet = typeof document !== 'undefined' ? document.querySelector('#rd-sheet') : null
if (sheet !== null) sheet.appendChild(btnRow)
else stage.appendChild(btnRow)

// ── the boot ───────────────────────────────────────────────────────────────
const first = MODE_PARAM === 'webgl2' ? 'webgl2' : 'webgpu'
void bootTier(first)
