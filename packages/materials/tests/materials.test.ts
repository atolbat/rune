import { describe, expect, it } from 'bun:test'
import {
  materialOf,
  resetMaterials,
  variantCount,
  assemble,
  pbrMask,
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
  PBR,
  PBR_D_GGX,
  PBR_D_BECKMANN,
  PBR_D_BLINN,
  PBR_G_SMITH,
  PBR_G_SMITH_SCHLICK,
  PBR_G_SMITH_HEIGHT,
  PBR_G_IMPLICIT,
  PBR_G_NEUMANN,
  PBR_G_KELEMEN,
  PBR_F_SCHLICK,
  PBR_F_EXACT,
  PBR_DIFF_LAMBERT,
  PBR_DIFF_OREN_NAYAR,
  PBR_DIFF_BURLEY,
  PBR_MR_TEXTURE,
  EMISSIVE,
  FOG,
  type PbrModelChoice,
} from '../src/index.ts'
import { reflectGlsl } from '@rune/webgl2'
import { reflectWgsl, lintWgsl } from '@rune/webgpu'
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
    // Audit: the product is right-associated (32 mults, not the 48 of the
    // left-assoc matrix-matrix form) and the negation lives in the vertex.
    expect(mat.glsl.vertex).toContain('v_viewZ = -(u_view * (u_model * position4)).z;')
    expect(mat.glsl.fragment).toContain('lit = mix(lit, u_fogColor, fogFactor);')
    expect(mat.wgsl).toContain('out.viewZ = -(params.u_view * (params.u_model * position4)).z;')
    expect(mat.wgsl).toContain('lit = mix(lit, params.u_fogColor.rgb, fogFactor);')
    expect(mat.glsl.fragment).toContain('clamp((v_viewZ - u_fogNear)')
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
    expect(mat.glsl.vertex).toContain('v_normal = mat3(u_model) * (mat3(i_model) * normal);')
    expect(mat.wgsl).toContain('out.worldNormal = mat3x3<f32>(params.u_model[0].xyz, params.u_model[1].xyz, params.u_model[2].xyz) * (mat3x3<f32>(i_col0.xyz, i_col1.xyz, i_col2.xyz) * normal);')
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
    // The audit: the matrix-matrix product never forms — the chain is
    // right-associated (3 × mat3×vec3 = 27 mults, not 63), and the WGSL side
    // builds mat3x3 from the columns instead of dragging a vec4 through
    // three mat4 products (48 → 27).
    expect(mat.glsl.vertex).toContain('mat3(u_model) * (mat3(i_model) * (mat3(skin) * normal));')
    expect(mat.wgsl).toContain('mat3x3<f32>(skin[0].xyz, skin[1].xyz, skin[2].xyz) * normal)')
    expect(mat.wgsl).toContain('(mat3x3<f32>(i_col0.xyz, i_col1.xyz, i_col2.xyz) * (mat3x3<f32>(skin[0].xyz, skin[1].xyz, skin[2].xyz) * normal));')
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

/* ── PBR: the optionable sub-models ───────────────────────────────────────── */

/** Every VALID distribution×geometry pair (the exact Smith forms pair with
 *  GGX only); × 2 fresnel × 3 diffuse = 84 BRDF variants in the sweep. */
const D_G_PAIRS: Array<[name: string, d: number, g: number]> = [
  ['ggx+smith', PBR_D_GGX, PBR_G_SMITH],
  ['ggx+smith-schlick', PBR_D_GGX, PBR_G_SMITH_SCHLICK],
  ['ggx+smith-height', PBR_D_GGX, PBR_G_SMITH_HEIGHT],
  ['ggx+implicit', PBR_D_GGX, PBR_G_IMPLICIT],
  ['ggx+neumann', PBR_D_GGX, PBR_G_NEUMANN],
  ['ggx+kelemen', PBR_D_GGX, PBR_G_KELEMEN],
  ['beckmann+smith-schlick', PBR_D_BECKMANN, PBR_G_SMITH_SCHLICK],
  ['beckmann+implicit', PBR_D_BECKMANN, PBR_G_IMPLICIT],
  ['beckmann+neumann', PBR_D_BECKMANN, PBR_G_NEUMANN],
  ['beckmann+kelemen', PBR_D_BECKMANN, PBR_G_KELEMEN],
  ['blinn+smith-schlick', PBR_D_BLINN, PBR_G_SMITH_SCHLICK],
  ['blinn+implicit', PBR_D_BLINN, PBR_G_IMPLICIT],
  ['blinn+neumann', PBR_D_BLINN, PBR_G_NEUMANN],
  ['blinn+kelemen', PBR_D_BLINN, PBR_G_KELEMEN],
]
const FRESNELS = [PBR_F_SCHLICK, PBR_F_EXACT]
const DIFFUSES = [PBR_DIFF_LAMBERT, PBR_DIFF_OREN_NAYAR, PBR_DIFF_BURLEY]

