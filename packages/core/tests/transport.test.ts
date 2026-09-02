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

  it('SAB without waitAsync → T2 (sab)', () => {
    expect(detectTransport({ sharedArrayBuffer: true, waitAsync: false })).toBe('sab')
  })

  it('no SAB → T3 (msg)', () => {
    expect(detectTransport({ sharedArrayBuffer: false, waitAsync: false })).toBe('msg')
    expect(detectTransport({ sharedArrayBuffer: false, waitAsync: true })).toBe('msg')
  })

  it('bun environment: SAB present — T1 or T2, but not msg', () => {
    const mode = detectTransport()
    expect(['sab+async', 'sab']).toContain(mode)
    expect(hasSharedArrayBuffer()).toBe(true)
  })
})

/** The scenario "shell writes signals → render world reads at the frame boundary"
 *  in all modes: the semantics is the same, only the mechanism changes.
 *  T0 — notifications flow synchronously at write time (the same signal
 *  graph); T1/T2/T3 — sampling/apply at the epoch boundary. */
function signalScenario(mode: TransportMode): void {
  const { host, client } = createTransport({ mode, names: NAMES })
  const hp = client.shared('game.hp')
  const visibility = client.shared('app.visibility')

  // Before any write — zeros (snapshot of an empty epoch).
  expect(hp.value).toBe(0)

  let hpSeen = -1
  let visibilitySeen = -1
  hp.subscribe(v => { hpSeen = v })
  visibility.subscribe(v => { visibilitySeen = v })

  // The host writes (the owning writer).
  host.write('game.hp', 85)
  host.write('app.visibility', 1)
  if (mode === 'memory') {
    // T0: synchronously — subscribers have already seen it without a frame boundary.
    expect(hpSeen).toBe(85)
    expect(visibilitySeen).toBe(1)
    expect(client.sampleAll()).toBe(0)
    return
  }

  // Frame boundary: a snapshot of the changed slots.
  const changed = client.sampleAll()
  expect(changed).toBe(2)
  expect(hp.value).toBe(85)
  expect(visibility.value).toBe(1)
  expect(hpSeen).toBe(85)
  expect(visibilitySeen).toBe(1)

  // Second epoch: only one slot changed.
  host.write('game.hp', 40)
  expect(client.sampleAll()).toBe(1)
  expect(hpSeen).toBe(40)
  expect(visibilitySeen).toBe(1) // untouched

  // Third epoch: no changes — zero notifications.
  expect(client.sampleAll()).toBe(0)
}

describe('transports: degradation invariant (same semantics)', () => {
  it('T0 memory: synchronously, the same signal graph', () => {
    signalScenario('memory')
  })

  it('T1 sab+async: seqlock + epochs', () => {
    signalScenario('sab+async')
  })

  it('T2 sab: seqlock + epochs', () => {
    signalScenario('sab')
  })

  it('T3 msg: deltas as a single message per frame', () => {
    const { host, client } = createTransport({ mode: 'msg', names: NAMES })
    const hp = client.shared('game.hp')
    let hpSeen = -1
    hp.subscribe(v => { hpSeen = v })

    host.write('game.hp', 85)
    host.write('app.visibility', 1)
    host.write('app.focus', 1)
    // The frame is not closed — the message has not left yet: an empty epoch.
    expect(client.sampleAll()).toBe(0)

    const message = host.flush()
    expect(message).not.toBeNull()
    expect(message!.deltas.length).toBe(3) // batch: one message per frame

    client.apply(message!)
    expect(client.sampleAll()).toBe(3)
    expect(hp.value).toBe(85)
    expect(hpSeen).toBe(85)

    // Second frame: only what changed.
    host.write('game.hp', 10)
    const second = host.flush()
    expect(second!.deltas.length).toBe(1)
    client.apply(second!)
    expect(client.sampleAll()).toBe(1)
    expect(hpSeen).toBe(10)

    // No changes — flush returns null (no message).
    expect(host.flush()).toBeNull()
  })
})

