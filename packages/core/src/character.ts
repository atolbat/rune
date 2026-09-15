/**
 * character.ts — Task 216 — THE KINEMATIC FIRST-PERSON CHARACTER.
 *
 * A pure-CPU, allocation-free kinematic controller built for the same
 * laws the rest of @rune/core lives by:
 *
 *   · THE GROUND ORACLE CONTRACT — the controller never knows what a
 *     terrain or a box IS. The world answers three questions: the
 *     highest walkable surface below a point (terrain or box tops, with
 *     the surface's own velocity for the MOVER CARRY), the boxes
 *     overlapping an AABB (pushout/ceilings), and a box's six numbers
 *     by id. The demo's oracle mounts the Task-213 spatial kit
 *     (records-built octree) under the terrain sampler (Task 216 prims)
 *     — one source of truth for the renderer, the culler, and the feet.
 *
 *   · TUNNELING-SAFE BY CONSTRUCTION — the ground probe is a RAY
 *     (infinite down), not a swept volume: any platform, however thin,
 *     catches any fall speed in one substep. Ceilings are swept
 *     explicitly on the way up.
 *
 *   · FIXED-SUBSTEP DETERMINISM — step(dt) accumulates and runs whole
 *     fixedDt substeps; the trajectory is a pure function of the input
 *     script (same script → same bits, the gate's own law). The
 *     remainder carries over; a hitch clamps at 64 substeps (never a
 *     spiral of death).
 *
 *   · THE FEEL LAWS (the parkour vocabulary): COYOTE TIME (a jump fired
 *     within `coyoteTime` after walking off an edge still launches),
 *     JUMP BUFFER (a press within `jumpBuffer` before landing fires on
 *     touchdown — a held jump auto-bunnyhops), STEP-UP (a grounded body
 *     meeting only ledges ≤ stepHeight mounts the highest instead of
 *     stopping — staircases, the «сложные объекты», are walkable), and
 *     GROUND GLUE (a grounded body within snapDown of its ground stays
 *     glued walking down gentle slopes — no air-frame stutter).
 *
 *   · AXIS-SEPARATED PUSHOUT — X and Z move independently (each axis
 *     resolves its own overlaps): sliding along a wall IS the
 *     composition of two 1-D clamps, no normals, no solver iterations.
 *
 *   · ZERO STEADY-STATE ALLOCATIONS — the contact object, the id
 *     scratch, and the box scratch are created once at boot and reused
 *     forever (the out-param contract; the store/spatial laws' own
 *     discipline).
 */

/** The character's tuned body + feel (SI units, seconds). */
export interface CharacterSpec {
  /** Horizontal collision half-size (the body is an AABB: radius × height). */
  readonly radius: number
  /** Full body height (the ceiling sweep's extent above the feet). */
  readonly height: number
  /** Target ground speed, m/s. */
  readonly walkSpeed: number
  /** Ground acceleration toward the target, m/s². */
  readonly accelGround: number
  /** Air acceleration (reduced control), m/s². */
  readonly accelAir: number
  /** Gravity, m/s² (positive; applied downward). */
  readonly gravity: number
  /** Launch speed, m/s. */
  readonly jumpSpeed: number
  /** Max ledge the body mounts while grounded, m (the staircase law). */
  readonly stepHeight: number
  /** Post-edge jump grace, s (the coyote law). */
  readonly coyoteTime: number
  /** Pre-landing press grace, s (the buffer law). */
  readonly jumpBuffer: number
  /** Terminal fall speed, m/s. */
  readonly maxFall: number
  /** Ground glue distance when walking down a SLOPE, m; ledges up to
   *  stepHeight also snap down (the staircase descent law). */
  readonly snapDown: number
  /** The physics substep, s (determinism). */
  readonly fixedDt: number
}

/** A ground surface under the feet (terrain or a box top). */
export interface GroundContact {
  /** The surface's height at the probe column. */
  top: number
  /** The box record id when the ground is a box (−1: terrain). */
  mover: number
  /** The surface's own velocity, m/s (the MOVER CARRY; zeros on static). */
  vx: number
  vy: number
  vz: number
}

