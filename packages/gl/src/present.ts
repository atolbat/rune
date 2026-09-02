// Task 102 (§8-5/§8-6, DESIGN §5.5 + §9.7): present.ts — runtime present paths.
//
// LINEAGE. Bench round 4 (demo/bench-present.html + dist/bench-present.json)
// measured 12 GL + 2 WebGPU frame present paths; DESIGN §5.5 required moving them
// from the bench artifact into the runtime as PathRegistry — PathState (healthy/degraded/
// disabled) was "the only genuinely new" thing in the plan. The Task 97 slice
// (fanout.ts) covered only fan-out; this module is the full machine:
//
//   Decay          — a frame-time window with p50/p95 percentiles and ratio = p95/p50
//                    (§7-clarification 1: the adaptive degradation threshold of Contract 1;
//                    the absolute maxMs remains a ceiling on the application side);
//   PathRegistry   — a registry of paths {requires, run, rank, pressureMax} +
//                    select(caps, pressure, filter): the best healthy path;
//   PathState      — healthy → degraded (ratio ≥ 1.2) → disabled (ratio ≥ 1.5)
//                    from Decay statistics; unavailable — from caps at select;
//                    disabled is not a final verdict: the probation period (Task 105) —
//                    elapsed waiting (5 s → ×2 per relapse, capped
//                    at 60 s) returns a fresh window and healthy to the path (the flapper
//                    is dampened by the ladder; manual disable — forever; samples
//                    are written even to a disabled path — the last-resort statistics
//                    stay live, not frozen).
//
// Task 106 (third round of the Mali field journal):
//   • PRESSURE HYSTERESIS: a slider jittering around pressureMax 0.6 thrashed
//     the multibmp4 ↔ draw2d selection and recreated the viewers 5 times in 4 s
//     (switching canvas modes 2d ↔ bitmaprenderer). Now a path is cut off
//     at pressure > pressureMax and returns only at
//     pressure ≤ pressureMax − pressureHysteresis (0.15) — the "hold the
//     decision" band kills boundary chatter; applyPressure() is the
//     authoritative source of "cut off/returned" events for the journal;
//   • ABSOLUTE SLOWNESS: ratio is blind to a uniformly slow path
//     (a field frame: multi4 p50 70.2 / p95 70.2 · ratio 1.00 — "healthy" at
//     16 fps, because the path was BORN in jank and there is no clean baseline in the window).
//     Now p50 ≥ absoluteMaxMs (50 ms) over minSamples frames — disabling with
//     the reason "absolute slowness": the path consistently fails the frame
//     budget, even if "smooth". Mixed windows (clean p50) are not touched by the absolute —
//     ratio catches those; the probation period cures this verdict too.
//
// CANONICAL REGISTRATIONS (createPresentRegistry, §9.7): ranks are calibrated
// with bench-present.json (SwiftShader): blit 0.026 ms submit / 59.8 wall fps,
// quadcopy 0.032/56.3, direct 0.061/22.5, bitmap 0.239/22.9 (≈ direct!),
// quadpass 0.074/17.4, draw2d 0.146/13.4, multi4 0.179/12. The §9.7 example:
// "on Mali preserve p95/p50 = 3.0 ≫ 1.5 → preserve disabled, the choice goes to
// quadpass or direct" — exactly that is executed by report() + select().
//
// HYGIENE (Contract 5): a path without run is NOT selected (that is "registry
// knowledge" — the renderer/application plugs the implementation in via add(), §9.8: 2 mandatory
// fields requires+run); requires strings are checked against caps.path() === 'supported'
// (environment keys are probed by probeEnvironmentPaths(), Task 102).

import type { Caps } from '@rune/core'
import type { AnyCanvas } from './canvasHelpers.ts'

// ─── Degradation constants (Contract 1, §7-clarification 1) ───────────────────────

/** Disable threshold: degradationRatio = p95/p50 ≥ 1.5 → disabled. */
export const DEGRADATION_RATIO = 1.5
/** Warn threshold: ratio ≥ 1.2 → degraded (the path is still selected last). */
export const DEGRADE_WARN_RATIO = 1.2
/** Statistics window, frames (≈2 s at 60 fps). */
export const DEGRADATION_WINDOW = 120
/** Minimum samples before state transitions (early statistics are noisy). */
export const DEGRADATION_MIN_SAMPLES = 30
/**
 * Probation period (Task 105, Mali field feedback): after this many ms a
 * disabled path gets a re-probe — Decay is reset, status →
 * healthy, selection may return to it. The reason "cut off under the same
 * settings" (waited for a manual reset()): temporary jank/thermals killed the path
 * FOREVER, even though the environment had long since normalized. Manual disable() is the exception:
 * the operator's decision is not challenged by auto-recovery.
 */
