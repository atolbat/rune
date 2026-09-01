import type { ReadableSignal } from '../signal/types.ts'

/** Типы полей uniform-набора (подмножество ABI). */
export type UniformSetFieldType =
  | 'float' | 'int' | 'uint' | 'bool'
  | 'vec2' | 'vec3' | 'vec4'
  | 'ivec2' | 'ivec3' | 'ivec4'
  | 'mat2' | 'mat3' | 'mat4'

/** Схема набора: имя поля → тип. */
export type UniformSetSchema = Readonly<Record<string, UniformSetFieldType>>

/** Значение поля: скаляр, массив или сигнал над ним. */
export type UniformSetValue = number | readonly number[] | Float32Array | ReadableSignal<number | readonly number[] | Float32Array>

/** Именованный расшаренный набор юниформов со слотом арены. */
export interface UniformSet<S extends UniformSetSchema = UniformSetSchema> {
  readonly name: string
  /** Слот выделяется ареной при создании (до первой команды). */
  attach(alloc: (type: UniformSetFieldType) => { offset: number; size: number }): void
  /** Пишет значения в арену (значения или сигналы — peek). */
  write(writeFloat: (offset: number, value: number) => void): void
  /** Постоянная связь: сигналы читаются при каждом write. */
  link(values: Partial<Record<keyof S, ReadableSignal<any>>>): void
  /** Снимок смещений полей (для компиляции команд). */
  readonly offsets: Readonly<Partial<Record<keyof S, number>>>
}

/** Создаёт именованный uniform-набор (камера, свет — по конвенции имён). */
export function createUniformSet<S extends UniformSetSchema>(
  name: string,
  schema: S,
  options: { frequency?: 'frame' | 'draw' } = {},
): UniformSet<S> {
  const offsets: Partial<Record<keyof S, number>> = {}
  let attached = false
  let linked: Partial<Record<keyof S, ReadableSignal<any>>> = {}
  const cache: Partial<Record<keyof S, UniformSetValue>> = {}
  void options.frequency // хинт для frequency-split арен (реализуется ареной)

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
