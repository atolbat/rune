import { describe, expect, it } from 'bun:test'
import { resolveBackend, shaderCoverage } from '../src/autoBackend.ts'
import type { AutoDrawSpec, BackendDecision } from '../src/autoBackend.ts'

/**
 * resolveBackend — чистая функция. Hardware подаётся фактами. Все сценарии
 * из дизайна (§9.12): dual / WGSL-only / GLSL-only / конфликт / strict / invalid.
 */

const DUAL_SPEC: AutoDrawSpec = {
  id: 'triangle',
  shader: { glsl: { vertex: '...glsl...', fragment: '...glsl...' }, wgsl: '...wgsl...' },
  count: 3,
}
const WGSL_ONLY: AutoDrawSpec = {
  id: 'compute-blur',
  shader: { wgsl: '...wgsl...' },
  count: 3,
}
const GLSL_ONLY: AutoDrawSpec = {
  id: 'legacy-triangle',
  shader: { glsl: { vertex: '...glsl...', fragment: '...glsl...' } },
  count: 3,
}
const INVALID_SPEC: AutoDrawSpec = {
  id: 'broken',
  shader: {},
  count: 3,
}

const HARDWARE_BOTH = { webgpu: true, webgl2: true }
const HARDWARE_GL_ONLY = { webgpu: false, webgl2: true }
const HARDWARE_GPU_ONLY = { webgpu: true, webgl2: false }
const HARDWARE_NONE = { webgpu: false, webgl2: false }

function d(d: BackendDecision): unknown {
  return {
    chosen: d.chosen,
    order: d.order,
    verdicts: {
      webgpu: { avail: d.verdicts.webgpu.available, covers: d.verdicts.webgpu.covers, rejected: d.verdicts.webgpu.rejected },
      webgl2: { avail: d.verdicts.webgl2.available, covers: d.verdicts.webgl2.covers, rejected: d.verdicts.webgl2.rejected },
    },
  }
}

