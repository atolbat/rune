/**
 * @rune/particles — deterministic spawning: a stateless integer-hash RNG +
 * the shape spawners.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A STATELESS HASH (not a mulberry32 stream): a stream RNG makes the
 * emission depend on CALL ORDER — the same (seed, particle index) pair
 * would produce different values after a pause/resume or a re-burst.
 * hash01(seed, i, salt) is a pure function of its arguments: same burst,
 * same numbers, every time. Determinism is a package guarantee (the tests
 * pin it bit-exactly).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { hash01 } from '@rune/core'
import type { SpawnRecord } from './system.ts'

// Task 133: hash01 moved to @rune/core (random.ts — the repo-standard
// deterministic uniform, bit-identical); re-exported here (the public API
// and the tests' import sites are unchanged).
export { hash01 }

/** The spawn shape. `axis` vectors are normalized ONCE at spawner
 *  creation (the emit path only reads them).
 *
 *  Task 117 — the disc's SPIRAL ARMS (the galaxy-maker): `arms` angular
 *  sectors, `twist` radians of winding swept from radius[0] to radius[1],
 *  `armSpread` radians of uniform scatter within an arm. Omitted arms →
 *  the uniform annulus (the previous behavior, bit-identical).
 *
 *  The emitter family: `hemisphere` (the upper
 *  dome around the axis), `donut` (a torus: the ring + the tube circle),
 *  `rectangle` (a plane patch ⊥ axis), `grid` (a lattice — 'random' cells
 *  like theirs, or 'lattice' index→cell for perfect full-grid bursts).
 *
 *  Task 126 — `path`: a POLYLINE spawner (lightning bolts, laser beams,
 *  wall-of-fire walls): one burst of `segments` particles covers the whole
 *  path exactly ('lattice' — index → segment), the velocity follows the
 *  LOCAL segment direction (mode 'axis'), `scatter` jitters sideways.
 *
 *  Task 130 — the `line` LATTICE: index → station (u = (i % count + 0.5) /
 *  count) — one burst of `count` particles covers the segment gap-free;
 *  re-bursted every frame with a live from/to it is the CONTINUOUS-BEAM
 *  primitive (the hash-random positions of a sparse line burst read as a
 *  dashed train of blobs — the laser demo's "discrete beam" bug). */
export type SpawnShape =
  | { readonly kind: 'point'; readonly origin: readonly number[] }
  | { readonly kind: 'sphere'; readonly origin: readonly number[]; readonly radius: readonly [number, number] }
  | { readonly kind: 'cone'; readonly origin: readonly number[]; readonly axis: readonly number[]; readonly halfAngle: number; readonly baseRadius: number; readonly length: readonly [number, number] }
  | { readonly kind: 'disc'; readonly origin: readonly number[]; readonly axis: readonly number[]; readonly radius: readonly [number, number]
      /** Arm count (integer ≥ 1). arms=1 = a single fanned sector (a comet
       *  tail / a barred galaxy). Default: no arms — the uniform annulus. */
      readonly arms?: number
      /** Angular scatter within an arm, radians (default 0.35). 0 = razor arms. */
      readonly armSpread?: number
      /** Total winding from the inner to the outer radius, radians (default 0 —
       *  straight radial arms). Negative = the opposite winding direction:
       *  match the sign to the orbit direction so the arms TRAIL (real galaxies). */
      readonly twist?: number }
  | { readonly kind: 'hemisphere'; readonly origin: readonly number[]; readonly axis: readonly number[]; readonly radius: readonly [number, number]
      /** Azimuth span, radians (default τ — the full dome). */
      readonly arc?: number }
  | { readonly kind: 'donut'; readonly origin: readonly number[]; readonly axis: readonly number[]
      /** The ring radius (the donut's centerline). */
      readonly radius: number
      /** The tube radius range [min, max] (the donut's thickness). */
      readonly tube: readonly [number, number]
      /** Azimuth span around the axis, radians (default τ). */
      readonly arc?: number }
  | { readonly kind: 'rectangle'; readonly origin: readonly number[]; readonly axis: readonly number[]; readonly width: number; readonly height: number }
  | { readonly kind: 'grid'; readonly origin: readonly number[]; readonly axis: readonly number[]; readonly width: number; readonly height: number
      readonly rows: number; readonly columns: number
      /** 'random' — a random cell per particle (the grid emitter).
       *  'lattice' — index → cell (col = i % columns): one burst of
       *  rows×columns fills the grid PERFECTLY, deterministically. */
      readonly mode?: 'random' | 'lattice' }
  | { readonly kind: 'line'; readonly from: readonly number[]; readonly to: readonly number[]
      /** Task 130 — 'lattice': index → station (u = (i % count + 0.5) / count):
       *  one burst of `count` particles covers the WHOLE segment gap-free,
       *  deterministically — the CONTINUOUS-BEAM primitive (re-burst every
       *  frame with a live from/to and the segment stays solid; a cyclic
       *  shift of the global stream still covers every station exactly).
       *  'random' — a hash position per particle (the default, unchanged). */
      readonly mode?: 'random' | 'lattice'
      /** The station spacing, world units (lattice, default 0.25) — the count
       *  derives from the CURRENT segment length: round(len / spacing), so
       *  the coverage tracks a live from/to. Ignored when `count` is set. */
      readonly spacing?: number
      /** An explicit station count (lattice) — overrides `spacing`; the
       *  stations stretch with the live segment length (uniform coverage at
       *  any length). Integer >= 1. */
      readonly count?: number }
  | { readonly kind: 'path'
      /** The flat polyline [x0,y0,z0, x1,y1,z1, …] — ≥ 2 points (1 segment).
       *  Repeated consecutive points are rejected (a zero-length segment has
       *  no direction). */
      readonly points: readonly number[]
      /** 'lattice' — index → segment: one burst of `segments` particles
       *  covers the WHOLE path exactly, deterministically (the jagged bolt
       *  in ONE burst). 'random' — a hash-picked segment per particle.
       *  Default 'random'. */
      readonly mode?: 'random' | 'lattice'
      /** The lateral scatter radius around the polyline, world units — a
       *  fuzzy band around the path instead of a razor line. Default 0. */
      readonly scatter?: number }

