/**
 * TextureView — sub-region текстуры.
 *
 * Контракт (см. дизайн-раунд «TextureView как первоклассник»):
 *  - WebGPU: нативный GPUTextureView с origin/size — GPU работает с sub-view
 *    как с полноценной текстурой. uvOffset=[0,0], uvScale=[1,1].
 *  - WebGL2: UV-rect эмуляция. textureId = тот же, что у родителя. uvOffset/uvScale
 *    реальны, шейдер должен применять: `uv_final = uv * u_uvScale + u_uvOffset`.
 *
 * На обоих бэкендах пользователь видит одно и то же: { textureId, uvOffset, uvScale }.
 *
 * Здесь — **обёртка** над существующим Texture из @rune/gl. Не ломает его API.
 * Юзер может использовать Texture напрямую (без view) или создать view для
 * sub-region. View — легковесный объект (без отдельного GPU-ресурса на WebGL2).
 */

export interface TextureViewDescriptor {
  /** Origin в пикселях (top-left). */
  readonly origin?: { readonly x: number; readonly y: number; readonly z?: number }
  /** Размер региона. */
  readonly size?: { readonly width: number; readonly height: number; readonly depthOrArrayLayers?: number }
  /** Сколько мип-уровней захватить. Default 1. */
  readonly mipLevelCount?: number
}

export interface TextureView {
  /** ID для использования в command system. На WebGPU это ID нативного sub-view;
   *  на WebGL2 — тот же ID, что у родителя. */
  readonly textureId: number
  /** UV-смещение региона в нормализованных координатах [u0, v0]. */
  readonly uvOffset: readonly [number, number]
  /** UV-масштаб региона в нормализованных координатах [u1-u0, v1-v0]. */
  readonly uvScale: readonly [number, number]
  /** Размер региона в пикселях. */
  readonly width: number
  readonly height: number
  /** Диагностический тег (dispose-состояние). Необязательное поле объявлено
   *  в интерфейсе, чтобы литерал объекта в createTextureView проходил
   *  excess-property-проверку (Task 71: tsc → 0). */
  readonly [Symbol.toStringTag]?: string
  /** Освободить view. На WebGL2 — no-op; на WebGPU — delete view. Идемпотентно. */
  dispose(): void
}

/** Минимальный интерфейс Texture-родителя для создания view. */
export interface ViewableTexture {
  readonly textureId: number
  readonly width: number
  readonly height: number
}

/**
 * Создаёт TextureView — sub-region текстуры.
 *
 * На WebGL2 это чисто CPU-объект: textureId наследуется от родителя, а
 * uvOffset/uvScale вычисляются из origin/size. Шейдер должен поддержать
 * `u_uvOffset`/`u_uvScale` uniforms.
 *
 * На WebGPU здесь могла бы быть нативная реализация через gpu.createView(),
 * но в текущей версии @rune/webgpu GPUFacade не экспонирует sub-views —
 * поэтому WebGPU-путь использует ту же UV-rect эмуляцию (функционально
 * идентично, просто не использует нативную возможность WebGPU).
 *
 * Когда GPUFacade получит createView(), здесь можно добавить ветку.
 */
export function createTextureView(parent: ViewableTexture, descriptor: TextureViewDescriptor = {}): TextureView {
  const origin = descriptor.origin ?? { x: 0, y: 0 }
  const size = descriptor.size ?? { width: parent.width, height: parent.height }
  const w = Math.max(1, size.width)
  const h = Math.max(1, size.height)

  // Проверки границ
  if (origin.x < 0 || origin.y < 0 || origin.x + w > parent.width || origin.y + h > parent.height) {
    throw new RangeError(
      `TextureView: регион (${origin.x},${origin.y}+${w}x${h}) не вписывается в текстуру ${parent.width}x${parent.height}`,
    )
  }

  // UV-rect в нормализованных координатах. V (Y) отсчитывается от верха
  // текстуры (image-space, как в @rune/prims/quad.ts: v=0 = верхняя строка,
  // v растёт вниз). Это совпадает с раскладкой данных на обоих бэкендах:
  // WebGL2 (с flipY=false по умолчанию — см. realGL.texImage2DFromSource)
  // и WebGPU (native top-left origin). Без этого условия region-based
  // sub-views будут указывать не на тот участок атласа.
  const u0 = origin.x / parent.width
  const v0 = origin.y / parent.height
  const u1 = (origin.x + w) / parent.width
  const v1 = (origin.y + h) / parent.height

  let disposed = false
  return {
    textureId: parent.textureId, // на WebGL2 — тот же; на WebGPU (если бы был sub-view) — иной
    uvOffset: [u0, v0],
    uvScale: [u1 - u0, v1 - v0],
    width: w,
    height: h,
    dispose() {
      // Текущая реализация не владеет отдельным GPU-ресурсом — no-op.
      // Когда появится нативный WebGPU sub-view — здесь deleteView.
      disposed = true
    },
    get [Symbol.toStringTag]() { return disposed ? 'TextureView(disposed)' : 'TextureView' },
  }
}
