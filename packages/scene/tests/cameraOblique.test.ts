/**
 * cameraOblique.test.ts — Task 86: наклонная ближняя плоскость (Ленгель)
 * для планарных зеркал + пост-умножение проекции (z-ремап GL→D3D).
 *
 * Свойства проверяются ЧИСЛЕННО на клип-координатах: точка на плоскости
 * получает NDC z = −1 (ближняя), точка «между камерой и плоскостью» —
 * z < −1 (клип ближней), точка за плоскостью — z ∈ (−1, 1].
 *
 * Семантика знака (Ленгель): КАМЕРА ОБЯЗАНА лежать на отрицательной
 * стороне плоскости; видимое полупространство — положительное. Плоскость,
 * переданная «навстречу» (камера на положительной стороне), автоматически
 * разворачивается — видимой становится сторона ОТ камеры.
 */
import { describe, expect, test } from 'bun:test'
import { createCamera, applyObliqueClipPlane } from '../src/camera.ts'

const camera = createCamera()

/** NDC точки world → clip через VP (гомогенное деление). */
function ndc(vp: Float32Array, x: number, y: number, z: number): { z: number; w: number } {
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12]
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13]
  const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14]
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
  expect(Number.isFinite(cx + cy + cz + cw)).toBe(true)
  return { z: cz / cw, w: cw }
}

describe('setObliqueClipPlane', () => {
  test('зеркальная камера ПОД плоскостью (канонический сценарий отражения)', () => {
    // отражённая камера под «зеркалом» y = 2, смотрит вверх; держим y ≥ 2
    const cam = createCamera()
    cam.setPerspective((60 * Math.PI) / 180, 1, 0.5, 200)
    cam.setViewLookAt(0, -8, 6, 0, 10, 0, 0, 0, 1)
    cam.setObliqueClipPlane([0, 1, 0, -2]) // y − 2 = 0, держим y ≥ 2
    const vp = cam.viewProjection
    expect(ndc(vp, 0, 2, 3).z).toBeCloseTo(-1, 5) // на плоскости — ближняя
    expect(ndc(vp, 0, 7, 3).z).toBeGreaterThan(-1) // за плоскостью — видима
    expect(ndc(vp, 0, 7, 3).z).toBeLessThanOrEqual(1)
    expect(ndc(vp, 0, -6, 3).z).toBeLessThan(-1) // между камерой и плоскостью — клип
    expect(ndc(vp, 0, 7, 3).w).toBeGreaterThan(0) // w не перевёрнута
  })

  test('плоскость «навстречу» авто-разворачивается (видима сторона ОТ камеры)', () => {
    // камера НАД плоскостью y = −5 смотрит вниз; плоскость передана так,
    // что камера на положительной стороне → флип → видимо y ≤ −5
    const cam = createCamera()
    cam.setPerspective((60 * Math.PI) / 180, 1, 0.5, 200)
    cam.setViewLookAt(0, 12, 6, 0, 0, 0, 0, 0, 1)
    cam.setObliqueClipPlane([0, 1, 0, 5]) // y + 5 = 0 → плоскость y = −5
    const vp = cam.viewProjection
    expect(ndc(vp, 0, -5, 3).z).toBeCloseTo(-1, 5) // на плоскости — ближняя
    expect(ndc(vp, 0, -9, 3).z).toBeGreaterThan(-1) // ниже плоскости (от камеры) — видима
    expect(ndc(vp, 0, -2, 3).z).toBeLessThan(-1) // между камерой и плоскостью — клип
  })

  test('фрустум-плоскости камеры согласованы: ближняя = плоскость клипа', () => {
    const cam = createCamera()
    cam.setPerspective((60 * Math.PI) / 180, 1, 0.5, 200)
    cam.setViewLookAt(0, -8, 6, 0, 10, 0, 0, 0, 1)
    cam.setObliqueClipPlane([0, 1, 0, -2]) // плоскость y = 2
    const n = cam.planes
    // PLANE_NEAR=4 → слоты 16..19; плоскость нормирована (|n|=1)
    const len = Math.hypot(n[16], n[17], n[18])
    expect(len).toBeCloseTo(1, 5)
    // точка плоскости y=2 лежит на ближней плоскости фрустума
    const dist = (n[16]! * 0 + n[17]! * 2 + n[18]! * 3) / len + n[19]! / len
    expect(Math.abs(dist)).toBeLessThan(1e-4)
  })

  test('наклонная плоскость (не ось-выровненная) — общий случай', () => {
    const cam = createCamera()
    cam.setPerspective((70 * Math.PI) / 180, 1.6, 0.5, 300)
    cam.setViewLookAt(10, 8, 12, 0, 2, 0, 0, 1, 0)
    const plane: [number, number, number, number] = [0.3, 0.8, 0.52, -3.0]
    cam.setObliqueClipPlane(plane)
    const vp = cam.viewProjection
    // точка на плоскости (x=z=1 → y = (3 − 0.3 − 0.52)/0.8 = 2.725)
    const py = (3 - 0.3 - 0.52) / 0.8
    const onPlane = ndc(vp, 1, py, 1)
    // точка может лежать вне xy-фрустума, но z-свойство обязано держаться:
    // она на ближней плоскости ⇒ z_ndc = −1 (если вообще проецируется)
    if (onPlane.w > 0) expect(onPlane.z).toBeCloseTo(-1, 4)
    // камера: 0.3·10 + 0.8·8 + 0.52·12 − 3 = 12.64 > 0 — на положительной
    // стороне ⇒ авто-флип: видима сторона ОТ камеры (меньшие значения
    // формы 0.3x+0.8y+0.52z−3).
    const below = ndc(vp, 1, py - 3, 1)
    expect(below.z).toBeGreaterThan(-1 - 1e-6)
    const above = ndc(vp, 1, py + 3, 1)
    expect(above.z).toBeLessThan(-1 + 1e-6)
  })

  test('вырожденная нормаль — честная ошибка', () => {
    const cam = createCamera()
    expect(() => cam.setObliqueClipPlane([0, 0, 0, 1])).toThrow(/нулевая нормаль/)
  })

  test('applyObliqueClipPlane экспортирован для прямого применения', () => {
    const cam = createCamera()
    cam.setPerspective(1, 1, 0.5, 100)
    cam.setViewLookAt(0, 5, 0, 0, 0, 0, 0, 0, 1)
    const before = Float32Array.from(cam.projection)
    applyObliqueClipPlane(cam.projection, cam.view, [0, 1, 0, 1])
    expect(Array.from(cam.projection)).not.toEqual(Array.from(before))
  })
})

