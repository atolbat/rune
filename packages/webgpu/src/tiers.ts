/**
 * §8-3 (M4, Contract 4): requestTier — a LADDER of negotiations with the
 * adapter.
 *
 * Before (until Task 101): createRealGPU called adapter.requestDevice() with
 * almost no parameters — the only "negotiation" logic: timestamp-query /
 * float32-filterable / float32-blendable were requested IF the adapter has
 * them, on refusal — a retry without requiredFeatures (see realGPU.ts).
 *
 * Now: the "desktop / mobile / fallback" profiles (§5.3, profile §9.2 —
 * REQUESTED tiers, not hardcoded by userAgent) are run through
 * negotiateDevice():
 *
 *   step 1..k  requestDevice({ requiredFeatures, requiredLimits }) down
 *             a ladder of limits in DESCENDING order (e.g. maxTextureDimension2D
 *             16384 → 8192 → adapter defaults, DESIGN §4: "descends
 *             from 16384 → 8192 on refusal");
 *   step k+1   requestDevice({ requiredFeatures }) — limits not requested;
 *   step k+2   bare requestDevice() — honest fallback (the previous
 *             behavior of createRealGPU as the last step — the contract
 *             is preserved).
 *
 * Every step is written into steps[] (NegotiationStep) — the negotiation
 * trace is visible to the caller (the requestTier demo shows it live).
 *
 * probeContextEviction() — a WebGL-context eviction probe (§7-clarification 2:
 * "not a hardcoded 8, but a measured profile": on Mali it gives 9, on
 * desktop 16+, measurement on Raspberry Pi (Mali Valhall): 18 alive
 * without eviction — the ceiling is set by maxProbes, the environment
 * may keep more).
 * Measurement: we create webgl2 contexts one by one and watch at which
 * one in order the browser kills the OLDEST (kill-oldest). safeMax =
 * evictedAt − 1 (safetyMargin(1)). The context factory is injected —
 * unit tests check the logic without a real GPU.
 *
 * Hygiene (Contract 5, Task 79): the tier does NOT claim features that
 * have no execution path in the engine — the requested feature set stays
 * as before (SOFT_FEATURES), only limits and profile hints change.
 */

/** Tier identifier. */
export type WebGpuTierId = 'desktop' | 'mobile' | 'fallback'

/** Tier request from the caller: a concrete profile or 'auto' (detection). */
export type WebGpuTierRequest = 'auto' | WebGpuTierId

/** Minimal structural adapter type — a real GPUAdapter satisfies it,
 *  unit tests substitute a fake. limits is an informational field
 *  (the ladder does NOT index adapter limits: negotiations happen only
 *  via requestDevice, Contract 4). */
export interface TierAdapter {
  readonly features: { has(name: string): boolean }
  readonly limits?: object
  readonly info?: { vendor?: string; architecture?: string; description?: string }
  requestDevice(descriptor?: GPUDeviceDescriptor): Promise<unknown>
}

/** Profile hints (§9.2): the consumer may NOT follow them — they are not
 *  device limits but engine/application recommendations for this tier. */
export interface TierHints {
  /** Canvas DPR cap (mobile profile: dpr ≤ 2). */
  readonly dprCap: number
  /** Approximate GPU memory budget for textures, MB (mobile: 256). */
  readonly textureBudgetMb: number
  /** Human-readable profile name. */
  readonly label: string
}

/** Ladder of a single limit: values in DESCENDING order. */
export interface TierLimitLadder {
  readonly limit: string
  readonly values: readonly number[]
}

/** Tier specification: limit ladders + profile hints. */
export interface TierSpec {
  readonly id: WebGpuTierId
  readonly limits: readonly TierLimitLadder[]
  readonly hints: TierHints
}

/**
 * Features requested IF the adapter supports them (soft — a refusal is
 * not fatal, the ladder descends to bare requestDevice). The set is not
 * extended by the tier: everything here has an execution path in the
 * engine (Contract 5):
 *   timestamp-query     — GpuTimer (device.createQuerySet timestamp);
 *   float32-filterable  — LINEAR filtering of rgba32float (Task 69);
 *   float32-blendable   — blending 32F targets (Task 81).
 */
export const SOFT_FEATURES: readonly GPUFeatureName[] = [
  'timestamp-query',
  'float32-filterable',
  'float32-blendable',
]

/**
 * Tiers (DESIGN §5.3: desktop / mobile / fallback; §4: descent 16384 → 8192).
 * Ladders specify REQUESTED values: requestDevice raises a limit to the
 * value if the adapter can; if not — reject, and negotiation descends one
 * step. The last step of any ladder is to not request the limit at all
 * (adapter defaults).
 */
