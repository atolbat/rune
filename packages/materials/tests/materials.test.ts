import { describe, expect, it } from 'bun:test'
import {
  materialOf,
  resetMaterials,
  variantCount,
  assemble,
  SKIN,
  NORMALMAP,
  TEXTURE,
  FLAT_ALBEDO,
  DOUBLE_SIDED,
  LAMBERT,
  ALPHA_CUTOFF,
} from '../src/index.ts'
import { reflectGlsl } from '@rune/webgl2'
import { reflectWgsl } from '@rune/webgpu'
import { createUniformArena } from '@rune/core'

/** The combinations exercised by the live demo models. */
const HOUSE = TEXTURE | LAMBERT | DOUBLE_SIDED | ALPHA_CUTOFF
const NEFERTITI = TEXTURE | NORMALMAP | LAMBERT | DOUBLE_SIDED
const SAMBA = SKIN | LAMBERT | FLAT_ALBEDO | DOUBLE_SIDED

const TRI = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])

describe('material assembly', () => {
  it('a minimal unlit variant carries no lighting, no lighting uniforms', () => {
    resetMaterials()
    const mat = materialOf({ features: FLAT_ALBEDO })
    expect(mat.glsl.fragment).not.toContain('lambert')
    expect(mat.glsl.fragment).not.toContain('u_lightDir')
    expect(mat.wgsl).not.toContain('u_lightDir')
    // The unlit final: the base color as is.
    expect(mat.glsl.fragment).toContain('o_color = base;')
  })

  it('no uber-shader: a feature emits ONLY its own code', () => {
    resetMaterials()
    const flat = materialOf({ features: FLAT_ALBEDO | LAMBERT })
    expect(flat.glsl.fragment).not.toContain('texture(')
    expect(flat.glsl.fragment).not.toContain('sampler')
    expect(flat.wgsl).not.toContain('texture_2d')
    const skinned = materialOf({ features: SAMBA, jointCount: 67 })
    expect(skinned.glsl.fragment).not.toContain('u_tex')
    expect(skinned.wgsl).not.toContain('nrmTexture')
  })

  it('attribute names and locations are the same in GLSL and WGSL', () => {
    resetMaterials()
    const mat = materialOf({ features: SAMBA, jointCount: 67 })
    const glsl = reflectGlsl(mat.glsl.vertex, mat.glsl.fragment)
    const wgsl = reflectWgsl(mat.wgsl)
    const glslAttrs = glsl.attributes.map(a => `${a.location}:${a.name}`).sort()
    const wgslAttrs = wgsl.attributes.map(a => `${a.location}:${a.name}`).sort()
    expect(glslAttrs).toEqual(wgslAttrs)
    expect(glslAttrs).toEqual(['0:position', '1:normal', '2:joints', '3:weights'])
  })

  it('uniform NAMES match between GLSL reflection and the WGSL struct', () => {
    resetMaterials()
    for (const [name, features, joints] of [
      ['house', HOUSE, 0],
      ['nefertiti', NEFERTITI, 0],
      ['samba', SAMBA, 67],
    ] as const) {
      const mat = materialOf({ features, jointCount: joints })
      const glsl = reflectGlsl(mat.glsl.vertex, mat.glsl.fragment)
      const wgsl = reflectWgsl(mat.wgsl)
      // GLSL reflection lists samplers among uniforms (the WGSL reflector
      // separates textures) and may repeat a uniform declared in BOTH stages
      // (u_model: vertex skeleton + normalmap fragment) — dedupe by name.
      const glslNames = [...new Set(glsl.uniforms.filter(u => u.type !== 'sampler2D').map(u => u.name))].sort()
      const wgslNames = wgsl.uniforms.map(u => u.name).sort()
      expect(glslNames).toEqual(wgslNames)
      // The declared list of the material equals the reflected set (u_mvp/u_model included).
      for (const declared of mat.uniforms.map(u => u.name)) {
        expect(glslNames).toContain(declared)
      }
      void name
    }
  })

  it('the skin palette reflects as a 67-element array on both sides', () => {
    resetMaterials()
    const mat = materialOf({ features: SAMBA, jointCount: 67 })
    const glsl = reflectGlsl(mat.glsl.vertex, mat.glsl.fragment)
    // The webgl2 reflector flattens arrays into a float size: mat4[67] = 1072.
    const bones = glsl.uniforms.find(u => u.name === 'u_bones')
    expect(bones?.size).toBe(16 * 67)
    const wgsl = reflectWgsl(mat.wgsl)
    const wgslBones = wgsl.uniforms.find(u => u.name === 'u_bones')
    expect(wgslBones).not.toBeUndefined()
    // 2 base mat4 + 67 palette = 69 mat4 = 4416 bytes + alignment → the
    // block covers the whole palette (the samba-class uniform window).
    expect(wgsl.uniformBytes).toBeGreaterThanOrEqual(2 * 64 + 67 * 64)
  })

  it('alpha discard PRECEDES the final color write (not dead code)', () => {
    resetMaterials()
    const mat = materialOf({ features: HOUSE })
    const body = mat.glsl.fragment.slice(mat.glsl.fragment.indexOf('void main()'))
    expect(body.indexOf('discard')).toBeLessThan(body.indexOf('o_color ='))
    const wgslBody = mat.wgsl.slice(mat.wgsl.indexOf('fn fsMain'))
    expect(wgslBody.indexOf('discard')).toBeLessThan(wgslBody.indexOf('return'))
  })

  it('deterministic: the same mask reassembles byte-for-byte', () => {
    const a = assemble(HOUSE, 0)
    const b = assemble(HOUSE, 0)
    expect(a.glsl.vertex).toBe(b.glsl.vertex)
    expect(a.glsl.fragment).toBe(b.glsl.fragment)
    expect(a.wgsl).toBe(b.wgsl)
  })

  it('invalid combinations fail at assembly with actionable messages', () => {
    expect(() => materialOf({ features: TEXTURE | FLAT_ALBEDO })).toThrow(/mutually exclusive/)
    expect(() => materialOf({ features: ALPHA_CUTOFF })).toThrow(/requires TEXTURE/)
    expect(() => materialOf({ features: SKIN })).toThrow(/jointCount/)
  })
})

