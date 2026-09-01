import { describe, expect, it } from 'bun:test'
import { lintWgsl } from '../src/index.ts'

const BAD_WGSL = `struct Params {
  u_mvp : mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;

@vertex
fn vsMain(@location(0) inPos : vec3<f32>) -> @builtin(position) vec4<f32> {
  var result : vec4<f32>
  result = params.u_mvp * vec4<f32>(inPos, 1.0)
  return result
}`

const GOOD_WGSL = `struct Params {
  u_mvp : mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;

@vertex
fn vsMain(@location(0) inPos : vec3<f32>) -> @builtin(position) vec4<f32> {
  var result : vec4<f32>;
  result = params.u_mvp * vec4<f32>(inPos, 1.0);
  return result;
}

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  let lambert = 0.5;
  return vec4<f32>(lambert, lambert, lambert, 1.0);
}`

describe('wgsl lint (REGRESSION: пропущенные точки с запятой)', () => {
  it('ловит операторы без ";" — с точными строками', () => {
    const problems = lintWgsl(BAD_WGSL)
    expect(problems.map(p => p.line)).toEqual([8, 9, 10])
    expect(problems[0].text).toContain('var result')
  })

  it('корректный шейдер проходит без замечаний', () => {
    expect(lintWgsl(GOOD_WGSL)).toEqual([])
  })

  it('ловит несколько пропусков в одном шейдере', () => {
    const problems = lintWgsl(BAD_WGSL + GOOD_WGSL)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.every(p => p.line > 0)).toBe(true)
  })
})
