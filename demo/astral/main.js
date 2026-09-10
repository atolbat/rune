// "astral" demo — a mini grand-strategy sandbox on the rune renderer:
// a spiral galaxy of 72 seeded star systems joined by travel lanes, an
// economy of mines / solar farms / orbital labs on colonized planets,
// colony ships and corvettes flying BFS paths over the lane graph, and a
// rival power (the Hegemony) expanding across the map — claim 60% of the
// colonizable systems before they do; parked corvettes deny their claims.
//
// The rendering surface this demo exercises end to end:
//   • one auto renderer (WebGPU / WebGL2 toggle via the shell) on a
//     fullscreen canvas — now a REAL 3D PERSPECTIVE SCENE: a tilted orbit
//     camera over the galaxy plane, camera-facing sprite quads, a textured
//     spiral haze in the plane, 3D star fields, nebula puffs and a
//     sphere-shaded planet atlas (see render.js);
//   • 12 dual-source commands (GLSL + WGSL twins) over textures (procedural
//     at boot, three real NASA/ESO bitmaps swapped in asynchronously);
//   • the rendererFeed dynamic-buffer pattern on both backends (GL:
//     createBuffer('dynamic') + updateBuffer per frame; WebGPU: the
//     data-keyed vertex cache + syncVertexBuffer) — with the Task-165
//     vertex-bind memo, the steady-state frame re-asserts nothing;
//   • uniforms through the shared arena (mat4 cameras, per-pass fades,
//     vec3 billboard axes), instance-step attributes with interleaved
//     64-byte records.
//
// MOBILE INPUT: the canvas carries touch-action: none — the browser's
// page-pinch never races the game's pinch (the field report: "zooming
// zooms the whole page even on the canvas"). One finger pans, two fingers
// pinch (zoom at the midpoint), twist (yaw the camera — the 3D plane
// rotates under you) and pan at once; taps stay taps (a 9px/400ms slop).
//
// The dist import carries the stale-cache guard: rune.esm.js is at ?v=169.

import { createRenderer } from '../../dist/rune.esm.js?v=169'
import {
  generateWorld, stepWorld, orderShip, queueBuilding, queueShip, shipName,
  OWNER, SHIPS, lanePath,
} from './galaxy.js?v=1'
import { createGameRender } from './render.js?v=3'
import { createUI } from './ui.js?v=2'
import {
  setCamera3D, screenToWorld, worldToScreen, panBy,
  MVP, PXK, CLOCK, FADE, GALAXY_FADE, NEB_FADE, SHIP_CAP,
} from './shaders.js?v=3'

/* ─── the seed (the same seed replays the same galaxy) ───────────────────── */

const url = new URL(location.href)
const seedArg = url.searchParams.get('seed')
const seed = seedArg !== null ? (Number.parseInt(seedArg, 10) >>> 0) : ((Date.now() / 1000) | 0) >>> 0

/* ─── the module state (survives backend re-boots; reset on restart) ─────── */

let world = generateWorld(seed)
let gameRender = null
let activeRenderer = null
let bootSeq = 0

const view = {
  mode: 'galaxy', // 'galaxy' | 'system'
  system: null, // the system object of the system view
  selectedSystem: -1,
  selectedPlanet: -1,
  selectedShipObj: null,
  speed: 1,
  blend: 0, // 0 = the galaxy layer, 1 = the system layer
}

// the camera: x/y target on the plane, z = CSS px per world unit, yaw =
// the twist around the view axis, tilt = the pitch from face-on
const cam = {
  x: world.systems[0].x, y: world.systems[0].y, z: 0.42, tx: 0, ty: 0, tz: 0.42,
  yaw: 0, tyaw: 0, tilt: 0.5, ttilt: 0.5,
}

// land the camera between the homeworld and the galactic core (the home can
// sit on the galaxy's outer edge — a camera centered on it would leave half
// the screen on empty void)
{
  const home = world.systems.find(s => s.owner === OWNER.PLAYER)
  if (home !== undefined) { cam.x = cam.tx = home.x * 0.6; cam.y = cam.ty = home.y * 0.6 }
}

/* ─── the shell ───────────────────────────────────────────────────────────── */

