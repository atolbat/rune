import { describe, expect, it } from 'bun:test'
import { reflectGlsl } from '../src/glslReflect.ts'

const VERTEX = `#version 300 es
layout(location = 0) in vec3 position;
uniform mat4 u_mvp;
uniform mat4 u_bones[52];
void main() {
  mat4 skin = u_bones[0] * u_bones[1];
  gl_Position = u_mvp * skin * vec4(position, 1.0);
}`

const FRAGMENT = `#version 300 es
precision mediump float;
uniform vec4 u_palette[8];
out vec4 o_color;
void main() { o_color = u_palette[0]; }`

describe('glsl reflect — array uniforms', () => {
  it('a mat4[N] array occupies one slot of 16×N floats', () => {
    const r = reflectGlsl(VERTEX, FRAGMENT)
    const bones = r.uniforms.find(u => u.name === 'u_bones')
    expect(bones?.type).toBe('mat4')
    expect(bones?.size).toBe(16 * 52)
  })

  it('a vec4[N] array occupies 4×N floats', () => {
    const r = reflectGlsl(VERTEX, FRAGMENT)
    const palette = r.uniforms.find(u => u.name === 'u_palette')
    expect(palette?.type).toBe('vec4')
    expect(palette?.size).toBe(4 * 8)
  })

  it('plain uniforms keep their base size', () => {
    const r = reflectGlsl(VERTEX, FRAGMENT)
    const mvp = r.uniforms.find(u => u.name === 'u_mvp')
    expect(mvp?.size).toBe(16)
  })

  it('usages inside the body (u_bones[0]) do not duplicate the uniform', () => {
    const r = reflectGlsl(VERTEX, FRAGMENT)
    expect(r.uniforms.filter(u => u.name === 'u_bones').length).toBe(1)
    expect(r.uniforms.filter(u => u.name === 'u_palette').length).toBe(1)
  })
})
