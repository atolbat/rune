// @rune/materials — the variant cache and the facade.
//
// materialOf(desc) is the ONLY hot-path call: a numeric composite key
// (mask + jointCount << 20) into a Map — one integer probe, zero
// allocations, the assembled variant is shared by reference. The first
// request for a combination pays the assembly (microseconds, once).

import { assemble, type AssembledMaterial } from './assemble.ts'
import { SKIN } from './features.ts'

/** What the caller wants from a material. */
export interface MaterialDesc {
  /** A union of feature bits (Feature.SKIN | Feature.LAMBERT | ...). */
  readonly features: number
  /** The skin palette size (required by SKIN; ignored otherwise). */
  readonly jointCount?: number
}

/** Compiled-facing facade: the cached AssembledMaterial. */
export type Material = AssembledMaterial

/** Composite cache key: features × 8192 + jointCount.
 *  (The old `features + (jointCount << 20)` overlapped feature bits ≥ 20 —
 *  the PBR family bits live there now, so EMISSIVE at bit 26 would have
 *  collided with jointCount = 64: same key, different palette size. The
 *  multiplicative form is injective for features < 2^28 and joints < 8192,
 *  and both stay exact in the f64 integer range. assemble() enforces the
 *  joint bound.) */
const KEY_STRIDE = 8192

function keyOf(features: number, jointCount: number): number {
  return features * KEY_STRIDE + jointCount
}

const cache = new Map<number, Material>()

/** The material for a feature combination. The first call assembles and
 *  caches; every subsequent call is a single numeric Map probe.
 *  Throws for invalid combinations (see assemble.ts). */
export function materialOf(desc: MaterialDesc): Material {
  const joints = (desc.features & SKIN) !== 0 ? (desc.jointCount ?? 0) : 0
  const key = keyOf(desc.features, joints)
  const found = cache.get(key)
  if (found !== undefined) return found
  const material = assemble(desc.features, joints)
  cache.set(key, material)
  return material
}

/** Variants assembled so far (diagnostics: how many live combinations). */
export function variantCount(): number {
  return cache.size
}

/** Drops the cache (tests / hot reload of the catalog). */
export function resetMaterials(): void {
  cache.clear()
}
