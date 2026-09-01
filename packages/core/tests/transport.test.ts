import { describe, expect, it } from 'bun:test'
import {
  createTransport,
  createTransportHost,
  attachTransport,
  detectTransport,
  hasSharedArrayBuffer,
  createMsgFeedWriter,
  createMsgFeedReader,
  signal,
} from '../src/index.ts'
import type { TransportMode } from '../src/index.ts'

const NAMES = ['game.hp', 'app.visibility', 'app.focus'] as const

describe('detectTransport', () => {
  it('SAB + waitAsync → T1 (sab+async)', () => {
    expect(detectTransport({ sharedArrayBuffer: true, waitAsync: true })).toBe('sab+async')
  })

  it('SAB без waitAsync → T2 (sab)', () => {
    expect(detectTransport({ sharedArrayBuffer: true, waitAsync: false })).toBe('sab')
  })

  it('нет SAB → T3 (msg)', () => {
    expect(detectTransport({ sharedArrayBuffer: false, waitAsync: false })).toBe('msg')
    expect(detectTransport({ sharedArrayBuffer: false, waitAsync: true })).toBe('msg')
  })

  it('окружение bun: SAB есть — T1 или T2, но не msg', () => {
    const mode = detectTransport()
    expect(['sab+async', 'sab']).toContain(mode)
    expect(hasSharedArrayBuffer()).toBe(true)
  })
})

/** Сценарий «шелл пишет сигналы → рендер-мир читает на границе кадра»
 *  на всех режимах: семантика одна, меняется только механизм.
 *  T0 — уведомления текут синхронно в момент записи (тот же сигнальный
 *  граф); T1/T2/T3 — семплирование/apply на границе эпохи. */
function signalScenario(mode: TransportMode): void {
  const { host, client } = createTransport({ mode, names: NAMES })
  const hp = client.shared('game.hp')
  const visibility = client.shared('app.visibility')

  // До записи — нули (снапшот пустой эпохи).
  expect(hp.value).toBe(0)

  let hpSeen = -1
  let visibilitySeen = -1
  hp.subscribe(v => { hpSeen = v })
  visibility.subscribe(v => { visibilitySeen = v })

  // Хост пишет (владелец-писатель).
  host.write('game.hp', 85)
  host.write('app.visibility', 1)
  if (mode === 'memory') {
    // T0: синхронно — подписчики уже увидели без границы кадра.
    expect(hpSeen).toBe(85)
    expect(visibilitySeen).toBe(1)
    expect(client.sampleAll()).toBe(0)
    return
  }

  // Граница кадра: снапшот изменившихся слотов.
  const changed = client.sampleAll()
  expect(changed).toBe(2)
  expect(hp.value).toBe(85)
  expect(visibility.value).toBe(1)
  expect(hpSeen).toBe(85)
  expect(visibilitySeen).toBe(1)

  // Вторая эпоха: изменился только один слот.
  host.write('game.hp', 40)
  expect(client.sampleAll()).toBe(1)
  expect(hpSeen).toBe(40)
  expect(visibilitySeen).toBe(1) // не тронут

  // Третья эпоха: без изменений — ноль уведомлений.
  expect(client.sampleAll()).toBe(0)
}

describe('транспорты: инвариант деградации (семантика одна)', () => {
  it('T0 memory: синхронно, тот же сигнальный граф', () => {
    signalScenario('memory')
  })

  it('T1 sab+async: seqlock + эпохи', () => {
    signalScenario('sab+async')
  })

  it('T2 sab: seqlock + эпохи', () => {
    signalScenario('sab')
  })

  it('T3 msg: дельты одним сообщением на кадр', () => {
    const { host, client } = createTransport({ mode: 'msg', names: NAMES })
    const hp = client.shared('game.hp')
    let hpSeen = -1
    hp.subscribe(v => { hpSeen = v })

    host.write('game.hp', 85)
    host.write('app.visibility', 1)
    host.write('app.focus', 1)
    // Кадр не закрыт — сообщение ещё не уехало: пустая эпоха.
    expect(client.sampleAll()).toBe(0)

    const message = host.flush()
    expect(message).not.toBeNull()
    expect(message!.deltas.length).toBe(3) // батч: одно сообщение на кадр

    client.apply(message!)
    expect(client.sampleAll()).toBe(3)
    expect(hp.value).toBe(85)
    expect(hpSeen).toBe(85)

    // Второй кадр: только изменившееся.
    host.write('game.hp', 10)
    const second = host.flush()
    expect(second!.deltas.length).toBe(1)
    client.apply(second!)
    expect(client.sampleAll()).toBe(1)
    expect(hpSeen).toBe(10)

    // Без изменений — flush возвращает null (сообщения нет).
    expect(host.flush()).toBeNull()
  })
})

