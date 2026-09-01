// @rune/webgl2 — бэкенд WebGL2: рефлексия GLSL, компилятор DrawSpec,
// исполнитель лент, настоящий и рекордерный фасады, state-программы.

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

// State-программы (M2): компиляция pipeline-дескриптора в диф-исполнитель
// поверх теневой копии GL-состояния. Два режима — один результат.
export { compileStateProgram } from './state/stateProgram.ts'
export type { PipelineDesc, StateProgram, StateMode, StateProgramGL } from './state/stateProgram.ts'
export { createGLShadow, applyActions, applyAction } from './gl/shadow.ts'
export type { GLShadow, StateAction } from './gl/shadow.ts'
export type { DepthFunc, CullFace, FrontFace, BlendFactor, PrimitiveKind } from './gl/facade.ts'
export { createCountingGL } from './gl/facade.ts'

export { probeGLCaps, makeGLProbe } from './capsProbe.ts'
export type { GLProbe } from './capsProbe.ts'

export { createGLGpuTimer } from './gpuTimer.ts'
