// "astral" demo — the procedural texture kitchen.
//
// Everything the renderer shows that is not a sprite quad baked in a shader
// comes from here: the arm-aligned spiral haze of the galaxy, the deep-space
// nebulas, the star/sun glow sprites, and the four equirect planet surfaces
// (plus a garden-world fallback for the settlement planet and the ring-band
// strip for the ringed gas giants).
//
// Why procedural at all when the demo also ships three REAL space bitmaps
// (assets/milkyway_1024.jpg — the ESO GigaGalaxy panorama via the three.js
// examples, assets/moon_512.jpg and assets/earth_512.jpg — NASA imagery via
// the three.js examples)? Two reasons, both mobile:
//   1. zero network on the critical path — the galaxy is playable the frame
//      the shaders compile; the real bitmaps swap into the SAME texture
//      handles when they arrive (a fetch that fails changes nothing);
//   2. determinism — the same ?seed= draws the same galaxy, haze included:
//      the spiral below traces the WORLD GENERATOR's own arm math (3 arms,
//      ARM_TWIST 2.35, radius 90..840), so the glow sits under the star
//      systems instead of being a generic stock spiral.
//
// Output shape: { width, height, data: Uint8Array(RGBA) } — straight
// (non-premultiplied) alpha, ready for renderer.texture(w, h).upload(data).

import { mulberry32, GALAXY_RADIUS } from './galaxy.js?v=1'

const TAU = Math.PI * 2

// ─── deterministic noise (value noise 3D + fbm) ─────────────────────────────

/** Integer hash → [0,1). Stable across runs, browsers and CPUs. */
function hash3(x, y, z, seed) {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)

/** Value noise over the unit cube, trilinear + quintic fade. */
function noise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const fx = x - ix, fy = y - iy, fz = z - iz
  const u = fade(fx), v = fade(fy), w = fade(fz)
  const n000 = hash3(ix, iy, iz, seed), n100 = hash3(ix + 1, iy, iz, seed)
  const n010 = hash3(ix, iy + 1, iz, seed), n110 = hash3(ix + 1, iy + 1, iz, seed)
  const n001 = hash3(ix, iy, iz + 1, seed), n101 = hash3(ix + 1, iy, iz + 1, seed)
  const n011 = hash3(ix, iy + 1, iz + 1, seed), n111 = hash3(ix + 1, iy + 1, iz + 1, seed)
  const x00 = n000 + (n100 - n000) * u
  const x10 = n010 + (n110 - n010) * u
  const x01 = n001 + (n101 - n001) * u
  const x11 = n011 + (n111 - n011) * u
  const y0 = x00 + (x10 - x00) * v
  const y1 = x01 + (x11 - x01) * v
  return y0 + (y1 - y0) * w
}

/** Fractal sum of value noise, [0,1]-ish normalized. */
function fbm3(x, y, z, octaves, seed) {
  let sum = 0
  let amp = 1
  let norm = 0
  let f = 1
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise3(x * f, y * f, z * f, seed + o * 1013)
    norm += amp
    amp *= 0.5
    f *= 2.07
  }
  return sum / norm
}

