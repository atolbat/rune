import type { TapeWriter } from '@rune/core'
import type { DrawSpec, Dynamic, UniformValue, PipelineDesc } from '@rune/webgl2'
import { createCompileContext, compileDrawSpec } from '@rune/webgl2'
import { createUniformArena } from '@rune/core'
import type { WgpuDrawSpec } from '@rune/webgpu'
import { createWgpuContext, compileWgslSpec } from '@rune/webgpu'
import { createSliceArena } from '@rune/webgpu'

/** Portable dual-source spec: the same on both backends. */
export interface PortableSpec {
  readonly shader: {
    readonly glsl: { readonly vertex: string; readonly fragment: string }
    readonly wgsl: string
  }
  readonly pipeline?: PipelineDesc
  readonly uniforms?: Readonly<Record<string, Dynamic<UniformValue>>>
  readonly count: Dynamic<number>
  readonly instances?: Dynamic<number>
}

/** Compiled on a specific backend: a tape record function + binding names. */
export interface CompiledOnBackend {
  readonly bindings: readonly string[]
  record(props: any, ctx: any, writer: TapeWriter): void
}

/** Backend adapter: context creation and portable spec compilation. */
export interface BackendAdapter {
  readonly kind: 'webgl2' | 'webgpu'
  create(): unknown
  compile(context: unknown, spec: PortableSpec): CompiledOnBackend
}

/** WebGL2 adapter: uniform arena + codegen context. */
export function webgl2Adapter(): BackendAdapter {
  return {
    kind: 'webgl2',
    create: () => createCompileContext(createUniformArena(), 'codegen'),
    compile: (context, spec) => {
      const ctx = context as ReturnType<typeof createCompileContext>
      const command = compileDrawSpec(toWebgl2Spec(spec), ctx)
      return {
        bindings: command.bindings.map(binding => binding.name),
        record: (props, frameCtx, writer) => command.record(props, frameCtx, writer),
      }
    },
  }
}

/** WebGPU adapter: slice arena + dynamic-offsets context. */
export function webgpuAdapter(): BackendAdapter {
  return {
    kind: 'webgpu',
    create: () => createWgpuContext(createSliceArena(1 << 20)),
    compile: (context, spec) => {
      const ctx = context as ReturnType<typeof createWgpuContext>
      const command = compileWgslSpec(toWebgpuSpec(spec), ctx)
      return {
        bindings: command.bindings.map(binding => binding.name),
        record: (props, frameCtx, writer) => command.record(props, frameCtx, writer),
      }
    },
  }
}

function toWebgl2Spec(spec: PortableSpec): DrawSpec {
  return {
    shader: { glsl: spec.shader.glsl },
    // depth/raster are structurally compatible; blend/frontFace belong to
    // the WebGL2 state program (the tape compiler reads only depth/raster).
    pipeline: spec.pipeline as DrawSpec['pipeline'],
    uniforms: spec.uniforms,
    count: spec.count as DrawSpec['count'],
    instances: spec.instances as DrawSpec['instances'],
  }
}

function toWebgpuSpec(spec: PortableSpec): WgpuDrawSpec {
  return {
    shader: { wgsl: spec.shader.wgsl },
    pipeline: spec.pipeline as WgpuDrawSpec['pipeline'],
    uniforms: spec.uniforms,
    count: spec.count as WgpuDrawSpec['count'],
    instances: spec.instances as WgpuDrawSpec['instances'],
  }
}
