/**
 * camera.ts — камера сцены (Task 81).
 *
 * Камера — НЕ узел сцены: она владеет собственными view/projection/VP и
 * нормированными плоскостями фрустума. Типичный сценарий — «камера на
 * узле»: main каждый кадр берёт world слота узла и вызывает
 * setViewFromWorld (быстрое аффинное обращение) — родительские цепочки
 * камер бесплатны, потому что мир узла уже посчитан сценой.
 *
 * Все сеттеры сразу пересчитывают VP и плоскости — камера меняется раз
 * в кадр, дешевле не копить грязь.
 */
import {
  mat4InvertAffine,
  mat4LookAt,
  mat4Ortho,
  mat4Perspective,
  mat4Multiply,
} from '@rune/math'
import { extractFrustumPlanes } from './frustum.ts'

/** Публичный интерфейс камеры. */
export interface Camera {
  /** Видовая матрица (мир → камера), колонко-мажор. */
  readonly view: Float32Array
  /** Проекция (камера → клип), колонко-мажор. */
  readonly projection: Float32Array
  /** view · projection, колонко-мажор. */
  readonly viewProjection: Float32Array
  /** 6 нормированных плоскостей фрустума (L,R,B,T,N,F). */
  readonly planes: Float32Array

  /** Перспектива (fovy рад, aspect = w/h). */
  setPerspective(fovy: number, aspect: number, near: number, far: number): Camera
  /** Ортография. */
  setOrtho(left: number, right: number, bottom: number, top: number, near: number, far: number): Camera
  /**
   * Наклонная ближняя плоскость (Lengyel, «Oblique View Frustum Depth
   * Projection and Clipping»): ближняя плоскость фрустума заменяется
   * мировой плоскостью (nx, ny, nz, d) — остаётся полупространство
   * n·x + d ≥ 0. Классика планарных зеркал/воды: всё «под» плоскостью
   * клипается ближней плоскостью, глубина остаётся корректной.
   *
   * ПРЕДУПРЕЖДЕНИЕ: точность буфера глубины снижается (диапазон [−1,1]
   * сжимается в [−1,1] относительно наклонного объёма) — для зеркальных
   * камер это приемлемо. Вызывать ПОСЛЕ setPerspective/setOrtho и
   * setView* — плоскость преобразуется текущей видовой матрицей.
   */
  setObliqueClipPlane(plane: readonly [number, number, number, number]): Camera
  /**
   * Пост-умножение проекции слева (P' = m · P) с пересчётом VP и плоскостей.
   * Назначение — конвенции бэкендов: WebGPU/D3D ждут NDC z ∈ [0,1],
   * GL-матрицы дают [-1,1]; ремап-матрица z' = (z+w)/2 чинит клип
   * (и наклонную плоскость тоже) на WebGPU-пути.
   */
  postMultiplyProjection(m: ArrayLike<number>): Camera
  /** Вид из мирового трансформа узла (аф. обращение). */
  setViewFromWorld(world: ArrayLike<number>): Camera
  /** LookAt (eye → center, up). */
  setViewLookAt(
    eyeX: number, eyeY: number, eyeZ: number,
    centerX: number, centerY: number, centerZ: number,
    upX: number, upY: number, upZ: number,
  ): Camera
}

const tmpInverse = new Float32Array(16)
const tmpProjLeft = new Float32Array(16)

