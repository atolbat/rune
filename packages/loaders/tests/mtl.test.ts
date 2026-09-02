/** mtl.ts — the Wavefront MTL parser: newmtl blocks, colors, textures, options. */

import { describe, expect, it } from 'bun:test'
import { parseMtl, parseMtlBytes } from '../src/mtl.ts'
import { readFileSync } from 'node:fs'

const SAMPLE = `
# Material Count: 3
newmtl _01_-_Default1noCulli__01_-_Default1noCulli
Ns 30.0000
Ka 0.640000 0.640000 0.640000
Kd 0.640000 0.640000 0.640000
Ks 0.050000 0.050000 0.050000
Ni 1.000000
d 1.000000
illum 2
map_Kd 01_-_Default1noCulling.JPG


newmtl FrontColorNoCullingID_male-02-1noCulling.JP
Ns 30
Ka 0.8 0.8 0.8
Kd 0.8 0.8 0.8
Ks 0.05 0.05 0.05
d 1.0
illum 2
map_Kd male-02-1noCulling.JPG

newmtl shiny_with_options
Ns 500
Kd 1 0.9 0.8
Tr 0.25
map_Kd -s 1 1 1 -o 0 0 0 textures/board.png
bump -clamp wood_bump.jpg
`

describe('parseMtl', () => {
  it('newmtl blocks: names are normalized (spaces → hyphens)', () => {
    const lib = parseMtl(SAMPLE)
    expect(lib.materials.length).toBe(3)
    expect(lib.materials[0]!.name).toBe('_01_-_Default1noCulli__01_-_Default1noCulli')
    expect(lib.materials[1]!.name).toBe('FrontColorNoCullingID_male-02-1noCulling.JP')
  })

  it('Kd/Ka/Ks/Ns/d/illum are read', () => {
    const lib = parseMtl(SAMPLE)
    const m = lib.materials[0]!
    expect([...m.diffuse]).toEqual([0.64, 0.64, 0.64])
    expect([...m.ambient]).toEqual([0.64, 0.64, 0.64])
    expect([...m.specular]).toEqual([0.05, 0.05, 0.05])
    expect(m.shininess).toBe(30)
    expect(m.opacity).toBe(1)
    expect(m.illum).toBe(2)
  })

  it('map_Kd — the texture path; options (-s/-o) are dropped; Tr is inverted', () => {
    const lib = parseMtl(SAMPLE)
    expect(lib.materials[0]!.mapKd).toBe('01_-_Default1noCulling.JPG')
    const m = lib.materials[2]!
    expect(m.mapKd).toBe('textures/board.png') // the last non-option token
    expect(m.mapBump).toBe('wood_bump.jpg')
    expect(m.opacity).toBe(0.75) // Tr 0.25 → d 0.75
    expect(m.shininess).toBe(500)
  })

  it('get(name) by usemtl name; absence — undefined', () => {
    const lib = parseMtl(SAMPLE)
    expect(lib.get('FrontColorNoCullingID_male-02-1noCulling.JP')?.mapKd).toBe('male-02-1noCulling.JPG')
    expect(lib.get('no-such-name')).toBeUndefined()
  })

  it('real male02.mtl: 5 materials, all with map_Kd, OBJ group names match', () => {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(readFileSync('/home/z/my-project/scripts/models-demo/assets/male02.mtl'))
    } catch {
      return // the asset is not required in a clean environment
    }
    const lib = parseMtlBytes(bytes)
    expect(lib.stats.materials).toBe(5)
    expect(lib.stats.withMapKd).toBe(5)
    // Name from OBJ usemtl: 'male-02-1noCullingID_male-02-1noCulling.JP'
    const m = lib.get('male-02-1noCullingID_male-02-1noCulling.JP')
    expect(m?.mapKd).toBe('male-02-1noCulling.JPG')
    expect(m?.diffuse[0]).toBeGreaterThan(0)
    expect(lib.materials[0]!.mapKd).toBe('01_-_Default1noCulling.JPG')
  })
})
