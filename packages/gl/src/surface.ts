/**
 * Surface + pass — единая структура полноэкранных проходов.
 *
 * Вместо двух отдельных сахаров (frag() для генерации картинки и image()
 * для показа) — ОДНА конструкция: проход «N входов → фрагментный шейдер →
 * цель». Вырожденные случаи:
 *   - генерация:  pass без входов, target = surface (бывший frag)
 *   - показ:      pass с входом, target = канвас (бывший image)
 *   - постпроцессинг: capture() рисует сцену В surface, затем цепочка
 *     pass'ов surface → surface → канвас, каждый — обычная команда
 *     рендер-пасса (пишется в ту же ленту через record()).
 *
 * Пользователь пишет ТОЛЬКО фрагментную стадию; вершинную рантайм
 * генерирует (клип-пространственный квад из @rune/prims). Контракт
 * шейдера: атрибуты position/uv уже заняты, varying/in — v_uv (GLSL)
 * или @location(0) uv (WGSL, точка входа fsMain).
 */

import { quad } from '@rune/prims'
import { OpCode } from '@rune/core'
import type { TapeWriter } from '@rune/core'

/** Ссылка на текстуру-вход: Texture (renderer), SurfaceTexture — годится любая. */
export interface TextureRef {
  readonly textureId: number
}

/** Опции полноэкранного прохода. */
export interface PassOptions {
  /** Юниформы: значение | (props, ctx) => значение (как в command()). */
  readonly uniforms?: Record<string, unknown>
  /** Входы: имя sampler'а в шейдере → текстура/поверхность.
   *  v1 WebGPU: один вход на проход (ограничение bind-группы текстур). */
  readonly inputs?: Record<string, TextureRef>
  /** Цель: поверхность (undefined → канвас). */
  readonly target?: { readonly targetId: number }
  /** Очистить цель перед проходом (default false: квад перекрывает всё). */
  readonly clear?: boolean
}

/** Опции поверхности-цели. */
export interface SurfaceOptions {
  readonly width?: number
  readonly height?: number
  /** Своя глубина — для capture() 3D-сцен (default false). */
  readonly depth?: boolean
  /** Цвет очистки (default — фон рендерера). */
  readonly color?: readonly [number, number, number, number]
}

/** Результат чтения поверхности (Task 80: readback — первый срез
 *  buffer/MRT/readback из остаточного бэклога аудита Task 72).
 *
 *  Контракт ОДИНАКОВ на обоих бэкендах — «одна сцена — одна картинка»
 *  распространена и на CPU-чтение: один и тот же индекс = один и тот же
 *  пиксель независимо от бэкенда:
 *   - data: RGBA8, tight-раскладка (rowBytes = width*4);
 *   - строки СВЕРХУ ВНИЗ (texture row 0 = верх): GL-фасад переворачивает
 *     readPixels, WebGPU-фасад уплотняет 256-байтовое выравнивание и
 *     свиззлит BGRA→RGBA — наружу торчит один и тот же формат. */
export interface SurfaceRead {
  readonly width: number
  readonly height: number
  /** RGBA8 (4 б/пиксель), row-major, первая строка — верхняя. */
  readonly data: Uint8Array
}

/** Поверхность: текстура-цель + полноэкранные проходы в неё. */
export interface Surface<C> {
  /** Id цели для BindTarget (диагностика/подстановка в passOptions.target). */
  readonly targetId: number
  /** Текстура поверхности — вход для следующих проходов. */
  readonly texture: { readonly textureId: number; readonly width: number; readonly height: number }
  readonly width: number
  readonly height: number
  /** Полноэкранный проход, пишущий В эту поверхность. */
  pass(fragment: string, options?: PassOptions): C
  /** Повернуть любую команду целью в эту поверхность (сцена → текстура).
   *  clear default true: 3D-сцене нужны чистые цвет и глубина. */
  capture(command: C, options?: { readonly clear?: boolean }): C
  /** Task 80: прочитать пиксели поверхности на CPU.
   *
   *  Читает содержимое ПОСЛЕ последнего исполненного кадра (вызов вне
   *  frame-колбэка; WebGPU-путь асинхронный — mapAsync). После dispose —
   *  reject с honest-ошибкой. Результат — SurfaceRead (RGBA8, сверху-вниз,
   *  паритет бэкендов — см. SurfaceRead). Не журналируется: чтение — не
   *  декларация, replay-восстановления не требует. */
  read(): Promise<SurfaceRead>
  /** Освободить GPU-ресурсы поверхности (target + текстура).
   *  Идемпотентно: повторный вызов — no-op. После dispose pass()/capture()
   *  на этом surface кидать НЕ надо — но и вызвать их не стоит.
   *  Журнал (если обёрнут) — destroyTarget + destroyTexture опсы пишутся. */
  dispose(): void
}