/**
 * The ground oracle — everything the controller knows about the world.
 * All three questions must be answerable from the SAME data the
 * renderer reads (the one-source-of-truth law).
 */
export interface CharacterWorld {
  /**
   * The highest walkable surface strictly below (x, z, fromY): the
   * terrain's exact-mesh height and every box top in the column, the
   * HIGHEST wins. Returns false when nothing walkable exists below.
   * Writes the contact into `out` (zero allocations).
   */
  groundBelow(x: number, z: number, fromY: number, out: GroundContact): boolean
  /**
   * The boxes overlapping the AABB, ids into `out` (capacity ≥ 64 is
   * the caller's contract). Returns the count.
   */
  boxesIn(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, out: Uint32Array): number
  /**
   * A box's bounds by id: [cx, cy, cz, hx, hy, hz] into `out`. Returns
   * false when the id is no box.
   */
  boxAt(id: number, out: Float64Array): boolean
}

/** One step's input (WORLD-space dir — the camera owns the yaw). */
export interface CharacterInput {
  /** World-space desired dir X (the unit disc clamps the pair). */
  readonly dirX: number
  /** World-space desired dir Z. */
  readonly dirZ: number
  /** Jump held this step (edge-detected internally; a held jump buffers). */
  readonly jumpHeld: boolean
}

/** The controller's mutable state (read by the camera/HUD/gates). */
export interface CharacterState {
  /** FEET position. */
  x: number
  y: number
  z: number
  /** Velocity, m/s. */
  vx: number
  vy: number
  vz: number
  /** On a walkable surface after the last substep. */
  grounded: boolean
  /** The last ground contact (top/mover/velocity) — null in the air. */
  ground: GroundContact | null
  /** The substeps the last step() ran (the determinism readout). */
  stepped: number
  /** The accumulator's remainder, s (the owed fraction of a substep). */
  owed: number
}

export interface Character {
  readonly state: CharacterState
  /** Advances the simulation: whole fixedDt substeps, the rest owed. */
  step(dt: number, input: CharacterInput): void
  /** Places the feet, zeroing the velocity (the respawn hook). */
  teleport(x: number, y: number, z: number): void
}

const EPS = 1e-6
/** The carry probe's upward tolerance: a mover the world stepped BETWEEN
 *  substeps rises INTO the body by ≤ v·dt — the probe must see its top and
 *  the body must ride it (0.1 m at the demo's movers ≈ 12 m/s · dt). */
const CARRY_TOL = 0.1

