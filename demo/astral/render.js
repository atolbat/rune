// "astral" demo — the rendering layer: instance records, soups, textures and
// the commands over the dual-source shaders.
//
// THE 3D LAYOUT (all gameplay stays on the world plane z = 0):
//   • the sky quad (the ESO Milky Way panorama) follows the camera at a
//     frustum-covering distance — it never runs out of frame at any zoom;
//   • ~1500 background stars scattered in a deep 3D shell below the plane —
//     the perspective parallax replaces the old parallax-camera trick;
//   • 4 nebulas drift below the galaxy, slowly turning;
//   • the arm-aligned spiral haze lies IN the plane (z = −8) under the
//     systems — it tilts with the camera like a real disc;
//   • lanes/orbits are centerline soups expanded to constant screen px in
//     eye space; ringed gas giants get in-plane annuli split near/far.
//
// THE TEXTURE STACK: everything procedural (textures.js — deterministic by
// the world seed, zero network on the critical path); the planet surfaces
// live in one 1024×512 ATLAS of 256×128 equirect tiles (rock/gas/ice/lava/
// garden/sun), sampled through sphere normals by the planet shader. The
// three REAL bitmaps (assets/: the ESO panorama, NASA moon + earth via the
// three.js examples, ~127 KB total) load asynchronously and swap into the
// SAME handles — moon → the rock tile, earth → the garden tile, panorama →
// the sky — a failed fetch changes nothing.
//
// Every dynamic quantity lives in stable pre-allocated Float32Arrays (the
// instance records) uploaded as live prefixes per frame — the rendererFeed
// pattern (GL: createBuffer('dynamic') + updateBuffer; WebGPU: the
// data-keyed vertex cache + syncVertexBuffer). Static records (the star
// field, the nebulas) upload once.

import {
  starShader, bgStarShader, skyShader, nebulaShader, hazeShader, laneShader,
  shipShader, planetShader, pringShader, ringShader, territoryShader, blackholeShader,
  MVP, VIEW, PROJ, RIGHT, UP, PXK, LINEK, YAW, CLOCK, FADE, GALAXY_FADE, NEB_FADE, SHIP_CAP,
  SPLIT, SKY_CENTER, SKY_HALF, SKY_U0, SKY_WIN, SKY_GAIN,
} from './shaders.js?v=5'
import { BUILDINGS, buildTime, GALAXY_RADIUS, OWNER } from './galaxy.js?v=3'
import { makeTextures } from './textures.js?v=3'
import { createPostChain } from './post.js?v=1'

export const RECORD_FLOATS = 16 // 64-byte stride (pos vec3@0, meta@16, color@32, state@48)
export const SOUP_FLOATS = 9    // 36-byte stride: pos vec2@0, dir vec2@8, color vec4@16, t@32

const MAX_SHIPS = 128
const MAX_RINGS = 32
const MAX_PLANETS = 16 // the sun + planets of one system
const MAX_PRINGS = 8   // ringed gas giants of one system
const MAX_BHS = 4      // the black-hole landmarks
const BG_STARS_BRIGHT = 900
const BG_STARS_MICRO = 1100
const BG_STARS = BG_STARS_BRIGHT + BG_STARS_MICRO
const ORBIT_SEGMENTS = 56
const MAX_ORBIT_RINGS = 7
// the bezier bake: each hyperlane becomes a quadratic curve with a
// perpendicular sag (6–12% of the lane length, seeded) — organic Stellaris
// hyperlane arcs, never ruler-straight graph edges
const LANE_SEGS = 8
// the beauty pass: the spiral disc GLOWS again — with the arm color story
// baked into the texture (teal→violet→ember zones + HII knots) and the
// bloom chain lifting the arms, the galaxy reads as a luminous colored disc
const HAZE_GAIN = [0.34]

// ── the empire territory field (the Stellaris border bake) ──
// 256² RGBA over the galaxy plane; R = the player's metaball sum, G = the
// Hegemony's. Rebaked ONLY when ownership changes (see bakeTerritory).
const TERR_SIZE = 256
const TERR_SPAN = GALAXY_RADIUS * 2.3

/** One record field accessor (offsets in floats — see the header). */
const F = {
  pos: 0, meta: 4, color: 8, state: 12,
}

// the atlas: 4×2 grid of 256×128 tiles in 1024×512
const ATLAS_W = 1024, ATLAS_H = 512, TILE_W = 256, TILE_H = 128
const TILE = { rock: 0, gas: 1, ice: 2, lava: 3, garden: 4, sun: 5 }

// the fetched-bitmap cache (survives backend re-boots — the fetches run once)
const bitmapCache = new Map()

