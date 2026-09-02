import type { BlendFactor, CullFace, DepthFunc, FrontFace } from '../gl/facade.ts'
import type { StateAction, StateProgramGL } from '../gl/shadow.ts'
import { applyActions } from '../gl/shadow.ts'
import type { GLShadow } from '../gl/shadow.ts'

export type { StateProgramGL } from '../gl/shadow.ts'

/** Description of the rasterization state of a pipeline (M2 subset). */
export interface PipelineDesc {
  readonly depth?: { readonly test?: DepthFunc; readonly write?: boolean } | false
  readonly blend?: { readonly src: BlendFactor; readonly dst: BlendFactor } | false
  readonly raster?: {
    readonly cull?: CullFace | 'none'
    readonly frontFace?: FrontFace
  }
}

/** An applied state program: two execution modes — one result. */
export type StateProgram = (gl: StateProgramGL, shadow: GLShadow) => void

export type StateMode = 'interpret' | 'codegen'

/** Compiles a pipeline state program in the selected mode. */
export function compileStateProgram(
  pipeline: PipelineDesc,
  programId: number,
  mode: StateMode,
): StateProgram {
  const actions = collectActions(pipeline, programId)
  if (mode === 'codegen') return compileCodegen(actions)
  return (gl, shadow) => applyActions(actions, shadow, gl)
}

/** The default actions follow the regl convention: depth less+write. */
function collectActions(pipeline: PipelineDesc, programId: number): StateAction[] {
  const actions: StateAction[] = []
  emitDepth(pipeline.depth, actions)
  emitBlend(pipeline.blend, actions)
  emitRaster(pipeline.raster, actions)
  actions.push({ call: 'program', id: programId })
  return actions
}

function emitDepth(depth: PipelineDesc['depth'], actions: StateAction[]): void {
  if (depth === false) return
  const test = depth?.test ?? 'less'
  const write = depth?.write ?? true
  actions.push({ call: 'depthTest', on: true })
  actions.push({ call: 'depthFunc', fn: test })
  actions.push({ call: 'depthMask', on: write })
}

function emitBlend(blend: PipelineDesc['blend'], actions: StateAction[]): void {
  if (blend === false || blend === undefined) return
  actions.push({ call: 'blend', on: true })
  actions.push({ call: 'blendFunc', src: blend.src, dst: blend.dst })
}

function emitRaster(raster: PipelineDesc['raster'], actions: StateAction[]): void {
  if (raster === undefined) return
  emitCull(raster.cull, actions)
  if (raster.frontFace !== undefined) actions.push({ call: 'frontFace', order: raster.frontFace })
}

function emitCull(cull: CullFace | 'none' | undefined, actions: StateAction[]): void {
  if (cull === undefined || cull === 'none') return
  actions.push({ call: 'cull', on: true })
  actions.push({ call: 'cullFace', face: cull })
}

/** Codegen: a specialized function with inline comparisons (turbo mode). */
function compileCodegen(actions: readonly StateAction[]): StateProgram {
  const body = actions.map(emitGuard).join('\n')
  const factory = new Function('gl', 'S', body) as StateProgram
  return factory
}

function emitGuard(action: StateAction): string {
  switch (action.call) {
    case 'depthTest':
      return `if(S.depthTest!==${action.on ? 1 : 0}){S.depthTest=${action.on ? 1 : 0};gl.${action.on ? 'enableDepthTest' : 'disableDepthTest'}()}`
    case 'depthMask':
      return `if(S.depthMask!==${action.on ? 1 : 0}){S.depthMask=${action.on ? 1 : 0};gl.depthMask(${action.on})}`
    case 'depthFunc':
      return `if(S.depthFunc!=='${action.fn}'){S.depthFunc='${action.fn}';gl.depthFunc('${action.fn}')}`
    case 'blend':
      return `if(S.blend!==${action.on ? 1 : 0}){S.blend=${action.on ? 1 : 0};gl.${action.on ? 'enableBlend' : 'disableBlend'}()}`
    case 'blendFunc':
      return `if(S.blendSrc!=='${action.src}'||S.blendDst!=='${action.dst}'){S.blendSrc='${action.src}';S.blendDst='${action.dst}';gl.blendFunc('${action.src}','${action.dst}')}`
    case 'cull':
      return `if(S.cull!==${action.on ? 1 : 0}){S.cull=${action.on ? 1 : 0};gl.${action.on ? 'enableCull' : 'disableCull'}()}`
    case 'cullFace':
      return `if(S.cullFace!=='${action.face}'){S.cullFace='${action.face}';gl.cullFace('${action.face}')}`
    case 'frontFace':
      return `if(S.frontFace!=='${action.order}'){S.frontFace='${action.order}';gl.frontFace('${action.order}')}`
    case 'program':
      return `if(S.program!==${action.id}){S.program=${action.id};gl.useProgram(${action.id})}`
  }
}