export const DEGRADATION_RECOVERY_MS = 5000
/** Every repeated disable multiplies the wait (anti-flapper): 5 → 10 → 20 → 40 s… */
export const DEGRADATION_RECOVERY_BACKOFF = 2
/** Cap of the waiting ladder (60 s). */
export const DEGRADATION_RECOVERY_MAX_MS = 60000
/** Noise floor, ms — TWO sides: a p95 below it cannot junk a frame
 * even at 120 Hz, and a SPIKE (p95 − p50) below it — neither (Task 104: a mobile
 * Mali measurement — a live path with p50 6 / p95 7.4 ms gave "ratio 1.23" on scheduler
 * jitter, negligible for the frame budget). Both cases — ratio 1. */
export const DEGRADATION_NOISE_FLOOR_MS = 2
/**
 * Hysteresis of returning from under pressure (Task 106, Mali field journal):
 * cutting off — at pressure > pressureMax, returning to the selection — only at
 * pressure ≤ pressureMax − HYSTERESIS. A slider jittering around the boundary
 * (0.6 ↔ 0.7) previously thrashed the selection and recreated the viewer canvases
 * 5 times in 4 seconds; now in the band [max − hyst, max] the path keeps
 * its previous decision. 0 — the previous instant semantics.
 */
export const PRESSURE_HYSTERESIS = 0.15
/**
 * Absolute p50 ceiling, ms (Task 106): a path whose frame MEDIAN is
 * consistently above this threshold is disabled with "absolute slowness" —
 * the ratio detector is blind to a uniformly slow path (p95/p50 = 1.00 at
 * p50 70 ms — a field multi4 frame, 16 fps "healthy"). Mixed windows
 * (clean p50 + janky p95) are not touched by the absolute — ratio catches those.
 * Infinity — disable the verdict.
 */
export const DEGRADATION_ABSOLUTE_MS = 50

// ─── Decay — a frame-time window with percentiles ──────────────────────────────

export interface DecayStats {
  readonly count: number
  readonly p50: number
  readonly p95: number
  /** p95/p50; p50=0 (timer quantization) → denominator of 1 ms; p95 or a spike
   * (p95 − p50) below the noise floor → 1 (jank is impossible, the ratio is
   * measurement noise, not a path signal). */
  readonly ratio: number
}

export interface DecayWindow {
  push(ms: number): void
  reset(): void
  stats(): DecayStats
}

/**
 * A sliding frame-time window (nearest-rank percentiles). ratio catches
 * degradation RELATIVE to vsync saturation (§4 addendum): a path with stable
 * 12 ms has not degraded, a path with p50 0.2 / p95 0.6 — has degraded, though both
 * are far from the absolute ceiling. Three safeguards against false positives:
 *   1. p95 < noiseFloorMs (default 2 ms) → ratio 1: a spike below the threshold
 *      does not eat a significant share of the frame budget at either 60 or 120 Hz —
 *      such "ratios" measure the timer, not the path (Task 102 experience: SwiftShader
 *      draw2d p50 0.1/p95 0.5 ms → "ratio 5" without any jank);
 *   2. p95 − p50 < noiseFloorMs → ratio 1 (Task 104): the spike DELTA matters
 *      more than the absolute — a path with p50 6 / p95 7.4 ms will not junk a single frame,
 *      "ratio 1.23" on it is scheduler/timer jitter, not degradation
 *      (a Mali measurement: the cascade disabled live paths precisely on this noise);
 *   3. p50 = 0 (the environment's timer is quantized) → denominator of 1 ms.
 * Applications looking for degradation at higher frequencies lower the threshold
 * via createDecayWindow(size, noiseFloorMs) / PathRegistryOptions.
 */
export function createDecayWindow(size = DEGRADATION_WINDOW, noiseFloorMs = DEGRADATION_NOISE_FLOOR_MS): DecayWindow {
  const samples: number[] = []
  return {
    push(ms) {
      samples.push(ms)
      if (samples.length > size) samples.shift()
    },
    reset() {
      samples.length = 0
    },
    stats() {
      const n = samples.length
      if (n === 0) return { count: 0, p50: 0, p95: 0, ratio: 1 }
      const sorted = [...samples].sort((a, b) => a - b)
      const at = (q: number): number => sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))]!
      const p50 = at(0.5)
      const p95 = at(0.95)
      if (p95 < noiseFloorMs) return { count: n, p50, p95, ratio: 1 }
      if (p95 - p50 < noiseFloorMs) return { count: n, p50, p95, ratio: 1 } // spike delta — noise
      const denominator = p50 > 0 ? p50 : 1
      const ratio = p95 > 0 ? p95 / denominator : 1
      return { count: n, p50, p95, ratio }
    },
  }
}

// ─── Path specification and present context ─────────────────────────────────────

