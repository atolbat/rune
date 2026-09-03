// GPU recorder facade: the frame's call order as strings (protects tape paths).

import type { GPUFacade, GPUImageSource } from './facade.ts'

export interface RecordingGPU {
  readonly gpu: GPUFacade
  readonly calls: string[]
}

export function createRecordingGPU(): RecordingGPU {
  const calls: string[] = []
  let nextTextureId = 1
  let nextTargetId = 1
  let nextTextureViewId = 1_000_000
  let currentTarget = 0
  let passOpen = false

  const gpu: GPUFacade = {
    configure: (width, height) => calls.push(`configure(${width},${height})`),
    resize: (width, height) => calls.push(`resize(${width},${height})`),
    // Task 116: the canvas clear state — recorded so tests can pin that the
    // renderer's `clear` option actually reaches the facade (the background
    // parity regression).
    setCanvasClearColor: (color, depth) => {
      const depthSuffix = depth !== undefined ? `,d=${depth}` : ''
      calls.push(`setCanvasClearColor(${color[0]},${color[1]},${color[2]},${color[3]}${depthSuffix})`)
    },
    createTexture: (width, height, format, options) => {
      const mipLevels = options?.mipLevels ?? 1
      const aniso = options?.maxAnisotropy
      // Task 67: HDR formats are written to the record; rgba8unorm is the default, omitted.
      const fmtSuffix = format !== undefined && format !== 'rgba8unorm' ? `,${format}` : ''
      const parts: string[] = []
      if (mipLevels > 1) parts.push(`mipLevels=${mipLevels}`)
      if (aniso !== undefined) parts.push(`aniso=${aniso}`)
      const optSuffix = parts.length > 0 ? `,${parts.join(',')}` : ''
      calls.push(`createTexture(${width},${height}${fmtSuffix}${optSuffix})`)
      return nextTextureId++
    },
    texSubImage2D: (textureId, x, y, width, height) =>
      calls.push(`texSubImage2D(${textureId},${x},${y},${width},${height})`),
    copyExternalImageToTexture: (textureId, source, dstX, dstY, w, h, flipY) => {
      const kind = describeGpuSource(source)
      const flipSuffix = flipY === true ? ',flipY' : ''
      calls.push(`copyExternalImageToTexture(${textureId},${kind},@${dstX},${dstY},${w}x${h}${flipSuffix})`)
    },
    copyExternalImageToTextureMip: (textureId, mipLevel, source, dstX, dstY, w, h, flipY) => {
      const kind = describeGpuSource(source)
      const flipSuffix = flipY === true ? ',flipY' : ''
      calls.push(`copyExternalImageToTextureMip(${textureId},mip=${mipLevel},${kind},@${dstX},${dstY},${w}x${h}${flipSuffix})`)
    },
    uploadUniforms: (offset, data) => calls.push(`uploadUniforms(${offset},${data.byteLength})`),
    ensurePipeline: (pipelineId, _wgsl, attrs, hasTextures, pipeline) => {
      // M5: numbers — tight (3x3x2); feed interleaving — size/stride@offset.
      // Task 75: instance-step suffix + blend/depth descriptor markers.
      const desc = attrs.map(a => {
        if (typeof a === 'number') return `${a}`
        const inst = a.step === 'instance' ? '!i' : ''
        return `${a.size}${inst}/${a.stride ?? a.size * 4}@${a.offset ?? 0}`
      }).join('x')
      const state: string[] = []
      if (pipeline?.blend !== undefined && pipeline.blend !== false) state.push(`blend=${pipeline.blend.src}/${pipeline.blend.dst}`)
      if (pipeline?.depth === false) state.push('depth=off')
      calls.push(`ensurePipeline(${pipelineId}, [${desc}]${hasTextures ? ', tex' : ''}${state.length > 0 ? `, ${state.join(' ')}` : ''})`)
    },
    usePipeline: pipelineId => calls.push(`usePipeline(${pipelineId})`),
    bindUniforms: offset => calls.push(`bindUniforms(${offset})`),
    bindVertexBuffer: (slot, data, size) => calls.push(`bindVertexBuffer(${slot},${data.length},${size})`),
    syncVertexBuffer: (data, byteLength) => calls.push(`syncVertexBuffer(${data.length},${byteLength})`),
    bindTexture: textureId => calls.push(`bindTexture(${textureId})`),
    beginPass: clearIndex => {
      currentTarget = 0
      passOpen = true
      calls.push(`beginPass(${clearIndex})`)
    },
    draw: (count, instances) => calls.push(`draw(${count},${instances})`),
    endPass: () => {
      passOpen = false
      calls.push('endPass')
    },
    submit: () => calls.push('submit'),
    // Task 80: readback — record the call; the recorder has no GPU — an
    // empty array (shape parity with the realGPU contract). The targetId 0
    // contract (the canvas is not readable) is mirrored: honest reject as
    // in realGPU.
    readTargetPixels: targetId => {
      if (targetId === 0) {
        return Promise.reject(new Error('rune: readTargetPixels(0) — the canvas cannot be read (a presented texture lives one frame). Read the SURFACE: renderer.surface(...) → capture/passes → surface.read()'))
      }
      calls.push(`readTargetPixels(${targetId})`)
      return Promise.resolve(new Uint8Array(0))
    },
    createTarget: (textureId, width, height, depth) => {
      calls.push(`createTarget(${textureId},${width},${height}${depth ? ',depth' : ''})`)
      return nextTargetId++
    },
    bindTarget: (targetId, clear) => {
      // The same skip contract as realGPU: same target, pass open, no clear
      if (targetId === currentTarget && passOpen && !clear) return
      currentTarget = targetId
      passOpen = true
      calls.push(`bindTarget(${targetId},${clear ? 1 : 0})`)
    },
    deleteTexture: textureId => calls.push(`deleteTexture(${textureId})`),
    deleteTarget: targetId => calls.push(`deleteTarget(${targetId})`),
    createTextureView: (textureId, options) => {
      const base = options?.baseMipLevel ?? 0
      const count = options?.mipLevelCount
      const optSuffix = (base !== 0 || count !== undefined)
        ? `,mip=${base}${count !== undefined ? `+${count}` : ''}`
        : ''
      calls.push(`createTextureView(${textureId}${optSuffix})`)
      // Return a fake viewId from the sub-view range (≥1M)
      nextTextureViewId++
      return nextTextureViewId
    },
    deleteTextureView: viewId => calls.push(`deleteTextureView(${viewId})`),
    dispose: () => calls.push('dispose'),
    installTimer: handle => {
      const handleName = handle === null ? 'null' : 'handle'
      calls.push(`installTimer(${handleName})`)
      // recording does not store the handle — return null (there is no previous one)
      return null
    },
    get adapter() { return null },
    get device() { return null },
    get preferredFormat() { return 'bgra8unorm' as GPUTextureFormat },
    get timer() { return null }, // recording facade: no device, no timer
  }

  return { gpu, calls }
}