/** Unsigned angle difference in [0, π]. */
function angDist(a, b) {
  let d = (a - b) % TAU
  if (d < 0) d += TAU
  if (d > Math.PI) d = TAU - d
  return d
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

// ─── 1. the spiral haze (arm-aligned with the world generator) ───────────────

/**
 * The galaxy's glowing disc: 3 spiral arms traced with the world generator's
 * own arm equation (angle = armBase + t·ARM_TWIST·π at radius r), a warm
 * bulge, and fbm grain. Additive blend does the rest.
 */
export function makeGalaxyHaze(seed) {
  const S = 512
  const data = new Uint8Array(S * S * 4)
  const rng = mulberry32(seed ^ 0x9a7e)
  const noiseSeed = (rng() * 0x7fffffff) | 0
  const ARM_TWIST = 2.35 // must mirror galaxy.js
  const span = GALAXY_RADIUS * 2.15 // world units the quad covers
  const half = span / 2
  // two dust-lane darkening seeds for depth
  const dustA = 0.55 + rng() * 0.2
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const wx = ((px + 0.5) / S) * span - half
      const wy = half - ((py + 0.5) / S) * span // texture v flipped → world +y up
      const r = Math.hypot(wx, wy)
      const at = (py * S + px) * 4
      if (r > half) continue
      const theta = Math.atan2(wy, wx)
      const t = clamp01((r - 80) / (GALAXY_RADIUS - 80))
      // the arm the world generator would place at this radius
      let arm = 0
      for (let k = 0; k < 3; k++) {
        const armAngle = (k / 3) * TAU + t * Math.PI * ARM_TWIST
        const d = angDist(theta, armAngle)
        if (d < 0.75) {
          const g = Math.exp(-(d * d) / (2 * 0.16 * 0.16 * 9)) // ~0.16 rad sigma
          arm += g
        }
      }
      arm = Math.min(1, arm)
      const armFall = clamp01(1 - t * 0.85) * (1 - Math.exp(-((r - 70) * (r - 70)) / (2 * 60 * 60)))
      const bulge = Math.exp(-(r * r) / (2 * 150 * 150)) * 1.35
      const grain = 0.55 + 0.45 * fbm3(wx / 95, wy / 95, 0, 4, noiseSeed)
      const dust = clamp01(1 - dustA * fbm3(wx / 160, wy / 160, 7.7, 3, noiseSeed ^ 0x51))
      let density = (arm * armFall * grain * 0.9 + bulge * (0.75 + 0.25 * grain)) * dust
      density = clamp01(density)
      if (density <= 0.004) continue
      // warm core → cool arms
      const mixW = clamp01(bulge / 1.2)
      const cr = (0.62 + mixW * 0.33) * density
      const cg = (0.70 + mixW * 0.20) * density
      const cb = (0.95 - mixW * 0.10) * density
      data[at] = Math.round(cr * 255)
      data[at + 1] = Math.round(cg * 255)
      data[at + 2] = Math.round(cb * 255)
      data[at + 3] = 255
    }
  }
  return { width: S, height: S, data }
}

// ─── 2. the star glow sprite (core + halo + diffraction spikes) ──────────────

/** The sprite every star field quad samples: three.js' galaxy-sprite look. */
export function makeStarSprite() {
  const S = 128
  const data = new Uint8Array(S * S * 4)
  const c = S / 2 - 0.5
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const dx = (px - c) / c
      const dy = (py - c) / c
      const d = Math.hypot(dx, dy)
      const at = (py * S + px) * 4
      const core = Math.exp(-d * d * 16) * 1.35
      const halo = Math.exp(-d * d * 3.2) * 0.42
      // the 4-point diffraction spikes (horizontal + vertical streaks)
      const spikeH = Math.exp(-(dy * dy) * 340) * Math.exp(-(dx * dx) * 2.6) * 0.55
      const spikeV = Math.exp(-(dx * dx) * 340) * Math.exp(-(dy * dy) * 2.6) * 0.55
      const spikeD = Math.exp(-Math.pow(Math.abs(dx * dy), 1.1) * 60) * Math.exp(-d * d * 3.5) * 0.16
      const v = clamp01(core + halo + spikeH + spikeV + spikeD)
      data[at] = data[at + 1] = data[at + 2] = Math.round(v * 255)
      data[at + 3] = 255
    }
  }
  return { width: S, height: S, data }
}

// ─── 3. the sun sprite (core + turbulent corona rays) ────────────────────────

export function makeSunSprite(seed) {
  // 256×128 (the atlas tile's aspect): the quad-space math below keeps the
  // glow ROUND once the tile is squeezed onto the square sun quad
  const W = 256, H = 128
  const data = new Uint8Array(W * H * 4)
  const rng = mulberry32(seed ^ 0x51ea)
  const noiseSeed = (rng() * 0x7fffffff) | 0
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const qx = ((px + 0.5) / W) * 2 - 1
      const qy = ((py + 0.5) / H) * 2 - 1
      const d = Math.hypot(qx, qy)
      const theta = Math.atan2(qy, qx)
      const at = (py * W + px) * 4
      const core = Math.exp(-d * d * 18) * 1.7
      const corona = Math.exp(-d * d * 4.0) * 0.5
      // the flame corona: a smooth radial falloff, wavering with ONE
      // low-frequency angular noise octave — extra octaves alias into a
      // periodic dashed ring when the sprite is minified on screen
      const wob = noise3(Math.cos(theta) * 1.1, Math.sin(theta) * 1.1, 3.1, noiseSeed)
      const flame = Math.exp(-d * d * (1.9 + wob * 0.9)) * (0.35 + wob * 0.3)
      const v = clamp01(core + corona + flame)
      data[at] = data[at + 1] = data[at + 2] = Math.round(v * 255)
      data[at + 3] = 255
    }
  }
  return { width: W, height: H, data }
}