const shell = window.RuneDemoShell.mount({
  layout: 'fullscreen',
  title: 'rune — astral',
  defaults: { mode: 'auto' },
  onMode: (mode) => void boot(mode),
  onPause: () => { activeRenderer?.stop(); shell.log.event('Paused') },
  onResume: () => { activeRenderer?.start(); shell.log.event('Resumed') },
})
shell.log.event(`Galaxy seed ${seed} — ${world.systems.length} systems, ${world.colonizableCount} colonizable`)
shell.log.info('Goal: settle 60% of the colonizable systems before the Hegemony.')

/* ─── the actions (the UI's handle into the game) ─────────────────────────── */

const actions = {
  setSpeed(s) { view.speed = s },
  exitSystem() {
    if (view.mode !== 'system') return
    view.mode = 'galaxy'
    view.system = null
    view.selectedPlanet = -1
    cam.tz = 0.42
  },
  selectPlanet(sys, pi) {
    view.selectedPlanet = pi
    ui?.refreshPanel()
  },
  queueShip(sys, kind) {
    if (queueShip(world, sys, kind)) {
      shell.log.event(`queued ${SHIPS[kind].name} at ${sys.name}`)
    } else {
      shell.log.warn(`cannot queue ${SHIPS[kind].name} — not enough resources or a ship is already building`)
    }
    ui?.refreshPanel()
  },
  queueBuilding(sys, planet, key) {
    if (queueBuilding(world, sys, planet, key)) {
      shell.log.event(`queued building at ${sys.name}`)
    } else {
      shell.log.warn('cannot queue — occupied, full or unaffordable')
    }
    ui?.refreshPanel()
  },
  sendNearestColony(sys) {
    let best = null
    let bestD = Infinity
    for (const ship of world.ships) {
      if (ship.kind !== 'colony' || ship.state !== 'idle') continue
      const d = Math.hypot(ship.x - sys.x, ship.y - sys.y)
      if (d < bestD) { bestD = d; best = ship }
    }
    if (best === null) return
    if (orderShip(world, best, sys.id)) {
      shell.log.event(`${shipName(best)} → ${sys.name}`)
      view.selectedShipObj = best
      gameRender?.setSelected(view.selectedSystem, best.id)
    }
    ui?.refreshPanel()
  },
  shipNameOf: shipName,
  restart() {
    shell.log.event('New galaxy')
    ui?.dispose()
    ui = null
    const nextSeed = ((Date.now() / 1000) | 0) >>> 0
    world = generateWorld(nextSeed)
    view.mode = 'galaxy'
    view.system = null
    view.selectedSystem = -1
    view.selectedPlanet = -1
    view.selectedShipObj = null
    view.blend = 0
    const home = world.systems.find(s => s.owner === OWNER.PLAYER)
    if (home !== undefined) { cam.x = cam.tx = home.x * 0.6; cam.y = cam.ty = home.y * 0.6 }
    cam.z = cam.tz = 0.42
    cam.yaw = cam.tyaw = 0
    shell.log.event(`Galaxy seed ${nextSeed}`)
    void boot(shell.mode)
  },
}

let ui = null

/* ─── the probe handle (the __vfx* pattern: live getters — the world is
       re-created on restart, so the gates read through these, never a stale
       capture) ────────────────────────────────────────────────────────── */

if (typeof window !== 'undefined') {
  window.__astral = {
    get world() { return world },
    get view() { return view },
    get cam() { return cam },
    get clock() { return CLOCK[0] },
    /** world plane point → screen CSS px (the gates' projection handle). */
    project(wx, wy) {
      const [w, h] = activeRenderer !== null ? activeRenderer.size.peek() : [1, 1]
      const out = { x: 0, y: 0 }
      return worldToScreen(wx, wy, w, h, out) ?? { x: -9999, y: -9999 }
    },
    frame: 0, // the liveness counter (the gates poll it)
  }
}

/* ─── the input: tap / pan / pinch / twist / wheel ────────────────────────── */
// THE TOUCH FIX: touch-action:none on the canvas (set at creation + CSS) —
// the browser stops treating the game's pinch as a page pinch. The
// gesturestart guard covers old iOS Safari, dblclick covers double-tap zoom.