/** Source type name to record in the call string. */
function describeGpuSource(source: GPUImageSource): string {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'ImageBitmap'
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return 'OffscreenCanvas'
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return 'HTMLCanvasElement'
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return 'HTMLVideoElement'
  // Duck-typing for headless environments without global types
  if (typeof source === 'object' && source !== null) {
    if ('getContext' in source) return 'OffscreenCanvas'
    if ('close' in source && 'width' in source) return 'ImageBitmap'
  }
  return (source as { constructor: { name: string } }).constructor?.name ?? 'unknown'
}

/** Counting GPU facade: zero work, only increments — benchmarks of the
 *  frame path (theory E) without the cost of recording strings. */
export function createCountingGPU(): GPUFacade & { totalCalls: number } {
  let totalCalls = 0
  const bump = (): void => { totalCalls++ }
  let nextId = 0
  const alloc = (): number => nextId++
  return {
    configure: bump,
    resize: bump,
    setCanvasClearColor: bump,
    createTexture: alloc as never,
    texSubImage2D: bump,
    copyExternalImageToTexture: bump,
    copyExternalImageToTextureMip: bump,
    uploadUniforms: bump,
    ensurePipeline: bump,
    usePipeline: bump,
    bindUniforms: bump,
    bindVertexBuffer: bump,
    syncVertexBuffer: bump,
    bindTexture: bump,
    beginPass: bump,
    draw: bump,
    endPass: bump,
    submit: bump,
    readTargetPixels: () => {
      bump()
      return Promise.resolve(new Uint8Array(0))
    },
    createTarget: alloc as never,
    bindTarget: bump,
    deleteTexture: bump,
    deleteTarget: bump,
    createTextureView: alloc as never,
    deleteTextureView: bump,
    dispose: bump,
    get timer() { return null as never },
    get adapter() { return null as never },
    get device() { return null as never },
    get preferredFormat() { return 'rgba8unorm' as const },
    get totalCalls() { return totalCalls },
  } as unknown as GPUFacade & { totalCalls: number }
}
