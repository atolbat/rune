/**
 * Automatic backend selection — a PURE function over facts (hardware + shader coverage).
 * No scenario enums: try order × two predicates → decision.
 *
 * Principle:
 *   candidates = order.filter(b => hardware[b] && shaderCovers(b, specs))
 *   chosen = candidates[0] ?? null
 *
 * BackendDecision — facts (per-backend verdict, per-spec coverage). The message
 * is generated from the facts by a template, without separate "reasons" as enum tags.
 */

import type { TextureHandle } from '@rune/webgl2'

/** A rune backend identifier. */
export type BackendId = 'webgpu' | 'webgl2'

/** Unified DrawSpec: dual-source shaders (optional GLSL + optional WGSL).
 *  Passes are not included — they have a built-in quad, always dual-source. */
export interface AutoDrawSpec {
  /** Spec identifier — for coverage/diagnostics (not used by the compiler). */
  readonly id?: string
  readonly shader: {
    readonly glsl?: { readonly vertex: string; readonly fragment: string }
    readonly wgsl?: string
  }
  /** Attributes: tight data OR a feed binding (data/size + stride/offset/
   *  bufferId + step — Task 75: step='instance' reads a record once per
   *  instance — star quads from the feed). */
  readonly attributes?: Record<string, { readonly data: Float32Array; readonly size: number; readonly stride?: number; readonly offset?: number; readonly bufferId?: number; readonly instance?: boolean; readonly step?: 'vertex' | 'instance' }>
  readonly uniforms?: Record<string, unknown>
  readonly textures?: Record<string, TextureHandle>
  readonly pipeline?: {
    readonly depth?: { readonly test?: 'less' | 'lequal' | 'always'; readonly write?: boolean } | false
    /** Task 75: blending (additive/transparency; premultiplied output). */
    readonly blend?: { readonly src: string; readonly dst: string } | false
    readonly raster?: { readonly cull?: 'none' | 'back' | 'front' }
  }
  readonly count: number
  /** Task 75: instances (signal/number/function) — draw(count, instances):
   *  count = vertices per instance (e.g. 6 = a quad from gl_VertexID/vertex_index),
   *  instances = number of instances (e.g. feed.count — stars). */
  readonly instances?: unknown
}

/** Coverage of a single spec: which shader variants it has. */
export interface SpecCoverage {
  readonly id?: string
  readonly hasGlsl: boolean
  readonly hasWgsl: boolean
}

/** Verdict for a single backend. */
export interface BackendVerdict {
  /** Whether hardware is available: navigator.gpu / canvas.getContext('webgl2'). */
  readonly available: boolean
  /** Whether the specs cover this backend (each has the required variant). */
  readonly covers: boolean
  /** If it failed the filter — the reason as a single line. */
  readonly rejected?: string
}

/** Full decision: who is chosen, who is rejected, why. */
export interface BackendDecision {
  readonly chosen: BackendId | null
  /** One line — for `#reason` / the console. */
  readonly message: string
  readonly verdicts: Record<BackendId, BackendVerdict>
  readonly coverage: readonly SpecCoverage[]
  /** The try order that was filtered against. */
  readonly order: readonly BackendId[]
}

/** Spec coverage (a pure function over the shader). */
export function shaderCoverage(spec: AutoDrawSpec): SpecCoverage {
  const glsl = spec.shader.glsl
  const wgsl = spec.shader.wgsl
  return {
    id: spec.id,
    hasGlsl: !!glsl && !!glsl.vertex && !!glsl.fragment,
    hasWgsl: !!wgsl,
  }
}

/** A backend covers the specs if every one of them has the matching shader. */
function coversBackend(backend: BackendId, coverage: readonly SpecCoverage[]): boolean {
  if (backend === 'webgpu') return coverage.every(c => c.hasWgsl)
  return coverage.every(c => c.hasGlsl)
}

/** Names of specs missing the required variant — for an actionable message. */
function missingSpecs(backend: BackendId, coverage: readonly SpecCoverage[]): string[] {
  const field = backend === 'webgpu' ? 'hasWgsl' : 'hasGlsl'
  const want = backend === 'webgpu' ? 'WGSL' : 'GLSL'
  return coverage
    .filter(c => !c[field])
    .map(c => `"${c.id ?? '<no id>'}" (no ${want})`)
}

interface ResolveInput {
  /** Try order. Default ['webgpu', 'webgl2']. Length 1 = strict (no fallback). */
  readonly order?: readonly BackendId[]
  /** Pre-flight specs for coverage checking. None = hardware filter only. */
  readonly specs?: readonly AutoDrawSpec[]
  /** Hardware facts: who is available. The pure function does not discover them. */
  readonly hardware: { readonly webgpu: boolean; readonly webgl2: boolean }
}

