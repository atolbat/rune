// Контракт фасада WebGL2: толстые операции, тонкий исполнитель.

/** Источник для атомарной загрузки текстуры (без стриминга/чанков).
 *  TexImageSource из lib.dom.d.ts (с OffscreenCanvas и VideoFrame при наличии). */
export type GLImageSource =
  | ImageBitmap
  | HTMLCanvasElement
  | HTMLImageElement
  | HTMLVideoElement
  | OffscreenCanvas
  // VideoFrame доступен только при WebCodecs, но TS-тип знает
  | (typeof globalThis extends { VideoFrame: infer V } ? V : never)

/** Формат хранения текстуры WebGL2 (Task 67: HDR).
 *  'rgba8' (default) — internalFormat RGBA8, загрузка (RGBA, UNSIGNED_BYTE).
 *  'rgba16f' — RGBA16F, загрузка (RGBA, HALF_FLOAT): 8 б/пиксель.
 *  'rgba32f' — RGBA32F, загрузка (RGBA, FLOAT): 16 б/пиксель.
 *  Хранение float-текстур — core WebGL2; линейная фильтрация rgba16f — core,
 *  rgba32f — OES_texture_float_linear (без неё MIN_FILTER деградирует до
 *  NEAREST); рендер В float-цель — EXT_color_buffer_float. */
export type GLTextureFormat = 'rgba8' | 'rgba16f' | 'rgba32f'

