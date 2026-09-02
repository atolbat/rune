import { describe, expect, it } from 'bun:test'
import {
  materialOf,
  resetMaterials,
  variantCount,
  assemble,
  SKIN,
  INSTANCED,
  NORMALMAP,
  TEXTURE,
  FLAT_ALBEDO,
  VERTEX_COLOR,
  DOUBLE_SIDED,
  ALPHA_CUTOFF,
  LAMBERT,
  MATCAP,
  EMISSIVE,
  FOG,
} from '../src/index.ts'
import { reflectGlsl } from '@rune/webgl2'
import { reflectWgsl } from '@rune/webgpu'
import { createUniformArena } from '@rune/core'

/** The combinations exercised by the live demo models. */
const HOUSE = TEXTURE | LAMBERT | DOUBLE_SIDED | ALPHA_CUTOFF
const NEFERTITI = TEXTURE | NORMALMAP | LAMBERT | DOUBLE_SIDED
const SAMBA = SKIN | LAMBERT | FLAT_ALBEDO | DOUBLE_SIDED

const TRI = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
const MAT4 = new Float32Array(16)
MAT4[0] = MAT4[5] = MAT4[10] = MAT4[15] = 1

describe('material assembly', () => {
  it('a minimal unlit variant carries no lighting, no lighting uniforms', () => {
    resetMaterials()
    const mat = materialOf({ features: FLAT_ALBEDO })
    expect(mat.glsl.fragment).not.toContain('lambert')
    expect(mat.glsl.fragment).not.toContain('u_lightDir')
    expect(mat.wgsl).not.toContain('u_lightDir')
    // The unlit final: the base color as is.
    expect(mat.glsl.fragment).toContain('o_color = base;')
    expect(mat.wgsl).toContain('return base;')
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
    const matcap = materialOf({ features: MATCAP | FLAT_ALBEDO })
    expect(matcap.glsl.fragment).not.toContain('u_lightDir')
    expect(matcap.wgsl).not.toContain('u_lightDir')
    expect(matcap.glsl.fragment).toContain('u_matcap')
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
      ['matcap', MATCAP | FLAT_ALBEDO, 0],
      ['matcap-tex', MATCAP | TEXTURE | DOUBLE_SIDED, 0],
      ['foggy', TEXTURE | LAMBERT | FOG, 0],
      ['glow', FLAT_ALBEDO | EMISSIVE, 0],
      ['vertexcolor', TEXTURE | LAMBERT | VERTEX_COLOR, 0],
      ['instanced', FLAT_ALBEDO | LAMBERT | INSTANCED, 0],
    ] as const) {
      const mat = materialOf({ features, jointCount: joints })
      const glsl = reflectGlsl(mat.glsl.vertex, mat.glsl.fragment)
      const wgsl = reflectWgsl(mat.wgsl)
      // GLSL reflection lists samplers among uniforms (the WGSL reflector
      // separates textures) and may repeat a uniform declared in BOTH stages
      // (u_view: FOG vertex + MATCAP fragment) — dedupe by name.
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
    expect(() => materialOf({ features: SKIN | FLAT_ALBEDO })).toThrow(/jointCount/)
    expect(() => materialOf({ features: LAMBERT })).toThrow(/base color source/)
    expect(() => materialOf({ features: LAMBERT | MATCAP | FLAT_ALBEDO })).toThrow(/light models/)
  })
})

describe('matcap', () => {
  it('the light comes from the texture: view-space normal lookup, no u_lightDir', () => {
    resetMaterials()
    const mat = materialOf({ features: MATCAP | FLAT_ALBEDO })
    expect(mat.glsl.fragment).toContain('mat3(u_view) * n')
    expect(mat.glsl.fragment).toContain('matcapUv')
    expect(mat.glsl.fragment).toContain('texture(u_matcap, matcapUv)')
    expect(mat.wgsl).toContain('params.u_view * vec4<f32>(n, 0.0)')
    expect(mat.wgsl).toContain('matTexture')
    expect(mat.samplers).toEqual(['u_matcap'])
    // u_view is a declared uniform on both language sides
    expect(mat.uniforms.map(u => u.name)).toContain('u_view')
  })

  it('DOUBLE_SIDED flips the matcap normal on back faces', () => {
    resetMaterials()
    const mat = materialOf({ features: MATCAP | FLAT_ALBEDO | DOUBLE_SIDED })
    expect(mat.glsl.fragment).toContain('if (!gl_FrontFacing) n = -n;')
    expect(mat.wgsl).toContain('n = select(-n, n, frag.ff);')
  })

  it('a normal-map matcap takes the normal from the map (no v_normal varying)', () => {
    resetMaterials()
    const mat = materialOf({ features: MATCAP | TEXTURE | NORMALMAP })
    expect(mat.glsl.vertex).not.toContain('v_normal')
    expect(mat.glsl.fragment).not.toContain('normalize(v_normal)')
    expect(mat.glsl.fragment).toContain('u_normalMap')
    expect(mat.glsl.fragment).toContain('mat3(u_view) * n')
  })

  it('compiles through the real webgl2 pipeline (u_view + u_matcap samplers)', async () => {
    resetMaterials()
    const { createCompileContext, compileDrawSpec } = await import('@rune/webgl2')
    const arena = createUniformArena(1 << 16)
    const ctx = createCompileContext(arena, 'codegen')
    const mat = materialOf({ features: MATCAP | FLAT_ALBEDO })
    const command = compileDrawSpec({
      shader: { glsl: mat.glsl },
      pipeline: { depth: { test: 'less', write: true } },
      uniforms: {
        u_mvp: MAT4,
        u_view: MAT4,
        u_albedo: [1, 1, 1],
      },
      attributes: {
        position: { data: TRI, size: 3 },
        normal: { data: TRI, size: 3 },
      },
      count: 3,
    }, ctx)
    expect(command.id).toBe(0)
    const bindings = (command as unknown as { bindings: Array<{ name: string }> }).bindings.map(b => b.name)
    expect(bindings).toContain('u_view')
    expect(bindings).toContain('u_albedo')
  })
})

