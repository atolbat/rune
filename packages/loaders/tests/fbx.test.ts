import { test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { parseFBX } from '../src/fbx.ts'
import { AssetLoader } from '../src/registry.ts'
import type { FbxModel } from '../src/index.ts'
const SAMBA = new URL('../../demo/assets/samba-dancing.fbx', import.meta.url)
// Тяжёлая Mixamo-фикстура не входит в состав библиотеки: тесты включаются
// автоматически, если положить файл по пути packages/loaders/demo/assets/.
const hasFixture = existsSync(SAMBA)
const it = test.skipIf(!hasFixture)

it('parseFBX: Mixamo Samba Dancing — скелет, скин, клипы', async () => {
  const buffer = await readFile(SAMBA)
  const model: FbxModel = await parseFBX(buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer)

  // Геометрия
  expect(model.meshes.length).toBeGreaterThan(0)
  for (const mesh of model.meshes) {
    expect(mesh.positions.length).toBe(mesh.vertexCount * 3)
    expect(mesh.indices.length % 3).toBe(0)
    // скин обязателен для анимируемой модели
    expect(mesh.skin).toBeDefined()
    expect(mesh.skin!.jointIndices.length).toBe(mesh.vertexCount * 4)
    expect(mesh.skin!.jointWeights.length).toBe(mesh.vertexCount * 4)
    // веса нормализованы
    for (let v = 0; v < mesh.vertexCount; v++) {
      const sum =
        mesh.skin!.jointWeights[v * 4] +
        mesh.skin!.jointWeights[v * 4 + 1] +
        mesh.skin!.jointWeights[v * 4 + 2] +
        mesh.skin!.jointWeights[v * 4 + 3]
      if (mesh.skin!.jointWeights[v * 4] > 0) expect(sum).toBeCloseTo(1, 3)
    }
  }

  // Скелет: топологический порядок (родитель раньше ребёнка)
  const joints = model.skeleton.joints
  expect(joints.length).toBeGreaterThan(20) // Mixamo-скелет ~55 костей
  for (let i = 0; i < joints.length; i++) {
    expect(joints[i].parent).toBeLessThan(i)
    expect(joints[i].parent).toBeGreaterThanOrEqual(-1)
  }
  const withInvBind = joints.filter((j) => j.invBind !== undefined)
  expect(withInvBind.length).toBeGreaterThan(10)

  // Клипы анимации
  expect(model.clips.length).toBeGreaterThanOrEqual(1)
  for (const clip of model.clips) {
    expect(clip.duration).toBeGreaterThan(0)
    for (const track of clip.tracksT) {
      expect(track.times.length).toBeGreaterThan(0)
      expect(track.values.length).toBe(track.times.length * 3)
      expect(track.joint).toBeLessThan(joints.length)
    }
    for (const track of clip.tracksR) {
      expect(track.times.length).toBeGreaterThan(0)
      expect(track.quats.length).toBe(track.times.length * 4)
      // кватернионы нормализованы
      for (let k = 0; k < track.quats.length; k += 4) {
        const len = Math.hypot(
          track.quats[k],
          track.quats[k + 1],
          track.quats[k + 2],
          track.quats[k + 3],
        )
        expect(len).toBeCloseTo(1, 3)
      }
      expect(track.joint).toBeLessThan(joints.length)
    }
  }
})

it('AssetLoader: полный конвейер .fbx (registry → parseFBX)', async () => {
  const bytes = await readFile(SAMBA)
  const fetchImpl = (async () =>
    new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    })) as unknown as typeof fetch
  const loader = new AssetLoader({ fetchImpl })
  const phases: string[] = []
  const handle = loader.load('https://mixamo/samba-dancing.fbx', {
    onProgress: (p) => phases.push(p.phase),
  })
  const model = (await handle) as FbxModel
  expect(model.meshes.length).toBeGreaterThan(0)
  expect(model.clips.length).toBeGreaterThanOrEqual(1)
  expect(phases).toContain('parsing')
  expect(phases[phases.length - 1]).toBe('done')
  // закэшировано и доступно через get()
  expect(loader.get('https://mixamo/samba-dancing.fbx')).toBeDefined()
}, 60000)
