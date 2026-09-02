/**
 * Transient pool (idea #2 of the early catalog): per-frame temporary data
 * without GC pressure. An array taken in a frame is guaranteed to live `depth`
 * frames (flight depth — like in triple buffering), then it is silently
 * reused. Contents after lease are undefined — this is scratch.
 */

/** Per-frame pool of temporary arrays. */
export interface TransientPool {
  /** Frame start: previous leases start aging. */
  beginFrame(): void
  /** Scratch array for frames (not zeroed). */
  f32(length: number): Float32Array
  f64(length: number): Float64Array
  i32(length: number): Int32Array
  u32(length: number): Uint32Array
  u8(length: number): Uint8Array
  /** Snapshot of counters (tests/diagnostics). */
  stats(): TransientPoolStats
}

/** Pool counters: created total, waiting in the pool, currently leased. */
export interface TransientPoolStats {
  readonly created: number
  readonly pooled: number
  readonly leased: number
  readonly bytes: number
  readonly frames: number
}

type View = Float32Array | Float64Array | Int32Array | Uint32Array | Uint8Array
type Tag = 'f32' | 'f64' | 'i32' | 'u32' | 'u8'

/** Type+length bin: free buffers and leased ones (FIFO by frames). */
interface Bin {
  readonly free: View[]
  readonly leased: Array<{ buf: View; frame: number }>
}

const BYTES: Record<Tag, number> = { f32: 4, f64: 8, i32: 4, u32: 4, u8: 1 }

const MAKE: Record<Tag, (length: number) => View> = {
  f32: length => new Float32Array(length),
  f64: length => new Float64Array(length),
  i32: length => new Int32Array(length),
  u32: length => new Uint32Array(length),
  u8: length => new Uint8Array(length),
}

/** Creates the pool; depth is the minimum buffer lifetime in frames. */
export function createTransientPool(depth = 2): TransientPool {
  const bins = new Map<string, Bin>()
  let created = 0
  let bytes = 0
  let frames = 0

  function beginFrame(): void {
    frames++
  }

  function alloc(tag: Tag, length: number): View {
    const bin = binFor(`${tag}:${length}`)
    reclaim(bin)
    const buf = bin.free.pop() ?? create(tag, length)
    bin.leased.push({ buf, frame: frames })
    return buf
  }

  function binFor(key: string): Bin {
    const found = bins.get(key)
    if (found !== undefined) return found
    const fresh: Bin = { free: [], leased: [] }
    bins.set(key, fresh)
    return fresh
  }

  /** Leased buffers that have lived depth frames are returned to free. */
  function reclaim(bin: Bin): void {
    while (bin.leased.length > 0 && frames - bin.leased[0].frame >= depth) {
      bin.free.push(bin.leased.shift()!.buf)
    }
  }

  function create(tag: Tag, length: number): View {
    created++
    bytes += length * BYTES[tag]
    return MAKE[tag](length)
  }

  function stats(): TransientPoolStats {
    let pooled = 0
    let leased = 0
    for (const bin of bins.values()) {
      pooled += bin.free.length
      leased += bin.leased.length
    }
    return { created, pooled, leased, bytes, frames }
  }

  return {
    beginFrame,
    f32: length => alloc('f32', length) as Float32Array,
    f64: length => alloc('f64', length) as Float64Array,
    i32: length => alloc('i32', length) as Int32Array,
    u32: length => alloc('u32', length) as Uint32Array,
    u8: length => alloc('u8', length) as Uint8Array,
    stats,
  }
}