describe('resolveBackend — чистый выбор бэкенда', () => {
  it('1. dual-source спеки, оба бэкенда доступны → WebGPU (первый в order)', () => {
    const r = resolveBackend({ specs: [DUAL_SPEC], hardware: HARDWARE_BOTH })
    expect(r.chosen).toBe('webgpu')
    expect(r.verdicts.webgpu.available).toBe(true)
    expect(r.verdicts.webgpu.covers).toBe(true)
    expect(r.verdicts.webgl2.available).toBe(true)
    expect(r.verdicts.webgl2.covers).toBe(true)
    expect(r.message).toContain('WebGPU')
  })

  it('2. WGSL-only спек, WebGPU недоступен → конфликт (chosen null), actionable message', () => {
    const r = resolveBackend({ specs: [WGSL_ONLY], hardware: HARDWARE_GL_ONLY })
    expect(r.chosen).toBeNull()
    expect(r.verdicts.webgpu.rejected).toContain('нет адаптера')
    // webgl2 требует GLSL; у WGSL_ONLY его нет — rejected упоминает GLSL
    expect(r.verdicts.webgl2.rejected).toContain('GLSL')
    expect(r.message).toContain('Конфликт')
  })

  it('3. GLSL-only спек, WebGPU доступен → тихий фолбэк на WebGL2 (forcedBy shader)', () => {
    const r = resolveBackend({ specs: [GLSL_ONLY], hardware: HARDWARE_BOTH })
    expect(r.chosen).toBe('webgl2')
    expect(r.verdicts.webgpu.available).toBe(true)
    expect(r.verdicts.webgpu.covers).toBe(false)
    expect(r.verdicts.webgpu.rejected).toContain('WGSL')
    expect(r.verdicts.webgl2.covers).toBe(true)
    expect(r.message).toContain('WebGL2')
  })

  it('4. GLSL-only спек, WebGL2 недоступен → конфликт', () => {
    const r = resolveBackend({ specs: [GLSL_ONLY], hardware: HARDWARE_GPU_ONLY })
    expect(r.chosen).toBeNull()
    expect(r.verdicts.webgl2.rejected).toContain('нет адаптера')
    expect(r.verdicts.webgpu.covers).toBe(false)
  })

  it('5. mixed: WGSL-only И GLSL-only спеки → конфликт (оба отсеяны)', () => {
    const r = resolveBackend({ specs: [WGSL_ONLY, GLSL_ONLY], hardware: HARDWARE_BOTH })
    expect(r.chosen).toBeNull()
    expect(r.verdicts.webgpu.covers).toBe(false)  // GLSL-only не покрыт
    expect(r.verdicts.webgl2.covers).toBe(false) // WGSL-only не покрыт
    expect(r.message).toContain('Конфликт')
  })

  it('6. strict order=["webgl2"] → WebGL2 всегда, даже если WebGPU лучше', () => {
    const r = resolveBackend({ order: ['webgl2'], specs: [DUAL_SPEC], hardware: HARDWARE_BOTH })
    expect(r.chosen).toBe('webgl2')
    expect(r.order).toEqual(['webgl2'])
    expect(r.message).toContain('Принудительный')
  })

  it('7. strict order=["webgpu"], недоступен → null с инструкцией смягчить', () => {
    const r = resolveBackend({ order: ['webgpu'], specs: [DUAL_SPEC], hardware: HARDWARE_GL_ONLY })
    expect(r.chosen).toBeNull()
    expect(r.message).toContain('недоступен')
    expect(r.message).toContain('Смягчите')
  })

  it('8. invalid spec (нет ни glsl ни wgsl) → null с actionable сообщением', () => {
    const r = resolveBackend({ specs: [INVALID_SPEC], hardware: HARDWARE_BOTH })
    expect(r.chosen).toBeNull()
    expect(r.message).toContain('Невалидный спек')
    expect(r.message).toContain('"broken"')
  })

  it('9. hardware NONE → null, оба отсеяны по available', () => {
    const r = resolveBackend({ specs: [DUAL_SPEC], hardware: HARDWARE_NONE })
    expect(r.chosen).toBeNull()
    expect(r.verdicts.webgpu.available).toBe(false)
    expect(r.verdicts.webgl2.available).toBe(false)
  })

  it('10. coverage из specs без id — fallback "<без id>" в сообщении', () => {
    const spec: AutoDrawSpec = { shader: { wgsl: '...' }, count: 3 }
    const r = resolveBackend({ specs: [spec], hardware: HARDWARE_GL_ONLY })
    expect(r.chosen).toBeNull()
    expect(r.message).toContain('<без id>')
  })
})

describe('shaderCoverage — per-spec predicate', () => {
  it('dual-source → hasGlsl=true, hasWgsl=true', () => {
    const c = shaderCoverage(DUAL_SPEC)
    expect(c.hasGlsl).toBe(true)
    expect(c.hasWgsl).toBe(true)
  })
  it('WGSL-only → hasGlsl=false, hasWgsl=true', () => {
    const c = shaderCoverage(WGSL_ONLY)
    expect(c.hasGlsl).toBe(false)
    expect(c.hasWgsl).toBe(true)
  })
  it('GLSL-only → hasGlsl=true, hasWgsl=false', () => {
    const c = shaderCoverage(GLSL_ONLY)
    expect(c.hasGlsl).toBe(true)
    expect(c.hasWgsl).toBe(false)
  })
  it('invalid → hasGlsl=false, hasWgsl=false', () => {
    const c = shaderCoverage(INVALID_SPEC)
    expect(c.hasGlsl).toBe(false)
    expect(c.hasWgsl).toBe(false)
  })
  it('пустые строки → false (защита от placeholder)', () => {
    const c = shaderCoverage({ shader: { glsl: { vertex: '', fragment: '' } }, count: 3 })
    expect(c.hasGlsl).toBe(false)
  })
})
