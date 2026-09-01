/**
 * Тесты GPUFacade — новые контракты (M4-addendum-2):
 *  - createTexture с mipLevels → запись с mipLevels=N
 *  - copyExternalImageToTextureMip → запись с mip=N
 *  - gpu.adapter — публичный геттер (null в recordingGPU)
 *  - gpu.preferredFormat — публичный геттер ('bgra8unorm' по умолчанию)
 */

import { describe, expect, it } from 'bun:test'
import { createRecordingGPU } from '../src/recordingGPU.ts'

describe('GPUFacade mip-chain', () => {
  it('createTexture без options → запись без mipLevels', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(128, 128)
    expect(calls[0]).toBe('createTexture(128,128)')
  })

  it('createTexture с format=canvas → запись с canvas-suffix', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(800, 600, 'canvas')
    expect(calls[0]).toBe('createTexture(800,600,canvas)')
  })

  it('createTexture с mipLevels=9 → запись с mipLevels=9', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9 })
    expect(calls[0]).toBe('createTexture(256,256,mipLevels=9)')
  })

  it('createTexture с canvas format и mipLevels=7 → запись с обоими суффиксами', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(64, 64, 'canvas', { mipLevels: 7 })
    expect(calls[0]).toBe('createTexture(64,64,canvas,mipLevels=7)')
  })

  it('createTexture с mipLevels=1 → запись без mipLevels-суффикса', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(64, 64, 'rgba8unorm', { mipLevels: 1 })
    expect(calls[0]).toBe('createTexture(64,64)')
  })

  it('createTexture с maxAnisotropy=8 → запись с aniso=8', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256, 'rgba8unorm', { mipLevels: 4, maxAnisotropy: 8 })
    expect(calls[0]).toBe('createTexture(256,256,mipLevels=4,aniso=8)')
  })

  it('createTexture с maxAnisotropy без mipLevels → aniso= без mip (бессмысленно, но валидно)', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(64, 64, 'rgba8unorm', { maxAnisotropy: 4 })
    expect(calls[0]).toBe('createTexture(64,64,aniso=4)')
  })

  it('createTexture с mipLevels + maxAnisotropy + canvas format → все суффиксы', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256, 'canvas', { mipLevels: 9, maxAnisotropy: 16 })
    expect(calls[0]).toBe('createTexture(256,256,canvas,mipLevels=9,aniso=16)')
  })

  it('copyExternalImageToTexture — запись с kind, dst origin и copy size', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 128, height: 128 } as unknown as ImageBitmap
    gpu.createTexture(128, 128)
    // Полная загрузка: dstX=0, dstY=0, copySize=source size
    gpu.copyExternalImageToTexture(1, src, 0, 0, 128, 128)
    expect(calls[1]).toContain('copyExternalImageToTexture(1')
    expect(calls[1]).toContain('@0,0')
    expect(calls[1]).toContain('128x128')
  })

  it('copyExternalImageToTexture — sub-region upload (atlas packing)', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 64, height: 64 } as unknown as ImageBitmap
    gpu.createTexture(256, 256)
    // Sub-region: dstX=128, dstY=64, copySize=source size (64×64)
    gpu.copyExternalImageToTexture(1, src, 128, 64, 64, 64)
    expect(calls[1]).toContain('@128,64')
    expect(calls[1]).toContain('64x64')
  })

  it('copyExternalImageToTextureMip — запись с mipLevel=N и origin', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 8, height: 8 } as unknown as ImageBitmap
    gpu.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9 })
    // Загружаем mip level=5 (размер 256/(2^5) = 8). dstX=0, dstY=0, copySize=8×8
    gpu.copyExternalImageToTextureMip(1, 5, src, 0, 0, 8, 8)
    expect(calls[1]).toContain('copyExternalImageToTextureMip')
    expect(calls[1]).toContain('mip=5')
    expect(calls[1]).toContain('@0,0')
    expect(calls[1]).toContain('8x8')
  })

  it('copyExternalImageToTexture — без flipY опции → нет flipY-суффикса', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 64, height: 64, close: () => {} } as unknown as ImageBitmap
    gpu.createTexture(64, 64)
    gpu.copyExternalImageToTexture(1, src, 0, 0, 64, 64)
    expect(calls[1]).toBe('copyExternalImageToTexture(1,ImageBitmap,@0,0,64x64)')
  })

  it('copyExternalImageToTexture — flipY=false → нет flipY-суффикса', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 64, height: 64, close: () => {} } as unknown as ImageBitmap
    gpu.createTexture(64, 64)
    gpu.copyExternalImageToTexture(1, src, 0, 0, 64, 64, false)
    expect(calls[1]).toBe('copyExternalImageToTexture(1,ImageBitmap,@0,0,64x64)')
  })

  it('copyExternalImageToTexture — flipY=true → есть flipY-суффикс', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 64, height: 64, close: () => {} } as unknown as ImageBitmap
    gpu.createTexture(64, 64)
    gpu.copyExternalImageToTexture(1, src, 0, 0, 64, 64, true)
    expect(calls[1]).toBe('copyExternalImageToTexture(1,ImageBitmap,@0,0,64x64,flipY)')
  })

  it('copyExternalImageToTextureMip — flipY=true → есть flipY-суффикс', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 8, height: 8, close: () => {} } as unknown as ImageBitmap
    gpu.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9 })
    gpu.copyExternalImageToTextureMip(1, 5, src, 0, 0, 8, 8, true)
    expect(calls[1]).toContain(',flipY)')
  })
})

