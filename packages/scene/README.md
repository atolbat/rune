# @rune/scene

Максимально плоский data-oriented сценовый граф для rune: камеры,
фрустум-отсечение, инстанс-пакеты, РЕНДЕРАБЛЫ (Task 86: абстрактная
сущность «что рисовать» — рецепт меша + материал + пасс + политика,
сводимая к мешу резолвером) и вынос кадрового конвейера в воркер —
поверх ОДНОЙ раскладки памяти, общей для main и воркера.

## Дизайн в одном абзаце

Ни одного JS-объекта на узел в горячих путях: всё — плоские типизированные
массивы по слотам (SoA). Порядок обхода — preorder (`order[]`), поэтому
родитель всегда раньше ребёнка (один проход трансформов без рекурсии), а
поддерево — непрерывный диапазон рангов (`subtreeEnd[]`) — иерархический
culling режет/принимает поддеревья заливкой слов битсета. Грязь — u32-штампы
монотонных часов: покоящийся кадр ничего не пересчитывает. Сцена живёт либо в
ArrayBuffer (T0), либо в SharedArrayBuffer (T1/T2 — воркер) — горячие циклы
одни и те же (инвариант транспортов ядра, §7.2).

## Быстрый старт

```ts
import { createScene, createCamera, recommendSceneStrategy } from '@rune/scene'

const scene = createScene({ capacity: 100_000, groupMax: 4, maxInstances: 50_000 })

// Строим поле инстансов: кластер → 9 листьев группы 0.
for (let c = 0; c < 10_000; c++) {
  const root = scene.create({ position: [c % 100 * 60, 0, Math.floor(c / 100) * 60], sphere: [0, 0, 0, 26] })
  for (let k = 0; k < 9; k++) {
    scene.create({ parent: root, position: [/* … */], sphere: [0, 0, 0, 0.8], group: 0 })
  }
}

const cam = createCamera()
cam.setPerspective(Math.PI / 3, aspect, 0.1, 1000)
cam.setViewLookAt(eyeX, eyeY, eyeZ, 0, 0, 0, 0, 1, 0)

// Кадр (T0, весь конвейер в main):
scene.updateWorld()            // грязевые штампы — покой бесплатен
scene.refitGroupBounds()       // авто-границы внутренних узлов
scene.cull([cam])              // битсет видимости (иерархический)
scene.collectInstances(0)      // матрицы видимых инстансов группы 0
const { matrices, count } = scene.instances(0)
// matrices: Float32Array(count*16) — готовый instance-атрибут
// (4 колонки vec4, stride 64 байта, divisor 1 — rendererFeed/batchCommand).

scene.forEachVisible(0, (slot) => {
  const myObject = myTable[scene.views.payload[slot]]
  // рисуем myObject с scene.worldMatrix(slot)
})
```

## Воркер (T1/T2)

```ts
// main.ts
const scene = createScene({ capacity: 100_000, shared: true })
const worker = new Worker(new URL('./scene.worker.ts', import.meta.url))
const bridge = createSceneWorkerBridge({ scene, worker: myPortAdapter(worker) })
await bridge.ready

// Кадр: опубликовали ввод → main свободен → взяли согласованный снимок.
bridge.publish([cam])          // ~микросекунды
// …рендер предыдущего снимка, GPU-сабмиты…
const snap = bridge.take()     // bits + instances (копии, без tearing)
```

```ts
// scene.worker.ts (воркер)
import { runSceneWorker } from '@rune/scene'
self.onmessage = (e) => { if (e.data.type === 'scene-init') {
  postMessage({ type: 'scene-ready' })
  runSceneWorker(e.data.sab)   // блокирующий цикл на Atomics.wait
} }
```

Протокол честности кадра: main пишет только до `inputEpoch++`; воркер читает
только после пробуждения; main читает битсеты/пулы только после `outputEpoch`.
Битсеты и инстанс-пулы двойные (`epoch & 1`) — tearing исключён; `take()`
никогда не блокирует (несвежий кадр → снимок предыдущей эпохи, латентность +1
кадр).

## Измеренные цифры (bench.ts, bun 1.3.14, контейнер 4 ядра)

| Что | Результат |
|---|---|
| updateWorld, покой (0% анимации) | 0.5 мс на 100k узлов (5 нс/узел) |
| updateWorld, полная анимация | 16.4 мс на 100k (160 нс/аним. узел) |
| cull иерархический vs brute | 2× на 100k, 4.5× на 1M узлов |
| cull 1M узлов | 2.0–2.6 мс (иерархический) |
| компакция инстансов | 0.8 мс / 10k видимых, 1.3 мс / 100k |
| pack (структурная правка) | 0.07 мс / 10k, 0.77 мс / 100k |
| мост publish+take | ≈1 мкс (медиана) |
| воркер: латентность publish→fresh | 1.3–2 мс (≤100k), ~12 мс (1M) |
| воркер: оверлап за 3 мс main-работы | 90% свежих кадров (≤100k), 0% (1M) |

**Честный вывод:** воркер — не про латентность (конвейер в потоке ≈2.5×
медленнее + пробуждение), а про освобождение main-времени. Порог —
`recommendSceneStrategy()`: конвейер ≥1 мс И воркер успевает в бюджет кадра.
На покоящихся сценах до ~200k узлов локальный конвейер дешевле синхронизации.

## Контракт границ

* Локальная сфера узла (`setSphereLocal`) обязана охватывать геометрию узла;
  у ВНУТРЕННЕГО узла сфера обязана охватывать поддерево (или оставьте r≤0 —
  refit посчитает сам, снизу вверх, каждый кадр).
* Внутренний узел без границ (r≤0) никогда не отсекается/принимается
  тривиально — только спуск: безопасность по построению.
* Бит видимости узла = тест его СОБСТВЕННОЙ сферы (побитовый паритет с brute
  на корректных границах — property-тест на 40 случайных сценах).
* GPU-driven culling (compute + indirect) НЕ заявлен: у движка нет этих путей
  исполнения (Контракт 5). Дизайн оставляет шов: битсеты/пул — те же буферы,
  что потреблял бы compute-проход.

## API

`createScene(options)` · `createSceneFromBuffer(buffer)` · `createCamera()` ·
`runSceneWorker(sab)` · `runScenePipeline(views, bufferIndex)` ·
`createSceneWorkerBridge({ scene, worker })` ·
`recommendSceneStrategy(inputs)` / `estimatePipelineMs(inputs)` /
`measureScenePipeline(scene, cameras)` ·
`cullViewsHierarchical/cullViewsBrute` · `collectInstancesViews` /
`collectGroupMatrices` · `extractFrustumPlanes` / `classifySphere` ·
`updateWorldViews` / `updateWorldForcedViews` / `refitGroupBoundsViews`.

Смотрите `src/*.ts` — каждый файл открывается манифестом своего контракта.