describe('транспорты: share() связывает сигнал-источник', () => {
  it('T1: источник-сигнал → слот, изменение утекает без сообщений', () => {
    const { host, client } = createTransport({ mode: 'sab+async', names: NAMES })
    const hpSource = signal(100)
    host.share(hpSource, 'game.hp')
    hpSource.value = 55
    const hpMirror = client.shared('game.hp')
    expect(hpMirror.value).toBe(55)
    expect(client.sampleAll()).toBe(1)
  })

  it('T3: источник-сигнал → дельта в сообщении', () => {
    const { host, client } = createTransport({ mode: 'msg', names: NAMES })
    const hpSource = signal(100)
    host.share(hpSource, 'game.hp')
    hpSource.value = 7
    const message = host.flush()
    expect(message!.deltas.length).toBe(1)
    client.apply(message!)
    client.sampleAll()
    expect(client.shared('game.hp').value).toBe(7)
  })
})

describe('транспорты: фиды', () => {
  const LAYOUT = { position: 'float32x3', color: 'float32x3', radius: 'float32' } as const

  it('T1/T2: воркер пишет в SAB-ринг, читатель снимает атомарный счётчик', () => {
    const { host, client } = createTransport({ mode: 'sab', names: NAMES })
    const feed = host.createFeed({ layout: LAYOUT, capacity: 64 })
    const view = client.feed(1)
    expect(view).not.toBeNull()

    const batch = feed.push(3)
    batch.setVec3('position', 0, 1, 2, 3)
    batch.setVec3('position', 1, 4, 5, 6)
    batch.setVec3('color', 0, 9, 8, 7)
    batch.setFloat('radius', 2, 0.5)

    expect(view!.count()).toBe(0) // до publish не видно
    feed.publish()
    expect(view!.count()).toBe(3)

    const bytes = view!.bytes()
    expect(bytes.length).toBe(64 * 7) // capacity * stride/4
    expect(bytes[0]).toBe(1) // position.x записи 0
    expect(bytes[3]).toBe(9) // color.x записи 0
    expect(bytes[2 * 7 + 6]).toBe(0.5) // radius записи 2 (stride 7 float)
    // Идентичность view стабильна (GPU-кэш по ней).
    expect(view!.bytes()).toBe(bytes)
  })

  it('T0: local-буфер, семантика та же', () => {
    const { host, client } = createTransport({ mode: 'memory', names: NAMES })
    const feed = host.createFeed({ layout: LAYOUT, capacity: 16 })
    feed.push(2).setVec3('position', 0, 1, 0, 0)
    feed.publish()
    // T0: канал общий — читаем сам фид.
    expect(feed.publishedCount()).toBe(2)
    void client
  })

  it('T3: ping-pong — чанки transferable, буферы возвращаются в пул', () => {
    const { host, client } = createTransport({ mode: 'msg', names: NAMES })
    const feed = host.createFeed({ layout: LAYOUT, capacity: 64 })
    const view = client.feed(1)
    expect(view).not.toBeNull()

    // Кадр 1: три записи.
    const b1 = feed.push(3)
    b1.setVec3('position', 0, 1, 1, 1)
    b1.setFloat('radius', 1, 2.5)
    feed.publish()
    const writtenBuffer = feed.buffer as ArrayBuffer // flush сменит current на новый
    const msg1 = host.flush()
    expect(msg1!.chunks.length).toBe(1)
    expect(msg1!.chunks[0]!.count).toBe(3)
    expect(msg1!.chunks[0]!.bytes).toBe(writtenBuffer) // ping-pong: сам буфер, без копии
    const firstBuffer = msg1!.chunks[0]!.bytes

    client.apply(msg1!)
    expect(view!.count()).toBe(3)
    expect(view!.bytes()[0]).toBe(1)
    expect(view!.bytes()[1 * 7 + 6]).toBe(2.5) // запись 1, radius (stride 7 float)

    // Читатель загрузил в GPU — возвращает буфер.
    view!.recycle()

    // Кадр 2: writer уже на новом буфере (ship-and-replace — без простоя);
    // возвращённый firstBuffer вернётся в оборот со следующего flush.
    const secondBuffer = feed.buffer as ArrayBuffer
    expect(secondBuffer).not.toBe(firstBuffer)
    const b2 = feed.push(2)
    b2.setVec3('position', 0, 9, 9, 9)
    feed.publish()
    const msg2 = host.flush()
    expect(msg2!.chunks[0]!.from).toBe(3) // логическое смещение
    expect(msg2!.chunks[0]!.bytes).toBe(secondBuffer)
    client.apply(msg2!)
    expect(view!.count()).toBe(5)
    expect(view!.bytes()[3 * 7]).toBe(9) // запись 3, position.x
    // Ping-pong: возвращённый буфер стал текущим у писателя.
    expect(feed.buffer).toBe(firstBuffer)
  })

  it('T3 standalone: писатель в воркере, читатель в рендер-мире (без транспорта)', () => {
    const writer = createMsgFeedWriter(7, { layout: LAYOUT, capacity: 32 })
    const reader = createMsgFeedReader(7, { layout: LAYOUT, capacity: 32 })

    writer.feed.push(2).setVec3('position', 0, 3, 3, 3)
    writer.feed.publish()
    const chunks = writer.ship()
    expect(chunks.length).toBe(1)

    reader.apply(chunks)
    expect(reader.view.count()).toBe(2)
    expect(reader.view.bytes()[0]).toBe(3)

    reader.view.recycle()
    const recycled = reader.takeRecycled()
    expect(recycled.length).toBe(1)
    writer.reclaim(recycled)

    // Возвращённый буфер вернётся писателю на СЛЕДУЮЩЕМ ship-цикле
    // (ship-and-replace: без простоя на не-возвращённых буферах).
    writer.feed.push(1).setFloat('radius', 0, 1.5)
    writer.feed.publish()
    writer.ship()
    expect(writer.feed.buffer).toBe(recycled[0]!.bytes)
  })
})