/** How the spawn velocity is directed.
 *  radial     — away from the shape origin (the sphere burst; any shape).
 *                             DEGENERATE at the origin (a point shape, a
 *               zero-radius sphere): a uniform RANDOM unit-sphere direction
 *               — the point emitter, exactly (theta = u·τ,
 *               phi = acos(2v−1)): a point burst SCATTERS, never jets.
 *  lobe       — the cone's axis fanned by its halfAngle (cone only);
 *  axis       — along the shape axis (cone / disc / line);
 *  tangential — cross(axis, radial): orbits, galaxies, vortices
 *               (disc / sphere);
 *  fixed      — an explicit vector (any shape). */
export type VelocityMode =
  | { readonly mode: 'radial' }
  | { readonly mode: 'lobe' }
  | { readonly mode: 'axis' }
  | { readonly mode: 'tangential' }
  | { readonly mode: 'fixed'; readonly dir: readonly number[] }

/** The seek TARGET source (the image-sequencer /
 *  ApplySequences): where a newborn particle is HEADING (see forces.seek
 *  in system.ts). Omitted → NaN → the store defaults the target to the
 *  spawn position (a particle that holds still). */
export type TargetDesc =
  | { readonly mode: 'point'; readonly point: readonly number[] }
  | { readonly mode: 'image'
      /** The plane center (world space). */
      readonly origin: readonly number[]
      /** The plane normal (the image faces this way). */
      readonly axis: readonly number[]
      /** The world-space width/height the mask maps onto. */
      readonly width: number
      readonly height: number
      /** The mask: {width, height, data} — data is ONE byte per pixel
       *  (the alpha channel); ≥ 128 = a lit pixel. Sampled UNIFORMLY over
       *  the lit pixels (a cumulated index built once at spawner creation —
       *  O(1) per particle, deterministic). */
      readonly mask: ImageMask }

/** The image mask (one byte per pixel, row-major, top row first). */
export interface ImageMask {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array | Uint8ClampedArray
}

/** The full spawner description: shape + velocity + per-particle ranges.
 *  Ranges are [min, max] — a constant is [v, v]. Colors interpolate
 *  linearly between two rgba endpoints.
 *
 *  Task 117 — the two radial modulators (the galaxy-maker kit):
 *   • speedByRadius — speed scales as (ref/r)^power (Keplerian shear at
 *     power ≈ 0.9: the inner rim visibly outruns the outer — spiral arms
 *     develop real differential rotation instead of a rigid donut);
 *   • colorByRadius — the color mix follows the radius (color[0] at the
 *     core → color[1] at the rim) instead of the per-particle hash —
 *     a warm core with cool arms, no random speckle.
 *
 *  Task 122 — `target`: the newborn's seek target (see TargetDesc). */
export interface SpawnerDesc {
  readonly shape: SpawnShape
  readonly velocity: VelocityMode
  /** Speed range, units/second. */
  readonly speed: readonly [number, number]
  /** Radial speed modulation: speed = range · (ref / r)^power, where r is
   *  the spawn distance from the shape origin (the disc/sphere radius).
   *  Omit = flat speed. The ref is the radius where the scale is exactly 1. */
  readonly speedByRadius?: { readonly ref: number; readonly power: number }
  /** The color mix follows r (the sphere/disc radius range) instead of the
   *  per-particle hash: color[0] at radius[0] → color[1] at radius[1].
 *      Requires the sphere or disc shape (they carry the radius range). */
  readonly colorByRadius?: boolean
  /** Lifetime range, seconds (> 0 — validated). */
  readonly life: readonly [number, number]
  /** Billboard size range, world units (>= 0). */
  readonly size: readonly [number, number]
  /** Tint endpoints, rgba. */
  readonly color: readonly [readonly number[], readonly number[]]
  /** The seek target of a newborn (Task 122 — the sequencers). Omitted →
   *  the spawn position (a hold-still particle). */
  readonly target?: TargetDesc
  /** The RNG stream seed (0..2^31); different seeds = different bursts. */
  readonly seed?: number
}

/** A spawner: (index, out) fills the reused record. Allocation-free. */
export type Spawner = (index: number, out: SpawnRecord) => void