/** How presenting is executed; source canvas + viewers (+ injections for GL/WebGPU paths). */
export interface PresentContext {
  /** The frame's source canvas (the renderer's canvas / OffscreenCanvas). */
  readonly source: AnyCanvas
  /** Viewer canvases (for cross-canvas paths). */
  readonly targets: readonly AnyCanvas[]
  /** The source's GL context — for GL-internal paths (blit/quad…). */
  readonly gl?: WebGL2RenderingContext | null
  /** WebGPU device + webgpu canvas context — for wgpu-copy. */
  readonly gpu?: PresentGpu | null
  /** Time (s), if the path needs animation. */
  readonly time?: number
}

/** The minimal WebGPU tail of PresentContext (real device/context fit). */
export interface PresentGpu {
  readonly device: GPUDevice
  readonly context: GPUCanvasContext
}

/** Present one frame. Async paths (createImageBitmap) return a Promise. */
export type PresentRun = (ctx: PresentContext) => void | Promise<void>

/** Path requirements: a caps.path key (or a list — all mandatory) or a predicate. */
export type PresentRequires = string | readonly string[] | ((caps: Caps) => boolean)

export interface PresentPathSpec {
  /** Environment/backend requirements; undefined — always available. */
  readonly requires?: PresentRequires
  /** Present implementation; without run the path is not selected (registry knowledge, §9.8). */
  readonly run?: PresentRun
  /** Preference: lower rank — selected earlier. Default — the order of add(). */
  readonly rank?: number
  /** The path is allowed only at pressure ≤ pressureMax (0..1; default 1). */
  readonly pressureMax?: number
  /** Path family for UI/reports: 'GL' | 'Canvas2D' | 'Bitmap' | 'WebGPU' | … */
  readonly group?: string
  /** The path's quirks (S1/S2/S3 from §9.7) + bench numbers — human-readable. */
  readonly note?: string
}

// ─── PathState ────────────────────────────────────────────────────────────────

export type PresentPathStatus = 'healthy' | 'degraded' | 'disabled' | 'unavailable'

/** A path state snapshot (UI, debug, e2e). */
export interface PresentPathState {
  readonly name: string
  readonly status: PresentPathStatus
  /** Why not healthy: 'requirements: …' | 'degradation: …' | 'manual' | … */
  readonly reason: string | null
  readonly rank: number
  readonly group: string
  readonly note: string | null
  readonly pressureMax: number
  /** The path is held back by the pressure hysteresis (the last select/applyPressure
   * cut it on pressureMax and the pressure has not yet subsided to the return boundary) —
   * an honest source for the "cut by pressure" UI badge (Task 106). */
  readonly pressureCut: boolean
  readonly hasRun: boolean
  readonly p50: number
  readonly p95: number
  readonly ratio: number
  readonly samples: number
}

/** The result of select(). */
export interface PathSelection {
  readonly name: string
  readonly run: PresentRun
  readonly state: PresentPathState
}

export interface SelectOptions {
  /** The application's structural filter: false → the path is skipped (not its scenario). */
  readonly filter?: (name: string) => boolean
  /** Allow selecting paths without run (they are skipped by default). */
  readonly includeRunless?: boolean
  /** Last resort (Task 104): healthy/degraded exhausted → return the BEST
   * disabled path instead of null — presenting matters more than quality (the card honestly
   * shows the disabled status; unavailable and the pressure gate are NOT bypassed —
   * the unavailable will not start working, and the expensive must not be enabled under pressure). */
  readonly lastResort?: boolean
  /** Operator override (force): the pressure gate is NOT applied to the selection
   * (the operator's explicit choice outweighs the application's policy — Task 105), but
   * the hysteresis flags keep updating from the real pressure,
   * so that after the force is lifted the state is not a surprise (Task 106). */
  readonly ignorePressure?: boolean
}

/** An event of the hysteresis pressure gate (applyPressure, Task 106). */
export interface PressureGateTransition {
  readonly name: string
  /** cut — the path is held back (pressure > pressureMax);
   *  returned — returned to the selection (the pressure subsided to the return boundary). */
  readonly to: 'cut' | 'returned'
}

export interface PathRegistryOptions {
  readonly window?: number
  readonly minSamples?: number
  readonly warnRatio?: number
  readonly disableRatio?: number
  /** Decay noise floor, ms (see createDecayWindow). */
  readonly noiseFloorMs?: number
  /**
   * The disabled path's probation period, ms (default 5000). Fires
   * in select() — selection is the heart of the machine: as long as it is called every frame,
   * disabled paths re-arm themselves. Infinity — the previous "disabled
   * forever until reset()" semantics; 0 — an instant probe on every select (the flapper is
   * the caller's responsibility).
   */
  readonly recoveryMs?: number
  /** The wait multiplier per repeated disable (default 2). */
  readonly recoveryBackoff?: number
  /** The waiting ladder cap, ms (default 60 000). */
  readonly recoveryMaxMs?: number
  /** Hysteresis of returning from under pressure (default 0.15; 0 — instant
   * return, the previous semantics). See PRESSURE_HYSTERESIS. */
  readonly pressureHysteresis?: number
  /** Absolute p50 ceiling, ms (default 50; Infinity — disable the
   * "absolute slowness" verdict). See DEGRADATION_ABSOLUTE_MS. */
  readonly absoluteMaxMs?: number
  /** Clock for the recovery ladder (tests); default performance.now(). */
  readonly now?: () => number
  /** Status transition telemetry (log/UI/metrics): called ONLY when
   * a path's status changes — with a full statistics snapshot at the moment of the transition
   * (p50/p95/ratio/samples/reason). The perfect place for a degradation journal. */
  readonly onTransition?: (transition: PathTransition) => void
}

