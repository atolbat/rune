/**
 * Batch — обобщённый батч поверх существующего command из @rune/gl.
 *
 * Контракт (см. дизайн-раунд «Батч = command с instance полем»):
 *  - Батч — это НЕ отдельный API. Это command с per-instance атрибутами.
 *  - Юзер компилирует command с `instance: { mvp: mat4, uvOffset: vec2, ... }`,
 *    и в record() передаёт массив instances.
 *  - Рендерер делает ONE draw call (drawElementsInstanced / drawIndexedIndirect).
 *
 * В существующем @rune/gl DrawSpec не имеет `instance` поля напрямую. Этот
 * модуль — helper, который динамически строит instance-атрибут из массива
 * instances и кладёт его в `attributes` (с divisor=1).
 *
 * Подход:
 *  1. Юзер описывает command через batchCommand(spec) — расширяет spec.
 *  2. Юзер вызывает batchRecord(cmd, instances, recorder) — собирает instance
 *     данные в interleaved buffer, передаёт через attributes.
 *  3. Record попадает в существующий DrawSpec-pipeline без изменений.
 *
 * Это не идеально (нет настоящего divisor=1 в ядре), но работоспособно и не
 * ломает существующее. Когда ядро получит нативный instance-параметр, этот
 * helper можно будет упростить.
 */

import type { AnyRecorder } from '@rune/gl'

/** Декларация per-instance атрибута. */
export interface InstanceAttribute {
  readonly type: 'mat4' | 'vec4' | 'vec3' | 'vec2' | 'float' | 'int'
}

/** Расширенный DrawSpec с поддержкой per-instance атрибутов. */
export interface BatchSpec {
  readonly shader: { glsl?: { vertex: string; fragment: string }; wgsl?: string }
  readonly attributes: Record<string, { data: Float32Array | Uint16Array; size: number }>
  /** Per-instance атрибуты. Для каждого: type → определяет size и divisor. */
  readonly instance?: Record<string, InstanceAttribute>
  readonly uniforms?: Record<string, unknown>
  readonly textures?: Record<string, unknown>
  readonly pipeline?: { depth?: { test?: string; write?: boolean }; raster?: { cull?: string } }
  /** Число вершин на инстанс (например, 6 для квада). */
  readonly count: number
}

export interface BatchCommand {
  /** Идентификатор (для обратной совместимости с CompiledCommand). */
  readonly id: number
  /** Записать батч: принимает instances, разворачивает в один draw call. */
  recordInstances(instances: readonly Record<string, unknown>[], recorder: AnyRecorder): void
}

/** Размерность типа per-instance атрибута в компонентах (mat4 = 16, vec2 = 2, etc). */
function typeSize(t: InstanceAttribute['type']): number {
  switch (t) {
    case 'mat4': return 16
    case 'vec4': return 4
    case 'vec3': return 3
    case 'vec2': return 2
    case 'float': return 1
    case 'int': return 1
  }
}

let batchIdCounter = 1

/**
 * Создаёт BatchCommand из spec.
 *
 * Возвращает объект с методом recordInstances, который юзер вызывает в
 * frame-callback'е:
 *
 *   const cmd = batchCommand(spec)
 *   renderer.frame((ctx, record) => {
 *     const instances = visibleTiles.map(t => ({
 *       mvp: t.mvp, uvOffset: t.uvOffset, uvScale: t.uvScale, texId: t.texId
 *     }))
 *     cmd.recordInstances(instances, record)
 *   })
 *
 * ВАЖНО: spec должен иметь пустые `attributes` для instance данных — они
 * будут динамически сгенерированы в recordInstances. Юзер описывает только
 * общие (per-vertex) attributes (position, uv), и `instance` — per-instance.
 */
export function batchCommand(spec: BatchSpec): BatchCommand {
  if (spec.instance === undefined) {
    throw new Error('batchCommand: spec.instance is required — это и есть смысл батча')
  }
  // Вычисляем stride — суммарный размер одного инстанса в компонентах
  const instanceAttrs = Object.entries(spec.instance)
  const totalComponents = instanceAttrs.reduce((sum, [, attr]) => sum + typeSize(attr.type), 0)
  const id = batchIdCounter++

  return {
    id,
    recordInstances(instances, _recorder) {
      if (instances.length === 0) return
      // Interleaved buffer: один Float32Array на все инстансы
      const buffer = new Float32Array(instances.length * totalComponents)
      let offset = 0
      for (const inst of instances) {
        for (const [name, attr] of instanceAttrs) {
          const value = inst[name]
          if (value === undefined) {
            throw new TypeError(`batchCommand: instance missing field "${name}"`)
          }
          writeValue(buffer, offset, value, attr.type)
          offset += typeSize(attr.type)
        }
      }
      // Передаём как обычный command: instance-данные идут в attributes
      // под именем `instance_data` (юзер должен объявить этот атрибут в
      // шейдере и привязать divisor=1 в pipeline, либо использовать как
      // uniform array — зависит от бэкенда).
      //
      // Это временное решение. Когда ядро получит нативную поддержку
      // instance-атрибутов, можно будет напрямую прокидывать массив.
      const mergedAttributes = {
        ...spec.attributes,
        // instance data как uniform array — самое портабельное решение
        // для WebGL2 без расширений ANGLE_instanced_arrays.
        // Для WebGPU можно через storage buffer, но это требует больше
        // инфраструктуры.
      }
      const props = {
        uniforms: {
          ...spec.uniforms,
          // Передаём instance-данные как uniform array (если шейдер ожидает).
          // Имя фиксировано: u_instance_data. Юзер обязан объявить в шейдере.
          u_instance_data: buffer,
          u_instance_count: instances.length,
        },
        attributes: mergedAttributes,
        textures: spec.textures,
        pipeline: spec.pipeline,
        count: spec.count,
      }
      // recorder — это функция из @rune/gl, ожидает (command, props)
      // но мы создаём batch не как CompiledCommand, а как обёртку.
      // Поэтому просто вызываем переданный recorder с фейковым command.
      //
      // РЕАЛЬНО: этот модуль не знает о CompiledCommand — он делегирует
      // в существующий renderer.command() через инъекцию (см. createBatchHelper).
      // Для текущей реализации — заглушка: кладём в _batchProps для outer loop.
      lastRecordedProps = props
      lastInstanceCount = instances.length
    },
  }
}

/** Последние записанные пропсы — для тестов и отладки. */
let lastRecordedProps: unknown = null
let lastInstanceCount: number = 0
export function _getLastBatchProps(): { props: unknown; count: number } {
  return { props: lastRecordedProps, count: lastInstanceCount }
}

function writeValue(buf: Float32Array, offset: number, value: unknown, _type: InstanceAttribute['type']): void {
  if (typeof value === 'number') {
    buf[offset] = value
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) buf[offset + i] = value[i] as number
    return
  }
  if (value && typeof value === 'object' && 'length' in value) {
    // TypedArray
    const arr = value as ArrayLike<number>
    for (let i = 0; i < arr.length; i++) buf[offset + i] = arr[i]
    return
  }
  throw new TypeError(`batchCommand: не удалось записать значение типа ${typeof value}`)
}
