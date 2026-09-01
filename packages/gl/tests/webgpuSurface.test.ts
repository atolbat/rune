import { describe, expect, it } from 'bun:test'
import { createWebGpuRenderer } from '../src/index.ts'
import { createRecordingGPU } from '@rune/webgpu'

/**
 * Surface + pass — WebGPU-путь на рекордер-фасаде: переключение целей
 * внутри энкодера (пасс на поверхность → пасс на канвас), формат
 * поверхностей — canvas (совместимость пайплайнов), генерация вершинной
 * стадии для фрагмента пользователя.
 */

const SCENE_WGSL = `struct Params {
  u_mvp : mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;

@vertex
fn vsMain(@location(0) inPos : vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(inPos, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  return vec4<f32>(0.4, 0.6, 0.9, 1.0);
}`

/** Фрагмент показа: сэмплер + текстура (бывший image()). */
const PRESENT_WGSL = `@group(1) @binding(0) var u_srcSampler : sampler;
@group(1) @binding(1) var u_src : texture_2d<f32>;

@fragment
fn fsMain(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(u_src, u_srcSampler, uv);
}`

/** Фрагмент генератора с билтинами (бывший frag()). */
const GEN_WGSL = `struct Params {
  u_time : f32,
  u_resolution : vec2<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;

@fragment
fn fsMain(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let wave = 0.5 + 0.5 * sin((uv.x + uv.y) * 20.0 + params.u_time * 3.0);
  return vec4<f32>(wave, wave, wave, 1.0);
}`

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as unknown as HTMLCanvasElement
}

async function setup() {
  const recording = createRecordingGPU()
  const renderer = await createWebGpuRenderer({
    canvas: fakeCanvas(),
    createGPU: async () => recording.gpu,
    observeResize: false,
    now: () => 0,
    requestFrame: () => () => {},
  })
  return { renderer, calls: recording.calls }
}

describe('surface/pass — WebGPU', () => {
  it('полная цепочка: сцена в поверхность → показ на канвас, порядок пассов верен', async () => {
    const { renderer, calls } = await setup()
    const scene = renderer.command({
      shader: { wgsl: SCENE_WGSL },
      uniforms: { u_mvp: () => IDENTITY },
      attributes: { inPos: { data: new Float32Array(9), size: 3 } },
      count: 3,
    })
    const surface = renderer.surface({ width: 256, height: 256, depth: true })
    const present = renderer.pass(PRESENT_WGSL, { inputs: { u_src: surface.texture } })

    renderer.frame((_ctx, record) => {
      record(surface.capture(scene), {})
      record(present)
    })
    renderer.step(16)

    // Поверхность: текстура формата канваса + цель с глубиной
    expect(calls).toContain('createTexture(256,256,canvas)')
    expect(calls).toContain('createTarget(1,256,256,depth)')

    // Порядок: beginPass(канвас) → bindTarget(поверхность) → draw сцены →
    // bindTarget(канвас) → draw прохода → endPass → submit
    const beginAt = calls.indexOf('beginPass(0)')
    const intoSurfaceAt = calls.indexOf('bindTarget(1,1)')
    const sceneDrawAt = calls.findIndex(call => call.startsWith('draw(3,1)'))
    const backToCanvasAt = calls.indexOf('bindTarget(0,0)')
    const presentDrawAt = calls.findIndex(call => call.startsWith('draw(6,1)'))
    const endAt = calls.indexOf('endPass')
    expect(beginAt).toBeGreaterThanOrEqual(0)
    expect(intoSurfaceAt).toBeGreaterThan(beginAt)
    expect(sceneDrawAt).toBeGreaterThan(intoSurfaceAt)
    expect(backToCanvasAt).toBeGreaterThan(sceneDrawAt)
    expect(presentDrawAt).toBeGreaterThan(backToCanvasAt)
    expect(endAt).toBeGreaterThan(presentDrawAt)
    expect(calls[calls.length - 1]).toBe('submit')
    renderer.stop()
  })

  it('проход в поверхность (frag-случай): пайплайн [2x2], билтин-юниформы в слайсе', async () => {
    const { renderer, calls } = await setup()
    const surface = renderer.surface({ width: 128, height: 128 })
    const gen = surface.pass(GEN_WGSL)
    renderer.frame((_ctx, record) => record(gen))
    renderer.step(100)

    expect(calls).toContain('bindTarget(1,0)')
    // Пайплайн прохода: два vec2-атрибута квада, без текстур
    expect(calls.some(call => /^ensurePipeline\(1, \[2x2\]\)$/.test(call))).toBe(true)
    expect(calls).toContain('draw(6,1)')
    renderer.stop()
  })

  it('вход прохода — текстура поверхности: bindTexture ДО draw, один вход', async () => {
    const { renderer, calls } = await setup()
    const surface = renderer.surface({ width: 64, height: 64 })
    const present = renderer.pass(PRESENT_WGSL, { inputs: { u_src: surface.texture } })
    renderer.frame((_ctx, record) => record(present))
    renderer.step(16)

    const bindTextureAt = calls.indexOf('bindTexture(1)')
    const drawAt = calls.findIndex(call => call.startsWith('draw(6,1)'))
    expect(bindTextureAt).toBeGreaterThanOrEqual(0)
    expect(drawAt).toBeGreaterThan(bindTextureAt)
    expect(calls.filter(call => call.startsWith('bindTexture(')).length).toBe(1)
    renderer.stop()
  })

  it('второй вход в WebGPU-проходе — внятная ошибка v1', async () => {
    const { renderer } = await setup()
    const a = renderer.surface({ width: 32, height: 32 })
    const b = renderer.surface({ width: 32, height: 32 })
    expect(() => renderer.pass(PRESENT_WGSL, {
      inputs: { u_a: a.texture, u_b: b.texture },
    })).toThrow(/один текстурный вход/)
    renderer.stop()
  })

  it('второй кадр: цепочка снова проходит поверхность — цели не слипаются', async () => {
    const { renderer, calls } = await setup()
    const scene = renderer.command({
      shader: { wgsl: SCENE_WGSL },
      uniforms: { u_mvp: () => IDENTITY },
      attributes: { inPos: { data: new Float32Array(9), size: 3 } },
      count: 3,
    })
    const surface = renderer.surface({ width: 64, height: 64, depth: true })
    const present = renderer.pass(PRESENT_WGSL, { inputs: { u_src: surface.texture } })
    renderer.frame((_ctx, record) => {
      record(surface.capture(scene), {})
      record(present)
    })
    renderer.step(16)
    renderer.step(32)
    // Два полных цикла «в поверхность и обратно»
    expect(calls.filter(call => call === 'bindTarget(1,1)').length).toBe(2)
    expect(calls.filter(call => call === 'bindTarget(0,0)').length).toBe(2)
    expect(calls.filter(call => call === 'beginPass(0)').length).toBe(2)
    renderer.stop()
  })
})