describe('vertex color', () => {
  it('the vec4 color attribute modulates the base color', () => {
    resetMaterials()
    const mat = materialOf({ features: TEXTURE | LAMBERT | VERTEX_COLOR })
    expect(mat.attributes.map(a => a.name)).toContain('color')
    expect(mat.glsl.fragment).toContain('base *= v_color;')
    expect(mat.wgsl).toContain('base = base * frag.color;')
    // WGSL mutates base only when the modulator is present
    expect(mat.wgsl).toContain('var base = textureSample')
  })
})

describe('emissive', () => {
  it('self-illumination adds to the LIT color, even unlit', () => {
    resetMaterials()
    const unlit = materialOf({ features: FLAT_ALBEDO | EMISSIVE })
    expect(unlit.glsl.fragment).toContain('lit = base.rgb;')
    expect(unlit.glsl.fragment).toContain('lit += u_emissive;')
    expect(unlit.wgsl).toContain('lit += params.u_emissive.rgb;')
    expect(unlit.glsl.fragment).not.toContain('u_lightDir')
  })
})

describe('fog', () => {
  it('the view-space depth drives the fade toward u_fogColor', () => {
    resetMaterials()
    const mat = materialOf({ features: TEXTURE | LAMBERT | FOG })
    expect(mat.glsl.vertex).toContain('v_viewZ = (u_view * u_model * position4).z;')
    expect(mat.glsl.fragment).toContain('lit = mix(lit, u_fogColor, fogFactor);')
    expect(mat.wgsl).toContain('out.viewZ = (params.u_view * params.u_model * position4).z;')
    expect(mat.wgsl).toContain('lit = mix(lit, params.u_fogColor.rgb, fogFactor);')
    expect(mat.uniforms.map(u => u.name)).toEqual(
      expect.arrayContaining(['u_view', 'u_fogColor', 'u_fogNear', 'u_fogFar']),
    )
  })
})

describe('instanced', () => {
  it('the instance matrix composes between skin and u_mvp', () => {
    resetMaterials()
    const mat = materialOf({ features: FLAT_ALBEDO | LAMBERT | INSTANCED })
    const inst = mat.attributes.filter(a => a.instance === true).map(a => a.name)
    expect(inst).toEqual(['i_col0', 'i_col1', 'i_col2', 'i_col3'])
    expect(mat.glsl.vertex).toContain('vec4 position4Inst = i_model * position4;')
    expect(mat.glsl.vertex).toContain('gl_Position = u_mvp * position4Inst;')
    expect(mat.glsl.vertex).toContain('v_normal = mat3(u_model) * mat3(i_model) * normal;')
    expect(mat.wgsl).toContain('out.pos = params.u_mvp * position4Inst;')
  })

  it('instanced attribute locations are dense and identical in both languages', () => {
    resetMaterials()
    const mat = materialOf({ features: FLAT_ALBEDO | LAMBERT | INSTANCED })
    const glsl = reflectGlsl(mat.glsl.vertex, mat.glsl.fragment)
    const wgsl = reflectWgsl(mat.wgsl)
    const glslAttrs = glsl.attributes.map(a => `${a.location}:${a.name}`).sort()
    const wgslAttrs = wgsl.attributes.map(a => `${a.location}:${a.name}`).sort()
    expect(glslAttrs).toEqual(wgslAttrs)
    expect(glslAttrs).toEqual([
      '0:position', '1:normal', '2:i_col0', '3:i_col1', '4:i_col2', '5:i_col3',
    ])
  })

  it('SKIN + INSTANCED: the palette skins, the instance transforms, the mvp projects', () => {
    resetMaterials()
    const mat = materialOf({ features: SKIN | INSTANCED | FLAT_ALBEDO | LAMBERT, jointCount: 4 })
    expect(mat.glsl.vertex).toContain('gl_Position = u_mvp * position4Inst;')
    expect(mat.glsl.vertex).toContain('mat3(u_model) * mat3(i_model) * mat3(skin) * normal;')
    expect(mat.wgsl).toContain('(i_model * (skin * vec4<f32>(normal, 0.0)))')
  })
})

describe('the memory contract of the gluing', () => {
  it('one source per stage: no bare CR/LF soup, no double blank lines', () => {
    resetMaterials()
    for (const features of [HOUSE, NEFERTITI, MATCAP | FLAT_ALBEDO, FLAT_ALBEDO | EMISSIVE | FOG]) {
      const mat = materialOf({ features, jointCount: 0 })
      for (const src of [mat.glsl.vertex, mat.glsl.fragment, mat.wgsl]) {
        expect(src).not.toContain('\n\n\n')
        expect(src.endsWith('\n')).toBe(false)
      }
    }
  })

  it('the scratch is reused: two assemblies do not share result arrays', () => {
    const a = assemble(HOUSE, 0)
    const b = assemble(NEFERTITI, 0)
    // fresh result containers (the scratch lives at module level)
    expect(a.attributes).not.toBe(b.attributes)
    expect(a.uniforms).not.toBe(b.uniforms)
    expect(a.samplers).not.toBe(b.samplers)
    // and mutating one result must not affect the next assembly
    expect(a.attributes.length).toBe(3)
    expect(b.attributes.length).toBe(2)
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