/** Создаёт камеру (по умолчанию identity view + перспектива 60°/1/0.1/100). */
export function createCamera(): Camera {
  const view = new Float32Array(16)
  const projection = new Float32Array(16)
  const viewProjection = new Float32Array(16)
  const planes = new Float32Array(24)
  view[0] = view[5] = view[10] = view[15] = 1

  const camera: Camera = {
    view,
    projection,
    viewProjection,
    planes,
    setPerspective(fovy, aspect, near, far) {
      mat4Perspective(projection, fovy, aspect, near, far)
      refresh()
      return camera
    },
    setOrtho(left, right, bottom, top, near, far) {
      mat4Ortho(projection, left, right, bottom, top, near, far)
      refresh()
      return camera
    },
    setViewFromWorld(world) {
      for (let i = 0; i < 16; i++) tmpInverse[i] = world[i]
      mat4InvertAffine(view, tmpInverse)
      refresh()
      return camera
    },
    setObliqueClipPlane(plane) {
      applyObliqueClipPlane(projection, view, plane)
      refresh()
      return camera
    },
    postMultiplyProjection(m) {
      // P' = m · P (m слева): копии в скретчи — mat4Multiply требует
      // Float32Array и не любит совпадение out с входом.
      for (let i = 0; i < 16; i++) tmpProjLeft[i] = m[i]!
      for (let i = 0; i < 16; i++) tmpInverse[i] = projection[i]
      mat4Multiply(projection, tmpProjLeft, tmpInverse)
      refresh()
      return camera
    },
    setViewLookAt(eyeX, eyeY, eyeZ, centerX, centerY, centerZ, upX, upY, upZ) {
      mat4LookAt(view, eyeX, eyeY, eyeZ, centerX, centerY, centerZ, upX, upY, upZ)
      refresh()
      return camera
    },
  }

  function refresh(): void {
    mat4Multiply(viewProjection, projection, view)
    extractFrustumPlanes(planes, viewProjection)
  }

  camera.setPerspective(Math.PI / 3, 1, 0.1, 100)
  return camera
}

/**
 * Наклонная ближняя плоскость (Lengyel). Модифицирует ПРОЕКЦИЮ in-place:
 * z-строка P (колонко-мажорные индексы 2, 6, 10, 14) заменяется так,
 * чтобы ближняя плоскость фрустума совпала с мировой плоскостью
 * (nx, ny, nz, d) (видимым остаётся полупространство n·x + d ≥ 0).
 *
 * Пошагово:
 *   1. Плоскость → видовое пространство: x_view = R·(x_world − e) для
 *      rigid view ⇒ n' = R·n, d' = d − n'·t, где t = перенос вида
 *      (−R·e в колонках 12..14).
 *   2. Стандартный вывод Ленгеля: q — точка на дальней плоскости,
 *      «зеркальная» пересечению плоскости с главной диагональю; новый
 *      z-столбец = плоскость·(2/dot(plane, q)); m[10] += 1 сохраняет
 *      дальнюю плоскость.
 *
 * Контракт: view — rigid (lookAt/fromWorld), projection — GL-конвенция
 * (z_ndc ∈ [−1, 1], m[11] = −1). Для WebGPU добавьте пост-ремап z
 * (postMultiplyProjection), клип по плоскости сохранится.
 */
export function applyObliqueClipPlane(
  projection: Float32Array,
  view: Float32Array,
  plane: readonly [number, number, number, number],
): void {
  const [nx, ny, nz, d] = plane
  const len = Math.hypot(nx, ny, nz)
  if (len < 1e-9) throw new Error('scene: нулевая нормаль плоскости клипа')
  // Нормализация (плоскость может приходить ненормированной).
  const a = nx / len, b = ny / len, c = nz / len, dd = d / len

  // Видовое пространство: n' = R·n (строки 3×3 вида), t = видовой перенос.
  const tx = view[12], ty = view[13], tz = view[14]
  const va = view[0] * a + view[4] * b + view[8] * c
  const vb = view[1] * a + view[5] * b + view[9] * c
  const vc = view[2] * a + view[6] * b + view[10] * c
  const vd = dd - (va * tx + vb * ty + vc * tz)

  // Знак (Ленгель): камера обязана лежать на ОТРИЦАТЕЛЬНОЙ стороне
  // плоскости (видимое полупространство — положительное). В видовом
  // пространстве камера — начало координат: p·(0,0,0,1) = d_view.
  // Плоскость «навстречу» (d_view > 0) — флип; вырожденность (d_view = 0,
  // камера на плоскости) не лечится флипом — оставляем как есть.
  let pa = va, pb = vb, pc = vc, pd = vd
  if (pd > 0) { pa = -pa; pb = -pb; pc = -pc; pd = -pd }

  const p = projection
  // q — вершина «дальнего угла», отвечающего знакам плоскости.
  const qx = (Math.sign(pa) + p[8]) / p[0]
  const qy = (Math.sign(pb) + p[9]) / p[5]
  const qz = -1
  const qw = (1 + p[10]) / p[14]
  const denom = pa * qx + pb * qy + pc * qz + pd * qw
  if (Math.abs(denom) < 1e-12) throw new Error('scene: наклонная плоскость вырождена (параллельна взгляду)')
  const s = 2 / denom
  p[2] = pa * s
  p[6] = pb * s
  p[10] = pc * s + 1
  p[14] = pd * s
}

