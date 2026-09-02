/**
 * GPUFacade tests — new contracts (M4-addendum-2):
 *  - createTexture with mipLevels → record with mipLevels=N
 *  - copyExternalImageToTextureMip → record with mip=N
 *  - gpu.adapter — public getter (null in recordingGPU)
 *  - gpu.preferredFormat — public getter ('bgra8unorm' by default)
 */

import { describe, expect, it } from 'bun:test'
import { createRecordingGPU } from '../src/recordingGPU.ts'

describe('GPUFacade mip-chain', () => {
  it('createTexture without options → record without mipLevels', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(128, 128)
    expect(calls[0]).toBe('createTexture(128,128)')
  })

  it('createTexture with format=canvas → record with canvas suffix', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(800, 600, 'canvas')
    expect(calls[0]).toBe('createTexture(800,600,canvas)')
  })

  it('createTexture with mipLevels=9 → record with mipLevels=9', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9 })
    expect(calls[0]).toBe('createTexture(256,256,mipLevels=9)')
  })

  it('createTexture with canvas format and mipLevels=7 → record with both suffixes', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(64, 64, 'canvas', { mipLevels: 7 })
    expect(calls[0]).toBe('createTexture(64,64,canvas,mipLevels=7)')
  })

  it('createTexture with mipLevels=1 → record without the mipLevels suffix', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(64, 64, 'rgba8unorm', { mipLevels: 1 })
    expect(calls[0]).toBe('createTexture(64,64)')
  })

  it('createTexture with maxAnisotropy=8 → record with aniso=8', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256, 'rgba8unorm', { mipLevels: 4, maxAnisotropy: 8 })
    expect(calls[0]).toBe('createTexture(256,256,mipLevels=4,aniso=8)')
  })

  it('createTexture with maxAnisotropy without mipLevels → aniso= without mips (pointless but valid)', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(64, 64, 'rgba8unorm', { maxAnisotropy: 4 })
    expect(calls[0]).toBe('createTexture(64,64,aniso=4)')
  })

  it('createTexture with mipLevels + maxAnisotropy + canvas format → all suffixes', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256, 'canvas', { mipLevels: 9, maxAnisotropy: 16 })
    expect(calls[0]).toBe('createTexture(256,256,canvas,mipLevels=9,aniso=16)')
  })

  it('copyExternalImageToTexture — record with kind, dst origin and copy size', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 128, height: 128 } as unknown as ImageBitmap
    gpu.createTexture(128, 128)
    // Full upload: dstX=0, dstY=0, copySize=source size
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

  it('copyExternalImageToTextureMip — record with mipLevel=N and origin', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 8, height: 8 } as unknown as ImageBitmap
    gpu.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9 })
    // Upload mip level=5 (size 256/(2^5) = 8). dstX=0, dstY=0, copySize=8×8
    gpu.copyExternalImageToTextureMip(1, 5, src, 0, 0, 8, 8)
    expect(calls[1]).toContain('copyExternalImageToTextureMip')
    expect(calls[1]).toContain('mip=5')
    expect(calls[1]).toContain('@0,0')
    expect(calls[1]).toContain('8x8')
  })

  it('copyExternalImageToTexture — without the flipY option → no flipY suffix', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 64, height: 64, close: () => {} } as unknown as ImageBitmap
    gpu.createTexture(64, 64)
    gpu.copyExternalImageToTexture(1, src, 0, 0, 64, 64)
    expect(calls[1]).toBe('copyExternalImageToTexture(1,ImageBitmap,@0,0,64x64)')
  })

  it('copyExternalImageToTexture — flipY=false → no flipY suffix', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 64, height: 64, close: () => {} } as unknown as ImageBitmap
    gpu.createTexture(64, 64)
    gpu.copyExternalImageToTexture(1, src, 0, 0, 64, 64, false)
    expect(calls[1]).toBe('copyExternalImageToTexture(1,ImageBitmap,@0,0,64x64)')
  })

  it('copyExternalImageToTexture — flipY=true → flipY suffix present', () => {
    const { gpu, calls } = createRecordingGPU()
    const src = { width: 64, height: 64, close: () => {} } as unknown as ImageBitmap
    gpu.createTexture(64, 64)
    gpu.copyExternalImageToTexture(1, src, 0, 0, 64, 64, true)
    expect(calls[1]).toBe('copyExternalImageToTexture(1,ImageBitmap,@0,0,64x64,flipY)')
  })

  it('copyExternalImageToTextureMip — flipY=true → flipY suffix present', () => {
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

  it('recordingGPU.preferredFormat is stable across repeated reads', () => {
    const { gpu } = createRecordingGPU()
    const f1 = gpu.preferredFormat
    const f2 = gpu.preferredFormat
    expect(f1).toBe(f2)
  })
})

