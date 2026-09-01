// Настоящий фасад WebGL2: компиляция шейдеров, юниформы по имени,
// буферы атрибутов, текстуры. Один скрытый класс, ленивые кэши.

import type { GLFacade, GLImageSource, GLTextureFormat } from './facade.ts'

interface ProgramRecord {
  readonly program: WebGLProgram
  readonly uniforms: Map<string, WebGLUniformLocation | null>
}

/** Пара (format, type) для загрузки пикселей в текстуру данного формата
 *  хранения (WebGL2 spec Table 3.2: combination must be compatible with
 *  the sized internal format, иначе GL_INVALID_OPERATION — молча).
 *  RGBA16F принимает (RGBA, HALF_FLOAT) и (RGBA, FLOAT); RGBA32F — (RGBA, FLOAT). */
interface FormatInfo {
  readonly internalFormat: number
  readonly uploadFormat: number
  readonly uploadType: number
}

/** Спек-фиксированные GLenum (не зависят от контекста, доступны в mock-GL).
 *  RGBA8=0x8058, RGBA16F=0x881A, RGBA32F=0x8816, RGBA=0x1908,
 *  UNSIGNED_BYTE=0x1401, HALF_FLOAT=0x140B, FLOAT=0x1406,
 *  NEAREST=0x2600, LINEAR=0x2601, NEAREST_MIPMAP_NEAREST=0x2700,
 *  LINEAR_MIPMAP_LINEAR=0x2703. */
const ENUM = {
  RGBA8: 0x8058,
  RGBA16F: 0x881a,
  RGBA32F: 0x8816,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  HALF_FLOAT: 0x140b,
  FLOAT: 0x1406,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700,
  LINEAR_MIPMAP_LINEAR: 0x2703,
} as const

/** internalFormat + (format, type) загрузки по GLTextureFormat (Task 67). */
function formatInfo(format: GLTextureFormat): FormatInfo {
  switch (format) {
    case 'rgba16f':
      return { internalFormat: ENUM.RGBA16F, uploadFormat: ENUM.RGBA, uploadType: ENUM.HALF_FLOAT }
    case 'rgba32f':
      return { internalFormat: ENUM.RGBA32F, uploadFormat: ENUM.RGBA, uploadType: ENUM.FLOAT }
    default:
      return { internalFormat: ENUM.RGBA8, uploadFormat: ENUM.RGBA, uploadType: ENUM.UNSIGNED_BYTE }
  }
}

interface TargetRecord {
  readonly fbo: WebGLFramebuffer
  readonly textureId: number
  readonly width: number
  readonly height: number
  readonly depth: boolean
  readonly depthRenderbuffer: WebGLRenderbuffer | null
  readonly color: readonly number[]
}

