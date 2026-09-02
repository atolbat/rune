/**
 * residency — LRU residency policy for GPU resources (Task 66).
 *
 * Closes the last explicit debt of the soft-reset architecture (Task 65):
 * "LRU eviction for resident resources — a separate task". Previously
 * residency was governed only by the scene's working set at loss and by
 * explicit ensureResident — memory pressure BETWEEN losses was not
 * limited in any way: ensureResident in a loop returns textures to GPU memory,
 * and a repeated OOM became a matter of time.
 *
 * Model (catalog §12 #14 pressure→evict, pattern P1 Probe→Gate→Degrade):
 *   • Probe — residencyStats(): the session computes an ESTIMATE of resident-texture
 *     GPU memory (the browser does not let you query actual video memory);
 *   • Gate — budgetBytes: the threshold above which we must degrade;
 *   • Degrade — selectLRUEvictions(): evict the LEAST RECENTLY
 *     USED (LRU) resident textures until the estimate fits
 *     the budget. Eviction = the flip side of ensureResident: the raw resource
 *     is released, but the DECLARATION and CONTENT stay in the journal — the resource
 *     will return via the same code path on demand. Nothing is lost.
 *
 * The unit of accounting is the TEXTURE (views/targets are aliases of its storage, ~0 bytes:
 * a GL "view" is a mip-range record, a WebGPU GPUTextureView is released
 * together with its parent). Evicting a texture drags its resident
 * views/targets along — the SESSION performs this closure (residency.ts only computes).
 *
 * Pure stateless functions: the policy is tested separately from the facades,
 * the session supplies entries (id/bytes/lastUse) and executes the plan.
 */

import { textureFormatBytesPerPixel, type TextureFormat } from './resourceJournal.ts'

export { textureFormatBytesPerPixel }

/** Bytes per pixel by format (Task 67: HDR textures weigh 2×/4× more).
 *  rgba8unorm/canvas → 4; rgba16float → 8; rgba32float → 16. */
function bytesPerPixel(format?: TextureFormat): number {
  return textureFormatBytesPerPixel(format)
}

/** GPU memory estimate of a texture in bytes.
 *  mip-chain: the full row of levels = base × (1 + 1/4 + 1/16 + …) ≈ ×4/3. */
export function estimateTextureBytes(
  width: number,
  height: number,
  mipLevels = 1,
  format?: TextureFormat,
): number {
  const base = width * height * bytesPerPixel(format)
  if (mipLevels <= 1) return base
  const levels = Math.min(mipLevels, 1 + Math.floor(Math.log2(Math.max(width, height))))
  // Σ base/4^i, i=0..levels-1 = base × (1 - 4^-levels) / (1 - 1/4) ≤ base × 4/3
  const sum = base * (1 - Math.pow(4, -levels)) / 0.75
  return Math.ceil(sum)
}

/** A resident texture in LRU accounting (supplied by the session). */
export interface ResidencyEntry {
  /** Stable textureId (< VIEW_ID_BASE). */
  readonly id: number
  /** GPU memory estimate (estimateTextureBytes). */
  readonly bytes: number
  /** Monotonic last-use counter (larger = more recent). */
  readonly lastUse: number
}

/** Eviction plan: whom to free to fit the budget. */
export interface EvictionSelection {
  /** Stable textureIds to evict (LRU first). */
  readonly evictIds: readonly number[]
  /** How many bytes the estimate will free (the sum of the evicted bytes). */
  readonly freedBytes: number
  /** Estimate of the remaining resident memory after applying the plan. */
  readonly residentBytes: number
}

/** Pick LRU victims (a pure function).
 *
 * Invariants:
 *   • pinned entries are NEVER evicted — even if the budget is not met
 *     (the scene's working set is untouchable; exceeding the budget
 *     by pinned entries — the caller's problem, not the policy's);
 *   • only UNpinned entries are evicted, starting from the smallest lastUse;
 *   • stop — as soon as the estimate fits the budget (including "exactly
 *     at the budget": the budget is a ceiling, not a goal);
 *   • an empty budget = evict everything unpinned (a full manual soft reset,
 *     without losing the device);
 *   • entries with bytes=0 (unknown size) count as 0 — they are evicted
 *     by LRU like the rest, but do not move the sum.
 */
export function selectLRUEvictions(
  entries: readonly ResidencyEntry[],
  budgetBytes: number,
  pinned?: ReadonlySet<number>,
): EvictionSelection {
  const pin = pinned ?? new Set<number>()
  const unpinned = entries.filter(e => !pin.has(e.id))
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0)
  if (totalBytes <= budgetBytes) {
    return { evictIds: [], freedBytes: 0, residentBytes: totalBytes }
  }
  // LRU first: the smallest lastUse goes before everyone else. A stable sort
  // by (lastUse, id) — determinism for tests and logs.
  const byLru = [...unpinned].sort((a, b) => (a.lastUse - b.lastUse) || (a.id - b.id))
  const evictIds: number[] = []
  let freed = 0
  for (const e of byLru) {
    if (totalBytes - freed <= budgetBytes) break
    evictIds.push(e.id)
    freed += e.bytes
  }
  return { evictIds, freedBytes: freed, residentBytes: totalBytes - freed }
}

/** Residency stats for diagnostics/UI. */
export interface ResidencyStats {
  /** Resident textures (stable ids), sorted by lastUse asc. */
  readonly textures: readonly {
    readonly id: number
    readonly bytes: number
    readonly lastUse: number
  }[]
  /** Total GPU memory estimate of resident textures. */
  readonly totalBytes: number
  /** Resident views/targets (aliases — not included in bytes). */
  readonly views: readonly number[]
  readonly targets: readonly number[]
}

/** Eviction result (executed by the session; raw calls, WITHOUT journal
 *  ops — declarations and content stay in the journal, the resource will return via
 *  ensureResident by the same code path as live work). */
export interface EvictionReport {
  /** Evicted textures (stable ids, LRU first). */
  readonly textures: readonly number[]
  /** Evicted views (a closure over the evicted textures). */
  readonly views: readonly number[]
  /** Evicted targets (the same). */
  readonly targets: readonly number[]
  /** Estimate of the freed GPU memory. */
  readonly freedBytes: number
  /** Estimate of the remaining resident memory. */
  readonly residentBytes: number
  /** Textures that remain resident (stable ids). */
  readonly residentTextures: readonly number[]
}
