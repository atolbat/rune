import { describe, expect, it } from 'bun:test'
import { createWgpuContext, compileWgslSpec, createRecordingGPU, createGpuExecutor } from '../src/index.ts'
import type { WgpuDrawSpec } from '../src/index.ts'
import { createSliceArena } from '../src/index.ts'
import { reflectWgsl } from '../src/wgslReflect.ts'
import { createTapeWriter, serializeTape, parseTape, OpCode } from '@rune/core'

/**
 * Task 193 (theory A — the bit-discard experiment), the WG mock pins:
 *
 *   1. REFLECTION: the read-only storage declarations (name/group/binding);
 *      read_write and compute-group storages are NOT the render slot;
 *   2. THE COMPILE CONTRACT: exactly one declaration at @group(2)
 *      @binding(0), matched by spec.storage — every mismatch (declared
 *      without a spec, spec without a declaration, a wrong slot, two
 *      declarations) is a LOUD error, never a silent unbound group;
 *   3. THE PROLOGUE POSITION: bindStorageBuffer lands after bindUniforms,
 *      before the vertex buffers — and ONLY for storage commands (the
 *      pre-193 stream for everyone else is byte-identical);
 *   4. THE MULTI-DRAW TIER: a same-command run binds the storage ONCE (the
 *      prologue) — members 2..N are bare draws (the tier discipline);
 *   5. THE RECORDING FACADE records the call (the stream pins).
 */

const WGSL_PLAIN = `
struct Params { u_mvp: mat4x4<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`

const WGSL_STORAGE = `
struct Params { u_mvp: mat4x4<f32>, u_rank0: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(2) @binding(0) var<storage, read> sceneBits: array<u32>;
@vertex fn vs_main(@location(0) position: vec3<f32>, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
  let rank = params.u_rank0 + ii
  let word = sceneBits[rank >> 5u]
  let visible = (word & (1u << (rank & 31u))) != 0u
  var pos = params.u_mvp * vec4<f32>(position, 1.0)
  if (!visible) { pos = vec4<f32>(2.0, 2.0, 2.0, 1.0) }
  return pos;
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`

const CLEAR = [{ color: [0.1, 0.1, 0.12, 1] as const, depth: null }]

function tapeOf(commandId: number) {
  const writer = createTapeWriter(16)
  writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  writer.emit(OpCode.Draw, commandId, 0, 3, 4)
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  return parseTape(serializeTape(writer))
}

function setup(spec: WgpuDrawSpec) {
  const arena = createSliceArena(8192)
  const ctx = createWgpuContext(arena)
  const command = compileWgslSpec(spec, ctx)
  const { gpu, calls } = createRecordingGPU()
  const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: CLEAR })
  return { command, calls, executor }
}

