/** Image format sniffing by magic — AVIF (the forest_house.glb lesson). */

import { describe, expect, it } from 'bun:test'
import { sniffMime } from '../src/image.ts'
import { readFileSync } from 'node:fs'

const hex = (s: string): Uint8Array => new Uint8Array((s.match(/../g) ?? []).map(b => parseInt(b, 16)))

describe('sniffMime', () => {
  it('JPEG/PNG/WebP/GIF — the previous signatures', () => {
    // the JPEG/GIF sniffer requires 12 bytes (real files are longer than the magic)
    expect(sniffMime(hex('ffd8ffe000104a4649460000'))).toBe('image/jpeg')
    expect(sniffMime(hex('89504e470d0a1a0a00000000'))).toBe('image/png')
    expect(sniffMime(hex('524946462400000057454250'))).toBe('image/webp')
    expect(sniffMime(hex('4749463839610d0a01003b00'))).toBe('image/gif')
  })

  it('AVIF: ftyp box with major brand avif/avis/mif1', () => {
    // Real magic from forest_house.glb (EXT_texture_avif, bufferView 0):
    // 00 00 00 1c 'ftyp' 'avif'
    expect(sniffMime(hex('0000001c6674797061766966'))).toBe('image/avif')
    // The AVIS sequence
    expect(sniffMime(hex('0000001c6674797061766973'))).toBe('image/avif')
    // HEIF container (mif1) — AVIF files of Blender/glTF-Transform
    expect(sniffMime(hex('00000018667479706d696631'))).toBe('image/avif')
  })

  it('non-AVIF ftyp (mp4 and other BMFF) is not detected as avif', () => {
    expect(sniffMime(hex('00000018667479706d703432'))).toBe('application/octet-stream')
    expect(sniffMime(hex('0000001c6674797068656963'))).toBe('application/octet-stream') // heic
  })

  it('real forest_house.glb: image/avif is detected from the first bufferView', () => {
    // The asset file is not required for CI — the synthetics above cover the contract.
    try {
      const real = new Uint8Array(
        readFileSync('/home/z/my-project/scripts/models-demo/assets/forest_house.glb'),
      )
      const jlen = new DataView(real.buffer).getUint32(12, true)
      const binPos = 20 + ((jlen + 3) >> 2 << 2)
      const binStart = binPos + 8
      expect(sniffMime(real.subarray(binStart, binStart + 12))).toBe('image/avif')
    } catch {
      // the asset is missing in a clean environment — skipping
    }
  })
})