// ─── 4. the nebulas (fbm clouds over a color ramp) ───────────────────────────

/** A soft nebula puff. palettes: [deep, mid, hot] as rgb triples. */
export function makeNebula(seed, palette, power = 2.2, gain = 1) {
  const S = 192
  const data = new Uint8Array(S * S * 4)
  const rng = mulberry32(seed ^ 0x7eba)
  const noiseSeed = (rng() * 0x7fffffff) | 0
  const [deep, mid, hot] = palette
  const c = S / 2 - 0.5
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const dx = (px - c) / c
      const dy = (py - c) / c
      const d = Math.hypot(dx, dy)
      const at = (py * S + px) * 4
      const n = fbm3(dx * 2.1, dy * 2.1, 9.4, 5, noiseSeed)
      let dens = Math.pow(clamp01(n * 1.9 - 0.42), power) * gain
      dens *= Math.exp(-(d * d) * 1.7) // radial falloff to the sprite edge
      dens = clamp01(dens)
      if (dens <= 0.004) continue
      // ramp: deep → mid → hot by density
      const m1 = clamp01(dens * 2.4)
      const m2 = clamp01((dens - 0.42) * 2.2)
      const r = deep[0] + (mid[0] - deep[0]) * m1 + (hot[0] - mid[0]) * m2
      const g = deep[1] + (mid[1] - deep[1]) * m1 + (hot[1] - mid[1]) * m2
      const b = deep[2] + (mid[2] - deep[2]) * m1 + (hot[2] - mid[2]) * m2
      data[at] = Math.round(clamp01(r) * dens * 255)
      data[at + 1] = Math.round(clamp01(g) * dens * 255)
      data[at + 2] = Math.round(clamp01(b) * dens * 255)
      data[at + 3] = 255
    }
  }
  return { width: S, height: S, data }
}

// ─── 5. the planet surfaces (equirect, sampled on the sphere) ────────────────

/** Sample point on the unit sphere for equirect (u, v) — seamless wrap. */
function spherePoint(u, v, out) {
  const lon = (u - 0.5) * TAU
  const lat = (0.5 - v) * Math.PI
  out[0] = Math.cos(lat) * Math.cos(lon)
  out[1] = Math.sin(lat)
  out[2] = Math.cos(lat) * Math.sin(lon)
  return out
}

/** Wraps u to [−0.5, 0.5) — for stamping craters across the seam. */
const wrapU = (u) => {
  let x = u % 1
  if (x < -0.5) x += 1
  if (x > 0.5) x -= 1
  return x
}

/** Rocky: cratered tan. The real moon bitmap swaps in when fetched. */
export function makeRockTexture(seed) {
  const W = 256, H = 128
  const data = new Uint8Array(W * H * 4)
  const rng = mulberry32(seed ^ 0x0c4a)
  const noiseSeed = (rng() * 0x7fffffff) | 0
  const craters = []
  for (let i = 0; i < 26; i++) {
    craters.push([rng(), 0.12 + rng() * 0.76, 0.012 + rng() * 0.05])
  }
  const p = [0, 0, 0]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H
      spherePoint(u, v, p)
      const at = (y * W + x) * 4
      const base = fbm3(p[0] * 2.3, p[1] * 2.3, p[2] * 2.3, 5, noiseSeed)
      let lum = 0.55 + base * 0.55
      let bump = 0
      for (const [cu, cv, cr] of craters) {
        const du = wrapU(u - cu) * Math.cos((0.5 - v) * Math.PI)
        const dv = v - cv
        const dd = Math.hypot(du, dv)
        if (dd < cr) {
          const rim = Math.exp(-Math.pow((dd / cr - 0.82) * 6, 2)) * 0.34
          const floor = Math.exp(-Math.pow((dd / cr) * 2.4, 2)) * 0.22
          bump += rim - floor
        }
      }
      lum = clamp01(lum + bump)
      data[at] = Math.round(200 * lum)
      data[at + 1] = Math.round(168 * lum)
      data[at + 2] = Math.round(132 * lum)
      data[at + 3] = 255
    }
  }
  return { width: W, height: H, data }
}

