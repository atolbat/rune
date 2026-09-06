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

  // Task 144 — the write plan built ONCE at attach: the old write() paid
  // Object.entries(schema) PER CALL (a fresh key array + N array
  // destructures) just to discover what attach had already resolved. The
  // plan walks a flat {field, offset} array in the same order — the
  // call sequence is bit-identical (write before attach → nothing is
  // written, exactly like the empty-offsets walk).
  let plan: { readonly field: keyof S; readonly offset: number }[] | null = null

  function attach(alloc: (type: UniformSetFieldType) => { offset: number; size: number }): void {
    if (attached) return
    attached = true
    const entries = Object.entries(schema)
    const resolved: { field: keyof S; offset: number }[] = []
    for (let i = 0; i < entries.length; i++) {
      const offset = alloc(entries[i][1] as UniformSetFieldType).offset
      offsets[entries[i][0] as keyof S] = offset
      resolved.push({ field: entries[i][0] as keyof S, offset })
    }
    plan = resolved
  }

  function write(writeFloat: (offset: number, value: number) => void): void {
    if (plan === null) return
    const p = plan
    for (let i = 0; i < p.length; i++) {
      const field = p[i].field
      const offset = p[i].offset
      const signal = linked[field]
      const value = signal !== undefined ? signal.peek() : cache[field]
      if (value === undefined) continue
      // writeField inlined (the Task-142 ramp lesson: JSC keeps the small
      // out-of-line call) — the same scalar/array split, the same order.
      if (typeof value === 'number') {
        writeFloat(offset, value)
      } else {
        const array = value as readonly number[]
        for (let at = 0; at < array.length; at++) writeFloat(offset + at * 4, array[at])
      }
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


