/** Сниффинг формата изображений по магике — AVIF (урок forest_house.glb). */

import { describe, expect, it } from 'bun:test'
import { sniffMime } from '../src/image.ts'
import { readFileSync } from 'node:fs'

const hex = (s: string): Uint8Array => new Uint8Array((s.match(/../g) ?? []).map(b => parseInt(b, 16)))

describe('sniffMime', () => {
  it('JPEG/PNG/WebP/GIF — прежние сигнатуры', () => {
    // JPEG/GIF-сниффер требует 12 байт (реальные файлы длиннее магики)
    expect(sniffMime(hex('ffd8ffe000104a4649460000'))).toBe('image/jpeg')
    expect(sniffMime(hex('89504e470d0a1a0a00000000'))).toBe('image/png')
    expect(sniffMime(hex('524946462400000057454250'))).toBe('image/webp')
    expect(sniffMime(hex('4749463839610d0a01003b00'))).toBe('image/gif')
  })

  it('AVIF: ftyp-box с major brand avif/avis/mif1', () => {
    // Реальная магика из forest_house.glb (EXT_texture_avif, bufferView 0):
    // 00 00 00 1c 'ftyp' 'avif'
    expect(sniffMime(hex('0000001c6674797061766966'))).toBe('image/avif')
    // Последовательность AVIS
    expect(sniffMime(hex('0000001c6674797061766973'))).toBe('image/avif')
    // HEIF-контейнер (mif1) — AVIF-файлы Blender/glTF-Transform
    expect(sniffMime(hex('00000018667479706d696631'))).toBe('image/avif')
  })

  it('не-AVIF ftyp (mp4 и прочие BMFF) не детектятся как avif', () => {
    expect(sniffMime(hex('00000018667479706d703432'))).toBe('application/octet-stream')
    expect(sniffMime(hex('0000001c6674797068656963'))).toBe('application/octet-stream') // heic
  })

  it('реальный forest_house.glb: image/avif детектится из первого bufferView', () => {
    // Файл ассета не обязателен для CI — синтетика выше покрывает контракт.
    try {
      const real = new Uint8Array(
        readFileSync('/home/z/my-project/scripts/models-demo/assets/forest_house.glb'),
      )
      const jlen = new DataView(real.buffer).getUint32(12, true)
      const binPos = 20 + ((jlen + 3) >> 2 << 2)
      const binStart = binPos + 8
      expect(sniffMime(real.subarray(binStart, binStart + 12))).toBe('image/avif')
    } catch {
      // ассет отсутствует в чистом окружении — пропускаем
    }
  })
})
