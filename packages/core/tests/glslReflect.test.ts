import { describe, expect, it } from 'bun:test'
import { reflectGlsl } from '../src/index.ts'

const VERTEX = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec2 uv;
uniform mat4 u_viewProj;
uniform float u_time;
out vec2 v_uv;
void main() { v_uv = uv; gl_Position = u_viewProj * vec4(position, 1.0); }`

const FRAGMENT = `#version 300 es
precision mediump float;
uniform vec4 u_color;
uniform sampler2D u_tex;
uniform float u_weights[4];
in vec2 v_uv;
out vec4 o_color;
void main() { o_color = u_color * texture(u_tex, v_uv); }`

describe('glsl reflect', () => {
  it('собирает union юниформов вершины и фрагмента', () => {
    const reflection = reflectGlsl(VERTEX, FRAGMENT)
    const names = reflection.uniforms.map(u => u.name).sort()
    expect(names).toEqual(['u_color', 'u_tex', 'u_time', 'u_viewProj', 'u_weights'])
  })

  it('различает типы и длины массивов', () => {
    const reflection = reflectGlsl(VERTEX, FRAGMENT)
    const byName = new Map(reflection.uniforms.map(u => [u.name, u]))
    expect(byName.get('u_viewProj')!.type).toBe('mat4')
    expect(byName.get('u_color')!.type).toBe('vec4')
    expect(byName.get('u_tex')!.type).toBe('sampler2D')
    expect(byName.get('u_weights')!.arrayLength).toBe(4)
  })

  it('читает layout(location) атрибутов вершины', () => {
    const reflection = reflectGlsl(VERTEX, FRAGMENT)
    const byName = new Map(reflection.attributes.map(a => [a.name, a]))
    expect(byName.get('position')!.location).toBe(0)
    expect(byName.get('uv')!.location).toBe(1)
  })

  it('игнорирует комментарии', () => {
    const commented = '#version 300 es\n// uniform float fake;\nin vec3 p;\nvoid main(){}'
    const reflection = reflectGlsl(commented, commented)
    expect(reflection.uniforms.length).toBe(0)
    expect(reflection.attributes.length).toBe(1)
  })

  it('пропускает uniform-блоки интерфейса', () => {
    const withBlock = `#version 300 es
uniform Scene { mat4 view; mat4 proj; };
uniform float u_alpha;
out vec4 o; void main(){}`
    const reflection = reflectGlsl(withBlock, withBlock)
    expect(reflection.uniforms.map(u => u.name)).toEqual(['u_alpha'])
  })
})
