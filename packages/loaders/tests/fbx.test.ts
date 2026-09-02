import { test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { parseFBX } from '../src/fbx.ts'
import { AssetLoader } from '../src/registry.ts'
import type { FbxModel } from '../src/index.ts'
import { buildFbx, fbxNode } from './helpers.ts'

// The heavy Mixamo fixture is shared with the model-viewer demo
// (demo/model-viewer/assets/samba.fbx): the tests are enabled automatically
// wherever the repo checkout is complete.
const SAMBA = new URL('../../../demo/model-viewer/assets/samba.fbx', import.meta.url)
const hasFixture = existsSync(SAMBA)
const it = test.skipIf(!hasFixture)

// ─── fan triangulation: the ~-encoded last corner of every polygon ─────────────

test('parseFBX: a quad polygon triangulates without the wrapped-negative-index bug', async () => {
  // Quad 0-1-2-3 (the last corner stored as ~3 = -4) + a separate triangle.
  // Regression (the "grater" bug): triangulate() pushed the raw negative
  // -4, Uint32Array.from() wrapped it to 4294967292, positions[huge] → NaN,
  // and every second triangle of a quad mesh silently disappeared.
  const quad = fbxNode('Objects', [], [
    fbxNode('Geometry', [
      { type: 'L', value: 100n },
      { type: 'S', value: 'Quad\u0000\u0001Geometry' },
    ], [
      fbxNode('Vertices', [{ type: 'd', value: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 1, 3, 0, 1, 3, 1, 1] }], null),
      fbxNode('PolygonVertexIndex', [{ type: 'i', value: [0, 1, 2, ~3, 4, 5, ~6] }], null),
    ]),
  ])
  const bytes = buildFbx(7400, [quad])
  const model = await parseFBX(bytes.buffer as ArrayBuffer)
  expect(model.meshes.length).toBe(1)
  const mesh = model.meshes[0]
  // quad → 2 triangles, triangle → 1: 3 triangles total
  expect(mesh.indices.length).toBe(9)
  // every index must be a valid vertex index (the bug: 4294967292)
  for (const index of mesh.indices) {
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThan(mesh.vertexCount)
  }
  // fan of the quad: (0,1,2) and (0,2,3)
  expect(Array.from(mesh.indices.slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3])
  // the triangle (4,5,6) survives intact
  expect(Array.from(mesh.indices.slice(6, 9))).toEqual([4, 5, 6])
})

test('parseFBX: computed normals cover every corner (no OOB silent drop)', async () => {
  // No LayerElementNormal → computeNormals() fallback. The ~-encoded last
  // corner used to write to out[negative] — a typed-array no-op, so the last
  // corner of each polygon lost its normal contribution.
  const quad = fbxNode('Objects', [], [
    fbxNode('Geometry', [
      { type: 'L', value: 100n },
      { type: 'S', value: 'Quad\u0000\u0001Geometry' },
    ], [
      fbxNode('Vertices', [{ type: 'd', value: [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0] }], null),
      fbxNode('PolygonVertexIndex', [{ type: 'i', value: [0, 1, 2, ~3] }], null),
    ]),
  ])
  const model = await parseFBX(buildFbx(7400, [quad]).buffer as ArrayBuffer)
  const normals = model.meshes[0].normals
  // a flat quad: every vertex normal points at +Z after normalization
  for (let v = 0; v < 4; v++) {
    expect(normals[v * 3 + 2]).toBeCloseTo(1, 5)
    expect(normals[v * 3]).toBeCloseTo(0, 5)
    expect(normals[v * 3 + 1]).toBeCloseTo(0, 5)
  }
})

it('parseFBX: Mixamo Samba Dancing — skeleton, skin, clips', async () => {
  const buffer = await readFile(SAMBA)
  const model: FbxModel = await parseFBX(buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer)

  // Geometry
  expect(model.meshes.length).toBeGreaterThan(0)
  for (const mesh of model.meshes) {
    expect(mesh.positions.length).toBe(mesh.vertexCount * 3)
    expect(mesh.indices.length % 3).toBe(0)
    // regression (the "grater" on the real file): half the triangles used a
    // wrapped ~-encoded corner index (4294967xxx) and rendered as NaN holes
    for (const index of mesh.indices) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(mesh.vertexCount)
    }
    // a skin is mandatory for an animatable model
    expect(mesh.skin).toBeDefined()
    expect(mesh.skin!.jointIndices.length).toBe(mesh.vertexCount * 4)
    expect(mesh.skin!.jointWeights.length).toBe(mesh.vertexCount * 4)
    // weights are normalized
    for (let v = 0; v < mesh.vertexCount; v++) {
      const sum =
        mesh.skin!.jointWeights[v * 4] +
        mesh.skin!.jointWeights[v * 4 + 1] +
        mesh.skin!.jointWeights[v * 4 + 2] +
        mesh.skin!.jointWeights[v * 4 + 3]
      if (mesh.skin!.jointWeights[v * 4] > 0) expect(sum).toBeCloseTo(1, 3)
    }
  }

  // Skeleton: topological order (parent before child)
  const joints = model.skeleton.joints
  expect(joints.length).toBeGreaterThan(20) // Mixamo skeleton ~55 bones
  for (let i = 0; i < joints.length; i++) {
    expect(joints[i].parent).toBeLessThan(i)
    expect(joints[i].parent).toBeGreaterThanOrEqual(-1)
  }
  const withInvBind = joints.filter((j) => j.invBind !== undefined)
  expect(withInvBind.length).toBeGreaterThan(10)

  // Animation clips
  expect(model.clips.length).toBeGreaterThanOrEqual(1)
  for (const clip of model.clips) {
    expect(clip.duration).toBeGreaterThan(0)
    for (const track of clip.tracksT) {
      expect(track.times.length).toBeGreaterThan(0)
      expect(track.values.length).toBe(track.times.length * 3)
      expect(track.joint).toBeLessThan(joints.length)
      // regression (KeyValueFloat f32 read as f64): values were ≈3e13 garbage
      // — two f32 keys packed into one double; real translations are centimeters
      for (let k = 0; k < track.values.length; k++) {
        expect(Math.abs(track.values[k])).toBeLessThan(1e6)
      }
    }
    for (const track of clip.tracksR) {
      expect(track.times.length).toBeGreaterThan(0)
      expect(track.quats.length).toBe(track.times.length * 4)
      // quaternions are normalized
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

it('AssetLoader: the full .fbx pipeline (registry → parseFBX)', async () => {
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
  // cached and available via get()
  expect(loader.get('https://mixamo/samba-dancing.fbx')).toBeDefined()
}, 60000)
