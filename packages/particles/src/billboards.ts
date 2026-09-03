/**
 * @rune/particles — the billboard soup: the GPU view of the particle store.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * One quad (6 vertices, 2 triangles) per particle, baked CPU-side into ONE
 * reused Float32Array — the draw command consumes the soup as plain vertex
 * attributes (position, uv, color), no instancing, no geometry shader, no
 * per-pipeline surprises on either backend.
 *
 * Vertex layout (STRIDE = 9 floats):
 *   [0..2] position  — world-space, p + right·ox + up·oy (billboarded)
 *   [3..4] uv        — the sprite corner, or the ATLAS tile corner (Task 122)
 *   [5..8] color     — spawn tint × ramp: rgb × rgb, a × a
 *
 * THE RENDER MODES (Task 122 — three.quarks' RenderMode family):
 *   camera     — the classic: the quad plane ⊥ the view direction (default)
 *   vertical   — upright: up = world +Y, turns around Y to face the camera
 *   horizontal — flat: the quad lies in the XZ plane (a ground decal)
 *   stretched  — velocity-aligned, three.quarks' StretchedBillBoard EXACTLY:
 *                a ONE-SIDDED quad — the head (u=0) sits on the particle,
 *                the tail (u=1) trails behind along the motion, and BOTH
 *                extents scale with the particle's own size:
 *                  tail   = (|v|·speedFactor + lengthFactor) · size
 *                  width  = size
 *                (their stretched_bb shader multiplies the pre-scaled
 *                velocity by avgSize — a 0.03 spark at sf 0.1 grows a
 *                0.06-unit tail, not a 2-unit laser streak; their texture
 *                is built for this mapping: a bright head at u≈0 fading
 *                to black at u=1)
 *   oriented   — a free 3D orientation: per-particle axis (fixed or
 *                seed-random) + angle = seed·τ + age·spin3d (their
 *                Rotation3DOverLife leaves / LocalSpace flash planes)
 *
 * THE ATLAS (Task 122 — their uTileCount/vTileCount/FrameOverLife):
 *   options.tiles = [u, v] splits the sprite texture into a u×v sheet; the
 *   ramp's FRAME channel (RampPoint.frame, sampled at t = age/life, floored)
 *   picks the tile. The tile index runs row-major from the top-left.
 *   options.frameJitter adds seed·frameJitter to the frame before the
 *   floor — their "startTileIndex: IntervalValue(0, N)" (a per-particle
 *   random tile; theirs also cross-blends fractional tiles — blendTiles —
 *   ours floors to the nearest tile).
 *
 * The rotation (camera mode): each quad spins in its own plane by
 *   angle = seed·τ + age·spinSpeed
 * (seed phases the particles apart; spinSpeed is a scalar of the view).
 *
 * PERFORMANCE: zero allocations — the out array is caller-owned (the
 * facade allocates it once at capacity), the ramp scratch is one shared
 * 6-float array, all locals are hoisted. fillBillboards returns the
 * VERTEX COUNT (6 × live particles).
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { ParticleSystem } from './system.ts'
import { sampleRamp, CONSTANT_RAMP, type Ramp } from './ramp.ts'

/** Floats per vertex (position 3, uv 2, color 4). */
export const SOUP_STRIDE = 9
/** Vertices per particle (two triangles). */
export const VERTS_PER_PARTICLE = 6

/** The camera basis for billboarding: two unit world-space vectors
 *  (right, up) — typically column 0 and 1 of the view matrix, negated
 *  appropriately. The quad plane is ⊥ the view direction by construction.
 *  `forward` (the unit direction the camera LOOKS, toward the target) is
 *  required by the vertical / horizontal / stretched modes. */
export interface CameraBasis {
  readonly right: readonly number[]
  readonly up: readonly number[]
  readonly forward?: readonly number[]
}

/** How the quad is oriented in the world (see the module header). */
export type BillboardMode = 'camera' | 'vertical' | 'horizontal' | 'stretched' | 'oriented'