export function createRealGL(gl: WebGL2RenderingContext): GLFacade {
  const programs = new Map<number, ProgramRecord>()
  const buffers = new Map<number, WebGLBuffer>()
  const textures = new Map<number, WebGLTexture>()
  const targets = new Map<number, TargetRecord>()
  // Per-texture metadata: ключ — textureId. Содержит:
  //   mipLevels: кол-во уровней в цепи (1 = нет цепи, N = texStorage2D с levels=N)
  //   maxLoadedLevel: индекс максимального загруженного уровня (для progressive
  //   streaming — поднимаем TEXTURE_MAX_LEVEL до этого значения, чтобы
  //   LINEAR_MIPMAP_LINEAR не пытался сэмплить незагруженные мипы → чёрный кадр)
  //   maxAnisotropy: значение, установленное через TEXTURE_MAX_ANISOTROPY_EXT
  //   (для расширения EXT_texture_filter_anisotropic).
  //   format: формат хранения (Task 67 HDR) — из него выводится пара
  //   (format, type) загрузок, если вызывающий не передал явные GLenum.
  const textureMeta = new Map<number, {
    mipLevels: number
    maxLoadedLevel: number
    maxAnisotropy: number
    format: GLTextureFormat
  }>()
  // Sub-mip views (Task 56): ключ — viewId (≥1M, disjoint namespace с textureId).
  // Значение — только метаданные диапазона мипов (baseMipLevel + maxMipLevel).
  // WebGL2 не имеет настоящего GPUTextureView, эмулируем через TEXTURE_BASE_LEVEL
  // и TEXTURE_MAX_LEVEL при bindTexture. Если view для текстуры удалён через
  // deleteTexture — все его sub-views тоже сносятся (см. deleteTexture cleanup).
  const textureViews = new Map<number, {
    textureId: number
    baseMipLevel: number
    maxMipLevel: number
  }>()
  let nextTextureViewId = 1_000_000
  // EXT_texture_filter_anisotropic — пробуем при создании контекста. Сохраняем
  // в замыкании, используем в createTexture для maxAnisotropy на текстурах с
  // mip-chain (LINEAR_MIPMAP_LINEAR). Без расширения caps.has('anisotropic')=false,
  // sampler остаётся без anisotropy.
  //
  // В mock-GL окружениях (headless-тесты без GPU) gl.getExtension может быть
  // undefined — оборачиваем в try/catch, в этом случае anisoExt=null, расширение
  // недоступно, maxAnisotropy на текстурах не применяется.
  let anisoExt: {
    TEXTURE_MAX_ANISOTROPY_EXT: number
    MAX_TEXTURE_MAX_ANISOTROPY_EXT: number
  } | null = null
  try {
    anisoExt = (gl as unknown as {
      getExtension?: (name: string) => unknown
    }).getExtension?.('EXT_texture_filter_anisotropic') as {
      TEXTURE_MAX_ANISOTROPY_EXT: number
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: number
    } | null ?? null
  } catch {
    anisoExt = null
  }
  // Максимально поддерживаемое драйвером значение anisotropy. Используем как
  // default для текстур с mip-chain (если не передано maxAnisotropy в options).
  // 1 = отключено (стандартный bilinear). 16 = максимум для desktop GPU.
  let anisoMax = 1
  if (anisoExt !== null) {
    try {
      anisoMax = (gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) || 1
    } catch {
      anisoMax = 1
    }
  }
  let nextProgram = 1
  let nextBuffer = 1
  let nextTexture = 1
  let nextTarget = 1
  let currentProgram: WebGLProgram | null = null
  let currentTarget = 0
  let canvasWidth = 1
  let canvasHeight = 1
  const unitTextures = new Map<number, number>() // юнит → textureId (профилактика feedback-loop)

  // Task 67: OES_texture_float_linear — линейная фильтрация RGBA32F.
  // Хранение/NEAREST-сэмплинг RGBA32F — core WebGL2; LINEAR — расширение
  // (десктопы обычно да, mobile часто нет). Без него LINEAR-фильтр делает
  // текстуру incomplete → сэмплер вернёт чёрный. Поэтому rgba32f без
  // расширения деградирует до NEAREST (честный пиксель, не чёрный кадр).
  // RGBA16F линейно фильтруется core — расширение не нужно.
  let floatLinearExt = false
  try {
    floatLinearExt = (gl as unknown as {
      getExtension?: (name: string) => unknown
    }).getExtension?.('OES_texture_float_linear') != null
  } catch {
    floatLinearExt = false
  }
  /** MAG-фильтр по формату: LINEAR, если формат линейно фильтруется. */
  function magFilter(format: GLTextureFormat): number {
    return format === 'rgba32f' && !floatLinearExt ? ENUM.NEAREST : ENUM.LINEAR
  }
  /** MIN-фильтр по формату и наличию mip-цепи. */
  function minFilter(format: GLTextureFormat, mipLevels: number): number {
    const linear = !(format === 'rgba32f' && !floatLinearExt)
    if (mipLevels > 1) return linear ? ENUM.LINEAR_MIPMAP_LINEAR : ENUM.NEAREST_MIPMAP_NEAREST
    return linear ? ENUM.LINEAR : ENUM.NEAREST
  }
  /** Пара (format, type) загрузки по формату хранения (или явным GLenum). */
  function uploadPair(textureId: number, explicit?: { format?: number; type?: number }): { format: number; type: number } {
    const meta = textureMeta.get(textureId)
    const fi = meta !== undefined ? formatInfo(meta.format) : formatInfo('rgba8')
    return {
      format: explicit?.format ?? fi.uploadFormat,
      type: explicit?.type ?? fi.uploadType,
    }
  }

  function createProgram(vertex: string, fragment: string): number {
    const program = gl.createProgram()
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`rune: линковка программы: ${gl.getProgramInfoLog(program)}`)
    }
    const id = nextProgram++
    programs.set(id, { program, uniforms: new Map() })
    return id
  }

  function compile(type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)
    if (shader === null) throw new Error('rune: createShader вернул null')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error(`rune: компиляция шейдера: ${log}`)
    }
    return shader
  }

  function useProgram(programId: number): void {
    const record = programs.get(programId)
    if (record === undefined || record.program === currentProgram) return
    currentProgram = record.program
    gl.useProgram(record.program)
  }

  function location(programId: number, name: string): WebGLUniformLocation | null {
    const record = programs.get(programId)
    if (record === undefined) return null
    if (!record.uniforms.has(name)) {
      record.uniforms.set(name, gl.getUniformLocation(record.program, name))
    }
    return record.uniforms.get(name) ?? null
  }

  function createBuffer(data: Float32Array): number {
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    const id = nextBuffer++
    buffers.set(id, buffer)
    return id
  }

  function bindVertexBuffer(bufferId: number, location: number, size: number, stride?: number, byteOffset?: number, divisor?: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.get(bufferId) ?? null)
    gl.enableVertexAttribArray(location)
    // M5: интерливинг фида — stride/offset записи (default: tight 0/0).
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride ?? 0, byteOffset ?? 0)
    // Task 75: инстанс-шаг (квады-звёзды: одна запись фида = один инстанс).
    // Вызываем БЕЗУСЛОВНО (и с 0) — сбрасываем делитель после инстансированных
    // команд, иначе атрибут «залипнет» с divisor=1 для обычной геометрии.
    gl.vertexAttribDivisor(location, divisor ?? 0)
  }

  /** M5 (Task 73): динамическое обновление (feed dual-bind) — bufferSubData.
   *  Хранилище уже выделено createBuffer (bufferData); здесь — только
   *  содержимое: рендерер фида льёт грязный диапазон одним вызовом. */
  function updateBuffer(bufferId: number, data: Float32Array, byteOffset = 0): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.get(bufferId) ?? null)
    gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, data)
  }

  function setUniformMatrix4(programId: number, name: string, values: Float32Array): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniformMatrix4fv(loc, false, values)
  }

  function setUniform4fv(programId: number, name: string, values: Float32Array): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniform4fv(loc, values)
  }

  function setUniform3fv(programId: number, name: string, values: Float32Array): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniform3fv(loc, values)
  }

  function setUniform2fv(programId: number, name: string, values: Float32Array): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniform2fv(loc, values)
  }

  function setUniform1f(programId: number, name: string, value: number): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniform1f(loc, value)
  }

  function setUniform1i(programId: number, name: string, value: number): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniform1i(loc, value)
  }

  function createTexture(
    width: number,
    height: number,
    options?: { mipLevels?: number; maxAnisotropy?: number; format?: GLTextureFormat },
  ): number {
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    const mipLevels = options?.mipLevels ?? 1
    // Task 67 HDR: формат хранения — из него internalFormat аллокации и
    // (format, type) всех последующих загрузок (см. formatInfo).
    const format = options?.format ?? 'rgba8'
    const fi = formatInfo(format)
    if (mipLevels > 1) {
      // Immutable storage: texStorage2D(target, levels, internalFormat, w, h).
      // Создаёт mip-цепь за один вызов, фиксируя размер на всех уровнях.
      // После texStorage2D нельзя вызывать texImage2D с null для создания —
      // только texImage2D-перегрузку с source для записи пикселей.
      // MIN_FILTER = LINEAR_MIPMAP_LINEAR: минификация выбирает mip по distance,
      // давая классический mip-map sampling.
      //
      // Progressive streaming: TEXTURE_MAX_LEVEL=0 сразу после создания, чтобы
      // sampler использовал только level 0 (пока пустой — WebGL2 возвращает 0 или
      // мусор, но НЕ падает). texImage2DLevel поднимает MAX_LEVEL по мере загрузки.
      // Альтернатива (gl.generateMipmap) требует, чтобы level 0 уже был загружен.
      gl.texStorage2D(gl.TEXTURE_2D, mipLevels, fi.internalFormat, width, height)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter(format, mipLevels))
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter(format))
      // MAX_LEVEL=0: sampler видит только level 0 (пока streaming не заполнит
      // остальные). По умолчанию WebGL2 ставит 1000 — тогда sampling нулевых
      // уровней даёт чёрный кадр. С MAX_LEVEL=0 используем только то, что загружено.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0)
    } else {
      // Mutable storage: texImage2D с null (как и раньше). Минификация без
      // mip-цепи → LINEAR (GLFW выбирает texel по bilinear на level=0).
      // internalFormat/type — по формату хранения (Task 67): для RGBA16F
      // аллокация с UNSIGNED_BYTE недопустима — пара из formatInfo.
      gl.texImage2D(gl.TEXTURE_2D, 0, fi.internalFormat, width, height, 0, fi.uploadFormat, fi.uploadType, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter(format, mipLevels))
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter(format))
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // Anisotropic filtering — только для текстур с mip-chain (mipLevels>1).
    // На non-mip текстурах anisotropy бесполезна (MIN_FILTER=LINEAR, без
    // межмиповой интерполяции). caps.has('anisotropic')=true iff расширение
    // доступно. По умолчанию — максимальное значение драйвера (anisoMax,
    // обычно 16 на desktop, 2-4 на mobile).
    //
    // maxAnisotropy: 1 = disabled (bilinear/trilinear), 2..maxAnisotropy = enabled.
    // По умолчанию в этом renderer'е — anisoMax (если расширение есть), или 1
    // если расширения нет. Пользователь может явно передать maxAnisotropy: 4
    // для мягкой анизотропии (2x SSAA-equivalent), или maxAnisotropy: 1 для
    // отключения на конкретной текстуре.
    let appliedAniso = 1
    if (mipLevels > 1 && anisoExt !== null) {
      const requested = options?.maxAnisotropy ?? anisoMax
      // WebGPU/спецификация: maxAnisotropy должен быть степенью двойки (1, 2, 4, 8, 16).
      // WebGL2 не требует степень двойки, но для паритета ограничиваем.
      // Clamp к [1, anisoMax].
      const clamped = Math.max(1, Math.min(requested, anisoMax))
      gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, clamped)
      appliedAniso = clamped
    }
    const id = nextTexture++
    textures.set(id, texture)
    textureMeta.set(id, { mipLevels, maxLoadedLevel: 0, maxAnisotropy: appliedAniso, format })
    return id
  }

  function texSubImage2D(textureId: number, x: number, y: number, width: number, height: number, bytes: Uint8Array): void {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null)
    // Raw-байтовый путь — домен UploadScheduler'а: Uint8Array подразумевает
    // 8-битные пиксели. Для HDR-текстур (rgba16f/rgba32f) байты будут
    // интерпретированы по (format, type) формата текстуры — данные должен
    // готовить вызывающий (scheduler-стриминг в float — отдельная задача).
    const pair = uploadPair(textureId)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, pair.format, pair.type, bytes)
  }

  function texImage2DFromSource(textureId: number, source: GLImageSource, options?: { flipY?: boolean }): void {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null)
    // Permalink overload: texImage2D(target, level, internalformat, format, type, source)
    // — source перезаписывает содержимое текстуры (мип 0). Размер берётся из источника.
    // Для RGBA8-текстуры это внутренний формат; source-путь сам приводит пиксели.
    //
    // flipY (default false): UNPACK_FLIP_Y_WEBGL перед вызовом, сброс после.
    // Паритет с WebGPU: copyExternalImageToTexture принимает flipY в
    // GPUCopyExternalImageSourceInfo — если передать true, WebGPU также
    // переворачивает источник по Y. При flipY=false оба бэкенда пишут
    // source row 0 в texture row 0 — отображение идентично.
    // Состояние не течёт: всегда возвращаем false после вызова.
    //
    // IMMUTABLE-текстуры (Task 64 fix): если хранилище выделено через
    // texStorage2D (mip-chain, mipLevels>1), ЛЮБОЙ texImage2D — включая
    // перегрузку с source и level=0 — генерирует GL_INVALID_OPERATION и
    // МОЛЧА игнорируется (GLES3: immutable texture image → TexImage*
    // недопустим; подтверждено зондом Chromium: err=1282 на texImage2D,
    // err=0 на texSubImage2D). Единственный легальный путь записи —
    // texSubImage2D(level, 0, 0, format, type, source). ДО фикса uploadImage
    // на mip-chain текстурах терял пиксели молча: сцены sub-mip view /
    // create view рендерились пустыми (прозрачный квад), и восстановление
    // после loss выглядело «не работающим» — при исправном журнале.
    const flipY = options?.flipY ?? false
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    const meta = textureMeta.get(textureId)
    // Task 67 HDR: (format, type) — из формата хранения текстуры. Для
    // RGBA16F/RGBA32F пара (RGBA, UNSIGNED_BYTE) недопустима — texSubImage2D
    // молча вернёт GL_INVALID_OPERATION и пиксели будут потеряны.
    const pair = uploadPair(textureId)
    if (meta !== undefined && meta.mipLevels > 1) {
      // immutable (texStorage2D): пишем через texSubImage2D level=0
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pair.format, pair.type, source as TexImageSource)
    } else {
      const internalFormat = meta !== undefined ? formatInfo(meta.format).internalFormat : ENUM.RGBA8
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, pair.format, pair.type, source as TexImageSource)
    }
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  }

  function texSubImage2DFromSource(textureId: number, x: number, y: number, source: GLImageSource, options?: { flipY?: boolean }): void {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null)
    // texSubImage2D overload с TexImageSource: обновляет только регион
    // [x, y, x+source.width, y+source.height]. Не трогает остальную текстуру.
    // Размер региона берётся из source (width/height у ImageBitmap/Canvas).
    //
    // flipY (default false) — паритет с WebGPU copyExternalImageToTexture:
    // оба бэкенда принимают flipY в опциях и при true переворачивают источник
    // по Y перед копированием. При false — пишут source row 0 в texture row 0.
    // Квад prims/quad.ts использует UV (0,0) на верхнем-левом вершине —
    // при flipY=false изображение отображается вертикально честно на обоих бэкендах.
    const flipY = options?.flipY ?? false
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    // Task 67 HDR: (format, type) — из формата хранения (паритет с
    // texImage2DFromSource: HALF_FLOAT/FLOAT для float-текстур).
    const pair = uploadPair(textureId)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, pair.format, pair.type, source as TexImageSource)
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  }

  function texImage2DLevel(
    textureId: number,
    level: number,
    source: GLImageSource,
    options?: {
      flipY?: boolean
      internalFormat?: number
      format?: number
      type?: number
    },
  ): void {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null)
    // Permalink overload: texImage2D(target, level, internalFormat, format, type, source).
    // Загружает конкретный mip-уровень (level=0 — базовый, 1 — 1/2 размера, и т.д.).
    // Размер source должен быть N/(2^level). WebGL2 сам проверит — если source
    // не совпадает с ожидаемым размером мипа, будет GL_INVALID_VALUE.
    //
    // Для mipmap текстуры (созданной через texStorage2D с levels>1 в createTexture)
    // работает progressive streaming: после загрузки level=L поднимаем
    // TEXTURE_MAX_LEVEL до L (если был ниже). Так LINEAR_MIPMAP_LINEAR видит
    // только загруженные уровни — незагруженные остаются null, но sampler не
    // пытается их сэмплить → нет чёрного кадра при частичной загрузке.
    //
    // Для non-mip текстуры (mipLevels=1): MAX_LEVEL игнорируется (MIN_FILTER=LINEAR
    // не использует mips), level>0 не даст видимого эффекта без пересоздания
    // текстуры с texStorage2D levels.
    //
    // flipY (default false) — WebGPU-паритет (см. texImage2DFromSource).
    //
    // Строгий формат/тип (Task 55): internalFormat/format/type — опциональные
    // GLenum-числа. Task 67: БЕЗ явных значений — авто-вывод из формата
    // ХРАНЕНИЯ текстуры (createTexture(...,{format})): rgba16f →
    // RGBA16F/RGBA/HALF_FLOAT, rgba32f → RGBA32F/RGBA/FLOAT, иначе —
    // RGBA8/RGBA/UNSIGNED_BYTE (baseline). Поддержка HDR-форматов: RGBA16F
    // (0x881A) с RGBA/HALF_FLOAT (0x140B); RGBA32F (0x8816) с RGBA/FLOAT.
    // Рендер В float-цель требует EXT_color_buffer_float; хранение float-
    // текстур — core WebGL2 (см. capsProbe: float16/float32-фичи).
    const flipY = options?.flipY ?? false
    const meta = textureMeta.get(textureId)
    const fi = meta !== undefined ? formatInfo(meta.format) : formatInfo('rgba8')
    const internalFormat = options?.internalFormat ?? fi.internalFormat
    const pair = uploadPair(textureId, options)
    const format = pair.format
    const type = pair.type
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    // IMMUTABLE-текстуры (Task 64 fix): texImage2D на любом level хранилища
    // texStorage2D генерирует GL_INVALID_OPERATION и МОЛЧА игнорируется
    // (зонд Chromium/SwiftShader: texImage2D(level=4) → err=1282, пиксели
    // НЕ записаны; texSubImage2D(level=4,0,0) → err=0, пиксели корректны).
    // Для mip-chain текстур (meta.mipLevels>1) пишем через texSubImage2D —
    // DOM-source перегрузка выводит width/height из самого источника.
    // Mutable-путь (mipLevels=1, texImage2D-null аллокация) не тронут:
    // texImage2D с level>0 там легален и аллоцирует уровень.
    if (meta !== undefined && meta.mipLevels > 1) {
      gl.texSubImage2D(gl.TEXTURE_2D, level, 0, 0, format, type, source as TexImageSource)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, level, internalFormat, format, type, source as TexImageSource)
    }
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    // Progressive mip streaming: поднимаем TEXTURE_MAX_LEVEL до текущего level,
    // чтобы LINEAR_MIPMAP_LINEAR использовал только загруженные мипы. Без этого
    // WebGL2 по умолчанию MAX_LEVEL=1000 → sampler сэмплит нулевые уровни → чёрный.
    if (meta !== undefined && meta.mipLevels > 1 && level > meta.maxLoadedLevel) {
      meta.maxLoadedLevel = level
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level)
    }
  }

  function bindTexture(textureOrViewId: number, unit: number): void {
    // Disjoint id namespace (Task 56): id < 1M = textureId (default view),
    // id ≥ 1M = viewId (sub-mip view, созданный через createTextureView).
    // Если это viewId — находим subView, берём его textureId, устанавливаем
    // TEXTURE_BASE_LEVEL / TEXTURE_MAX_LEVEL под диапазон view. Если это
    // textureId — сбрасываем базу=0, max=meta.maxLoadedLevel (progressive
    // streaming). Состояние BASE_LEVEL/MAX_LEVEL не протекает между
    // вызовами bindTexture: каждый вызов переписывает оба параметра заново
    // на той текстуре, к которой привязан.
    gl.activeTexture(gl.TEXTURE0 + unit)
    const subView = textureViews.get(textureOrViewId)
    let underlyingTextureId: number
    let baseLevel: number
    let maxLevel: number
    if (subView !== undefined) {
      underlyingTextureId = subView.textureId
      baseLevel = subView.baseMipLevel
      maxLevel = subView.maxMipLevel
    } else {
      underlyingTextureId = textureOrViewId
      const meta = textureMeta.get(underlyingTextureId)
      baseLevel = 0
      // Для mip-chain текстуры: maxLevel = maxLoadedLevel (streaming state).
      // Для non-mip текстуры: maxLevel = 0 (только level 0, MAX_LEVEL
      // игнорируется MIN_FILTER=LINEAR без mipmap, но ставим 0 для чистоты).
      maxLevel = meta !== undefined ? meta.maxLoadedLevel : 0
    }
    gl.bindTexture(gl.TEXTURE_2D, textures.get(underlyingTextureId) ?? null)
    // Базовый/максимальный mip-уровень sampler'а. WebGL2 spec: TEXTURE_BASE_LEVEL
    // и TEXTURE_MAX_LEVEL — per-texture-object state, НЕ per-bind. Поэтому
    // всегда переустанавливаем при bindTexture, чтобы предыдущий bind (с
    // другим view на этой же текстуре) не протёк BASE_LEVEL/MAX_LEVEL.
    // Это особенно важно при bindTexture(viewId, unit=0) сразу после
    // bindTexture(textureId, unit=1) — без этой перезаписи unit=0
    // унаследовал бы диапазон view, который не должен.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, baseLevel)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, maxLevel)
    // unitTextures хранит underlying textureId (НЕ viewId) — это нужно для
    // feedback-loop профилактики в bindTarget: цель и сэмплер на одной
    // текстуре = GL undefined behavior, ANGLE/SwiftShader гасят draw.
    unitTextures.set(unit, underlyingTextureId)
  }

  function createTextureView(
    textureId: number,
    options?: {
      baseMipLevel?: number
      mipLevelCount?: number
    },
  ): number {
    const meta = textureMeta.get(textureId)
    if (meta === undefined) {
      throw new Error(`rune: createTextureView — текстура ${textureId} не найдена`)
    }
    const mipLevels = meta.mipLevels
    if (mipLevels < 2) {
      throw new Error(
        `rune: createTextureView — текстура ${textureId} имеет mipLevels=${mipLevels} ` +
        '(нет mip-chain). Sub-mip view имеет смысл только при mipLevels ≥ 2.',
      )
    }
    const baseMipLevel = options?.baseMipLevel ?? 0
    if (baseMipLevel < 0 || baseMipLevel >= mipLevels) {
      throw new Error(
        `rune: createTextureView — baseMipLevel=${baseMipLevel} вне диапазона [0, ${mipLevels - 1}] ` +
        `(textureId=${textureId}, mipLevels=${mipLevels})`,
      )
    }
    // default mipLevelCount = все оставшиеся мипы до конца цепи
    const mipLevelCount = options?.mipLevelCount ?? (mipLevels - baseMipLevel)
    if (mipLevelCount < 1 || baseMipLevel + mipLevelCount > mipLevels) {
      throw new Error(
        `rune: createTextureView — baseMipLevel=${baseMipLevel} + mipLevelCount=${mipLevelCount} ` +
        `превышает mipLevels=${mipLevels} (textureId=${textureId})`,
      )
    }
    const viewId = nextTextureViewId++
    textureViews.set(viewId, {
      textureId,
      baseMipLevel,
      maxMipLevel: baseMipLevel + mipLevelCount - 1,
    })
    return viewId
  }

  function deleteTextureView(viewId: number): void {
    // Идемпотентность: нет записи — no-op.
    textureViews.delete(viewId)
  }

  function setViewport(width: number, height: number): void {
    canvasWidth = width
    canvasHeight = height
    gl.viewport(0, 0, width, height)
  }

  function createTarget(
    textureId: number,
    width: number,
    height: number,
    depth: boolean,
    color: readonly [number, number, number, number],
  ): number {
    const fbo = gl.createFramebuffer()
    if (fbo === null) throw new Error('rune: createFramebuffer вернул null')
    let depthRenderbuffer: WebGLRenderbuffer | null = null
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textures.get(textureId) ?? null, 0)
    if (depth) {
      depthRenderbuffer = gl.createRenderbuffer()
      if (depthRenderbuffer === null) throw new Error('rune: createRenderbuffer вернул null')
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRenderbuffer)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRenderbuffer)
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    // Возврат прежней цели до возможного throw: состояние не течёт
    gl.bindFramebuffer(gl.FRAMEBUFFER, currentTarget === 0 ? null : targets.get(currentTarget)?.fbo ?? null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      // Очистка: созданный FBO и renderbuffer — мусор
      if (depthRenderbuffer !== null) gl.deleteRenderbuffer(depthRenderbuffer)
      gl.deleteFramebuffer(fbo)
      throw new Error(`rune: FBO поверхности неполный (статус ${status}) — размер ${width}x${height}`)
    }
    const id = nextTarget++
    targets.set(id, {
      fbo,
      textureId,
      width,
      height,
      depth,
      depthRenderbuffer,
      color,
    })
    return id
  }

  function bindTarget(targetId: number, clear: boolean): void {
    if (targetId === currentTarget && !clear) return
    currentTarget = targetId
    if (targetId === 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, canvasWidth, canvasHeight)
      return
    }
    const target = targets.get(targetId)
    if (target === undefined) return
    // Feedback-loop профилактика: текстуру ЦЕЛИ нельзя держать привязанной к
    // сэмплер-юнитам, пока она — цветовое прикрепление FBO (GL: undefined;
    // ANGLE/SwiftShader гасят такие draw). Ровно это убивало кадр 2+.
    for (const [unit, boundId] of unitTextures) {
      if (boundId === target.textureId) {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, null)
        unitTextures.delete(unit)
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.viewport(0, 0, target.width, target.height)
    if (clear) {
      gl.clearColor(target.color[0], target.color[1], target.color[2], target.color[3])
      if (target.depth) {
        gl.depthMask(true) // clear маскируется depthMask (см. clear())
        gl.clearDepth(1)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      } else {
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
    }
  }

  function setDepthMode(test: string, write: boolean): void {
    if (test === 'always') gl.disable(gl.DEPTH_TEST)
    else {
      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(test === 'lequal' ? gl.LEQUAL : gl.LESS)
    }
    gl.depthMask(write)
  }

  // ─── Task 80: readback (readPixels + флип строк) ───────────────────
  // Контракт паритета с GPU-фасадом: RGBA8, tight, строки СВЕРХУ ВНИЗ.
  // GL readPixels: origin — левый-НИЖНИЙ угол, строка 0 — нижняя; WebGPU
  // copyTextureToBuffer отдаёт строки сверху-вниз. Флип здесь даёт один и
  // тот же индекс = один и тот же пиксель на обоих бэкендах.
  function readTargetPixels(targetId: number): Uint8Array {
    if (targetId === 0) {
      throw new Error('rune: readTargetPixels(0) — канвас не читается (паритет с WebGPU: presented-текстура живёт один кадр). Читайте ПОВЕРХНОСТЬ: renderer.surface(...) → capture/проходы → surface.read()')
    }
    const target = targets.get(targetId)
    if (target === undefined) {
      throw new Error(`rune: readTargetPixels — цель ${targetId} не найдена (удалена или не создана)`)
    }
    const w = target.width
    const h = target.height
    // Привязка FBO не течёт: читаем в своей привязке, возвращаем прежнюю.
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    const rowBytes = w * 4
    const bottomUp = new Uint8Array(rowBytes * h)
    try {
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp)
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, currentTarget === 0 ? null : targets.get(currentTarget)?.fbo ?? null)
    }
    // Флип: GL row 0 = низ → на выходе row 0 = верх (как texture row 0).
    const out = new Uint8Array(rowBytes * h)
    for (let y = 0; y < h; y++) {
      out.set(bottomUp.subarray((h - 1 - y) * rowBytes, (h - y) * rowBytes), y * rowBytes)
    }
    return out
  }

  function setCull(mode: string): void {
    if (mode === 'none') gl.disable(gl.CULL_FACE)
    else {
      gl.enable(gl.CULL_FACE)
      gl.cullFace(mode === 'front' ? gl.FRONT : gl.BACK)
    }
  }

  /** Task 75: BlendFactor-строка фасада → GLenum. */
  const BLEND_FACTORS: Record<string, number> = {
    'zero': 0, 'one': 1, 'src-color': 0x0300, 'one-minus-src-color': 0x0301,
    'src-alpha': 0x0302, 'one-minus-src-alpha': 0x0303,
    'dst-color': 0x0306, 'one-minus-dst-color': 0x0307,
  }

  function setBlend(src: string | null, dst: string | null): void {
    if (src === null || dst === null) {
      gl.disable(gl.BLEND)
      return
    }
    gl.enable(gl.BLEND)
    // Премультиплированный вывод шейдера: blendFunc(src, dst) без
    // разделения RGB/A — альфа-канал канваса непрозрачен (alpha:false).
    gl.blendFunc(BLEND_FACTORS[src] ?? gl.ONE, BLEND_FACTORS[dst] ?? gl.ZERO)
  }

  function clear(color: readonly number[], depth: number | null): void {
    gl.clearColor(color[0], color[1], color[2], color[3])
    // glClear маскируется depthMask: прошлый кадр мог оставить false
    // (полноэкранный проход) — глубина молча не чистилась бы (урок демо-10:
    // кадр 2+ пустой, сцена z-fighting'ит с прошлым кадром)
    if (depth !== null) {
      gl.depthMask(true)
      gl.clearDepth(depth)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    } else {
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
  }

  function drawArrays(mode: string, first: number, count: number, instances: number): void {
    if (instances > 1) gl.drawArraysInstanced(mode === 'triangles' ? gl.TRIANGLES : gl.TRIANGLES, first, count, instances)
    else gl.drawArrays(gl.TRIANGLES, first, count)
  }

  // ─── Disposal: явное освобождение GPU-ресурса ────────────────────────
  // Идемпотентность: повторный delete того же id — no-op (записи уже нет в Map).
  // Если id не найден — тоже no-op (ничего не поделаешь, но и не бросаем).

  function deleteTexture(textureId: number): void {
    const texture = textures.get(textureId)
    if (texture === undefined) return
    // Снимаем привязку со сэмплер-юнитов (иначе deleteTexture молча игнорируется на некоторых драйверах)
    for (const [unit, boundId] of unitTextures) {
      if (boundId === textureId) {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, null)
        unitTextures.delete(unit)
      }
    }
    gl.deleteTexture(texture)
    textures.delete(textureId)
    textureMeta.delete(textureId)
    // Удалить все sub-mip views этой текстуры (Task 56): они бесполезны без
    // родительской текстуры — bindTexture(viewId) будет no-op (textureId не
    // найден в textures Map). Удаляем из textureViews чтобы гарантировать,
    // что textureViews не накапливает «осиротевшие» записи до конца сессии.
    for (const [viewId, sv] of textureViews) {
      if (sv.textureId === textureId) {
        textureViews.delete(viewId)
      }
    }
  }

  function deleteTarget(targetId: number): void {
    const target = targets.get(targetId)
    if (target === undefined) return
    // Если цель сейчас активна — отцепляем от контекста ДО удаления
    if (currentTarget === targetId) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      currentTarget = 0
    }
    if (target.depthRenderbuffer !== null) gl.deleteRenderbuffer(target.depthRenderbuffer)
    gl.deleteFramebuffer(target.fbo)
    targets.delete(targetId)
  }

  function deleteProgram(programId: number): void {
    const record = programs.get(programId)
    if (record === undefined) return
    if (currentProgram === record.program) {
      gl.useProgram(null)
      currentProgram = null
    }
    gl.deleteProgram(record.program)
    programs.delete(programId)
  }

  function deleteBuffer(bufferId: number): void {
    const buffer = buffers.get(bufferId)
    if (buffer === undefined) return
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.deleteBuffer(buffer)
    buffers.delete(bufferId)
  }

  return {
    createProgram,
    useProgram,
    createBuffer,
    bindVertexBuffer,
    updateBuffer,
    setUniformMatrix4,
    setUniform4fv,
    setUniform3fv,
    setUniform2fv,
    setUniform1f,
    setUniform1i,
    createTexture,
    texSubImage2D,
    texImage2DFromSource,
    texSubImage2DFromSource,
    texImage2DLevel,
    bindTexture,
    createTextureView,
    deleteTextureView,
    setViewport,
    setDepthMode,
    setCull,
    setBlend,
    clear,
    drawArrays,
    createTarget,
    bindTarget,
    readTargetPixels,
    deleteTexture,
    deleteTarget,
    deleteProgram,
    deleteBuffer,
  }
}