/** A path status transition (for onTransition telemetry). */
export interface PathTransition {
  readonly name: string
  readonly from: PresentPathStatus
  readonly to: PresentPathStatus
  /** A snapshot at the moment AFTER the transition (reason explains "why"). */
  readonly state: PresentPathState
}

export interface PathRegistry {
  /** Register/replace a path (replacement resets the state). §9.8: ≤6 lines. */
  add(name: string, spec: PresentPathSpec): void
  remove(name: string): void
  /** The best healthy path (degraded — when there are no healthy ones; disabled/unavailable — never).
   *  Also — the heart of recovery: every call re-arms disabled paths
   *  that have served their probation period (recoveryMs) and updates the hysteresis
   *  pressure flags from the passed pressure. */
  select(caps: Caps, pressure?: number, options?: SelectOptions): PathSelection | null
  /** The authoritative pressure gate (Task 106): update the pressure flags of all
   *  paths with hysteresis and return the transitions (who is cut off/returned) —
   *  for the journal/UI; select() with the same pressure — idempotent. */
  applyPressure(pressure: number): readonly PressureGateTransition[]
  /** Feed the path's Decay with the real present time, ms (written even to disabled —
   *  live last-resort statistics; the verdict — until the period/reset). */
  report(name: string, frameMs: number): void
  /** Manual disable (an operator-decision override): without a reason — forever,
   *  with a reason — subject to the probation period. */
  disable(name: string, reason?: string): void
  /** Re-arm: reset Decay + status + the probation ladder (all paths or one). */
  reset(name?: string): void
  status(name: string): PresentPathState
  /** All paths by rank. */
  snapshot(): readonly PresentPathState[]
  readonly names: readonly string[]
}

interface Entry {
  name: string
  spec: PresentPathSpec
  rank: number
  status: PresentPathStatus
  reason: string | null
  decay: DecayWindow
  /** The moment (now()) of moving to disabled; null — a manual disable forever. */
  disabledAt: number | null
  /** The current wait until the probation period (grows with repeats). */
  cooldownMs: number
  /** How many probation periods the path has already had (the waiting ladder). */
  probations: number
  /** The path is held back by pressure with hysteresis (Task 106): true while
   *  the pressure has not subsided to pressureMax − pressureHysteresis. */
  pressureCut: boolean
}

function requirementsCheck(spec: PresentPathSpec, caps: Caps): { ok: boolean; reason?: string } {
  const requires = spec.requires
  if (requires === undefined) return { ok: true }
  if (typeof requires === 'function') {
    return requires(caps) ? { ok: true } : { ok: false, reason: 'requires predicate returned false' }
  }
  const keys = typeof requires === 'string' ? [requires] : requires
  const failed = keys.filter(key => caps.path(key) !== 'supported')
  return failed.length === 0
    ? { ok: true }
    : { ok: false, reason: `caps.path(${failed.join(', ')}) ≠ 'supported'` }
}

/** The target's 2d context (HTMLCanvasElement | OffscreenCanvas — both can drawImage). */
function ctx2dOf(canvas: AnyCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null
  if (ctx === null) {
    throw new Error("rune: present — getContext('2d') on the target returned null (the target's context type is already taken). Use a fresh canvas.")
  }
  return ctx
}

function bitmapCtxOf(canvas: AnyCanvas): ImageBitmapRenderingContext {
  const ctx = (canvas as HTMLCanvasElement).getContext('bitmaprenderer') as ImageBitmapRenderingContext | null
  if (ctx === null) {
    throw new Error("rune: present — getContext('bitmaprenderer') on the target returned null (the target's context type is already taken). Use a '2d'-mode path.")
  }
  return ctx
}

function firstTarget(ctx: PresentContext): AnyCanvas {
  const target = ctx.targets[0]
  if (target === undefined) {
    throw new Error('rune: present — PresentContext.targets is empty (at least one viewer is required)')
  }
  return target
}

function oneTarget(ctx: PresentContext): AnyCanvas {
  if (ctx.targets.length > 1) {
    throw new Error(`rune: present — exactly one viewer (got ${ctx.targets.length}): transferFromImageBitmap consumes the ImageBitmap. For N viewers — multibmp4/draw paths.`)
  }
  return firstTarget(ctx)
}

