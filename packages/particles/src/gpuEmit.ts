/**
 * gpuEmit — Task 135 — GPU-SIDE EMISSION: the shared interpretation of a
 * SpawnerDesc for the GPU append pass, plus the JS reference twin (the
 * parity model — the same role simplex3/PERM/GRAD3 play for the forces).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY: the emission was the last CPU-coupled half of the GPU tier's frame
 * (docs/particles-optimization.md's own remaining list — "the hash-RNG
 * append pass"). The CPU walked the full spawner per newborn (215 ns/spawn
 * — 21.5 ms for a 100k one-shot burst) and uploaded the rows; now the
 * KERNEL generates the rows straight into the state store (the same
 * hash01 stream — @rune/core's integer hash, bit-portable to WGSL u32 and
 * GLSL uint), and the CPU keeps ONLY the life scalar per newborn (the
 * death clock of the aging ledger — one hash + one lerp, ~15 ns).
 *
 * THE SUPPORT SURFACE (everything closed-form over flat scalars):
 *   shapes: sphere, cone, disc (incl. the spiral arms), hemisphere, donut,
 *           rectangle, grid ('random'), line ('random')
 *   velocity modes: fixed, radial (incl. the degenerate scatter), axis,
 *           tangential, lobe (cone)
 *   ranges: speed/life/size, the two-color mix, the seed
 * THE LOUD REJECTS (the honest v1 boundary — CPU-tier territory):
 *   the path shape (per-segment data is CPU-side), the 'lattice' modes
 *   (line/grid — their semantics are CALL-local, the GPU window spans
 *   calls), speedByRadius, colorByRadius, the seek target, the runtime
 *   spawner replacement, orient() (the facade's own rejects).
 *
 * THE PARITY CONTRACT: semantic, not bit-exact (the CPU reference runs
 * f64, the shaders f32 — the same class as the sim tier's 1-ULP gates).
 * The JS twin below is the model the raw-device gate compares against
 * (scripts/task135-wgsl-emit.mjs) and the facade's life ledger source.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { hash01 } from '@rune/core'
import type { SpawnerDesc } from './spawn.ts'

// ── the shape/velocity enums (the uniform's u32 discriminants) ─────────────

/** The emit kernel's shape discriminants (the WGSL/GLSL switch values).
 *  `point` is 0 — the identity branch (no shape math; the position IS the
 *  origin — the shader's if-chain naturally falls through). */
export const GPU_EMIT_SHAPE = {
  point: 0, sphere: 1, cone: 2, disc: 3, hemisphere: 4, donut: 5, rectangle: 6, grid: 7, line: 8,
} as const

/** The emit kernel's velocity-mode discriminants. */
export const GPU_EMIT_VEL = {
  fixed: 1, radial: 2, axis: 3, tangential: 4, lobe: 5,
} as const

// ── the RNG salt streams (spawn.ts's own — the hash domain is shared) ──────

/** The decorrelated hash streams (spawn.ts's S_* constants — the GPU twin
 *  MUST draw the same salt per decision or the CPU ledger's life diverges). */
export const GPU_EMIT_SALTS = {
  dir: 1, spd: 2, life: 3, size: 4, col: 5, seed: 6, p0: 7, p1: 8, p2: 9, scat0: 11, scat1: 12,
} as const

const TAU = 6.283185307179586

// ── the WGSL uniform layout (SimParams' emit block — absolute float
//    indices; the GLSL twin has its own packed layout in gpuSimGl.ts) ───────

/** The emit block's base (float index — SimParams' first 36 floats are the
 *  force half; 144 bytes is 16-aligned, a legal vec4 boundary). */
export const GPU_EMIT_BASE = 36

/** The u32 fields of the emit block (their FLOAT indices — write via the
 *  u32 view of the uniform scratch). */
export const GPU_EMIT_U32_FIELDS: Record<
  'emitBase' | 'emitCount' | 'streamBase' | 'emitMask' | 'shapeKind' | 'velMode' | 'seed', number
