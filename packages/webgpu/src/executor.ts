/**
 * Executor of WG tapes: slice uploads BEFORE the pass (ordered with submit —
 * the GPU does not read what the CPU writes), then the pass with dynamic offsets.
 * Frame order: uploadUniforms → beginPass → draw → endPass → submit.
 */

import type { TapeView } from '@rune/core'
import type { WgpuCommand } from './command.ts'
import type { SliceArena } from './sliceArena.ts'
import type { GPUFacade } from './facade.ts'
import type { GpuPipelineDesc } from './pipeline/pipelineCache.ts'

export interface GpuExecutorOptions {
  readonly gpu: GPUFacade
  readonly arena: SliceArena
  readonly commands: readonly WgpuCommand[]
  readonly clears: ReadonlyArray<{ readonly color: readonly [number, number, number, number]; readonly depth: number | null }>
}

export interface GpuTapeExecutor {
  run(view: TapeView): void
}

export function createGpuExecutor(options: GpuExecutorOptions): GpuTapeExecutor {
  const gpu = options.gpu
  const arena = options.arena
  const commands = options.commands

  function run(view: TapeView): void {
    uploadDirtySlices(view)
    for (let at = 0; at < view.count; at++) {
      const op = view.op[at]
      if (op === 1) beginPass()
      else if (op === 2) drawCommand(commands[view.a[at]] as RichWgpuCommand, view.c[at], view.d[at])
      else if (op === 3) gpu.endPass()
      else if (op === 4) gpu.bindTarget(view.a[at], view.b[at] === 1)
    }
    gpu.submit()
  }

  /** First pass: dirty slices into the UBO before the pass opens. */
  function uploadDirtySlices(view: TapeView): void {
    for (let at = 0; at < view.count; at++) {
      if (view.op[at] !== 2) continue
      const command = commands[view.a[at]] as RichWgpuCommand | undefined
      if (command === undefined || !command.needsUpload) continue
      // Upload — the actual uniform bytes (without the slice's trailing padding
      // up to dynamic-offset granularity): writeBuffer allows a multiple-of-4
      // size, the shader reads exactly as much as declared in the struct.
      const bytes = Math.min(command.uniformBytes ?? command.sliceBytes, command.sliceBytes)
      gpu.uploadUniforms(command.sliceOffset, arena.bytes.subarray(command.sliceOffset, command.sliceOffset + bytes))
      command.needsUpload = false
    }
  }

  function beginPass(): void {
    gpu.beginPass(0)
  }

  function drawCommand(command: RichWgpuCommand | undefined, count: number, instances: number): void {
    if (command === undefined) return
    if (!command.pipelineReady) {
      // M5 (Task 73): feed interleaving — rich slot {size, stride, offset};
      // tight attributes — a number (arrayStride = size*4, offset 0).
      // Task 75: step='instance' → pipeline stepMode; desc — blend/depth/
      // cull/primitive from GpuPipelineDesc (actually applied in buildPipeline).
      gpu.ensurePipeline(
        command.pipelineId,
        command.wgsl,
        command.attrOrder.map(a => a.stride !== undefined || a.step !== undefined
          ? { size: a.size, stride: a.stride, offset: a.offset ?? 0, step: a.step }
          : a.size),
        command.textureIds.length > 0,
        command.pipeline,
      )
      command.pipelineReady = true
    }
    gpu.usePipeline(command.pipelineId)
    gpu.bindUniforms(command.sliceOffset)
    command.attrOrder.forEach((attribute, slot) => gpu.bindVertexBuffer(slot, attribute.data, attribute.size))
    for (const textureId of command.textureIds) gpu.bindTexture(textureId)
    gpu.draw(count, instances)
  }

  return { run }
}

/** Internal command shape (the compiler writes these fields). */
interface RichWgpuCommand extends WgpuCommand {
  readonly pipelineId: number
  readonly wgsl: string
  readonly attrOrder: readonly { readonly data: Float32Array; readonly size: number; readonly stride?: number; readonly offset?: number; readonly step?: 'vertex' | 'instance' }[]
  readonly pipeline: GpuPipelineDesc
  readonly textureIds: readonly number[]
  readonly sliceOffset: number
  readonly sliceBytes: number
  /** Actual uniform bytes (upload without the slice's trailing padding). */
  readonly uniformBytes?: number
  needsUpload: boolean
  pipelineReady: boolean
}