export const TIERS: Readonly<Record<WebGpuTierId, TierSpec>> = {
  desktop: {
    id: 'desktop',
    limits: [
      { limit: 'maxTextureDimension2D', values: [16384, 8192] },
      { limit: 'maxBufferSize', values: [1073741824, 268435456] },
    ],
    hints: { dprCap: 3, textureBudgetMb: 1024, label: 'Desktop — full limits' },
  },
  mobile: {
    id: 'mobile',
    limits: [
      { limit: 'maxTextureDimension2D', values: [8192] },
      { limit: 'maxBufferSize', values: [268435456] },
    ],
    hints: { dprCap: 2, textureBudgetMb: 256, label: 'Mobile (§9.2): dpr ≤ 2, budget 256 MB' },
  },
  fallback: {
    id: 'fallback',
    limits: [],
    hints: { dprCap: 1, textureBudgetMb: 64, label: 'Fallback — adapter defaults' },
  },
}

/** Mobile GPU families (adapter.info.architecture) — a "mobile profile"
 *  signal. Dawn names Mali generations by microarchitecture ("valhall",
 *  "bifrost", "midgard", "immortalis" — report from Mali Valhall: vendor
 *  "arm", architecture "valhall"), so the VENDOR "arm" also signals
 *  mobile — ARM's GPU line is only Mali (mobile class). SwiftShader
 *  (software renderer of headless/weak machines) is also conservative in
 *  limits — classified into the mobile tier. UA is NOT used (§5.3:
 *  "requested tiers, not hardcoded by userAgent"). The Apple vendor is
 *  NOT added: iPhone and Mac report the same info — indistinguishable,
 *  so conservative desktop remains. */
const MOBILE_ARCH_RE = /mali|valhall|bifrost|midgard|immortalis|adreno|powervr|xclipse|videocore|swiftshader/i

/** Vendors whose entire GPU line is the mobile class (ARM = Mali). */
const MOBILE_VENDOR_RE = /^arm$/i

/**
 * Tier detection from adapter.info/limits. This is ONLY the default for
 * tier:'auto' — the application can always request a profile explicitly
 * (the main requirement of §5.3). The heuristic is conservative: an
 * unknown adapter = desktop (the ladder will descend on refusal anyway,
 * no loss).
 */
export function detectTier(adapter: { readonly info?: { vendor?: string; architecture?: string; description?: string } }): WebGpuTierId {
  const info = adapter.info
  const arch = info?.architecture ?? ''
  if (MOBILE_ARCH_RE.test(arch)) return 'mobile'
  if (info?.vendor !== undefined && MOBILE_VENDOR_RE.test(info.vendor)) return 'mobile'
  return 'desktop'
}

/** One negotiation step (trace for the application/demo). */
export interface NegotiationStep {
  /** What was tried at this step (human-readable). */
  readonly label: string
  readonly ok: boolean
  readonly error?: string
  /** Limits of this step (for an ok step — the GUARANTEED required limits). */
  readonly requiredLimits?: Readonly<Record<string, number>>
}

/** Negotiation result. */
export interface NegotiatedTier {
  /** What was requested ('auto' is already resolved into a concrete profile). */
  readonly requested: WebGpuTierRequest
  /** What was granted: 'fallback' — only bare requestDevice survived. */
  readonly granted: WebGpuTierId
  readonly device: unknown
  /** Features actually requested from the adapter (soft, filtered by has). */
  readonly requiredFeatures: readonly string[]
  /** Limits of the final successful step (empty — adapter defaults). */
  readonly requiredLimits: Readonly<Record<string, number>>
  /** Full trace: every step + the final ok step. */
  readonly steps: readonly NegotiationStep[]
  readonly hints: TierHints
}

