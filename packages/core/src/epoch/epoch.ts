// Epoch: a frame counter with a span — frame callbacks see consistent state.
// frame() = batch(): notifications of signals written inside the frame body
// go out ONCE at the outer boundary (§9.11.2). Nested frames are atomic
// relative to the outer one: only the outer boundary raises the index, the
// notification flush happens once — on exit from the outer frame.

import { batch } from '../signal/batch.ts'

export interface EpochHarness {
  /** Current epoch (frame) number — grows at every OUTER boundary. */
  readonly index: number
  /** Increment (outer boundary) + run the frame body inside the epoch. */
  frame<T>(body: () => T): T
}

export function createEpoch(): EpochHarness {
  let index = 0
  let nesting = 0
  return {
    get index() { return index },
    frame<T>(body: () => T): T {
      // Outer boundary: raise the index and run the body inside batch.
      // Nested boundaries do not move the index (atomicity relative to the outer one).
      if (nesting === 0) index++
      nesting++
      try {
        return batch(body)
      } finally {
        nesting--
      }
    },
  }
}
