import type { ReadableSignal } from '../signal/types.ts'

/** Uniform set field types (an ABI subset). */
export type UniformSetFieldType =
  | 'float' | 'int' | 'uint' | 'bool'
  | 'vec2' | 'vec3' | 'vec4'
  | 'ivec2' | 'ivec3' | 'ivec4'
  | 'mat2' | 'mat3' | 'mat4'

/** Set schema: field name → type. */
export type UniformSetSchema = Readonly<Record<string, UniformSetFieldType>>

/** Field value: a scalar, an array, or a signal over them. */
export type UniformSetValue = number | readonly number[] | Float32Array | ReadableSignal<number | readonly number[] | Float32Array>

/** A named shared uniform set with an arena slot. */
export interface UniformSet<S extends UniformSetSchema = UniformSetSchema> {
  readonly name: string
  /** The slot is allocated by the arena at creation (before the first command). */
  attach(alloc: (type: UniformSetFieldType) => { offset: number; size: number }): void
  /** Writes values into the arena (values or signals — peek). */
  write(writeFloat: (offset: number, value: number) => void): void
  /** Persistent binding: signals are read on every write. */
  link(values: Partial<Record<keyof S, ReadableSignal<any>>>): void
  /** Snapshot of field offsets (for command compilation). */
  readonly offsets: Readonly<Partial<Record<keyof S, number>>>
}

/** Creates a named uniform set (camera, light — by naming convention). */
export function createUniformSet<S extends UniformSetSchema>(
  name: string,
  schema: S,
  options: { frequency?: 'frame' | 'draw' } = {},
): UniformSet<S> {
  const offsets: Partial<Record<keyof S, number>> = {}
  let attached = false
  let linked: Partial<Record<keyof S, ReadableSignal<any>>> = {}
  const cache: Partial<Record<keyof S, UniformSetValue>> = {}
  void options.frequency // a hint for frequency-split arenas (implemented by the arena)

  function attach(alloc: (type: UniformSetFieldType) => { offset: number; size: number }): void {
    if (attached) return
    attached = true
    for (const [field, type] of Object.entries(schema)) {
      offsets[field as keyof S] = alloc(type).offset
    }
  }

  function write(writeFloat: (offset: number, value: number) => void): void {
    for (const [field] of Object.entries(schema)) {
      const offset = offsets[field as keyof S]
      if (offset === undefined) continue
      const signal = linked[field as keyof S]
      const value = signal !== undefined ? signal.peek() : cache[field as keyof S]
      if (value === undefined) continue
      writeField(offset, value, writeFloat)
    }
  }

  function link(values: Partial<Record<keyof S, ReadableSignal<any>>>): void {
    linked = { ...linked, ...values }
  }

  return {
    name,
    attach,
    write,
    link,
    offsets,
  }
}

function writeField(offset: number, value: UniformSetValue, writeFloat: (offset: number, value: number) => void): void {
  if (typeof value === 'number') {
    writeFloat(offset, value)
    return
  }
  const array = value as readonly number[]
  for (let i = 0; i < array.length; i++) writeFloat(offset + i * 4, array[i])
}
