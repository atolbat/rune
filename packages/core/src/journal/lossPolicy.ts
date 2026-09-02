/**
 * LossPolicy — classification of a GPU context loss + the "recover?" decision.
 *
 * Task (Task 62): not every device loss is worth recovering.
 * Task 65 (soft reset): the decision became THREE-valued — not only "recover
 * or not", but also "HOW MUCH to recover":
 *
 *   • strategy='full' — an ordinary loss (webglcontextlost, device.lost
 *     'destroyed'/'unknown') → replay of the whole journal: resources + content.
 *   • strategy='soft' — out-of-memory → SOFT RESET: a full replay would repeat
 *     the same allocations and crash again, BUT recovery is not "all or nothing".
 *     We restore ONLY the scene's working set (restore(workingSet));
 *     the other resources remain declarations in the journal and return
 *     LAZILY on demand (ensureResident). One texture on screen —
 *     one texture in GPU memory after the reset. If OOM repeats even
 *     on the minimal set — the storm budget fires (abort).
 *   • strategy='abort' — recovery is pointless:
 *     - an ultra-heavy shader (the watchdog killed the context): the replay/lazy path
 *       would still recompile the same shader on the first draw;
 *     - a loss storm (N within an M ms window): the system has degraded.
 *
 * The decision is made by decideRecovery(event, history) — a pure stateless
 * function; the storm window is counted by createLossBudget().
 *
 * Integration: the application listens to real events (canvas 'webglcontextlost',
 * device.lost, uncapturederror with GPUOutOfMemoryError) → builds a LossEvent →
 * decideRecovery → recover ? the replay path (full/soft by strategy) : the fatal path.
 */

/** Loss class. */
export type LossKind =
  | 'context-lost'      // WebGL2: webglcontextlost (ordinary, recoverable)
  | 'device-destroyed'  // WebGPU: device.lost reason='destroyed' (expected: we destroyed it ourselves on switch)
  | 'device-unknown'    // WebGPU: device.lost reason='unknown' (driver/OS/reset)
  | 'out-of-memory'     // GL_OUT_OF_MEMORY / GPUOutOfMemoryError — allocations will not survive
  | 'shader-compile'    // the context was killed by compiling an ultra-heavy shader (watchdog)
  | 'loss-storm'        // too many losses within a short window
  | 'unknown'

export type LossBackend = 'webgl2' | 'webgpu'

/** A loss fact. at — epoch ms (Date.now()). */
export interface LossEvent {
  readonly kind: LossKind
  readonly backend: LossBackend
  readonly detail?: string
  readonly at: number
}

/** Recovery strategy (Task 65).
 *  full — replay of the whole journal; soft — only the scene's working set
 *  (the rest lazily via ensureResident); abort — do not recover. */
export type RecoveryStrategy = 'full' | 'soft' | 'abort'

/** The verdict: whether to recover the context/device and how exactly. */
export interface LossDecision {
  /** false ONLY for strategy='abort'. Equivalent to strategy !== 'abort'. */
  readonly recover: boolean
  /** How to recover (full/soft) or refusal (abort). */
  readonly strategy: RecoveryStrategy
  readonly kind: LossKind
  readonly message: string
}

/** Storm threshold: this many losses within the window → loss-storm. */
export const LOSS_STORM_WINDOW_MS = 10_000
export const LOSS_STORM_MAX = 3

/**
 * Decide: recover after the loss or go fatal.
 * history — previous losses (the current one is not passed here).
 */