/** Main: choose a backend and collect verdicts. Pure function — no side effects. */
export function resolveBackend(input: ResolveInput): BackendDecision {
  const order = input.order ?? ['webgpu', 'webgl2']
  const specs = input.specs ?? []
  const coverage = specs.map(shaderCoverage)
  const hardware = input.hardware

  // Conflict: a spec without both shader variants is invalid on its own
  const invalid = coverage.filter(c => !c.hasGlsl && !c.hasWgsl)
  if (invalid.length > 0) {
    const names = invalid.map(c => `"${c.id ?? '<no id>'}"`).join(', ')
    return decision(null, order, coverage, hardware, {
      webgpu: { available: hardware.webgpu, covers: false, rejected: `invalid spec: ${names}` },
      webgl2: { available: hardware.webgl2, covers: false, rejected: `invalid spec: ${names}` },
    }, `Invalid spec (neither GLSL nor WGSL): ${names}. Add at least one shader variant.`)
  }

  // Verdicts for each backend
  const verdicts = {
    webgpu: verdictFor('webgpu', hardware.webgpu, coversBackend('webgpu', coverage), coverage),
    webgl2: verdictFor('webgl2', hardware.webgl2, coversBackend('webgl2', coverage), coverage),
  }

  // Filter + first
  const candidates = order.filter(b => verdicts[b].available && verdicts[b].covers)
  const chosen = candidates.length > 0 ? candidates[0] : null

  return decision(chosen, order, coverage, hardware, verdicts, messageFor(chosen, order, verdicts, coverage))
}

function verdictFor(
  backend: BackendId,
  available: boolean,
  covers: boolean,
  coverage: readonly SpecCoverage[],
): BackendVerdict {
  if (!available && !covers) {
    return { available: false, covers, rejected: `no adapter and coverage failed: ${missingSpecs(backend, coverage).join(', ')}` }
  }
  if (!available) {
    return { available: false, covers, rejected: 'no adapter' }
  }
  if (!covers) {
    return { available, covers: false, rejected: `spec has no variant for ${backend === 'webgpu' ? 'WGSL' : 'GLSL'}: ${missingSpecs(backend, coverage).join(', ')}` }
  }
  return { available: true, covers: true }
}

function decision(
  chosen: BackendId | null,
  order: readonly BackendId[],
  coverage: readonly SpecCoverage[],
  hardware: { readonly webgpu: boolean; readonly webgl2: boolean },
  verdicts: Record<BackendId, BackendVerdict>,
  message: string,
): BackendDecision {
  return { chosen, message, verdicts, coverage, order }
}

/** Human-readable backend name — for the message. */
function label(b: BackendId): string {
  return b === 'webgpu' ? 'WebGPU' : 'WebGL2'
}

/** Message template from facts. Not an enum of reasons — generated from verdicts. */
function messageFor(
  chosen: BackendId | null,
  order: readonly BackendId[],
  verdicts: Record<BackendId, BackendVerdict>,
  coverage: readonly SpecCoverage[],
): string {
  // strict: order of length 1
  if (order.length === 1) {
    const only = order[0]
    if (chosen === null) {
      const v = verdicts[only]
      if (!v.available) {
        return `Forced ${label(only)} unavailable: ${v.rejected}. Soften order=${JSON.stringify(['webgpu', 'webgl2'])} to allow fallback.`
      }
      return `Forced ${label(only)} does not cover the specs: ${v.rejected}. Add ${only === 'webgpu' ? 'WGSL' : 'GLSL'} to the specs.`
    }
    return `Forced choice (order=${JSON.stringify(order)})`
  }

  // auto: order of length ≥ 2
  if (chosen !== null) {
    const forcedBy = coverage.filter(c => (chosen === 'webgpu' ? !c.hasGlsl : !c.hasWgsl))
    if (forcedBy.length > 0) {
      const names = forcedBy.map(c => `"${c.id ?? '<no id>'}"`).join(', ')
      const other = order.filter(b => b !== chosen)[0]
      const otherRejected = verdicts[other]?.rejected ?? 'none'
      const missingVariant = chosen === 'webgpu' ? 'GLSL' : 'WGSL'
      return `Chosen ${label(chosen)} — available; specs without ${missingVariant}: ${names} — fallback candidate ${label(other)} rejected (${otherRejected})`
    }
    return `Chosen ${label(chosen)} — available and covers all specs`
  }

  // nobody passed
  const rejections = order.map(b => `${label(b)}: ${verdicts[b].rejected ?? 'unknown'}`).join('; ')
  return `Conflict — no backend from order=${JSON.stringify(order)} passed. Verdicts: ${rejections}`
}