export interface GLFacade {
  createProgram(vertex: string, fragment: string): number
  useProgram(programId: number): void
  createBuffer(data: Float32Array): number
  /** M5 (Task 73): динамическое обновление буфера (feed dual-bind) —
   *  bufferSubData поверх существующего хранилища. Рендерер фида
   *  вызывает один раз на кадр с грязным диапазоном записей. */
  updateBuffer(bufferId: number, data: Float32Array, byteOffset?: number): void
  /** Привязать вершинный атрибут. stride/byteOffset (M5): интерливинг
   *  записей фида — bindVertexBuffer(buf, loc, size, stride, offset)
   *  → vertexAttribPointer(loc, size, FLOAT, false, stride, offset).
   *  Default (undefined) — tight-раскладка (stride 0, offset 0),
   *  обратная совместимость.
   *  divisor (Task 75): 1 → vertexAttribDivisor(loc, 1) — атрибут
   *  читается один раз на ИНСТАНС (квады-звёзды из фида); 0/undefined —
   *  обычный per-vertex (обратная совместимость). */
  bindVertexBuffer(bufferId: number, location: number, size: number, stride?: number, byteOffset?: number, divisor?: number): void
  setUniformMatrix4(programId: number, name: string, values: Float32Array): void
  setUniform4fv(programId: number, name: string, values: Float32Array): void
  setUniform3fv(programId: number, name: string, values: Float32Array): void
  setUniform2fv(programId: number, name: string, values: Float32Array): void
  setUniform1f(programId: number, name: string, value: number): void
  setUniform1i(programId: number, name: string, value: number): void
  /** Создать GPU-текстуру.
   *
   *  options.mipLevels (default 1): кол-во mip-уровней в цепи. Если >1 —
   *  используется gl.texStorage2D(target, levels, internalFormat, w, h)
   *  (immutable storage; internalFormat соответствует options.format) и
   *  TEXTURE_MIN_FILTER = LINEAR_MIPMAP_LINEAR (минификация выбирает mip
   *  по distance). Если 1 — обычный texImage2D level=0 с null (mutable
   *  storage), MIN_FILTER = LINEAR.
   *
   *  mipLevels высчитывается как 1 + floor(log2(min(w,h))). Можно передать
   *  'auto' (через string — но TS-контракт требует number, поэтому юзер
   *  сам считает или использует helper computeMipLevels(w, h)).
   *
   *  options.format (default 'rgba8', Task 67): формат хранения — 'rgba8' |
   *  'rgba16f' | 'rgba32f'. Влияет на internalFormat аллокации (texStorage2D
   *  / texImage2D-null) И на последующие загрузки: texImage2DFromSource /
   *  texSubImage2DFromSource / texImage2DLevel автоматически выводят пару
   *  (format, type) из формата текстуры (HALF_FLOAT / FLOAT) — WebGL2
   *  отклоняет несогласованные комбинации GL_INVALID_OPERATION'ом молча
   *  (та же ловушка, что Task 64, теперь для HDR).
   *
   *  options.maxAnisotropy (default 1 для non-mip, anisoMax для mip): включить
   *  анизотропную фильтрацию — sampler берёт несколько сэмплов под разными
   *  углами для лучшего качества под наклоном. Требует расширение
   *  EXT_texture_filter_anisotropic (caps.has('anisotropic')). Без расширения
   *  опция игнорируется. Степень двойки: 1 (off), 2, 4, 8, 16 (max desktop).
   *  Применяется только при mipLevels>1 (на non-mip бесполезна).
   *
   *  Контракт с texImage2DLevel: текстура с mipLevels=N ожидает, что
   *  уровни 0..N-1 будут загружены через texImage2DLevel(texId, level, src).
   *  texStorage2D гарантирует, что level L имеет размер w/(2^L) × h/(2^L)
   *  — WebGL2 сам проверит при texImage2D, если источник не совпадает —
   *  GL_INVALID_VALUE. */
  createTexture(
    width: number,
    height: number,
    options?: { mipLevels?: number; maxAnisotropy?: number; format?: GLTextureFormat },
  ): number
  texSubImage2D(textureId: number, x: number, y: number, width: number, height: number, bytes: Uint8Array): void
  /** Атомарная загрузка из bitmap/canvas/video — без стриминга, одним вызовом.
   *  Использует texImage2D overload с TexImageSource (перезаписывает текстуру).
   *
   *  flipY (default true): перевернуть источник по Y при загрузке — даёт
   *  паритет с WebGPU (textureSample там использует top-left origin).
   *  Для WebGL2 без flip: canvas row 0 (top) → texture row 0 (V=0 = bottom
   *  в конвенциях GL) — то есть текстура видна «вверх ногами» на кубе.
   *  flipY=true через gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, true) перед
   *  texImage2D, сброс к false после — состояние не течёт. */
  texImage2DFromSource(textureId: number, source: GLImageSource, options?: { flipY?: boolean }): void
  /** Загрузка части текстуры (sub-region) из bitmap/canvas/video.
   *  Использует texSubImage2D overload с TexImageSource. НЕ перезаписывает
   *  остальные пиксели — только регион [x, y, x+w, y+h].
   *
   *  Используется для:
   *   - runtime atlas packing (несколько битмапов в одну текстуру),
   *   - tile replacement (обновление части карты),
   *   - progressive loading (загрузка тайлов по мере необходимости).
   *
   *  flipY (default true) — аналогично texImage2DFromSource. */
  texSubImage2DFromSource(textureId: number, x: number, y: number, source: GLImageSource, options?: { flipY?: boolean }): void
  /** Загрузка конкретного mip-уровня текстуры (level 0 = базовый, 1 = 1/2 размер и т.д.).
   *
   *  Использует texImage2D overload с level параметром: gl.texImage2D(target, level,
   *  internalFormat, format, type, source). Перезаписывает указанный mip целиком.
   *
   *  Контракт mip-цепи: для текстуры размером N×N с mip chain levels=1+log2(N),
   *  каждый level L имеет размер N/(2^L). WebGL2 требует, чтобы все мипы были
   *  загружены для текстуры без FILTERING_MIPMAP, иначе texture() в шейдере вернёт
   *  чёрный при минификации.
   *
   *  Используется MipStreamer'ом для progressive mip upload (от маленького к большому).
   *
   *  Строгий формат/тип (Task 55): опциональные internalFormat/format/type
   *  позволяют загружать HDR-данные (RGBA16F, RGBA32F) и нестандартные типы
   *  (HALF_FLOAT, FLOAT, UNSIGNED_INT_2_10_10_10_REV). Без опций —
   *  авто-вывод ИЗ ФОРМАТА ТЕКСТУРЫ (Task 67): createTexture(...,{format:'rgba16f'})
   *  → (RGBA, HALF_FLOAT), {format:'rgba32f'} → (RGBA, FLOAT), иначе —
   *  RGBA8/RGBA/UNSIGNED_BYTE. WebGL2 отклоняет несогласованные пары
   *  GL_INVALID_OPERATION'ом молча — авто-вывод закрывает эту ловушку.
   *
   *  Контракт texImage2D(source) overload требует, чтобы format/type были
   *  совместимы с internalFormat текстуры (созданной через createTexture с
   *  gl.texStorage2D target internalFormat). Для RGBA8 (default) подойдут
   *  RGBA/UNSIGNED_BYTE; для RGBA16F — RGBA/HALF_FLOAT. Несовпадение →
   *  GL_INVALID_ENUM / GL_INVALID_OPERATION (WebGL2 spec).
   *
   *  Значения GLenum — числа (e.g. gl.RGBA8=0x8058, gl.RGBA=0x1908,
   *  gl.UNSIGNED_BYTE=0x1401, gl.HALF_FLOAT=0x140B, gl.FLOAT=0x1406).
   *  Юзер может передать как числовое значение, так и gl.RGBA8 если
   *  имеет доступ к контексту (через createGL injection). */
  texImage2DLevel(
    textureId: number,
    level: number,
    source: GLImageSource,
    options?: {
      flipY?: boolean
      /** internalFormat GLenum (default — из формата текстуры). Например: gl.RGBA16F. */
      internalFormat?: number
      /** format GLenum (default — из формата текстуры). Например: gl.RGBA. */
      format?: number
      /** type GLenum (default — из формата текстуры). Например: gl.HALF_FLOAT. */
      type?: number
    },
  ): void
  /** Привязать текстуру (или sub-mip view — Task 56) к сэмплер-юниту.
   *
   *  id ∈ [1, 1M) — textureId (default view): sampler видит всю mip-chain
   *  с base=0 и max=meta.maxLoadedLevel (progressive streaming, см. createTexture
   *  и texImage2DLevel).
   *
   *  id ∈ [1M, ∞) — viewId (sub-mip view, созданный через createTextureView):
   *  sampler видит только диапазон [view.baseMipLevel,
   *  view.baseMipLevel + view.mipLevelCount - 1]. Реализуется через
   *  gl.texParameteri(TEXTURE_BASE_LEVEL / TEXTURE_MAX_LEVEL).
   *
   *  Контракт без утечки state: при каждом bindTexture вызове BASE_LEVEL и
   *  MAX_LEVEL сбрасываются/устанавливаются заново. Если bind с viewId после
   *  bind с textureId (или наоборот) — параметры не протекают между вызовами.
   *
   *  Disjoint id namespace (как в WebGPU GPUFacade, см. realGPU.ts:335):
   *  textureId и viewId никогда не пересекаются. */
  bindTexture(textureOrViewId: number, unit: number): void
  /** Создать sub-mip-range view текстуры (Task 56: WebGL2 LOD-clamp API).
   *
   *  WebGL2 не имеет настоящего GPUTextureView (как WebGPU). Эмуляция через
   *  TEXTURE_BASE_LEVEL / TEXTURE_MAX_LEVEL параметры текстуры — применяются
   *  в bindTexture при каждой смене id (см. bindTexture контракт).
   *
   *  Паритет с WebGPU createTextureView:
   *   - baseMipLevel (default 0): стартовый mip-уровень для view
   *   - mipLevelCount (default = texture.mipLevels - baseMipLevel): кол-во
   *     мипов в view. view видит диапазон [baseMipLevel, baseMipLevel +
   *     mipLevelCount - 1].
   *
   *  Ограничения:
   *   - textureId должен существовать и иметь mipLevels ≥ 2 (иначе view
   *     не имеет смысла — sampler и так использует только level 0).
   *   - baseMipLevel + mipLevelCount ≤ texture.mipLevels.
   *   - При нарушении бросает Error (actionable).
   *
   *  @returns viewId ≥ 1_000_000. Используется в bindTexture(viewId, unit).
   *  @see bindTexture для семантики LOD-clamp при bind. */
  createTextureView(
    textureId: number,
    options?: {
      baseMipLevel?: number
      mipLevelCount?: number
    },
  ): number
  setViewport(width: number, height: number): void
  setDepthMode(test: string, write: boolean): void
  setCull(mode: string): void
  /** Task 75: блендинг пайплайна. src/dst — BlendFactor-строки фасада
   *  ('one', 'one-minus-src-alpha', ...); null/null — выключить.
   *  Премультиплицированный вывод шейдера: аддитив = ('one','one'),
   *  классическая прозрачность = ('one','one-minus-src-alpha'). */
  setBlend(src: string | null, dst: string | null): void
  clear(color: readonly [number, number, number, number] | readonly number[], depth: number | null): void
  drawArrays(mode: string, first: number, count: number, instances: number): void
  /** Цель рендера: FBO с цветовой текстурой (и опциональной глубиной).
   *  targetId 0 — канвас (встроенная цель, не создаётся). */
  createTarget(
    textureId: number,
    width: number,
    height: number,
    depth: boolean,
    color: readonly [number, number, number, number],
  ): number
  /** Переключить цель: 0 = канвас. clear — очистить цель её цветом
   *  (для канваса игнорируется: канвас чистит BeginPass). */
  bindTarget(targetId: number, clear: boolean): void
  /** Task 80 (readback): прочитать пиксели ЦЕЛИ (surface) — синхронно.
   *
   *  Контракт паритета с GPU-фасадом (Promise<Uint8Array>):
   *   - RGBA8, tight-раскладка (rowBytes = width*4);
   *   - строки СВЕРХУ ВНИЗ: data[0..3] = верхний-левый пиксель — GL
   *     readPixels отдаёт снизу-вверх (origin — левый-НИЖНИЙ угол), фасад
   *     переворачивает строки; WebGPU-текстуры и так хранятся сверху-вниз —
   *     один и тот же индекс = один и тот же пиксель на обоих бэкендах;
   *   - текущая привязка FBO сохраняется и восстанавливается (state не течёт).
   *
   *  targetId 0 (канвас) не читается — честный Error (WebGPU-путь не может
   *  детерминированно читать presented-канвас — паритет важнее полноты);
   *  читайте поверхность: renderer.surface(...) → capture/проходы →
   *  surface.read(). Читает содержимое ПОСЛЕ последнего исполненного кадра
   *  (внутри frame-колбэка — промежуточное состояние). */
  readTargetPixels(targetId: number): Uint8Array