describe('транспорты: кросс-мирная связка (descriptor)', () => {
  it('sab: describe → attachTransport в другом мире', () => {
    const host = createTransportHost({ mode: 'sab', names: NAMES })
    const feed = host.createFeed({ layout: { value: 'float32' }, capacity: 8 })
    // «Другой мир»: тот же SAB через дескриптор (запись — ПОСЛЕ attach,
    // как в живом сценарии: реестр поднят, потом шелл пишет).
    const client = attachTransport(host.describe())
    host.write('game.hp', 33)
    feed.push(1).setFloat('value', 0, 42)
    feed.publish()

    expect(client.shared('game.hp').value).toBe(33)
    expect(client.sampleAll()).toBe(1)
    const view = client.feed(1)
    expect(view!.count()).toBe(1)
    expect(view!.bytes()[0]).toBe(42)
  })

  it('msg: describe → attachTransport, фид привязывается по метаданным', () => {
    const host = createTransportHost({ mode: 'msg', names: NAMES })
    const client = attachTransport(host.describe())
    host.write('game.hp', 12)
    const feed = host.createFeed({ layout: { value: 'float32' }, capacity: 8 })
    // Фид создан ПОСЛЕ attach — читатель привязывает по метаданным later:
    const view = client.attachFeed(1, { value: 'float32' }, 8)
    feed.push(1).setFloat('value', 0, 5)
    feed.publish()
    client.apply(host.flush()!)
    expect(view.count()).toBe(1)
    expect(view.bytes()[0]).toBe(5)
    expect(client.shared('game.hp').value).toBe(12)
  })
})

describe('T1: futex-ожидание (редкие ожидания)', () => {
  it('waitForChange просыпается от записи в слот', async () => {
    const { host, client } = createTransport({ mode: 'sab+async', names: NAMES })
    const promise = client.waitForChange('game.hp', 500)
    host.write('game.hp', 1)
    const changed = await promise
    expect(changed).toBe(true)
  })

  it('waitForChange таймаут без записи → false', async () => {
    const { client } = createTransport({ mode: 'sab+async', names: NAMES })
    const changed = await client.waitForChange('game.hp', 5)
    expect(changed).toBe(false)
  })

  it('не-T1 режимы → false без ожидания', async () => {
    const { client } = createTransport({ mode: 'msg', names: NAMES })
    expect(await client.waitForChange('game.hp')).toBe(false)
  })
})
