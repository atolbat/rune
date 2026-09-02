// @rune/webgpu — the WebGPU backend: WGSL reflection, slice arena,
// compiler, tape executor, real and recording facades.

/// <reference types="@webgpu/types" />

export { reflectWgsl } from './wgslReflect.ts'
export type { WgslReflection, WgslUniformInfo, WgslAttributeInfo, WgslTextureInfo } from './wgslReflect.ts'

export { createSliceArena } from './sliceArena.ts'
export type { SliceArena, SliceHandle, SliceSlot, SliceRange } from './sliceArena.ts'

// Task 68 (legacy restoration): WGSL lint and pipeline cache — the package's
// public tools (they were used by tests and external code before the Task 43
// environment reset).
export { lintWgsl } from './shader/wgslLint.ts'
export type { WgslLintProblem } from './shader/wgslLint.ts'
export { createPipelineCache, structuralKey } from './pipeline/pipelineCache.ts'
export type { GpuPipelineDesc, PipelineCache } from './pipeline/pipelineCache.ts'

export { compileWgslSpec, createWgpuContext } from './command.ts'
export type { WgpuDrawSpec, WgpuCommand, WgpuCompileContext, TextureHandle } from './command.ts'

export { createGpuExecutor } from './executor.ts'
export type { GpuTapeExecutor, GpuExecutorOptions } from './executor.ts'

export type { GPUFacade, GPUImageSource, GpuAttrSlot } from './facade.ts'
export { externalImageSize } from './facade.ts'

export { createRealGPU } from './realGPU.ts'
export { createRecordingGPU, createCountingGPU } from './recordingGPU.ts'
export type { RecordingGPU } from './recordingGPU.ts'

export { createGpuGpuTimer } from './gpuTimer.ts'
export type { GpuTimerHandle } from './gpuTimer.ts'

export { probeGPUCaps, makeGPUProbe } from './capsProbe.ts'
export type { GPUProbe } from './capsProbe.ts'