export function decideRecovery(event: LossEvent, history: readonly LossEvent[] = []): LossDecision {
  // Storm: N losses (including the current one) within the window.
  const recent = [...history, event].filter(e => event.at - e.at <= LOSS_STORM_WINDOW_MS)
  if (recent.length >= LOSS_STORM_MAX) {
    return {
      recover: false,
      strategy: 'abort',
      kind: 'loss-storm',
      message: `Loss storm: ${recent.length} losses within ${LOSS_STORM_WINDOW_MS / 1000} s — ` +
        `the system has degraded (driver/GPU/memory). Recovery would mask the problem and loop forever. ` +
        `We stop rendering; restart the page or free up memory.`,
    }
  }
  switch (event.kind) {
    case 'out-of-memory':
      // Task 65 soft reset: a full replay would repeat the allocations — but we do not
      // need a full one either. We restore ONLY the scene's working set; everything
      // else lives in the journal as declarations and returns lazily
      // (ensureResident). A repeated OOM even on the minimal set will be caught by
      // the storm budget above.
      return {
        recover: true,
        strategy: 'soft',
        kind: event.kind,
        message: 'The context was lost due to a GPU memory shortage (out-of-memory). ' +
          'A full replay would repeat the same allocations — instead we do a SOFT RESET: ' +
          'restoring only the scene working set, the remaining resources ' +
          'stay in the journal and will return to GPU memory lazily on demand ' +
          '(ensureResident). If memory is not enough even for the scene — reduce the size of ' +
          'textures/atlas pages, the number of render targets, or the canvas resolution.',
      }
    case 'shader-compile':
      return {
        recover: false,
        strategy: 'abort',
        kind: event.kind,
        message: 'The context was killed, apparently by compiling an ultra-heavy shader ' +
          '(driver watchdog / overflow). Lazy recovery will not help: ' +
          'the very first draw will recompile the same shader — the loss will repeat. ' +
          'Simplify the shader (fewer instructions/loops/samples) and restart.',
      }
    case 'context-lost':
      return {
        recover: true,
        strategy: 'full',
        kind: event.kind,
        message: 'The WebGL2 context was lost (an ordinary loss). Recovering: a replay of the journal ' +
          'of primary resources will restore textures/targets/views and their content.',
      }
    case 'device-destroyed':
      return {
        recover: true,
        strategy: 'full',
        kind: event.kind,
        message: 'The GPU device was destroyed (expected on backend switch/dispose). ' +
          'Recovering by replaying the journal on the new device.',
      }
    case 'device-unknown':
      return {
        recover: true,
        strategy: 'full',
        kind: event.kind,
        message: 'The GPU device was lost for an unknown reason (driver/OS/reset). ' +
          'We try to recover by replaying the journal; if it repeats, the storm budget will fire.',
      }
    case 'loss-storm':
      return {
        recover: false,
        strategy: 'abort',
        kind: event.kind,
        message: 'Device loss storm. Recovery cancelled.',
      }
    default:
      return {
        recover: true,
        strategy: 'full',
        kind: 'unknown',
        message: 'Device loss of an unknown type. We try to recover by replaying the journal.',
      }
  }
}

/**
 * Storm budget: a sliding window of losses. note() records a loss,
 * storm() answers whether the threshold has been reached. Simpler than carrying history by hand.
 */
export interface LossBudget {
  note(event: LossEvent): void
  storm(): boolean
  events(): readonly LossEvent[]
  /** Reset the window (e.g., after a successful manual recovery
   *  or when a button-triggered simulation must not count as a storm). */
  reset(): void
}

export function createLossBudget(windowMs: number = LOSS_STORM_WINDOW_MS, maxLosses: number = LOSS_STORM_MAX): LossBudget {
  const events: LossEvent[] = []
  return {
    note(event) {
      events.push(event)
      // drop everything outside the window (the window is counted from the last event)
      while (events.length > 0 && event.at - events[0]!.at > windowMs) events.shift()
    },
    storm() {
      return events.length >= maxLosses
    },
    events() {
      return events.slice()
    },
    reset() {
      events.length = 0
    },
  }
}

/**
 * Classification of a WebGPU uncapturederror (GPUUncapturedErrorEvent.error):
 * GPUOutOfMemoryError → 'out-of-memory'; GPUValidationError → 'unknown'
 * (validation — a code bug, not fatal for the device; but if the context is already
 * dead — the caller classifies by device.lost).
 */
export function classifyGpuError(error: unknown): LossKind {
  if (typeof GPUOutOfMemoryError !== 'undefined' && error instanceof GPUOutOfMemoryError) return 'out-of-memory'
  return 'unknown'
}

/** Classification of device.lost (GPUDeviceLostInfo.reason). */
export function classifyDeviceLost(reason: string | undefined): LossKind {
  if (reason === 'destroyed') return 'device-destroyed'
  return 'device-unknown'
}
