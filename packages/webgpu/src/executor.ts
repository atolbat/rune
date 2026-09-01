/**
 * Исполнитель WG-лент: аплоады слайсов ДО пасса (упорядочено с submit —
 * GPU не читает то, что CPU пишет), затем пасс с dynamic offsets.
 * Порядок кадра: uploadUniforms → beginPass → draw → endPass → submit.
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

  /** Первый проход: грязные слайсы в UBO до открытия пасса. */
  function uploadDirtySlices(view: TapeView): void {
    for (let at = 0; at < view.count; at++) {
      if (view.op[at] !== 2) continue
      const command = commands[view.a[at]] as RichWgpuCommand | undefined
      if (command === undefined || !command.needsUpload) continue
      // Аплоад — фактические байты юниформов (без хвостовой набивки среза
      // до dynamic-offset гранулярности): writeBuffer допускает кратный 4
      // размер, шейдер читает ровно столько, сколько объявлено в struct.
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
      // M5 (Task 73): интерливинг фида — rich-слот {size, stride, offset};
      // tight-атрибуты — число (arrayStride = size*4, offset 0).
      // Task 75: step='instance' → stepMode пайплайна; desc — blend/depth/
      // cull/primitive из GpuPipelineDesc (реально применяется в buildPipeline).
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

/** Внутренняя форма команды (компилятор пишет эти поля). */
interface RichWgpuCommand extends WgpuCommand {
  readonly pipelineId: number
  readonly wgsl: string
  readonly attrOrder: readonly { readonly data: Float32Array; readonly size: number; readonly stride?: number; readonly offset?: number; readonly step?: 'vertex' | 'instance' }[]
  readonly pipeline: GpuPipelineDesc
  readonly textureIds: readonly number[]
  readonly sliceOffset: number
  readonly sliceBytes: number
  /** Фактические байты юниформов (аплоад без хвостовой набивки среза). */
  readonly uniformBytes?: number
  needsUpload: boolean
  pipelineReady: boolean
}
