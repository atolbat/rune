/**
 * renderable.test.ts — Task 86: the Renderable registry — an abstract entity
 * "what to draw" (mesh recipe + material + pass + policy), "mesh
 * resolution" via resolveMesh with a cache.
 */
import { describe, expect, test } from 'bun:test'
import {
  createRenderableRegistry,
  RENDER_PASS_ORDER,
} from '../src/renderable.ts'

describe('renderable registry', () => {
  test('a mesh recipe is resolved once and cached (mesh resolution)', () => {
    const reg = createRenderableRegistry()
    let calls = 0
    const mesh = reg.addMesh(() => { calls++; return { positions: new Float32Array(9) } })
    expect(mesh).toBe(0)
    const a = reg.resolveMesh(mesh)
    const b = reg.resolveMesh(mesh)
    expect(calls).toBe(1) // loader called ONCE
    expect(a).toBeDefined()
    expect(b!.geometry).toBe(a!.geometry) // the same cached object
    expect(a!.meshId).toBe(mesh)
  })

  test('unknown mesh recipe — undefined', () => {
    const reg = createRenderableRegistry()
    expect(reg.resolveMesh(42)).toBeUndefined()
  })

  test('renderable description: pass/policy/layer are preserved', () => {
    const reg = createRenderableRegistry()
    const mesh = reg.addMesh(() => 1)
    const mat = reg.addMaterial({ base: [0.2, 0.4, 0.9], emissive: 0.3, alpha: 0.7 })
    const id = reg.add({ mesh, material: mat, pass: 'transparent', policy: 'instanced', layer: 2 })
    const desc = reg.get(id)
    expect(desc).toMatchObject({ id, mesh, material: mat, pass: 'transparent', policy: 'instanced', layer: 2 })
    expect(reg.count).toBe(1)
    expect(reg.get(999)).toBeUndefined()
  })

  test('add with a non-existent mesh/material — actionable error', () => {
    const reg = createRenderableRegistry()
    const mesh = reg.addMesh(() => 1)
    expect(() => reg.add({ mesh: 7, material: 0, pass: 'opaque', policy: 'unique', layer: 0 })).toThrow(/mesh 7/)
    const mat = reg.addMaterial({ base: [1, 1, 1], emissive: 0, alpha: 1 })
    expect(() => reg.add({ mesh, material: 7, pass: 'opaque', policy: 'unique', layer: 0 })).toThrow(/material 7/)
  })

  test('material is data: base/emissive/alpha are read as is', () => {
    const reg = createRenderableRegistry()
    const id = reg.addMaterial({ base: [0.1, 0.2, 0.3], emissive: 0.55, alpha: 0.68 })
    expect(reg.material(id)).toMatchObject({ id, base: [0.1, 0.2, 0.3], emissive: 0.55, alpha: 0.68 })
  })

  test('pass order: opaque → sky → mirror → transparent → overlay', () => {
    expect(RENDER_PASS_ORDER.opaque).toBeLessThan(RENDER_PASS_ORDER.sky)
    expect(RENDER_PASS_ORDER.sky).toBeLessThan(RENDER_PASS_ORDER.mirror)
    expect(RENDER_PASS_ORDER.mirror).toBeLessThan(RENDER_PASS_ORDER.transparent)
    expect(RENDER_PASS_ORDER.transparent).toBeLessThan(RENDER_PASS_ORDER.overlay)
  })

  test('dense renderable ids and registry independence', () => {
    const a = createRenderableRegistry()
    const b = createRenderableRegistry()
    const meshA = a.addMesh(() => 'A')
    const meshB = b.addMesh(() => 'B')
    expect(meshA).toBe(0)
    expect(meshB).toBe(0) // registries are independent
    const r0 = a.add({ mesh: meshA, material: a.addMaterial({ base: [0, 0, 0], emissive: 0, alpha: 1 }), pass: 'opaque', policy: 'instanced', layer: 0 })
    const r1 = a.add({ mesh: meshA, material: a.addMaterial({ base: [0, 0, 0], emissive: 0, alpha: 1 }), pass: 'mirror', policy: 'unique', layer: 0 })
    expect(r0).toBe(0)
    expect(r1).toBe(1)
    expect(a.get(r1)!.pass).toBe('mirror')
  })
})
