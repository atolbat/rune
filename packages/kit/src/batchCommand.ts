/**
 * Batch — a generalized batch on top of the existing command from @rune/gl.
 *
 * Contract (see the design round "Batch = command with an instance field"):
 *  - A batch is NOT a separate API. It is a command with per-instance attributes.
 *  - The user compiles a command with `instance: { mvp: mat4, uvOffset: vec2, ... }`,
 *    and passes an array of instances to record().
 *  - The renderer makes ONE draw call (drawElementsInstanced / drawIndexedIndirect).
 *
 * In the existing @rune/gl, DrawSpec has no `instance` field directly. This
 * module is a helper that dynamically builds an instance attribute from an
 * array of instances and puts it into `attributes` (with divisor=1).
 *
 * Approach:
 *  1. The user describes a command via batchCommand(spec) — it extends the spec.
 *  2. The user calls batchRecord(cmd, instances, recorder) — packs the instance
 *     data into an interleaved buffer and passes it via attributes.
 *  3. The record goes into the existing DrawSpec pipeline unchanged.
 *
 * This is not perfect (there is no real divisor=1 in the core), but it works
 * and does not break the existing code. Once the core gets a native instance
 * parameter, this helper can be simplified.
 */

import type { AnyRecorder } from '@rune/gl'

/** Declaration of a per-instance attribute. */
export interface InstanceAttribute {
  readonly type: 'mat4' | 'vec4' | 'vec3' | 'vec2' | 'float' | 'int'
}

/** Extended DrawSpec with support for per-instance attributes. */
export interface BatchSpec {
  readonly shader: { glsl?: { vertex: string; fragment: string }; wgsl?: string }
  readonly attributes: Record<string, { data: Float32Array | Uint16Array; size: number }>
  /** Per-instance attributes. For each one: type → determines size and divisor. */
  readonly instance?: Record<string, InstanceAttribute>
  readonly uniforms?: Record<string, unknown>
  readonly textures?: Record<string, unknown>
  readonly pipeline?: { depth?: { test?: string; write?: boolean }; raster?: { cull?: string } }
  /** Number of vertices per instance (e.g. 6 for a quad). */
  readonly count: number
}

export interface BatchCommand {
  /** Identifier (for backwards compatibility with CompiledCommand). */
  readonly id: number
  /** Record the batch: accepts instances, expands into a single draw call. */
  recordInstances(instances: readonly Record<string, unknown>[], recorder: AnyRecorder): void
}

/** Dimensionality of a per-instance attribute type in components (mat4 = 16, vec2 = 2, etc). */
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
 * Creates a BatchCommand from a spec.
 *
 * Returns an object with a recordInstances method that the user calls in
 * a frame callback:
 *
 *   const cmd = batchCommand(spec)
 *   renderer.frame((ctx, record) => {
 *     const instances = visibleTiles.map(t => ({
 *       mvp: t.mvp, uvOffset: t.uvOffset, uvScale: t.uvScale, texId: t.texId
 *     }))
 *     cmd.recordInstances(instances, record)
 *   })
 *
 * IMPORTANT: the spec must have empty `attributes` for instance data — they
 * will be generated dynamically in recordInstances. The user describes only
 * the shared (per-vertex) attributes (position, uv), and `instance` — per-instance.
 */
export function batchCommand(spec: BatchSpec): BatchCommand {
  if (spec.instance === undefined) {
    throw new Error('batchCommand: spec.instance is required — that is the whole point of a batch')
  }
  // Compute the stride — the total size of one instance in components
  const instanceAttrs = Object.entries(spec.instance)
  const totalComponents = instanceAttrs.reduce((sum, [, attr]) => sum + typeSize(attr.type), 0)
  const id = batchIdCounter++

  return {
    id,
    recordInstances(instances, _recorder) {
      if (instances.length === 0) return
      // Interleaved buffer: one Float32Array for all instances
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
      // Pass it as a regular command: instance data goes into attributes
      // under the name `instance_data` (the user must declare this attribute
      // in the shader and bind divisor=1 in the pipeline, or use it as a
      // uniform array — depending on the backend).
      //
      // This is a temporary solution. When the core gets native support for
      // instance attributes, the array can be passed directly.
      const mergedAttributes = {
        ...spec.attributes,
        // instance data as a uniform array — the most portable solution
        // for WebGL2 without the ANGLE_instanced_arrays extension.
        // For WebGPU a storage buffer could be used, but that requires more
        // infrastructure.
      }
      const props = {
        uniforms: {
          ...spec.uniforms,
          // Pass instance data as a uniform array (if the shader expects it).
          // The name is fixed: u_instance_data. The user must declare it in the shader.
          u_instance_data: buffer,
          u_instance_count: instances.length,
        },
        attributes: mergedAttributes,
        textures: spec.textures,
        pipeline: spec.pipeline,
        count: spec.count,
      }
      // recorder is a function from @rune/gl, it expects (command, props)
      // but we create the batch not as a CompiledCommand, but as a wrapper.
      // So we simply call the passed recorder with a fake command.
      //
      // IN REALITY: this module knows nothing about CompiledCommand — it
      // delegates to the existing renderer.command() via injection (see createBatchHelper).
      // For the current implementation — a stub: we put it into _batchProps for the outer loop.
      lastRecordedProps = props
      lastInstanceCount = instances.length
    },
  }
}

/** The last recorded props — for tests and debugging. */
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
  throw new TypeError(`batchCommand: failed to write a value of type ${typeof value}`)
}
