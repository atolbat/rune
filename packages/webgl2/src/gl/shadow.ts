import type { BlendEquation, BlendFactor, CullFace, DepthFunc, FrontFace } from './facade.ts'

/** The minimal structural target of state actions: raw-state methods +
 *  useProgram. Satisfied both by the full legacy facade and by the extended
 *  recordingGL recorder (stateProgram.ts uses the same type). */
export interface StateProgramGL {
  enableDepthTest(): void
  disableDepthTest(): void
  depthMask(enabled: boolean): void
  depthFunc(fn: DepthFunc): void
  enableBlend(): void
  disableBlend(): void
  blendFunc(src: BlendFactor, dst: BlendFactor): void
  blendEquation(eq: BlendEquation): void
  enableCull(): void
  disableCull(): void
  cullFace(face: CullFace): void
  frontFace(order: FrontFace): void
  useProgram(programId: number): void
}

/** Shadow copy of the GL state: the source of truth for the minimal diff. */
export interface GLShadow {
  depthTest: 0 | 1
  depthMask: 0 | 1
  depthFunc: DepthFunc | ''
  blend: 0 | 1
  blendSrc: BlendFactor | ''
  blendDst: BlendFactor | ''
  blendEq: BlendEquation | ''
  cull: 0 | 1
  cullFace: CullFace | ''
  frontFace: FrontFace | ''
  program: number
}

/** Creates a "nothing is set" shadow state. */
export function createGLShadow(): GLShadow {
  return {
    depthTest: 0, depthMask: 0, depthFunc: '',
    blend: 0, blendSrc: '', blendDst: '', blendEq: '',
    cull: 0, cullFace: '', frontFace: '',
    program: -1,
  }
}

/** One pipeline state as an action over the facade. */
export type StateAction =
  | { readonly call: 'depthTest'; readonly on: boolean }
  | { readonly call: 'depthMask'; readonly on: boolean }
  | { readonly call: 'depthFunc'; readonly fn: DepthFunc }
  | { readonly call: 'blend'; readonly on: boolean }
  | { readonly call: 'blendFunc'; readonly src: BlendFactor; readonly dst: BlendFactor }
  | { readonly call: 'blendEquation'; readonly eq: BlendEquation }
  | { readonly call: 'cull'; readonly on: boolean }
  | { readonly call: 'cullFace'; readonly face: CullFace }
  | { readonly call: 'frontFace'; readonly order: FrontFace }
  | { readonly call: 'program'; readonly id: number }

/** Applies an action with a diff against the shadow (interpreter). */
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
    case 'blendEquation':
      if (shadow.blendEq !== action.eq) {
        shadow.blendEq = action.eq
        gl.blendEquation(action.eq)
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

/** Applies a list of actions in a row (interpreter). */
export function applyActions(actions: readonly StateAction[], shadow: GLShadow, gl: StateProgramGL): void {
  for (let i = 0; i < actions.length; i++) applyAction(actions[i], shadow, gl)
}