describe('GPUFacade dispose', () => {
  it('dispose — recorded in calls', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.dispose()
    expect(calls[calls.length - 1]).toBe('dispose')
  })

  it('dispose — a repeated call is also recorded (recording logs all calls)', () => {
    // realGPU uses a facadeDisposed flag so the second dispose is a no-op.
    // recordingGPU is a mock, logging every call without state.
    // This test fixes the recording facade's behavior (for tape debugging):
    // every dispose = one line in calls.
    const { gpu, calls } = createRecordingGPU()
    gpu.dispose()
    gpu.dispose()
    const disposeCalls = calls.filter(c => c === 'dispose')
    expect(disposeCalls.length).toBe(2)
  })

  it('dispose — createTexture can be called after it (recording does not block)', () => {
    // After dispose() realGPU formally stays in a signed form (returns an
    // object with the same methods), but device.destroy() makes any GPU
    // call throw. recordingGPU is a mock, it does not emulate this. The
    // test fixes that the recording facade does not crash on a post-dispose
    // createTexture.
    const { gpu, calls } = createRecordingGPU()
    gpu.dispose()
    gpu.createTexture(64, 64)
    expect(calls[calls.length - 1]).toBe('createTexture(64,64)')
  })

  it('dispose — correct place in the sequence (after draw)', () => {
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
  it('installTimer(null) — record installTimer(null)', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.installTimer(null)
    expect(calls[calls.length - 1]).toBe('installTimer(null)')
  })

  it('installTimer(handle) — record installTimer(handle)', () => {
    const { gpu, calls } = createRecordingGPU()
    const handle = {
      onBeginPass: () => {},
      onEndPass: () => {},
      onSubmit: () => {},
    }
    gpu.installTimer(handle)
    expect(calls[calls.length - 1]).toBe('installTimer(handle)')
  })

  it('installTimer returns null — recording does not store the previous handle', () => {
    const { gpu } = createRecordingGPU()
    const prev = gpu.installTimer(null)
    expect(prev).toBeNull()
  })

  it('gpu.timer — recording returns null (no device, no timer)', () => {
    const { gpu } = createRecordingGPU()
    expect(gpu.timer).toBeNull()
  })

  it('gpu.timer is stable across repeated reads (recording is always null)', () => {
    const { gpu } = createRecordingGPU()
    expect(gpu.timer).toBeNull()
    expect(gpu.timer).toBeNull()
  })
})

describe('GPUFacade createTextureView + deleteTextureView', () => {
  it('createTextureView without options — record without the mip suffix', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256)
    const viewId = gpu.createTextureView(1)
    expect(calls[1]).toBe('createTextureView(1)')
    expect(viewId).toBeGreaterThanOrEqual(1_000_000)
  })

  it('createTextureView with baseMipLevel — record with the mip=N suffix', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256)
    gpu.createTextureView(1, { baseMipLevel: 2 })
    expect(calls[1]).toBe('createTextureView(1,mip=2)')
  })

  it('createTextureView with baseMipLevel+mipLevelCount — record with the mip=N+M suffix', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256)
    gpu.createTextureView(1, { baseMipLevel: 2, mipLevelCount: 3 })
    expect(calls[1]).toBe('createTextureView(1,mip=2+3)')
  })

  it('createTextureView with only mipLevelCount — record without base, but with +count', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256)
    gpu.createTextureView(1, { mipLevelCount: 4 })
    expect(calls[1]).toBe('createTextureView(1,mip=0+4)')
  })

  it('createTextureView returns different viewIds for different calls', () => {
    const { gpu } = createRecordingGPU()
    gpu.createTexture(256, 256)
    const v1 = gpu.createTextureView(1)
    const v2 = gpu.createTextureView(1, { baseMipLevel: 2 })
    expect(v1).not.toBe(v2)
    expect(v2).toBeGreaterThan(v1)
  })

  it('deleteTextureView(viewId) — recorded', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createTexture(256, 256)
    const viewId = gpu.createTextureView(1)
    gpu.deleteTextureView(viewId)
    expect(calls[calls.length - 1]).toBe(`deleteTextureView(${viewId})`)
  })

  it('createTextureView returns a viewId ≥ 1_000_000 (a separate namespace)', () => {
    const { gpu } = createRecordingGPU()
    gpu.createTexture(64, 64)
    gpu.createTexture(64, 64)
    // textureId 1, 2 — below 1M
    const viewId = gpu.createTextureView(1)
    expect(viewId).toBeGreaterThanOrEqual(1_000_000)
  })
})
