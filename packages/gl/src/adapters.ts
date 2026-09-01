import type { TapeWriter } from '@rune/core'
import type { DrawSpec, Dynamic, UniformValue, PipelineDesc } from '@rune/webgl2'
import { createCompileContext, compileDrawSpec } from '@rune/webgl2'
import { createUniformArena } from '@rune/core'
import type { WgpuDrawSpec } from '@rune/webgpu'
import { createWgpuContext, compileWgslSpec } from '@rune/webgpu'
import { createSliceArena } from '@rune/webgpu'

/** Переносимый dual-source спек: один и тот же на обоих бэкендах. */
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

/** Скомпилированное на конкретном бэкенде: запись в ленту + имена привязок. */
export interface CompiledOnBackend {
  readonly bindings: readonly string[]
  record(props: any, ctx: any, writer: TapeWriter): void
}

/** Адаптер бэкенда: создание контекста и компиляция переносимого спека. */
export interface BackendAdapter {
  readonly kind: 'webgl2' | 'webgpu'
  create(): unknown
  compile(context: unknown, spec: PortableSpec): CompiledOnBackend
}

/** Адаптер WebGL2: арена юниформов + codegen-контекст. */
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

/** Адаптер WebGPU: slice-арена + dynamic-offsets контекст. */
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
    // depth/raster структурно совместимы; blend/frontFace — достояние
    // state-программы WebGL2 (tape-компилятор читает только depth/raster).
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
