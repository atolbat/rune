/**
 * @rune/particles — the DEPTH SORT (Task 132): the painter's order for
 * alpha-blended layers.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY: an alpha-blended layer composited in slot order draws a NEAR
 * particle UNDER a FAR one whenever the near one's slot is lower — the
 * classic "the bright impact card shines through the smoke in front of
 * it" artifact. The fix is the painter's algorithm: draw the FAR
 * particles first, the NEAR ones last, and each sprite blends over
 * everything behind it. Additive layers do not need it (the blend is
 * commutative) — sorting them only costs CPU time.
 *
 * Task 141: THE MOVE — the painter's order is the property of every
 * depth-less alpha-blended renderer, not of particles; the SoA body now
 * lives in @rune/core (sort.ts — sortBackToFront). This module is the
 * particles binding: the ParticleFields wrapper (the same public name
 * and contract, zero changes for the callers).
 *
 * THE ORDER: BACK TO FRONT — the key DESCENDING (the farthest particle
 * first). The sorted index list feeds `order` of packInstances() /
 * fillBillboards() (both bakers then emit particles in exactly this
 * order — the soup's quad stream and the instance-record stream get the
 * IDENTICAL sequence, the backend-parity contract).
 *
 * DETERMINISM: the comparator breaks ties by the slot index (a total
 * order), so the sequence is engine-independent — the same store state
 * and camera basis produce the same draw order on every backend, every
 * engine, every run. The sort is in-place on caller-owned scratch
 * (an Int32Array of capacity for the indices, a Float32Array for the
 * keys): ZERO allocations per frame.
 *
 * NOT FOR: the GPU sim tier (the records are packed GPU-side — the CPU
 * has no positions to sort; the facade rejects render.sort + sim:'gpu'
 * loudly) and the trail kind (a ribbon is one continuous strip — the
 * per-particle painter's order does not apply).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { sortBackToFront } from '@rune/core'
import type { ParticleFields } from './system.ts'

/** Sorts the live [0, count) particles BACK TO FRONT (far first) by the
 *  camera-basis forward axis. Writes the descending-depth index sequence
 *  into `indices[0..count)` (caller-owned, at least `count` long — the
 *  facade allocates it at capacity) and returns `count`. Deterministic,
 *  zero allocations (the keys land in the caller's scratch; the sort is
 *  an in-place subarray sort with a total-order comparator). */
export function sortDepthBackToFront(
  fields: ParticleFields,
  count: number,
  forward: readonly number[],
  indices: Int32Array,
  keys: Float32Array,
): number {
  return sortBackToFront(fields.px, fields.py, fields.pz, count, forward, indices, keys)
}