describe('transports: share() binds a source signal', () => {
  it('T1: source signal → slot, the change leaks through without messages', () => {
    const { host, client } = createTransport({ mode: 'sab+async', names: NAMES })
    const hpSource = signal(100)
    host.share(hpSource, 'game.hp')
    hpSource.value = 55
    const hpMirror = client.shared('game.hp')
    expect(hpMirror.value).toBe(55)
    expect(client.sampleAll()).toBe(1)
  })

  it('T3: source signal → a delta in the message', () => {
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

describe('transports: feeds', () => {
  const LAYOUT = { position: 'float32x3', color: 'float32x3', radius: 'float32' } as const

  it('T1/T2: the worker writes into the SAB ring, the reader reads the atomic counter', () => {
    const { host, client } = createTransport({ mode: 'sab', names: NAMES })
    const feed = host.createFeed({ layout: LAYOUT, capacity: 64 })
    const view = client.feed(1)
    expect(view).not.toBeNull()

    const batch = feed.push(3)
    batch.setVec3('position', 0, 1, 2, 3)
    batch.setVec3('position', 1, 4, 5, 6)
    batch.setVec3('color', 0, 9, 8, 7)
    batch.setFloat('radius', 2, 0.5)

    expect(view!.count()).toBe(0) // not visible until publish
    feed.publish()
    expect(view!.count()).toBe(3)

    const bytes = view!.bytes()
    expect(bytes.length).toBe(64 * 7) // capacity * stride/4
    expect(bytes[0]).toBe(1) // position.x of record 0
    expect(bytes[3]).toBe(9) // color.x of record 0
    expect(bytes[2 * 7 + 6]).toBe(0.5) // radius of record 2 (stride 7 float)
    // View identity is stable (the GPU cache keys on it).
    expect(view!.bytes()).toBe(bytes)
  })

  it('T0: local buffer, same semantics', () => {
    const { host, client } = createTransport({ mode: 'memory', names: NAMES })
    const feed = host.createFeed({ layout: LAYOUT, capacity: 16 })
    feed.push(2).setVec3('position', 0, 1, 0, 0)
    feed.publish()
    // T0: the channel is shared — read the feed itself.
    expect(feed.publishedCount()).toBe(2)
    void client
  })

  it('T3: ping-pong — chunks are transferable, buffers return to the pool', () => {
    const { host, client } = createTransport({ mode: 'msg', names: NAMES })
    const feed = host.createFeed({ layout: LAYOUT, capacity: 64 })
    const view = client.feed(1)
    expect(view).not.toBeNull()

    // Frame 1: three records.
    const b1 = feed.push(3)
    b1.setVec3('position', 0, 1, 1, 1)
    b1.setFloat('radius', 1, 2.5)
    feed.publish()
    const writtenBuffer = feed.buffer as ArrayBuffer // flush swaps current for a new one
    const msg1 = host.flush()
    expect(msg1!.chunks.length).toBe(1)
    expect(msg1!.chunks[0]!.count).toBe(3)
    expect(msg1!.chunks[0]!.bytes).toBe(writtenBuffer) // ping-pong: the buffer itself, no copy
    const firstBuffer = msg1!.chunks[0]!.bytes

    client.apply(msg1!)
    expect(view!.count()).toBe(3)
    expect(view!.bytes()[0]).toBe(1)
    expect(view!.bytes()[1 * 7 + 6]).toBe(2.5) // record 1, radius (stride 7 float)

    // The reader uploaded it to the GPU — returns the buffer.
    view!.recycle()

    // Frame 2: the writer is already on the new buffer (ship-and-replace — no stalling);
    // the returned firstBuffer comes back into rotation at the next flush.
    const secondBuffer = feed.buffer as ArrayBuffer
    expect(secondBuffer).not.toBe(firstBuffer)
    const b2 = feed.push(2)
    b2.setVec3('position', 0, 9, 9, 9)
    feed.publish()
    const msg2 = host.flush()
    expect(msg2!.chunks[0]!.from).toBe(3) // logical offset
    expect(msg2!.chunks[0]!.bytes).toBe(secondBuffer)
    client.apply(msg2!)
    expect(view!.count()).toBe(5)
    expect(view!.bytes()[3 * 7]).toBe(9) // record 3, position.x
    // Ping-pong: the returned buffer became the writer's current one.
    expect(feed.buffer).toBe(firstBuffer)
  })

  it('T3 standalone: writer in a worker, reader in the render world (no transport)', () => {
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

    // The returned buffer comes back to the writer on the NEXT ship cycle
    // (ship-and-replace: no stalling on non-returned buffers).
    writer.feed.push(1).setFloat('radius', 0, 1.5)
    writer.feed.publish()
    writer.ship()
    expect(writer.feed.buffer).toBe(recycled[0]!.bytes)
  })
})

describe('transports: cross-world binding (descriptor)', () => {
  it('sab: describe → attachTransport in another world', () => {
    const host = createTransportHost({ mode: 'sab', names: NAMES })
    const feed = host.createFeed({ layout: { value: 'float32' }, capacity: 8 })
    // "Another world": the same SAB via the descriptor (writing happens AFTER attach,
    // as in a live scenario: the registry is up, then the shell writes).
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

  it('msg: describe → attachTransport, the feed binds by metadata', () => {
    const host = createTransportHost({ mode: 'msg', names: NAMES })
    const client = attachTransport(host.describe())
    host.write('game.hp', 12)
    const feed = host.createFeed({ layout: { value: 'float32' }, capacity: 8 })
    // The feed was created AFTER attach — the reader binds by metadata later:
    const view = client.attachFeed(1, { value: 'float32' }, 8)
    feed.push(1).setFloat('value', 0, 5)
    feed.publish()
    client.apply(host.flush()!)
    expect(view.count()).toBe(1)
    expect(view.bytes()[0]).toBe(5)
    expect(client.shared('game.hp').value).toBe(12)
  })
})

describe('T1: futex waiting (rare waits)', () => {
  it('waitForChange wakes up on a slot write', async () => {
    const { host, client } = createTransport({ mode: 'sab+async', names: NAMES })
    const promise = client.waitForChange('game.hp', 500)
    host.write('game.hp', 1)
    const changed = await promise
    expect(changed).toBe(true)
  })

  it('waitForChange times out without a write → false', async () => {
    const { client } = createTransport({ mode: 'sab+async', names: NAMES })
    const changed = await client.waitForChange('game.hp', 5)
    expect(changed).toBe(false)
  })

  it('non-T1 modes → false without waiting', async () => {
    const { client } = createTransport({ mode: 'msg', names: NAMES })
    expect(await client.waitForChange('game.hp')).toBe(false)
  })
})

describe('Task 114: the T3 feed writer', () => {
  const L = { position: 'float32x3', radius: 'float32' } as const

  it('writes AFTER a flush land in the SWAPPED buffer (the writer views follow the core)', () => {
    const { host, client } = createTransport({ mode: 'msg', names: [] })
    const feed = host.createFeed({ layout: L, capacity: 8 })
    const view = client.attachFeed(1, L, 8)

    // Frame 1: write + flush — the core's buffer swaps.
    const b1 = feed.push(2)
    b1.setVec3('position', 0, 1, 2, 3)
    b1.setFloat('radius', 1, 0.5)
    const firstBuffer = feed.buffer as ArrayBuffer
    const msg1 = host.flush()
    expect(msg1!.chunks[0]!.bytes).toBe(firstBuffer)

    // Frame 2: the writer handle from frame 1 is REUSED (Task 114) — a new
    // push re-aims it; the writes must land in the NEW current buffer, not
    // the shipped one (a stale view would corrupt the reader's copy source).
    const b2 = feed.push(2)
    expect(b2).toBe(b1)
    b2.setVec3('position', 0, 7, 8, 9)
    b2.setFloat('radius', 1, 1.5)
    const secondBuffer = feed.buffer as ArrayBuffer
    expect(secondBuffer).not.toBe(firstBuffer)
    const msg2 = host.flush()
    expect(msg2!.chunks[0]!.bytes).toBe(secondBuffer)

    client.apply(msg1!)
    client.apply(msg2!)
    // Mirror: logical positions — frame 2's records are logical 2..4.
    expect(view.bytes()[0]).toBe(1)
    expect(view.bytes()[2 * 4]).toBe(7) // record 2, position.x (stride 4 float)
    expect(view.bytes()[3 * 4 + 3]).toBe(1.5) // record 3, radius
    expect(view.count()).toBe(4)
  })
})