export function createGameRender(renderer, world, shell, canvas) {
  const isGL = renderer.backend === 'webgl2'
  const gl = isGL ? renderer.inner.gl : null
  const gpu = isGL ? null : renderer.inner.gpu

  // THE POST CHAIN — the whole scene renders into a surface, then bloom +
  // grade + vignette composite to the canvas (see post.js). The chain reads
  // the DRAWING BUFFER size off the canvas (the authoritative source — the
  // renderer's resize self-heals to it too)
  const post = createPostChain(renderer)
  const bufferSize = () => (canvas !== undefined && canvas.width > 0
    ? [canvas.width, canvas.height]
    : [Math.round(800 * (globalThis.devicePixelRatio ?? 1)), Math.round(600 * (globalThis.devicePixelRatio ?? 1))])

  // ── the instance record arrays (stable identities — the WG data-keyed cache) ──
  const sysRecords = new Float32Array(world.systems.length * RECORD_FLOATS)
  const bgRecords = new Float32Array(BG_STARS * RECORD_FLOATS)
  const shipRecords = new Float32Array(MAX_SHIPS * RECORD_FLOATS)
  const planetRecords = new Float32Array(MAX_PLANETS * RECORD_FLOATS)
  const pringRecords = new Float32Array(MAX_PRINGS * RECORD_FLOATS)
  const ringRecords = new Float32Array(MAX_RINGS * RECORD_FLOATS)
  const bhRecords = new Float32Array(MAX_BHS * RECORD_FLOATS)

  // ── the nebulas (baked placement, four texture variants) ──
  // THE BEAUTY PASS: ten painterly washes — teal, dusty violet, ember and
  // crimson drift below the plane, brighter and bolder (the bloom chain
  // carries their hot tips into glow)
  const NEBS = [
    { ang: 0.55, dist: 1080, z: -430, size: 1500, rot: 1.2, spin: 0.010, alpha: 0.42, tex: 0 },
    { ang: 2.45, dist: 720, z: -270, size: 1150, rot: 2.8, spin: -0.008, alpha: 0.38, tex: 1 },
    { ang: 4.35, dist: 950, z: -560, size: 1680, rot: 0.4, spin: 0.007, alpha: 0.34, tex: 2 },
    { ang: 5.55, dist: 1550, z: -720, size: 1950, rot: 4.0, spin: -0.005, alpha: 0.32, tex: 3 },
    { ang: 1.45, dist: 1350, z: -980, size: 2300, rot: 2.1, spin: 0.004, alpha: 0.26, tex: 1 },
    { ang: 3.55, dist: 1180, z: -820, size: 1750, rot: 5.2, spin: -0.006, alpha: 0.28, tex: 0 },
    { ang: 0.15, dist: 800, z: -600, size: 1350, rot: 0.9, spin: 0.006, alpha: 0.24, tex: 3 },
    { ang: 2.05, dist: 1420, z: -880, size: 2100, rot: 3.3, spin: -0.007, alpha: 0.23, tex: 2 },
    { ang: 5.05, dist: 640, z: -320, size: 1050, rot: 1.7, spin: 0.009, alpha: 0.22, tex: 0 },
    { ang: 3.85, dist: 1690, z: -1040, size: 2400, rot: 0.8, spin: 0.005, alpha: 0.20, tex: 1 },
  ]
  const nebRecords = [0, 1, 2, 3].map(() => new Float32Array(3 * RECORD_FLOATS))
  const nebCounts = [0, 0, 0, 0]

  // ── the soups ──
  // THE LANE SOUP GROWS: the new 36-byte layout adds the along-lane
  // parameter t (the flow-pulse coordinate); the lanes are BAKED AS
  // QUADRATIC BÉZIERS (LANE_SEGS subdivisions, a seeded perpendicular sag)
  const laneSoup = new Float32Array(world.lanes.length * LANE_SEGS * 6 * SOUP_FLOATS)
  const orbitSoup = new Float32Array(MAX_ORBIT_RINGS * ORBIT_SEGMENTS * 6 * SOUP_FLOATS)
  const hazeSoup = new Float32Array(6 * 4)   // pos vec2 + uv vec2
  const terrSoup = new Float32Array(6 * 4)   // the territory quad (the haze layout)
  const skySoup = new Float32Array(6 * 2)    // the unit quad
  let orbitVerts = 0
  let laneVerts = 0

  // ── the textures (procedural, seeded by the world) ──
  const tex = makeTextures(world.seed)
  const atlasData = new Uint8Array(ATLAS_W * ATLAS_H * 4)

  /** Stretch-blit a procedural tile into the atlas grid. */
  function blitTile(tileIndex, src) {
    const tx = (tileIndex % 4) * TILE_W
    const ty = Math.floor(tileIndex / 4) * TILE_H
    for (let y = 0; y < TILE_H; y++) {
      const sy = Math.min(src.height - 1, Math.floor((y / TILE_H) * src.height))
      for (let x = 0; x < TILE_W; x++) {
        const sx = Math.min(src.width - 1, Math.floor((x / TILE_W) * src.width))
        const at = (ty + y) * ATLAS_W + tx + x
        const sat = (sy * src.width + sx) * 4
        atlasData[at * 4] = src.data[sat]
        atlasData[at * 4 + 1] = src.data[sat + 1]
        atlasData[at * 4 + 2] = src.data[sat + 2]
        atlasData[at * 4 + 3] = src.data[sat + 3]
      }
    }
  }
  blitTile(TILE.rock, tex.rock)
  blitTile(TILE.gas, tex.gas)
  blitTile(TILE.ice, tex.ice)
  blitTile(TILE.lava, tex.lava)
  blitTile(TILE.garden, tex.garden)
  blitTile(TILE.sun, tex.sun)

  // the sky placeholder: a dark field with a sprinkle of micro stars (the
  // real panorama swaps in when fetched)
  const skyData = new Uint8Array(1024 * 512 * 4)
  {
    const rngSky = mulberry(world.seed ^ 0x5d2b)
    for (let i = 0; i < 900; i++) {
      const at = ((rngSky() * 512) | 0) * 1024 + ((rngSky() * 1024) | 0)
      const v = 30 + (rngSky() * 90) | 0
      skyData[at * 4] = v
      skyData[at * 4 + 1] = v
      skyData[at * 4 + 2] = Math.min(255, v + 20)
      skyData[at * 4 + 3] = 255
    }
  }

  const atlasTex = renderer.texture(ATLAS_W, ATLAS_H)
  atlasTex.upload(atlasData)
  const starTex = renderer.texture(tex.star.width, tex.star.height)
  starTex.upload(tex.star.data)
  const hazeTex = renderer.texture(tex.haze.width, tex.haze.height)
  hazeTex.upload(tex.haze.data)
  const skyTex = renderer.texture(1024, 512)
  skyTex.upload(skyData)
  const nebTexs = [tex.nebula0, tex.nebula1, tex.nebula2, tex.nebula3].map(t => {
    const h = renderer.texture(t.width, t.height)
    h.upload(t.data)
    return h
  })
  const ringTexHandle = renderer.texture(tex.ring.width, tex.ring.height)
  ringTexHandle.upload(tex.ring.data)

  // the territory field texture (starts empty — the first bake fills it)
  const territoryTex = renderer.texture(TERR_SIZE, TERR_SIZE)
  territoryTex.upload(new Uint8Array(TERR_SIZE * TERR_SIZE * 4))

  // ── the per-backend dynamic buffer plumbing ──
  const glDyn = isGL
    ? {
      sys: gl.createBuffer(sysRecords, 'dynamic'),
      bg: gl.createBuffer(bgRecords),
      ships: gl.createBuffer(shipRecords, 'dynamic'),
      planets: gl.createBuffer(planetRecords, 'dynamic'),
      prings: gl.createBuffer(pringRecords, 'dynamic'),
      rings: gl.createBuffer(ringRecords, 'dynamic'),
      bhs: gl.createBuffer(bhRecords, 'dynamic'),
      nebs: [0, 1, 2, 3].map(i => gl.createBuffer(nebRecords[i])),
      lanes: null, // static — created after the bake
      orbits: gl.createBuffer(orbitSoup, 'dynamic'),
      haze: gl.createBuffer(hazeSoup),
      terr: gl.createBuffer(terrSoup),
      sky: gl.createBuffer(skySoup),
    }
    : null

  // ── the baked content ──

  // the background star field: two depth layers in one buffer
  {
    const rngB = mulberry(0x5eed ^ world.seed)
    for (let i = 0; i < BG_STARS; i++) {
      const at = i * RECORD_FLOATS
      const a = rngB() * Math.PI * 2
      const bright = i < BG_STARS_BRIGHT
      const r = bright ? 2600 + rngB() * 2600 : 1900 + rngB() * 3700
      const z = bright ? -250 - rngB() * 700 : -150 - rngB() * 1100
      bgRecords[at + F.pos] = Math.cos(a) * r
      bgRecords[at + F.pos + 1] = Math.sin(a) * r
      bgRecords[at + F.pos + 2] = z
      bgRecords[at + F.meta] = bright ? 26 + rngB() * 38 : 7 + rngB() * 11
      bgRecords[at + F.meta + 1] = rngB()
      const warm = rngB()
      const lum = bright ? 0.35 + rngB() * 0.55 : 0.14 + rngB() * 0.3
      bgRecords[at + F.color] = lum * (0.8 + warm * 0.3)
      bgRecords[at + F.color + 1] = lum * (0.85 + warm * 0.1)
      bgRecords[at + F.color + 2] = lum * (1.15 - warm * 0.25)
      bgRecords[at + F.color + 3] = bright ? 0.5 + rngB() * 0.5 : 0.3 + rngB() * 0.35
    }
  }

  // the nebulas
  for (const neb of NEBS) {
    const arr = nebRecords[neb.tex]
    const n = nebCounts[neb.tex]
    if (n >= 3) continue
    const at = n * RECORD_FLOATS
    arr[at + F.pos] = Math.cos(neb.ang) * neb.dist
    arr[at + F.pos + 1] = Math.sin(neb.ang) * neb.dist
    arr[at + F.pos + 2] = neb.z
    arr[at + F.meta] = neb.size
    arr[at + F.meta + 1] = neb.rot
    arr[at + F.color] = 1
    arr[at + F.color + 1] = 1
    arr[at + F.color + 2] = 1
    arr[at + F.color + 3] = neb.alpha
    arr[at + F.state] = neb.spin
    nebCounts[neb.tex] = n + 1
  }

  // the lane soup (centerline + unit perpendicular + the along-lane t —
  // the shader expands and pulses). THE BEAUTY PASS: every hyperlane is a
  // QUADRATIC BÉZIER with a seeded perpendicular sag — the arc reads organic
  // (the Stellaris hyperlane sweep), never a ruler-straight graph edge.
  // the Stellaris read: hyperlanes are TEAL threads with a traveling pulse
  {
    const rngL = mulberry(0x1ace ^ world.seed)
    for (const lane of world.lanes) {
      const A = world.systems[lane.a]
      const B = world.systems[lane.b]
      const dx = B.x - A.x
      const dy = B.y - A.y
      const len = Math.hypot(dx, dy) || 1
      const nx = -dy / len
      const ny = dx / len
      // the control point: the midpoint pushed perpendicular by 6–12% of
      // the length (the sign seeded per lane — the arcs never all bow one way)
      const sag = (0.06 + rngL() * 0.06) * len * (rngL() < 0.5 ? -1 : 1)
      const cx = (A.x + B.x) / 2 + nx * sag
      const cy = (A.y + B.y) / 2 + ny * sag
      const alpha = 0.36
      const cr = 0.42 * alpha
      const cg = 0.88 * alpha
      const cb = 0.80 * alpha
      for (let s = 0; s < LANE_SEGS; s++) {
        const q0 = s / LANE_SEGS
        const q1 = (s + 1) / LANE_SEGS
        // the bezier point + tangent at each end of the segment
        const bez = (q, out) => {
          const u = 1 - q
          out[0] = u * u * A.x + 2 * u * q * cx + q * q * B.x
          out[1] = u * u * A.y + 2 * u * q * cy + q * q * B.y
          // the tangent (derivative), normalized → the segment perpendicular
          let tx = 2 * u * (cx - A.x) + 2 * q * (B.x - cx)
          let ty = 2 * u * (cy - A.y) + 2 * q * (B.y - cy)
          const tl = Math.hypot(tx, ty) || 1
          out[2] = -ty / tl
          out[3] = tx / tl
        }
        const e0 = [0, 0, 0, 0]
        const e1 = [0, 0, 0, 0]
        bez(q0, e0)
        bez(q1, e1)
        // two triangles: (e0-, e1-, e1+) and (e0-, e1+, e0+), the dir
        // carrying the edge side; t = the CURVE parameter (the pulse)
        const put = (e, side, t) => {
          const v = laneVerts * SOUP_FLOATS
          laneSoup[v] = e[0]
          laneSoup[v + 1] = e[1]
          laneSoup[v + 2] = e[2] * side
          laneSoup[v + 3] = e[3] * side
          laneSoup[v + 4] = cr
          laneSoup[v + 5] = cg
          laneSoup[v + 6] = cb
          laneSoup[v + 7] = alpha
          laneSoup[v + 8] = t
          laneVerts++
        }
        put(e0, -1, q0)
        put(e1, -1, q1)
        put(e1, 1, q1)
        put(e0, -1, q0)
        put(e1, 1, q1)
        put(e0, 1, q0)
      }
    }
    if (isGL) glDyn.lanes = gl.createBuffer(laneSoup)
  }

  // the galaxy haze quad: spans the spiral, v flipped so world +y is up
  {
    const S = GALAXY_RADIUS * 2.15
    const half = S / 2
    let hv = 0
    const put = (x, y) => {
      const v = hv * 4
      hazeSoup[v] = x
      hazeSoup[v + 1] = y
      hazeSoup[v + 2] = (x + half) / S
      hazeSoup[v + 3] = (half - y) / S
      hv++
    }
    put(-half, -half); put(half, -half); put(half, half)
    put(-half, -half); put(half, half); put(-half, half)
  }

  // the territory quad: the same layout, spanning TERR_SPAN
  {
    const half = TERR_SPAN / 2
    let tv = 0
    const put = (x, y) => {
      const v = tv * 4
      terrSoup[v] = x
      terrSoup[v + 1] = y
      terrSoup[v + 2] = (x + half) / TERR_SPAN
      terrSoup[v + 3] = (half - y) / TERR_SPAN
      tv++
    }
    put(-half, -half); put(half, -half); put(half, half)
    put(-half, -half); put(half, half); put(-half, half)
  }

  // the sky unit quad
  {
    let sv = 0
    const put = (x, y) => {
      const v = sv * 2
      skySoup[v] = x
      skySoup[v + 1] = y
      sv++
    }
    put(-1, -1); put(1, -1); put(1, 1)
    put(-1, -1); put(1, 1); put(-1, 1)
  }

  // ── the commands ──
  const instanceAttrs = (records, dyn) => ({
    a_pos: { data: records, size: 3, stride: 64, offset: 0, step: 'instance', ...(isGL ? { bufferId: dyn } : {}) },
    a_meta: { data: records, size: 2, stride: 64, offset: 16, step: 'instance', ...(isGL ? { bufferId: dyn } : {}) },
    a_color: { data: records, size: 4, stride: 64, offset: 32, step: 'instance', ...(isGL ? { bufferId: dyn } : {}) },
    a_state: { data: records, size: 4, stride: 64, offset: 48, step: 'instance', ...(isGL ? { bufferId: dyn } : {}) },
  })

  const cmdSky = renderer.command({
    shader: { glsl: skyShader.glsl, wgsl: skyShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one' } },
    attributes: {
      a_pos: { data: skySoup, size: 2, stride: 8, offset: 0, ...(isGL ? { bufferId: glDyn.sky } : {}) },
    },
    uniforms: {
      u_mvp: () => MVP,
      u_center: () => SKY_CENTER,
      u_right: () => RIGHT,
      u_up: () => UP,
      u_half: () => SKY_HALF,
      u_u0: () => SKY_U0,
      u_win: () => SKY_WIN,
      u_gain: () => SKY_GAIN,
    },
    textures: { u_tex: skyTex, texTexture: skyTex },
    count: 6,
  })

  const cmdBgStars = renderer.command({
    shader: { glsl: bgStarShader.glsl, wgsl: bgStarShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one' } },
    attributes: instanceAttrs(bgRecords, glDyn?.bg),
    uniforms: {
      u_mvp: () => MVP,
      u_view: () => VIEW,
      u_right: () => RIGHT,
      u_up: () => UP,
      u_pxk: () => PXK,
      u_time: () => CLOCK,
    },
    textures: { u_tex: starTex, texTexture: starTex },
    count: 6,
    instances: (p) => p.count,
  })

  const cmdNebs = [0, 1, 2, 3].map(i => renderer.command({
    shader: { glsl: nebulaShader.glsl, wgsl: nebulaShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one' } },
    attributes: instanceAttrs(nebRecords[i], glDyn?.nebs[i]),
    uniforms: {
      u_mvp: () => MVP,
      u_right: () => RIGHT,
      u_up: () => UP,
      u_time: () => CLOCK,
      u_fade: () => NEB_FADE,
    },
    textures: { u_tex: nebTexs[i], texTexture: nebTexs[i] },
    count: 6,
    instances: (p) => p.count,
  }))

  const cmdHaze = renderer.command({
    shader: { glsl: hazeShader.glsl, wgsl: hazeShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one' } },
    attributes: {
      a_pos: { data: hazeSoup, size: 2, stride: 16, offset: 0, ...(isGL ? { bufferId: glDyn.haze } : {}) },
      a_uv: { data: hazeSoup, size: 2, stride: 16, offset: 8, ...(isGL ? { bufferId: glDyn.haze } : {}) },
    },
    uniforms: {
      u_mvp: () => MVP,
      u_fade: () => GALAXY_FADE,
      u_gain: () => HAZE_GAIN,
    },
    textures: { u_tex: hazeTex, texTexture: hazeTex },
    count: 6,
  })

  // THE STELLARIS BORDER: the empire territory field — drawn above the haze,
  // under the lanes (the fill tints the ground, the contour sheen and the
  // contested frontier glow ride the same quad)
  const cmdTerritory = renderer.command({
    shader: { glsl: territoryShader.glsl, wgsl: territoryShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: {
      a_pos: { data: terrSoup, size: 2, stride: 16, offset: 0, ...(isGL ? { bufferId: glDyn.terr } : {}) },
      a_uv: { data: terrSoup, size: 2, stride: 16, offset: 8, ...(isGL ? { bufferId: glDyn.terr } : {}) },
    },
    uniforms: {
      u_mvp: () => MVP,
      u_fade: () => GALAXY_FADE,
    },
    textures: { u_tex: territoryTex, texTexture: territoryTex },
    count: 6,
  })

  const cmdLanes = renderer.command({
    shader: { glsl: laneShader.glsl, wgsl: laneShader.wgsl },
    pipeline: { depth: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: {
      a_pos: { data: laneSoup, size: 2, stride: 36, offset: 0, ...(isGL ? { bufferId: glDyn.lanes } : {}) },
      a_dir: { data: laneSoup, size: 2, stride: 36, offset: 8, ...(isGL ? { bufferId: glDyn.lanes } : {}) },
      a_color: { data: laneSoup, size: 4, stride: 36, offset: 16, ...(isGL ? { bufferId: glDyn.lanes } : {}) },
      a_t: { data: laneSoup, size: 1, stride: 36, offset: 32, ...(isGL ? { bufferId: glDyn.lanes } : {}) },
    },
    uniforms: {
      u_view: () => VIEW,
      u_proj: () => PROJ,
      u_linek: () => LINEK,
      u_width: [1.15],
      u_fade: () => GALAXY_FADE,
      u_time: () => CLOCK,
      u_pulse: [0.28],
    },
    count: (p) => p.count,
  })

  const cmdOrbits = renderer.command({
    shader: { glsl: laneShader.glsl, wgsl: laneShader.wgsl },
    pipeline: { depth: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: {
      a_pos: { data: orbitSoup, size: 2, stride: 36, offset: 0, ...(isGL ? { bufferId: glDyn.orbits } : {}) },
      a_dir: { data: orbitSoup, size: 2, stride: 36, offset: 8, ...(isGL ? { bufferId: glDyn.orbits } : {}) },
      a_color: { data: orbitSoup, size: 4, stride: 36, offset: 16, ...(isGL ? { bufferId: glDyn.orbits } : {}) },
      a_t: { data: orbitSoup, size: 1, stride: 36, offset: 32, ...(isGL ? { bufferId: glDyn.orbits } : {}) },
    },
    uniforms: {
      u_view: () => VIEW,
      u_proj: () => PROJ,
      u_linek: () => LINEK,
      u_width: [2.2],
      u_fade: () => FADE,
      u_time: () => CLOCK,
      u_pulse: [0.06],
    },
    count: (p) => p.count,
  })

  const pringAttrs = instanceAttrs(pringRecords, glDyn?.prings)
  const cmdPRingsFar = renderer.command({
    shader: { glsl: pringShader.glsl, wgsl: pringShader.wgsl },
    pipeline: { depth: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: pringAttrs,
    uniforms: {
      u_mvp: () => MVP,
      u_time: () => CLOCK,
      u_split: () => SPLIT,
      u_half: [1],
      u_fade: () => FADE,
    },
    textures: { u_tex: ringTexHandle, texTexture: ringTexHandle },
    count: 6,
    instances: (p) => p.count,
  })
  const cmdPRingsNear = renderer.command({
    shader: { glsl: pringShader.glsl, wgsl: pringShader.wgsl },
    pipeline: { depth: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: pringAttrs,
    uniforms: {
      u_mvp: () => MVP,
      u_time: () => CLOCK,
      u_split: () => SPLIT,
      u_half: [0],
      u_fade: () => FADE,
    },
    textures: { u_tex: ringTexHandle, texTexture: ringTexHandle },
    count: 6,
    instances: (p) => p.count,
  })

  const cmdPlanets = renderer.command({
    shader: { glsl: planetShader.glsl, wgsl: planetShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: instanceAttrs(planetRecords, glDyn?.planets),
    uniforms: {
      u_mvp: () => MVP,
      u_view: () => VIEW,
      u_right: () => RIGHT,
      u_up: () => UP,
      u_pxk: () => PXK,
      u_time: () => CLOCK,
      u_fade: () => FADE,
    },
    textures: { u_tex: atlasTex, texTexture: atlasTex },
    count: 6,
    instances: (p) => p.count,
  })

  const cmdStars = renderer.command({
    shader: { glsl: starShader.glsl, wgsl: starShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one' } },
    attributes: instanceAttrs(sysRecords, glDyn?.sys),
    uniforms: {
      u_mvp: () => MVP,
      u_view: () => VIEW,
      u_right: () => RIGHT,
      u_up: () => UP,
      u_pxk: () => PXK,
      u_time: () => CLOCK,
      u_fade: () => GALAXY_FADE,
    },
    textures: { u_tex: starTex, texTexture: starTex },
    count: 6,
    instances: (p) => p.count,
  })

  const cmdShips = renderer.command({
    shader: { glsl: shipShader.glsl, wgsl: shipShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: instanceAttrs(shipRecords, glDyn?.ships),
    uniforms: {
      u_mvp: () => MVP,
      u_view: () => VIEW,
      u_right: () => RIGHT,
      u_up: () => UP,
      u_pxk: () => PXK,
      u_time: () => CLOCK,
      u_yaw: () => YAW,
      u_cap: () => SHIP_CAP,
    },
    count: 6,
    instances: (p) => p.count,
  })

  // the black holes: an ALPHA-blend pass (the horizon must occlude, not add)
  const cmdBlackholes = renderer.command({
    shader: { glsl: blackholeShader.glsl, wgsl: blackholeShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one-minus-src-alpha' } },
    attributes: instanceAttrs(bhRecords, glDyn?.bhs),
    uniforms: {
      u_mvp: () => MVP,
      u_view: () => VIEW,
      u_right: () => RIGHT,
      u_up: () => UP,
      u_pxk: () => PXK,
      u_time: () => CLOCK,
      u_fade: () => GALAXY_FADE,
    },
    count: 6,
    instances: (p) => p.count,
  })

  const cmdRings = renderer.command({
    shader: { glsl: ringShader.glsl, wgsl: ringShader.wgsl },
    pipeline: { depth: false, blend: { src: 'one', dst: 'one' } },
    attributes: instanceAttrs(ringRecords, glDyn?.rings),
    uniforms: {
      u_mvp: () => MVP,
      u_view: () => VIEW,
      u_right: () => RIGHT,
      u_up: () => UP,
      u_pxk: () => PXK,
      u_time: () => CLOCK,
    },
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
      sysRecords[at + F.pos] = sys.x
      sysRecords[at + F.pos + 1] = sys.y
      sysRecords[at + F.pos + 2] = 0
      sysRecords[at + F.meta] = sys.cls.size * 0.34
      // the class rides the phase float: phase + type*4 (0 star, 1 black
      // hole, 2 neutron) — the shader splits it back apart
      const type = sys.cls.key === 'BH' ? 1 : sys.cls.key === 'N' ? 2 : 0
      sysRecords[at + F.meta + 1] = (sys.id * 0.618) % 1 + type * 4
      const c = sys.cls.color
      sysRecords[at + F.color] = c[0]
      sysRecords[at + F.color + 1] = c[1]
      sysRecords[at + F.color + 2] = c[2]
      // THE HIERARCHY (the VLM read: "when everything glows with equal
      // intensity, nothing feels important"): the brightness rides the
      // class size — an O giant blazes (spikes + bloom), an M dwarf is a
      // quiet point; planets and ownership add weight. The bloom threshold
      // does the rest: dim stars never bloom, capitals do
      const sizeW = 0.16 + Math.min(1, sys.cls.size / 15) * 0.84
      sysRecords[at + F.color + 3] = sizeW * (sys.planets.length > 0 ? 1.0 : 0.6)
      sysRecords[at + F.state] = sys.owner
      sysRecords[at + F.state + 1] = sys.id === selectedSystem ? 1 : 0
      sysRecords[at + F.state + 2] = sys.colonizing !== null ? sys.colonizing.progress : 0
      // a black hole draws through its OWN pass (an opaque horizon needs the
      // alpha blend) — the additive star sprite hides
      sysRecords[at + F.state + 3] = type === 1 ? 0 : 1
    }
    starsDirty = true
  }

  /** The black-hole landmark records (the same fields as stars, minus color). */
  function updateBlackholeRecords() {
    let n = 0
    for (const sys of world.systems) {
      if (sys.cls.key !== 'BH' || n >= MAX_BHS) continue
      const at = n * RECORD_FLOATS
      bhRecords[at + F.pos] = sys.x
      bhRecords[at + F.pos + 1] = sys.y
      bhRecords[at + F.pos + 2] = 0
      bhRecords[at + F.meta] = sys.cls.size * 0.34
      bhRecords[at + F.meta + 1] = (sys.id * 0.618) % 1
      bhRecords[at + F.state] = sys.owner
      bhRecords[at + F.state + 1] = sys.id === selectedSystem ? 1 : 0
      bhRecords[at + F.state + 2] = sys.colonizing !== null ? sys.colonizing.progress : 0
      bhRecords[at + F.state + 3] = 1
      n++
    }
    return n
  }

  // the last-seen positions (a PATROLLING ship also deserves its plume —
  // the record's "moving" flag is velocity, not the state machine)
  const lastPos = new Map()
  function writeShipRecord(at, ship) {
    const c = ship.kind === 'colony' ? [0.55, 0.95, 0.75] : [0.85, 0.75, 0.45]
    shipRecords[at + F.pos] = ship.x
    shipRecords[at + F.pos + 1] = ship.y
    shipRecords[at + F.pos + 2] = 0
    shipRecords[at + F.meta] = ship.angle
    shipRecords[at + F.meta + 1] = ship.kind === 'colony' ? 1.1 : 1.5
    shipRecords[at + F.color] = c[0]
    shipRecords[at + F.color + 1] = c[1]
    shipRecords[at + F.color + 2] = c[2]
    shipRecords[at + F.color + 3] = 1
    const prev = lastPos.get(ship.id)
    const drifting = prev !== undefined && Math.hypot(ship.x - prev[0], ship.y - prev[1]) > 1e-4
    lastPos.set(ship.id, [ship.x, ship.y])
    const moving = ship.state === 'move' ? 1 : (ship.state === 'colonize' ? 2 : (drifting ? 1 : 0))
    shipRecords[at + F.state] = ship.kind === 'war' ? 1 : 0
    shipRecords[at + F.state + 1] = moving
    shipRecords[at + F.state + 2] = ship.id === selectedShip ? 1 : 0
    shipRecords[at + F.state + 3] = (ship.id * 0.37) % 1
  }

  function updateShipRecords(view) {
    let n = 0
    const near = view.mode === 'system' && view.system !== null ? view.system : null
    for (const ship of world.ships) {
      if (n >= MAX_SHIPS) break
      if (near !== null && Math.hypot(ship.x - near.x, ship.y - near.y) > 60) continue
      writeShipRecord(n * RECORD_FLOATS, ship)
      n++
    }
    return n
  }

  /** The system-view content: the sun + planets (+ ring records). */
  function setSystemView(sys) {
    planetRecords.fill(0)
    pringRecords.fill(0)
    let prings = 0
    if (sys === null) return { planets: 0, prings: 0 }
    // the sun (tile 5)
    const sunAt = 0
    const c = sys.cls.color
    planetRecords[sunAt + F.pos] = sys.x
    planetRecords[sunAt + F.pos + 1] = sys.y
    planetRecords[sunAt + F.meta] = (1.9 + sys.cls.size * 0.05) * 1.35
    planetRecords[sunAt + F.meta + 1] = 0
    planetRecords[sunAt + F.color] = c[0]
    planetRecords[sunAt + F.color + 1] = c[1]
    planetRecords[sunAt + F.color + 2] = c[2]
    planetRecords[sunAt + F.color + 3] = 0
    planetRecords[sunAt + F.state + 3] = TILE.sun
    let n = 1
    for (const planet of sys.planets) {
      if (n >= MAX_PLANETS) break
      const at = n * RECORD_FLOATS
      const pc = planet.type.color
      const settlement = planet.buildings.includes('colony')
      // the settlement planet is a garden world (the earth bitmap swaps in)
      const tile = settlement ? TILE.garden
        : planet.type.key === 'rock' ? TILE.rock
        : planet.type.key === 'gas' ? TILE.gas
        : planet.type.key === 'ice' ? TILE.ice
        : TILE.lava
      // half-strength tint: the texture carries the hue, the tint varies it per planet
      const jitter = 0.86 + ((planet.orbit * 7.3 + planet.phase) % 1) * 0.24
      const tint = settlement ? [0.98, 0.99, 1.0] : [pc[0] * 0.5 + 0.5, pc[1] * 0.5 + 0.5, pc[2] * 0.5 + 0.5]
      planetRecords[at + F.pos] = sys.x
      planetRecords[at + F.pos + 1] = sys.y
      // THE SCALE: bigger, textured discs (the VLM read: "billiard
      // balls" — at the old scale the procedural surface detail was
      // invisible; ~1.9× reads as WORLDS, and the atmosphere shell +
      // specular + city lights have room to show)
      const visScale = planet.size * 0.5 * 1.9
      planetRecords[at + F.meta] = visScale
      planetRecords[at + F.meta + 1] = planet.orbit
      planetRecords[at + F.color] = tint[0] * jitter
      planetRecords[at + F.color + 1] = tint[1] * jitter
      planetRecords[at + F.color + 2] = tint[2] * jitter
      planetRecords[at + F.color + 3] = (planet.phase * 0.9) % 1 // the spin phase
      planetRecords[at + F.state] = planet.phase
      planetRecords[at + F.state + 1] = planet.speed
      planetRecords[at + F.state + 2] = planet.queue !== null ? Math.min(1, planet.queue.progress / buildTime(BUILDINGS[planet.queue.building])) : 0
      planetRecords[at + F.state + 3] = tile
      // a ringed gas giant
      if (planet.type.key === 'gas' && planet.size >= 1.35 && prings < MAX_PRINGS) {
        const prAt = prings * RECORD_FLOATS
        const r = planet.size * 0.5 * 1.9
        pringRecords[prAt + F.pos] = sys.x
        pringRecords[prAt + F.pos + 1] = sys.y
        pringRecords[prAt + F.meta] = r * 1.45
        pringRecords[prAt + F.meta + 1] = r * 2.55
        pringRecords[prAt + F.color] = 0.9
        pringRecords[prAt + F.color + 1] = 0.85
        pringRecords[prAt + F.color + 2] = 0.75
        pringRecords[prAt + F.color + 3] = 0.8
        pringRecords[prAt + F.state] = planet.phase
        pringRecords[prAt + F.state + 1] = planet.speed
        pringRecords[prAt + F.state + 2] = planet.orbit
        prings++
      }
      n++
    }
    // the orbit ring soup (centerline + perpendicular — the lane format)
    orbitVerts = 0
    bakeOrbits(sys)
    return { planets: n, prings }
  }

  function bakeOrbits(sys) {
    // the Stellaris read: orbit rings are quiet TEAL threads (the lane
    // family) with a SLOW pulse crawling around them (u_pulse 0.06 — a
    // planet's system feels alive even when nothing moves)
    const alpha = 0.3
    const rgb = 0.5 * alpha
    const rgbG = 0.62 * alpha
    const rgbB = 0.60 * alpha
    const put = (x, y, dx, dy, t) => {
      const v = orbitVerts * SOUP_FLOATS
      orbitSoup[v] = x
      orbitSoup[v + 1] = y
      orbitSoup[v + 2] = dx
      orbitSoup[v + 3] = dy
      orbitSoup[v + 4] = rgb
      orbitSoup[v + 5] = rgbG
      orbitSoup[v + 6] = rgbB
      orbitSoup[v + 7] = alpha
      orbitSoup[v + 8] = t
      orbitVerts++
    }
    let rings = 0
    for (const planet of sys.planets) {
      if (rings >= MAX_ORBIT_RINGS) break
      const r = planet.orbit
      for (let s = 0; s < ORBIT_SEGMENTS; s++) {
        const a0 = (s / ORBIT_SEGMENTS) * Math.PI * 2
        const a1 = ((s + 1) / ORBIT_SEGMENTS) * Math.PI * 2
        const x0 = sys.x + Math.cos(a0) * r
        const y0 = sys.y + Math.sin(a0) * r
        const x1 = sys.x + Math.cos(a1) * r
        const y1 = sys.y + Math.sin(a1) * r
        // the segment's unit perpendicular (tangent rotated 90°)
        const tx = x1 - x0, ty = y1 - y0
        const tl = Math.hypot(tx, ty) || 1
        const nx = -ty / tl, ny = tx / tl
        put(x0, y0, -nx, -ny, s / ORBIT_SEGMENTS)
        put(x1, y1, -nx, -ny, (s + 1) / ORBIT_SEGMENTS)
        put(x1, y1, nx, ny, (s + 1) / ORBIT_SEGMENTS)
        put(x0, y0, -nx, -ny, s / ORBIT_SEGMENTS)
        put(x1, y1, nx, ny, (s + 1) / ORBIT_SEGMENTS)
        put(x0, y0, nx, ny, s / ORBIT_SEGMENTS)
      }
      rings++
    }
  }

  // the selection ring / effect records
  function updateRingRecords(view) {
    let n = 0
    // the selected planet ring (system view) — the Stellaris teal
    if (view.mode === 'system' && view.selectedPlanet >= 0 && view.system !== null) {
      const planet = view.system.planets[view.selectedPlanet]
      if (planet !== undefined) {
        const ang = planet.phase + CLOCK[0] * planet.speed
        const px = view.system.x + Math.cos(ang) * planet.orbit
        const py = view.system.y + Math.sin(ang) * planet.orbit
        n = writeRing(n, px, py, planet.size * 0.5 * 1.9 * 1.9, [0.45, 1.0, 0.88, 1], 0, 0, 1, CLOCK[0])
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
        n = writeRing(n, dest.x, dest.y, 5, [0.45, 1.0, 0.88, 1], 0, 3, 1, CLOCK[0] * 0.8)
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
  function uploadFull(records, name) {
    if (isGL) gl.updateBuffer(glDyn[name], records)
    else gpu.syncVertexBuffer(records, records.length * 4)
  }

  // ── the empire territory bake (the Stellaris border field) ──
  // 256² texels × the owned systems (a few dozen at endgame) — a couple of
  // ms of Math.exp on a phone, and ONLY when a claim flips an owner. The
  // fingerprint is the owned-count pair; positions are static, so the field
  // changes iff a count changes.
  const territoryData = new Uint8Array(TERR_SIZE * TERR_SIZE * 4)
  let territoryFp = -1
  function ownershipFingerprint() {
    let p = 0
    let r = 0
    for (const sys of world.systems) {
      if (sys.owner === OWNER.PLAYER) p++
      else if (sys.owner === OWNER.RIVAL) r++
    }
    return p * 1000 + r
  }
  function bakeTerritory() {
    territoryFp = ownershipFingerprint()
    territoryData.fill(0)
    const cells = []
    for (const sys of world.systems) {
      if (sys.owner === OWNER.NONE) continue
      // the bubble radius: ~55% of the shortest lane (borders meet halfway
      // to the neighbor — the Stellaris convention)
      let minLane = Infinity
      for (const other of sys.lanes) {
        const o = world.systems[other]
        minLane = Math.min(minLane, Math.hypot(o.x - sys.x, o.y - sys.y))
      }
      const base = Math.min(150, Math.max(72, minLane * 0.55))
      cells.push({ x: sys.x, y: sys.y, base, owner: sys.owner, phi: sys.id * 1.7 })
    }
    if (cells.length > 0) {
      const half = TERR_SPAN / 2
      const k = TERR_SPAN / TERR_SIZE
      for (let py = 0; py < TERR_SIZE; py++) {
        const wy = half - (py + 0.5) * k
        for (let px = 0; px < TERR_SIZE; px++) {
          const wx = -half + (px + 0.5) * k
          let wp = 0
          let wr = 0
          for (const c of cells) {
            const dx = wx - c.x
            const dy = wy - c.y
            const d2 = dx * dx + dy * dy
            const cut = c.base * 3
            if (d2 > cut * cut) continue
            // the organic wobble: 3-lobed + 5-lobed angular noise per
            // system — Voronoi-ish blobs, never circles
            const th = Math.atan2(dy, dx)
            const rEff = c.base * (1 + 0.12 * Math.sin(3 * th + c.phi) + 0.07 * Math.sin(5 * th + c.phi * 2.3))
            const w = Math.exp(-d2 / (rEff * rEff))
            if (c.owner === OWNER.PLAYER) wp += w
            else wr += w
          }
          const at = (py * TERR_SIZE + px) * 4
          territoryData[at] = Math.min(255, wp * 255)
          territoryData[at + 1] = Math.min(255, wr * 255)
        }
      }
    }
    territoryTex.upload(territoryData)
  }

  // ── the frame draw (called from the renderer's frame callback) ──
  let planetCount = 0
  let pringCount = 0
  let sysViewId = -2
  let lanesUploaded = false
  let staticUploaded = false

  function draw(record, view) {
    // the star records refresh (ownership/selection/colonize progress)
    updateStarRecords()
    const sysChanged = view.mode === 'system' && view.system !== null && sysViewId !== view.system.id
    if (sysChanged || view.mode !== 'system') {
      if (view.mode === 'system' && view.system !== null) {
        const r = setSystemView(view.system)
        planetCount = r.planets
        pringCount = r.prings
        sysViewId = view.system.id
      } else {
        sysViewId = -2
        planetCount = 0
        pringCount = 0
        // the orbit rings die with the crossfade (they are invisible past
        // blend < 0.4 anyway — this frees the draws entirely)
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
      if (isGL) {
        gl.updateBuffer(glDyn.planets, planetRecords.subarray(0, planetCount * RECORD_FLOATS))
        gl.updateBuffer(glDyn.prings, pringRecords.subarray(0, pringCount * RECORD_FLOATS))
      } else {
        gpu.syncVertexBuffer(planetRecords, planetCount * RECORD_FLOATS * 4)
        gpu.syncVertexBuffer(pringRecords, pringCount * RECORD_FLOATS * 4)
      }
    }

    // the territory rebake: only when a claim flipped an owner
    if (ownershipFingerprint() !== territoryFp) bakeTerritory()

    // the live prefixes + the once-only static uploads
    upload(sysRecords, world.systems.length * RECORD_FLOATS, 'sys')
    const shipCount = updateShipRecords(view)
    upload(shipRecords, shipCount * RECORD_FLOATS, 'ships')
    const bhCount = updateBlackholeRecords()
    upload(bhRecords, bhCount * RECORD_FLOATS, 'bhs')
    const ringCount = updateRingRecords(view)
    upload(ringRecords, ringCount * RECORD_FLOATS, 'rings')

    if (!staticUploaded) {
      if (isGL) {
        gl.updateBuffer(glDyn.bg, bgRecords)
        for (let i = 0; i < 4; i++) gl.updateBuffer(glDyn.nebs[i], nebRecords[i].subarray(0, nebCounts[i] * RECORD_FLOATS))
        gl.updateBuffer(glDyn.haze, hazeSoup)
        gl.updateBuffer(glDyn.terr, terrSoup)
        gl.updateBuffer(glDyn.sky, skySoup)
      } else {
        gpu.syncVertexBuffer(bgRecords, bgRecords.length * 4)
        for (let i = 0; i < 4; i++) gpu.syncVertexBuffer(nebRecords[i], nebCounts[i] * RECORD_FLOATS * 4)
        gpu.syncVertexBuffer(hazeSoup, hazeSoup.length * 4)
        gpu.syncVertexBuffer(terrSoup, terrSoup.length * 4)
        gpu.syncVertexBuffer(skySoup, skySoup.length * 4)
      }
      staticUploaded = true
    }
    if (isGL) {
      if (!lanesUploaded) { gl.updateBuffer(glDyn.lanes, laneSoup); lanesUploaded = true }
      if (sysChanged && view.mode === 'system') gl.updateBuffer(glDyn.orbits, orbitSoup.subarray(0, orbitVerts * SOUP_FLOATS))
    } else {
      if (!lanesUploaded) { gpu.syncVertexBuffer(laneSoup, laneSoup.length * 4); lanesUploaded = true }
      if (sysChanged && view.mode === 'system') gpu.syncVertexBuffer(orbitSoup, orbitVerts * SOUP_FLOATS * 4)
    }

    // the draw list (the tape order = the painter's order; the fades cross the
    // view blend). THE POST PASS: every command is captured INTO THE SCENE
    // SURFACE (the first one clears it), then the post chain runs — the
    // composite lands on the canvas (see post.js for the tape plumbing)
    const [bufW, bufH] = bufferSize()
    post.ensure(bufW, bufH)
    record(post.capture(cmdSky, true), {})
    record(post.capture(cmdBgStars, false), { count: BG_STARS })
    for (let i = 0; i < 4; i++) {
      if (nebCounts[i] > 0) record(post.capture(cmdNebs[i], false), { count: nebCounts[i] })
    }
    record(post.capture(cmdHaze, false), {})
    record(post.capture(cmdTerritory, false), {})
    record(post.capture(cmdLanes, false), { count: laneVerts })
    if (orbitVerts > 0) record(post.capture(cmdOrbits, false), { count: orbitVerts })
    if (pringCount > 0 && view.blend > 0.05) record(post.capture(cmdPRingsFar, false), { count: pringCount })
    if (planetCount > 0) record(post.capture(cmdPlanets, false), { count: planetCount })
    if (pringCount > 0 && view.blend > 0.05) record(post.capture(cmdPRingsNear, false), { count: pringCount })
    record(post.capture(cmdStars, false), { count: world.systems.length })
    if (bhCount > 0) record(post.capture(cmdBlackholes, false), { count: bhCount })
    if (shipCount > 0) record(post.capture(cmdShips, false), { count: shipCount })
    if (ringCount > 0) record(post.capture(cmdRings, false), { count: ringCount })
    post.recordPost(record)
  }

  // ── the REAL space assets: fetch + swap into the live handles ──
  swapRealTextures(shell).catch(() => { /* a failed fetch keeps the procedural set */ })

  async function swapRealTextures(sh) {
    const load = async (url, opts) => {
      if (bitmapCache.has(url)) return bitmapCache.get(url)
      try {
        const resp = await fetch(url)
        if (!resp.ok) return null
        const blob = await resp.blob()
        const bitmap = await createImageBitmap(blob, opts)
        bitmapCache.set(url, bitmap)
        return bitmap
      } catch {
        return null
      }
    }
    const [sky, moon, earth] = await Promise.all([
      load('./assets/milkyway_1024.jpg', { premultiplyAlpha: 'none' }),
      load('./assets/moon_512.jpg', { resizeWidth: TILE_W, resizeHeight: TILE_H, resizeQuality: 'high', premultiplyAlpha: 'none' }),
      load('./assets/earth_512.jpg', { resizeWidth: TILE_W, resizeHeight: TILE_H, resizeQuality: 'high', premultiplyAlpha: 'none' }),
    ])
    if (sky !== null) {
      skyTex.uploadImage(sky)
      sh?.log.event('sky: the ESO Milky Way panorama swapped in')
    }
    if (moon !== null) {
      atlasTex.uploadSubImage((TILE.rock % 4) * TILE_W, Math.floor(TILE.rock / 4) * TILE_H, moon)
      sh?.log.event('planets: the NASA moon surface swapped into the rocky tile')
    }
    if (earth !== null) {
      atlasTex.uploadSubImage((TILE.garden % 4) * TILE_W, Math.floor(TILE.garden / 4) * TILE_H, earth)
      sh?.log.event('planets: the NASA earth swapped into the settlement tile')
    }
  }

  // ── the view-facing API ──
  return {
    draw,
    get sysRecords() { return sysRecords },
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
      post.dispose()
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