> = {
  emitBase: 36,
  emitCount: 37,
  streamBase: 38,
  emitMask: 39,
  shapeKind: 40,
  velMode: 41,
  seed: 42,
}

/** The emitMask bit: 1 — the GPU emission is ON (the entry's early-out). */
export const GPU_EMIT_MASK = { on: 1 } as const

/** The vec4 fields of the emit block (their FLOAT base indices — xyz used
 *  unless documented, w padding). */
export const GPU_EMIT_VEC4_FIELDS: Record<
  'shapeOrigin' | 'atOrigin' | 'axis' | 't1' | 't2' | 'fixedDir'
  | 'radius' | 'cone' | 'donut' | 'misc' | 'misc2' | 'lineTo' | 'speed' | 'sizeInherit'
  | 'color0' | 'color1' | 'emitterV', number
> = {
  shapeOrigin: 44,
  atOrigin: 48,   // per-frame (the at() origin)
  axis: 52,
  t1: 56,
  t2: 60,
  fixedDir: 64,
  radius: 68,     // (rMin, rMax, hemArc, donR)
  cone: 72,       // (cosHalf, baseRadius, lenMin, lenMax)
  donut: 76,      // (tubeMin, tubeMax, donArc, arms)
  misc: 80,       // (armSpread, twist, rectW, rectH)
  misc2: 84,      // (gridW, gridH, gridRows, gridCols)
  lineTo: 88,
  speed: 92,      // (speedMin, speedMax, lifeMin, lifeMax)
  sizeInherit: 96, // (sizeMin, sizeMax, inheritK, _)
  color0: 100,
  color1: 104,
  emitterV: 108,  // per-frame (the inherit source)
}

// ── the flat config (ONE interpretation, both orchestrators consume) ───────

/** A SpawnerDesc flattened to the uniform's own shape (validated — the
 *  unsupported constructs threw before this exists). */
export interface GpuEmitConfig {
  readonly shapeKind: number
  readonly velMode: number
  readonly seed: number
  readonly shapeOrigin: readonly number[]
  readonly axis: readonly number[]
  readonly t1: readonly number[]
  readonly t2: readonly number[]
  readonly fixedDir: readonly number[]
  readonly lineTo: readonly number[] | null
  readonly rMin: number
  readonly rMax: number
  readonly hemArc: number
  readonly donR: number
  readonly cosHalf: number
  readonly baseRadius: number
  readonly lenMin: number
  readonly lenMax: number
  readonly tubeMin: number
  readonly tubeMax: number
  readonly donArc: number
  readonly arms: number
  readonly armSpread: number
  readonly twist: number
  readonly rectW: number
  readonly rectH: number
  readonly gridW: number
  readonly gridH: number
  readonly gridRows: number
  readonly gridCols: number
  readonly speedMin: number
  readonly speedMax: number
  readonly lifeMin: number
  readonly lifeMax: number
  readonly sizeMin: number
  readonly sizeMax: number
  readonly color0: readonly number[]
  readonly color1: readonly number[]
}

/** The orthonormal frame around a shape axis (spawn.ts's own construction:
 *  t1 = cross(axis, worldUp) with the ±Y fallback, t2 = cross(axis, t1) —
 *  bit-identical, the GPU gathers in the SAME frame). */
function emitFrame(ax: number, ay: number, az: number): { t1: readonly number[]; t2: readonly number[] } {
  let t1x = -az, t1y = 0, t1z = ax
  let tl = Math.hypot(t1x, t1y, t1z)
  if (tl < 1e-6) { t1x = 1; t1y = 0; t1z = 0; tl = 1 }
  t1x /= tl; t1y /= tl; t1z /= tl
  const t2x = ay * t1z - az * t1y, t2y = az * t1x - ax * t1z, t2z = ax * t1y - ay * t1x
  return { t1: [t1x, t1y, t1z], t2: [t2x, t2y, t2z] }
}

