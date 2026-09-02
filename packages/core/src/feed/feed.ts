/** Feed field formats (M5 subset).
 *  float32x2/x3/x4 (Task 73 / M5): vector fields — dual-bind feed requires
 *  1..4 components per field (dossier §4.3: layout { position: 'float32x3', … }). */
export type FeedFieldFormat = 'float32' | 'float32x2' | 'float32x3' | 'float32x4' | 'unorm8x4'

/** Feed record schema: name → format. */
export type FeedLayout = Readonly<Record<string, FeedFieldFormat>>

/** Ring overflow policy. */
export type FeedPolicy = 'drop-oldest' | 'drop-new' | 'block'

/** Ring backing: SAB (T1/T2, cross-thread) or ArrayBuffer (T0/T3 world). */
export type FeedBacking = 'sab' | 'local'

/** Channel feed: workers write into a shared ring, the GPU owner reads atomically. */
export interface Feed {
  readonly buffer: ArrayBufferLike
  readonly capacity: number
  readonly stride: number
  /** Writes n records starting at index `from` (locally, without publish).
 *  The returned writer is REUSED by the feed: the next view()/push() call
 *  RE-AIMS it — consume the batch before requesting the next (Task 114,
 *  zero steady-state allocations; previously every call rebuilt the views,
 *  the offsets map and five writer closures). */
  view(from: number, count: number): FeedWriter
  /** Sugar: appends to the tail, returns the starting index. */
  push(count: number): FeedWriter
  /** Publishes: one atomic increment of the counter for the whole batch. */
  publish(): void
  /** Atomic snapshot of the number of published records. */
  publishedCount(): number
}

/** Batch record writer: sets fields by name. */
export interface FeedWriter {
  setFloat(name: string, index: number, value: number): void
  setVec2(name: string, index: number, x: number, y: number): void
  setVec3(name: string, index: number, x: number, y: number, z: number): void
  setVec4(name: string, index: number, x: number, y: number, z: number, w: number): void
  setVec4Bytes(name: string, index: number, r: number, g: number, b: number, a: number): void
}

const HEADER_BYTES = 64 // count(u32), published(u32), dropped(u32), reserved

/** Computes the record stride from the layout (4-byte alignment). */
export function feedStride(layout: FeedLayout): number {
  let stride = 0
  for (const format of Object.values(layout)) {
    stride += formatBytes(format)
  }
  return stride
}

function formatBytes(format: FeedFieldFormat): number {
  if (format === 'float32x2') return 8
  if (format === 'float32x3') return 12
  if (format === 'float32x4') return 16
  return 4 // float32, unorm8x4
}

/** Number of float components in a field (for the dual-bind vertex path). */
export function feedFieldSize(format: FeedFieldFormat): number {
  if (format === 'float32x2') return 2
  if (format === 'float32x3') return 3
  if (format === 'float32x4') return 4
  return 1 // float32; unorm8x4 — byte-sized (not used for vertices)
}

export interface FeedOptions {
  readonly layout: FeedLayout
  readonly capacity: number
  readonly policy?: FeedPolicy
  /** Backing: 'sab' (default, cross-thread T1/T2) | 'local' (T0/T3 world). */
  readonly backing?: FeedBacking
}

/** Creates a feed on the owner side. */
export function createFeed(options: FeedOptions): Feed {
  const stride = feedStride(options.layout)
  const backing = options.backing ?? 'sab'
  const buffer = backing === 'sab'
    ? new SharedArrayBuffer(HEADER_BYTES + options.capacity * stride)
    : new ArrayBuffer(HEADER_BYTES + options.capacity * stride)
  return makeFeed(buffer, options.layout, options.capacity, options.policy ?? 'drop-oldest')
}

/** Attaches to a feed from a worker (same layout). */
export function attachFeed(buffer: ArrayBufferLike, layout: FeedLayout, capacity: number): Feed {
  return makeFeed(buffer, layout, capacity, 'drop-oldest')
}

