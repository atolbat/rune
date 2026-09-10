// "astral" demo — a mini grand-strategy sandbox on the rune renderer:
// a spiral galaxy of 72 seeded star systems joined by travel lanes, an
// economy of mines / solar farms / orbital labs on colonized planets,
// colony ships and corvettes flying BFS paths over the lane graph, and a
// rival power (the Hegemony) expanding across the map — claim 60% of the
// colonizable systems before they do; parked corvettes deny their claims.
//
// The rendering surface this demo exercises end to end:
//   • one auto renderer (WebGPU / WebGL2 toggle via the shell) on a
//     fullscreen canvas;
//   • 6 dual-source commands (GLSL + WGSL twins): two instanced star
//     passes (a parallax background field + the galaxy), the lane pass (a
//     line soup with a screen-constant width — the vertex shader expands
//     the baked centerline+perpendicular to ~2.2px), the orbit-ring soup,
//     the instanced ship pass and the instanced planet/sun pass — plus
//     the ring/effect pass (selection, claim flashes, move markers);
//   • the rendererFeed dynamic-buffer pattern on both backends (GL:
//     createBuffer('dynamic') + updateBuffer per frame; WebGPU: the
//     data-keyed vertex cache + syncVertexBuffer) — with the Task-165
//     vertex-bind memo, the steady-state frame re-asserts nothing;
//   • uniforms through the shared arena (mat4 cameras, per-pass fades),
//     instance-step attributes with interleaved 64-byte records.
//
// The dist import carries the stale-cache guard: rune.esm.js is at ?v=165.

import { createRenderer } from '../../dist/rune.esm.js?v=165'
import {
  generateWorld, stepWorld, orderShip, queueBuilding, queueShip, shipName,
  OWNER, SHIPS, lanePath,
} from './galaxy.js?v=1'
import { createGameRender } from './render.js?v=1'
import { createUI } from './ui.js?v=1'
import { setCamera, MVP, MVP_PARALLAX, PX, PX_PARALLAX, CLOCK, FADE, GALAXY_FADE } from './shaders.js?v=1'

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

const cam = { x: world.systems[0].x, y: world.systems[0].y, z: 0.42, tx: 0, ty: 0, tz: 0.42 }

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
    frame: 0, // the liveness counter (the gates poll it)
  }
}

/* ─── the input: tap / pan / pinch / wheel ─────────────────────────────────── */

function bindInput(canvas) {
  const pointers = new Map()
  let pinchDist = 0
  let pinchZ = 0
  let moved = 0
  let downAt = 0

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture?.(e.pointerId)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved = 0
    downAt = performance.now()
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
      pinchZ = cam.z
    }
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
      const [a, b] = [...pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchDist > 0 && d > 0) {
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinchZ * (d / pinchDist))
      }
      return
    }
    // pan (both views)
    cam.x -= dx / cam.z
    cam.y += dy / cam.z
    cam.tx = cam.x
    cam.ty = cam.y
    clampCam()
  })

  const up = (e) => {
    const had = pointers.delete(e.pointerId)
    if (!had) return
    if (pointers.size === 0 && moved < 9 && performance.now() - downAt < 400) {
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
}

/** Zoom keeping the world point under (sx, sy) fixed. */
function zoomAt(sx, sy, z) {
  const [w, h] = activeRenderer !== null ? activeRenderer.size.peek() : [1, 1]
  const zClamped = clampZoom(z)
  const wx = cam.x + (sx - w / 2) / cam.z
  const wy = cam.y - (sy - h / 2) / cam.z
  cam.z = zClamped
  cam.x = wx - (sx - w / 2) / zClamped
  cam.y = wy + (sy - h / 2) / zClamped
  cam.tx = cam.x
  cam.ty = cam.y
  cam.tz = zClamped
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
  const wx = cam.x + (sx - w / 2) / cam.z
  const wy = cam.y - (sy - h / 2) / cam.z

  // 1. a planet (system view) — the view's subject wins over everything
  if (view.mode === 'system' && view.system !== null) {
    const sys = view.system
    for (let pi = 0; pi < sys.planets.length; pi++) {
      const planet = sys.planets[pi]
      const ang = planet.phase + CLOCK[0] * planet.speed
      const px = sys.x + Math.cos(ang) * planet.orbit
      const py = sys.y + Math.sin(ang) * planet.orbit
      const r = Math.max(planet.size * 0.5, 14 / cam.z) + 6 / cam.z
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
  shell.slot.append(canvas)
  bindInput(canvas)

  shell.log.event(`Booting: ${mode}`)

  try {
    const renderer = createRenderer({
      canvas,
      backend: mode === 'auto' ? undefined : mode,
      clear: { color: [0.016, 0.02, 0.033, 1], depth: 1 },
      onGlError: (message) => shell.log.warn(`GL: ${message}`),
      onGpuError: (message) => shell.log.warn(`GPU: ${message}`),
    })
    await renderer.start()
    if (seq !== bootSeq) { renderer.dispose(); return }
    activeRenderer = renderer
    if (ui === null) ui = createUI(world, view, actions)
    gameRender = createGameRender(renderer, world)
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
  const blendTarget = view.mode === 'system' ? 1 : 0
  view.blend += (blendTarget - view.blend) * k

  // the matrices + the shared uniforms
  const [w, h] = activeRenderer.size.peek()
  setCamera(MVP, cam.x, cam.y, cam.z, ctx.aspect, h)
  const bgPx = Math.max(cam.z * 0.09, 0.05)
  setCamera(MVP_PARALLAX, cam.x * 0.15, cam.y * 0.15, bgPx, ctx.aspect, h)
  PX[0] = cam.z
  PX_PARALLAX[0] = bgPx
  FADE[0] = view.blend
  GALAXY_FADE[0] = 1 - view.blend

  gameRender.draw(record, view)
  ui?.tick(dtRaw, cam, w, h)
}

await boot(shell.mode)
