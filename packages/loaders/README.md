# @rune/loaders — интерфейс лоадеров

Ассеты: источник → планировщик → формат → кэш. Ноль GPU-кода: результаты —
типизированные массивы и `ImageBitmap`, которые одинаково принимает
WebGL2 (`texImage2DFromSource`) и WebGPU (`copyExternalImageToTexture`).

## Слои и имена

| Слой | Файл | Класс/функция |
|---|---|---|
| Планировщик | `scheduler.ts` | `LoadScheduler` |
| Источник | `source.ts` | `openByteSource`, `StreamAssembler` |
| GLB/glTF | `gltf.ts` | `parseGlb`, `parseGltfJson`, `looksLikeGlb` |
| OBJ | `obj.ts` | `parseObj`, `parseObjStream`, `ObjStreamParser` |
| MTL | `mtl.ts` | `parseMtl`, `parseMtlBytes` |
| FBX | `fbx.ts` | `parseFbx`, `looksLikeFbxBinary`, `looksLikeFbxAscii` |
| Картинки | `image.ts` | `parseImage`, `sniffMime` |
| Конфиги | `config.ts` | `parseZml`, `parseIni`, `parseConfig`, `registerConfigParser` |
| Пайпы | `pipes.ts` | `tap`, `bytesToText`, `splitLines`, `collect`… |
| Библиотека | `library.ts` | `AssetLibrary` |
| Легаси v0 | `compat.ts` | `loadImage`, `loadJSON`, `loadArrayBuffer` |

## Главный вход — AssetLibrary

```ts
const library = new AssetLibrary({
  scheduler: new LoadScheduler({ maxConcurrent: 2, maxBytesInFlight: 16 << 20 }),
  defaults: { retries: 1, connectTimeoutMs: 25_000 },
  cacheBytesLimit: 64 << 20, // LRU-вытеснение
})

// Загрузка одного ассета. Вход: url (строка). Выход: AssetHandle<T> —
// thenable (await даёт T) + progress/cancel/setPriority.
const handle = library.load<GltfModel>(url, {
  priority: 0,                    // меньше = раньше (default 5)
  parser: 'glb',                  // форсировать; иначе авто (расширение/магика)
  onProgress: p => uiBar(p.ratio),// снимок прогресса (см. AssetProgress)
  transform: [normalize],         // пост-парсинг цепочка (asset, meta) => asset
  signal, retries, weightBytes, noCache,
})
const model: GltfModel = await handle
handle.cancel('причина')          // bool: queued мгновенно, fetching — abort
handle.setPriority(1)             // bool: только пока queued

// Прелоад без результата (прогрев кэша).
const report = await library.preload([urlA, urlB], { parser: 'glb' })
report.ok   // AssetHandle[]
report.fail // { url, error }[]

// Группой: агрегатный взвешенный прогресс + общая отмена.
const group = library.loadGroup([urlA, urlB])
group.progress.ratio  // 0..1 по сумме весов
const all = await group.promise

// Свои форматы: имя парсера → функция.
library.registerFormat('scene-config', ['.zml', '.cfg'], async ctx => {
  await ctx.assembler.completion        // дождаться тела
  return parseZml(ctx.assembler.fullView())
})
// Теперь library.load(url, { parser: 'scene-config' }) — как любой встроенный.

library.stats()    // LibraryStats: cacheBytes, cacheHits, downloads…
library.clear()    // сброс кэша
library.on(e => …) // события: progress | done | error | cancelled | evicted
```

## Вход/выход парсеров — таблица

| Парсер (имя) | Вход | Выход |
|---|---|---|
| `parseGlb` | `StreamAssembler` (GLB-стрим) + `GltfParseOptions` | `Promise<GltfModel>` |
| `parseGltfJson` | `jsonText: string` + `GltfExternalSource` (внешние .bin/имаги) | `Promise<GltfModel>` |
| `parseObj` / `parseObjStream` | `Uint8Array` / `StreamAssembler` | `ObjModel` / `Promise<ObjModel>` |
| `parseMtl` / `parseMtlBytes` | текст MTL / `Uint8Array` | `MtlLibrary` (имя → `MtlMaterial`) |
| `parseFbx` | `Uint8Array` (бинарный FBX 7.x) | `Promise<FbxModel>` |
| `parseImage` | `StreamAssembler` + опции | `Promise<ImageAsset>` (`ImageBitmap`) |
| `parseZml` / `parseIni` | текст/байты | деревья `ZmlNode` / запись `Record<string, unknown>` |
| `sniffMime` | `Uint8Array` (магика) | mime-строка (вкл. `image/avif` по ftyp-box) |