export function createCharacter(spec: CharacterSpec, world: CharacterWorld, x0: number, y0: number, z0: number): Character {
  // the owned scratch — created once, reused every substep
  const contact: GroundContact = { top: 0, mover: -1, vx: 0, vy: 0, vz: 0 }
  const probe: GroundContact = { top: 0, mover: -1, vx: 0, vy: 0, vz: 0 }
  const ids = new Uint32Array(96)
  const box = new Float64Array(6)
  const state: CharacterState = {
    x: x0, y: y0, z: z0,
    vx: 0, vy: 0, vz: 0,
    grounded: false, ground: null,
    stepped: 0, owed: 0,
  }
  let coyote = 0
  let buffer = 0
  let jumpWasHeld = false

  function land(g: GroundContact): void {
    state.grounded = true
    state.vy = 0
    contact.top = g.top
    contact.mover = g.mover
    contact.vx = g.vx
    contact.vy = g.vy
    contact.vz = g.vz
    state.ground = contact
  }

  function goAir(): void {
    state.grounded = false
    state.ground = null
  }

  /** One axis's move + overlap resolve: the step-up when every obstacle
   *  is a mountable ledge, the 1-D clamp otherwise (the wall law — the
   *  other axis rides untouched, that IS the slide). */
  function moveAxis(axis: 'x' | 'z', delta: number): void {
    if (delta === 0) return
    const r = spec.radius
    if (axis === 'x') state.x += delta
    else state.z += delta
    // the body AABB at the MOVED position; a hair above the feet so the
    // ground being STOOD on (top == feet) never reads as an obstacle
    const y0 = state.y + 1e-4
    const y1 = state.y + spec.height
    const n = world.boxesIn(state.x - r, y0, state.z - r, state.x + r, y1, state.z + r, ids)
    if (n === 0) return
    let stepTop = -Infinity
    let wall = false
    for (let k = 0; k < n; k++) {
      if (!world.boxAt(ids[k]!, box)) continue
      const top = box[1]! + box[4]!
      const rise = top - state.y
      if (state.grounded && rise > EPS && rise <= spec.stepHeight) {
        if (top > stepTop) stepTop = top
      } else {
        wall = true
      }
    }
    if (!wall) {
      if (stepTop > -Infinity) {
        // THE STEP-UP: mount the highest ledge in the way (the staircase)
        state.y = stepTop
        contact.top = stepTop
        contact.mover = -1
        contact.vx = 0; contact.vy = 0; contact.vz = 0
        state.ground = contact
      }
      return
    }
    // THE PUSHOUT: each wall resolves to its NEARER side (the body's
    // position vs the box's center on the moved axis — the minimal exit,
    // NOT the travel direction's face: a body grazing a box's far edge
    // while falling past it must stay, never teleport to the far face).
    // Steps (steppable ledges) are excluded — they are not walls.
    for (let k = 0; k < n; k++) {
      if (!world.boxAt(ids[k]!, box)) continue
      const top = box[1]! + box[4]!
      const rise = top - state.y
      if (state.grounded && rise > EPS && rise <= spec.stepHeight) continue // a step, not a wall
      const c = axis === 'x' ? box[0]! : box[2]!
      const h = axis === 'x' ? box[3]! : box[5]!
      const lo = c - h
      const hi = c + h
      const pos = axis === 'x' ? state.x : state.z
      if (pos + r <= lo || pos - r >= hi) continue // (a same-axis twin the query saw; not penetrating)
      if (pos < c) {
        // exit the LEFT side
        if (axis === 'x') { state.x = lo - r - EPS; if (state.vx > 0) state.vx = 0 }
        else { state.z = lo - r - EPS; if (state.vz > 0) state.vz = 0 }
      } else {
        // exit the RIGHT side
        if (axis === 'x') { state.x = hi + r + EPS; if (state.vx < 0) state.vx = 0 }
        else { state.z = hi + r + EPS; if (state.vz < 0) state.vz = 0 }
      }
    }
  }

  function substep(dt: number, input: CharacterInput): void {
    // ── the timers (coyote counts down from the last grounded substep;
    //    the buffer holds a fresh press) ─────────────────────────────
    coyote = Math.max(0, coyote - dt)
    buffer = Math.max(0, buffer - dt)
    if (input.jumpHeld && !jumpWasHeld) buffer = spec.jumpBuffer
    jumpWasHeld = input.jumpHeld

    // ── the move dir (world-space in; the unit disc clamp keeps
    //    diagonals honest) ───────────────────────────────────────────
    let dx = input.dirX
    let dz = input.dirZ
    const dl = Math.hypot(dx, dz)
    if (dl > 1) { dx /= dl; dz /= dl }
    const wantX = dx * spec.walkSpeed
    const wantZ = dz * spec.walkSpeed

    // ── THE MOVER CARRY: standing on a moving surface, the surface's
    //    displacement rides the body BEFORE the input moves (a platform
    //    is a frame of reference, not a push). The contact is RE-PROBED
    //    fresh every substep — the last land() snapshotted the mover's
    //    velocity a substep ago, and a mover whose velocity CHANGED
    //    (or whose path bent) must carry with its CURRENT numbers, not
    //    the stale ones (the elevator law's own lesson: a stale carry
    //    falls one substep behind, and the platform's top rises above
    //    the probe origin — the body drops off a platform it stands on)
    if (state.grounded && world.groundBelow(state.x, state.z, state.y + CARRY_TOL, probe)) {
      state.x += probe.vx * dt
      state.z += probe.vz * dt
      // the platform may have risen INTO the body between substeps (the
      // world stepped it while the body stood): ride the TOP — max() is a
      // no-op when synced, a snap-up when the platform jumped
      state.y = Math.max(state.y + probe.vy * dt, probe.top)
    }

    // ── horizontal accel: the honest 1-D clamp toward the target ────
    const a = (state.grounded ? spec.accelGround : spec.accelAir) * dt
    state.vx += Math.max(-a, Math.min(a, wantX - state.vx))
    state.vz += Math.max(-a, Math.min(a, wantZ - state.vz))

    // ── gravity + terminal velocity ─────────────────────────────────
    state.vy -= spec.gravity * dt
    if (state.vy < -spec.maxFall) state.vy = -spec.maxFall

    // ── THE JUMP: (grounded ∨ coyote) ∧ buffer — the feel laws ─────
    if (buffer > 0 && (state.grounded || coyote > 0)) {
      state.vy = spec.jumpSpeed
      goAir()
      coyote = 0
      buffer = 0
    }

    // ── THE VERTICAL MOVE ───────────────────────────────────────────
    const feet = state.y
    const newY = feet + state.vy * dt
    if (state.vy <= 0) {
      // DOWN: the ray law — cast from the pre-move feet, the highest
      // top in the column answers; no speed tunnels past anything
      if (world.groundBelow(state.x, state.z, feet + EPS, probe)) {
        const top = probe.top
        if (newY <= top) {
          // LAND (or stay landed): the exact top, zero bounce
          state.y = top
          land(probe)
        } else if (state.grounded && feet - top <= Math.max(spec.stepHeight, spec.snapDown)) {
          // THE GROUND GLUE / STEP-DOWN: a grounded body whose ground
          // dropped by ≤ stepHeight (a staircase step) or ≤ snapDown (a
          // gentle slope) snaps down to it — stairs descend without a
          // bounce per step; a REAL ledge (higher than a step) falls
          state.y = top
          land(probe)
        } else {
          state.y = newY
          goAir()
        }
      } else {
        state.y = newY
        goAir()
      }
    } else {
      // UP: the ceiling sweep — the head into [feet, newY + height]
      const n = world.boxesIn(
        state.x - spec.radius, feet, state.z - spec.radius,
        state.x + spec.radius, newY + spec.height, state.z + spec.radius,
        ids,
      )
      let ceiling = Infinity
      for (let k = 0; k < n; k++) {
        if (!world.boxAt(ids[k]!, box)) continue
        const bottom = box[1]! - box[4]!
        if (bottom >= feet - EPS && bottom < ceiling) ceiling = bottom
      }
      if (newY + spec.height > ceiling) {
        state.y = ceiling - spec.height
        state.vy = 0
        goAir()
      } else {
        state.y = newY
        goAir()
      }
    }

    // ── THE HORIZONTAL MOVE, axis-separated (slide = two 1-D clamps) ──
    moveAxis('x', state.vx * dt)
    moveAxis('z', state.vz * dt)

    // a substep that ENDED grounded arms the coyote clock
    if (state.grounded) coyote = spec.coyoteTime
  }

  return {
    state,
    step(dt: number, input: CharacterInput): void {
      let budget = state.owed + dt
      let ran = 0
      while (budget >= spec.fixedDt - 1e-9 && ran < 64) {
        substep(spec.fixedDt, input)
        budget -= spec.fixedDt
        ran++
      }
      state.owed = ran === 64 ? 0 : budget
      state.stepped = ran
    },
    teleport(x: number, y: number, z: number): void {
      state.x = x; state.y = y; state.z = z
      state.vx = 0; state.vy = 0; state.vz = 0
      state.grounded = false
      state.ground = null
      coyote = 0
      buffer = 0
    },
  }
}
