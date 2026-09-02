import { describe, expect, it } from 'bun:test'
import { resolveBackend, shaderCoverage } from '../src/autoBackend.ts'
import type { AutoDrawSpec, BackendDecision } from '../src/autoBackend.ts'

/**
 * resolveBackend — a pure function. Hardware is supplied as facts. All scenarios
 * from the design (§9.12): dual / WGSL-only / GLSL-only / conflict / strict / invalid.
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

describe('resolveBackend — pure backend choice', () => {
  it('1. dual-source specs, both backends available → WebGPU (first in order)', () => {
    const r = resolveBackend({ specs: [DUAL_SPEC], hardware: HARDWARE_BOTH })
    expect(r.chosen).toBe('webgpu')
    expect(r.verdicts.webgpu.available).toBe(true)
    expect(r.verdicts.webgpu.covers).toBe(true)
    expect(r.verdicts.webgl2.available).toBe(true)
    expect(r.verdicts.webgl2.covers).toBe(true)
    expect(r.message).toContain('WebGPU')
  })

  it('2. WGSL-only spec, WebGPU unavailable → conflict (chosen null), actionable message', () => {
    const r = resolveBackend({ specs: [WGSL_ONLY], hardware: HARDWARE_GL_ONLY })
    expect(r.chosen).toBeNull()
    expect(r.verdicts.webgpu.rejected).toContain('no adapter')
    // webgl2 requires GLSL; WGSL_ONLY does not have it — rejected mentions GLSL
    expect(r.verdicts.webgl2.rejected).toContain('GLSL')
    expect(r.message).toContain('Conflict')
  })

  it('3. GLSL-only spec, WebGPU available → silent fallback to WebGL2 (forcedBy shader)', () => {
    const r = resolveBackend({ specs: [GLSL_ONLY], hardware: HARDWARE_BOTH })
    expect(r.chosen).toBe('webgl2')
    expect(r.verdicts.webgpu.available).toBe(true)
    expect(r.verdicts.webgpu.covers).toBe(false)
    expect(r.verdicts.webgpu.rejected).toContain('WGSL')
    expect(r.verdicts.webgl2.covers).toBe(true)
    expect(r.message).toContain('WebGL2')
  })

  it('4. GLSL-only spec, WebGL2 unavailable → conflict', () => {
    const r = resolveBackend({ specs: [GLSL_ONLY], hardware: HARDWARE_GPU_ONLY })
    expect(r.chosen).toBeNull()
    expect(r.verdicts.webgl2.rejected).toContain('no adapter')
    expect(r.verdicts.webgpu.covers).toBe(false)
  })

  it('5. mixed: WGSL-only AND GLSL-only specs → conflict (both filtered out)', () => {
    const r = resolveBackend({ specs: [WGSL_ONLY, GLSL_ONLY], hardware: HARDWARE_BOTH })
    expect(r.chosen).toBeNull()
    expect(r.verdicts.webgpu.covers).toBe(false)  // GLSL-only is not covered
    expect(r.verdicts.webgl2.covers).toBe(false) // WGSL-only is not covered
    expect(r.message).toContain('Conflict')
  })

  it('6. strict order=["webgl2"] → WebGL2 always, even if WebGPU is better', () => {
    const r = resolveBackend({ order: ['webgl2'], specs: [DUAL_SPEC], hardware: HARDWARE_BOTH })
    expect(r.chosen).toBe('webgl2')
    expect(r.order).toEqual(['webgl2'])
    expect(r.message).toContain('Forced')
  })

  it('7. strict order=["webgpu"], unavailable → null with an instruction to soften', () => {
    const r = resolveBackend({ order: ['webgpu'], specs: [DUAL_SPEC], hardware: HARDWARE_GL_ONLY })
    expect(r.chosen).toBeNull()
    expect(r.message).toContain('unavailable')
    expect(r.message).toContain('Soften')
  })

  it('8. invalid spec (neither glsl nor wgsl) → null with an actionable message', () => {
    const r = resolveBackend({ specs: [INVALID_SPEC], hardware: HARDWARE_BOTH })
    expect(r.chosen).toBeNull()
    expect(r.message).toContain('Invalid spec')
    expect(r.message).toContain('"broken"')
  })

  it('9. hardware NONE → null, both filtered out by available', () => {
    const r = resolveBackend({ specs: [DUAL_SPEC], hardware: HARDWARE_NONE })
    expect(r.chosen).toBeNull()
    expect(r.verdicts.webgpu.available).toBe(false)
    expect(r.verdicts.webgl2.available).toBe(false)
  })

  it('10. coverage of specs without id — fallback "<no id>" in the message', () => {
    const spec: AutoDrawSpec = { shader: { wgsl: '...' }, count: 3 }
    const r = resolveBackend({ specs: [spec], hardware: HARDWARE_GL_ONLY })
    expect(r.chosen).toBeNull()
    expect(r.message).toContain('<no id>')
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
  it('empty strings → false (placeholder guard)', () => {
    const c = shaderCoverage({ shader: { glsl: { vertex: '', fragment: '' } }, count: 3 })
    expect(c.hasGlsl).toBe(false)
  })
})
