import { describe, expect, it } from 'bun:test'
import { createPipelineCache, structuralKey, reflectWgsl } from '../src/index.ts'

/** Task 144 — the WebGPU compile-path pass: the pipeline cache key built as a
 *  concat chain (join ≡ +, byte-identical strings) and the reflectWgsl source
 *  cache (parse once, share the readonly result — the core reflectWgsl
 *  precedent). These pins hold the rewrites to the V0 contracts. */
describe('task 144: the webgpu compile path', () => {
  it('pipeline ids: structurally equal FRESH objects share the id (the compile-storm shape)', () => {
    const cache = createPipelineCache()
    const mk = () => ({ depth: { test: 'less' as const, write: true }, blend: { src: 'src-alpha' as const, dst: 'one-minus-src-alpha' as const } })
    const a = cache.idOf(mk(), 1, '4:16:0:v')
    const b = cache.idOf(mk(), 1, '4:16:0:v')
    expect(a).toBe(b)
    const otherLayout = cache.idOf(mk(), 1, '4:64:0:i')
    expect(otherLayout).not.toBe(a)
    const otherShader = cache.idOf(mk(), 2, '4:16:0:v')
    expect(otherShader).not.toBe(a)
    expect(cache.size).toBe(3)
  })

  it('structuralKey: the concat chain is byte-identical to the join format', () => {
    // the exact V0 strings, pinned so the concat rewrite cannot drift
    expect(structuralKey({}, 1)).toBe('1|less:1|off|off|triangles|layout:default')
    expect(structuralKey({ depth: false, blend: false }, 2, '4:16:0:v')).toBe('2|off|off|off|triangles|4:16:0:v')
    expect(structuralKey({ depth: { test: 'less', write: false } }, 4)).toBe('4|less:0|off|off|triangles|layout:default')
    expect(structuralKey({
      depth: { test: 'greater' },
      blend: { src: 'one', dst: 'zero', equation: 'subtract' },
      raster: { cull: 'back', frontFace: 'cw' },
      primitive: 'triangle-strip',
    }, 3)).toBe('3|greater:1|one/zero/subtract|back/cw|triangle-strip|layout:default')
    expect(structuralKey({ raster: { cull: 'none' } }, 5)).toBe('5|less:1|off|none/ccw|triangles|layout:default')
  })

  it('reflectWgsl: the same source → the SAME reflection object (the compile cache)', () => {
    const src = 'struct P { a: vec4<f32>, b: f32, }\n@group(0) @binding(0) var<uniform> p : P;\n@vertex fn v(@location(0) x: vec3<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(x, 1.0); }'
    const first = reflectWgsl(src)
    expect(reflectWgsl(src)).toBe(first)
    expect(first.uniforms.length).toBe(2)
    expect(first.uniforms[0].name).toBe('a')
    expect(first.uniforms[0].offset).toBe(0)
    expect(first.uniforms[1].name).toBe('b')
    expect(first.uniforms[1].offset).toBe(16)
    expect(first.uniformBytes).toBe(32)
    expect(first.attributes.length).toBe(1)
    expect(first.attributes[0].location).toBe(0)
  })

  it('reflectWgsl: different sources do not collide in the cache', () => {
    const a = reflectWgsl('struct P { a: f32, }\n@group(0) @binding(0) var<uniform> p : P;')
    const b = reflectWgsl('struct P { a: vec4<f32>, }\n@group(0) @binding(0) var<uniform> p : P;')
    expect(a).not.toBe(b)
    expect(a.uniforms[0].size).toBe(4)
    expect(b.uniforms[0].size).toBe(16)
  })

  it('reflectWgsl: the array types survive the slice splitter (top-level commas only)', () => {
    const src = 'struct S { bones: array<mat4x4<f32>, 4>, w: array<vec4<f32>, 4>, t: f32, }\n@group(0) @binding(0) var<uniform> s : S;'
    const r = reflectWgsl(src)
    expect(r.uniforms.length).toBe(3)
    expect(r.uniforms[0].name).toBe('bones')
    expect(r.uniforms[0].size).toBe(256)
    expect(r.uniforms[1].name).toBe('w')
    expect(r.uniforms[1].size).toBe(64)
    expect(r.uniforms[2].name).toBe('t')
    expect(r.uniforms[2].offset).toBe(320)
  })

  it('reflectWgsl: the cache stops adding beyond the limit (the core precedent) but still parses', () => {
    // fill past CACHE_LIMIT with unique tiny sources; the early ones are
    // cached (identity), the late ones parse fresh every call (deep-equal)
    const srcs = Array.from({ length: 600 }, (_, i) => `struct P${i} { v${i}: f32, }\n@group(0) @binding(0) var<uniform> p${i} : P${i};\n// ${i}`)
    for (const s of srcs) reflectWgsl(s)
    const first = reflectWgsl(srcs[0])
    expect(reflectWgsl(srcs[0])).toBe(first)
    const late = reflectWgsl(srcs[599])
    const lateAgain = reflectWgsl(srcs[599])
    expect(late).not.toBe(lateAgain)
    expect(late.uniforms.length).toBe(lateAgain.uniforms.length)
    expect(late.uniforms[0].name).toBe('v599')
  })
})
