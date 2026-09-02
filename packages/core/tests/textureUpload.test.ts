import { describe, expect, it } from 'bun:test'
import { createUploadScheduler } from '../src/streaming/uploadScheduler.ts'
import { streamTexture } from '../src/streaming/textureUpload.ts'

describe('streamTexture (preview → chunks → progress)', () => {
  it('preview goes first (priority +1), progress reaches 1', async () => {
    const scheduler = createUploadScheduler({ initialBytes: 1024 * 1024, minBytes: 64 * 1024 })
    const order: string[] = []
    let progress = 0
    const source = new Uint8Array(256 * 128 * 4)
    const upload = streamTexture(scheduler, source, 256, 128,
      (tile, _bytes) => order.push(tile.width < 256 ? `preview:${tile.width}x${tile.height}` : 'chunk'),
      { priority: 1, onProgress: f => { progress = f } })
    scheduler.drain()
    await upload.done
    expect(order[0].startsWith('preview:')).toBe(true) // the preview overtakes
    expect(order.filter(kind => kind === 'chunk').length).toBeGreaterThan(0)
    expect(progress).toBe(1)
  })

  it('the window spreads a BIG upload across frames — anti-lag (theory N: above the burst cap)', async () => {
    const scheduler = createUploadScheduler({ initialBytes: 64 * 1024, minBytes: 64 * 1024 })
    const source = new Uint8Array(2048 * 1024 * 4) // 8 MiB — above the burst cap
    const frames: number[] = []
    let ran = 0
    const upload = streamTexture(scheduler, source, 2048, 1024, () => { ran++ }, { priority: 1 })
    for (let frame = 0; frame < 60 && upload.progress < 1; frame++) {
      scheduler.drain()
      frames.push(ran)
    }
    await upload.done
    expect(frames.length).toBeGreaterThan(1) // not all in a single frame
    expect(upload.progress).toBe(1)
  })

  it('cancel before drain: the upload stays silent, done resolves', async () => {
    const scheduler = createUploadScheduler()
    const source = new Uint8Array(256 * 64 * 4)
    let ran = 0
    const upload = streamTexture(scheduler, source, 256, 64, () => { ran++ }, { priority: 1 })
    upload.cancel()
    scheduler.drain()
    await upload.done
    expect(ran).toBe(0)
  })

  it('theory N: 1024² uploads in ONE idle slot — without visible filling', async () => {
    const scheduler = createUploadScheduler() // default: a 4 MiB burst cap
    const source = new Uint8Array(1024 * 1024 * 4)
    let uploads = 0
    const upload = streamTexture(scheduler, source, 1024, 1024, () => { uploads++ }, { priority: 1 })
    scheduler.drain()
    expect(scheduler.pending).toBe(0) // everything in the very first idle slot
    expect(upload.progress).toBe(1)
    await upload.done
    expect(uploads).toBe(65) // preview 128×128 + 64 tiles 1024×16
  })

  it('theory N: burst works after idle too — the window shrank to the minimum', () => {
    const scheduler = createUploadScheduler({ initialBytes: 2 * 1024 * 1024, minBytes: 64 * 1024 })
    for (let frame = 0; frame < 40; frame++) scheduler.drain() // idle: the window ×7/8
    expect(scheduler.window).toBe(64 * 1024)
    const source = new Uint8Array(512 * 512 * 4) // 1 MiB
    const upload = streamTexture(scheduler, source, 512, 512, () => {})
    scheduler.drain()
    expect(upload.progress).toBe(1) // demand raised the window — a single frame again
  })
})