describe('GPUFacade public adapter/preferredFormat', () => {
  it('recordingGPU.adapter === null (headless mock)', () => {
    const { gpu } = createRecordingGPU()
    expect(gpu.adapter).toBeNull()
  })

  it('recordingGPU.preferredFormat === bgra8unorm (default)', () => {
    const { gpu } = createRecordingGPU()
    expect(gpu.preferredFormat).toBe('bgra8unorm')
  })

  it('recordingGPU.preferredFormat стабилен при повторных чтениях', () => {
    const { gpu } = createRecordingGPU()
    const f1 = gpu.preferredFormat
    const f2 = gpu.preferredFormat
    expect(f1).toBe(f2)
  })
})

describe('GPUFacade dispose', () => {
  it('dispose — запись в calls', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.dispose()
    expect(calls[calls.length - 1]).toBe('dispose')
  })

  it('dispose — повторный вызов также записывается (recording логирует все вызовы)', () => {
    // realGPU использует facadeDisposed-флаг, чтобы второй dispose был no-op.
    // recordingGPU — mock, логирует каждый вызов без состояния.
    // Этот тест фиксирует поведение recording-фасада (для отладки лент):
    // каждый dispose = одна строка в calls.
    const { gpu, calls } = createRecordingGPU()
    gpu.dispose()
    gpu.dispose()
    const disposeCalls = calls.filter(c => c === 'dispose')
    expect(disposeCalls.length).toBe(2)
  })

  it('dispose — после него createTexture можно вызвать (recording не блокирует)', () => {
    // realGPU после dispose() формально остаётся в подписанной форме (returns
    // объект с теми же методами), но device.destroy() делает любой GPU-вызов
    // бросающим. recordingGPU — mock, не эмулирует это. Тест фиксирует
    // что recording-фасад не падает на post-dispose createTexture.
    const { gpu, calls } = createRecordingGPU()
    gpu.dispose()
    gpu.createTexture(64, 64)
    expect(calls[calls.length - 1]).toBe('createTexture(64,64)')
  })

  it('dispose — корректное место в последовательности (после draw)', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(128, 128)
    gpu.beginPass(0)
    gpu.draw(6, 1)
    gpu.endPass()
    gpu.submit()
    gpu.dispose()
    expect(calls[calls.length - 1]).toBe('dispose')
    expect(calls).toContain('draw(6,1)')
    expect(calls).toContain('submit')
  })
})

describe('GPUFacade installTimer + timer getter', () => {
  it('installTimer(null) — запись installTimer(null)', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.installTimer(null)
    expect(calls[calls.length - 1]).toBe('installTimer(null)')
  })

  it('installTimer(handle) — запись installTimer(handle)', () => {
    const { gpu, calls } = createRecordingGPU()
    const handle = {
      onBeginPass: () => {},
      onEndPass: () => {},
      onSubmit: () => {},
    }
    gpu.installTimer(handle)
    expect(calls[calls.length - 1]).toBe('installTimer(handle)')
  })

  it('installTimer возвращает null — recording не хранит предыдущий handle', () => {
    const { gpu } = createRecordingGPU()
    const prev = gpu.installTimer(null)
    expect(prev).toBeNull()
  })

  it('gpu.timer — recording возвращает null (нет device, нет timer)', () => {
    const { gpu } = createRecordingGPU()
    expect(gpu.timer).toBeNull()
  })

  it('gpu.timer стабилен при повторных чтениях (recording всегда null)', () => {
    const { gpu } = createRecordingGPU()
    expect(gpu.timer).toBeNull()
    expect(gpu.timer).toBeNull()
  })
})

describe('GPUFacade createTextureView + deleteTextureView', () => {
  it('createTextureView без options — запись без mip-суффикса', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256)
    const viewId = gpu.createTextureView(1)
    expect(calls[1]).toBe('createTextureView(1)')
    expect(viewId).toBeGreaterThanOrEqual(1_000_000)
  })

  it('createTextureView с baseMipLevel — запись с mip=N суффиксом', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256)
    gpu.createTextureView(1, { baseMipLevel: 2 })
    expect(calls[1]).toBe('createTextureView(1,mip=2)')
  })

  it('createTextureView с baseMipLevel+mipLevelCount — запись с mip=N+M суффиксом', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256)
    gpu.createTextureView(1, { baseMipLevel: 2, mipLevelCount: 3 })
    expect(calls[1]).toBe('createTextureView(1,mip=2+3)')
  })

  it('createTextureView только с mipLevelCount — запись без base, но с +count', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256)
    gpu.createTextureView(1, { mipLevelCount: 4 })
    expect(calls[1]).toBe('createTextureView(1,mip=0+4)')
  })

  it('createTextureView возвращает разные viewId для разных вызовов', () => {
    const { gpu } = createRecordingGPU()
    gpu.createTexture(256, 256)
    const v1 = gpu.createTextureView(1)
    const v2 = gpu.createTextureView(1, { baseMipLevel: 2 })
    expect(v1).not.toBe(v2)
    expect(v2).toBeGreaterThan(v1)
  })

  it('deleteTextureView(viewId) — запись', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256)
    const viewId = gpu.createTextureView(1)
    gpu.deleteTextureView(viewId)
    expect(calls[calls.length - 1]).toBe(`deleteTextureView(${viewId})`)
  })

  it('createTextureView возвращает viewId ≥ 1_000_000 (отдельный namespace)', () => {
    const { gpu } = createRecordingGPU()
    gpu.createTexture(64, 64)
    gpu.createTexture(64, 64)
    // textureId 1, 2 — ниже 1M
    const viewId = gpu.createTextureView(1)
    expect(viewId).toBeGreaterThanOrEqual(1_000_000)
  })
})