describe('Task 193 (theory A): the bit-discard storage binding', () => {
  it('REFLECTION: read-only storage declarations are parsed (name/group/binding)', () => {
    const r = reflectWgsl(WGSL_STORAGE)
    expect(r.storages.length).toBe(1)
    expect(r.storages[0]).toEqual({ name: 'sceneBits', group: 2, binding: 0 })
    // a read_write storage is NOT the render slot (the vertex stage may
    // only read — the scan is read-only by contract)
    const rw = reflectWgsl(WGSL_STORAGE.replace('var<storage, read>', 'var<storage, read_write>'))
    expect(rw.storages.length).toBe(0)
    // no storages in a plain shader
    expect(reflectWgsl(WGSL_PLAIN).storages.length).toBe(0)
    // the attribute order inside the declaration is free
    const flipped = reflectWgsl(WGSL_STORAGE.replace('@group(2) @binding(0)', '@binding(0) @group(2)'))
    expect(flipped.storages.length).toBe(1)
    expect(flipped.storages[0].group).toBe(2)
    expect(flipped.storages[0].binding).toBe(0)
  })

  it('THE COMPILE CONTRACT: mismatches are loud, never a silent unbound group', () => {
    const ok = setup({
      shader: { wgsl: WGSL_STORAGE }, count: 3, instances: 4,
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      storage: { bufferId: 42 },
    })
    expect((ok.command as unknown as { storageId?: number }).storageId).toBe(42)

    expect(() => setup({ shader: { wgsl: WGSL_STORAGE }, count: 3 })).toThrow(/spec has no storage/)
    expect(() => setup({
      shader: { wgsl: WGSL_STORAGE }, count: 3, storage: { bufferId: 42 },
    })).not.toThrow() // attributes optional in the mock path (default data)
    expect(() => setup({
      shader: { wgsl: WGSL_PLAIN }, count: 3, storage: { bufferId: 42 },
    })).toThrow(/declares no/)
    expect(() => setup({
      shader: {
        wgsl: WGSL_STORAGE.replace('@group(2) @binding(0)', '@group(3) @binding(0)'),
      }, count: 3, storage: { bufferId: 42 },
    })).toThrow(/group 3/)
    expect(() => setup({
      shader: {
        wgsl: WGSL_STORAGE + '\n@group(2) @binding(1) var<storage, read> extra: array<u32>;',
      }, count: 3, storage: { bufferId: 42 },
    })).toThrow(/exactly one/)
  })

  it('THE PROLOGUE POSITION: after bindUniforms, before the vertex buffers; others byte-identical', () => {
    const on = setup({
      shader: { wgsl: WGSL_STORAGE }, count: 3, instances: 4,
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      storage: { bufferId: 42 },
    })
    on.executor.run(tapeOf(on.command.id))
    const iUse = on.calls.indexOf('usePipeline(1)')
    const iUniforms = on.calls.indexOf('bindUniforms(0)')
    const iStorage = on.calls.indexOf('bindStorageBuffer(42)')
    const iVertex = on.calls.indexOf('bindVertexBuffer(0,9,3)')
    expect(iUse).toBeGreaterThanOrEqual(0)
    expect(iStorage).toBeGreaterThanOrEqual(0)
    expect(iUniforms).toBeLessThan(iStorage)
    expect(iStorage).toBeLessThan(iVertex)
    // the pre-193 stream: a plain command has NO new calls
    const off = setup({
      shader: { wgsl: WGSL_PLAIN }, count: 3, instances: 4,
      attributes: { position: { data: new Float32Array(9), size: 3 } },
    })
    off.executor.run(tapeOf(off.command.id))
    expect(off.calls.some(c => c.startsWith('bindStorageBuffer'))).toBe(false)
  })

  it('THE MULTI-DRAW TIER: a same-command run binds the storage ONCE (prologue)', () => {
    const arena = createSliceArena(8192)
    const ctx = createWgpuContext(arena)
    const spec: WgpuDrawSpec = {
      shader: { wgsl: WGSL_STORAGE }, count: 3, instances: 4,
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      storage: { bufferId: 42 },
    }
    const command = compileWgslSpec(spec, ctx)
    const { gpu, calls } = createRecordingGPU()
    // a capable facade — the indirect shape (the run batches)
    const multi: typeof gpu = { ...gpu, multiDraw: () => true }
    const executor = createGpuExecutor({ gpu: multi, arena, commands: ctx.commands, clears: CLEAR })
    const writer = createTapeWriter(16)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    for (let k = 0; k < 4; k++) writer.emit(OpCode.Draw, command.id, 0, 3, 4)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(parseTape(serializeTape(writer)))
    expect(calls.filter(c => c === 'bindStorageBuffer(42)').length).toBe(1)
    expect(calls.filter(c => c.startsWith('draw(')).length).toBe(0) // all rode the batch
  })

  it('THE RECORDING FACADE records the call (the stream pin)', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.bindStorageBuffer(7)
    expect(calls).toEqual(['bindStorageBuffer(7)'])
  })
})