export interface NegotiateDeviceOptions {
  /** Live step callback (the demo highlights steps as negotiations proceed). */
  readonly onStep?: (step: NegotiationStep) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Negotiation ladder: limits in descending order → features only → bare.
 * Returns the GUARANTEED step; if even bare fails — rethrows the
 * original error (the adapter is dead, there is nothing left to bargain).
 *
 * ⚠ Dawn/Chrome: a SUCCESSFUL requestDevice "consumes" the adapter (adapter
 * is "consumed") — one adapter yields one device. Failed ladder attempts
 * do NOT consume the adapter, so the descent within one call works; for
 * REPEATED negotiations request a fresh adapter
 * (navigator.gpu.requestAdapter() again).
 */
export async function negotiateDevice(
  adapter: TierAdapter,
  tier: WebGpuTierRequest,
  options?: NegotiateDeviceOptions,
): Promise<NegotiatedTier> {
  const resolved: WebGpuTierId = tier === 'auto' ? detectTier(adapter) : tier
  const spec = TIERS[resolved]
  // Soft features: request only what the adapter declares (the previous
  // realGPU behavior — preserved as the first step of the ladder). An
  // explicit fallback tier — bare semantics: no features at all (gpuTimer
  // honestly will not be wired).
  const requiredFeatures = resolved === 'fallback'
    ? []
    : SOFT_FEATURES.filter(name => adapter.features.has(name))
  const steps: NegotiationStep[] = []
  const emit = (step: NegotiationStep): void => { steps.push(step); options?.onStep?.(step) }

  // Steps over the limit ladders: index k = "take the k-th value of every
  // ladder" (a short ladder yields its last value). The first step — all
  // maxima, then the descent. Step hints: maxTextureDimension2D.
  const maxLen = Math.max(0, ...spec.limits.map(l => l.values.length))
  for (let k = 0; k < maxLen; k++) {
    const requiredLimits: Record<string, number> = {}
    for (const ladder of spec.limits) {
      requiredLimits[ladder.limit] = ladder.values[Math.min(k, ladder.values.length - 1)]!
    }
    const tex = requiredLimits['maxTextureDimension2D']
    const label = tex === undefined
      ? `${resolved} · limits (step ${k + 1})`
      : `${resolved} · textures ≤ ${tex}px`
    try {
      const device = await adapter.requestDevice({ requiredFeatures, requiredLimits })
      emit({ label, ok: true, requiredLimits })
      return { requested: tier, granted: resolved, device, requiredFeatures, requiredLimits, steps, hints: spec.hints }
    } catch (error) {
      emit({ label, ok: false, error: errorText(error) })
    }
  }

  // Step without limits (adapter defaults) — but with soft features.
  try {
    const device = await adapter.requestDevice({ requiredFeatures })
    emit({ label: `${resolved} · no requiredLimits (adapter defaults)`, ok: true, requiredLimits: {} })
    return { requested: tier, granted: resolved, device, requiredFeatures, requiredLimits: {}, steps, hints: spec.hints }
  } catch (error) {
    emit({ label: `${resolved} · no requiredLimits (adapter defaults)`, ok: false, error: errorText(error) })
  }

  // Bare — the previous final fallback of realGPU (no features: gpuMs honestly null).
  try {
    const device = await adapter.requestDevice()
    emit({ label: 'fallback · bare requestDevice()', ok: true, requiredLimits: {} })
    return { requested: tier, granted: 'fallback', device, requiredFeatures: [], requiredLimits: {}, steps, hints: TIERS.fallback.hints }
  } catch (error) {
    emit({ label: 'fallback · bare requestDevice()', ok: false, error: errorText(error) })
    throw error
  }
}

// ─── WebGL context eviction probe (§7-clarification 2) ───────────────────────

/** Minimal context for the probe (a real WebGL2RenderingContext with
 *  isContextLost() + WEBGL_lose_context satisfies it). */
export interface EvictionContext {
  readonly isLost: boolean
  lose?(): void
}

export interface EvictionProbeOptions {
  /** Hard cap of created contexts (browsers keep ~16; default 24). */
  readonly maxProbes?: number
  /** Pause after creating a context before checking isContextLost, ms
   *  (the browser kills the oldest asynchronously; default 60). */
  readonly settleMs?: number
  /** Context factory — injection for unit tests. null from the factory =
   *  webgl2 unavailable. */
  readonly create?: () => EvictionContext | null
  /** Live callback: the i-th context created (1-based), whether the oldest is alive. */
  readonly onProbe?: (info: { index: number; created: number; oldestLost: boolean }) => void
}

export interface EvictionProbeResult {
  /** At which context in order the oldest died (1-based). null — no
   *  eviction happened within maxProbes (capped=true). */
  readonly evictedAt: number | null
  /** evictedAt − safetyMargin(1): the safe number of simultaneous contexts. */
  readonly safeMax: number | null
  /** How many contexts were created. */
  readonly probed: number
  /** true — reached maxProbes without eviction (lower bound of the measurement). */
  readonly capped: boolean
  /** webgl2 unavailable in the environment. */
  readonly unavailable?: boolean
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The real factory: a 4×4 canvas + a webgl2 context. */
function createWebGL2Context(): EvictionContext | null {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 4
  const gl = canvas.getContext('webgl2')
  if (gl === null) return null
  return gl as unknown as EvictionContext
}

/**
 * Measuring the context eviction threshold (kill-oldest). Creates contexts
 * one by one; after each waits settleMs and checks the oldest. As soon as
 * the oldest is lost — evictedAt = the number of the last created one, all
 * created contexts are released via WEBGL_lose_context (if present).
 */
export async function probeContextEviction(options?: EvictionProbeOptions): Promise<EvictionProbeResult> {
  const maxProbes = options?.maxProbes ?? 24
  const settleMs = options?.settleMs ?? 60
  const create = options?.create ?? createWebGL2Context
  const contexts: EvictionContext[] = []

  const cleanup = (): void => {
    for (const ctx of contexts) {
      try { ctx.lose?.() } catch { /* context already dead */ }
    }
  }

  try {
    for (let index = 1; index <= maxProbes; index++) {
      const ctx = create()
      if (ctx === null) {
        // webgl2 absent entirely: this is an honest "environment without GL" result (not an error).
        if (index === 1) return { evictedAt: null, safeMax: null, probed: 0, capped: false, unavailable: true }
        break
      }
      contexts.push(ctx)
      if (settleMs > 0) await sleep(settleMs)
      const oldestLost = contexts[0]!.isLost
      options?.onProbe?.({ index, created: contexts.length, oldestLost })
      if (oldestLost) {
        // kill-oldest: the oldest died when the index-th context appeared.
        return { evictedAt: index, safeMax: index - 1, probed: contexts.length, capped: false }
      }
    }
    return { evictedAt: null, safeMax: null, probed: contexts.length, capped: true }
  } finally {
    cleanup()
  }
}