describe('pbr: the sub-model catalog', () => {
  it('pbrMask defaults to the exact Smith-GGX + Schlick + Lambert', () => {
    expect(pbrMask()).toBe(PBR | PBR_D_GGX | PBR_G_SMITH | PBR_F_SCHLICK | PBR_DIFF_LAMBERT)
  })

  it('pbrMask routes every named choice to its bit', () => {
    const choice: PbrModelChoice = {
      distribution: 'beckmann',
      geometry: 'kelemen',
      fresnel: 'exact',
      diffuse: 'burley',
    }
    expect(pbrMask(choice)).toBe(PBR | PBR_D_BECKMANN | PBR_G_KELEMEN | PBR_F_EXACT | PBR_DIFF_BURLEY)
  })

  it('the framework: world position varying, view vector, the shared uniforms', () => {
    resetMaterials()
    const mat = materialOf({ features: pbrMask() | FLAT_ALBEDO })
    expect(mat.glsl.vertex).toContain('v_worldPos = (u_model * position4).xyz;')
    expect(mat.wgsl).toContain('out.worldPos = (params.u_model * position4).xyz;')
    expect(mat.glsl.fragment).toContain('vec3 v = normalize(u_camPos - v_worldPos);')
    expect(mat.wgsl).toContain('let v = normalize(params.u_camPos.xyz - frag.worldPos);')
    expect(mat.uniforms.map(u => u.name)).toEqual(
      ['u_albedo', 'u_lightDir', 'u_lightColor', 'u_ambient', 'u_camPos', 'u_roughness', 'u_metallic'],
    )
    // energy conservation + the final combine (direct sun + the sky fill)
    expect(mat.glsl.fragment).toContain('vec3 kd = (1.0 - metal) * (vec3(1.0) - F);')
    expect(mat.glsl.fragment).toContain(
      'vec3 lit = (diffuse + (D * vis) * F) * u_lightColor * nDotL + kd * base.rgb * u_ambient;',
    )
    expect(mat.wgsl).toContain('kd * base.rgb * params.u_ambient.rgb')
  })

  it('each distribution emits its own formula — and ONLY it', () => {
    resetMaterials()
    const ggx = assemble(pbrMask() | FLAT_ALBEDO, 0)
    expect(ggx.glsl.fragment).toContain('float dd = nDotH * nDotH * (a2 - 1.0) + 1.0;')
    expect(ggx.wgsl).toContain('let dd = nDotH * nDotH * (a2 - 1.0) + 1.0;')
    expect(ggx.glsl.fragment).not.toContain('exp(')
    expect(ggx.glsl.fragment).not.toContain('pow(')

    const beckmann = assemble(pbrMask({ distribution: 'beckmann', geometry: 'kelemen' }) | FLAT_ALBEDO, 0)
    expect(beckmann.glsl.fragment).toContain('exp((nh2 - 1.0)')
    expect(beckmann.wgsl).toContain('exp((nh2 - 1.0)')
    expect(beckmann.glsl.fragment).not.toContain('pow(')

    const blinn = assemble(pbrMask({ distribution: 'blinn-phong', geometry: 'kelemen' }) | FLAT_ALBEDO, 0)
    expect(blinn.glsl.fragment).toContain('pow(nDotH, blinnExp)')
    expect(blinn.wgsl).toContain('pow(nDotH, blinnExp)')
    expect(blinn.glsl.fragment).not.toContain('exp(')
  })

  it('the geometry family: every term in the FOLDED visibility form', () => {
    resetMaterials()
    const smith = assemble(pbrMask() | FLAT_ALBEDO, 0)
    expect(smith.glsl.fragment).toContain('float vis = 1.0 / ((1.0 + sqL) * (1.0 + sqV));')
    expect(smith.wgsl).toContain('let vis = 1.0 / ((1.0 + sqL) * (1.0 + sqV));')

    const height = assemble(pbrMask({ geometry: 'smith-height' }) | FLAT_ALBEDO, 0)
    expect(height.glsl.fragment).toContain('float lamL = (sqL - 1.0) * 0.5;')
    expect(height.glsl.fragment).toContain('max(4.0 * nDotL * nDotV * (1.0 + lamL + lamV), 1e-8)')

    const karis = assemble(pbrMask({ geometry: 'smith-schlick' }) | FLAT_ALBEDO, 0)
    expect(karis.glsl.fragment).toContain('float kk = (rough + 1.0) * (rough + 1.0) * 0.125;')

    // IMPLICIT folds to a constant — no division at all in the geometry
    const implicit = assemble(pbrMask({ geometry: 'implicit' }) | FLAT_ALBEDO, 0)
    expect(implicit.glsl.fragment).toContain('float vis = 0.25;')
    expect(implicit.wgsl).toContain('let vis = 0.25;')
    expect(implicit.glsl.fragment).not.toContain('sqL')

    const neumann = assemble(pbrMask({ geometry: 'neumann' }) | FLAT_ALBEDO, 0)
    expect(neumann.glsl.fragment).toContain('float vis = 0.25 / max(nDotL, nDotV);')

    const kelemen = assemble(pbrMask({ geometry: 'kelemen' }) | FLAT_ALBEDO, 0)
    expect(kelemen.glsl.fragment).toContain('float vis = 0.25 / max(vDotH * vDotH, 1e-8);')
    expect(kelemen.glsl.fragment).not.toContain('sqL')
  })

  it('the Schlick fresnel expands the 5th power — no pow, in both languages', () => {
    resetMaterials()
    const mat = assemble(pbrMask() | FLAT_ALBEDO, 0)
    expect(mat.glsl.fragment).toContain('float fT = 1.0 - vDotH;')
    expect(mat.wgsl).toContain('let fT = 1.0 - vDotH;')
    expect(mat.glsl.fragment).toContain('float fT5 = fT4 * fT;')
    expect(mat.wgsl).toContain('let fT5 = fT4 * fT;')
    // the only allowed pow is the Blinn distribution's — Schlick never uses it
    expect(mat.glsl.fragment).not.toContain('pow(')
    expect(mat.wgsl).not.toContain('pow(')
  })

  it('the exact fresnel declares u_ior and the dielectric term; Schlick does not', () => {
    resetMaterials()
    const exact = assemble(pbrMask({ fresnel: 'exact' }) | FLAT_ALBEDO, 0)
    expect(exact.uniforms.map(u => u.name)).toContain('u_ior')
    expect(exact.glsl.fragment).toContain('float fG = sqrt(max(u_ior * u_ior + fC * fC - 1.0, 0.0));')
    expect(exact.wgsl).toContain('let fG = sqrt(max(params.u_ior * params.u_ior + fC * fC - 1.0, 0.0));')
    const schlick = assemble(pbrMask() | FLAT_ALBEDO, 0)
    expect(schlick.uniforms.map(u => u.name)).not.toContain('u_ior')
  })

  it('the diffuse family: Lambert / Oren-Nayar / Burley markers', () => {
    resetMaterials()
    const lambert = assemble(pbrMask() | FLAT_ALBEDO, 0)
    expect(lambert.glsl.fragment).toContain('vec3 diffuse = kd * base.rgb * 0.318309886;')

    const oren = assemble(pbrMask({ diffuse: 'oren-nayar' }) | FLAT_ALBEDO, 0)
    expect(oren.glsl.fragment).toContain('float A = 1.0 - 0.5 * s2 / (s2 + 0.33);')
    // the azimuthal cosφ (the spherical identity), not the dot(l,v) shortcut
    expect(oren.glsl.fragment).toContain('inversesqrt(max((1.0 - nDotL * nDotL) * (1.0 - nDotV * nDotV), 1e-4))')
    expect(oren.wgsl).toContain('let cosPhi = clamp((dot(l, v) - nDotL * nDotV)')

    const burley = assemble(pbrMask({ diffuse: 'burley' }) | FLAT_ALBEDO, 0)
    expect(burley.glsl.fragment).toContain('float FD90 = 0.5 + 2.0 * vDotH * vDotH * rough;')
    expect(burley.wgsl).toContain('let FD90 = 0.5 + 2.0 * vDotH * vDotH * rough;')
  })

  it('the metallic-roughness texture: one .gb sample, factor multiply, binding 4', () => {
    resetMaterials()
    const mat = materialOf({ features: pbrMask() | FLAT_ALBEDO | PBR_MR_TEXTURE })
    expect(mat.glsl.fragment).toContain('vec2 mr = texture(u_mrTex, v_uv).gb;')
    expect(mat.glsl.fragment).toContain('float rough = clamp(u_roughness * mr.x, 0.045, 1.0);')
    expect(mat.wgsl).toContain('let mr = textureSample(mrTexture, texSampler, frag.uv).gb;')
    expect(mat.wgsl).toContain('@group(1) @binding(4) var mrTexture : texture_2d<f32>;')
    expect(mat.wgsl).toContain('@group(1) @binding(0) var texSampler : sampler;')
    expect(mat.samplers).toEqual(['u_mrTex'])
    // FLAT_ALBEDO + MR still gets the uv attribute (the gap-filler entry)
    expect(mat.attributes.map(a => a.name)).toEqual(['position', 'normal', 'uv'])
    expect(mat.glsl.vertex).toContain('v_uv = uv;')
    expect(mat.glsl.fragment).toContain('in vec2 v_uv;')
    // exactly ONE texture sample for the MR data
    expect(mat.glsl.fragment.match(/texture\(u_mrTex/g)?.length).toBe(1)
  })

  it('PBR and TEXTURE fragments are highp; the plain light models stay mediump', () => {
    resetMaterials()
    const pbr = materialOf({ features: pbrMask() | FLAT_ALBEDO })
    expect(pbr.glsl.fragment).toContain('precision highp float;')
    // Task 75b: textured materials feed the fixed-function blender — the
    // alpha path must not quantize (fp16 banding reads as a hard sprite rim)
    const tex = materialOf({ features: TEXTURE | VERTEX_COLOR })
    expect(tex.glsl.fragment).toContain('precision highp float;')
    const lambert = materialOf({ features: LAMBERT | FLAT_ALBEDO })
    expect(lambert.glsl.fragment).toContain('precision mediump float;')
    const matcap = materialOf({ features: MATCAP | FLAT_ALBEDO })
    expect(matcap.glsl.fragment).toContain('precision mediump float;')
  })

  it('the roughness is clamped (the mirrored-surface NaN guard)', () => {
    resetMaterials()
    const mat = materialOf({ features: pbrMask() | FLAT_ALBEDO })
    expect(mat.glsl.fragment).toContain('clamp(u_roughness, 0.045, 1.0)')
    expect(mat.wgsl).toContain('clamp(params.u_roughness, 0.045, 1.0)')
  })

  it('invalid combinations fail with actionable family errors', () => {
    resetMaterials()
    expect(() => materialOf({ features: LAMBERT | pbrMask() | FLAT_ALBEDO })).toThrow(/mutually exclusive light models/)
    expect(() => materialOf({ features: MATCAP | pbrMask() | FLAT_ALBEDO })).toThrow(/mutually exclusive light models/)
    // a bare sub-model bit without PBR
    expect(() => materialOf({ features: FLAT_ALBEDO | PBR_D_GGX })).toThrow(/require PBR/)
    expect(() => materialOf({ features: FLAT_ALBEDO | PBR_MR_TEXTURE })).toThrow(/require PBR/)
    // exactly-one per family
    expect(() => materialOf({ features: PBR | PBR_D_GGX | PBR_D_BECKMANN | PBR_G_SMITH | PBR_F_SCHLICK | PBR_DIFF_LAMBERT | FLAT_ALBEDO }))
      .toThrow(/exactly one distribution/)
    expect(() => materialOf({ features: PBR | PBR_D_GGX | PBR_G_SMITH | PBR_G_KELEMEN | PBR_F_SCHLICK | PBR_DIFF_LAMBERT | FLAT_ALBEDO }))
      .toThrow(/exactly one geometry model/)
    expect(() => materialOf({ features: PBR | PBR_D_GGX | PBR_G_SMITH | PBR_F_SCHLICK | PBR_F_EXACT | PBR_DIFF_LAMBERT | FLAT_ALBEDO }))
      .toThrow(/exactly one fresnel model/)
    expect(() => materialOf({ features: PBR | PBR_D_GGX | PBR_G_SMITH | PBR_F_SCHLICK | PBR_DIFF_LAMBERT | PBR_DIFF_BURLEY | FLAT_ALBEDO }))
      .toThrow(/exactly one diffuse model/)
    // PBR with NO sub-model bits: all four families are missing
    expect(() => materialOf({ features: PBR | FLAT_ALBEDO })).toThrow(/exactly one distribution/)
    // the exact Smith forms are Smith-GGX
    expect(() => materialOf({ features: pbrMask({ distribution: 'beckmann' }) | FLAT_ALBEDO })).toThrow(/Smith-GGX/)
    expect(() => materialOf({ features: pbrMask({ distribution: 'blinn-phong' }) | FLAT_ALBEDO })).toThrow(/Smith-GGX/)
  })

  it('the jointCount bound of the cache key stride', () => {
    expect(() => materialOf({ features: SKIN | LAMBERT | FLAT_ALBEDO, jointCount: 8192 })).toThrow(/8192/)
  })

  it('ALL 84 valid BRDF variants: clean WGSL (lint) + uniform parity + minimality', () => {
    resetMaterials()
    let assembled = 0
    for (const [name, d, g] of D_G_PAIRS) {
      for (const f of FRESNELS) {
        for (const diff of DIFFUSES) {
          const mask = PBR | d | g | f | diff | FLAT_ALBEDO
          const mat = materialOf({ features: mask })
          assembled++
          // the WGSL linter: statement-level sanity of the generated source
          expect(lintWgsl(mat.wgsl)).toEqual([])
          // the reflected uniform NAMES agree between the two languages
          const glsl = reflectGlsl(mat.glsl.vertex, mat.glsl.fragment)
          const wgsl = reflectWgsl(mat.wgsl)
          const glslNames = [...new Set(glsl.uniforms.filter(u => u.type !== 'sampler2D').map(u => u.name))].sort()
          const wgslNames = wgsl.uniforms.map(u => u.name).sort()
          expect(glslNames).toEqual(wgslNames)
          // minimality: the exact fresnel's u_ior appears in exactly the
          // exact variants; the Smith sqrt pair in the Smith variants only
          if (f !== PBR_F_EXACT) expect(wgslNames).not.toContain('u_ior')
          else expect(wgslNames).toContain('u_ior')
          const smithy = (g === PBR_G_SMITH || g === PBR_G_SMITH_HEIGHT)
          expect(mat.glsl.fragment.includes('float sqL =')).toBe(smithy)
          void name
        }
      }
    }
    expect(assembled).toBe(14 * 2 * 3)
    expect(variantCount()).toBe(84)
  })

  it('PBR composes with the base/post features: skin, normal map, alpha, fog', () => {
    resetMaterials()
    const mat = materialOf({ features: SKIN | pbrMask() | FLAT_ALBEDO | DOUBLE_SIDED | EMISSIVE | FOG, jointCount: 4 })
    expect(mat.glsl.vertex).toContain('u_bones[4]')
    expect(mat.glsl.vertex).toContain('v_worldPos = (u_model * position4).xyz;')
    // fog AFTER the light model (the worldPos and viewZ coexist)
    expect(mat.glsl.fragment.indexOf('vec3 lit =')).toBeLessThan(mat.glsl.fragment.indexOf('lit = mix(lit, u_fogColor'))
    expect(mat.glsl.fragment).toContain('lit += u_emissive;')
    // `lit` must be reassignable when post effects mutate it
    expect(mat.wgsl).toContain('var lit = (diffuse + (D * vis) * F)')
    // the normal map path: the normal from the map, the worldPos still there
    const nmap = materialOf({ features: TEXTURE | NORMALMAP | pbrMask() | DOUBLE_SIDED })
    expect(nmap.glsl.vertex).not.toContain('v_normal')
    expect(nmap.glsl.fragment).toContain('vec3 n = normalize(mat3(u_model)')
    expect(nmap.glsl.fragment).toContain('v_worldPos')
    expect(nmap.glsl.fragment).not.toContain('normalize(v_normal)')
  })
})

describe('the variant cache key (the bit-overlap fix)', () => {
  it('EMISSIVE at bit 26 no longer aliases jointCount 64 (features × 8192)', () => {
    resetMaterials()
    // Under the old `features + (jointCount << 20)` these two produced the
    // SAME key (bit 26 = 64 × 2^20) — one palette size silently served both.
    const a = materialOf({ features: SKIN | LAMBERT | FLAT_ALBEDO | EMISSIVE, jointCount: 64 })
    const b = materialOf({ features: SKIN | LAMBERT | FLAT_ALBEDO | EMISSIVE, jointCount: 1 })
    expect(b).not.toBe(a)
    expect(a.glsl.vertex).toContain('u_bones[64]')
    expect(b.glsl.vertex).toContain('u_bones[1]')
    // and the PBR sub-bits (up to bit 25) keep distinct variants too
    const c = materialOf({ features: SKIN | pbrMask() | FLAT_ALBEDO, jointCount: 33 })
    const d = materialOf({ features: SKIN | pbrMask() | FLAT_ALBEDO, jointCount: 1 })
    expect(d).not.toBe(c)
    expect(c.glsl.vertex).toContain('u_bones[33]')
  })
})

describe('pbr backend integration (the real compilers)', () => {
  it('GLSL: compileDrawSpec consumes the assembled PBR pair', async () => {
    resetMaterials()
    const { createCompileContext, compileDrawSpec } = await import('@rune/webgl2')
    const arena = createUniformArena(1 << 16)
    const ctx = createCompileContext(arena, 'codegen')
    const mat = materialOf({ features: pbrMask() | FLAT_ALBEDO })
    const command = compileDrawSpec({
      shader: { glsl: mat.glsl },
      pipeline: { depth: { test: 'less', write: true } },
      uniforms: {
        u_mvp: MAT4,
        u_lightDir: [0.5, 0.8, 0.6],
        u_lightColor: [1, 1, 1],
        u_ambient: [0.3, 0.3, 0.34],
        u_camPos: [0, 0.55, 3.2],
        u_roughness: 0.9,
        u_metallic: 0,
        u_albedo: [0.8, 0.7, 0.5],
      },
      attributes: {
        position: { data: TRI, size: 3 },
        normal: { data: TRI, size: 3 },
      },
      count: 3,
    }, ctx)
    expect(command.id).toBe(0)
    const bindings = (command as unknown as { bindings: Array<{ name: string }> }).bindings.map(b => b.name)
    for (const name of ['u_lightDir', 'u_lightColor', 'u_camPos', 'u_roughness', 'u_metallic']) {
      expect(bindings).toContain(name)
    }
  })

  it('WGSL: reflectWgsl sizes the uniform window with the PBR fields', () => {
    resetMaterials()
    const mat = materialOf({ features: pbrMask() | FLAT_ALBEDO })
    const reflection = reflectWgsl(mat.wgsl)
    // 2 mat4 (128 B) + 3 vec4 (48) + 2 f32 (8, padded to 16) >= 192
    expect(reflection.uniformBytes).toBeGreaterThanOrEqual(192)
    const names = reflection.uniforms.map(u => u.name)
    expect(names).toEqual(['u_mvp', 'u_model', 'u_albedo', 'u_lightDir', 'u_lightColor', 'u_ambient', 'u_camPos', 'u_roughness', 'u_metallic'])
  })
})
