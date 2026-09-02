/**
 * Ping-pong — a double-buffering pattern (Task 112).
 *
 * A useful GPU-simulation pattern, extracted from the FFT ocean into the core
 * (user decision for Task 112: FFT goes to kit, patterns go to core).
 * Users: ocean phase evolution (ping-pong textures), Stockham FFT passes
 * (ping-pong spectrum), post-process chains, feedback effects — everywhere
 * it's "read from one buffer, write to the other, swap them".
 *
 * Semantics:
 *  • current — the one READ from on the current step;
 *  • previous — the one WRITTEN to on the previous step (where to write
 *    is usually decided by the caller via swap());
 *  • swap() — atomically (with a single assignment of each reference) swaps
 *    the pairs and returns the NEW current (handy in a pass loop).
 */

export interface PingPong<A, B = A> {
  /** Current-step buffer (read source). */
  readonly current: A
  /** Previous-step buffer. */
  readonly previous: B
  /** Swap the two; returns the new (post-swap) current. */
  swap(): A
  /** Step index (number of swaps modulo 2): 0 = initial layout,
   *  1 = after the first swap. For parity logic (as in FFT: input/output
   *  depends on the pass number's parity). */
  readonly parity: 0 | 1
}

/** Create a ping-pong pair from two buffers. */
export function createPingPong<A, B = A>(initial: A, other: B): PingPong<A, B> {
  let current: A = initial
  let previous: B = other
  let swaps = 0
  return {
    get current(): A {
      return current
    },
    get previous(): B {
      return previous
    },
    get parity(): 0 | 1 {
      return (swaps & 1) as 0 | 1
    },
    swap(): A {
      const next = previous as unknown as A
      previous = current as unknown as B
      current = next
      swaps++
      return current
    },
  }
}