/** Gas giant: latitude bands + domain-warped turbulence + one storm oval. */
export function makeGasTexture(seed) {
  const W = 256, H = 128
  const data = new Uint8Array(W * H * 4)
  const rng = mulberry32(seed ^ 0x9a5e)
  const noiseSeed = (rng() * 0x7fffffff) | 0
  const hueShift = rng() * 0.16
  const storm = [rng(), 0.3 + rng() * 0.4, 0.05 + rng() * 0.04, 0.028]
  const p = [0, 0, 0]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H
      spherePoint(u, v, p)
      const at = (y * W + x) * 4
      const warp = fbm3(p[0] * 1.6, p[1] * 3.4, p[2] * 1.6, 4, noiseSeed) - 0.5
      const band = Math.sin(v * Math.PI * 9 + warp * 2.6) * 0.5 + 0.5
      const detail = fbm3(p[0] * 5, p[1] * 10, p[2] * 5, 3, noiseSeed ^ 99) * 0.2
      let t = clamp01(band * 0.8 + detail + 0.1)
      // the storm oval (a great-spot)
      const du = wrapU(u - storm[0]) * Math.cos((0.5 - v) * Math.PI)
      const dv = (v - storm[1]) / 0.42
      const ds = Math.hypot(du / storm[2], dv)
      if (ds < 1) {
        // the storm oval lightens and saturates the band under it
        const s = Math.exp(-ds * ds * 2.2) * 0.8
        t = clamp01(t + s * 0.35)
      }
      const r = 158 + t * 66 + hueShift * 40
      const g = 132 + t * 54
      const b = 104 + t * 40 - hueShift * 30
      data[at] = Math.round(clamp01(r / 255) * 255)
      data[at + 1] = Math.round(clamp01(g / 255) * 255)
      data[at + 2] = Math.round(clamp01(b / 255) * 255)
      data[at + 3] = 255
    }
  }
  return { width: W, height: H, data }
}

/** Frozen: pale ice with pressure cracks. */
export function makeIceTexture(seed) {
  const W = 256, H = 128
  const data = new Uint8Array(W * H * 4)
  const rng = mulberry32(seed ^ 0x1ce1)
  const noiseSeed = (rng() * 0x7fffffff) | 0
  const p = [0, 0, 0]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H
      spherePoint(u, v, p)
      const at = (y * W + x) * 4
      const base = fbm3(p[0] * 2.2, p[1] * 2.2, p[2] * 2.2, 5, noiseSeed)
      const streak = fbm3(p[0] * 5.5, p[1] * 9, p[2] * 5.5, 3, noiseSeed ^ 55)
      // the cracks: ridged noise threshold
      const ridge = Math.abs(fbm3(p[0] * 3.2, p[1] * 3.2, p[2] * 3.2, 4, noiseSeed ^ 0x77) * 2 - 1)
      const crack = 1 - clamp01(ridge / 0.09)
      let lum = 0.72 + base * 0.2 + streak * 0.08 - crack * 0.4
      lum = clamp01(lum)
      data[at] = Math.round(178 * lum + 40)
      data[at + 1] = Math.round(206 * lum + 40)
      data[at + 2] = Math.round(235 * lum + 20)
      data[at + 3] = 255
    }
  }
  return { width: W, height: H, data }
}

/** Volcanic: dark crust, glowing fissures — the fissure mask rides in ALPHA. */
export function makeLavaTexture(seed) {
  const W = 256, H = 128
  const data = new Uint8Array(W * H * 4)
  const rng = mulberry32(seed ^ 0x1a7a)
  const noiseSeed = (rng() * 0x7fffffff) | 0
  const p = [0, 0, 0]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H
      spherePoint(u, v, p)
      const at = (y * W + x) * 4
      const crust = fbm3(p[0] * 3.1, p[1] * 3.1, p[2] * 3.1, 5, noiseSeed)
      const ridge = Math.abs(fbm3(p[0] * 2.4, p[1] * 2.4, p[2] * 2.4, 4, noiseSeed ^ 0x33) * 2 - 1)
      const fissure = Math.pow(1 - clamp01(ridge / 0.14), 1.6)
      const hot = fbm3(p[0] * 7, p[1] * 7, p[2] * 7, 3, noiseSeed ^ 0x91)
      data[at] = Math.round((28 + crust * 34 + fissure * 120) * 1)
      data[at + 1] = Math.round((16 + crust * 18 + fissure * 40) * 1)
      data[at + 2] = Math.round((13 + crust * 14 + fissure * 8) * 1)
      data[at + 3] = Math.round(clamp01(fissure * (0.55 + hot * 0.45)) * 255)
    }
  }
  return { width: W, height: H, data }
}

