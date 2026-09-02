import { describe, expect, it } from 'bun:test'
import { createUniformArena, createUniformSet, signal } from '../src/index.ts'

/** uniformSet: named shared sets (camera/light from the dossier). */
describe('uniformSet', () => {
  it('attach allocates slots per the schema; write writes values', () => {
    const arena = createUniformArena()
    const camera = createUniformSet('camera', {
      u_view: 'mat4',
      u_proj: 'mat4',
      u_eye: 'vec3',
    })
    camera.attach(type => arena.alloc(type))

    // Slots are allocated and offsets are known BEFORE the first command
    expect(camera.offsets.u_view).toBeDefined()
    expect(camera.offsets.u_proj).toBeDefined()
    expect(camera.offsets.u_eye).toBeDefined()

    const view = new Float32Array(16)
    view[0] = view[5] = view[10] = view[15] = 1
    const eye = [1, 2, 3]
    // A set-like cache: we write through the write cache — we use link for signals
    const viewSignal = signal<readonly number[]>(Array.from(view))
    const eyeSignal = signal<readonly number[]>(eye)
    camera.link({ u_view: viewSignal, u_eye: eyeSignal })

    camera.write((offset, value) => {
      const slot = { offset, size: 4 }
      arena.writeFloat({ index: 0, offset: slot.offset, size: slot.size, kind: 'f32' } as never, value)
    })

    // Check: values from the signals landed in the arena at the field offsets
    const viewAt = camera.offsets.u_view!
    const eyeAt = camera.offsets.u_eye!
    expect(arena.readFloat({ index: 0, offset: viewAt, size: 64, kind: 'f32' } as never, 0)).toBe(1)
    expect(arena.readFloat({ index: 0, offset: viewAt, size: 64, kind: 'f32' } as never, 15)).toBe(1)
    expect(arena.readFloat({ index: 0, offset: eyeAt, size: 12, kind: 'f32' } as never, 0)).toBe(1)
    expect(arena.readFloat({ index: 0, offset: eyeAt, size: 12, kind: 'f32' } as never, 2)).toBe(3)
  })

  it('attach is idempotent (a double call allocates no new slots)', () => {
    const arena = createUniformArena()
    const set = createUniformSet('lights', { u_count: 'int', u_intensity: 'float' })
    set.attach(type => arena.alloc(type))
    const first = set.offsets.u_count
    set.attach(type => arena.alloc(type))
    expect(set.offsets.u_count).toBe(first)
    expect(arena.usedBytes).toBeLessThan(64) // only two fields
  })

  it('link is overwritten; write reads the current signal values', () => {
    const arena = createUniformArena()
    const set = createUniformSet('fog', { u_density: 'float' })
    set.attach(type => arena.alloc(type))
    const density = signal(0.5)
    set.link({ u_density: density })

    const writes: number[] = []
    set.write((offset, value) => writes.push(value))

    density.value = 0.9
    set.write((offset, value) => writes.push(value))

    expect(writes).toEqual([0.5, 0.9]) // peek reads the current value
  })

  it('camera naming convention: the u_view/u_proj/u_viewProj/u_eye set works', () => {
    const arena = createUniformArena()
    const camera = createUniformSet('camera', {
      u_view: 'mat4', u_proj: 'mat4', u_viewProj: 'mat4', u_eye: 'vec3', u_nearFar: 'vec2',
    })
    camera.attach(type => arena.alloc(type))
    // All convention fields got slots
    for (const field of ['u_view', 'u_proj', 'u_viewProj', 'u_eye', 'u_nearFar']) {
      expect(camera.offsets[field as keyof typeof camera.offsets]).toBeDefined()
    }
  })
})