describe('postMultiplyProjection', () => {
  /** Ремап GL→D3D: z' = (z + w)/2 (ближняя −1 → 0, дальняя +1 → 1). */
  const REMAP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1])

  test('z-ремап GL→D3D переводит наклонную ближнюю в 0 (WebGPU-конвенция)', () => {
    const cam = createCamera()
    cam.setPerspective(1, 1, 0.5, 100)
    // зеркальная камера под плоскостью y=2, смотрит вверх
    cam.setViewLookAt(0, -8, 6, 0, 10, 0, 0, 0, 1)
    cam.setObliqueClipPlane([0, 1, 0, -2]) // ближняя = плоскость y = 2
    cam.postMultiplyProjection(REMAP)
    const vp = cam.viewProjection
    // точка на плоскости зеркала → NDC z = 0 (WebGPU-ближняя)
    expect(ndc(vp, 0, 2, 3).z).toBeCloseTo(0, 5)
    // видимая точка (за плоскостью) → z ∈ (0, 1)
    const vis = ndc(vp, 0, 6, 3)
    expect(vis.z).toBeGreaterThan(0)
    expect(vis.z).toBeLessThanOrEqual(1)
    // между камерой и плоскостью → z < 0 (клип в WebGPU)
    expect(ndc(vp, 0, -4, 3).z).toBeLessThan(0)
  })

  test('x/y/w не затрагиваются ремапом', () => {
    const cam = createCamera()
    cam.setPerspective(1, 1, 0.5, 100)
    cam.setViewLookAt(0, 0, 10, 0, 0, 0, 0, 1, 0)
    const vp0 = Float32Array.from(cam.viewProjection)
    cam.postMultiplyProjection(REMAP)
    const vp = cam.viewProjection
    const p = [0.3, 1.0, -2.0]
    const px0 = vp0[0]! * p[0]! + vp0[4]! * p[1]! + vp0[8]! * p[2]! + vp0[12]!
    const py0 = vp0[1]! * p[0]! + vp0[5]! * p[1]! + vp0[9]! * p[2]! + vp0[13]!
    const w0 = vp0[3]! * p[0]! + vp0[7]! * p[1]! + vp0[11]! * p[2]! + vp0[15]!
    const px = vp[0]! * p[0]! + vp[4]! * p[1]! + vp[8]! * p[2]! + vp[12]!
    const py = vp[1]! * p[0]! + vp[5]! * p[1]! + vp[9]! * p[2]! + vp[13]!
    const w = vp[3]! * p[0]! + vp[7]! * p[1]! + vp[11]! * p[2]! + vp[15]!
    expect(px).toBeCloseTo(px0, 6)
    expect(py).toBeCloseTo(py0, 6)
    expect(w).toBeCloseTo(w0, 6)
  })
})
