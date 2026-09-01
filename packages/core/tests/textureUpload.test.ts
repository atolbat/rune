import { describe, expect, it } from 'bun:test'
import { createUploadScheduler } from '../src/streaming/uploadScheduler.ts'
import { streamTexture } from '../src/streaming/textureUpload.ts'

describe('streamTexture (превью → чанки → прогресс)', () => {
  it('превью идёт первым (приоритет +1), прогресс доезжает до 1', async () => {
    const scheduler = createUploadScheduler({ initialBytes: 1024 * 1024, minBytes: 64 * 1024 })
    const order: string[] = []
    let progress = 0
    const source = new Uint8Array(256 * 128 * 4)
    const upload = streamTexture(scheduler, source, 256, 128,
      (tile, _bytes) => order.push(tile.width < 256 ? `preview:${tile.width}x${tile.height}` : 'chunk'),
      { priority: 1, onProgress: f => { progress = f } })
    scheduler.drain()
    await upload.done
    expect(order[0].startsWith('preview:')).toBe(true) // превью обгоняет
    expect(order.filter(kind => kind === 'chunk').length).toBeGreaterThan(0)
    expect(progress).toBe(1)
  })

  it('окно растягивает БОЛЬШУЮ загрузку по кадрам — анти-лаг (теория N: > бёрст-капа)', async () => {
    const scheduler = createUploadScheduler({ initialBytes: 64 * 1024, minBytes: 64 * 1024 })
    const source = new Uint8Array(2048 * 1024 * 4) // 8 МиБ — больше бёрст-капа
    const frames: number[] = []
    let ran = 0
    const upload = streamTexture(scheduler, source, 2048, 1024, () => { ran++ }, { priority: 1 })
    for (let frame = 0; frame < 60 && upload.progress < 1; frame++) {
      scheduler.drain()
      frames.push(ran)
    }
    await upload.done
    expect(frames.length).toBeGreaterThan(1) // не всё в один кадр
    expect(upload.progress).toBe(1)
  })

  it('cancel до drain: загрузка молчит, done резолвится', async () => {
    const scheduler = createUploadScheduler()
    const source = new Uint8Array(256 * 64 * 4)
    let ran = 0
    const upload = streamTexture(scheduler, source, 256, 64, () => { ran++ }, { priority: 1 })
    upload.cancel()
    scheduler.drain()
    await upload.done
    expect(ran).toBe(0)
  })

  it('теория N: 1024² грузится за ОДИН idle-слот — без видимого заполнения', async () => {
    const scheduler = createUploadScheduler() // дефолт: бёрст-кап 4 МиБ
    const source = new Uint8Array(1024 * 1024 * 4)
    let uploads = 0
    const upload = streamTexture(scheduler, source, 1024, 1024, () => { uploads++ }, { priority: 1 })
    scheduler.drain()
    expect(scheduler.pending).toBe(0) // всё в первом же idle-слоте
    expect(upload.progress).toBe(1)
    await upload.done
    expect(uploads).toBe(65) // превью 128×128 + 64 тайла 1024×16
  })

  it('теория N: бёрст работает и после простоя — окно распустилось до минимума', () => {
    const scheduler = createUploadScheduler({ initialBytes: 2 * 1024 * 1024, minBytes: 64 * 1024 })
    for (let frame = 0; frame < 40; frame++) scheduler.drain() // простой: окно ×7/8
    expect(scheduler.window).toBe(64 * 1024)
    const source = new Uint8Array(512 * 512 * 4) // 1 МиБ
    const upload = streamTexture(scheduler, source, 512, 512, () => {})
    scheduler.drain()
    expect(upload.progress).toBe(1) // спрос поднял окно — снова один кадр
  })
})
