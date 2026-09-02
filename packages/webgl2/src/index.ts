// @rune/webgl2 — the WebGL2 backend: GLSL reflection, the DrawSpec compiler,
// the tape executor, real and recording facades, state programs.

export { reflectGlsl } from './glslReflect.ts'
export type { GlslReflection, UniformInfo, AttributeInfo, UniformGlType } from './glslReflect.ts'

export { compileDrawSpec, createCompileContext } from './command.ts'
export type {
  DrawSpec,
  CompiledCommand,
  GLCompileContext,
  UniformStrategy,
  UniformValue,
  TextureHandle,
  Dynamic,
  CommandBinding,
} from './command.ts'

export { createExecutor } from './executor.ts'
export type { GLExecutor, GLExecutorOptions } from './executor.ts'

export type { GLFacade, GLImageSource, GLTextureFormat } from './facade.ts'

export { createRealGL } from './realGL.ts'
export { createRecordingGL } from './recordingGL.ts'
export type { RecordingGL } from './recordingGL.ts'

// State programs (M2): compile a pipeline descriptor into a diff executor
// on top of a shadow copy of the GL state. Two modes — one result.
export { compileStateProgram } from './state/stateProgram.ts'
export type { PipelineDesc, StateProgram, StateMode, StateProgramGL } from './state/stateProgram.ts'
export { createGLShadow, applyActions, applyAction } from './gl/shadow.ts'
export type { GLShadow, StateAction } from './gl/shadow.ts'
export type { DepthFunc, CullFace, FrontFace, BlendFactor, PrimitiveKind } from './gl/facade.ts'
export { createCountingGL } from './gl/facade.ts'

export { probeGLCaps, makeGLProbe } from './capsProbe.ts'
export type { GLProbe } from './capsProbe.ts'

export { createGLGpuTimer } from './gpuTimer.ts'
