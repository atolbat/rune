# @rune/loaders — loader interface

Assets: source → scheduler → format → cache. Zero GPU code: the results are
typed arrays and `ImageBitmap`, which both WebGL2 (`texImage2DFromSource`)
and WebGPU (`copyExternalImageToTexture`) accept.

## Layers and names

| Layer | File | Class/function |
|---|---|---|
| Scheduler | `scheduler.ts` | `LoadScheduler` |
| Source | `source.ts` | `openByteSource`, `StreamAssembler` |
| GLB/glTF | `gltf.ts` | `parseGlb`, `parseGltfJson`, `looksLikeGlb` |
| OBJ | `obj.ts` | `parseObj`, `parseObjStream`, `ObjStreamParser` |
| MTL | `mtl.ts` | `parseMtl`, `parseMtlBytes` |
| FBX | `fbx.ts` | `parseFbx`, `looksLikeFbxBinary`, `looksLikeFbxAscii` |
| Images | `image.ts` | `parseImage`, `sniffMime` |
| Configs | `config.ts` | `parseZml`, `parseIni`, `parseConfig`, `registerConfigParser` |
| Pipes | `pipes.ts` | `tap`, `bytesToText`, `splitLines`, `collect`… |
| Library | `library.ts` | `AssetLibrary` |
| Legacy v0 | `compat.ts` | `loadImage`, `loadJSON`, `loadArrayBuffer` |

## Main entry — AssetLibrary

```ts
const library = new AssetLibrary({
  scheduler: new LoadScheduler({ maxConcurrent: 2, maxBytesInFlight: 16 << 20 }),
  defaults: { retries: 1, connectTimeoutMs: 25_000 },
  cacheBytesLimit: 64 << 20, // LRU eviction
})

// Load a single asset. Input: url (string). Output: AssetHandle<T> —
// thenable (await gives T) + progress/cancel/setPriority.
const handle = library.load<GltfModel>(url, {
  priority: 0,                    // lower = earlier (default 5)
  parser: 'glb',                  // force; otherwise auto (extension/magic)
  onProgress: p => uiBar(p.ratio),// progress snapshot (see AssetProgress)
  transform: [normalize],         // post-parse chain (asset, meta) => asset
  signal, retries, weightBytes, noCache,
})
const model: GltfModel = await handle
handle.cancel('reason')          // bool: queued instantly, fetching — abort
handle.setPriority(1)             // bool: only while queued

// Preload without a result (cache warm-up).
const report = await library.preload([urlA, urlB], { parser: 'glb' })
report.ok   // AssetHandle[]
report.fail // { url, error }[]

// As a group: aggregate weighted progress + shared cancellation.
const group = library.loadGroup([urlA, urlB])
group.progress.ratio  // 0..1 by sum of weights
const all = await group.promise

// Custom formats: parser name → function.
library.registerFormat('scene-config', ['.zml', '.cfg'], async ctx => {
  await ctx.assembler.completion        // wait for the body
  return parseZml(ctx.assembler.fullView())
})
// Now library.load(url, { parser: 'scene-config' }) — like any built-in.

library.stats()    // LibraryStats: cacheBytes, cacheHits, downloads…
library.clear()    // cache reset
library.on(e => …) // events: progress | done | error | cancelled | evicted
```

## Parser input/output — table

| Parser (name) | Input | Output |
|---|---|---|
| `parseGlb` | `StreamAssembler` (GLB stream) + `GltfParseOptions` | `Promise<GltfModel>` |
| `parseGltfJson` | `jsonText: string` + `GltfExternalSource` (external .bin/images) | `Promise<GltfModel>` |
| `parseObj` / `parseObjStream` | `Uint8Array` / `StreamAssembler` | `ObjModel` / `Promise<ObjModel>` |
| `parseMtl` / `parseMtlBytes` | MTL text / `Uint8Array` | `MtlLibrary` (name → `MtlMaterial`) |
| `parseFbx` | `Uint8Array` (binary FBX 7.x) | `Promise<FbxModel>` |
| `parseImage` | `StreamAssembler` + options | `Promise<ImageAsset>` (`ImageBitmap`) |
| `parseZml` / `parseIni` | text/bytes | `ZmlNode` trees / `Record<string, unknown>` entry |
| `sniffMime` | `Uint8Array` (magic) | mime string (incl. `image/avif` by ftyp-box) |

