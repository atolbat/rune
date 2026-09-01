import type { BlendFactor, CullFace, DepthFunc, FrontFace } from './facade.ts'

/** Минимальная структурная цель state-действий: методы сырого состояния +
 *  useProgram. Удовлетворяется и полным легаси-фасадом, и расширенным
 *  рекордером recordingGL (stateProgram.ts использует тот же тип). */
export interface StateProgramGL {
  enableDepthTest(): void
  disableDepthTest(): void
  depthMask(enabled: boolean): void
  depthFunc(fn: DepthFunc): void
  enableBlend(): void
  disableBlend(): void
  blendFunc(src: BlendFactor, dst: BlendFactor): void
  enableCull(): void
  disableCull(): void
  cullFace(face: CullFace): void
  frontFace(order: FrontFace): void
  useProgram(programId: number): void
}

/** Теневая копия GL-состояния: источник истины для минимального diff. */
export interface GLShadow {
  depthTest: 0 | 1
  depthMask: 0 | 1
  depthFunc: DepthFunc | ''
  blend: 0 | 1
  blendSrc: BlendFactor | ''
  blendDst: BlendFactor | ''
  cull: 0 | 1
  cullFace: CullFace | ''
  frontFace: FrontFace | ''
  program: number
}

/** Создаёт теневое состояние «ничего не установлено». */
export function createGLShadow(): GLShadow {
  return {
    depthTest: 0, depthMask: 0, depthFunc: '',
    blend: 0, blendSrc: '', blendDst: '',
    cull: 0, cullFace: '', frontFace: '',
    program: -1,
  }
}

/** Одно состояние пайплайна как действие над фасадом. */
export type StateAction =
  | { readonly call: 'depthTest'; readonly on: boolean }
  | { readonly call: 'depthMask'; readonly on: boolean }
  | { readonly call: 'depthFunc'; readonly fn: DepthFunc }
  | { readonly call: 'blend'; readonly on: boolean }
  | { readonly call: 'blendFunc'; readonly src: BlendFactor; readonly dst: BlendFactor }
  | { readonly call: 'cull'; readonly on: boolean }
  | { readonly call: 'cullFace'; readonly face: CullFace }
  | { readonly call: 'frontFace'; readonly order: FrontFace }
  | { readonly call: 'program'; readonly id: number }

/** Применяет действие с diff относительно тени (интерпретатор). */
export function applyAction(action: StateAction, shadow: GLShadow, gl: StateProgramGL): void {
  switch (action.call) {
    case 'depthTest':
      if (shadow.depthTest !== (action.on ? 1 : 0)) {
        shadow.depthTest = action.on ? 1 : 0
        if (action.on) gl.enableDepthTest(); else gl.disableDepthTest()
      }
      break
    case 'depthMask':
      if (shadow.depthMask !== (action.on ? 1 : 0)) {
        shadow.depthMask = action.on ? 1 : 0
        gl.depthMask(action.on)
      }
      break
    case 'depthFunc':
      if (shadow.depthFunc !== action.fn) {
        shadow.depthFunc = action.fn
        gl.depthFunc(action.fn)
      }
      break
    case 'blend':
      if (shadow.blend !== (action.on ? 1 : 0)) {
        shadow.blend = action.on ? 1 : 0
        if (action.on) gl.enableBlend(); else gl.disableBlend()
      }
      break
    case 'blendFunc':
      if (shadow.blendSrc !== action.src || shadow.blendDst !== action.dst) {
        shadow.blendSrc = action.src
        shadow.blendDst = action.dst
        gl.blendFunc(action.src, action.dst)
      }
      break
    case 'cull':
      if (shadow.cull !== (action.on ? 1 : 0)) {
        shadow.cull = action.on ? 1 : 0
        if (action.on) gl.enableCull(); else gl.disableCull()
      }
      break
    case 'cullFace':
      if (shadow.cullFace !== action.face) {
        shadow.cullFace = action.face
        gl.cullFace(action.face)
      }
      break
    case 'frontFace':
      if (shadow.frontFace !== action.order) {
        shadow.frontFace = action.order
        gl.frontFace(action.order)
      }
      break
    case 'program':
      if (shadow.program !== action.id) {
        shadow.program = action.id
        gl.useProgram(action.id)
      }
      break
  }
}

/** Применяет список действий подряд (интерпретатор). */
export function applyActions(actions: readonly StateAction[], shadow: GLShadow, gl: StateProgramGL): void {
  for (let i = 0; i < actions.length; i++) applyAction(actions[i], shadow, gl)
}