/** Validates + flattens a SpawnerDesc into the GPU emit config. The loud
 *  rejects are the honest v1 boundary (see the module header); the shapes'
 *  own numeric validation already ran in createSpawner — this walk mirrors
 *  the SAME interpretations (the frame, the ranges, the axis). */
export function readGpuEmitConfig(desc: SpawnerDesc): GpuEmitConfig {
  const shape = desc.shape
  const velocity = desc.velocity
  if (shape.kind === 'path') {
    throw new Error('rune/particles: emit:"gpu" rejects the path shape (the per-segment direction/scatter data is CPU-side — take a line or disc emitter, or sim:"cpu")')
  }
  if (shape.kind === 'line' && shape.mode === 'lattice') {
    throw new Error('rune/particles: emit:"gpu" rejects the line lattice (its station mapping is CALL-local — a GPU window spans calls; take the random line, or sim:"cpu")')
  }
  if (shape.kind === 'grid' && shape.mode === 'lattice') {
    throw new Error('rune/particles: emit:"gpu" rejects the grid lattice (its cell mapping is CALL-local — a GPU window spans calls; take the random grid, or sim:"cpu")')
  }
  if (desc.speedByRadius !== undefined) {
    throw new Error('rune/particles: emit:"gpu" rejects speedByRadius (the radial speed modulation stays CPU-side in v1 — emit over a plain speed range, or sim:"cpu")')
  }
  if (desc.colorByRadius === true) {
    throw new Error('rune/particles: emit:"gpu" rejects colorByRadius (the radius-driven mix stays CPU-side in v1 — take the per-particle hash mix, or sim:"cpu")')
  }
  if (desc.target !== undefined) {
    throw new Error('rune/particles: emit:"gpu" rejects the seek target (the seek force is already CPU-tier territory on sim:"gpu")')
  }

  const shapeKind = GPU_EMIT_SHAPE[shape.kind as keyof typeof GPU_EMIT_SHAPE] as number
  const velMode = GPU_EMIT_VEL[velocity.mode as keyof typeof GPU_EMIT_VEL] as number
  if (shapeKind === undefined) {
    throw new Error(`rune/particles: emit:"gpu" — unknown shape kind ${JSON.stringify(shape.kind)}`)
  }
  if (velMode === undefined) {
    throw new Error(`rune/particles: emit:"gpu" — unknown velocity mode ${JSON.stringify(velocity.mode)}`)
  }

  // the shape origin + the axis family (line: from→to; the rest: origin+axis)
  const ox = shape.kind === 'line' ? shape.from[0] : shape.origin[0]
  const oy = shape.kind === 'line' ? shape.from[1] : shape.origin[1]
  const oz = shape.kind === 'line' ? shape.from[2] : shape.origin[2]
  let ax = 0, ay = 0, az = 1
  let lineTo: readonly number[] | null = null
  if (shape.kind === 'line') {
    const vx = shape.to[0] - ox, vy = shape.to[1] - oy, vz = shape.to[2] - oz
    const l = Math.hypot(vx, vy, vz)
    if (l === 0 || !Number.isFinite(l)) {
      throw new Error('rune/particles: emit:"gpu" — the line endpoints must be a finite non-zero vector (createSpawner validated this; a mid-flight desc mutation broke it)')
    }
    ax = vx / l; ay = vy / l; az = vz / l
    lineTo = [shape.to[0], shape.to[1], shape.to[2]]
  } else if (shape.kind === 'cone' || shape.kind === 'disc' || shape.kind === 'hemisphere'
    || shape.kind === 'donut' || shape.kind === 'rectangle' || shape.kind === 'grid') {
    const l = Math.hypot(shape.axis[0], shape.axis[1], shape.axis[2])
    if (l === 0 || !Number.isFinite(l)) {
      throw new Error('rune/particles: emit:"gpu" — the shape axis must be a finite non-zero vector (createSpawner validated this; a mid-flight desc mutation broke it)')
    }
    ax = shape.axis[0] / l; ay = shape.axis[1] / l; az = shape.axis[2] / l
  }
  const { t1, t2 } = emitFrame(ax, ay, az)

  // the fixed direction (the 'fixed' mode's own — normalized)
  let fx = 0, fy = 0, fz = 1
  if (velocity.mode === 'fixed') {
    const l = Math.hypot(velocity.dir[0], velocity.dir[1], velocity.dir[2])
    if (l === 0 || !Number.isFinite(l)) {
      throw new Error('rune/particles: emit:"gpu" — the fixed velocity dir must be finite non-zero (createSpawner validated this; a mid-flight desc mutation broke it)')
    }
    fx = velocity.dir[0] / l; fy = velocity.dir[1] / l; fz = velocity.dir[2] / l
  }

  // the per-shape scalars (zeroed when the shape does not use them — the
  // uniform's shape is constant, the discriminants decide)
  let rMin = 0, rMax = 0, hemArc = TAU, donR = 0
  if (shape.kind === 'sphere' || shape.kind === 'disc' || shape.kind === 'hemisphere') {
    rMin = shape.radius[0]; rMax = shape.radius[1]
  }
  if (shape.kind === 'hemisphere') hemArc = shape.arc ?? TAU
  let cosHalf = 0, baseRadius = 0, lenMin = 0, lenMax = 0
  if (shape.kind === 'cone') {
    cosHalf = Math.cos(shape.halfAngle)
    baseRadius = shape.baseRadius
    lenMin = shape.length[0]; lenMax = shape.length[1]
  }
  let tubeMin = 0, tubeMax = 0, donArc = TAU
  if (shape.kind === 'donut') {
    donR = shape.radius
    tubeMin = shape.tube[0]; tubeMax = shape.tube[1]
    donArc = shape.arc ?? TAU
  }
  let rectW = 0, rectH = 0
  if (shape.kind === 'rectangle') { rectW = shape.width; rectH = shape.height }
  let gridW = 0, gridH = 0, gridRows = 1, gridCols = 1
  if (shape.kind === 'grid') {
    gridW = shape.width; gridH = shape.height
    gridRows = Math.floor(shape.rows); gridCols = Math.floor(shape.columns)
  }
  // the disc's spiral arms (Task 117 — closed-form, GPU-portable)
  let arms = 0, armSpread = 0.35, twist = 0
  if (shape.kind === 'disc' && shape.arms !== undefined) {
    arms = shape.arms
    armSpread = shape.armSpread ?? 0.35
    twist = shape.twist ?? 0
  }

  const c0 = desc.color[0], c1 = desc.color[1]
  return {
    shapeKind, velMode,
    seed: (desc.seed ?? 1) | 0,
    shapeOrigin: [ox, oy, oz],
    axis: [ax, ay, az],
    t1, t2,
    fixedDir: [fx, fy, fz],
    lineTo,
    rMin, rMax, hemArc, donR,
    cosHalf, baseRadius, lenMin, lenMax,
    tubeMin, tubeMax, donArc, arms,
    armSpread, twist,
    rectW, rectH,
    gridW, gridH, gridRows, gridCols,
    speedMin: desc.speed[0], speedMax: desc.speed[1],
    lifeMin: desc.life[0], lifeMax: desc.life[1],
    sizeMin: desc.size[0], sizeMax: desc.size[1],
    color0: [c0[0], c0[1], c0[2], c0[3]],
    color1: [c1[0], c1[1], c1[2], c1[3]],
  }
}

