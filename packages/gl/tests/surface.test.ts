import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'

/**
 * Surface + pass — единая структура полноэкранных проходов (WebGL2-путь).
 * Порядок вызовов на рекордере: цепочка постпроцессинга
 * capture(сцена → surface) → pass(surface → канвас).
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

function setup() {
  const recording = createRecordingGL()
  const renderer = createWebGL2Renderer({
    canvas: fakeCanvas(),
    createGL: () => recording.gl,
    observeResize: false,
    now: () => 0,
    requestFrame: () => () => {},
  })
  return { renderer, calls: recording.calls }
}

const SCENE_VERT = `#version 300 es
layout(location = 0) in vec3 position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`

const SCENE_FRAG = `#version 300 es
precision mediump float;
out vec4 o_color;
void main() { o_color = vec4(0.4, 0.6, 0.9, 1.0); }`

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

/** Фрагмент прохода-показа: вход-сэмплер (бывший image()). */
const PRESENT_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_src;
in vec2 v_uv;
out vec4 o_color;
void main() { o_color = texture(u_src, v_uv); }`

/** Фрагмент генератора: без входов (бывший frag()). */
const GEN_FRAG = `#version 300 es
precision mediump float;
uniform float u_time;
uniform vec2 u_resolution;
in vec2 v_uv;
out vec4 o_color;
void main() {
  float wave = 0.5 + 0.5 * sin((v_uv.x + v_uv.y) * 20.0 + u_time * 3.0);
  o_color = vec4(vec3(wave) * u_resolution.x * 0.0 + wave, 1.0);
}`

describe('surface/pass — WebGL2', () => {
  it('полная цепочка постпроцессинга: capture → present, порядок целей верен', () => {
    const { renderer, calls } = setup()
    const scene = renderer.command({
      shader: { glsl: { vertex: SCENE_VERT, fragment: SCENE_FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => IDENTITY },
      count: 3,
    })
    const surface = renderer.surface({ width: 256, height: 256, depth: true })
    const present = renderer.pass(PRESENT_FRAG, { inputs: { u_src: surface.texture } })

    renderer.frame((_ctx, record) => {
      record(surface.capture(scene), {})
      record(present)
    })
    renderer.step(16)

    // Поверхность создана: текстура + цель с глубиной
    expect(calls).toContain('createTexture(256,256)')
    expect(calls).toContain('createTarget(1,256,256,depth)')

    // Порядок кадра: clear канваса → bindTarget(surface,clear) → сцена →
    // bindTarget(канвас) → полноэкранный проход
    const clearAt = calls.findIndex(call => call.startsWith('clear('))
    const intoSurfaceAt = calls.indexOf('bindTarget(1,1)')
    const sceneDrawAt = calls.indexOf('drawArrays(triangles,0,3,1)')
    const backToCanvasAt = calls.indexOf('bindTarget(0,0)')
    const presentDrawAt = calls.indexOf('drawArrays(triangles,0,6,1)')
    expect(clearAt).toBeGreaterThanOrEqual(0)
    expect(intoSurfaceAt).toBeGreaterThan(clearAt)
    expect(sceneDrawAt).toBeGreaterThan(intoSurfaceAt)
    expect(backToCanvasAt).toBeGreaterThan(sceneDrawAt)
    expect(presentDrawAt).toBeGreaterThan(backToCanvasAt)
    renderer.stop()
  })

  it('present (image-случай): вход-сэмплер на юните 0, квад 6 вершин, без bindTarget', () => {
    const { renderer, calls } = setup()
    const texture = renderer.texture(64, 64)
    const present = renderer.pass(PRESENT_FRAG, { inputs: { u_src: texture } })
    renderer.frame((_ctx, record) => record(present))
    renderer.step(16)

    expect(calls).toContain('bindTexture(1,0)') // textureId 1, юнит 0
    expect(calls).toContain('uniform1i(u_src,0)')
    expect(calls).toContain('drawArrays(triangles,0,6,1)')
    // Чисто канвасный кадр: переключений цели нет (skip в фасаде)
    expect(calls.filter(call => call.startsWith('bindTarget(')).length).toBe(0)
    renderer.stop()
  })

  it('генерация (frag-случай): проход В поверхность, билтин u_time обновляется', () => {
    const { renderer, calls } = setup()
    const surface = renderer.surface({ width: 128, height: 128 })
    const gen = surface.pass(GEN_FRAG)
    renderer.frame((_ctx, record) => record(gen))
    renderer.step(500)

    // Цель — поверхность, без очистки (квад перекрывает всё)
    expect(calls).toContain('bindTarget(1,0)')
    expect(calls).toContain('drawArrays(triangles,0,6,1)')
    // Билтин u_time подставлен и получил время кадра (500 мс = 0.5 с,
    // точно представимо во float32 — без округлений в строке вызова)
    const timeCalls = calls.filter(call => call.startsWith('uniform1f(u_time,'))
    expect(timeCalls.length).toBeGreaterThan(0)
    expect(timeCalls[0]).toBe('uniform1f(u_time,0.5)')
    // Билтин u_resolution — размер ЦЕЛИ (поверхности, не канваса)
    expect(calls).toContain('uniform2fv(u_resolution)')
    renderer.stop()
  })

  it('capture(clear: false) не чистит поверхность; по умолчанию — чистит', () => {
    const { renderer, calls } = setup()
    const scene = renderer.command({
      shader: { glsl: { vertex: SCENE_VERT, fragment: SCENE_FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => IDENTITY },
      count: 3,
    })
    const surface = renderer.surface({ width: 64, height: 64 })
    renderer.frame((_ctx, record) => {
      record(surface.capture(scene, { clear: false }), {})
    })
    renderer.step(16)
    expect(calls).toContain('bindTarget(1,0)')
    expect(calls).not.toContain('bindTarget(1,1)')
    renderer.stop()
  })

  it('pingpong из двух поверхностей: A → B → канвас, цели чередуются без чтения цели', () => {
    const { renderer, calls } = setup()
    const a = renderer.surface({ width: 64, height: 64 })
    const b = renderer.surface({ width: 64, height: 64 })
    const gen = a.pass(GEN_FRAG)
    const toB = b.pass(PRESENT_FRAG, { inputs: { u_src: a.texture } })
    const toCanvas = renderer.pass(PRESENT_FRAG, { inputs: { u_src: b.texture } })
    renderer.frame((_ctx, record) => {
      record(gen)
      record(toB)
      record(toCanvas)
    })
    renderer.step(16)

    const order = calls.filter(call => call.startsWith('bindTarget('))
    // Поверхности получили targetId 1 и 2; порядок: A → B → канвас
    expect(order).toEqual(['bindTarget(1,0)', 'bindTarget(2,0)', 'bindTarget(0,0)'])
    // Вход второго прохода — текстура первой поверхности
    expect(calls).toContain('bindTexture(1,0)')
    renderer.stop()
  })

  it('второй кадр: возврат на канвас гарантирован (BeginPass), сцена снова в поверхность', () => {
    const { renderer, calls } = setup()
    const scene = renderer.command({
      shader: { glsl: { vertex: SCENE_VERT, fragment: SCENE_FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => IDENTITY },
      count: 3,
    })
    const surface = renderer.surface({ width: 64, height: 64, depth: true })
    const present = renderer.pass(PRESENT_FRAG, { inputs: { u_src: surface.texture } })
    renderer.frame((_ctx, record) => {
      record(surface.capture(scene), {})
      record(present)
    })
    renderer.step(16)
    renderer.step(32)

    // Кадр 2: clear канваса после возврата с поверхности — до новой записи сцены
    const clears = calls.map((call, at) => ({ call, at })).filter(c => c.call.startsWith('clear('))
    expect(clears.length).toBe(2)
    const secondClearAt = clears[1].at
    const secondIntoSurfaceAt = calls.indexOf('bindTarget(1,1)', secondClearAt)
    expect(secondIntoSurfaceAt).toBeGreaterThan(secondClearAt)
    renderer.stop()
  })
})