All parsers accept **byte streaming**, not a ready-made whole buffer
(though a complete buffer works too):
- `parseGlb(assembler: StreamAssembler, opts?) → Promise<GltfModel>` —
  the JSON chunk is parsed once the body has fully arrived, geometry as
  BIN-chunk ranges become ready, images (PNG/WebP/**AVIF**) are decoded
  into `ImageBitmap` as their bytes arrive (`premultiplyAlpha:'none'` —
  deterministic straight-alpha for MASK/BLEND); the image source is also
  resolved from the `EXT_texture_webp`/`EXT_texture_avif` extensions
  (forest_house.glb lesson). Interleaved float accessors (byteStride) are
  de-interleaved via a fast path (Float32Array.set rows instead of
  DataView iteration).
- `parseGltfJson(jsonText, external: GltfExternalSource, opts?) → Promise<GltfModel>` —
  `.gltf` with external buffers/images (`external.loadExternal(uri)`).
- `parseObj(bytes: Uint8Array, opts?) → ObjModel` — one-shot;
  `parseObjStream(assembler, opts?) → Promise<ObjModel>` — streaming
  (line-by-line, digit-by-digit number parsing; face corners use an
  Int32Array pool without object allocations).
- `parseMtlBytes(bytes) → MtlLibrary` — Wavefront MTL: `newmtl` blocks,
  `Kd/Ka/Ks`, `Ns`, `d/Tr`, `map_Kd/map_Ks/bump` (`-s/-o` options are
  discarded). The consumer resolves `map_Kd` via `new URL(path, mtlUrl)`.
- `parseFbx(bytes: Uint8Array, opts?) → Promise<FbxModel>` — binary FBX 7.x,
  zlib arrays via `DecompressionStream('deflate')` (in PARALLEL,
  Promise.all), aligned 'd'/'i' — zero-copy typed views;
  meshes + node hierarchy (Lcl Translation/Rotation/Scaling) + materials
  (DiffuseColor).
  `opts.skipHeavyNodes` (default **true**): subtrees that are NOT in the
  static output — animations (`AnimationStack/Layer/CurveNode/Curve`),
  skins (`Deformer`), `NodeAttribute`, poses, embedded media — are skipped
  entirely (jump to the absolute endOffset): Samba Dancing.fbx — up to 3×
  faster; `false` — full traversal (diagnostics).
- `parseImage(assembler, opts?) → Promise<ImageAsset>` — PNG/JPEG/WebP/GIF/AVIF.

### Draco (KHR_draco_mesh_compression) — decoder injection

The engine does NOT bundle a wasm decoder: pass it in the options — anywhere
(directly in `GltfParseOptions.dracoDecoder` or in `new AssetLibrary({ dracoDecoder })`):

```ts
const library = new AssetLibrary({
  dracoDecoder: myWasmDracoDecoder, // (bytes, attributes) => Promise<DracoDecodedGeometry>
})
```

The `DracoGeometryDecoder` contract: input — compressed `bufferView` bytes and
the `{ POSITION: id, NORMAL: id, TEXCOORD_0: id }` map (uniqueId from the
extension), output — `{ positions, normals, uvs, indices }` (typed arrays).
Without a decoder, a Draco file fails with an honest error. An example
wrapper over the CDN `draco_wasm_wrapper.js` + `draco_decoder.wasm` —
`packages/demo/src/models-demo.ts`.

`StreamAssembler` (the input of streaming parsers) assembles the fetch stream
into a buffer with watermark access: `waitFor(minBytes)`, `onRange(cb)`,
`slice(from, len)`, `fullView()`, `completion` — the parser reads ready
ranges without waiting for the whole body.

## Result shape

`GltfModel`: `meshes` (primitives with `positions/normals/uvs: Float32Array`,
`indices: Uint16Array|Uint32Array|null`, `bounds`), `materials`
(baseColorFactor, PBR factors, texture image indices, doubleSided,
**alphaMode/alphaCutoff**, **unlit** — KHR_materials_unlit),
`images` (`bytes` + lazy `bitmap: Promise<ImageBitmap>` + sampler),
`nodes` (TRS/matrix + children + mesh), `sceneRoots`, `stats`, `json`
(raw glTF-JSON for exotic cases). `ObjModel` — flat expanded arrays
(`positions/normals/uvs` per triangle corner) + `groups` (vertex ranges
with usemtl materials) + `mtllib`. `MtlLibrary` — `materials`
(`diffuse/ambient/specular/shininess/opacity/mapKd…`) + `get(name)`.
`FbxModel` — `meshes` + `nodes` (TRS, hierarchy) + `materials`
(diffuse) + `roots`.

## Contract

- No GPU or DOM canvases: the result survives a backend switch.
- Cancellation is end-to-end: `AbortSignal` → fetch abort → parser stop.
- Progress is immutable (`AssetProgress`: phase, loaded/total, ratio, detail).
- Cache keyed by normalized URL; parallel `load`s of the same URL are deduplicated.
