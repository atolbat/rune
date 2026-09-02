import { describe, expect, it } from 'bun:test'
import { reflectWgsl } from '../src/index.ts'

const WGSL = `
struct Params {
  u_viewProj: mat4x4<f32>,
  u_tint: vec4<f32>,
  u_time: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var u_tex: texture_2d<f32>;
@group(1) @binding(0) var u_shadow: texture_depth_2d;

@vertex
fn vs_main(@location(0) position: vec3<f32>, @location(1) uv: vec2<f32>) -> @builtin(position) vec4<f32> {
  return params.u_viewProj * vec4<f32>(position, 1.0);
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  return params.u_tint;
}`

describe('wgsl reflect', () => {
  it('exposes var<uniform> struct fields with group/binding', () => {
    const reflection = reflectWgsl(WGSL)
    expect(reflection.uniforms.map(u => u.name)).toEqual(['u_viewProj', 'u_tint', 'u_time'])
    for (const uniform of reflection.uniforms) {
      expect(uniform.group).toBe(0)
      expect(uniform.binding).toBe(0)
    }
  })

  it('maps WGSL types to ABI types', () => {
    const reflection = reflectWgsl(WGSL)
    const types = reflection.uniforms.map(u => u.type)
    expect(types).toEqual(['mat4', 'vec4', 'float'])
  })

  it('collects textures separately from uniforms', () => {
    const reflection = reflectWgsl(WGSL)
    expect(reflection.textures.map(t => t.name)).toEqual(['u_tex', 'u_shadow'])
  })

  it('reads @location attributes of the vertex input', () => {
    const reflection = reflectWgsl(WGSL)
    expect(reflection.attributes).toEqual([
      { name: 'position', location: 0 },
      { name: 'uv', location: 1 },
    ])
  })

  it('finds entry points', () => {
    const reflection = reflectWgsl(WGSL)
    expect(reflection.entries.vertex).toBe('vs_main')
    expect(reflection.entries.fragment).toBe('fs_main')
    expect(reflection.entries.compute).toBeNull()
  })

  it('ignores comments', () => {
    const commented = `// struct Fake { x: f32 }
/* var<uniform> bogus: Fake; */
struct Real { u_a: f32 }
@group(0) @binding(0) var<uniform> r: Real;
@fragment fn f() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`
    const reflection = reflectWgsl(commented)
    expect(reflection.uniforms.map(u => u.name)).toEqual(['u_a'])
  })
})