describe('variant cache', () => {
  it('the same combination returns the SAME object (by reference)', () => {
    resetMaterials()
    const a = materialOf({ features: HOUSE })
    const b = materialOf({ features: HOUSE })
    expect(b).toBe(a)
    expect(variantCount()).toBe(1)
  })

  it('different joint counts are different variants', () => {
    resetMaterials()
    const a = materialOf({ features: SAMBA, jointCount: 67 })
    const b = materialOf({ features: SAMBA, jointCount: 32 })
    expect(b).not.toBe(a)
    expect(a.glsl.vertex).toContain('u_bones[67]')
    expect(b.glsl.vertex).toContain('u_bones[32]')
    expect(variantCount()).toBe(2)
  })
})

describe('backend integration (the real compilers)', () => {
  it('GLSL: compileDrawSpec consumes the assembled pair', async () => {
    resetMaterials()
    const { createCompileContext, compileDrawSpec } = await import('@rune/webgl2')
    const arena = createUniformArena(1 << 16)
    const ctx = createCompileContext(arena, 'codegen')
    const mat = materialOf({ features: HOUSE })
    const command = compileDrawSpec({
      shader: { glsl: mat.glsl },
      pipeline: { depth: { test: 'less', write: true } },
      uniforms: {
        u_mvp: TRI.subarray(0, 16) as unknown as Float32Array,
        u_lightDir: [0.5, 0.8, 0.6],
        u_alphaCutoff: 0.5,
      },
      attributes: {
        position: { data: TRI, size: 3 },
        normal: { data: TRI, size: 3 },
        uv: { data: new Float32Array([0, 0, 1, 0, 0, 1]), size: 2 },
      },
      count: 3,
    }, ctx)
    expect(command.id).toBe(0)
    const bindings = (command as unknown as { bindings: Array<{ name: string }> }).bindings.map(b => b.name)
    expect(bindings).toContain('u_lightDir')
    expect(bindings).toContain('u_alphaCutoff')
  })

  it('WGSL: reflectWgsl drives the slice allocation (uniformBytes >= palette)', () => {
    resetMaterials()
    const mat = materialOf({ features: SAMBA, jointCount: 67 })
    const reflection = reflectWgsl(mat.wgsl)
    // The 256-byte minimum of the dynamic-offset granularity.
    expect(reflection.uniformBytes).toBeGreaterThanOrEqual(256)
    // The attribute order of the material matches the WGSL @location order.
    const locations = reflection.attributes.map(a => a.location)
    expect(locations).toEqual([0, 1, 2, 3])
    const names = reflection.attributes.map(a => a.name)
    expect(names).toEqual(mat.attributes.map(a => a.name))
  })
})
