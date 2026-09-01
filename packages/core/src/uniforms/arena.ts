/**
 * std140-арена: staging-буфер юниформов с поштучным value-compare.
 * Неизменённое значение НЕ помечается грязным (теория C: fround —
 * 0.8 как f64 ≠ 0.8 как f32, сравнение в f32 подавляет ложные аплоады).
 *
 * Две совместимые поверхности:
 *  - float-API (активные рендереры): alloc(sizeFloats) → UniformSlot,
 *    write(slot, values) — слот в float-элементах;
 *  - byte-API (uniformSet/frequencyArena/tape-доставка): alloc(type) →
 *    {offset,size} в байтах, writeFloat/readFloat, dirtyRanges/importBytes.
 */

export interface DirtyRange {
  /** Начало диапазона в массивах буфера. */
  begin: number
  /** Конец (эксклюзивный). */
  end: number
}

/** Байтовый диапазон (для доставки кадров между мирами). */
export interface ByteRange {
  /** Начало в байтах от начала буфера арены. */
  from: number
  /** Конец (эксклюзивный) в байтах. */
  to: number
}

/** Дескриптор слота в байтах (byte-API). */
export interface UniformSlotBytes {
  /** Смещение поля в байтах от начала буфера арены. */
  readonly offset: number
  /** Размер поля в байтах. */
  readonly size: number
}

export interface UniformSlot {
  /** Смещение в float-элементах буфера. */
  readonly base: number
  /** Число float. */
  readonly size: number
  /** Грязный с последней загрузки. */
  dirty: boolean
}

export interface UniformArena {
  readonly buffer: Float32Array
  /** Байтовый вид поверх того же буфера (доставка кадров). */
  readonly bytes: Uint8Array
  /** Линейное выделение слота (бамп; float-API). */
  alloc(size: number): UniformSlot
  /** Выделение слота по ИМЕНИ ТИПА (byte-API: 'mat4' → 64 байта). */
  alloc(type: string): UniformSlotBytes
  /** Запись со сравнением; true = значение изменилось (float-API).
   *  Скаляр (float-uniform) пишется в первый элемент слота. */
  write(slot: UniformSlot, values: ArrayLike<number> | number): boolean
  /** Запись одного float по байтовому смещению со сравнением (byte-API). */
  writeFloat(slot: number | UniformSlotBytes, value: number): void
  /** Чтение float по байтовому смещению (byte-API). */
  readFloat(slot: number | UniformSlotBytes, index?: number): number
  /** Все слоты, помеченные грязным (снимок). */
  dirtySlots(): UniformSlot[]
  /** Грязные диапазоны в БАЙТАХ, слитые из смежных слотов (byte-API). */
  dirtyRanges(): ByteRange[]
  /** Записать vec4 в слот со value-compare (byte-API). */
  writeVec4(slot: UniformSlot | UniformSlotBytes, x: number, y: number, z: number, w: number): void
  /** Грязный ли слот (диагностика/бенчмарки). */
  isDirty(slot: UniformSlot | UniformSlotBytes): boolean
  /** Вливает доставленные байты, помечая пересечённые слоты грязными. */
  importBytes(from: number, bytes: Uint8Array): void
  /** Сброс грязных флагов (после загрузки). */
  clearDirty(): void
  /** Занятость в float. */
  used(): number
  /** Занятость в байтах (byte-API). */
  readonly usedBytes: number
}

/** Размеры uniform-типов в байтах (подмножество ABI). */
const TYPE_BYTES: Record<string, number> = {
  float: 4, int: 4, uint: 4, bool: 4,
  vec2: 8, vec3: 12, vec4: 16,
  ivec2: 8, ivec3: 12, ivec4: 16,
  uvec2: 8, uvec3: 12, uvec4: 16,
  bvec2: 8, bvec3: 12, bvec4: 16,
  mat2: 16, mat3: 48, mat4: 64,
}