Все парсеры принимают **байтовый стриминг**, а не готовый буфер целиком
(хотя готовый тоже можно):
- `parseGlb(assembler: StreamAssembler, opts?) → Promise<GltfModel>` —
  JSON-чанк разбирается до конца тела, геометрия — по готовности диапазонов
  BIN-чанка, имаги (PNG/WebP/**AVIF**) декодируются в `ImageBitmap` по мере
  прихода своих байт (`premultiplyAlpha:'none'` — детерминированный
  straight-alpha для MASK/BLEND); источник имаги резолвится и из расширений
  `EXT_texture_webp`/`EXT_texture_avif` (урок forest_house.glb).
  Интерливинговые float-аксессоры (byteStride) деинтерливятся
  fast-path'ом (Float32Array.set-строки вместо DataView-перебора).
- `parseGltfJson(jsonText, external: GltfExternalSource, opts?) → Promise<GltfModel>` —
  `.gltf` с внешними буферами/имагами (`external.loadExternal(uri)`).
- `parseObj(bytes: Uint8Array, opts?) → ObjModel` — разовый;
  `parseObjStream(assembler, opts?) → Promise<ObjModel>` — стриминговый
  (построчный, поразрядный разбор чисел; углы граней — Int32Array-пул
  без объектных аллокаций).
- `parseMtlBytes(bytes) → MtlLibrary` — Wavefront MTL: блоки `newmtl`,
  `Kd/Ka/Ks`, `Ns`, `d/Tr`, `map_Kd/map_Ks/bump` (опции `-s/-o` отбрасываются).
  Потребитель резолвит `map_Kd` через `new URL(path, mtlUrl)`.
- `parseFbx(bytes: Uint8Array, opts?) → Promise<FbxModel>` — бинарный FBX 7.x,
  zlib-массивы через `DecompressionStream('deflate')` (ПАРАЛЛЕЛЬНО,
  Promise.all), выровненные 'd'/'i' — zero-copy типизированные виды;
  меши + иерархия нод (Lcl Translation/Rotation/Scaling) + материалы
  (DiffuseColor).
  `opts.skipHeavyNodes` (default **true**): поддеревья, которых НЕТ в
  статическом выходе — анимации (`AnimationStack/Layer/CurveNode/Curve`),
  скины (`Deformer`), `NodeAttribute`, позы, встроенные медиа — скипаются
  целиком (прыжок на абсолютный endOffset): Samba Dancing.fbx — до 3×
  быстрее; `false` — полный обход (диагностика).
- `parseImage(assembler, opts?) → Promise<ImageAsset>` — PNG/JPEG/WebP/GIF/AVIF.

### Draco (KHR_draco_mesh_compression) — инъекция декодера

Движок НЕ тянет wasm-декодер: передайте его в опциях — где угодно
(напрямую в `GltfParseOptions.dracoDecoder` или в `new AssetLibrary({ dracoDecoder })`):

```ts
const library = new AssetLibrary({
  dracoDecoder: myWasmDracoDecoder, // (bytes, attributes) => Promise<DracoDecodedGeometry>
})
```

Контракт `DracoGeometryDecoder`: вход — байты сжатого `bufferView` и карта
`{ POSITION: id, NORMAL: id, TEXCOORD_0: id }` (uniqueId из расширения),
выход — `{ positions, normals, uvs, indices }` (типизированные массивы).
Без декодера Draco-файл падает честной ошибкой. Пример обвязки над
CDN `draco_wasm_wrapper.js` + `draco_decoder.wasm` — `packages/demo/src/models-demo.ts`.

`StreamAssembler` (вход стриминговых парсеров) собирает fetch-стрим в
буфер с watermark-доступом: `waitFor(minBytes)`, `onRange(cb)`,
`slice(from, len)`, `fullView()`, `completion` — парсер читает готовые
диапазоны, не дожидаясь всего тела.

## Форма результата

`GltfModel`: `meshes` (примитивы с `positions/normals/uvs: Float32Array`,
`indices: Uint16Array|Uint32Array|null`, `bounds`), `materials`
(baseColorFactor, факторы PBR, индексы текстур-имагей, doubleSided,
**alphaMode/alphaCutoff**, **unlit** — KHR_materials_unlit),
`images` (`bytes` + ленивый `bitmap: Promise<ImageBitmap>` + sampler),
`nodes` (TRS/matrix + children + mesh), `sceneRoots`, `stats`, `json`
(сырой glTF-JSON для экзотики). `ObjModel` — плоские развёрнутые массивы
(`positions/normals/uvs` на угол треугольника) + `groups` (диапазоны
вершин с материалами usemtl) + `mtllib`. `MtlLibrary` — `materials`
(`diffuse/ambient/specular/shininess/opacity/mapKd…`) + `get(name)`.
`FbxModel` — `meshes` + `nodes` (TRS, иерархия) + `materials`
(diffuse) + `roots`.

## Контракт

- Никакого GPU и DOM-канвасов: результат переживёт смену бэкенда.
- Отмена сквозная: `AbortSignal` → fetch abort → парсер stop.
- Прогресс иммутабелен (`AssetProgress`: phase, loaded/total, ratio, detail).
- Кэш по нормализованному URL; параллельные `load` одного URL дедупятся.