/** The settlement world (procedural garden planet; the earth bitmap swaps in). */
export function makeGardenTexture(seed) {
  const W = 256, H = 128
  const data = new Uint8Array(W * H * 4)
  const rng = mulberry32(seed ^ 0x9a2d)
  const noiseSeed = (rng() * 0x7fffffff) | 0
  const p = [0, 0, 0]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H
      spherePoint(u, v, p)
      const at = (y * W + x) * 4
      const land = fbm3(p[0] * 2.0, p[1] * 2.0, p[2] * 2.0, 5, noiseSeed)
      const lat = Math.abs(v - 0.5) * 2
      const cloud = fbm3(p[0] * 3.3, p[1] * 3.3, p[2] * 3.3, 4, noiseSeed ^ 0x44)
      let r, g, b
      if (land > 0.52) {
        const h = clamp01((land - 0.52) * 4)
        // green lowlands → brown highlands → snow caps by latitude
        const snow = clamp01((lat - 0.62) * 3 + h * 0.5 - 0.25)
        r = 52 + h * 60 + snow * 160
        g = 108 + h * 40 + snow * 140
        b = 44 + h * 26 + snow * 130
      } else {
        const deep = clamp01((0.52 - land) * 3)
        r = 16 + (1 - deep) * 26
        g = 42 + (1 - deep) * 50
        b = 96 + (1 - deep) * 66
      }
      if (cloud > 0.58) {
        const c = clamp01((cloud - 0.58) * 2.6) * 0.75
        r += (235 - r) * c
        g += (240 - g) * c
        b += (245 - b) * c
      }
      data[at] = Math.round(clamp01(r / 255) * 255)
      data[at + 1] = Math.round(clamp01(g / 255) * 255)
      data[at + 2] = Math.round(clamp01(b / 255) * 255)
      data[at + 3] = 255
    }
  }
  return { width: W, height: H, data }
}

// ─── 6. the gas-giant ring band (a radial strip) ─────────────────────────────

export function makeRingBands(seed) {
  const W = 256, H = 4
  const data = new Uint8Array(W * H * 4)
  const rng = mulberry32(seed ^ 0x21a9)
  const noiseSeed = (rng() * 0x7fffffff) | 0
  for (let x = 0; x < W; x++) {
    const t = x / W
    const n = fbm3(t * 9, 0.5, 2.2, 4, noiseSeed)
    // the Cassini-style gap structure
    const gaps = Math.exp(-Math.pow((t - 0.44) * 9, 2)) * 0.9 + Math.exp(-Math.pow((t - 0.16) * 14, 2)) * 0.7
    let a = clamp01((0.55 + n * 0.75) * (1 - gaps) * Math.min(1, t * 7) * Math.min(1, (1 - t) * 5))
    const lum = 0.72 + n * 0.28
    for (let y = 0; y < H; y++) {
      const at = (y * W + x) * 4
      data[at] = Math.round(216 * lum)
      data[at + 1] = Math.round(198 * lum)
      data[at + 2] = Math.round(172 * lum)
      data[at + 3] = Math.round(a * 255)
    }
  }
  return { width: W, height: H, data }
}

// ─── the kitchen: everything the render layer needs, in one call ────────────

/** The three nebula palettes (deep → mid → hot). */
export const NEBULA_PALETTES = [
  [[0.03, 0.08, 0.24], [0.18, 0.42, 0.85], [0.72, 0.88, 1.0]], // cold blue
  [[0.10, 0.04, 0.16], [0.55, 0.22, 0.68], [1.0, 0.7, 0.95]], // violet
  [[0.14, 0.05, 0.02], [0.75, 0.30, 0.14], [1.0, 0.8, 0.5]], // ember
]

/**
 * Build the whole texture set for a world. Cheap enough to run at boot
 * (~50-150 ms on a phone, once) and fully deterministic by seed.
 */
export function makeTextures(seed) {
  return {
    haze: makeGalaxyHaze(seed),
    star: makeStarSprite(),
    sun: makeSunSprite(seed),
    nebula0: makeNebula(seed + 1, NEBULA_PALETTES[0], 2.1, 1.0),
    nebula1: makeNebula(seed + 2, NEBULA_PALETTES[1], 2.4, 1.0),
    nebula2: makeNebula(seed + 3, NEBULA_PALETTES[2], 2.0, 0.85),
    rock: makeRockTexture(seed + 11),
    gas: makeGasTexture(seed + 12),
    ice: makeIceTexture(seed + 13),
    lava: makeLavaTexture(seed + 14),
    garden: makeGardenTexture(seed + 15),
    ring: makeRingBands(seed + 21),
  }
}
