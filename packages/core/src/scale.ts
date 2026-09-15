/**
 * scale.ts — Task 216 — THE ADAPTIVE RENDER-SCALE GOVERNOR.
 *
 * Mobile-first rendering's honest answer to the unknown GPU: the frame
 * time decides the resolution. A small, pure, engine-free state machine
 * the demo's loop feeds frame times into; it answers which scale level
 * to render at.
 *
 * THE LAWS (the same discipline the frame graph's policy cache lives by
 * — a level change must be a DECISION, never a jitter):
 *
 *   · EMA FIRST — one slow frame is a hitch (GC, a tab switch, the OS),
 *     not a signal: the sample feeds an exponential moving average
 *     (alpha configurable), and the LADDER reads the average only.
 *   · HYSTERESIS — stepping down needs `downNeed` consecutive samples
 *     of the average ABOVE target + downMargin; stepping back up needs
 *     `upNeed` consecutive samples BELOW target − upMargin (the margin
 *     is what keeps the governor from oscillating at the boundary —
 *     the same class of law as the K=3 hysteresis fold).
 *   · COOLDOWN — after any step, `cooldown` seconds must pass before
 *     the next (a step is a surface recreation on the caller's side;
 *     it must not run every frame).
 *   · FLOOR + CEILING — the level index never leaves [0, levels)
 *     (level 0 = the smallest); the caller maps the index to real
 *     resolutions.
 *   · PURE + ALLOCATION-FREE — observe() returns the CURRENT level and
 *     whether it CHANGED this call (the caller recreates the target on
 *     a change, does nothing otherwise); no timers, no callbacks.
 */

/** The governor's tuning. */
export interface ScaleGovernorSpec {
  /** The ladder's SIZE (level 0 = the smallest scale; the caller owns
   *  the actual resolution mapping). ≥ 2. */
  readonly levels: number
  /** The frame-time target, seconds (e.g. 1/60). */
  readonly targetMs: number
  /** The EMA coefficient (0..1; higher = twitchier). Default 0.2. */
  readonly emaAlpha?: number
  /** Consecutive over-budget samples before a step DOWN. Default 8. */
  readonly downNeed?: number
  /** Consecutive under-budget samples before a step UP. Default 30
   *  (climbing back is deliberately harder than falling). */
  readonly upNeed?: number
  /** The over-budget margin (fraction of target). Default 0.15. */
  readonly downMargin?: number
  /** The under-budget margin (fraction of target). Default 0.25. */
  readonly upMargin?: number
  /** Seconds between steps (the surface-recreation cooldown). Default 2. */
  readonly cooldown?: number
  /** The starting level index. Default levels − 1 (the TOP: start
   *  honest, degrade on evidence — never boot degraded). */
  readonly startLevel?: number
}

/** One observe() answer. */
export interface ScaleGovernorSample {
  /** The level index in [0, levels). */
  readonly level: number
  /** TRUE iff the level CHANGED on this very sample (the caller's
   *  recreate-the-target hook). */
  readonly changed: boolean
  /** The current EMA of frame times, seconds (the HUD's honest number). */
  readonly ema: number
  /** The consecutive over-budget streak (the step-down evidence). */
  readonly overStreak: number
  /** The consecutive under-budget streak (the step-up evidence). */
  readonly underStreak: number
  /** Seconds left on the cooldown clock (0 = armed). */
  readonly cooldownLeft: number
}

export interface ScaleGovernor {
  /** Feed one frame time (seconds). Returns the verdict for THAT frame. */
  observe(frameSeconds: number): ScaleGovernorSample
  /** The current verdict without feeding a sample. */
  peek(): ScaleGovernorSample
  /** Force a level (the user's manual quality pick; resets streaks and
   *  arms the cooldown — a manual choice must not be fought at once). */
  setLevel(level: number): void
  /** Simulated time source override for the cooldown clock (tests/gates
   *  inject frame counts; default: a monotonic internal counter of
   *  observed seconds). */
  readonly spec: ScaleGovernorSpec
}

export function createScaleGovernor(spec: ScaleGovernorSpec): ScaleGovernor {
  const levels = Math.max(2, Math.floor(spec.levels))
  const target = spec.targetMs
  const alpha = spec.emaAlpha ?? 0.2
  const downNeed = Math.max(1, spec.downNeed ?? 8)
  const upNeed = Math.max(1, spec.upNeed ?? 30)
  const downMargin = spec.downMargin ?? 0.15
  const upMargin = spec.upMargin ?? 0.25
  const cooldownS = spec.cooldown ?? 2
  let level = Math.min(levels - 1, Math.max(0, Math.floor(spec.startLevel ?? levels - 1)))
  let ema = Number.NaN // seeded by the FIRST sample (a pure streak: the
  // first over-budget frame counts toward downNeed from sample 1 — a
  // target-prior would smear the warmup and blur the sustained law)
  let over = 0
  let under = 0
  let cooldownLeft = 0
  let clock = 0 // the internal second counter (the cooldown's time source)
  let lastDt = 1 / 60

  const verdict = (changed: boolean): ScaleGovernorSample => ({
    level, changed, ema: Number.isFinite(ema) ? ema : target, overStreak: over, underStreak: under, cooldownLeft,
  })

  return {
    spec,
    observe(frameSeconds: number): ScaleGovernorSample {
      if (!(frameSeconds > 0) || !Number.isFinite(frameSeconds)) return verdict(false)
      lastDt = frameSeconds
      clock += frameSeconds
      if (cooldownLeft > 0) cooldownLeft = Math.max(0, cooldownLeft - frameSeconds)
      ema = Number.isFinite(ema) ? ema + (frameSeconds - ema) * alpha : frameSeconds
      // THE STREAK LAW: the counter reads the RAW frame (a slow FRAME
      // counts), the gate reads the EMA (the smoothed confirmation).
      // Counting the EMA alone let a single hitch's DECAY TAIL read as
      // 7 frames of sustained overload and step the ladder down on one
      // GC pause — the exact class of jitter the governor exists to
      // kill; requiring BOTH keeps the hitch law (1 raw over ≠ 8) and
      // the sustained law (8 raw overs, confirmed by the average)
      const raw = frameSeconds
      if (raw > target * (1 + downMargin) && ema > target * (1 + downMargin)) { over++; under = 0 }
      else if (raw < target * (1 - upMargin) && ema < target * (1 - upMargin)) { under++; over = 0 }
      else { over = 0; under = 0 }
      if (cooldownLeft <= 0) {
        if (over >= downNeed && level > 0) {
          level--
          over = 0; under = 0
          cooldownLeft = cooldownS
          return verdict(true)
        }
        if (under >= upNeed && level < levels - 1) {
          level++
          under = 0; over = 0
          cooldownLeft = cooldownS
          return verdict(true)
        }
      }
      return verdict(false)
    },
    peek(): ScaleGovernorSample {
      return verdict(false)
    },
    setLevel(next: number): void {
      level = Math.min(levels - 1, Math.max(0, Math.floor(next)))
      over = 0
      under = 0
      cooldownLeft = cooldownS
      void clock
      void lastDt
    },
  }
}