function drawTo2d(source: CanvasImageSource & { readonly width: number; readonly height: number }, target: AnyCanvas): void {
  ctx2dOf(target).drawImage(source, 0, 0, target.width, target.height)
}

// ─── Registry ───────────────────────────────────────────────────────────────────

export function createPathRegistry(options: PathRegistryOptions = {}): PathRegistry {
  const windowSize = options.window ?? DEGRADATION_WINDOW
  const minSamples = options.minSamples ?? DEGRADATION_MIN_SAMPLES
  const warnRatio = options.warnRatio ?? DEGRADE_WARN_RATIO
  const disableRatio = options.disableRatio ?? DEGRADATION_RATIO
  const noiseFloorMs = options.noiseFloorMs ?? DEGRADATION_NOISE_FLOOR_MS
  const onTransition = options.onTransition
  const recoveryMs = options.recoveryMs ?? DEGRADATION_RECOVERY_MS
  const recoveryBackoff = options.recoveryBackoff ?? DEGRADATION_RECOVERY_BACKOFF
  const recoveryMaxMs = options.recoveryMaxMs ?? DEGRADATION_RECOVERY_MAX_MS
  const pressureHysteresis = options.pressureHysteresis ?? PRESSURE_HYSTERESIS
  const absoluteMaxMs = options.absoluteMaxMs ?? DEGRADATION_ABSOLUTE_MS
  const now = options.now ?? (() => performance.now())

  const entries = new Map<string, Entry>()
  let nextDefaultRank = 1000

  /** The hysteresis pressure gate (Task 106): state is part of the path
   * (a sticky flag), the decision changes only outside the band.
   * Returns a transition if the decision changed (null — none). */
  const pressureGate = (entry: Entry, pressure: number): PressureGateTransition | null => {
    const max = entry.spec.pressureMax ?? 1
    const before = entry.pressureCut
    if (pressure > max) entry.pressureCut = true
    else if (pressure <= max - pressureHysteresis) entry.pressureCut = false
    // in the band (max − hyst, max] the decision stays the same — boundary chatter
    // no longer flips the selection back and forth (Mali field journal)
    return before === entry.pressureCut
      ? null
      : { name: entry.name, to: entry.pressureCut ? 'cut' : 'returned' }
  }

  /** The waiting ladder: base × backoff^probations, with a cap. Infinity — forever. */
  const armCooldown = (entry: Entry): void => {
    if (!Number.isFinite(recoveryMs)) {
      entry.cooldownMs = Number.POSITIVE_INFINITY
      return
    }
    entry.cooldownMs = Math.min(recoveryMs * Math.pow(recoveryBackoff, entry.probations), recoveryMaxMs)
  }

  const asState = (entry: Entry): PresentPathState => {
    const stats = entry.decay.stats()
    return {
      name: entry.name,
      status: entry.status,
      reason: entry.reason,
      rank: entry.rank,
      group: entry.spec.group ?? '',
      note: entry.spec.note ?? null,
      pressureMax: entry.spec.pressureMax ?? 1,
      pressureCut: entry.pressureCut,
      hasRun: entry.spec.run !== undefined,
      p50: stats.p50,
      p95: stats.p95,
      ratio: stats.ratio,
      samples: stats.count,
    }
  }

  /** A status change with telemetry: re-setting the same status only
   * updates the reason (e.g. a fresh ratio for degraded) — a non-transition is not an event. */
  const setStatus = (entry: Entry, to: PresentPathStatus, reason: string | null): void => {
    const from = entry.status
    entry.reason = reason
    if (from === to) return
    entry.status = to
    onTransition?.({ name: entry.name, from, to, state: asState(entry) })
  }

  const sorted = (): Entry[] => [...entries.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))

  return {
    add(name, spec) {
      if (name.length === 0) throw new Error('rune: present — path name is empty')
      const rank = spec.rank ?? nextDefaultRank
      if (spec.rank === undefined) nextDefaultRank++
      entries.set(name, {
        name,
        spec,
        rank,
        status: 'healthy',
        reason: null,
        decay: createDecayWindow(windowSize, noiseFloorMs),
        disabledAt: null,
        cooldownMs: recoveryMs,
        probations: 0,
        pressureCut: false,
      })
    },
    remove(name) {
      entries.delete(name)
    },
    select(caps, pressure = 0, options) {
      // −1) Probation period (Task 105): a degradation disable is not a final verdict.
      // A path that has waited out gets a fresh window and healthy: the environment may
      // have normalized (the jank is gone, the thermals released, one tab). Re-degradation
      // returns disabled with a doubled wait — the flapper is dampened by the ladder.
      // A manual disable (disabledAt === null) never comes back to life.
      for (const entry of entries.values()) {
        if (entry.status !== 'disabled' || entry.disabledAt === null) continue
        if (now() - entry.disabledAt < entry.cooldownMs) continue
        const waitedMs = entry.cooldownMs
        entry.probations++
        entry.disabledAt = null
        entry.decay.reset()
        setStatus(entry, 'healthy', `probation period #${entry.probations}: re-probe after ${(waitedMs / 1000).toFixed(waitedMs % 1000 === 0 ? 0 : 1)} s of being disabled (auto-recovery)`)
      }
      // 0) The availability of ALL paths is recomputed from the current caps: a path
      // marked unavailable at the previous select comes back to life after
      // invalidate()/re-probe — and vice versa. The snapshot() remains
      // honest for paths below the selection point.
      for (const entry of entries.values()) {
        const check = requirementsCheck(entry.spec, caps)
        if (!check.ok) {
          setStatus(entry, 'unavailable', `requirements: ${check.reason}`)
        } else if (entry.status === 'unavailable') {
          setStatus(entry, 'healthy', null)
        }
      }
      const eligible = (entry: Entry): boolean =>
        entry.spec.run !== undefined || options?.includeRunless === true
      // The pressure gate is a hysteresis sticky flag (updated above from
      // the real pressure always, even under ignorePressure); ignorePressure
      // (the operator's force) bypasses only APPLYING the gate to the selection.
      for (const entry of entries.values()) pressureGate(entry, pressure)
      const passes = (entry: Entry): boolean =>
        options?.filter?.(entry.name) !== false && (options?.ignorePressure === true || !entry.pressureCut)
      // 1) Two selection passes: first healthy, then degraded (the last
      // chance). disabled/unavailable are never selected.
      for (const allowDegraded of [false, true]) {
        for (const entry of sorted()) {
          if (entry.status === 'disabled' || entry.status === 'unavailable') continue
          if (entry.status === 'degraded' && !allowDegraded) continue
          if (!eligible(entry) || !passes(entry)) continue
          return { name: entry.name, run: entry.spec.run!, state: asState(entry) }
        }
      }
      // 2) Last resort (Task 104): no live paths — the best disabled instead of null.
      // unavailable does not come back to life from repeated selection, and the pressure gate is the
      // application's policy, we do not bypass it. The status in state is honest: the consumer
      // decides whether to show "last resort" or stop.
      if (options?.lastResort === true) {
        for (const entry of sorted()) {
          if (entry.status !== 'disabled') continue
          if (!eligible(entry) || !passes(entry)) continue
          return { name: entry.name, run: entry.spec.run!, state: asState(entry) }
        }
      }
      return null
    },
    applyPressure(pressure) {
      // The authoritative source of pressure events for the journal/UI: the same machine
      // as in select() — a repeated call with the same pressure changes nothing.
      const transitions: PressureGateTransition[] = []
      for (const entry of entries.values()) {
        const transition = pressureGate(entry, pressure)
        if (transition !== null) transitions.push(transition)
      }
      return transitions
    },
    report(name, frameMs) {
      const entry = entries.get(name)
      if (entry === undefined) throw new Error(`rune: present.report — path "${name}" is not registered`)
      // A sample is written EVEN to a disabled path: the last-resort path runs
      // every frame — its card must show LIVE time, not a snapshot
      // of the disable moment (field feedback: "p95 35 ms" for a path running at 0.2 ms).
      // The verdict stays sticky: only the probation period/reset change the status.
      entry.decay.push(frameMs)
      if (entry.status === 'disabled') return
      const stats = entry.decay.stats()
      if (stats.count >= minSamples && stats.ratio >= disableRatio) {
        armCooldown(entry)
        entry.disabledAt = now()
        setStatus(entry, 'disabled', `degradation: p95/p50 = ${stats.ratio.toFixed(2)} ≥ ${disableRatio} (${stats.count} frames)`)
        return
      }
      // Absolute slowness (Task 106): ratio is blind to a uniformly slow
      // path (p95/p50 = 1.00 at p50 70 ms — the path was born in jank, there is no clean
      // baseline in the window). A MEDIAN outside the budget — a verdict regardless of ratio;
      // mixed windows (clean p50) do not get here — ratio above catches them.
      if (stats.count >= minSamples && stats.p50 >= absoluteMaxMs) {
        armCooldown(entry)
        entry.disabledAt = now()
        setStatus(entry, 'disabled', `absolute slowness: p50 ${stats.p50.toFixed(1)} ms ≥ ${absoluteMaxMs} ms (${stats.count} frames) — consistently outside the frame budget`)
        return
      }
      if (stats.count >= minSamples && stats.ratio >= warnRatio) {
        setStatus(entry, 'degraded', `degradation: p95/p50 = ${stats.ratio.toFixed(2)} ≥ ${warnRatio} (warning)`)
        return
      }
      // A full clean window after the probation period — the waiting ladder
      // starts over: sustained health = a clean record.
      if (entry.probations > 0 && stats.count >= windowSize) entry.probations = 0
      setStatus(entry, 'healthy', null)
    },
    disable(name, reason = 'manual') {
      const entry = entries.get(name)
      if (entry === undefined) throw new Error(`rune: present.disable — path "${name}" is not registered`)
      // A manual disable (a call without a reason) — forever: the operator knows better.
      // A disable WITH a reason (an execution error, a renderer decision) — a temporary
      // verdict: the path will get a probation period on the common ladder — the error
      // may have been transient (memory pressure on mobile has passed).
      entry.disabledAt = reason === 'manual' ? null : now()
      armCooldown(entry)
      setStatus(entry, 'disabled', reason)
    },
    reset(name) {
      for (const entry of entries.values()) {
        if (name !== undefined && entry.name !== name) continue
        entry.decay.reset()
        entry.disabledAt = null
        entry.cooldownMs = recoveryMs
        entry.probations = 0
        setStatus(entry, 'healthy', null)
      }
    },
    status(name) {
      const entry = entries.get(name)
      if (entry === undefined) throw new Error(`rune: present.status — path "${name}" is not registered`)
      return asState(entry)
    },
    snapshot() {
      return sorted().map(asState)
    },
    get names() {
      return sorted().map(entry => entry.name)
    },
  }
}

