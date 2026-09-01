/** Форматы полей feed (M5-подмножество).
 *  float32x2/x3/x4 (Task 73 / M5): векторные поля — dual-bind feed требует
 *  компоненты 1..4 на поле (досье §4.3: layout { position: 'float32x3', … }). */
export type FeedFieldFormat = 'float32' | 'float32x2' | 'float32x3' | 'float32x4' | 'unorm8x4'

/** Схема записи feed: имя → формат. */
export type FeedLayout = Readonly<Record<string, FeedFieldFormat>>

/** Политика переполнения ринга. */
export type FeedPolicy = 'drop-oldest' | 'drop-new' | 'block'

/** Носитель ринга: SAB (T1/T2, кросс-поток) или ArrayBuffer (T0/T3-мир). */
export type FeedBacking = 'sab' | 'local'

/** Канал-фид: воркеры пишут в общий ринг, владелец GPU читает атомарно. */
export interface Feed {
  readonly buffer: ArrayBufferLike
  readonly capacity: number
  readonly stride: number
  /** Записывает n записей от индекса from (локально, без publish). */
  view(from: number, count: number): FeedWriter
  /** Сахар: дописывает в хвост, возвращает стартовый индекс. */
  push(count: number): FeedWriter
  /** Публикует: один атомарный инкремент счётчика на всю партию. */
  publish(): void
  /** Атомарный снимок числа опубликованных записей. */
  publishedCount(): number
}

/** Писатель пакета записей: задаёт поля по имени. */
export interface FeedWriter {
  setFloat(name: string, index: number, value: number): void
  setVec2(name: string, index: number, x: number, y: number): void
  setVec3(name: string, index: number, x: number, y: number, z: number): void
  setVec4(name: string, index: number, x: number, y: number, z: number, w: number): void
  setVec4Bytes(name: string, index: number, r: number, g: number, b: number, a: number): void
}

const HEADER_BYTES = 64 // count(u32), published(u32), dropped(u32), reserved

/** Вычисляет stride записи по layout (выравнивание 4). */
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

/** Число float-компонент поля (для вершинного пути dual-bind). */
export function feedFieldSize(format: FeedFieldFormat): number {
  if (format === 'float32x2') return 2
  if (format === 'float32x3') return 3
  if (format === 'float32x4') return 4
  return 1 // float32; unorm8x4 — байтовый (вершинно не используется)
}

export interface FeedOptions {
  readonly layout: FeedLayout
  readonly capacity: number
  readonly policy?: FeedPolicy
  /** Носитель: 'sab' (default, кросс-поток T1/T2) | 'local' (T0/T3-мир). */
  readonly backing?: FeedBacking
}

/** Создаёт feed на стороне владельца. */
export function createFeed(options: FeedOptions): Feed {
  const stride = feedStride(options.layout)
  const backing = options.backing ?? 'sab'
  const buffer = backing === 'sab'
    ? new SharedArrayBuffer(HEADER_BYTES + options.capacity * stride)
    : new ArrayBuffer(HEADER_BYTES + options.capacity * stride)
  return makeFeed(buffer, options.layout, options.capacity, options.policy ?? 'drop-oldest')
}

/** Привязывается к фиду из воркера (тот же layout). */
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
  u32[0] = 0 // written
  u32[1] = 0 // published
  u32[2] = 0 // dropped
  return {
    buffer,
    capacity,
    stride,
    view: (from, count) => feedWriter(buffer, stride, layout, from, count, policy),
    push: count => feedWriter(buffer, stride, layout, reserve(buffer, capacity, count, policy), count, policy),
    publish: () => publishCount(u32),
    publishedCount: () => Atomics.load(u32, 1),
  }
}

function reserve(buffer: ArrayBufferLike, capacity: number, count: number, _policy: FeedPolicy): number {
  const u32 = new Uint32Array(buffer)
  const from = Atomics.load(u32, 0)
  // Task 75 (фикс «Number of bytes to write is too large»): written НИКОГДА
  // не заходит за capacity. Раньше резерв шёл безусловно (written уходил за
  // capacity, publish копировал его в published), и рендерер получал
  // count > capacity → writeBuffer/bufferSubData больше буфера → внезапный
  // OperationError под стрессом. Теперь окно закрыто = записи считаются
  // drop'нутыми (счётчик u32[2]), данные пишутся «в пустоту» (OOB-записи
  // TypedArray молча игнорируются) — published ≤ capacity всегда.
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

function feedWriter(
  buffer: ArrayBufferLike,
  stride: number,
  layout: FeedLayout,
  from: number,
  _count: number,
  _policy: FeedPolicy,
): FeedWriter {
  const f32 = new Float32Array(buffer, HEADER_BYTES)
  const u8 = new Uint8Array(buffer, HEADER_BYTES)
  const offsets = fieldOffsets(layout)
  return {
    setFloat: (name, index, value) => {
      const offset = requireOffset(offsets, name)
      f32[((from + index) * stride + offset) >> 2] = value
    },
    setVec2: (name, index, x, y) => {
      const offset = requireOffset(offsets, name)
      const at = ((from + index) * stride + offset) >> 2
      f32[at] = x
      f32[at + 1] = y
    },
    setVec3: (name, index, x, y, z) => {
      const offset = requireOffset(offsets, name)
      const at = ((from + index) * stride + offset) >> 2
      f32[at] = x
      f32[at + 1] = y
      f32[at + 2] = z
    },
    setVec4: (name, index, x, y, z, w) => {
      const offset = requireOffset(offsets, name)
      const at = ((from + index) * stride + offset) >> 2
      f32[at] = x
      f32[at + 1] = y
      f32[at + 2] = z
      f32[at + 3] = w
    },
    setVec4Bytes: (name, index, r, g, b, a) => {
      const offset = requireOffset(offsets, name)
      const at = (from + index) * stride + offset
      u8[at] = r; u8[at + 1] = g; u8[at + 2] = b; u8[at + 3] = a
    },
  }
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
  if (offset === undefined) throw new Error(`rune: поле фида "${name}" не объявлено`)
  return offset
}