/** The billboard view options. */
export interface BillboardOptions {
  /** The over-life ramp (size + color + frame); default: the constant identity. */
  readonly ramp?: Ramp
  /** The spin speed, radians/second (the seed phases each particle). */
  readonly spin?: number
  /** The orientation mode (default 'camera' — the classic billboard). */
  readonly mode?: BillboardMode
  /** The sprite sheet split [u, v] (the atlas; the ramp's frame channel
   *  picks the tile). Omitted — the full texture. */
  readonly tiles?: readonly [number, number]
  /** 'stretched': the velocity stretch — the tail gains
   *  (|v|·speedFactor)·size world units, BEHIND the particle (their
   *  SpriteBatch pre-scales the velocity attribute by speedFactor and the
   *  shader multiplies by avgSize; default 0). */
  readonly speedFactor?: number
  /** 'stretched': the base tail = lengthFactor·size, added at rest so the
   *  streak reads even when |v| ≈ 0 (their (1 + lf/vlength) term; default
   *  1 — pass 0 for a pure velocity streak like the cfxr sparks). */
  readonly lengthFactor?: number
  /** A per-particle random tile offset added to the ramp's frame before
   *  the floor: frame + seed·frameJitter. three.quarks' startTileIndex
   *  IntervalValue(0, N) — each particle picks its own atlas tile (their
   *  fractional tiles also cross-blend neighbors; ours floors). Default 0. */
  readonly frameJitter?: number
  /** 'oriented': the rotation axis — [x, y, z] (any length; normalized
   *  once) or 'random' (a per-particle axis from the seed — their
   *  RandomQuatGenerator look). Default 'random'. */
  readonly axis?: readonly number[] | 'random'
  /** 'oriented': the 3D spin speed, radians/second (the seed phases it). */
  readonly spin3d?: number
}

/** Bakes the live particles into `out` (a Float32Array of at least
 *  capacity × 54 floats). Returns the vertex count. Deterministic:
 *  the same (store state, basis, options) writes the same bytes. */