// ─── Canonical registrations (§9.7: 12 GL + 2 WebGPU + degradation steps) ─

/**
 * A registry of canonical present paths (§9.7). Ranks — the SwiftShader bench
 * (bench-present.json): lower rank — cheaper/preferred.
 *
 * GL-internal paths (blit/quadcopy/quadpass/uvremap) are registered WITHOUT run:
 * their execution lives in the renderer (surface/target) — the application plugs in
 * its own implementation via `paths.add(name, { requires, run })` (§9.8, ≤6 lines),
 * keeping the registry's ranks/states. Cross-canvas paths are executed here.
 */
export function createPresentRegistry(options?: PathRegistryOptions): PathRegistry {
  const registry = createPathRegistry(options)

  // The intermediate ½-canvas for draw2d-half — lazy, on the registry's closure.
  let halfBuffer: { canvas: HTMLCanvasElement | OffscreenCanvas; w: number; h: number } | null = null
  const halfCanvas = (w: number, h: number): HTMLCanvasElement | OffscreenCanvas => {
    if (halfBuffer === null || halfBuffer.w !== w || halfBuffer.h !== h) {
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      halfBuffer = { canvas, w, h }
    }
    return halfBuffer.canvas
  }

  registry.add('direct', {
    requires: 'canvas-direct',
    rank: 10,
    group: 'GL',
    run: () => { /* the source is itself a visible canvas — the render is already shown (S3: premultiplied) */ },
    note: 'render straight into the visible canvas, zero copies (bench: 0.061 ms submit / 22.5 fps). S3: context premultiplied hygiene',
  })
  registry.add('wgpu-direct', {
    requires: 'WebGPU',
    rank: 15,
    group: 'WebGPU',
    run: () => { /* the pass writes straight into the webgpu canvas texture */ },
    note: 'WebGPU: a pass straight into the canvas texture. S1: configure(alphaMode)',
  })
  registry.add('blit', {
    requires: 'blit',
    rank: 20,
    group: 'GL',
    note: 'gl.blitFramebuffer without a shader — the cheapest (bench: 0.026 ms / 59.8 fps). S1: ANGLE BGRA-mismatch. Execution — the renderer, plug in run via add()',
  })
  registry.add('wgpu-copy', {
    requires: 'WebGPU.copyExternalImage',
    rank: 25,
    group: 'WebGPU',
    run: ctx => {
      const gpu = ctx.gpu
      if (gpu === null || gpu === undefined) {
        throw new Error('rune: present wgpu-copy — PresentContext.gpu is not set (WebGPU device + webgpu canvas context)')
      }
      gpu.device.queue.copyExternalImageToTexture(
        { source: ctx.source },
        { texture: gpu.context.getCurrentTexture() },
        [ctx.source.width, ctx.source.height],
      )
    },
    note: 'queue.copyExternalImageToTexture: an external frame (GL canvas) → webgpu canvas texture. S1: flipY/premultiplied',
  })
  registry.add('quadcopy', {
    requires: 'canvas-direct',
    rank: 30,
    group: 'GL',
    note: 'a texture→texture copy with a sampling shader (bench: 0.032 ms / 56.3 fps). S2: copy shader. Execution — the renderer, plug in run via add()',
  })
  registry.add('quadpass', {
    requires: 'canvas-direct',
    rank: 40,
    group: 'GL',
    note: 'the scene into an FBO texture + a quad pass onto the canvas — the rune path (bench: 0.074 ms / 17.4 fps). S2: pass vert shader. Execution — the renderer, plug in run via add()',
  })
  registry.add('uvremap', {
    requires: 'canvas-direct',
    rank: 45,
    group: 'GL',
    note: 'a quad with UV remapping (an atlas view). S2: UV-remap shader. Execution — the renderer, plug in run via add()',
  })
  registry.add('bitmap', {
    requires: ['OffscreenCanvas', 'transferToImageBitmap', 'bitmaprenderer'],
    rank: 50,
    group: 'Bitmap',
    run: ctx => {
      const target = oneTarget(ctx)
      bitmapCtxOf(target).transferFromImageBitmap((ctx.source as OffscreenCanvas).transferToImageBitmap())
    },
    note: 'transferToImageBitmap → bitmaprenderer, zero CPU copy (bench: 22.9 fps ≈ direct 22.5!). S1: source is an OffscreenCanvas, exactly 1 viewer',
  })
  registry.add('asyncbmp', {
    requires: ['createImageBitmap', 'bitmaprenderer'],
    rank: 55,
    group: 'Bitmap',
    run: async ctx => {
      const target = oneTarget(ctx)
      const bitmap = await createImageBitmap(ctx.source as CanvasImageSource)
      try {
        bitmapCtxOf(target).transferFromImageBitmap(bitmap)
      } finally {
        bitmap.close() // the transferred bitmap is already closed (no-op); on a transfer failure — no leak
      }
    },
    note: 'await createImageBitmap → bitmaprenderer (bench: 15.9 fps). S1: asynchrony, exactly 1 viewer',
  })
  registry.add('multibmp4', {
    requires: ['createImageBitmap', 'bitmaprenderer'],
    rank: 58,
    group: 'Bitmap',
    pressureMax: 0.6,
    run: async ctx => {
      const bitmaps = await Promise.all(ctx.targets.map(() => createImageBitmap(ctx.source as CanvasImageSource)))
      try {
        for (let i = 0; i < ctx.targets.length; i++) {
          bitmapCtxOf(ctx.targets[i]!).transferFromImageBitmap(bitmaps[i]!)
        }
      } finally {
        // the transferred bitmaps are already closed (close on a closed one — no-op);
        // the NOT transferred ones (a failure mid-way) we close by hand — no leak
        for (const bitmap of bitmaps) bitmap.close()
      }
    },
    note: 'N × createImageBitmap in parallel → N bitmaprenderers (multibmp4 bench: 15.5 fps). S1: N bitmaps; pressureMax 0.6 — expensive under pressure',
  })
  registry.add('draw2d', {
    requires: 'Canvas2D',
    rank: 70,
    group: 'Canvas2D',
    run: ctx => {
      drawTo2d(ctx.source, firstTarget(ctx))
    },
    note: 'drawImage source → first viewer (bench: 13.4 fps). S1+S3: Canvas2D branch, alpha channel',
  })
  registry.add('multi4', {
    requires: 'Canvas2D',
    rank: 72,
    group: 'Canvas2D',
    pressureMax: 0.6,
    run: ctx => {
      for (const target of ctx.targets) drawTo2d(ctx.source, target)
    },
    note: 'drawImage × N viewers (multi4 bench: 12 fps — −4 fps for 4 copies). S1: N 2d contexts; pressureMax 0.6',
  })
  registry.add('preserve', {
    requires: ['preserve', 'Canvas2D'],
    rank: 80,
    group: 'Canvas2D',
    run: ctx => {
      drawTo2d(ctx.source, firstTarget(ctx))
    },
    note: 'a hidden GL canvas with preserveDrawingBuffer:true → drawImage (bench: 13.6 fps; Mali: p95/p50 = 3.0 → disabled). S3: premultiplied tax; the source must be created with preserve',
  })
  registry.add('draw2d-half', {
    requires: 'Canvas2D',
    rank: 90,
    group: 'Canvas2D',
    run: ctx => {
      // A degradation step: full frame → intermediate ½ → target.
      // The first copy writes a quarter of the pixels, the second reads a quarter —
      // cheaper than full draw2d on throttled mobile compositors.
      const target = firstTarget(ctx)
      const w = Math.max(1, ctx.source.width >> 1)
      const h = Math.max(1, ctx.source.height >> 1)
      const half = halfCanvas(w, h)
      ctx2dOf(half).drawImage(ctx.source as CanvasImageSource, 0, 0, w, h)
      drawTo2d(half, target)
    },
    note: 'a draw2d degradation step: the frame via an intermediate ½-canvas (a quarter of the pixels). S1: two drawImages',
  })
  registry.add('scaled-half', {
    requires: ['createImageBitmap', 'createImageBitmap.resize'],
    rank: 92,
    group: 'Bitmap',
    run: async ctx => {
      const target = firstTarget(ctx)
      const w = Math.max(1, ctx.source.width >> 1)
      const h = Math.max(1, ctx.source.height >> 1)
      const bitmap = await createImageBitmap(ctx.source as CanvasImageSource, { resizeWidth: w, resizeHeight: h })
      try {
        drawTo2d(bitmap, target)
      } finally {
        bitmap.close()
      }
    },
    note: 'a bitmap degradation step: createImageBitmap with ½ resize → drawImage. S1: resize options',
  })

  return registry
}