function bindInput(canvas) {
  const pointers = new Map()
  let pinchDist = 0
  let pinchAngle = 0
  let pinchZ = 0
  let pinchYaw = 0
  let midX = 0
  let midY = 0
  let moved = 0
  let downAt = 0

  const snapTwoFinger = () => {
    const [a, b] = [...pointers.values()]
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
    pinchAngle = Math.atan2(b.y - a.y, b.x - a.x)
    pinchZ = cam.z
    pinchYaw = cam.yaw
    midX = (a.x + b.x) / 2
    midY = (a.y + b.y) / 2
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture?.(e.pointerId)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved = 0
    downAt = performance.now()
    if (pointers.size === 2) snapTwoFinger()
  })

  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId)
    if (p === undefined) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    p.x = e.clientX
    p.y = e.clientY
    moved += Math.abs(dx) + Math.abs(dy)
    if (pointers.size === 2) {
      // pinch + twist + two-finger pan, all at once
      const [a, b] = [...pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const ang = Math.atan2(b.y - a.y, b.x - a.x)
      const nMidX = (a.x + b.x) / 2
      const nMidY = (a.y + b.y) / 2
      if (pinchDist > 8 && d > 8) {
        zoomAt(nMidX, nMidY, pinchZ * (d / pinchDist))
        cam.yaw = pinchYaw + (ang - pinchAngle)
        cam.tyaw = cam.yaw
      }
      // the midpoint drag pans (the world under the fingers)
      panBy(cam, nMidX - midX, nMidY - midY)
      midX = nMidX
      midY = nMidY
      clampCam()
      return
    }
    // pan (both views)
    panBy(cam, dx, dy)
    cam.tx = cam.x
    cam.ty = cam.y
    clampCam()
  })

  const up = (e) => {
    const had = pointers.delete(e.pointerId)
    if (!had) return
    // a tap is "down→up without movement" — the slop is the discriminator,
    // not the duration (a slow main thread can deliver the pair a second
    // apart; a held-still-then-released finger still means "select this")
    if (pointers.size === 0 && moved < 9) {
      tap(e.clientX, e.clientY)
    }
    if (pointers.size < 2) pinchDist = 0
  }
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', up)

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    zoomAt(e.clientX, e.clientY, cam.z * Math.exp(-e.deltaY * 0.0012))
  }, { passive: false })

  // iOS Safari's page-level gesture events never fire with touch-action:none
  // on modern builds — this guard is for the old ones
  const stopGesture = (e) => { e.preventDefault() }
  document.addEventListener('gesturestart', stopGesture)
  document.addEventListener('gesturechange', stopGesture)
  canvas.addEventListener('dblclick', (e) => e.preventDefault())
}

/**
 * Zoom keeping the world point under (sx, sy) fixed — Newton by world-space
 * correction: read the world point under the cursor, change z, then move the
 * camera target by wherever that point now lands. Two iterations converge
 * past pixel precision under any yaw/tilt.
 */
function zoomAt(sx, sy, z) {
  const [w, h] = activeRenderer !== null ? activeRenderer.size.peek() : [1, 1]
  const before = screenToWorld(sx, sy, w, h)
  cam.z = clampZoom(z)
  if (before === null) return
  for (let i = 0; i < 2; i++) {
    const now = screenToWorld(sx, sy, w, h)
    if (now === null) break
    cam.x += before[0] - now[0]
    cam.y += before[1] - now[1]
  }
  cam.tx = cam.x
  cam.ty = cam.y
  cam.tz = cam.z
  clampCam()
}

function clampZoom(z) {
  const galaxy = view.mode === 'galaxy'
  const lo = galaxy ? 0.28 : 6
  const hi = galaxy ? 3.2 : 34
  return Math.min(hi, Math.max(lo, z))
}

function clampCam() {
  const bound = view.mode === 'galaxy' ? 1080 : 60
  const cx = view.mode === 'system' && view.system !== null ? view.system.x : cam.tx
  const cy = view.mode === 'system' && view.system !== null ? view.system.y : cam.ty
  cam.x = Math.min(cx + bound, Math.max(cx - bound, cam.x))
  cam.y = Math.min(cy + bound, Math.max(cy - bound, cam.y))
}