  // ─── Disposal (M1 §9.9 disposal discipline) ─────────────────────────────
  // Каждый delete* освобождает GPU-ресурс и убирает запись из внутреннего
  // кэша фасада. Повторный вызов с тем же id — no-op (идемпотентность).
  // Рантайм также пишет destroy-опс в Journal (если фасад обёрнут withJournal).

  /** Удалить текстуру: gl.deleteTexture. Удаляет из textures Map.
   *  Также удаляет ВСЕ sub-mip views этой текстуры (созданные через
   *  createTextureView) — иначе bindTexture(viewId) продолжил бы работать
   *  с удалённой текстурой (no-op silently, но бесполезно). */
  deleteTexture(textureId: number): void
  /** Удалить цель: gl.deleteFramebuffer + (если была глубина) gl.deleteRenderbuffer.
   *  Не трогает текстуру (она — отдельный ресурс). Удаляет из targets Map. */
  deleteTarget(targetId: number): void
  /** Удалить программу: gl.deleteProgram. Удаляет из programs Map. */
  deleteProgram(programId: number): void
  /** Удалить буфер: gl.deleteBuffer. Удаляет из buffers Map. */
  deleteBuffer(bufferId: number): void
  /** Удалить sub-mip view (созданный через createTextureView выше).
   *  Default-view (привязка напрямую textureId в bindTexture) не может быть
   *  удалён этим методом — он управляется через deleteTexture.
   *  Идемпотентно: повторный deleteTextureView того же id — no-op.
   *
   *  После deleteTextureView: bindTexture(viewId, ...) — no-op (запись
   *  не найдена, sampler останется с предыдущим состоянием). */
  deleteTextureView(viewId: number): void
}