const TAU = 6.283185307179586
// The salt streams: decorrelated per property (any distinct constants).
const S_DIR = 1, S_SPD = 2, S_LIFE = 3, S_SIZE = 4, S_COL = 5, S_SEED = 6, S_P0 = 7, S_P1 = 8, S_P2 = 9, S_TARGET = 10
// Task 124 — the degenerate-radial scatter direction (two independent
// draws: the azimuth θ and the polar cosφ).
const S_SCAT0 = 11, S_SCAT1 = 12
// Task 126 — the path spawner streams: the segment pick, the t along it,
// the scatter radius and the scatter angle.
const S_PATH0 = 13, S_PATH1 = 14, S_PATH2 = 15, S_PATH3 = 16

/** Validates the description and compiles it into a flat spawner closure
 *  (all vectors normalized / precomputed ONCE, here). */
export function createSpawner(desc: SpawnerDesc): Spawner {
  const shape = desc.shape
  const velocity = desc.velocity
  const speed = rangeOf(desc.speed, 'speed')
  const life = rangeOf(desc.life, 'life')
  const size = rangeOf(desc.size, 'size')
  if (life[0] <= 0) throw new Error('rune/particles: spawner life must be > 0 (a zero-life particle is born dead)')
  if (size[0] < 0) throw new Error('rune/particles: spawner size must be >= 0')
  const seed = (desc.seed ?? 1) | 0
  const c0 = desc.color[0], c1 = desc.color[1]

  // ── the shape constants (origin, axis, ranges — all flat scalars) ──────
  const ox = shape.kind === 'line' ? shape.from[0] : shape.kind === 'path' ? shape.points[0] : shape.origin[0]
  const oy = shape.kind === 'line' ? shape.from[1] : shape.kind === 'path' ? shape.points[1] : shape.origin[1]
  const oz = shape.kind === 'line' ? shape.from[2] : shape.kind === 'path' ? shape.points[2] : shape.origin[2]
  let ax = 0, ay = 0, az = 1
  let lineLen = 0 // the live segment length (the line lattice derives count from it)
  const hasAxis = shape.kind === 'cone' || shape.kind === 'disc' || shape.kind === 'line'
    || shape.kind === 'hemisphere' || shape.kind === 'donut' || shape.kind === 'rectangle' || shape.kind === 'grid'
  if (hasAxis) {
    const vx = shape.kind === 'line' ? shape.to[0] - ox : shape.axis[0]
    const vy = shape.kind === 'line' ? shape.to[1] - oy : shape.axis[1]
    const vz = shape.kind === 'line' ? shape.to[2] - oz : shape.axis[2]
    const l = Math.hypot(vx, vy, vz)
    if (l === 0 || !Number.isFinite(l)) throw new Error('rune/particles: the shape axis (or the line endpoints) must be a finite non-zero vector')
    ax = vx / l; ay = vy / l; az = vz / l
    if (shape.kind === 'line') lineLen = l
  }
  // Task 130 — the LINE lattice constants: the station count is EXPLICIT
  // (`count`) or derived from the live segment length (`spacing` — the
  // coverage tracks a from/to that changes every burst). 'random' lines
  // are untouched (bit-identical).
  let lineLattice = false, lineCount = 0
  if (shape.kind === 'line') {
    const sp = shape.spacing ?? 0.25
    if (shape.spacing !== undefined && (!Number.isFinite(sp) || sp <= 0)) {
      throw new Error(`rune/particles: line spacing must be a finite > 0 (got ${shape.spacing})`)
    }
    if (shape.count !== undefined && (!Number.isInteger(shape.count) || shape.count < 1)) {
      throw new Error(`rune/particles: line count must be an integer >= 1 (got ${shape.count})`)
    }
    lineLattice = shape.mode === 'lattice'
    lineCount = lineLattice
      ? (shape.count ?? Math.max(1, Math.round(lineLen / sp)))
      : 0
  }
  let rMin = 0, rMax = 0
  if (shape.kind === 'sphere' || shape.kind === 'disc' || shape.kind === 'hemisphere') {
    ;[rMin, rMax] = rangeOf(shape.radius, 'radius')
    if (rMin < 0) throw new Error('rune/particles: shape radius must be >= 0')
  }
  let halfAngle = 0, baseRadius = 0, lenMin = 0, lenMax = 0
  if (shape.kind === 'cone') {
    halfAngle = shape.halfAngle
    if (!(halfAngle >= 0 && halfAngle < Math.PI / 2)) throw new Error('rune/particles: cone halfAngle must be in [0, π/2)')
    baseRadius = shape.baseRadius
    if (baseRadius < 0) throw new Error('rune/particles: cone baseRadius must be >= 0')
    ;[lenMin, lenMax] = rangeOf(shape.length, 'length')
  }
  // Task 122 — hemisphere/donut/rectangle/grid constants, flat scalars.
  let hemArc = TAU
  if (shape.kind === 'hemisphere') {
    hemArc = shape.arc ?? TAU
    if (!Number.isFinite(hemArc) || hemArc <= 0) throw new Error(`rune/particles: hemisphere arc must be a finite > 0 (got ${hemArc})`)
  }
  let donR = 0, tubeMin = 0, tubeMax = 0, donArc = TAU
  if (shape.kind === 'donut') {
    donR = shape.radius
    if (!Number.isFinite(donR) || donR <= 0) throw new Error(`rune/particles: donut radius must be a finite > 0 (got ${donR})`)
    ;[tubeMin, tubeMax] = rangeOf(shape.tube, 'tube')
    if (tubeMin < 0) throw new Error('rune/particles: donut tube must be >= 0')
    donArc = shape.arc ?? TAU
    if (!Number.isFinite(donArc) || donArc <= 0) throw new Error(`rune/particles: donut arc must be a finite > 0 (got ${donArc})`)
  }
  let rectW = 0, rectH = 0
  if (shape.kind === 'rectangle') {
    rectW = shape.width; rectH = shape.height
    if (!Number.isFinite(rectW) || rectW < 0 || !Number.isFinite(rectH) || rectH < 0) {
      throw new Error(`rune/particles: rectangle width/height must be finite >= 0 (got ${rectW}×${rectH})`)
    }
  }
  let gridW = 0, gridH = 0, gridRows = 0, gridCols = 0, gridLattice = false
  if (shape.kind === 'grid') {
    gridW = shape.width; gridH = shape.height
    gridRows = Math.floor(shape.rows); gridCols = Math.floor(shape.columns)
    gridLattice = shape.mode === 'lattice'
    if (!Number.isFinite(gridW) || gridW <= 0 || !Number.isFinite(gridH) || gridH <= 0) {
      throw new Error(`rune/particles: grid width/height must be finite > 0 (got ${gridW}×${gridH})`)
    }
    if (!Number.isInteger(gridRows) || gridRows < 1 || !Number.isInteger(gridCols) || gridCols < 1) {
      throw new Error(`rune/particles: grid rows/columns must be integers >= 1 (got ${gridRows}×${gridCols})`)
    }
  }
  // Task 126 — the PATH spawner: the polyline is validated + precompiled
  // ONCE here — per-segment direction, length, and the two scatter
  // perpendiculars (the emit path only lerps and jitters).
  let pathPts: Float64Array | null = null
  let pathDirs: Float64Array | null = null
  let pathPerp: Float64Array | null = null
  let pathSegs = 0, pathLattice = false, pathScatter = 0
  if (shape.kind === 'path') {
    const pts: readonly number[] = shape.points
    if (!Array.isArray(pts) && !(pts instanceof Float64Array) && !(pts instanceof Float32Array)) {
      throw new Error('rune/particles: path points must be a flat array of xyz triples')
    }
    if (pts.length < 6 || pts.length % 3 !== 0) {
      throw new Error(`rune/particles: path needs >= 2 points as a flat xyz array (got ${pts.length} numbers)`)
    }
    let allFinite = true
    for (let k = 0; k < pts.length; k++) {
      if (!Number.isFinite(pts[k])) { allFinite = false; break }
    }
    if (!allFinite) throw new Error('rune/particles: path points must all be finite')
    pathSegs = (pts.length / 3) - 1
    pathLattice = shape.mode === 'lattice'
    pathScatter = shape.scatter ?? 0
    if (!Number.isFinite(pathScatter) || pathScatter < 0) {
      throw new Error(`rune/particles: path scatter must be a finite >= 0 (got ${shape.scatter})`)
    }
    pathPts = Float64Array.from(pts)
    pathDirs = new Float64Array(pathSegs * 3)
    pathPerp = pathScatter > 0 ? new Float64Array(pathSegs * 6) : null
    for (let s = 0; s < pathSegs; s++) {
      const b = s * 3
      const dx = pts[b + 3] - pts[b], dy = pts[b + 4] - pts[b + 1], dz = pts[b + 5] - pts[b + 2]
      const l = Math.hypot(dx, dy, dz)
      if (l === 0 || !Number.isFinite(l)) {
        throw new Error(`rune/particles: path segment ${s} has zero length (points ${s} and ${s + 1} coincide) — no direction to emit along`)
      }
      const ndx = dx / l, ndy = dy / l, ndz = dz / l
      pathDirs[b] = ndx; pathDirs[b + 1] = ndy; pathDirs[b + 2] = ndz
      if (pathPerp !== null) {
        // The scatter frame: p1 = cross(worldUp, dir) (fallback (1,0,0)
        // when the segment is vertical), p2 = cross(dir, p1).
        let p1x = ndz, p1y = 0, p1z = -ndx
        let pl = Math.hypot(p1x, p1y, p1z)
        if (pl < 1e-6) { p1x = 1; p1y = 0; p1z = 0; pl = 1 }
        p1x /= pl; p1z /= pl
        pathPerp[b * 2] = p1x; pathPerp[b * 2 + 1] = p1y; pathPerp[b * 2 + 2] = p1z
        pathPerp[b * 2 + 3] = ndy * p1z - ndz * p1y
        pathPerp[b * 2 + 4] = ndz * p1x - ndx * p1z
        pathPerp[b * 2 + 5] = ndx * p1y - ndy * p1x
      }
    }
  }
  // Task 117: the disc's spiral arms — compiled ONCE into flat scalars.
  let arms = 0, armSpread = 0.35, twist = 0
  if (shape.kind === 'disc' && shape.arms !== undefined) {
    arms = shape.arms
    if (!Number.isInteger(arms) || arms < 1) throw new Error(`rune/particles: disc arms must be an integer >= 1 (got ${arms})`)
    armSpread = shape.armSpread ?? 0.35
    if (!Number.isFinite(armSpread) || armSpread < 0) throw new Error(`rune/particles: disc armSpread must be a finite >= 0 (got ${armSpread})`)
    twist = shape.twist ?? 0
    if (!Number.isFinite(twist)) throw new Error(`rune/particles: disc twist must be finite (got ${twist})`)
  }
  // Task 117: the radial modulators — speed scaling and the radius-driven
  // color mix. colorByRadius needs the radius RANGE → sphere/disc only.
  let speedRef = 0, speedPower = 0
  if (desc.speedByRadius !== undefined) {
    speedRef = desc.speedByRadius.ref
    speedPower = desc.speedByRadius.power
    if (!Number.isFinite(speedRef) || speedRef <= 0) throw new Error(`rune/particles: speedByRadius.ref must be a finite > 0 (got ${speedRef})`)
    if (!Number.isFinite(speedPower)) throw new Error(`rune/particles: speedByRadius.power must be finite (got ${speedPower})`)
  }
  const colorByRadius = desc.colorByRadius === true
  if (colorByRadius && shape.kind !== 'disc' && shape.kind !== 'sphere' && shape.kind !== 'hemisphere') {
    throw new Error("rune/particles: colorByRadius needs the sphere, disc or hemisphere shape (the radius range drives the mix)")
  }

  // ── the velocity mode validation (an honest pairing, no silent traps) ──
  let fx = 0, fy = 0, fz = 1
  if (velocity.mode === 'fixed') {
    const l = Math.hypot(velocity.dir[0], velocity.dir[1], velocity.dir[2])
    if (l === 0 || !Number.isFinite(l)) throw new Error('rune/particles: fixed velocity dir must be a finite non-zero vector')
    fx = velocity.dir[0] / l; fy = velocity.dir[1] / l; fz = velocity.dir[2] / l
  } else if (velocity.mode === 'lobe' && shape.kind !== 'cone') {
    throw new Error("rune/particles: velocity mode 'lobe' needs the cone shape (its halfAngle defines the fan)")
  } else if (velocity.mode === 'axis' && !hasAxis && shape.kind !== 'path') {
    throw new Error("rune/particles: velocity mode 'axis' needs a shape with an axis (cone/disc/line/hemisphere/donut/rectangle/grid) or the path shape (its LOCAL segment direction)")
  } else if (velocity.mode === 'tangential' && shape.kind !== 'disc' && shape.kind !== 'sphere' && shape.kind !== 'donut' && shape.kind !== 'hemisphere') {
    throw new Error("rune/particles: velocity mode 'tangential' needs the disc, sphere, donut or hemisphere shape")
  }

  // The orthonormal frame around the axis: t1, t2 (both ⊥ axis, ⊥ each other).
  // t0 = cross(axis, worldUp) with a fallback when the axis is ±Y.
  let t1x = -az, t1y = 0, t1z = ax
  let tl = Math.hypot(t1x, t1y, t1z)
  if (tl < 1e-6) { t1x = 1; t1y = 0; t1z = 0; tl = 1 }
  t1x /= tl; t1y /= tl; t1z /= tl
  const t2x = ay * t1z - az * t1y, t2y = az * t1x - ax * t1z, t2z = ax * t1y - ay * t1x

  // ── Task 122: the seek TARGET (the sequencer machinery) ────────────────
  // point → the flat target; image → a CUMULATED lit-pixel index built
  // ONCE here (one pass over the mask — cold), sampled O(1) per particle.
  let imgLit: Uint32Array | null = null // the packed (y<<16 | x) lit pixels
  let tgx = 0, tgy = 0, tgz = 0 // 'point': the flat target
  let imgTx = 0, imgTy = 0, imgTz = 0, imgUx = 0, imgUy = 0, imgUz = 0 // the image frame
  let imgW = 0, imgH = 0, imgWorldW = 0, imgWorldH = 0
  let imgOx = 0, imgOy = 0, imgOz = 0
  if (desc.target !== undefined) {
    const target = desc.target
    if (target.mode === 'point') {
      tgx = target.point[0]; tgy = target.point[1]; tgz = target.point[2]
      if (!Number.isFinite(tgx + tgy + tgz)) throw new Error('rune/particles: target point must be three finite numbers')
    } else {
      const mask = target.mask
      imgW = mask.width; imgH = mask.height
      if (!Number.isInteger(imgW) || imgW < 1 || imgW > 65535 || !Number.isInteger(imgH) || imgH < 1 || imgH > 65535) {
        throw new Error(`rune/particles: target mask must be 1..65535 per side (got ${imgW}×${imgH})`)
      }
      if (mask.data.length < imgW * imgH) {
        throw new Error(`rune/particles: target mask data is ${mask.data.length} bytes — the ${imgW}×${imgH} mask needs ${imgW * imgH}`)
      }
      if (!Number.isFinite(target.width) || target.width <= 0 || !Number.isFinite(target.height) || target.height <= 0) {
        throw new Error(`rune/particles: target width/height must be finite > 0 (got ${target.width}×${target.height})`)
      }
      if (!Number.isFinite(target.origin[0] + target.origin[1] + target.origin[2])) {
        throw new Error('rune/particles: target origin must be three finite numbers')
      }
      // The image frame: an orthonormal basis around the target axis with
      // the CORRECT CHIRALITY — viewed from +axis, the mask's x walks RIGHT
      // (u = cross(worldUp, axis)) and the TOP row points UP (v =
      // cross(axis, u)). (A left-handed pick mirrors the text — the bug
      // this shipped with on its first cut: RUNE read as ENUR.)
      let tax = target.axis[0], tay = target.axis[1], taz = target.axis[2]
      const tal = Math.hypot(tax, tay, taz)
      if (tal === 0 || !Number.isFinite(tal)) throw new Error('rune/particles: target axis must be a finite non-zero vector')
      tax /= tal; tay /= tal; taz /= tal
      let utx = taz, uty = 0, utz = -tax // cross(worldUp, axis)
      let utl = Math.hypot(utx, uty, utz)
      if (utl < 1e-6) { utx = 1; uty = 0; utz = 0; utl = 1 } // axis ∥ Y — the fallback keeps u horizontal
      utx /= utl; uty /= utl; utz /= utl
      imgUx = tay * utz - taz * uty; imgUy = taz * utx - tax * utz; imgUz = tax * uty - tay * utx
      imgTx = utx; imgTy = uty; imgTz = utz
      imgOx = target.origin[0]; imgOy = target.origin[1]; imgOz = target.origin[2]
      imgWorldW = target.width; imgWorldH = target.height
      // The lit-pixel index (the cumulated list — uniform sampling = O(1)
      // per particle, deterministic via the hash stream).
      const lit: number[] = []
      const data = mask.data
      for (let y = 0; y < imgH; y++) {
        for (let x = 0; x < imgW; x++) {
          if ((data[y * imgW + x] as number) >= 128) lit.push((y << 16) | x)
        }
      }
      if (lit.length === 0) throw new Error('rune/particles: target mask has no lit pixels (≥ 128) — nothing to seek')
      imgLit = new Uint32Array(lit)
    }
  }

  return function spawner(index, out) {
    // Independent streams per decision — position and velocity stay
    // uncorrelated (a correlated burst visibly "columns").
    const u = hash01(seed, index, S_DIR)
    const v = hash01(seed, index, S_DIR + 100)
    let px = ox, py = oy, pz = oz
    let dx = fx, dy = fy, dz = fz

    if (shape.kind === 'sphere') {
      // A uniform direction on the unit sphere: cosθ = 1 − 2u, φ = τv.
      const z = 1 - 2 * u
      const s = Math.sqrt(Math.max(0, 1 - z * z))
      const phi = TAU * v
      dx = s * Math.cos(phi); dy = s * Math.sin(phi); dz = z
      const r = rMin + (rMax - rMin) * hash01(seed, index, S_P0)
      px = ox + dx * r; py = oy + dy * r; pz = oz + dz * r
    } else if (shape.kind === 'cone') {
      // The velocity lobe: the polar angle FAN-COMPRESSED into the cone
      // (cosθ uniform on [cosHalf, 1] — uniform over the solid angle),
      // φ uniform around the axis.
      const cosHalf = Math.cos(halfAngle)
      const z = 1 - (1 - cosHalf) * u
      const s = Math.sqrt(Math.max(0, 1 - z * z))
      const phi = TAU * v
      dx = ax * z + (t1x * Math.cos(phi) + t2x * Math.sin(phi)) * s
      dy = ay * z + (t1y * Math.cos(phi) + t2y * Math.sin(phi)) * s
      dz = az * z + (t1z * Math.cos(phi) + t2z * Math.sin(phi)) * s
      // The position: a disc in the base plane (√ mapping — area-uniform)
      // + a stretch along the axis. Independent salts (S_P0/1/2).
      const rr = baseRadius * Math.sqrt(hash01(seed, index, S_P0))
      const rphi = TAU * hash01(seed, index, S_P1)
      const stretch = lenMin + (lenMax - lenMin) * hash01(seed, index, S_P2)
      const cx = Math.cos(rphi) * rr, cy = Math.sin(rphi) * rr
      px = ox + t1x * cx + t2x * cy + ax * stretch
      py = oy + t1y * cx + t2y * cy + ay * stretch
      pz = oz + t1z * cx + t2z * cy + az * stretch
    } else if (shape.kind === 'disc') {
      // Uniform in the annulus: r² = rMin² + u·(rMax² − rMin²).
      const r2 = rMin * rMin + (rMax * rMax - rMin * rMin) * u
      const rr = Math.sqrt(r2)
      // Task 117: with arms — the angular coordinate is the arm sector + the
      // radial twist + the uniform scatter (independent salts: S_P0 the arm
      // pick, S_P1 the scatter). Without arms — the uniform annulus as before.
      let phi: number
      if (arms > 0) {
        const arm = Math.floor(hash01(seed, index, S_P0) * arms)
        const scatter = (hash01(seed, index, S_P1) - 0.5) * 2 * armSpread
        const tR = (rr - rMin) / Math.max(1e-6, rMax - rMin)
        phi = arm * (TAU / arms) + twist * tR + scatter
      } else {
        phi = TAU * v
      }
      px = ox + (t1x * Math.cos(phi) + t2x * Math.sin(phi)) * rr
      py = oy + (t1y * Math.cos(phi) + t2y * Math.sin(phi)) * rr
      pz = oz + (t1z * Math.cos(phi) + t2z * Math.sin(phi)) * rr
    } else if (shape.kind === 'hemisphere') {
      // The upper dome around the axis: polar θ ∈ [0, π/2] (cosθ uniform
      // on [0, 1] — the area-correct dome), φ over the arc; r in the band.
      const cosTheta = u // uniform on [0,1] = area-uniform on the dome
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
      const phi = hemArc * v
      const r = rMin + (rMax - rMin) * hash01(seed, index, S_P0)
      dx = ax * cosTheta + (t1x * Math.cos(phi) + t2x * Math.sin(phi)) * sinTheta
      dy = ay * cosTheta + (t1y * Math.cos(phi) + t2y * Math.sin(phi)) * sinTheta
      dz = az * cosTheta + (t1z * Math.cos(phi) + t2z * Math.sin(phi)) * sinTheta
      px = ox + dx * r; py = oy + dy * r; pz = oz + dz * r
    } else if (shape.kind === 'donut') {
      // The torus: a ring of radius `donR` at angle φ (arc-limited), plus a
      // tube circle of radius `tr` around the ring point (ψ uniform).
      const phi = donArc * u
      const tr = tubeMin + (tubeMax - tubeMin) * hash01(seed, index, S_P0)
      const psi = TAU * hash01(seed, index, S_P1)
      const cphi = Math.cos(phi), sphi = Math.sin(phi)
      const cpsi = Math.cos(psi), spsi = Math.sin(psi)
      // The ring's radial direction and the axis — the tube circles in the
      // plane spanned by them: offset = tr·(cosψ·radial + sinψ·axis).
      const rrx = t1x * cphi + t2x * sphi, rry = t1y * cphi + t2y * sphi, rrz = t1z * cphi + t2z * sphi
      px = ox + rrx * (donR + tr * cpsi) + ax * (tr * spsi)
      py = oy + rry * (donR + tr * cpsi) + ay * (tr * spsi)
      pz = oz + rrz * (donR + tr * cpsi) + az * (tr * spsi)
    } else if (shape.kind === 'rectangle') {
      // A plane patch ⊥ axis: u along t1 (width), v along t2 (height),
      // centered at the origin.
      const hx = (u - 0.5) * rectW, hy = (v - 0.5) * rectH
      px = ox + t1x * hx + t2x * hy
      py = oy + t1y * hx + t2y * hy
      pz = oz + t1z * hx + t2z * hy
    } else if (shape.kind === 'grid') {
      // The lattice: 'random' — a hash-picked cell (their GridEmitter);
      // 'lattice' — index → cell, one burst of rows×columns fills it exactly.
      let col: number, row: number
      if (gridLattice) {
        col = index % gridCols
        row = Math.floor(index / gridCols) % gridRows
      } else {
        col = Math.floor(hash01(seed, index, S_P0) * gridCols)
        row = Math.floor(hash01(seed, index, S_P1) * gridRows)
      }
      const gx = ((col + 0.5) / gridCols - 0.5) * gridW
      const gy = ((row + 0.5) / gridRows - 0.5) * gridH
      px = ox + t1x * gx + t2x * gy
      py = oy + t1y * gx + t2y * gy
      pz = oz + t1z * gx + t2z * gy
    } else if (shape.kind === 'line') {
      // Task 130 — the lattice: u = (index % count + 0.5) / count — every
      // station exactly once per `count` particles, gap-free (a cyclic shift
      // of the global stream still covers them all); 'random' keeps the
      // hash draw.
      const lu = lineLattice ? ((index % lineCount) + 0.5) / lineCount : u
      px = ox + (shape.to[0] - ox) * lu
      py = oy + (shape.to[1] - oy) * lu
      pz = oz + (shape.to[2] - oz) * lu
    } else if (shape.kind === 'path') {
      // Task 126 — the polyline: 'lattice' maps the call index onto segments
      // (a cyclic shift of the global stream still covers ALL segments in
      // one burst of `segments` particles); 'random' hash-picks one. The
      // position lerps along the chosen segment, 'axis' velocity points
      // along the LOCAL segment (the jagged bolt reads as a bolt), and the
      // scatter jitters in the segment's precomputed perpendicular plane.
      let seg: number
      if (pathLattice) seg = ((index % pathSegs) + pathSegs) % pathSegs
      else seg = Math.min(pathSegs - 1, Math.floor(hash01(seed, index, S_PATH0) * pathSegs))
      const b = seg * 3
      const t = hash01(seed, index, S_PATH1)
      px = pathPts![b] + (pathPts![b + 3] - pathPts![b]) * t
      py = pathPts![b + 1] + (pathPts![b + 4] - pathPts![b + 1]) * t
      pz = pathPts![b + 2] + (pathPts![b + 5] - pathPts![b + 2]) * t
      if (velocity.mode === 'axis') {
        dx = pathDirs![b]; dy = pathDirs![b + 1]; dz = pathDirs![b + 2]
      }
      if (pathScatter > 0) {
        const pb = seg * 6
        const rr = pathScatter * Math.sqrt(hash01(seed, index, S_PATH2))
        const th = TAU * hash01(seed, index, S_PATH3)
        const cth = Math.cos(th) * rr, sth = Math.sin(th) * rr
        px += pathPerp![pb] * cth + pathPerp![pb + 3] * sth
        py += pathPerp![pb + 1] * cth + pathPerp![pb + 4] * sth
        pz += pathPerp![pb + 2] * cth + pathPerp![pb + 5] * sth
      }
    }

    // The velocity direction by mode.
    if (velocity.mode === 'radial') {
      dx = px - ox; dy = py - oy; dz = pz - oz
      const l = Math.hypot(dx, dy, dz)
      if (l > 1e-12) { dx /= l; dy /= l; dz /= l }
      else {
        // Task 124 — the degenerate case (a particle AT the shape origin: a
        // point burst, or a zero-radius sphere — the point emitter
        // and their ps.json's r=0.0001 sphere): their direction is a UNIFORM
        // RANDOM UNIT-SPHERE vector (theta = u·τ, phi = acos(2v−1)), so the
        // burst SCATTERS in every direction. The old axis fallback produced a
        // single-direction jet (the explosion smoke blow-back bug) — never
        // again. Deterministic: the same (seed, index) pair, the same draw.
        const theta = TAU * hash01(seed, index, S_SCAT0)
        const cphi = 2 * hash01(seed, index, S_SCAT1) - 1
        const sphi = Math.sqrt(Math.max(0, 1 - cphi * cphi))
        dx = sphi * Math.cos(theta)
        dy = sphi * Math.sin(theta)
        dz = cphi
      }
    } else if (velocity.mode === 'axis' && shape.kind !== 'path') {
      dx = ax; dy = ay; dz = az
    } else if (velocity.mode === 'tangential') {
      // cross(axis, radial) normalized: the orbit direction.
      const rx = px - ox, ry = py - oy, rz = pz - oz
      dx = ay * rz - az * ry; dy = az * rx - ax * rz; dz = ax * ry - ay * rx
      const l = Math.hypot(dx, dy, dz)
      if (l > 1e-12) { dx /= l; dy /= l; dz /= l } else { dx = ax; dy = ay; dz = az }
    }
    // 'lobe' (cone) and 'fixed' keep the dx/dy/dz computed above.

    // Task 117: the radial speed modulation — (ref / r)^power over the spawn
    // distance from the shape origin. r is floored at 0.01 (a point/line
    // spawn at the origin with power > 0 would otherwise explode; the emit
    // validation still rejects non-finite results loudly).
    let spd = speed[0] + (speed[1] - speed[0]) * hash01(seed, index, S_SPD)
    if (speedRef > 0) {
      const rdx = px - ox, rdy = py - oy, rdz = pz - oz
      const rad = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz)
      spd *= Math.pow(speedRef / Math.max(rad, 0.01), speedPower)
    }
    // Task 117: the radius-driven color mix (color[0] at the core →
    // color[1] at the rim) — otherwise the per-particle hash.
    let mix = hash01(seed, index, S_COL)
    if (colorByRadius) {
      const rdx = px - ox, rdy = py - oy, rdz = pz - oz
      const rad = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz)
      mix = Math.min(1, Math.max(0, (rad - rMin) / Math.max(1e-6, rMax - rMin)))
    }
    // The seek target (Task 122): an explicit target desc fills it, else
    // NaN (the store defaults NaN → the spawn position — a hold-still
    // particle under `seek`).
    if (imgLit !== null) {
      // The image target: a uniformly-sampled lit pixel, mapped into the
      // world frame (centered; the PIXEL CENTERS, so the mask fills the
      // full world rect; the top row points along +v).
      const lit = imgLit[Math.min(imgLit.length - 1, Math.floor(hash01(seed, index, S_TARGET) * imgLit.length))]
      const mx = ((lit & 0xffff) + 0.5) / imgW - 0.5
      const my = ((lit >>> 16) + 0.5) / imgH - 0.5
      const wx = mx * imgWorldW
      const wy = -my * imgWorldH // the mask's y grows DOWN; the world's v grows UP
      out.tx = imgOx + imgTx * wx + imgUx * wy
      out.ty = imgOy + imgTy * wx + imgUy * wy
      out.tz = imgOz + imgTz * wx + imgUz * wy
    } else if (desc.target !== undefined && desc.target.mode === 'point') {
      out.tx = tgx; out.ty = tgy; out.tz = tgz
    } else {
      out.tx = NaN; out.ty = NaN; out.tz = NaN
    }
    out.x = px; out.y = py; out.z = pz
    out.vx = dx * spd; out.vy = dy * spd; out.vz = dz * spd
    out.life = life[0] + (life[1] - life[0]) * hash01(seed, index, S_LIFE)
    out.size = size[0] + (size[1] - size[0]) * hash01(seed, index, S_SIZE)
    out.r = c0[0] + (c1[0] - c0[0]) * mix
    out.g = c0[1] + (c1[1] - c0[1]) * mix
    out.b = c0[2] + (c1[2] - c0[2]) * mix
    out.a = c0[3] + (c1[3] - c0[3]) * mix
    out.seed = hash01(seed, index, S_SEED)
  }
}

/** A [min, max] range with the min <= max + finiteness validation. */
function rangeOf(range: readonly number[], name: string): [number, number] {
  const min = range[0], max = range[1]
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new Error(`rune/particles: spawner ${name} range must be [min <= max], finite (got [${min}, ${max}])`)
  }
  return [min, max]
}
