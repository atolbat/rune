import { describe, expect, it } from 'bun:test'
import { createPipelineCache, structuralKey } from '../src/index.ts'

/** Task 195 — THE WEBGPU SIDE of the rasterization-parity contract.
 *
 * WebGPU was ALREADY right: realGPU maps an absent raster.cull to cullMode
 * 'none' (the GPURenderPipelineDescriptor spec default) and an absent
 * raster.frontFace to 'ccw', both baked into the GPURenderPipeline and keyed
 * through the structural cache. These pins are the defensive twin of the
 * WebGL2 task195.test.ts: they hold the WG defaults so the parity contract
 * ("an unspecified pipeline means: no culling, CCW winding — on BOTH
 * backends", proven pixel-level by scripts/task195-parity.mjs) cannot drift
 * from either side. */
describe('task 195: the WG raster defaults (the parity twin)', () => {
  it('structuralKey: an absent raster and a neutral raster agree — the pipeline identity of "no culling, CCW"', () => {
    // raster absent → rasterKey 'off'; the DESC still compiles to
    // cullMode 'none' + frontFace 'ccw' in realGPU (the spec defaults).
    expect(structuralKey({}, 1)).toBe('1|less:1|off|off|triangles|layout:default')
    // the explicit neutral raster — cull 'none' (NOT culled) + 'ccw'
    expect(structuralKey({ raster: { cull: 'none' } }, 1)).toBe('1|less:1|off|none/ccw|triangles|layout:default')
    // frontFace IS part of the pipeline identity (a 'cw' spec is a
    // different pipeline — never silently dropped, the pre-195 GL hole).
    expect(structuralKey({ raster: { frontFace: 'cw' } }, 2)).toBe('2|less:1|off|none/cw|triangles|layout:default')
    expect(structuralKey({ raster: { cull: 'back', frontFace: 'cw' } }, 3)).toBe('3|less:1|off|back/cw|triangles|layout:default')
  })

  it('the pipeline cache: distinct raster states stay distinct ids (no silent coalescing)', () => {
    const cache = createPipelineCache()
    const plain = cache.idOf({}, 1, '4:16:0:v')
    const neutral = cache.idOf({ raster: { cull: 'none' } }, 1, '4:16:0:v')
    const cw = cache.idOf({ raster: { frontFace: 'cw' } }, 1, '4:16:0:v')
    const culled = cache.idOf({ raster: { cull: 'back' } }, 1, '4:16:0:v')
    expect(neutral).not.toBe(plain) // 'off' vs 'none/ccw' — distinct keys, both render uncullled
    expect(cw).not.toBe(neutral)
    expect(culled).not.toBe(neutral)
    expect(culled).not.toBe(cw)
    expect(cache.size).toBe(4)
  })
})