// ── the uniform packer (the static half — one call at attach) ──────────────

/** Packs the config's STATIC half into the sim uniform (the f32 + u32
 *  views of the tier's scratch — the per-frame half — emitBase/emitCount/
 *  streamBase/atOrigin/emitterV — stays with the orchestrator's step()). */
export function gpuEmitPackStatic(f32: Float32Array, u32: Uint32Array, cfg: GpuEmitConfig): void {
  const U = GPU_EMIT_U32_FIELDS
  const V = GPU_EMIT_VEC4_FIELDS
  u32[U.shapeKind] = cfg.shapeKind
  u32[U.velMode] = cfg.velMode
  u32[U.seed] = cfg.seed >>> 0
  u32[U.emitMask] = GPU_EMIT_MASK.on
  f32[V.shapeOrigin] = cfg.shapeOrigin[0]; f32[V.shapeOrigin + 1] = cfg.shapeOrigin[1]; f32[V.shapeOrigin + 2] = cfg.shapeOrigin[2]
  f32[V.axis] = cfg.axis[0]; f32[V.axis + 1] = cfg.axis[1]; f32[V.axis + 2] = cfg.axis[2]
  f32[V.t1] = cfg.t1[0]; f32[V.t1 + 1] = cfg.t1[1]; f32[V.t1 + 2] = cfg.t1[2]
  f32[V.t2] = cfg.t2[0]; f32[V.t2 + 1] = cfg.t2[1]; f32[V.t2 + 2] = cfg.t2[2]
  f32[V.fixedDir] = cfg.fixedDir[0]; f32[V.fixedDir + 1] = cfg.fixedDir[1]; f32[V.fixedDir + 2] = cfg.fixedDir[2]
  f32[V.radius] = cfg.rMin; f32[V.radius + 1] = cfg.rMax; f32[V.radius + 2] = cfg.hemArc; f32[V.radius + 3] = cfg.donR
  f32[V.cone] = cfg.cosHalf; f32[V.cone + 1] = cfg.baseRadius; f32[V.cone + 2] = cfg.lenMin; f32[V.cone + 3] = cfg.lenMax
  f32[V.donut] = cfg.tubeMin; f32[V.donut + 1] = cfg.tubeMax; f32[V.donut + 2] = cfg.donArc; f32[V.donut + 3] = cfg.arms
  f32[V.misc] = cfg.armSpread; f32[V.misc + 1] = cfg.twist; f32[V.misc + 2] = cfg.rectW; f32[V.misc + 3] = cfg.rectH
  f32[V.misc2] = cfg.gridW; f32[V.misc2 + 1] = cfg.gridH; f32[V.misc2 + 2] = cfg.gridRows; f32[V.misc2 + 3] = cfg.gridCols
  if (cfg.lineTo !== null) {
    f32[V.lineTo] = cfg.lineTo[0]; f32[V.lineTo + 1] = cfg.lineTo[1]; f32[V.lineTo + 2] = cfg.lineTo[2]
  }
  f32[V.speed] = cfg.speedMin; f32[V.speed + 1] = cfg.speedMax; f32[V.speed + 2] = cfg.lifeMin; f32[V.speed + 3] = cfg.lifeMax
  f32[V.sizeInherit] = cfg.sizeMin; f32[V.sizeInherit + 1] = cfg.sizeMax
  f32[V.color0] = cfg.color0[0]; f32[V.color0 + 1] = cfg.color0[1]; f32[V.color0 + 2] = cfg.color0[2]; f32[V.color0 + 3] = cfg.color0[3]
  f32[V.color1] = cfg.color1[0]; f32[V.color1 + 1] = cfg.color1[1]; f32[V.color1 + 2] = cfg.color1[2]; f32[V.color1 + 3] = cfg.color1[3]
}

