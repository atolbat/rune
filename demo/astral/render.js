// "astral" demo — the rendering layer: instance records, soup builders and
// the commands over the dual-source shaders.
//
// Every dynamic quantity lives in stable pre-allocated Float32Arrays (the
// instance records) uploaded as a live PREFIX per frame — the rendererFeed
// pattern (GL: createBuffer('dynamic') + updateBuffer; WebGPU: the
// data-keyed vertex cache + syncVertexBuffer). The Task-165 vertex-bind
// memo keeps the per-frame rebinds dead on both backends.
//
// Static geometry (the lane network) is a triangle soup baked once at
// galaxy generation; the orbit rings are re-baked per system entry into a
// MAX-SIZED soup buffer (bufferSubData cannot grow a storage).

import { starShader, soupShader, laneShader, shipShader, planetShader, ringShader, MVP, MVP_PARALLAX, PX, PX_PARALLAX, CLOCK, FADE, GALAXY_FADE } from './shaders.js?v=2'
import { BUILDINGS, buildTime } from './galaxy.js?v=1'

export const RECORD_FLOATS = 16 // 64-byte stride, WG-aligned (vec2@0, vec2@8, vec4@16, vec4@32)
export const SOUP_FLOATS = 8    // 32-byte stride: pos vec2@0, color vec4@16

const MAX_SHIPS = 128
const MAX_RINGS = 32
const MAX_PLANETS = 16 // the sun + planets of one system
const MAX_BG_STARS = 620
const ORBIT_SEGMENTS = 56
const MAX_ORBIT_RINGS = 7

/** One record field accessor (offsets in floats). */
const F = {
  pos: 0, meta: 2, color: 4, state: 6,
}