export function fillBillboards(
  system: ParticleSystem,
  basis: CameraBasis,
  out: Float32Array,
  options: BillboardOptions = {},
): number {
  const ramp = options.ramp ?? CONSTANT_RAMP
  const spin = options.spin ?? 0
  const mode = options.mode ?? 'camera'
  const f = system.fields
  const count = system.count
  const rx = basis.right[0], ry = basis.right[1], rz = basis.right[2]
  const ux = basis.up[0], uy = basis.up[1], uz = basis.up[2]
  const fx = basis.forward?.[0] ?? 0, fy = basis.forward?.[1] ?? 0, fz = basis.forward?.[2] ?? -1
  // The ramp scratch — ONE array shared by every particle in this pass.
  const s: Float32Array = SCRATCH

  // The atlas constants (Task 122): the tile size and the frame clamp.
  const tiles = options.tiles
  const tileU = tiles !== undefined ? tiles[0] : 1
  const tileV = tiles !== undefined ? tiles[1] : 1
  const useAtlas = tiles !== undefined
  // Their startTileIndex IntervalValue(0, N): the seed-scattered per-particle
  // tile offset, added to the ramp's frame BEFORE the floor.
  const frameJitter = options.frameJitter ?? 0
  if (useAtlas && (!Number.isInteger(tileU) || tileU < 1 || !Number.isInteger(tileV) || tileV < 1)) {
    throw new Error(`rune/particles: billboard tiles must be integers >= 1 (got [${tileU}, ${tileV}])`)
  }
  const maxFrame = tileU * tileV - 1

  // The vertical/horizontal/stretched constants: the horizontal frame
  // around worldUp — hz = normalize((fz, 0, -fx)) ⊥ forward, horizontal;
  // hf = normalize((fx, 0, fz)) — the forward's ground projection.
  let hzx = fz, hzy = 0, hzz = -fx
  let hl = Math.hypot(hzx, hzy, hzz)
  if (hl < 1e-6) { hzx = 1; hzy = 0; hzz = 0; hl = 1 }
  hzx /= hl; hzy /= hl; hzz /= hl
  const hfx = fx, hfy = 0, hfz = fz
  let hfl = Math.hypot(hfx, hfy, hfz)
  if (hfl < 1e-6) { hfl = 1 }
  const gx = hfx / hfl, gy = 0, gz = hfz / hfl

  const speedFactor = options.speedFactor ?? 0
  const lengthFactor = options.lengthFactor ?? 1

  // The 'oriented' constants: the fixed axis (normalized) or 'random'.
  const axisOpt = options.axis ?? 'random'
  let oax = 0, oay = 0, oaz = 1
  const axisRandom = axisOpt === 'random'
  if (!axisRandom) {
    const a = axisOpt as readonly number[]
    const al = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0)
    if (al < 1e-12 || !Number.isFinite(al)) {
      throw new Error('rune/particles: the oriented axis must be a finite non-zero vector')
    }
    oax = (a[0] ?? 0) / al; oay = (a[1] ?? 0) / al; oaz = (a[2] ?? 0) / al
  }
  const spin3d = options.spin3d ?? 0

  let at = 0
  for (let i = 0; i < count; i++) {
    const age = f.age[i]
    const life = f.life[i]
    const t = life > 0 ? age / life : 0
    sampleRamp(ramp, t, s)
    // The final size: the spawn size × the ramp multiplier; the half-extent.
    const half = f.size[i] * s[0] * 0.5
    if (half <= 0) continue // a zero-size particle emits no quad
    // The color: tint × ramp (rgb × rgb, a × a).
    const cr = f.cr[i] * s[1], cg = f.cg[i] * s[2], cb = f.cb[i] * s[3], ca = f.ca[i] * s[4]
    const px = f.px[i], py = f.py[i], pz = f.pz[i]

    // The atlas tile (row-major from the top-left; the frame is lerped by
    // the ramp, jittered by the seed, floored here, clamped to the sheet).
    let u0 = 0, v0 = 0, uS = 1, vS = 1
    if (useAtlas) {
      let frame = Math.floor(s[5] + (frameJitter > 0 ? f.seed[i] * frameJitter : 0))
      if (!Number.isFinite(frame)) frame = 0
      if (frame < 0) frame = 0
      if (frame > maxFrame) frame = maxFrame
      u0 = (frame % tileU) / tileU
      v0 = Math.floor(frame / tileU) / tileV
      uS = 1 / tileU
      vS = 1 / tileV
    }

    if (mode === 'camera') {
      // The in-plane rotation (seed phases, spin advances).
      let c1 = 1, s1 = 0, c2 = 0, s2 = 1
      if (spin !== 0 || f.seed[i] !== 0) {
        const ang = f.seed[i] * 6.283185307179586 + age * spin
        const cos = Math.cos(ang), sin = Math.sin(ang)
        // Corner (a, b) ∈ {(-1,-1),(1,-1),(1,1),(-1,1)} rotated by ang.
        c1 = cos; s1 = sin; c2 = -sin; s2 = cos
      }

      // The four rotated corner offsets (world space), shared by the 2 tris.
      // corners: 0 = (-1,-1), 1 = (1,-1), 2 = (1,1), 3 = (-1,1)
      const o0x = (c1 * -half + c2 * -half), o0y = (s1 * -half + s2 * -half)
      const o1x = (c1 * half + c2 * -half), o1y = (s1 * half + s2 * -half)
      const o2x = (c1 * half + c2 * half), o2y = (s1 * half + s2 * half)
      const o3x = (c1 * -half + c2 * half), o3y = (s1 * -half + s2 * half)

      // Triangle 1: corners 0, 1, 2. Triangle 2: corners 0, 2, 3.
      // (Same winding for both — CCW in the right/up plane.)
      at = vert(out, at, px + o0x * rx + o0y * ux, py + o0x * ry + o0y * uy, pz + o0x * rz + o0y * uz, u0, v0, cr, cg, cb, ca)
      at = vert(out, at, px + o1x * rx + o1y * ux, py + o1x * ry + o1y * uy, pz + o1x * rz + o1y * uz, u0 + uS, v0, cr, cg, cb, ca)
      at = vert(out, at, px + o2x * rx + o2y * ux, py + o2x * ry + o2y * uy, pz + o2x * rz + o2y * uz, u0 + uS, v0 + vS, cr, cg, cb, ca)
      at = vert(out, at, px + o0x * rx + o0y * ux, py + o0x * ry + o0y * uy, pz + o0x * rz + o0y * uz, u0, v0, cr, cg, cb, ca)
      at = vert(out, at, px + o2x * rx + o2y * ux, py + o2x * ry + o2y * uy, pz + o2x * rz + o2y * uz, u0 + uS, v0 + vS, cr, cg, cb, ca)
      at = vert(out, at, px + o3x * rx + o3y * ux, py + o3x * ry + o3y * uy, pz + o3x * rz + o3y * uz, u0, v0 + vS, cr, cg, cb, ca)
      continue
    }

    if (mode === 'vertical' || mode === 'horizontal') {
      // upright: right = the horizontal ⊥-forward; up = world +Y.
      // flat (a ground decal): right = the same horizontal ⊥-forward;
      // up = the ground-projected forward (the texture top points AWAY).
      const arx = hzx, ary = hzy, arz = hzz
      const auy = mode === 'vertical' ? 1 : gy
      const aux = mode === 'vertical' ? 0 : gx
      const auz = mode === 'vertical' ? 0 : gz
      const o0x = -half * arx + -half * aux, o0y = -half * ary + -half * auy, o0z = -half * arz + -half * auz
      const o1x = half * arx + -half * aux, o1y = half * ary + -half * auy, o1z = half * arz + -half * auz
      const o2x = half * arx + half * aux, o2y = half * ary + half * auy, o2z = half * arz + half * auz
      const o3x = -half * arx + half * aux, o3y = -half * ary + half * auy, o3z = -half * arz + half * auz
      at = vert3(out, at, px, py, pz, o0x, o0y, o0z, u0, v0, cr, cg, cb, ca)
      at = vert3(out, at, px, py, pz, o1x, o1y, o1z, u0 + uS, v0, cr, cg, cb, ca)
      at = vert3(out, at, px, py, pz, o2x, o2y, o2z, u0 + uS, v0 + vS, cr, cg, cb, ca)
      at = vert3(out, at, px, py, pz, o0x, o0y, o0z, u0, v0, cr, cg, cb, ca)
      at = vert3(out, at, px, py, pz, o2x, o2y, o2z, u0 + uS, v0 + vS, cr, cg, cb, ca)
      at = vert3(out, at, px, py, pz, o3x, o3y, o3z, u0, v0 + vS, cr, cg, cb, ca)
      continue
    }

    if (mode === 'stretched') {
      // Velocity-aligned, three.quarks' stretched_bb EXACTLY: the HEAD
      // (u = 0) sits ON the particle, the TAIL (u = 1) trails BEHIND along
      // −dir; both extents scale with the particle's own size (their
      // avgSize). A particle at rest (|v| ≈ 0) falls back to the camera-
      // facing quad (their shader NaNs at |v| → 0 — they hack a 0.001
      // speedFactor floor; we degrade gracefully).
      const vx = f.vx[i], vy = f.vy[i], vz = f.vz[i]
      const vlen = Math.hypot(vx, vy, vz)
      if (vlen < 1e-4) {
        at = cameraQuad(out, at, px, py, pz, half, rx, ry, rz, ux, uy, uz, u0, v0, uS, vS, cr, cg, cb, ca)
        continue
      }
      const dx = vx / vlen, dy = vy / vlen, dz = vz / vlen
      // side = cross(forward, dir), normalized; degenerate (dir ∥ forward)
      // → any perpendicular of dir.
      let sx = fy * dz - fz * dy, sy = fz * dx - fx * dz, sz = fx * dy - fy * dx
      let sl = Math.hypot(sx, sy, sz)
      if (sl < 1e-6) { sx = dy; sy = -dx; sz = 0; sl = Math.hypot(sx, sy, sz) || 1 }
      sx /= sl; sy /= sl; sz /= sl
      const sizeFull = f.size[i] * s[0]
      const tail = (vlen * speedFactor + lengthFactor) * sizeFull
      const halfW = half
      // The head edge (u=0) at the particle, the tail edge (u=1) at
      // p − dir·tail; the width spans ±halfW along the side axis.
      const h0x = -sx * halfW, h0y = -sy * halfW, h0z = -sz * halfW
      const h1x = sx * halfW, h1y = sy * halfW, h1z = sz * halfW
      const t0x = -dx * tail - sx * halfW, t0y = -dy * tail - sy * halfW, t0z = -dz * tail - sz * halfW
      const t1x = -dx * tail + sx * halfW, t1y = -dy * tail + sy * halfW, t1z = -dz * tail + sz * halfW
      at = vert3(out, at, px, py, pz, h0x, h0y, h0z, u0, v0, cr, cg, cb, ca)
      at = vert3(out, at, px, py, pz, t0x, t0y, t0z, u0 + uS, v0, cr, cg, cb, ca)
      at = vert3(out, at, px, py, pz, t1x, t1y, t1z, u0 + uS, v0 + vS, cr, cg, cb, ca)
      at = vert3(out, at, px, py, pz, h0x, h0y, h0z, u0, v0, cr, cg, cb, ca)
      at = vert3(out, at, px, py, pz, t1x, t1y, t1z, u0 + uS, v0 + vS, cr, cg, cb, ca)
      at = vert3(out, at, px, py, pz, h1x, h1y, h1z, u0, v0 + vS, cr, cg, cb, ca)
      continue
    }

    // mode === 'oriented' — the free 3D rotation. The base quad lives in
    // the world XY plane (normal +Z, like their PlaneGeometry); the
    // axis-angle rotation spins it. Per-particle random axis from the seed
    // (two decorrelated fract multiplies → a uniform sphere direction).
    let ax2 = oax, ay2 = oay, az2 = oaz
    if (axisRandom) {
      const sd = f.seed[i]
      const s1 = sd * 7.31 - Math.floor(sd * 7.31)
      const s2 = sd * 3.77 - Math.floor(sd * 3.77)
      const zc = 1 - 2 * s1
      const rc = Math.sqrt(Math.max(0, 1 - zc * zc))
      const phi = 6.283185307179586 * s2
      ax2 = rc * Math.cos(phi); ay2 = rc * Math.sin(phi); az2 = zc
    }
    const ang = f.seed[i] * 6.283185307179586 + age * spin3d
    const c = Math.cos(ang), sn = Math.sin(ang), tt = 1 - c
    // The rotation matrix's first TWO columns (the third multiplies z = 0
    // — never read for a planar quad):
    //  R = [ t·x²+c   t·xy−s·z ]   (column 0 and 1)
    //      [ t·xy+s·z t·y²+c   ]
    //      [ t·xz−s·y t·yz+s·x ]
    const m00 = tt * ax2 * ax2 + c, m01 = tt * ax2 * ay2 - sn * az2
    const m10 = tt * ax2 * ay2 + sn * az2, m11 = tt * ay2 * ay2 + c
    const m20 = tt * ax2 * az2 - sn * ay2, m21 = tt * ay2 * az2 + sn * ax2
    // corners: 0 = (-1,-1), 1 = (1,-1), 2 = (1,1), 3 = (-1,1) in the base plane
    const o0x = m00 * -half + m01 * -half, o0y = m10 * -half + m11 * -half, o0z = m20 * -half + m21 * -half
    const o1x = m00 * half + m01 * -half, o1y = m10 * half + m11 * -half, o1z = m20 * half + m21 * -half
    const o2x = m00 * half + m01 * half, o2y = m10 * half + m11 * half, o2z = m20 * half + m21 * half
    const o3x = m00 * -half + m01 * half, o3y = m10 * -half + m11 * half, o3z = m20 * -half + m21 * half
    at = vert3(out, at, px, py, pz, o0x, o0y, o0z, u0, v0, cr, cg, cb, ca)
    at = vert3(out, at, px, py, pz, o1x, o1y, o1z, u0 + uS, v0, cr, cg, cb, ca)
    at = vert3(out, at, px, py, pz, o2x, o2y, o2z, u0 + uS, v0 + vS, cr, cg, cb, ca)
    at = vert3(out, at, px, py, pz, o0x, o0y, o0z, u0, v0, cr, cg, cb, ca)
    at = vert3(out, at, px, py, pz, o2x, o2y, o2z, u0 + uS, v0 + vS, cr, cg, cb, ca)
    at = vert3(out, at, px, py, pz, o3x, o3y, o3z, u0, v0 + vS, cr, cg, cb, ca)
  }
  return at / SOUP_STRIDE
}