// ── the life twin (the facade's ledger source) ─────────────────────────────

/** The newborn's life — the ONE scalar the CPU ledger keeps (the death
 *  clock). The same hash draw the kernel takes (SALT life=3): the GPU's
 *  f32 lerp may differ by an ULP — a one-frame death jitter at worst,
 *  invisible at life scales ≥ 0.1 s. */
export function gpuEmitLife(cfg: { readonly lifeMin: number; readonly lifeMax: number; readonly seed: number }, globalIndex: number): number {
  return cfg.lifeMin + (cfg.lifeMax - cfg.lifeMin) * hash01(cfg.seed, globalIndex, GPU_EMIT_SALTS.life)
}

// ── the JS reference twin (the parity model — tests + the raw gate) ────────

/** Generates the 17-float state row for window-local index `i` — the JS
 *  twin of the WGSL `emit` entry / the GLSL emit pass (the same hash
 *  draws, the same salt order, the same force of each shape branch — the
 *  model task131's parity gates hold the shader to). Writes into `out`
 *  (17 floats — the FIELD_NAMES row); allocation-free (the caller owns
 *  the scratch). */
export function gpuEmitRowModel(
  cfg: GpuEmitConfig,
  i: number,
  atOrigin: readonly number[],
  emitterV: readonly number[],
  inheritK: number,
  out: Float32Array,
): void {
  const sd = cfg.seed
  const gi = i // the caller passes the HASH index: the window-local i + the window's global stream base
  const u = hash01(sd, gi, GPU_EMIT_SALTS.dir)
  const v = hash01(sd, gi, GPU_EMIT_SALTS.dir + 100)
  let px = cfg.shapeOrigin[0], py = cfg.shapeOrigin[1], pz = cfg.shapeOrigin[2]
  let dx = cfg.fixedDir[0], dy = cfg.fixedDir[1], dz = cfg.fixedDir[2]
  const S = GPU_EMIT_SALTS

  if (cfg.shapeKind === GPU_EMIT_SHAPE.sphere) {
    const z = 1 - 2 * u
    const s = Math.sqrt(Math.max(0, 1 - z * z))
    const phi = TAU * v
    dx = s * Math.cos(phi); dy = s * Math.sin(phi); dz = z
    const r = cfg.rMin + (cfg.rMax - cfg.rMin) * hash01(sd, gi, S.p0)
    px = cfg.shapeOrigin[0] + dx * r; py = cfg.shapeOrigin[1] + dy * r; pz = cfg.shapeOrigin[2] + dz * r
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.cone) {
    const z = 1 - (1 - cfg.cosHalf) * u
    const s = Math.sqrt(Math.max(0, 1 - z * z))
    const phi = TAU * v
    const a = cfg.axis, t1 = cfg.t1, t2 = cfg.t2
    dx = a[0] * z + (t1[0] * Math.cos(phi) + t2[0] * Math.sin(phi)) * s
    dy = a[1] * z + (t1[1] * Math.cos(phi) + t2[1] * Math.sin(phi)) * s
    dz = a[2] * z + (t1[2] * Math.cos(phi) + t2[2] * Math.sin(phi)) * s
    const rr = cfg.baseRadius * Math.sqrt(hash01(sd, gi, S.p0))
    const rphi = TAU * hash01(sd, gi, S.p1)
    const stretch = cfg.lenMin + (cfg.lenMax - cfg.lenMin) * hash01(sd, gi, S.p2)
    const cx = Math.cos(rphi) * rr, cy = Math.sin(rphi) * rr
    px = cfg.shapeOrigin[0] + t1[0] * cx + t2[0] * cy + a[0] * stretch
    py = cfg.shapeOrigin[1] + t1[1] * cx + t2[1] * cy + a[1] * stretch
    pz = cfg.shapeOrigin[2] + t1[2] * cx + t2[2] * cy + a[2] * stretch
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.disc) {
    const r2 = cfg.rMin * cfg.rMin + (cfg.rMax * cfg.rMax - cfg.rMin * cfg.rMin) * u
    const rr = Math.sqrt(r2)
    let phi: number
    if (cfg.arms > 0) {
      const arm = Math.floor(hash01(sd, gi, S.p0) * cfg.arms)
      const scatter = (hash01(sd, gi, S.p1) - 0.5) * 2 * cfg.armSpread
      const tR = (rr - cfg.rMin) / Math.max(1e-6, cfg.rMax - cfg.rMin)
      phi = arm * (TAU / cfg.arms) + cfg.twist * tR + scatter
    } else {
      phi = TAU * v
    }
    const t1 = cfg.t1, t2 = cfg.t2
    px = cfg.shapeOrigin[0] + (t1[0] * Math.cos(phi) + t2[0] * Math.sin(phi)) * rr
    py = cfg.shapeOrigin[1] + (t1[1] * Math.cos(phi) + t2[1] * Math.sin(phi)) * rr
    pz = cfg.shapeOrigin[2] + (t1[2] * Math.cos(phi) + t2[2] * Math.sin(phi)) * rr
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.hemisphere) {
    const cosTheta = u
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
    const phi = cfg.hemArc * v
    const a = cfg.axis, t1 = cfg.t1, t2 = cfg.t2
    dx = a[0] * cosTheta + (t1[0] * Math.cos(phi) + t2[0] * Math.sin(phi)) * sinTheta
    dy = a[1] * cosTheta + (t1[1] * Math.cos(phi) + t2[1] * Math.sin(phi)) * sinTheta
    dz = a[2] * cosTheta + (t1[2] * Math.cos(phi) + t2[2] * Math.sin(phi)) * sinTheta
    const r = cfg.rMin + (cfg.rMax - cfg.rMin) * hash01(sd, gi, S.p0)
    px = cfg.shapeOrigin[0] + dx * r; py = cfg.shapeOrigin[1] + dy * r; pz = cfg.shapeOrigin[2] + dz * r
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.donut) {
    const phi = cfg.donArc * u
    const tr = cfg.tubeMin + (cfg.tubeMax - cfg.tubeMin) * hash01(sd, gi, S.p0)
    const psi = TAU * hash01(sd, gi, S.p1)
    const cphi = Math.cos(phi), sphi = Math.sin(phi)
    const cpsi = Math.cos(psi), spsi = Math.sin(psi)
    const t1 = cfg.t1, t2 = cfg.t2, a = cfg.axis
    const rrx = t1[0] * cphi + t2[0] * sphi, rry = t1[1] * cphi + t2[1] * sphi, rrz = t1[2] * cphi + t2[2] * sphi
    px = cfg.shapeOrigin[0] + rrx * (cfg.donR + tr * cpsi) + a[0] * (tr * spsi)
    py = cfg.shapeOrigin[1] + rry * (cfg.donR + tr * cpsi) + a[1] * (tr * spsi)
    pz = cfg.shapeOrigin[2] + rrz * (cfg.donR + tr * cpsi) + a[2] * (tr * spsi)
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.rectangle) {
    const hx = (u - 0.5) * cfg.rectW, hy = (v - 0.5) * cfg.rectH
    const t1 = cfg.t1, t2 = cfg.t2
    px = cfg.shapeOrigin[0] + t1[0] * hx + t2[0] * hy
    py = cfg.shapeOrigin[1] + t1[1] * hx + t2[1] * hy
    pz = cfg.shapeOrigin[2] + t1[2] * hx + t2[2] * hy
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.grid) {
    const col = Math.floor(hash01(sd, gi, S.p0) * cfg.gridCols)
    const row = Math.floor(hash01(sd, gi, S.p1) * cfg.gridRows)
    const gx = ((col + 0.5) / cfg.gridCols - 0.5) * cfg.gridW
    const gy = ((row + 0.5) / cfg.gridRows - 0.5) * cfg.gridH
    const t1 = cfg.t1, t2 = cfg.t2
    px = cfg.shapeOrigin[0] + t1[0] * gx + t2[0] * gy
    py = cfg.shapeOrigin[1] + t1[1] * gx + t2[1] * gy
    pz = cfg.shapeOrigin[2] + t1[2] * gx + t2[2] * gy
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.line) {
    const lu = u
    const to = cfg.lineTo!
    px = cfg.shapeOrigin[0] + (to[0] - cfg.shapeOrigin[0]) * lu
    py = cfg.shapeOrigin[1] + (to[1] - cfg.shapeOrigin[1]) * lu
    pz = cfg.shapeOrigin[2] + (to[2] - cfg.shapeOrigin[2]) * lu
  }

  // the velocity mode overrides (the radial/tangential work on the SHAPE-LOCAL
  // position — the at() translation is a later step, the CPU's own order)
  if (cfg.velMode === GPU_EMIT_VEL.radial) {
    dx = px - cfg.shapeOrigin[0]; dy = py - cfg.shapeOrigin[1]; dz = pz - cfg.shapeOrigin[2]
    const l = Math.hypot(dx, dy, dz)
    if (l > 1e-12) { dx /= l; dy /= l; dz /= l }
    else {
      const theta = TAU * hash01(sd, gi, S.scat0)
      const cphi = 2 * hash01(sd, gi, S.scat1) - 1
      const sphi = Math.sqrt(Math.max(0, 1 - cphi * cphi))
      dx = sphi * Math.cos(theta)
      dy = sphi * Math.sin(theta)
      dz = cphi
    }
  } else if (cfg.velMode === GPU_EMIT_VEL.axis) {
    // (the CPU guards `shape.kind !== 'path'` — path is rejected here anyway)
    dx = cfg.axis[0]; dy = cfg.axis[1]; dz = cfg.axis[2]
  } else if (cfg.velMode === GPU_EMIT_VEL.tangential) {
    const rx = px - cfg.shapeOrigin[0], ry = py - cfg.shapeOrigin[1], rz = pz - cfg.shapeOrigin[2]
    dx = cfg.axis[1] * rz - cfg.axis[2] * ry
    dy = cfg.axis[2] * rx - cfg.axis[0] * rz
    dz = cfg.axis[0] * ry - cfg.axis[1] * rx
    const l = Math.hypot(dx, dy, dz)
    if (l > 1e-12) { dx /= l; dy /= l; dz /= l } else { dx = cfg.axis[0]; dy = cfg.axis[1]; dz = cfg.axis[2] }
  }
  // 'fixed' (1) and 'lobe' (5): keep the dx the shape branch computed

  const spd = cfg.speedMin + (cfg.speedMax - cfg.speedMin) * hash01(sd, gi, S.spd)
  const mixC = hash01(sd, gi, S.col)
  const life = cfg.lifeMin + (cfg.lifeMax - cfg.lifeMin) * hash01(sd, gi, S.life)
  const size = cfg.sizeMin + (cfg.sizeMax - cfg.sizeMin) * hash01(sd, gi, S.size)
  const seedF = hash01(sd, gi, S.seed)

  const wx = px + atOrigin[0], wy = py + atOrigin[1], wz = pz + atOrigin[2]
  out[0] = wx; out[1] = wy; out[2] = wz
  out[3] = dx * spd + emitterV[0] * inheritK
  out[4] = dy * spd + emitterV[1] * inheritK
  out[5] = dz * spd + emitterV[2] * inheritK
  out[6] = 0 // age — born this frame
  out[7] = life
  out[8] = size
  out[9] = cfg.color0[0] + (cfg.color1[0] - cfg.color0[0]) * mixC
  out[10] = cfg.color0[1] + (cfg.color1[1] - cfg.color0[1]) * mixC
  out[11] = cfg.color0[2] + (cfg.color1[2] - cfg.color0[2]) * mixC
  out[12] = cfg.color0[3] + (cfg.color1[3] - cfg.color0[3]) * mixC
  out[13] = seedF
  out[14] = wx; out[15] = wy; out[16] = wz // tx/ty/tz: no target → the spawn position (the store's NaN mapping)
}