/** Квад полноэкранных проходов (общий для обоих бэкендов). */
export const FULLSCREEN_QUAD = quad()

/** Генерируемая вершинная стадия GLSL: проводит UV квада во фрагмент. */
export const PASS_VERT_GLSL = `#version 300 es
layout(location = 0) in vec2 position;
layout(location = 1) in vec2 uv;
out vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}`

/** Генерируемая вершинная стадия WGSL (препендится к фрагменту пользователя). */
export const PASS_VERT_WGSL = `struct RunePassVsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}
@vertex
fn vsMain(
  @location(0) position : vec2<f32>,
  @location(1) uv : vec2<f32>,
) -> RunePassVsOut {
  var out : RunePassVsOut;
  out.pos = vec4<f32>(position, 0.0, 1.0);
  out.uv = uv;
  return out;
}
`

/** Обёртка команды: перед записью оригинала эмитит BindTarget.
 *  id сохранён — исполнитель находит оригинал в реестре команд. */
export function withTarget<C extends { readonly id: number }>(
  command: C & { record(props: unknown, frameCtx: unknown, writer: TapeWriter): void },
  targetId: number,
  clear: boolean,
): C {
  const clearFlag = clear ? 1 : 0
  return {
    id: command.id,
    record(props: unknown, frameCtx: unknown, writer: TapeWriter): void {
      writer.emit(OpCode.BindTarget, targetId, clearFlag, 0, 0)
      command.record(props, frameCtx, writer)
    },
  } as unknown as C
}

/** Имена билтин-юниформов, которые pass подставляет автоматически. */
const BUILTIN_NAMES = ['u_time', 'u_resolution', 'u_texel'] as const

/** Какие билтины объявлены в шейдере (по вхождению имени). */
export function scanBuiltins(fragment: string): ReadonlySet<string> {
  const found = new Set<string>()
  for (const name of BUILTIN_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(fragment)) found.add(name)
  }
  return found
}

/** Мутабельные значения билтинов: обновляются на каждом record, без GC. */
export interface PassBuiltins {
  readonly time: Float32Array
  readonly resolution: Float32Array
  readonly texel: Float32Array
}

export function createPassBuiltins(): PassBuiltins {
  return {
    time: new Float32Array(1),
    resolution: new Float32Array(2),
    texel: new Float32Array(2),
  }
}

/** Вписать билтин-резолверы в uniforms спека прохода.
 *  resolutionSource: актуальный размер ЦЕЛИ в пикселях буфера (кадровый). */
export function applyBuiltins(
  uniforms: Record<string, unknown>,
  builtins: ReadonlySet<string>,
  values: PassBuiltins,
  resolutionSource: () => readonly [number, number],
): void {
  if (builtins.has('u_time')) {
    uniforms.u_time = (_props: unknown, ctx: { time: number }) => {
      values.time[0] = ctx.time
      return values.time
    }
  }
  if (builtins.has('u_resolution')) {
    uniforms.u_resolution = () => {
      const [w, h] = resolutionSource()
      values.resolution[0] = w
      values.resolution[1] = h
      return values.resolution
    }
  }
  if (builtins.has('u_texel')) {
    uniforms.u_texel = () => {
      const [w, h] = resolutionSource()
      values.texel[0] = w > 0 ? 1 / w : 0
      values.texel[1] = h > 0 ? 1 / h : 0
      return values.texel
    }
  }
}