export function createGameRender(renderer, world) {
  const isGL = renderer.backend === 'webgl2'
  const gl = isGL ? renderer.inner.gl : null
  const gpu = isGL ? null : renderer.inner.gpu

  // ── the instance record arrays (stable identities — the WG data-keyed cache) ──
  const starRecords = new Float32Array((world.systems.length + MAX_BG_STARS) * RECORD_FLOATS)
  const shipRecords = new Float32Array(MAX_SHIPS * RECORD_FLOATS)
  const planetRecords = new Float32Array(MAX_PLANETS * RECORD_FLOATS)
  const ringRecords = new Float32Array(MAX_RINGS * RECORD_FLOATS)

  // ── the soups ──
  const laneSoup = new Float32Array(world.lanes.length * 6 * SOUP_FLOATS)
  const orbitSoup = new Float32Array(MAX_ORBIT_RINGS * ORBIT_SEGMENTS * 6 * SOUP_FLOATS)
  let orbitVerts = 0
  let laneVerts = 0

  // ── the per-backend dynamic buffer plumbing ──
  const glDyn = isGL
    ? {
      stars: gl.createBuffer(starRecords, 'dynamic'),
      ships: gl.createBuffer(shipRecords, 'dynamic'),
      planets: gl.createBuffer(planetRecords, 'dynamic'),
      rings: gl.createBuffer(ringRecords, 'dynamic'),
      lanes: null, // static — created after the bake
      orbits: gl.createBuffer(orbitSoup, 'dynamic'),
    }
    : null

  // ── the background star field (baked once) ──
  {
    const rngB = mulberry(0x5eed ^ world.seed)
    const base = world.systems.length * RECORD_FLOATS
    for (let i = 0; i < MAX_BG_STARS; i++) {
      const at = (base + i) * RECORD_FLOATS
      const a = rngB() * Math.PI * 2
      const r = 240 + rngB() * 2400
      starRecords[at + F.pos] = Math.cos(a) * r
      starRecords[at + F.pos + 1] = Math.sin(a) * r
      const size = 1.2 + rngB() * 3.2
      starRecords[at + F.meta] = size
      starRecords[at + F.meta + 1] = rngB()
      const warm = rngB()
      const bright = 0.16 + rngB() * 0.34
      starRecords[at + F.color] = bright * (0.8 + warm * 0.3)
      starRecords[at + F.color + 1] = bright * (0.85 + warm * 0.1)
      starRecords[at + F.color + 2] = bright * (1.15 - warm * 0.25)
      starRecords[at + F.color + 3] = 0.5 + rngB() * 0.5
      // state: owner −1 (no ring), fade by depth
      starRecords[at + F.state] = -1
      starRecords[at + F.state + 3] = 0.55 + rngB() * 0.45
    }
  }

  // ── the lane soup (baked once) ──
  // The record: pos = the CENTERLINE endpoint (exact, no baked width),
  // dir = the unit perpendicular * the edge side (±1) — the vertex shader
  // expands this to a constant ~2.2 screen pixels (see the lane shader's
  // comment: a baked world-space width is sub-pixel at galaxy zoom and
  // the rasterizer drops it — the thin-line dropout).
  {
    for (const lane of world.lanes) {
      const A = world.systems[lane.a]
      const B = world.systems[lane.b]
      const dx = B.x - A.x
      const dy = B.y - A.y
      const len = Math.hypot(dx, dy) || 1
      const nx = -dy / len
      const ny = dx / len
      const alpha = 0.3
      const cr = 0.36 * alpha
      const cg = 0.46 * alpha
      const cb = 0.66 * alpha
      // CCW winding (the pipeline culls back faces — the pipeline default
      // is cull:'back', a CW quad would vanish whole; the working star quads
      // are CCW for the same reason)
      const quad = [
        A.x, A.y, -nx, -ny, cr, cg, cb, alpha,
        B.x, B.y, -nx, -ny, cr, cg, cb, alpha,
        B.x, B.y, nx, ny, cr, cg, cb, alpha,
        A.x, A.y, -nx, -ny, cr, cg, cb, alpha,
        B.x, B.y, nx, ny, cr, cg, cb, alpha,
        A.x, A.y, nx, ny, cr, cg, cb, alpha,
      ]
      laneSoup.set(quad, laneVerts * SOUP_FLOATS)
      laneVerts += 6
    }
    if (isGL) glDyn.lanes = gl.createBuffer(laneSoup)
  }

  // ── the commands (the attributes differ per backend — the vfx pattern) ──
  // — star command (galaxy stars + the background field) —
  const starAttr = {
    a_pos: { data: starRecords, size: 2, stride: 64, offset: 0, step: 'instance', ...(isGL ? { bufferId: glDyn.stars } : {}) },
    a_meta: { data: starRecords, size: 2, stride: 64, offset: 8, step: 'instance', ...(isGL ? { bufferId: glDyn.stars } : {}) },
    a_color: { data: starRecords, size: 4, stride: 64, offset: 16, step: 'instance', ...(isGL ? { bufferId: glDyn.stars } : {}) },
    a_state: { data: starRecords, size: 4, stride: 64, offset: 32, step: 'instance', ...(isGL ? { bufferId: glDyn.stars } : {}) },
  }
  const cmdStars = renderer.command({
    shader: { glsl: starShader.glsl, wgsl: starShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one' } },
    attributes: starAttr,
    uniforms: {
      u_mvp: () => MVP,
      u_px: () => PX,
      u_time: () => CLOCK,
      u_fade: () => GALAXY_FADE,
    },
    count: 6,
    instances: (p) => p.count,
  })
  const cmdBgStars = renderer.command({
    shader: { glsl: starShader.glsl, wgsl: starShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one' } },
    attributes: starAttr,
    uniforms: {
      u_mvp: () => MVP_PARALLAX,
      u_px: () => PX_PARALLAX,
      u_time: () => CLOCK,
      u_fade: () => [1],
    },
    count: 6,
    instances: (p) => p.count,
  })

  // — the lane pass (its own shader: the screen-constant width) —
  const cmdLanes = renderer.command({
    shader: { glsl: laneShader.glsl, wgsl: laneShader.wgsl },
    pipeline: { depth: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: {
      a_pos: { data: laneSoup, size: 2, stride: 32, offset: 0, ...(isGL ? { bufferId: glDyn.lanes } : {}) },
      a_dir: { data: laneSoup, size: 2, stride: 32, offset: 8, ...(isGL ? { bufferId: glDyn.lanes } : {}) },
      a_color: { data: laneSoup, size: 4, stride: 32, offset: 16, ...(isGL ? { bufferId: glDyn.lanes } : {}) },
    },
    uniforms: { u_mvp: () => MVP, u_px: () => PX, u_fade: () => GALAXY_FADE },
    count: (p) => p.count,
  })
  const cmdOrbits = renderer.command({
    shader: { glsl: soupShader.glsl, wgsl: soupShader.wgsl },
    pipeline: { depth: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: {
      a_pos: { data: orbitSoup, size: 2, stride: 32, offset: 0, ...(isGL ? { bufferId: glDyn.orbits } : {}) },
      a_color: { data: orbitSoup, size: 4, stride: 32, offset: 16, ...(isGL ? { bufferId: glDyn.orbits } : {}) },
    },
    uniforms: { u_mvp: () => MVP, u_fade: () => FADE },
    count: (p) => p.count,
  })

  // — the ship command —
  const shipAttr = {
    a_pos: { data: shipRecords, size: 2, stride: 64, offset: 0, step: 'instance', ...(isGL ? { bufferId: glDyn.ships } : {}) },
    a_meta: { data: shipRecords, size: 2, stride: 64, offset: 8, step: 'instance', ...(isGL ? { bufferId: glDyn.ships } : {}) },
    a_color: { data: shipRecords, size: 4, stride: 64, offset: 16, step: 'instance', ...(isGL ? { bufferId: glDyn.ships } : {}) },
    a_state: { data: shipRecords, size: 4, stride: 64, offset: 32, step: 'instance', ...(isGL ? { bufferId: glDyn.ships } : {}) },
  }
  const cmdShips = renderer.command({
    shader: { glsl: shipShader.glsl, wgsl: shipShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: shipAttr,
    uniforms: { u_mvp: () => MVP, u_px: () => PX, u_time: () => CLOCK },
    count: 6,
    instances: (p) => p.count,
  })

  // — the planet command (system view) —
  const planetAttr = {
    a_pos: { data: planetRecords, size: 2, stride: 64, offset: 0, step: 'instance', ...(isGL ? { bufferId: glDyn.planets } : {}) },
    a_meta: { data: planetRecords, size: 2, stride: 64, offset: 8, step: 'instance', ...(isGL ? { bufferId: glDyn.planets } : {}) },
    a_color: { data: planetRecords, size: 4, stride: 64, offset: 16, step: 'instance', ...(isGL ? { bufferId: glDyn.planets } : {}) },
    a_state: { data: planetRecords, size: 4, stride: 64, offset: 32, step: 'instance', ...(isGL ? { bufferId: glDyn.planets } : {}) },
  }
  const cmdPlanets = renderer.command({
    shader: { glsl: planetShader.glsl, wgsl: planetShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: planetAttr,
    uniforms: { u_mvp: () => MVP, u_time: () => CLOCK, u_fade: () => FADE },
    count: 6,
    instances: (p) => p.count,
  })

  // — the ring/effect command —
  const ringAttr = {
    a_pos: { data: ringRecords, size: 2, stride: 64, offset: 0, step: 'instance', ...(isGL ? { bufferId: glDyn.rings } : {}) },
    a_meta: { data: ringRecords, size: 2, stride: 64, offset: 8, step: 'instance', ...(isGL ? { bufferId: glDyn.rings } : {}) },
    a_color: { data: ringRecords, size: 4, stride: 64, offset: 16, step: 'instance', ...(isGL ? { bufferId: glDyn.rings } : {}) },
    a_state: { data: ringRecords, size: 4, stride: 64, offset: 32, step: 'instance', ...(isGL ? { bufferId: glDyn.rings } : {}) },
  }
  const cmdRings = renderer.command({
    shader: { glsl: ringShader.glsl, wgsl: ringShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one' } },
    attributes: ringAttr,
    uniforms: { u_mvp: () => MVP, u_px: () => PX, u_time: () => CLOCK },
    count: 6,
    instances: (p) => p.count,
  })

  // ── the record writers ──

  let starsDirty = true
  let selectedSystem = -1
  let selectedShip = -1

  function updateStarRecords() {
    for (const sys of world.systems) {
      const at = sys.id * RECORD_FLOATS
      starRecords[at + F.pos] = sys.x
      starRecords[at + F.pos + 1] = sys.y
      starRecords[at + F.meta] = sys.cls.size * 0.34
      starRecords[at + F.meta + 1] = (sys.id * 0.618) % 1
      const c = sys.cls.color
      starRecords[at + F.color] = c[0]
      starRecords[at + F.color + 1] = c[1]
      starRecords[at + F.color + 2] = c[2]
      starRecords[at + F.color + 3] = sys.planets.length > 0 ? 1.0 : 0.55
      starRecords[at + F.state] = sys.owner
      starRecords[at + F.state + 1] = sys.id === selectedSystem ? 1 : 0
      starRecords[at + F.state + 2] = sys.colonizing !== null ? sys.colonizing.progress : 0
      starRecords[at + F.state + 3] = 1
    }
    starsDirty = true
  }

  function writeShipRecord(at, ship) {
    const c = ship.kind === 'colony' ? [0.55, 0.95, 0.75] : [0.85, 0.75, 0.45]
    shipRecords[at + F.pos] = ship.x
    shipRecords[at + F.pos + 1] = ship.y
    shipRecords[at + F.meta] = ship.angle
    shipRecords[at + F.meta + 1] = ship.kind === 'colony' ? 1.1 : 1.5
    shipRecords[at + F.color] = c[0]
    shipRecords[at + F.color + 1] = c[1]
    shipRecords[at + F.color + 2] = c[2]
    shipRecords[at + F.color + 3] = 1
    const moving = ship.state === 'move' ? 1 : (ship.state === 'colonize' ? 2 : 0)
    shipRecords[at + F.state] = ship.kind === 'war' ? 1 : 0
    shipRecords[at + F.state + 1] = moving
    shipRecords[at + F.state + 2] = ship.id === selectedShip ? 1 : 0
    shipRecords[at + F.state + 3] = (ship.id * 0.37) % 1
  }

  function updateShipRecords() {
    let n = 0
    for (const ship of world.ships) {
      if (n >= MAX_SHIPS) break
      writeShipRecord(n * RECORD_FLOATS, ship)
      n++
    }
    return n
  }

  /** The system-view content: the sun + planets (static records — the shader orbits). */
  function setSystemView(sys) {
    planetRecords.fill(0)
    if (sys === null) return 0
    // the sun (type 4)
    const sunAt = 0
    const c = sys.cls.color
    planetRecords[sunAt + F.pos] = sys.x
    planetRecords[sunAt + F.pos + 1] = sys.y
    planetRecords[sunAt + F.meta] = 1.9 + sys.cls.size * 0.05
    planetRecords[sunAt + F.meta + 1] = 0
    planetRecords[sunAt + F.color] = c[0]
    planetRecords[sunAt + F.color + 1] = c[1]
    planetRecords[sunAt + F.color + 2] = c[2]
    planetRecords[sunAt + F.color + 3] = 1
    planetRecords[sunAt + F.state + 3] = 4 // the sun type
    let n = 1
    for (const planet of sys.planets) {
      if (n >= MAX_PLANETS) break
      const at = n * RECORD_FLOATS
      const pc = planet.type.color
      planetRecords[at + F.pos] = sys.x
      planetRecords[at + F.pos + 1] = sys.y
      planetRecords[at + F.meta] = planet.size * 0.5
      planetRecords[at + F.meta + 1] = planet.orbit
      planetRecords[at + F.color] = pc[0]
      planetRecords[at + F.color + 1] = pc[1]
      planetRecords[at + F.color + 2] = pc[2]
      planetRecords[at + F.color + 3] = 1
      planetRecords[at + F.state] = planet.phase
      planetRecords[at + F.state + 1] = planet.speed
      planetRecords[at + F.state + 2] = planet.queue !== null ? Math.min(1, planet.queue.progress / buildTime(BUILDINGS[planet.queue.building])) : 0
      planetRecords[at + F.state + 3] = planet.type.key === 'rock' ? 0 : planet.type.key === 'gas' ? 1 : planet.type.key === 'ice' ? 2 : 3
      n++
    }
    // the orbit ring soup
    orbitVerts = 0
    bakeOrbits(sys)
    return n
  }

  function bakeOrbits(sys) {
    const alpha = 0.1
    const rgb = 0.4 * alpha
    const put = (x, y) => {
      orbitSoup[orbitVerts * SOUP_FLOATS] = x
      orbitSoup[orbitVerts * SOUP_FLOATS + 1] = y
      orbitSoup[orbitVerts * SOUP_FLOATS + 4] = rgb
      orbitSoup[orbitVerts * SOUP_FLOATS + 5] = rgb
      orbitSoup[orbitVerts * SOUP_FLOATS + 6] = rgb * 1.2
      orbitSoup[orbitVerts * SOUP_FLOATS + 7] = alpha
      orbitVerts++
    }
    let rings = 0
    for (const planet of sys.planets) {
      if (rings >= MAX_ORBIT_RINGS) break
      const r = planet.orbit
      const t = 0.14 // ≥ 1px at the entry zoom (8) — thinner drops out
      for (let s = 0; s < ORBIT_SEGMENTS; s++) {
        const a0 = (s / ORBIT_SEGMENTS) * Math.PI * 2
        const a1 = ((s + 1) / ORBIT_SEGMENTS) * Math.PI * 2
        const x0 = sys.x + Math.cos(a0) * r
        const y0 = sys.y + Math.sin(a0) * r
        const x1 = sys.x + Math.cos(a1) * r
        const y1 = sys.y + Math.sin(a1) * r
        const nx0 = Math.sin(a0) * t
        const ny0 = -Math.cos(a0) * t
        const nx1 = Math.sin(a1) * t
        const ny1 = -Math.cos(a1) * t
        put(x0 - nx0, y0 - ny0)
        put(x0 + nx0, y0 + ny0)
        put(x1 - nx1, y1 - ny1)
        put(x1 - nx1, y1 - ny1)
        put(x0 + nx0, y0 + ny0)
        put(x1 + nx1, y1 + ny1)
      }
      rings++
    }
  }

  // the selection ring / effect records
  function updateRingRecords(view) {
    let n = 0
    // the selected planet ring (system view)
    if (view.mode === 'system' && view.selectedPlanet >= 0 && view.system !== null) {
      const planet = view.system.planets[view.selectedPlanet]
      if (planet !== undefined) {
        const ang = planet.phase + CLOCK[0] * planet.speed
        const px = view.system.x + Math.cos(ang) * planet.orbit
        const py = view.system.y + Math.sin(ang) * planet.orbit
        n = writeRing(n, px, py, planet.size * 0.5 * 1.9, [1.0, 0.85, 0.4, 1], 0, 0, 1, CLOCK[0])
      }
    }
    // the world effects
    for (const fx of world.effects) {
      if (n >= MAX_RINGS) break
      if (fx.kind === 'claim') n = writeRing(n, fx.x, fx.y, 6 + fx.t * 16, [0.45, 1.0, 0.7, 1], fx.t / 2.4, 1, 1, 0)
      else if (fx.kind === 'rivalClaim') n = writeRing(n, fx.x, fx.y, 6 + fx.t * 16, [1.0, 0.35, 0.3, 1], fx.t / 2.4, 2, 1, 0)
    }
    // the move target marker for the selected ship
    if (view.selectedShipObj !== null && view.selectedShipObj.state === 'move' && view.selectedShipObj.path !== null) {
      const dest = world.systems[view.selectedShipObj.path[view.selectedShipObj.path.length - 1]]
      if (dest !== undefined && n < MAX_RINGS) {
        n = writeRing(n, dest.x, dest.y, 5, [1.0, 0.8, 0.45, 1], 0, 3, 1, CLOCK[0] * 0.8)
      }
    }
    return n
  }

  function writeRing(n, x, y, radius, color, age, kind, fade, phase) {
    const at = n * RECORD_FLOATS
    ringRecords[at + F.pos] = x
    ringRecords[at + F.pos + 1] = y
    ringRecords[at + F.meta] = radius
    ringRecords[at + F.meta + 1] = 0
    ringRecords[at + F.color] = color[0]
    ringRecords[at + F.color + 1] = color[1]
    ringRecords[at + F.color + 2] = color[2]
    ringRecords[at + F.color + 3] = 1
    ringRecords[at + F.state] = age
    ringRecords[at + F.state + 1] = kind
    ringRecords[at + F.state + 2] = fade
    ringRecords[at + F.state + 3] = phase
    return n + 1
  }

  // ── the upload plumbing (per backend) ──
  function upload(records, liveFloats, name) {
    if (liveFloats <= 0) return
    if (isGL) gl.updateBuffer(glDyn[name], records.subarray(0, liveFloats))
    else gpu.syncVertexBuffer(records, liveFloats * 4)
  }

  // ── the frame draw (called from the renderer's frame callback) ──
  let planetCount = 0
  let sysViewId = -2

  function draw(record, view) {
    // the star records refresh (ownership/selection/colonize progress)
    updateStarRecords()
    const sysChanged = view.mode === 'system' && view.system !== null && sysViewId !== view.system.id
    if (sysChanged || view.mode !== 'system') {
      if (view.mode === 'system' && view.system !== null) {
        planetCount = setSystemView(view.system)
        sysViewId = view.system.id
      } else {
        sysViewId = -2
        planetCount = 0
        // the orbit rings die with the crossfade (they are invisible past
        // blend < 0.4 anyway — this frees the draw entirely)
        if (view.blend < 0.4) orbitVerts = 0
      }
    }
    // live planet queue progress (cheap: rewrite the queue fields)
    if (view.mode === 'system' && view.system !== null) {
      for (let i = 0; i < view.system.planets.length && i + 1 < MAX_PLANETS; i++) {
        const planet = view.system.planets[i]
        const at = (i + 1) * RECORD_FLOATS
        const q = planet.queue
        planetRecords[at + F.state + 2] = q !== null ? Math.min(1, q.progress / buildTime(BUILDINGS[q.building])) : 0
      }
      if (isGL) gl.updateBuffer(glDyn.planets, planetRecords)
      else gpu.syncVertexBuffer(planetRecords, planetRecords.length * 4)
    }

    // the galaxy-star prefix every frame; the baked background ONCE
    upload(starRecords, world.systems.length * RECORD_FLOATS, 'stars')
    if (!bgUploaded) {
      const bgFloats = starRecords.length - world.systems.length * RECORD_FLOATS
      if (isGL) {
        gl.updateBuffer(glDyn.stars, starRecords.subarray(world.systems.length * RECORD_FLOATS), world.systems.length * RECORD_FLOATS * 4)
      } else {
        gpu.syncVertexBuffer(starRecords, starRecords.length * 4)
      }
      bgUploaded = true
    }
    const shipCount = updateShipRecords()
    upload(shipRecords, shipCount * RECORD_FLOATS, 'ships')
    const ringCount = updateRingRecords(view)
    upload(ringRecords, ringCount * RECORD_FLOATS, 'rings')

    // the soups: static lanes (once) + orbits (on entry)
    if (isGL) {
      if (!lanesUploaded) { gl.updateBuffer(glDyn.lanes, laneSoup); lanesUploaded = true }
      if (sysChanged && view.mode === 'system') gl.updateBuffer(glDyn.orbits, orbitSoup.subarray(0, orbitVerts * SOUP_FLOATS))
    } else {
      if (!lanesUploaded) { gpu.syncVertexBuffer(laneSoup, laneSoup.length * 4); lanesUploaded = true }
      if (sysChanged && view.mode === 'system') gpu.syncVertexBuffer(orbitSoup, orbitVerts * SOUP_FLOATS * 4)
    }

    // the draw list (the tape order = the painter's order; the fades cross the view blend)
    record(cmdBgStars, { count: MAX_BG_STARS })
    record(cmdLanes, { count: laneVerts })
    if (orbitVerts > 0) record(cmdOrbits, { count: orbitVerts })
    record(cmdStars, { count: world.systems.length })
    if (planetCount > 0) record(cmdPlanets, { count: planetCount })
    if (ringCount > 0) record(cmdRings, { count: ringCount })
    if (shipCount > 0) record(cmdShips, { count: shipCount })
  }

  let lanesUploaded = false
  let bgUploaded = false

  // ── the view-facing API ──
  return {
    draw,
    get starRecords() { return starRecords },
    setSelected(systemId, shipId) {
      selectedSystem = systemId
      selectedShip = shipId
      updateStarRecords()
    },
    /** The world position of a planet (the orbit math mirrored in JS). */
    planetPos(sys, planet) {
      const ang = planet.phase + CLOCK[0] * planet.speed
      return [sys.x + Math.cos(ang) * planet.orbit, sys.y + Math.sin(ang) * planet.orbit]
    },
    dispose() {
      // the renderer's own dispose frees the facade buffers wholesale
    },
  }
}

function mulberry(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