/** A tap: planets (system view) > ships vs systems (proportional) > deselect. */
function tap(sx, sy) {
  const [w, h] = activeRenderer !== null ? activeRenderer.size.peek() : [1, 1]
  const hit = screenToWorld(sx, sy, w, h)
  if (hit === null) return
  const wx = hit[0]
  const wy = hit[1]

  // 1. a planet (system view) — the view's subject wins over everything
  if (view.mode === 'system' && view.system !== null) {
    const sys = view.system
    for (let pi = 0; pi < sys.planets.length; pi++) {
      const planet = sys.planets[pi]
      const ang = planet.phase + CLOCK[0] * planet.speed
      const px = sys.x + Math.cos(ang) * planet.orbit
      const py = sys.y + Math.sin(ang) * planet.orbit
      const r = Math.max(planet.size * 0.5 * 1.55, 14 / cam.z) + 6 / cam.z
      if (Math.hypot(px - wx, py - wy) < r) {
        view.selectedPlanet = view.selectedPlanet === pi ? -1 : pi
        if (view.selectedPlanet >= 0) shell.log.event(`${sys.name} · ${planet.type.name} selected`)
        ui?.refreshPanel()
        return
      }
    }
  }

  // 2. ships and systems compete PROPORTIONALLY: the hit whose normalized
  //    distance (distance / hit radius) is smallest wins — a tap dead-center
  //    on the star selects the SYSTEM even with ships orbiting inside its
  //    halo, while a tap on the ship itself (the orbiting dot) wins for the
  //    ship. The screen-space radii: 18px ships, 26px systems.
  let hitShip = null
  let hitSys = null
  let bestScore = Infinity
  for (const ship of world.ships) {
    const d = Math.hypot(ship.x - wx, ship.y - wy) * cam.z
    const score = d / 18
    if (score <= 1 && score < bestScore) { bestScore = score; hitShip = ship; hitSys = null }
  }
  for (const sys of world.systems) {
    const d = Math.hypot(sys.x - wx, sys.y - wy) * cam.z
    const score = d / 26
    if (score <= 1 && score < bestScore) { bestScore = score; hitSys = sys; hitShip = null }
  }

  if (hitShip !== null) {
    view.selectedShipObj = hitShip
    gameRender?.setSelected(view.selectedSystem, hitShip.id)
    ui?.refreshPanel()
    if (view.mode === 'galaxy') shell.log.event(`${shipName(hitShip)} selected — tap a system to send it`)
    return
  }

  if (hitSys !== null) {
    // a selected ship + a tap on a (different) system = a move order
    if (view.selectedShipObj !== null && view.selectedShipObj.state !== 'colonize') {
      const ship = view.selectedShipObj
      if (orderShip(world, ship, hitSys.id)) {
        shell.log.event(`${shipName(ship)} → ${hitSys.name}`)
        view.selectedSystem = hitSys.id
        gameRender?.setSelected(hitSys.id, ship.id)
        ui?.refreshPanel()
        return
      }
    }
    if (view.mode === 'galaxy') {
      if (view.selectedSystem === hitSys.id) {
        enterSystem(hitSys)
      } else {
        view.selectedSystem = hitSys.id
        gameRender?.setSelected(hitSys.id, view.selectedShipObj !== null ? view.selectedShipObj.id : -1)
        ui?.refreshPanel()
      }
    } else {
      // in the system view a tap on the far distance = jump the selection
      view.selectedSystem = hitSys.id
      gameRender?.setSelected(hitSys.id, -1)
      ui?.refreshPanel()
    }
    return
  }

  // 3. empty space: deselect
  view.selectedPlanet = -1
  view.selectedShipObj = null
  gameRender?.setSelected(view.selectedSystem, -1)
  ui?.refreshPanel()
}

function enterSystem(sys) {
  view.mode = 'system'
  view.system = sys
  view.selectedPlanet = -1
  view.selectedSystem = sys.id
  const [w, h] = activeRenderer !== null ? activeRenderer.size.peek() : [400, 700]
  const maxOrbit = sys.planets.length > 0 ? sys.planets[sys.planets.length - 1].orbit : 8
  cam.tx = sys.x
  cam.ty = sys.y
  cam.tz = Math.min(30, Math.max(8, (Math.min(w, h) * 0.44) / (maxOrbit + 2)))
  shell.log.event(`entered ${sys.name} — ${sys.cls.name}`)
  ui?.refreshPanel()
}

/* ─── the boot (backend toggle / restart) ─────────────────────────────────── */