export function createUniformArena(floats: number = 1 << 16): UniformArena {
  const buffer = new Float32Array(floats)
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const slots: UniformSlot[] = []
  let cursor = 0

  function alloc(sizeOrType: number | string): UniformSlot | UniformSlotBytes {
    if (typeof sizeOrType === 'string') {
      const byteSize = TYPE_BYTES[sizeOrType]
      if (byteSize === undefined) throw new Error(`rune: неизвестный uniform-тип "${sizeOrType}"`)
      return allocBytes(byteSize)
    }
    return allocFloats(sizeOrType)
  }

  function allocFloats(size: number): UniformSlot {
    if (cursor + size > floats) throw new Error(`rune: uniform-арена переполнена (${floats} float)`)
    const slot: UniformSlot = { base: cursor, size, dirty: true }
    cursor += size
    slots.push(slot)
    return slot
  }

  /** Выделение по размеру в байтах: слот хранит float-метрики, наружу — байтовый дескриптор. */
  function allocBytes(byteSize: number): UniformSlotBytes {
    const size = byteSize / 4
    if (cursor + size > floats) throw new Error(`rune: uniform-арена переполнена (${floats} float)`)
    const slot: UniformSlot = { base: cursor, size, dirty: true }
    cursor += size
    slots.push(slot)
    return { offset: slot.base * 4, size: byteSize }
  }

  function write(slot: UniformSlot, values: ArrayLike<number> | number): boolean {
    let changed = false
    if (typeof values === 'number') {
      // Скалярный float-uniform: сравнение и запись первого элемента
      // (раньше values[0] на числе давал undefined → молчаливый ноль).
      if (Math.fround(values) !== buffer[slot.base]) {
        buffer[slot.base] = values
        changed = true
      }
    } else {
      for (let at = 0; at < slot.size; at++) {
        const next = values[at] ?? 0
        if (Math.fround(next) !== buffer[slot.base + at]) {
          buffer[slot.base + at] = next
          changed = true
        }
      }
    }
    if (changed) slot.dirty = true
    return changed
  }

  function slotAt(floatIndex: number): UniformSlot | null {
    for (let at = 0; at < slots.length; at++) {
      const slot = slots[at]
      if (floatIndex >= slot.base && floatIndex < slot.base + slot.size) return slot
    }
    return null
  }

  function byteOffsetOf(slot: number | UniformSlotBytes): number {
    return typeof slot === 'number' ? slot : slot.offset
  }

  function writeFloat(slot: number | UniformSlotBytes, value: number): void {
    const offset = byteOffsetOf(slot)
    if (offset % 4 !== 0 || offset < 0 || offset >= buffer.byteLength) {
      throw new Error(`rune: writeFloat — неверное смещение ${offset}`)
    }
    const floatIndex = offset >> 2
    if (Math.fround(value) !== buffer[floatIndex]) {
      buffer[floatIndex] = value
      const owner = slotAt(floatIndex)
      if (owner !== null) owner.dirty = true
    }
  }

  function readFloat(slot: number | UniformSlotBytes, index = 0): number {
    const offset = byteOffsetOf(slot)
    return buffer[(offset >> 2) + index]
  }

  function floatIndexOf(slot: UniformSlot | UniformSlotBytes): number {
    return 'base' in slot ? slot.base : slot.offset >> 2
  }

  function writeVec4(slot: UniformSlot | UniformSlotBytes, x: number, y: number, z: number, w: number): void {
    const base = floatIndexOf(slot)
    let changed = false
    const values = [x, y, z, w]
    for (let at = 0; at < 4; at++) {
      if (Math.fround(values[at]) !== buffer[base + at]) {
        buffer[base + at] = values[at]
        changed = true
      }
    }
    if (changed) {
      const owner = slotAt(base)
      if (owner !== null) owner.dirty = true
    }
  }

  function isDirty(slot: UniformSlot | UniformSlotBytes): boolean {
    const owner = slotAt(floatIndexOf(slot))
    return owner !== null && owner.dirty
  }

  function dirtySlots(): UniformSlot[] {
    return slots.filter(slot => slot.dirty)
  }

  function dirtyRanges(): ByteRange[] {
    const dirty = slots.filter(slot => slot.dirty).map(slot => ({
      from: slot.base * 4,
      to: (slot.base + slot.size) * 4,
    }))
    dirty.sort((a, b) => a.from - b.from)
    const ranges: ByteRange[] = []
    for (const range of dirty) {
      const last = ranges[ranges.length - 1]
      if (last !== undefined && range.from <= last.to) {
        if (range.to > last.to) last.to = range.to
      } else {
        ranges.push({ from: range.from, to: range.to })
      }
    }
    return ranges
  }

  function importBytes(from: number, source: Uint8Array): void {
    if (source.byteLength === 0) return
    if (from < 0 || from + source.byteLength > buffer.byteLength) {
      throw new Error('rune: importBytes выходит за границы арены')
    }
    bytes.set(source, from)
    const fromFloat = from >> 2
    const toFloat = (from + source.byteLength + 3) >> 2
    for (const slot of slots) {
      if (slot.base + slot.size > fromFloat && slot.base < toFloat) slot.dirty = true
    }
  }

  function clearDirty(): void {
    for (const slot of slots) slot.dirty = false
  }

  function used(): number {
    return cursor
  }

  return {
    buffer,
    get bytes() { return bytes },
    alloc: alloc as unknown as {
      (size: number): UniformSlot
      (type: string): UniformSlotBytes
    },
    write,
    writeFloat,
    readFloat,
    writeVec4,
    isDirty,
    dirtySlots,
    dirtyRanges,
    importBytes,
    clearDirty,
    used,
    get usedBytes() { return cursor * 4 },
  }
}