function makeFeed(
  buffer: ArrayBufferLike,
  layout: FeedLayout,
  capacity: number,
  policy: FeedPolicy,
): Feed {
  const stride = feedStride(layout)
  const u32 = new Uint32Array(buffer)
  const f32 = new Float32Array(buffer, HEADER_BYTES)
  const u8 = new Uint8Array(buffer, HEADER_BYTES)
  // Offsets are resolved ONCE per feed — the layout never changes after
  // creation (Task 114: previously every view()/push() re-parsed it).
  const offsets = fieldOffsets(layout)
  u32[0] = 0 // written
  u32[1] = 0 // published
  u32[2] = 0 // dropped
  // Task 114 — ONE writer per feed, re-aimed by view()/push(): the write
  // window is closure state (mutable `wFrom`), the methods never allocate.
  let wFrom = 0
  const writer: FeedWriter = {
    setFloat: (name, index, value) => {
      const offset = requireOffset(offsets, name)
      f32[((wFrom + index) * stride + offset) >> 2] = value
    },
    setVec2: (name, index, x, y) => {
      const offset = requireOffset(offsets, name)
      const at = ((wFrom + index) * stride + offset) >> 2
      f32[at] = x
      f32[at + 1] = y
    },
    setVec3: (name, index, x, y, z) => {
      const offset = requireOffset(offsets, name)
      const at = ((wFrom + index) * stride + offset) >> 2
      f32[at] = x
      f32[at + 1] = y
      f32[at + 2] = z
    },
    setVec4: (name, index, x, y, z, w) => {
      const offset = requireOffset(offsets, name)
      const at = ((wFrom + index) * stride + offset) >> 2
      f32[at] = x
      f32[at + 1] = y
      f32[at + 2] = z
      f32[at + 3] = w
    },
    setVec4Bytes: (name, index, r, g, b, a) => {
      const offset = requireOffset(offsets, name)
      const at = (wFrom + index) * stride + offset
      u8[at] = r; u8[at + 1] = g; u8[at + 2] = b; u8[at + 3] = a
    },
  }
  return {
    buffer,
    capacity,
    stride,
    view: (from, count) => {
      void count
      wFrom = from
      return writer
    },
    push: count => {
      wFrom = reserve(u32, capacity, count, policy)
      return writer
    },
    publish: () => publishCount(u32),
    publishedCount: () => Atomics.load(u32, 1),
  }
}

function reserve(u32: Uint32Array, capacity: number, count: number, _policy: FeedPolicy): number {
  const from = Atomics.load(u32, 0)
  // Task 75 (fix for "Number of bytes to write is too large"): written NEVER
  // goes past capacity. Previously the reserve went unconditionally (written went past
  // capacity, publish copied it into published), and the renderer got
  // count > capacity → writeBuffer/bufferSubData larger than the buffer → a sudden
  // OperationError under stress. Now a closed window = records are counted as
  // dropped (counter u32[2]), the data is written "into the void" (out-of-bounds
  // TypedArray writes are silently ignored) — published ≤ capacity always.
  if (from + count > capacity) {
    Atomics.add(u32, 2, count)
    return capacity
  }
  Atomics.add(u32, 0, count)
  return from
}

function publishCount(u32: Uint32Array): void {
  Atomics.store(u32, 1, Atomics.load(u32, 0))
}

function fieldOffsets(layout: FeedLayout): Map<string, number> {
  const offsets = new Map<string, number>()
  let offset = 0
  for (const [name, format] of Object.entries(layout)) {
    offsets.set(name, offset)
    offset += formatBytes(format)
  }
  return offsets
}

function requireOffset(offsets: Map<string, number>, name: string): number {
  const offset = offsets.get(name)
  if (offset === undefined) throw new Error(`rune: feed field "${name}" is not declared`)
  return offset
}