async function boot(mode) {
  const seq = ++bootSeq

  if (activeRenderer !== null) {
    try { activeRenderer.dispose() } catch { /* the context may have died with the canvas */ }
    activeRenderer = null
    gameRender = null
  }
  shell.slot.replaceChildren()
  const canvas = document.createElement('canvas')
  canvas.id = 'canvas'
  // THE TOUCH FIX: the browser must not own pinch/pan on the game surface
  canvas.style.touchAction = 'none'
  shell.slot.append(canvas)
  bindInput(canvas)

  shell.log.event(`Booting: ${mode}`)

  try {
    const renderer = createRenderer({
      canvas,
      backend: mode === 'auto' ? undefined : mode,
      clear: { color: [0.008, 0.011, 0.02, 1], depth: 1 },
      onGlError: (message) => shell.log.warn(`GL: ${message}`),
      onGpuError: (message) => shell.log.warn(`GPU: ${message}`),
    })
    await renderer.start()
    if (seq !== bootSeq) { renderer.dispose(); return }
    activeRenderer = renderer
    if (ui === null) ui = createUI(world, view, actions)
    gameRender = createGameRender(renderer, world, shell)
    renderer.frame(frameCallback)
    const backendName = renderer.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
    shell.setBadge(backendName, renderer.backend === 'webgpu' ? 'gpu' : 'gl')
    shell.log.info(`Backend: ${backendName}`)
  } catch (error) {
    if (seq !== bootSeq) return
    const message = error instanceof Error ? error.message : String(error)
    shell.setBadge(mode === 'webgpu' ? 'WebGPU unavailable' : 'startup failed', 'err')
    shell.log.error(`Boot on ${mode} failed: ${message}`)
    if (mode === 'webgpu') shell.log.info('Not a library error — the backend is missing here. Switch the toggle to Auto or WebGL2.')
    return
  }
  shell.markReady()
}

/* ─── the frame loop ───────────────────────────────────────────────────────── */

let outcomeShown = false

function frameCallback(ctx, record) {
  const dtRaw = Math.min(ctx.dt, 0.1) // a background tab can deliver huge dt
  const dt = dtRaw * view.speed
  CLOCK[0] += dt
  window.__astral.frame++

  const events = []
  stepWorld(world, dt, events)
  for (const e of events) shell.log.event(e)

  if (world.outcome !== null && !outcomeShown) {
    outcomeShown = true
    ui?.showOutcome(world.outcome)
    shell.log.event(world.outcome === 'won' ? 'VICTORY — the galaxy is yours' : 'DEFEAT — the Hegemony wins')
  }

  // the camera easing (frame-rate independent)
  const k = 1 - Math.exp(-7 * dtRaw)
  cam.x += (cam.tx - cam.x) * k
  cam.y += (cam.ty - cam.y) * k
  cam.z += (cam.tz - cam.z) * k
  // the yaw eases the short way around the circle
  let dyaw = (cam.tyaw - cam.yaw) % (Math.PI * 2)
  if (dyaw > Math.PI) dyaw -= Math.PI * 2
  if (dyaw < -Math.PI) dyaw += Math.PI * 2
  cam.yaw += dyaw * k
  // the tilt target: cinematic when zoomed out, strategic when close in
  const blendTarget = view.mode === 'system' ? 1 : 0
  view.blend += (blendTarget - view.blend) * k
  const tiltTarget = view.mode === 'system'
    ? 0.21 // ~12° — the orbits read as ellipses, the rings show
    : 0.32 + 0.26 * Math.min(1, Math.max(0, (1.5 - cam.z) / 1.2)) // 33°..48°
  cam.tilt += (tiltTarget - cam.tilt) * (1 - Math.exp(-3.5 * dtRaw))

  // the matrices + the shared uniforms
  const [w, h] = activeRenderer.size.peek()
  setCamera3D(cam, ctx.aspect, w, h)
  FADE[0] = view.blend
  GALAXY_FADE[0] = 1 - view.blend
  NEB_FADE[0] = 0.9 * GALAXY_FADE[0]
  // in the system view ships are markers, not giants (a galaxy-scale hull
  // would dwarf the textured planets)
  SHIP_CAP[0] = 240 - 230 * view.blend

  gameRender.draw(record, view)
  ui?.tick(dtRaw, cam, w, h)
}

await boot(shell.mode)