/** The module-level ramp scratch (the memory contract: no per-call
 *  allocation — one 6-float array serves every fillBillboards call;
 *  the write happens before the read, single-threaded by contract). */
const SCRATCH = new Float32Array(6)

/** A camera-facing quad at (px,py,pz) — the stretched mode's rest fallback.
 *  All six verts inline (the soup's zero-allocation contract). */
function cameraQuad(
  out: Float32Array, at: number,
  px: number, py: number, pz: number, half: number,
  rx: number, ry: number, rz: number, ux: number, uy: number, uz: number,
  u0: number, v0: number, uS: number, vS: number,
  cr: number, cg: number, cb: number, ca: number,
): number {
  const aX = -half, aY = -half, bX = half, bY = -half, cX = half, cY = half, dX = -half, dY = half
  at = vert(out, at, px + aX * rx + aY * ux, py + aX * ry + aY * uy, pz + aX * rz + aY * uz, u0, v0, cr, cg, cb, ca)
  at = vert(out, at, px + bX * rx + bY * ux, py + bX * ry + bY * uy, pz + bX * rz + bY * uz, u0 + uS, v0, cr, cg, cb, ca)
  at = vert(out, at, px + cX * rx + cY * ux, py + cX * ry + cY * uy, pz + cX * rz + cY * uz, u0 + uS, v0 + vS, cr, cg, cb, ca)
  at = vert(out, at, px + aX * rx + aY * ux, py + aX * ry + aY * uy, pz + aX * rz + aY * uz, u0, v0, cr, cg, cb, ca)
  at = vert(out, at, px + cX * rx + cY * ux, py + cX * ry + cY * uy, pz + cX * rz + cY * uz, u0 + uS, v0 + vS, cr, cg, cb, ca)
  at = vert(out, at, px + dX * rx + dY * ux, py + dX * ry + dY * uy, pz + dX * rz + dY * uz, u0, v0 + vS, cr, cg, cb, ca)
  return at
}

/** Writes one vertex at float offset `at`, returns the next offset. */
function vert(
  out: Float32Array,
  at: number,
  x: number, y: number, z: number,
  u: number, v: number,
  cr: number, cg: number, cb: number, ca: number,
): number {
  out[at] = x; out[at + 1] = y; out[at + 2] = z
  out[at + 3] = u; out[at + 4] = v
  out[at + 5] = cr; out[at + 6] = cg; out[at + 7] = cb; out[at + 8] = ca
  return at + SOUP_STRIDE
}

/** Writes one vertex = position + a PRE-COMPUTED world offset. */
function vert3(
  out: Float32Array,
  at: number,
  px: number, py: number, pz: number,
  ox: number, oy: number, oz: number,
  u: number, v: number,
  cr: number, cg: number, cb: number, ca: number,
): number {
  out[at] = px + ox; out[at + 1] = py + oy; out[at + 2] = pz + oz
  out[at + 3] = u; out[at + 4] = v
  out[at + 5] = cr; out[at + 6] = cg; out[at + 7] = cb; out[at + 8] = ca
  return at + SOUP_STRIDE
}
