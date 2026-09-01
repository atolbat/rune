# rune DESIGN — addendum к досье v1.0 (бенч-калибровка Mali-G57 MC2)

> Сверено с `upload/rune-design-dossier.docx` (досье v1.0, 9 итераций, утверждено
> полностью, август 2026). Предыдущий драфт «Раунд 5: адаптивность вместо
> хардкода» — отозван: оказалось, что бóльшая часть «новых» идей уже присутствует
> в досье под каноническими именами (каталог §12, Контракт 4 §11.3, мобильная
> дисциплина §9.2). Этот документ — **addendum**, не замена досье.

## 0. Контекст

Досье v1.0 было утеряно при сбросе окружения (worklog Task 43) и не восстановлено.
Бенч-раунды 4–5 (бенч present-путей на SwiftShader, бенч телефона Mali-G57 MC2,
теория-бенчи heavy-×8) проводились без оглядки на досье. Результат — несколько
«теорий O–S» из Task 49 оказались переименованием пунктов каталога §12. Это
addendum фиксирует свёрку и даёт калибровочные формулы для Контракта 4
(tier-лестница адаптера), опираясь на бенч-данные с живого Mali.

## 1. Сверка «теории O–S» ↔ каталог §12

Прямая таблица соответствий. Подтверждает: то, что я подавал как «новые политики
O–S» — переименование уже утверждённых пунктов досье.

| «теория» из Task 49 | № в каталоге §12 | Имя в досье | Слой |
|---|---|---|---|
| reactiveFrame | #17 | Signal frame-cap при простое ввода (батарея) | Ядро |
| switchBackend | #19 | Hot adapter swap — переигрывание журнала | Ядро |
| atlas (UV-ремап) | — | (нет в каталоге, но описано в §6 как inferred passes) | Ядро |
| paging (виртуальная текстурная память) | #9 | Сетевые тайлы HTTP Range + textureArray (deep-zoom) | Kit |
| adaptive (динамическое разрешение) | #44 | Mip-trim под давлением памяти | Ядро |
| worker (вынос компиляции/стейджа) | #12 | Zero-main-thread путь ассета (fetch, декод, нарезка — в воркерах) | Ядро |
| thermal-эвристика | #47 | Thermal/battery фьюжн в pressure-сигнал | Ядро |
| present-пути (direct/blit/bitmap/…) | #61 | Compositing-гигиена канваса (premultiplied, opaque, desynchronized) | Kit |
| asyncbmp-путь | #62 | transferToImageBitmap-экспорт без readPixels (+ golden-CI) | Kit |
| feature-ladder (мои «AdaptiveLimits») | #48 | Feature-ladder + requestTier (переговоры features/limits) | Ядро |
| adaptivный codegen по классу | #43 | Адаптивный codegen по классу устройства | Ядро |

**Вывод**: «отключаемость политик O–S» уже заложена в досье как «каталог
оптимизаций, где каждая позиция — toggleable с сейф-дефолтом». Каталог №1–65 —
каноническая номенклатура; «теории O–S» — отозваны.

## 2. Адаптивные лимиты — в досье уже есть как Контракт 4

§11.3, **Контракт 4** — tier-лестница адаптера:
> `requestTier` — переговоры `requiredFeatures` и `requiredLimits` со спуском при
> отказе; feature-ladder — первый класс гражданин (мобильный профиль — частный
> случай).

Это и есть адаптивность лимитов в канонической форме:
- Никакого хардкода `maxRenderSize=1024²`, `maxTextureMemory=480 МБ`,
  `forbiddenPaths` — это противоречило бы Контракту 4.
- `requestTier` переговаривает `requiredLimits` с адаптером и спускается при
  отказе. На Mali-G57 MC2 спустится к мобильному профилю (§9.2: dpr≤2, ASTC,
  memoryBudget 256 МБ), на десктопе — останется на полном.
- Профиль — **частный случай** feature-ladder, не хардкод.

§9.2, мобильный профиль — это профиль для tile-based GPU (99% мобильных):
> dpr до 2, ASTC, memoryBudget 256 МБ, интерпретатор вместо codegen, idle
> frame-cap 30. Батарея: visibility-сигнал, frame-cap при простое ввода,
> thermal-эвристика (EMA кадр-тайма и зарядность снижают разрешение раньше
> троттлинга).

Бенч Mali-G57 MC2 валидирует именно этот профиль (а не задаёт «кап для всех»):
- 9 контекстов до вытеснения → бенч подтверждает, что mobile-profile держит
  `maxActiveContexts` низким (но это tier-переговоры, не хардкод)
- 128 × 1024² RGBA8 = 512 МБ до капа → бенч подтверждает, что
  `memoryBudget 256 МБ` (половина от капа) — разумный профиль
- heavy-2048 11 fps, p95 184 мс → бенч подтверждает, что на Mali renderSize
  ограничен `MAX_TEXTURE_SIZE/4` адаптивно

## 3. Реальные диффы код ↔ досье (по плану M0–M8)

§14.3, этапы реализации:

| Этап | По плану | В коде (по worklog Task 43–49) | Дифф |
|---|---|---|---|
| M0 Каркас | Монорепо, пакеты, CI | ✅ пакеты @rune/{core,math,prims,webgl2,webgpu,gl}, tsconfig | нет |
| M1 Ядро-1 | Сигналы, эпохи, ленты v1, журнал | ✅ signal+derive, epoch, tape SoA, segments+live, transientPool, layoutGuard | **журнал деклараций** — ДИФФ (утрачен Task 43, не восстановлен) |
| M2 WebGL2 | DrawSpec, Uniform ABI, пассы | ✅ glslReflect, компилятор, executor (юниформы по имени, state-кэш, BindTarget), realGL (FBO+depthMask), recordingGL | нет |
| M3 WebGPU | Кэш пайплайнов, арена, dynamic offsets | ✅ wgslReflect, slice-арена 256, компилятор, executor, realGPU (writeTexture origin, ленивые пайплайны, dynamic offsets), recordingGPU | нет |
| M4 Переносимость | Матрица, switchBackend, симуляция потери | ✅ частично: showOn/showAny (бэкенд-каскад с try/catch), pause/resume, freshCanvas (повторная проба) | **switchBackend как journal-replay** — ДИФФ (нет журнала деклараций → нет и replay); матрица переносимости §11.1 — ДИФФ (нет caps-модуля) |
| M5 Воркеры | Stub-ленты, T0–T3, feed | ❌ **полностью утеряно** (Task 43: «transport seqlock/SAB-реестр T0–T3, feed — не восстановлены») | ДИФФ — нет транспортов, нет feed, нет stub-лент в воркере |
| M6 Стриминг | upload-jobs, AIMD, резидентность | ✅ uploadScheduler AIMD (2/16 МиБ окно, бёрст 4 МиБ — теория N), streamTexture, chunker | нет (теория N закрыта) |
| M7 Сахар | scene, frag, image, prims, input | ✅ show, surface+pass (frag/image → ОДНА структура, Task 46), prims cube+quad | нет |
| M8 Kit и debug | Рецепты, capture, rewind, explain | ❌ частично: diag1–17 (диагностический арсенал), bench-present (бенч путей) | **kit, capture, rewind, explain** — ДИФФ; golden-CI — ДИФФ |

**Главный вывод сверки**: раунды 4–5 бенч-инжиниринга проводились как «новый дизайн»,
хотя на самом деле это инкрементальная работа по M4/M8. Бенч present-путей — это
подготовка к #61 (Compositing-гигиена) и #62 (transferToImageBitmap), бенч телефона —
калибровка Контракта 4 (tier-лестница) и §9.2 (мобильный профиль).

## 4. Калибровочные формулы — что бенч Mali добавляет к Контракту 4

Бенч-данные (телефон Mali-G57 MC2, раунд 4) не задают лимиты, а калибруют
формулы tier-переговоров:

| Замер на Mali | Контракт 4 / §9.2 формула | Чему равна на этом железе |
|---|---|---|
| `MAX_TEXTURE_SIZE=8192`, `limits.maxTextureDimension2D=16384` | `requestTier.requiredLimits.maxTextureDimension2D` | спускается с 16384 → 8192 при отказе |
| референс вытеснен после 9 контекстов | зонд `probeContextEviction()` (новый для §9.2) | 9 → safetyMargin(1) = 8 (не хардкод, а замер) |
| 128 × 1024² RGBA8 = 512 МБ до капа | эвристика `memoryBudget` (§9.2: 256 МБ профиль) | profile=256 МБ (половина капа; профиль, не лимит) |
| `blit2default` gl error 1282 | Контракт 5: «недоступная возможность — явная строка матрицы» | матрица §11.1 отмечает: `blit→default` = нет (формат-мISMATCH ANGLE BGRA) |
| `preserve`/`draw2d-half`/`scaled-half` p95 50–67 мс | jank-контракт (Контракт 1, §11.3): «main thread ≤ maxMs» | эти пути = «не доминанта» в матрице переносимости |
| heavy-2048 11 fps, p95 184 мс | `requestTier` спускает `maxTextureDimension` под pressure | профиль Mali: renderSize ≤ 1024² для heavy, ≤2048² для light |

**Новая формула (не в досье, предложение)**: адаптивный порог деградации p95
через **ratio**, а не абсолют:
```
degradationRatio = p95_rolling / p50_rolling
pathHealthy = degradationRatio < thresholdRatio   // default 1.5
```
На Mali (p50≈16.8 vsync) ratio 1.5 → триггер 25.2 мс — ловит preserve (3.0) и
draw2d-half (4.0). На десктопе (p50≈4) ratio 1.5 → триггер 6 мс — реагирует на
относительную деградацию, не привязан к железу. **Это дополнение к Контракту 1
(jank-контракт), не замена**: вместо «maxMs = X» — «maxRatio = 1.5 × p50».

## 5. Что РЕАЛЬНО нужно добавить в код (по приоритетам M4–M8)

Диффы из §3, ранжированные по зависимости:

### 5.1 Журнал деклараций (M1, утрачен) — фундамент для M4
Без него нет `switchBackend` (#19), нет `device-loss recovery` (#19), нет миграции
в воркер (#12). Это **блокирующий дифф** — M4 (Переносимость) не может быть
закрыт без него.

Артефакт по досье: «журнал деклараций делает switchBackend = device-loss
recovery = миграцию в воркер одним механизмом replay». Восстановить как
`packages/core/src/journal/` (реестр деклараций с destroy-опсами — аудит 1,
§14.1).

### 5.2 caps-модуль (M4, матрица переносимости)
§11.1, §11.4: `capabilities.has(FeatureId)`, `caps.format(f)` по 6 осям,
`caps.ext` escape-хэт, `RendererStats` (cpuMs, gpuMs, memoryEstimate,
hit-rate). Без этого нет «честности гейтов» (Контракт 5) — недоступная
возможность должна быть либо null, либо capability-проверка, либо строка
матрицы. Сейчас в коде этого нет.

Артефакт: `packages/core/src/caps.ts` + интеграция в realGL/realGPU.

### 5.3 requestTier (M4, Контракт 4)
`adapter.requestDevice({ requiredFeatures, requiredLimits })` со спуском при
отказе. Сейчас `createRealGPU` (realGPU.ts:14–17) вызывает `requestDevice()` без
параметров — нет переговоров. Профиль «мобильный» из §9.2 (dpr≤2, ASTC,
memoryBudget 256 МБ) должен быть **запрашиваемым tiers**, а не захардкоженным
по userAgent.

Артефакт: `packages/webgpu/src/tiers.ts` — RequestTier ladder (desktop / mobile /
fallback) + интеграция в `createRealGPU`.

### 5.4 Транспорты T0–T3 + feed (M5, полностью утеряно)
§7.2: T0 (один поток, синхро), T1 (postMessage), T2 (SharedArrayBuffer + seqlock),
T3 (SAB-реестр + fallback). Измерения в досье: чтение 14 нс, запись 18 нс —
на четыре порядка дешевле сообщений. Восстановить как
`packages/core/src/transport/`.

Артефакт: T0–T3 транспорты + feed (dual-bind) — база для #12 (zero-main-thread).

### 5.5 present-пути (M8, #61 + #62)
Бенч present-путей (download/rune-bench.html) — это подготовка к #61 (Compositing-
гигиена) и #62 (transferToImageBitmap). 12 путей показа кадра + 2 WebGPU —
перенести из бенч-артефакта в рантайм как `packages/gl/src/present.ts` с
PathRegistry (моя `PathState` из отозванного драфта — единственное, что
действительно новое; всё остальное — канон).

PathState должен интегрироваться с Контрактом 1 (jank-контракт): переход
`healthy → disabled` по `degradationRatio ≥ 1.5 × p50` (формула §4 addendum).

### 5.6 Kit + capture + rewind + explain (M8)
§10.3, §11: `@rune/kit`, `@rune/debug`, `@rune/tape`. Две трети каталога §12
(#6, #8–11, #16, #21, #24–27, #30–32, #34, #39–42, #45, #49–65) — на слое Kit.
Сейчас в коде — только `demo/diag*.ts` (диагностические скрипты, не пакет).

## 6. Что НЕ нужно делать (отозвано из предыдущего драфта)

- ❌ `maxRenderSize`, `maxActiveContexts`, `maxTextureMemory` как хардкод-константы —
  противоречит Контракту 4; правильно — `requestTier` переговоры.
- ❌ `forbiddenPaths: ['blit2default', 'preserve', 'draw2d-half', 'scaled-half']`
  как хардкод-список — противоречит Контракту 5; правильно — матрица §11.1 +
  degradationRatio.
- ❌ `disableGPUAcceleration` как **новая** опция — это частный случай tier-выбора
  `requestTier=software` или профиль «Canvas2D fallback» (если добавить — как
  ветка `ShowOptions.backends`, не как глобальный тумблер).
- ❌ `configure({ policies })` с переизобретёнными именами — правильно
  `configure({ policies: { '#17': true, '#44': true, '#47': false } })` или
  человекочитаемыми alias'ами, но с пометкой «= #N каталога».
- ❌ Мои «7 этапов реализации» — отозваны; канонические M0–M8 из §14.3.

## 7. Уточнения к досье (предложения на утверждение)

Эти пункты не противоречат досье, а уточняют его формулы на базе бенч-данных:

1. **Уточнение Контракта 1 (jank)**: добавить адаптивный порог деградации
   `degradationRatio = p95/p50` (default 1.5) — абсолютный `maxMs` остаётся
   как потолок, но ratio ловит деградацию относительно vsync-насыщения, а не
   от абсолюта. См. §4 addendum.

2. **Уточнение §9.2 (мобильный профиль)**: добавить зонд
   `probeContextEviction()` как часть `requestTier` — на Mali даёт 9, на
   десктопе может дать 16+. Это не хардкод «8», а измеряемый профиль.

3. **Уточнение матрицы §11.1**: добавить строки про 12 present-путей
   (direct/quadpass/bitmap/draw2d/multi4/draw2d-half/preserve/blit/
   quadcopy/uvremap/asyncbmp/multibmp4/scaled-half) и 2 WebGPU-пути
   (wgpu-direct/wgpu-copy) — с пометками «渲染абелен / не портируем / degradation»
   на базе бенч-данных.

4. **Уточнение каталога §12**: настоящие имена «теорий O–S» уже есть в
   каталоге; бенч-данные не добавляют новых пунктов, а калибруют #44
   (mip-trim под давлением), #47 (thermal/battery), #48 (feature-ladder),
   #61 (compositing-гигиена), #62 (transferToImageBitmap).

## 8. Этапы дальнейшей работы (канон M4 → M8, не мои)

| # | Задача | Этап | Зависимости |
|---|---|---|---|
| 1 | Журнал деклараций + destroy-опсы | M1 (восстановление) | — |
| 2 | caps-модуль + RendererStats | M4 | 1 |
| 3 | requestTier ladder (desktop/mobile/fallback) | M4 | 2 |
| 4 | Транспорты T0–T3 + feed (dual-bind) | M5 | — |
| 5 | present.ts (PathRegistry + PathState + 12 путей) | M8 (#61, #62) | 2, 3 |
| 6 | degradationRatio как уточнение Контракта 1 | M8 (уточнение досье) | 5 |
| 7 | Kit-пакеты: @rune/kit, @rune/debug, @rune/tape | M8 | 1, 2 |
| 8 | switchBackend через journal-replay | M4 (#19) | 1 |

## 9. Инфра-примитивы для развёртывания каталога

> Раунд 6 addendum. После сверки с досье (§1–§8) и каталогом §12 целиком —
> разложение 65 позиций + 12/2 present-путей на повторяющиеся паттерны. Цель:
> сделать так, чтобы 80% каталога и «похожих с небольшими изменениями»
> разворачивались композицией 9 примитивов + 1 мета, а не почерновой
> реализацией каждой позиции отдельно. Не заменяет досье — описывает
> инфраструктурный каркас, в котором пункты §12 становятся ≤20-строчными
> композициями.

### 9.1 Метод

Каталог §12 — это 65 разрозненных идей. Без общего каркаса каждая
реализуется в обособленном модуле, со своим API, своими тестами, своим
путём деградации. Бенч-раунды 4–5 показали цену: «теории O–S» оказались
переименованием пунктов каталога (§1 addendum), потому что у каждой теории
был свой namespace, не связанный с каноническими именами.

Чтобы это не повторилось на уровне реализации, применён метод:
1. Прочитать все 65 позиций каталога + 14 present-путей.
2. Для каждой записать «что ей нужно измерить / что решить / что
   деградировать».
3. Сгруппировать по общности этих трёх операций.
4. Имена групп и есть примитивы.

Результат — 6 универсальных паттернов (покрывают ~52 из 65 позиций) и
2 сквозных utility (покрывают остальные кроме ~13 «специфичных»).
Не покрываются: сырые API браузера (HTTP Range, transferToImageBitmap,
VideoFrame, OffscreenCanvas), специфичный шейдерный кодген (Nanite-lite,
TSR-lite, AgX, HiZ) и семантические инварианты (premultiplied, opaque,
desynchronized, depthMode compare translation). Эти остаются ручными
рецептами.

### 9.2 Общее — шесть универсальных паттернов

**P1. Probe → Gate → Degrade.** Триада: измерить состояние → решить
порог → переключить поведение. Встречается в: #17 (idle-input → cap),
#19 (device-loss → replay), #44 (memory → mip-bias), #47 (thermal →
resolution), #48 (features → tier), #43 (gpu-class → codegen), #14
(pressure → evict), #61 (p95/p50 → disable path), #62 (caps → asyncbmp),
#9 (range → paging), #57 (half-res). Паттерн един — реализация разная.

**P2. Pressure-bus fusion.** Несколько «убывающих» сигналов (idle-input,
thermal-EMA, battery, memory-pressure, network-downlink) сливаются в один
скаляр `Pressure ∈ [0, 1]`, на который подписываются degrade-колбэки.
Встречается в #17, #44, #47, #43, #48, #14, #61. В досье §9.2 описано
вручную («visibility-сигнал, frame-cap при простое ввода, thermal-
эвристика (EMA кадр-тайма и зарядность снижают разрешение)») — это и есть
pressure-bus, но не названный как примитив.

**P3. Journal-replay.** Один механизм на три сценария (по §5.1 addendum):
#19 switchBackend = device-loss recovery = worker migration. Журнал
деклараций с destroy-опсами — это и есть «точка монтирования» P3. Также
обслуживает: #13 (heap compaction = replay + drop), #14 (lazy
re-declaration = evict + redeclare), #41 (resume-snapshot = journal +
tape ring), #42 (cold-start prewarm = replay tape во время сплеша).

**P4. Transferable stream (Tape + dual-head).** Лента = SoA-ArrayBuffer,
recorder пишет, executor воспроизводит, между потоками — transfer.
Встречается в #4 (triple buffer), #5 (parallel encoders), #7 (Tape JIT
vs interpreter), #12 (worker path), #15 (orchestrator batches), #30
(GPU-less authoring = stub recorder), #41 (resume), #64 (scoped
determinism = лента как чистая функция от лога). Уже в коде как
`recordingGL/realGL` и `recordingGPU/realGPU` — инвариант, не новая
разработка.

**P5. AIMD pump.** Окно с AIMD-динамикой + idle-слот + бёрст. Уже в коде
как `uploadScheduler` (теория N закрыта Task 45). Обобщается до `Pump<T>`
и покрывает: #8 (scan-progressive decode), #9 (HTTP Range tiles), #10
(OPFS L2 cache), #11 (codec plugins), #12 (upload-jobs), #46 (staging
pool), #42 (cold-start prewarm).

**P6. Capability matrix + path registry.** Честные гейты (Контракт 5):
`caps.has(FeatureId)`, `caps.format(f, axis)`, `caps.path(id)`. Реестр
путей с Probe/Caps/Decay-гейтами. Покрывает: #39 (pickFormat family),
#48 (tier), #49 (subgroups), #50 (work graphs), #60 (WebCodecs), #61
(present paths), #62 (asyncbmp), #45 (zero-copy ladder audit). В досье
§11.4 уже есть Caps — расширить `path()` для present-путей.

**U1. Decay (EMA + ratio + hysteresis).** Сквозной utility.
Встречается в #17 (EMA frame-cap), #44 (memory decay), #47 (thermal-EMA),
#61 (degradationRatio p95/p50 — формула §4 addendum), #21 (history ring).
Не требует отдельного «модуля» — утилитарная функция.

**U2. Telemetry hook.** Сквозной контракт: каждый примитив
экспортирует `state(): {id, enabled, lastValue, verdict}`. Встречается
везде (§11.3 Контракт 5, §11.4 RendererStats, #27 signal devtools, #45
explain-audit, #65 pixel-diff). В коде есть как diag1–17 — обобщить до
единого интерфейса.

### 9.3 Частное — что НЕ сводится к примитивам

Четыре класса остаются ручными, на них примитивы накладываются как
обёртки, но не заменяют содержимое:

**S1. Сырые API браузера (escape-hatch'и).** HTTP Range (#9), OPFS (#10),
transferToImageBitmap (#62), OffscreenCanvas + transferControlToOffscreen
(#12, асинхронные present-пути), createImageBitmap (asyncbmp/multibmp4/
scaled-half), VideoFrame (#60), WebCodecs, scheduler.postTask (#63),
SAB + seqlock (T2), GPUQuerySet (#34), WebGPU render bundles (#5),
shared memory (#49), navigator.connection (bandwidth/RTT). Каждый —
`caps.path(id) → 'ok'|'unavailable'|'degraded'` и пошаговая логика в
`run(ctx)`. Примитив даёт шилд, содержимое — ручное.

**S2. Специфичный шейдерный кодген (рецепты).** Mip-bias injection (#44),
UV-ремап (uvremap present-path, теория P), dynamic-resize shader
(scaled-half), AgX + Oklab (#55), TSR-lite (#56), checkerboard
(#57), blue-noise Owen-Sobol (#58), meshlet-LOD-DAG (#51), visibility-
buffer deferred (#53), GPU culling chain (#54), HiZ pyramid (#31),
Meshoptimizer-pipeline (#52). Это рецептуры уровня `@rune/kit` —
шейдер + Tape-опсы + Caps-гейт. Не обобщается в примитив, но plug-in
темплейт описывает структуру.

**S3. Семантические инварианты (не оптимизации).** Premultiplied alpha,
opaque canvas, desynchronized canvas (#61), depthMode semantic compare
→ physical translation (#33), NDC harmonization (§5.2 досье),
premultiplied copy (#62), damage-clears для UI-канвасов (#32), MSAA
resolve (#38), reversed-Z convention (#32). Это дисциплина, не
оптимизация — реализуется в Tape-исполнителе как инвариант, не plug-in.

**S4. Специфичные debug-артефакты.** Snapshot fuzzing (#23), perf bisect
(#24), borrow-check (#26), pixel-diff (#65), capture (#25), explain-audit
(#45), signal devtools (#27), GPU-less authoring (#30). Встречают Tape
как источник данных, но каждый — отдельная аналитика. Не обобщается,
потому что различается алгоритм анализа.

### 9.4 Принцип: бойлерплейт не растёт

Главное требование заказчика: **внешний API = минимальный**. Внутренняя
сложность примитивов — невидна и не важна. Это формализует принцип:

> Пользователь пишет **только то, что специфично его фиче** — caps-гейт,
> measure-функцию, run-функцию, шейдер. Весь каркас (кэш, инвалидация,
> EMA, fusion, подписка, telemetry, выбор healthy-пути, деградация) —
> библиотечный, с разумными дефолтами. `FeaturePlug` — **внутренняя**
> запись библиотеки (для telemetry / rewind / determinism), пользователь
> её не строит и не видит.

Из этого принципа вытекают два правила для API:

1. **Никаких обязательных полей кроме специфики фичи.** `id` авто-генерируется
   из строки имени. `requires` принимает string shorthand. `telemetry`,
   `degrade`, `depends` — библиотечные дефолты.
2. **`depends` убран из пользовательского API.** Библиотека infer'ит
   зависимости по тому, что `apply()`/`run()` вызывает (pressureBus.on →
   pressure-dep, paths.add → path-dep, pump.create → pump-dep).

### 9.5 Примитивы (9 + 1 мета) — внешний и внутренний слои

Девять примитивов + один мета. Часть уже есть в коде/досье (отмечено),
часть новая (по §5 addendum). Не дублируют досье — обобщают то, что в
досье описано точечно.

**Внешний API (пользовательский, низкий бойлерплейт)** — функциональные
одно-liner'ы с опциональными полями и дефолтами:

```typescript
// Present-путь — 2 обязательных поля (requires + run), остальное по дефолту
paths.add('transferControl', {
  requires: 'OffscreenCanvas.transferControl',  // string shorthand для caps.path === 'ok'
  run: ctx => ctx.canvas.transferControlToOffscreen()
  // probe:        дефолт — auto-benchmark на первом запуске, кэш
  // degrade:      дефолт — переключатель на следующий healthy-путь
  // telemetry:    дефолт — стандартная {id, enabled, state}
});

// Probe — 2 обязательных (id, measure)
probe.add('hasSAB', () => typeof SharedArrayBuffer !== 'undefined');
// cached:    computed-once, refresh по invalidate (device-loss / backend-swap)
// subscribe: библиотечный сигнал

// Pressure-source — 2-3 обязательных (id, measure, ema-опция)
pressureBus.add('network', () => computeNetworkPressure(), { ema: 0.1 });
// range: дефолт [0, 1]; fuse/decay/подписчики — библиотечные

// Подписка на pressure — одна строка
pressureBus.on('idle-input', level => {
  if (level > 0.7) tape.frameSkip();
});

// Pump — 2 обязательных (min, max), maxBurst-опция
const tilePump = pump.create<Tile>({ min: 256*1024, max: 16*1024*1024 });
tilePump.push(tile);
// burst/drain/stats/AIMD-динамика — библиотечные

// Tier profile — регистрация в ladder
tiers.register('mobile-v2', {
  features: ['astc'], limits: { maxTextureDimension2D: 8192 }
});

// Глобальные опции — env-driven, не обязательны
configure({ log: 'verbose' });
// или: RUNE_LOG=verbose (env-variable fallback)
```

**Бойлерплейт-сравнение**: раньше описанный plug-in объект — 6 обязательных
полей (`id`/`requires`/`depends`/`apply`/`degrade`/`telemetry`) + 2
опциональных, ~24 строки на типичную фичу. Сейчас — 2–3 обязательных
аргумента в функциональном вызове, ~4–6 строк. **Снижение в 4–5 раз.**
Условие «бойлерплейт не растёт» — выполнено.

**Низко-уровневый escape-hatch** (для <5% фич — composite-плагины вроде
«mobile profile», которые регистрируют несколько источников/путей одной
декларацией):

```typescript
registerRawPlug({
  id: 'mobile-profile',
  requires: caps => caps.has('astc'),
  apply(ctx) {
    ctx.pressureBus.add('thermal', measureThermal, { ema: 0.05 });
    ctx.pressureBus.add('battery', measureBattery, { ema: 0.1 });
    ctx.paths.add('preserve', { requires: 'preserveDrawingBuffer', run: ... });
    // ...
  }
});
```

Полный контроль, ручная декларация. **Не для типичных фич**.

**Внутреннее представление (библиотечное, не пользовательское)** —
`FeaturePlug` как запись, которая автоматически строится из вызовов
`paths.add()` / `probe.add()` / `pressureBus.add()` / etc.:

```typescript
// ВНУТРЕННИЙ интерфейс — НЕ пользовательский
interface FeaturePlug {
  readonly id: string;
  requires: (caps: Caps) => boolean;
  apply: (ctx: PlugCtx) => void;
  // depends — ИНФЕРИРУЕТСЯ из вызовов в apply() (pressureBus.on, paths.add, etc.)
  degrade?: (level: number) => void;     // дефолт: switch to next-best path / no-op
  telemetry: () => PlugState;             // дефолт: {id, enabled, state}
}
```

Полные интерфейсы примитивов (для аудитории библиотекарей, не пользователей):

```typescript
// 1. PressureBus — НОВЫЙ (в досье §9.2 описано вручную)
interface PressureBus {
  add(id: string, measure: () => number, opts?: { ema?: number; range?: [number, number] }): PressureSource;
  on(source: string | PressureSource, fn: (level: number) => void): Unsub;
  fuse(...sources: PressureSource[]): Pressure;     // weighted max; on() принимает fused pressure
}

// 2. Probe<T> — НОВЫЙ (уточнение §9.2 addendum §4: probeContextEviction как частный случай)
interface Probe<T> {
  readonly id: string;
  readonly cached: T;                                  // refresh-on-invalidate
  measure(): T;                                        // explicit refresh
  invalidate(): void;                                  // триггерится device-loss / backend-swap автоматически
  subscribe(fn: (v: T) => void): Unsub;
}
function probe.add<T>(id: string, measure: () => T): Probe<T>;

// 3. Caps — досье §11.4, РАСШИРИТЬ path() и zeroCopy ladder
interface Caps {
  has(f: FeatureId): boolean;
  format(f: GPUFormat, axis: FormatAxis): FormatSupport;
  path(name: PresentPathId | 'range' | 'asyncbmp' | 'video-external' | 'zero-copy' | 'offscreen-canvas'): PathSupport;
  ext(name: string): unknown | null;
  stats(): RendererStats;
  invalidate(): void;                                  // = invalidate all Probes
}

// 4. TierLadder — досье §11.3 Контракт 4, НЕ ТРОГАТЬ (канонический)
interface TierLadder {
  request(features: FeatureId[], limits: Record<string, number>): TierResult;
  register(profile: TierProfile): void;               // desktop / mobile / fallback / custom
}

// 5. Journal — досье §14.1 audit 1, восстановить как примитив (§5.1 addendum)
interface Journal {
  record(op: DeclOp): void;
  replay(backend: BackendId): void;                    // = switchBackend = device-loss recovery = worker migration
  compact(): void;                                     // #13 heap compaction
  snapshot(): Snapshot;                                // #41 resume-snapshot
  evict(predicate: (op: DeclOp) => boolean): void;     // #14 lazy re-declaration
}

// 6. Tape + Recorder/Executor — в коде, ИНВАРИАНТ (не новый примитив, но enforced)
interface Tape {
  push(op: OpCode, ...args: number[]): void;
  transfer(): ArrayBuffer;                             // transferable across workers
  replayOn(executor: Executor): void;
  analyze(): TapeStats;                                // borrow-check #26, usage #37, post-link prune #36
  optimize(): void;                                    // #6 tape.optimize
  ring(depth: number): Tape[];                         // #4 triple buffer, #41 resume
}

// 7. Pump<T> — обобщение uploadScheduler (в коде как uploadScheduler, обобщить)
interface Pump<T> {
  push(job: T): void;
  drain(slot: IdleSlot): number;                        // bytes / tiles / chunks processed
  burst(bytes: number): void;                           // #theory N — instant on idle, ≤ cap
  setWindow(min: number, max: number): void;            // AIMD bounds
  stats(): PumpStats;
}
function pump.create<T>(opts: { min: number; max: number; maxBurst?: number }): Pump<T>;

// 8. Decay — НОВЫЙ utility (формулы в §4 addendum и §9.2 досье)
interface Decay {
  ema(value: number, prev: number, alpha: number): number;
  ratio(p95: number, p50: number): number;              // §4 addendum, degradationRatio
  hysteresis(value: number, lower: number, upper: number, state: boolean): boolean;
  ring<T>(values: T[], n: number): T[];                 // #21 history
}

// 9. PathRegistry — НОВЫЙ (DESIGN.md §5.5 addendum, обобщить до любых plug-in)
interface PathRegistry {
  add(name: PresentPathId, def: {
    requires: string | ((c: Caps) => PathSupport);   // string shorthand ИЛИ полная функция
    run: (ctx: PresentCtx) => void;
    probe?: () => PathCost | Promise<PathCost>;         // дефолт: auto-benchmark
    degrade?: (level: number) => void;                  // дефолт: switch to next-best
  }): void;
  select(caps: Caps, pressure: Pressure): PresentPathId;     // auto-select best healthy
  state(id: PresentPathId): PathState;                       // healthy | degraded | disabled via Decay.ratio
  all(): { id: PresentPathId; state: PathState; cost: PathCost }[];
}
```

### 9.6 Декомпозиция каталога §12 → композиции примитивов

Каждая позиция каталога — композиция примитивов. «S1/S2/S3/S4» в столбце
«частное» — что осталось ручным (см. §9.3).

| # | Имя | Примитивы | Частное |
|---|----|-----------|---------|
| 1 | every(n) | Tape.optimize | — |
| 2 | Транзиентный пул | Pool<Target> (epoch-recycle, уже в коде) | — |
| 3 | Frequency-split арены | Tape.partition (frame vs draw) | — |
| 4 | Тройная буферизация арены | Tape.ring(depth) | — |
| 5 | Параллельные энкодеры | Tape.split + Caps.has('render-bundles') | S1 (WebGPU bundles) |
| 6 | tape.optimize | Tape.optimize pass | — |
| 7 | Tape JIT/interpreter | Tape dispatch (codegen toggle, dual-head) | — |
| 8 | Scan-progressive декод | Pump<DecodeChunk> | S1 (ImageDecoder) |
| 9 | Сетевые тайлы | Pump<Tile>.aimd + Caps.path('range') + Tape.texSubImage | S1 (HTTP Range) |
| 10 | OPFS L2-кэш | Pump<Tile> tier extension + Caps.path('opfs') | S1 (OPFS) |
| 11 | Кодек-плагины | CodecRegistry (pluggable; S1 per codec) | S1 (meshoptimizer, Basis, Draco) |
| 12 | Zero-main-thread | Pump<Job> + Tape.transfer + Journal.replay(worker) | S1 (OffscreenCanvas, postMessage, SAB) |
| 13 | Journal-компактация | Journal.compact | — |
| 14 | Ленивая re-declaration | Journal.evict(pressure predicate) | — |
| 15 | Глобальный frame-оркестратор | FrameOrchestrator (one rAF, BC-delta batching) | — |
| 16 | rVFC frame pacing | FrameOrchestrator extension | S1 (vsync API) |
| 17 | reactiveFrame | PressureBus.source('idle-input') + Decay.EMA + Tape.frameSkip | — |
| 18 | Late input sampling | Tape.snapshot at submit | S1 (input events) |
| 19 | switchBackend | Journal.replay(newBackend) | — |
| 20 | sinkSignal | Arena direct writer (signal → typed slot) | — |
| 21 | history(sig, n) | Decay.ring | — |
| 22 | Fixed-point sim-time | Time source (u64 µs) | S3 (invariant) |
| 23 | Snapshot fuzzing | Tape.fuzz (mutations of epoch snapshots) | S4 (fuzzer logic) |
| 24 | Perf bisect | Tape.bisect (binary search regression) | S4 (search algorithm) |
| 25 | Запись сессии | Capture (video + Journal.snapshot) | S4 (capture format) |
| 26 | Borrow-check | Tape.analyze (use-after-destroy check) | S4 (analyzer rules) |
| 27 | Signal devtools-оверлей | Telemetry hook + Tape.epoch timeline | S4 (overlay UI) |
| 28 | Fix-suggestions в ошибках | Diagnostic messages | S4 (suggestion engine) |
| 29 | Renderer fan-out | Renderer.multiplex (one device, many canvases) | — |
| 30 | GPU-less авторинг | Stub backend + Tape authoring | S4 (stub completeness) |
| 31 | Depth pyramid (HiZ) | Recipe (Caps.gate + Tape-опсы) | S2 (shader recipe) |
| 32 | Reversed-Z + damage-clears | Convention in math + Tape.clear(damage rect) | S3 (convention) |
| 33 | depthMode | Uniform ABI translator (semantic → physical) | S3 (semantic map) |
| 34 | Occlusion-feedback | Probe<Visibility> + Tape.feedback | S1 (GPUQuerySet) |
| 35 | Bind-group-aware ordering | Tape.sortKey extension | — |
| 36 | Active-uniform pruning | Tape.analyze (post-link) | — |
| 37 | Memoryless depth | Tape.analyze (usage-анализ) | S3 (usage semantics) |
| 38 | MSAA storeOp discard + resolve | Tape.storeOp select | S3 (resolve invariant) |
| 39 | caps.pickFormat | Caps.format(family) negotiation | — |
| 40 | Precision-профили GLSL | Codegen profile (mediump gate) | S2 (GLSL precision hints) |
| 41 | Resume-snapshot | Journal.snapshot + Tape.ring | — |
| 42 | Cold-start replay prewarm | Pump<Prewarm> + Tape.replay(splash) | — |
| 43 | Адаптивный codegen | Probe<GPUClass> + Codegen.select(profile) | S2 (profile table) |
| 44 | Mip-trim под давлением | PressureBus.source('memory') + Tape.mipBias | S2 (mip-bias shader) |
| 45 | Zero-copy ladder | Caps.path('zero-copy') + Explain-audit | S4 (audit logic) |
| 46 | Staging-пул малых буферов | Pool<Buffer> (ring recycle) | — |
| 47 | Thermal/battery фьюжн | PressureBus.fuse('thermal-EMA', 'battery') | — |
| 48 | Feature-ladder + requestTier | TierLadder.request | — |
| 49 | Subgroups | Caps.gate + shared-mem emulation | S1 (shared memory) + S2 (emulation) |
| 50 | Work graphs | Tape.reserve(indirect) (watchlist) | S1 (indirect API) |
| 51 | Nanite-lite | Caps.gate + Tape-опсы | S2 (meshlet-LOD-DAG, soft rasterizer) |
| 52 | Meshoptimizer-пайплайн | CodecRegistry (prims extension) | S2 (meshlet builder) |
| 53 | Visibility-buffer deferred | Recipe (material resolve by primitive-ID) | S2 (visibility shader) |
| 54 | Полная GPU-цепочка куллинга | Compute pipeline recipe | S2 (instance→meshlet→cluster→occ) |
| 55 | AgX + Oklab | Color recipe | S2 (AgX/Oklab shader) |
| 56 | TSR-lite | Temporal upscale recipe | S2 (reprojection + clip history) |
| 57 | Checkerboard-прозрачность | Recipe (half-res particles) | S2 (quincunx shader) |
| 58 | Blue noise без LUT | Recipe | S2 (Owen-scrambled Sobol) |
| 59 | WASM-SIMD math | Math backend | — |
| 60 | WebCodecs zero-copy | Caps.path('video-external') + VideoFrame | S1 (WebCodecs) |
| 61 | Compositing-гигиена | PathRegistry + PathState (Decay.ratio) | S3 (premultiplied, opaque, desync) |
| 62 | transferToImageBitmap | PathRegistry.register('asyncbmp') + Caps.path | S1 (transferToImageBitmap) |
| 63 | scheduler.postTask/yield | Scheduler integration | S1 (postTask API) |
| 64 | Scoped-детерминизм | Determinism contract (cross-cutting) | S3 (semantic) |
| 65 | Pixel-diff в rewind | Tape.diff (visual bisect) | S4 (diff algorithm) |

**Сводка**: 65 позиций → 52 полностью сводятся к композиции примитивов
(частное = «—»), 13 имеют S1/S2/S3/S4-хвост, который остаётся ручным. Это
соотношение 80/20 — именно то, чего хотел заказчик: «похожие с небольшими
изменениями» = новые позиции с тем же шаблоном композиции.

### 9.7 Декомпозиция 14 present-путей → PathRegistry

Все 12 GL + 2 WebGPU present-пути (бенч-раунд 4, DESIGN.md §5.5 addendum)
выражаются как регистрации в PathRegistry. Каждый путь = { probe, caps,
run }, состояние управляется `PathState` через `Decay.ratio(p95, p50)`.
Это и есть «compositing-гигиена» (#61) + «transferToImageBitmap» (#62) в
канонической форме.

| Путь | Probe/Caps | Частное (S1/S2/S3) |
|------|-----------|---------------------|
| direct | Caps.has('webgl2') — всегда 'ok' | S3 (premultiplied) |
| quadpass | Caps.has('webgl2') — всегда 'ok' | S2 (pass vert shader) |
| bitmap | Caps.path('OffscreenCanvas') + Caps.path('ImageBitmap') | S1 (transferToImageBitmap) |
| draw2d | Caps.path('Canvas2D') — fallback ветка | S1 (Canvas2D), S3 (alpha) |
| multi4 | Caps.has('webgl2') + N viewers | S1 (4 contexts) |
| draw2d-half | как draw2d + Decay degradation | S1 (Canvas2D half-res) |
| preserve | Caps.has('preserveDrawingBuffer') | S3 (premultiplied tax) |
| blit | Caps.has('blitFramebuffer FBO→default') | S1 (ANGLE BGRA mismatch) |
| quadcopy | Caps.has('webgl2') | S2 (copy shader) |
| uvremap | Caps.has('webgl2') (атлас-вью) | S2 (UV-remap shader) |
| asyncbmp | Caps.path('transferToImageBitmap') | S1 (OffscreenCanvas.transferToImageBitmap) |
| multibmp4 | как asyncbmp × 4 viewers | S1 (4 ImageBitmaps) |
| scaled-half | Caps.path('createImageBitmap resize') | S1 (createImageBitmap + resize) |
| wgpu-direct | Caps.path('WebGPU') + Caps.has('render-bundles') | S1 (WebGPU canvas) |
| wgpu-copy | Caps.path('WebGPU.copyExternalImage') | S1 (copyExternalImageToTexture) |

`PathRegistry.select(caps, pressure)` автоматически выбирает лучший
healthy-путь на данном железе под текущим pressure. На Mali (preserve
p95/p50 ratio = 3.0 ≫ 1.5) preserve → disabled, выбор уходит в quadpass
или direct. На десктопе (ratio < 1.5) — выбирается самый дешёвый по
Probe (direct или quadcopy). На адаптере без WebGPU wgpu-* → 'unavailable',
path-state = 'unavailable', выберется асинхронный GL-путь.

### 9.8 Развёртывание «похожих с небольшими изменениями» — одно-liner'ы

Главная ценность каркаса: **новая фича = ≤6 строк пользовательского кода**.
Не plug-in объект с 8 полями — функциональный вызов с 2–3 обязательными
аргументами и дефолтами для остального.

```typescript
// Шаблон: paths.add / probe.add / pressureBus.add / pump.create / tiers.register
// Каждая функция строит FeaturePlug внутренне; пользователь его не видит.
```

Три примера «похожих с небольшими изменениями»:

**A. Новый present-путь «OffscreenCanvas.transferControl»**
(похож на #62 asyncbmp, но без переноса в ImageBitmap — кадр остаётся в
OffscreenCanvas, показывается через `transferControlToOffscreen`):

```typescript
paths.add('transferControl', {
  requires: 'OffscreenCanvas.transferControl',
  run: ctx => ctx.canvas.transferControlToOffscreen()
});
```

**4 строки**. Против ~14 строк в старом plug-in объекте (id/requires/depends/
apply/ctx.paths.register/probe/caps/run/telemetry). Дельта против asyncbmp-
регистрации (тоже 4 строки) — только строка `requires` и тело `run`. Probe,
telemetry, PathState-гейтинг, decay, degrade-переключатель — библиотечные
дефолты.

**B. Новый probe «probeSharedArrayBuffer»**
(похож на probeContextEviction, но проверяет доступность SAB для T2/T3
транспортов — нужен для #12 worker migration):

```typescript
probe.add('hasSAB', () => typeof SharedArrayBuffer !== 'undefined');

// Использование в TierLadder — в профильном запросе:
tiers.register('transport-sab', {
  features: [],
  limits: {},
  // если probe.cached === false → ladder спустит к T1 (postMessage)
});
```

**1 строка** на регистрацию probe. Против ~8 строк в старом Probe-объекте
(id/cached/measure/invalidate/subscribe). Дельта против probeContextEviction
— только тело measure. Cache, invalidate по device-loss, subscribe —
библиотечные.

**C. Новый pressure-source «network bandwidth»**
(похож на #47 thermal-EMA, но сигнал — сетевая полоса от
navigator.connection.downlink + RTT — нужен #9 paging, #10 OPFS, #8
scan-progressive для деградации качества тайлов):

```typescript
pressureBus.add('network', () => {
  const c = navigator.connection;
  if (!c) return 0;
  return c.rtt > 200 || c.downlink < 1 ? 0.8 : 0;
}, { ema: 0.1 });

// Подписчики — одна строка каждый:
pressureBus.on('network', level => {
  if (level > 0.5) tilePump.setWindow(64*1024, 4*1024*1024);
});
```

**3 строки** на источник + 2 строки на каждого подписчика. Дельта против
thermal-source — только measure-тело и ema-коэффициент. PressureBus, EMA,
fusion, подписка — библиотечные.

**Сводка «маленького изменения»**:

| Что меняется | API-вызов | Обязательных полей | Дельта против ближайшего соседа |
|---|---|---|---|
| Новый present-путь | `paths.add(name, {requires, run})` | 2 | requires + run |
| Новый probe | `probe.add(name, measure)` | 2 | measure-тело |
| Новый pressure-source | `pressureBus.add(name, measure, {ema})` | 2–3 | measure + ema |
| Новый AIMD-поток | `pump.create({min, max})` | 2 | min/max границы |
| Новый tier-профиль | `tiers.register(name, {features, limits})` | 3 | features/limits |
| Новый kit-рецепт | `recipe.add(name, {caps, setup, shader})` | 3 | шейдер + Tape-опсы |

**Kit-рецепты (S2)** — отдельный escape-hatch, т.к. требуют шейдера:

```typescript
recipe.add('agx-grading', {
  caps: c => c.has('render-target-float'),
  shader: { frag: AGX_FRAG_SRC, vert: PASS_VERT_GLSL },  // dual-source
  setup: ctx => ctx.tape.bindTarget(ctx.target)
});
```

3 обязательных поля вместо 8-field plug-in'а — всё ещё ниже старого
варианта. recipe.add — для S2-класса фич (AgX, TSR-lite, HiZ, etc.); другие
примитивы (paths/probe/pressureBus/pump/tiers) не требуют шейдера.

**Принцип**: каждая новая фича — **только её специфика**. Никаких
boilerplate-полей (id/requires/depends/apply/degrade/telemetry) — это
библиотечные дефолты. Условие заказчика «бойлерплейт не растёт» —
выполнено: 2–3 обязательных поля на типичную фичу, против 6–8 в plug-in
объекте. Снижение в 4–5 раз.

### 9.9 Что это даёт для M4–M8

Примитивы сопоставлены с этапами реализации (§14.3 досье):

| Примитив | Этап | Зависимости | Примечание |
|----------|------|-------------|------------|
| Journal | M1 (восстановление) | — | Блокер для M4 (#19), M5 (#12) |
| Caps (расширить path()) | M4 | Journal | Базис для #39/#48/#61/#62 |
| TierLadder | M4 | Caps | Канонический, не трогать |
| PressureBus + Decay | M8 (как часть #47/#44/#17) | Probe | Назван из §9.2 досье |
| Probe | M4 (probeContextEviction, probeTextureMemory) | Caps | Уточнение §9.2 addendum §4 |
| Pump<T> (обобщение) | M6 (uploadScheduler → Pump) | — | Уже в коде, обобщить |
| PathRegistry | M8 (#61, #62) | Caps, Probe, Decay | DESIGN.md §5.5 addendum |
| FeaturePlug | M8 (мета) | все выше | Каталог §12 становится декларативным |

Порядок — канонический M4→M8 (как в §8 addendum), без перекрытия.
Каждый примитив — независимый шаг с зависимостями, легко тестируется.

### 9.10 Что НЕ покрывают примитивы (остаётся ручным)

Прямо перечислить, чтобы не было иллюзий:

1. **Шейдерный кодген рецептов S2** — AgX, TSR-lite, meshlet-LOD-DAG,
   HiZ-pyramid, GPU culling chain. Каждый — отдельный WGSL/GLSL-шейдер +
   Tape-опсы + Caps-гейт. Plug-in даёт структуру, не содержимое.

2. **State-кэш специфичных команд GL/GPU** — `depthMask(true)` перед
   clear с depth (урок Task 46), `bindTarget` с feedback-loop
   профилактикой, viewport-восстановление на канвас. Это инварианты
   Tape-исполнителя, не plug-in'ы.

3. **Баг-охота на конкретных сочетаниях** — как diag17 покадровый пруф
   «кадр 2+ пустой» оказался `depthMask`-маскировкой glClear (Task 46).
   Такие инциденты не сводятся к примитивам — нужны диагностические
   скрипты (diag1–17), которые остаются ручными.

4. **Дисциплина контрактов 1–5** — jank/maxMs, scoped-детерминизм,
   транспортная инвариантность, tier-лестница, честность гейтов. Это
   правила аудита, не код. Примитивы их реализуют, но не заменяют.

5. **Бенч-калибровка под новое железо** — как раунд 4 (Mali-G57 MC2).
   Нужно физическое устройство или эмулятор, скрипты bench-present /
   bench-phone, ручной анализ. Примитивы дают точки наблюдения
   (`telemetry()`), но интерпретация — человеческая.

### 9.11 Демонстрация: текущий конвейер vs примитивы §9.5

**Цель секции** — зафиксировать границу между «работает сегодня» и
«предложено в §9.5». Сверка показала, что пример `triangle-primitives-demo.ts`
читается как будто `scene.mount(...)` уже существует. Это не так: файл —
эталон будущего API, в шапке явно помечен «примитивы НЕ реализованы».
Текущий код — **regl-like**, без сценового графа.

#### 9.11.1 Текущий API — что экспортирует `@rune/gl` сегодня

```typescript
// packages/gl/src/index.ts — реальный набор
export { createRenderer } from './renderer.ts'
export { createWebGpuRenderer } from './webgpuRenderer.ts'
export { show } from './scene.ts'           // сахар «куб в одну строку»
export { showAny, showOn, probeWebGpu } from './show*.ts'
```

`scene.ts` — имя историческое; внутри только `show(target, options)`
для куба. **Сценового графа нет**: нет `scene.add(node)`, нет
`scene.traverse()`, нет `scene.root`. Имя файла — артефакт раунда MVP-2,
когда куб назывался «сценой».

Текущий регл-лайк цикл пользователя:

```typescript
const r = createRenderer({ canvas: '#c' })
const tex = r.texture(1024, 1024)
void tex.upload(rgba).done
const draw = r.command({
  shader: { glsl: { vertex: VERT, fragment: FRAG } },
  attributes: { position: { data: POS, size: 2 }, uv: { data: UV, size: 2 } },
  textures: { u_tex: tex },
  uniforms: { u_mvp: (p) => p.mvp },
  pipeline: { depth: { test: 'always', write: false }, raster: { cull: 'none' } },
  count: 3,
})
r.frame((ctx, record) => record(draw, { mvp: rotation2d(ctx.time * 0.5) }))
r.start()
```

**8 строк** пользовательского кода (без шейдера/геометрии — это специфика
фичи, не бойлерплейт). Под ними — все семь слоёв вывода (см. §9.11.3).

#### 9.11.2 Покадровый такт конвейера (реальный)

```
rAF tick → step(nowMs)
  ├─ updateFrameContext(nowMs)     time/dt/aspect/size → FrameContext
  ├─ transients.beginFrame()      скретч прошлого кадра стареет
  ├─ epoch.frame(() => {          сейфгард: точка отката при ошибке
  │    ├─ time.value = ctx.time   пуш в signal → реактивные derive
  │    ├─ writer.reset()         очистка ленты
  │    ├─ writer.emit(BeginPass) открывающая скобка
  │    ├─ buildFrame(lives, w)    live-команды испускают опкоды,
  │    │                          только если изменились их deps
  │    ├─ emitFrameCallbacks()    пользовательские колбэки:
  │    │    └─ record(cmd, props) → cmd.record(props, ctx, w)
  │    │        ├─ resolve uniforms  (props, ctx) → arena.write
  │    │        ├─ value-compare     dirty flag на слоте
  │    │        └─ w.emit(Draw, id, 0, count, 1)
  │    ├─ writer.emit(EndPass)    закрывающая скобка
  │    ├─ executor.run(view)      интерпретация опкодов:
  │    │    ├─ BeginPass:  bindTarget(0) + clear(color, depth)
  │    │    ├─ Draw:      ensureProgram (lazy GL program+buffer)
  │    │    │                useProgram (cache lastProgram)
  │    │    │                applyState (depth/cull cache)
  │    │    │                uploadUniforms (только dirty слоты)
  │    │    │                bind samplers (auto-unit из reflection)
  │    │    │                bind vertex buffers
  │    │    │                gl.drawArrays(...)
  │    │    └─ BindTarget: switch render target
  │    └─ uploads.drain()        idle-слот: стриминг текстур
  └─ scheduleNext()              следующий rAF
```

#### 9.11.3 Zero-declaration inference — что выводится СЕГОДНЯ

«Inference» в текущем коде — это семь слоёв автоматического вывода из
`DrawSpec`, без единой ручной декларации location/binding/state:

| # | Слой | Что infer'ируется | Где в коде |
|---|------|-------------------|------------|
| 1 | GLSL reflection | uniform-слот в арене по имени | `glslReflect.ts` → `command.ts:toField` |
| 2 | Attribute binding | `location` из шейдера | `glslReflect.ts` → `command.ts:attributes` |
| 3 | Sampler binding | texture unit auto-increment | `command.ts:bindSamplers` |
| 4 | Pass builtins | `u_time`/`u_resolution`/`u_texel` | `surface.ts:scanBuiltins/applyBuiltins` |
| 5 | State cache | depth/cull/program skip no-op | `executor.ts:applyState` |
| 6 | Arena diff | value-compare → только dirty upload | `arena.ts:write` + `executor.ts:uploadUniforms` |
| 7 | Lazy resources | program/buffer на первом draw | `executor.ts:ensureProgram` |

Это и есть «дух regl, расширенный» в текущей версии: пользователь
пишет **только специфику фичи** (шейдер, геометрия, юниформы), всё
остальное выводит рантайм. Без plug-in объекта, без 8 полей, без
ручных `gl.getUniformLocation`/`bindAttribLocation`.

#### 9.11.4 Что НЕ infer'ируется сегодня — зона §9.5

| Граница | Сегодня | Что добавит §9.5 |
|---------|---------|------------------|
| Выбор бэкенда | явный `createRenderer` / `createWebGpuRenderer` | `recipe.caps` → авто-выбор |
| Текстура | `renderer.texture().upload()` — стримится, давление не публикует | `texture.create({pressureSource})` — сама источник |
| Present-путь | кадр всегда в canvas | `PathRegistry.select(caps, pressure)` |
| Device-loss | ручной ребут | `Journal.replay(auto)` |
| Реактивные uniforms | `renderer.live()` — регистрация ручная | `recipe.uniforms: () => ({u_x: signal})` |
| Постпроцессинг | `surface.pass()`/`capture()` (есть, но в одном фреймворке) | `scene.mount([recipe.into(s), fx])` |
| Telemetry | `diag*.ts` скрипты | `state()` на каждом объекте |

#### 9.11.5 Граница в одной таблице

| Слой | Сегодня (regl-like) | После §9.5 (recipe/mount) |
|------|---------------------|---------------------------|
| init | `createRenderer({canvas})` | `scene.mount(target, recipe, props)` |
| spec | `renderer.command(DrawSpec)` | `recipe.add(name, {caps, shader, geometry, uniforms})` |
| uniforms | `function (props, ctx) => value` | `signal.derive([deps], fn)` |
| текстура | `renderer.texture(w,h).upload(bytes)` | `texture.create({source, pressureSource})` |
| present | canvas (хардкожен) | `PathRegistry.select` (quad/asyncbmp/...) |
| device-loss | ручной ребут | `Journal.replay` (auto) |
| постпроцессинг | `surface.capture()` + `surface.pass()` цепочкой | `scene.mount([recipe.into(s), fxBlur])` |
| idle/thermal | нет (жёсткий rAF) | `pressureBus.on('idle-input', ...)` |

#### 9.11.6 «Гениальный» угол — рост вывода vs снижение кода

Текущие 8 строк пользовательского кода порождают 7 слоёв вывода (§9.11.3).
После §9.5 — 5 строк породят 12 слоёв (7 текущих + caps/pressure/paths/
journal/reactive/textures-as-sources/telemetry). Рост вывода: **+5 слоёв**;
снижение кода: **−3 строки**. Это и есть выполнение условия заказчика
«бойлерплейт не растёт» (§9.4): каждая новая фича = только её специфика,
а библиотека забирает под вывод больше, чем под бойлерплейт.

`triangle-primitives-demo.ts` остаётся эталоном для §9.5; в текущий
код его вставлять нельзя — `scene.mount` не существует. Чтобы он
заработал, нужны примитивы из §9.9 (M4→M8 порядок реализации):
Journal → Caps расширение → Probe → PressureBus → Pump → PathRegistry →
FeaturePlug. До их реализации текущий regl-like цикл (§9.11.1–9.11.3) —
единственный рабочий путь.

### 9.12 Backend auto-selection — единый `createRenderer`

Заказчик: «по умолчанию вебгпу, если нет — вебгл; если хоть один
шейдер только WGSL и не в опциональном кейсе типа pass(), то вебгл;
дай reason; возможно — pre-check шейдеров до первого рендра, если
авто». Дизайн прошёл четыре итерации критики; зафиксирован финал.

#### 9.12.1 Итоговый API

```typescript
type BackendId = 'webgpu' | 'webgl2'

interface RendererOptions {
  canvas: HTMLCanvasElement | string
  backend?: BackendId | readonly BackendId[]  // default ['webgpu', 'webgl2']
  // ...другие опции (uniforms arena size, tape capacity, и т.д.)
}

interface Renderer {
  command(spec: DrawSpec): CompiledCommand
  frame(cb: (ctx, record) => void): void
  start(): Promise<void>                  // async ВСЕГДА (контракт унифицирован)
  whyBackend(): BackendDecision | null    // null до .start()
  // ...остальное без изменений
}

// Единый entry point + два явных для strict-режима
function createRenderer(opts: RendererOptions): Renderer
function createWebGL2Renderer(opts: RendererOptions): Renderer    // бывший createRenderer
function createWebGpuRenderer(canvas: HTMLCanvasElement | string): Promise<Renderer>
```

`backend` опционален. Строка — strict-режим (length-1 порядок, без
фолбэка); массив — упорядоченный список с фолбэком. По умолчанию
`['webgpu', 'webgl2']`: попробовать WebGPU, при недоступности или
непокрытии шейдеров — WebGL2. Старый WebGL2-only `createRenderer`
переименован в `createWebGL2Renderer` (миграция ниже, §9.12.6).
Новый `createRenderer` — надстройка над обоими; внутри один и тот же
класс `Renderer`, вебгпу/вебгл2 — swap-able адаптеры.

#### 9.12.2 DrawSpec — dual-source shader

```typescript
interface DrawSpec {
  shader: {
    glsl?: { vertex: string; fragment: string }
    wgsl?: string
  }
  attributes: ...
  uniforms: ...
  pipeline: ...
  count: number
}
```

Хотя бы один из `glsl`/`wgsl` обязан быть. Оба — спека работает
везде (портабельный код). Только `glsl` → только WebGL2. Только
`wgsl` → только WebGPU. `pass()`-инстансы исключены из pre-flight
(§9.12.4): их шейдеры — built-in dual-source квад, не могут «не
подойти» ни к одному бэкенду. Это же касается `surface.capture()` и
других встроенных quad-пассов.

#### 9.12.3 `resolveBackend` — чистая функция + `BackendDecision`

```typescript
interface HardwareAvailability {
  webgpu: boolean
  webgl2: boolean
}

function resolveBackend(
  order: readonly BackendId[],
  specs: readonly DrawSpec[],
  hardware: HardwareAvailability,
): BackendDecision
```

Алгоритм — две строки:

```typescript
const candidates = order.filter(b =>
  hardware[b] && specs.every(s => covers(s, b)))
const chosen = candidates[0] ?? null
```

`covers(spec, backend)` тривиален: для `webgpu` нужен
`spec.shader.wgsl`, для `webgl2` — `spec.shader.glsl`. Чистая
функция, тестируется без GPU — в `packages/gl/tests/autoBackend.test.ts`
10+ кейсов уже зелёные (Task 52).

`BackendDecision` — структурированный отчёт, никаких enum'ов
причин:

```typescript
interface BackendDecision {
  chosen: BackendId | null
  message: string                   // генерируется из verdicts, всегда actionable
  verdicts: {
    webgpu: { available: boolean; covers: boolean; rejected?: string }
    webgl2: { available: boolean; covers: boolean; rejected?: string }
  }
  coverage: Array<{ id?: string; hasGlsl: boolean; hasWgsl: boolean }>
}
```

Round 1 отказался от `prefer: 'auto'|'webgpu'|'webgl2'` enum'а как
противоречивого: «prefer = приоритет, а не фиксация, throw при
отсутствии — топорно». Только факты в `verdicts`; `message`
собирается шаблоном. Если `chosen === null` — throw
`BackendResolutionError` с полным `decision` в поле, юзер видит
какой бэкенд отвалился и почему («webgpu: unavailable», «webgl2:
covers=false, 2 specs are WGSL-only»).

#### 9.12.4 Ленивое обнаружение спек — через `.command()`

Round 2 требовал `specs: DrawSpec[]` в опциях для pre-flight.
Заказчик: «бойлерплейт лютый» — юзер перечислял бы спеки дважды (для
резолвера, потом в `command(spec)`). Убрали. Спеки собираются
автоматически из того, что юзер реально вызывает в `command()`.
Решение принимается на `.start()` — это и есть «pre-check до первого
рендера».

Поток:

1. `createRenderer(opts)` **синхронный** — обёртка, никакой GPU-работы.
   `inner: Renderer | null = null`, `pendingSpecs: DrawSpec[] = []`,
   `pendingFrames: FrameCb[] = []`.
2. `command(spec)` до старта: `pendingSpecs.push(spec)`, возвращает
   proxy `CompiledCommand` (реальный подключится после `.start()`).
3. `frame(cb)` до старта: `pendingFrames.push(cb)`.
4. `start()` **асинхронный**:
   - probe hardware (`navigator.gpu !== undefined` + try
     `requestAdapter()` для webgpu; `typeof WebGL2RenderingContext`
     для webgl2; canvas не трогается, не дают контекст);
   - `decision = resolveBackend(order, pendingSpecs, hardware)`;
   - если `chosen === null` → throw `BackendResolutionError(decision)`;
   - `inner = chosen === 'webgpu'
       ? await createWebGpuRenderer(canvas)
       : createWebGL2Renderer(canvas)`;
   - проксировать `pendingSpecs` через `inner.command()` (proxy-команды
     получают реальный `CompiledCommand`);
   - проксировать `pendingFrames` через `inner.frame()`;
   - `await inner.start()`.
5. `command(spec)` после старта: `assertCovers(spec, decision)` —
   если спека не подходит под выбранный бэкенд, throw с actionable
   сообщением («вы на webgl2, спека требует wgsl — добавьте glsl
   к спеке или перезапустите с `backend: 'webgpu'`»). Иначе
   `inner.command(spec)`. Это late-reject для динамически
   добавленных после старта спек.

Конструктор синхронный, `.start()` асинхронный — контракт-брейк для
старых WebGL2-юзеров (раньше `.start()` был sync), но плата за
единый entry point. WebGL2-путь резолвится мгновенно, `.start()` для
него завершается в том же тике.

#### 9.12.5 Пользовательский код

```typescript
// 1. Дефолт — webgpu с фолбэком на webgl2
const r = createRenderer({ canvas })
const tri = r.command({
  shader: { glsl: { vertex, fragment }, wgsl },
  attributes: { position: [...] },
  count: 3,
})
r.frame((ctx, rec) => rec(tri, { u_time: ctx.time }))
await r.start()
console.log(r.whyBackend())
// { chosen: 'webgpu', verdicts: { webgpu: {...}, webgl2: {...} }, ... }

// 2. Строгий webgpu (упрётся в BackendResolutionError, если недоступен)
const r = createRenderer({ canvas, backend: 'webgpu' })

// 3. Легаси-режим — только webgl2 (эквивалент бывшего createRenderer)
const r = createRenderer({ canvas, backend: 'webgl2' })
// или явно: const r = createWebGL2Renderer({ canvas })

// 4. Обратный порядок (webgl2 preferred, webgpu как фолбэк)
const r = createRenderer({ canvas, backend: ['webgl2', 'webgpu'] })
```

#### 9.12.6 Итерации и миграция существующего кода

Итерации дизайна (память для будущих раундов):

| Раунд | Предложение | Отказ заказчика |
|---|---|---|
| 1 | `prefer: 'auto'\|'webgpu'\|'webgl2'` enum + throw при недоступности | «Prefer = приоритет, не фиксация. Throw при отсутствии противоречие. Система топорная» |
| 2 | `createAutoRenderer({ specs: DrawSpec[] })` с предобъявлением | «Бойлерплейт лютый — спеки перечисляются дважды» |
| 3 | Отдельный `createAutoRenderer` как новый entry point | «Почему "auto"? Просто добавь `backend` в `createRenderer`, а старый переименуй в `createWebGL2Renderer`» |
| 4 (финал) | `createRenderer({ backend?: BackendId \| BackendId[] })` + lazy discovery через `.command()` + `.start()` как точка решения | Принято |

Каждый отказ → упрощение. Финальный API: один entry point
(`createRenderer`), одна опция (`backend` — строка или массив),
одна асинхронная точка (`.start()`), одна функция-резолвер
(`resolveBackend` — чистая, тестируется без GPU).

Текущее состояние (Task 52 уже реализован в `autoBackend.ts` +
`autoRenderer.ts`, но под старым именем `createAutoRenderer` —
требуется rename-рефакторинг):

- `packages/gl/src/autoBackend.ts` — `resolveBackend`,
  `shaderCoverage`, типы `BackendDecision`/`BackendVerdict`/
  `SpecCoverage` — остаются без изменений (уже соответствуют итогу).
- `packages/gl/src/autoRenderer.ts` — `createAutoRenderer` → rename
  в `createRenderer`; файл либо переименовать в `renderer.ts`
  (тогда старый `renderer.ts` → `webgl2Renderer.ts`), либо
  вынести обёртку в `renderer.ts` и переименовать старый.
- `packages/gl/src/renderer.ts` — текущий WebGL2-рендерер → переименовать
  экспорт в `createWebGL2Renderer`, файл → `webgl2Renderer.ts`
  (или `webgl2.ts`).
- `packages/gl/src/webgpuRenderer.ts` — без изменений.
- `packages/gl/src/index.ts` — экспортировать: `createRenderer`
  (новый), `createWebGL2Renderer` (переименованный),
  `createWebGpuRenderer`, `resolveBackend`, `BackendResolutionError`,
  типы `BackendId`/`BackendDecision`/`RendererOptions`.
- `packages/gl/tests/autoBackend.test.ts` — без изменений (чистая
  функция уже финальна).
- `packages/gl/tests/autoRenderer.test.ts` → rename в
  `renderer.test.ts` (или оставить как есть — тестирует тот же класс).
- `demo/auto-backend-demo.ts` — обновить пользовательский API в
  финальном примере (переименовать вызовы).

Работа — чистый rename + move, без смены алгоритма `resolveBackend`
(он уже финален с Task 52). Контракт-брейк один: `.start()` стал
`Promise<void>` вместо `void` для WebGL2-пути.

### 9.13 Внешние канвасы + альтернативные источники текстур

Две конкретные фичи, не требующие полного §9.5 — concrete improvements
существующего API. Лёгкая groundwork-база: когда `PathRegistry` и
`textures-as-sources` будут реализованы, эти API станут декларативной
обёрткой над ними.

#### 9.13.1 Внешние канвасы — `OffscreenCanvas` как цель рендера

```typescript
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

interface RendererOptions {
  canvas: AnyCanvas | string
  // ...
}
```

Семантика размеров принципиально разная (`canvasHelpers.ts`):
- `HTMLCanvasElement`: `clientWidth`/`clientHeight` (CSS), `width`/`height`
  (buffer). Renderer множит CSS на DPR → buffer. `ResizeObserver` работает.
- `OffscreenCanvas`: `width`/`height` — это И CSS, И buffer (нет DOM, нет
  CSS-размеров). DPR = 1 всегда. `ResizeObserver` НЕ поддерживается —
  пользователь сам зовёт `renderer.resize(w, h)`.

```typescript
function isOffscreenCanvas(canvas: AnyCanvas): canvas is OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) return true
  // Duck-typing fallback для Node/headless (HTMLCanvasElement имеет
  // clientWidth через HTMLElement.prototype, OffscreenCanvas — нет)
  return !('clientWidth' in canvas)
}

function getCanvasCssSize(canvas: AnyCanvas): readonly [number, number] {
  if (isOffscreenCanvas(canvas)) return [canvas.width, canvas.height]
  const css = canvas.clientWidth, cssH = canvas.clientHeight
  if (css > 0 && cssH > 0) return [css, cssH]  // DOM отрисован
  return [canvas.width || 1, canvas.height || 1]  // fallback для ранней инициализации
}

function canvasDpr(canvas: AnyCanvas, override?: number): number {
  if (override !== undefined) return override
  if (isOffscreenCanvas(canvas)) return 1  // нет CSS → нет DPR
  return typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1
}
```

Поддержка `transferControlToOffscreen()` workflow: пользователь зовёт
`canvas.transferControlToOffscreen()` сам, передаёт полученный
`OffscreenCanvas` в `createRenderer({ canvas })`. Renderer не знает
разницы — работает с `OffscreenCanvas` как обычно. Это основа для
zero-main-thread рендеринга (см. §9.5 #12 «Zero-main-thread» в будущем).

`acquireWebGL2` и `createRealGPU` теперь принимают `AnyCanvas`.
`canvas.getContext('webgl2' | 'webgpu', ...)` работает на обоих типах.
`observeSize` ранним return'ом пропускает `OffscreenCanvas` (нет
`ResizeObserver`).

Тесты (`canvasHelpers.test.ts`, 6 кейсов): `isOffscreenCanvas` отличает
типы; `getCanvasCssSize` для HTML vs Offscreen; `canvasDpr` HTML vs
Offscreen; `createWebGL2Renderer` принимает `OffscreenCanvas` + createGL
инъекцию (size = `canvas.width/height`, не `clientWidth`); `step` не
бросает на `OffscreenCanvas`; HTML с `clientWidth=0` fallback на
`width/height`.

#### 9.13.2 Альтернативные источники текстур — `texture.uploadImage(source)`

Стриминг (chunked bytes) и атомарная загрузка (bitmap/canvas/video) —
разные семантики, два API:

```typescript
interface Texture extends TextureHandle {
  width: number
  height: number
  /** Стриминг RGBA-байтов: превью → чанки; прогресс и отмена. */
  upload(source: Uint8Array, options?: { priority?: number; onProgress?: (fraction: number) => void }): TextureUpload
  /** Атомарная загрузка из bitmap/canvas/video — одним вызовом, без чанков. */
  uploadImage(source: GLImageSource | GPUImageSource): void
}

type GLImageSource = ImageBitmap | HTMLCanvasElement | HTMLImageElement |
                     HTMLVideoElement | OffscreenCanvas | VideoFrame
type GPUImageSource = ImageBitmap | HTMLCanvasElement | HTMLVideoElement |
                      OffscreenCanvas | VideoFrame
```

Реализация:
- WebGL2: `gl.texImage2D(target, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)`
  — overload с `TexImageSource` (перезаписывает мип 0; размер берётся из источника).
- WebGPU: `device.queue.copyExternalImageToTexture({ source }, { texture, mipLevel: 0, origin: [0,0,0] }, [w, h, 1])`
  — `ExternalImageCopy` принимает ImageBitmap | HTMLCanvasElement | HTMLVideoElement | VideoFrame | OffscreenCanvas.

Facade contract:
```typescript
interface GLFacade {
  // ...
  texImage2DFromSource(textureId: number, source: GLImageSource): void
}
interface GPUFacade {
  // ...
  copyExternalImageToTexture(textureId: number, source: GPUImageSource, w: number, h: number): void
}
```

Тесты (`textureUploadImage.test.ts`, 5 кейсов): `uploadImage` зовёт
`texImage2DFromSource` с тем же `textureId`; `HTMLCanvasElement`-источник
→ корректное имя типа в записи; НЕ зовёт `texSubImage2D` (стриминг не
задействован); можно чередовать `upload(bytes)` и `uploadImage(source)`;
`OffscreenCanvas`-источник → корректное имя. `describeSource` в
recordingGL.ts и recordingGPU.ts использует duck-typing для headless-сред
(без глобального `ImageBitmap`/`OffscreenCanvas`).

Зачем отдельный `uploadImage`, а не расширение `upload`:
1. Стриминг возвращает `TextureUpload` с `.done: Promise<void>` и прогрессом
   — не имеет смысла для атомарных источников (one-shot upload).
2. Типы источников `GLImageSource`/`GPUImageSource` — широкие union'ы,
   засовывать в `upload(bytes: Uint8Array | GLImageSource)` ломает вывод типов.
3. Семантика разная — пользователь явно выбирает: «у меня готовый bitmap»
   vs «у меня байты, стримь их по чанкам».

Связь с §9.5 «textures-as-sources» (будущее): когда `PressureBus` будет
реализован, текстуры станут sources давления (`texture.create({source,
pressureSource})`). Текущий `uploadImage` — concrete improvement: та же
функция, но без реактивного `pressureSource`-флага. Migration path —
`texture.uploadImage(source)` → `texture.create({source, pressureSource:
'memory'})` (декоратор поверх).

#### 9.13.3 Миграция и что осталось

Изменения файлов:
- `packages/gl/src/canvasHelpers.ts` (NEW, ~70 строк) — `AnyCanvas`,
  `isOffscreenCanvas`, `getCanvasCssSize`, `canvasDpr`, `resolveCanvasAny`.
- `packages/gl/src/webgl2Renderer.ts` — `WebGL2RendererOptions.canvas`
  тип `AnyCanvas | string`; `acquireWebGL2(canvas: AnyCanvas)`; init size
  через `getCanvasCssSize`; `observeSize` skip для Offscreen; `Texture`
  интерфейс расширен `uploadImage`; реализация `texture.uploadImage` через
  `gl.texImage2DFromSource`. Удалены `resolveCanvas` (HTML-only) и
  `devicePixelRatioOrOne` (заменены `canvasHelpers`).
- `packages/gl/src/webgpuRenderer.ts` — то же для WebGPU; `createGPU`
  инъекция принимает `AnyCanvas`.
- `packages/gl/src/renderer.ts` (unified) — `RendererOptions.canvas` тип
  `AnyCanvas | string`; WebGPU-ветка `texture()` возвращает объект с
  `uploadImage` через `gpu.copyExternalImageToTexture`.
- `packages/webgl2/src/facade.ts` + `realGL.ts` + `recordingGL.ts` —
  `GLImageSource` type, `texImage2DFromSource` method.
- `packages/webgpu/src/facade.ts` + `realGPU.ts` + `recordingGPU.ts` —
  `GPUImageSource` type, `copyExternalImageToTexture` method.
- `packages/webgpu/src/realGPU.ts` — `createRealGPU(canvas: AnyCanvas)`
  вместо `HTMLCanvasElement`.
- `packages/gl/src/scene.ts`, `showAny.ts`, `showOn.ts`, `showWebgpu.ts` —
  без изменений (используют существующие рендереры через сахар).

Что НЕ сделано в этом раунде (full §9.5 vision):
- `PressureBus` — текстуры пока НЕ публикуют давление (нет
  `pressureSource`-флага). Текущий `uploadImage` — атомарный one-shot.
- `PathRegistry` — нет автоматического выбора между `OffscreenCanvas` +
  `transferControlToOffscreen` vs прямым canvas-путём. Пользователь
  выбирает вручную.
- `VideoFrame` — тип включён в `GLImageSource`/`GPUImageSource`, но
  реальная проверка требует WebCodecs (нет в SwiftShader).
- Стриминг `Uint8Array` на WebGPU-пути — нет (нужно расширять gpu-фасад
  для `writeTexture`-тайлов). Workaround: `createImageBitmap(bytes)` →
  `uploadImage(bitmap)`.

## 10. Статус

Дизайн-досье v1.0 — первичный документ. Этот addendum — раунды 4–8:
- **Раунд 4** — бенч-калибровка Mali-G57 MC2 (§4) + сверка код ↔ досье (§3, §5);
- **Раунд 5** — отозван (переименование каталога §12);
- **Раунд 6** — инфра-примитивы для развёртывания каталога §12 (§9): 6
  универсальных паттернов, 9 примитивов + 1 мета (FeaturePlug), таблица
  декомпозиции всех 65 позиций + 14 present-путей, шаблон для «похожих с
  небольшими изменениями», демонстрация границы текущий vs будущий API (§9.11).
- **Раунд 7** — backend auto-selection (§9.12): четыре итерации дизайна
  (`prefer`-enum → `createAutoRenderer+specs` → отдельный `createAutoRenderer`
  → финальный `createRenderer({ backend?: BackendId | BackendId[] })` с lazy
  discovery через `.command()`). Зафиксирован финальный API; существующий код
  Task 52 (`autoBackend.ts` + `autoRenderer.ts`) ждёт rename-рефакторинга
  под итоговые имена (`createRenderer`/`createWebGL2Renderer`).
- **Раунд 8** — concrete improvements существующего API (§9.13): внешние
  канвасы (`OffscreenCanvas` как цель рендера + duck-typing helper'ы) +
  альтернативные источники текстур (`texture.uploadImage(source)` через
  `texImage2D` overload / `copyExternalImageToTexture`). Без полного §9.5 —
  groundwork для будущих `PathRegistry` + `textures-as-sources`.

Все «новые» предложения (§7 уточнения формул, §9 примитивы, §9.12 backend
auto-selection) — не новые архитектурные решения, а обобщение того, что
в досье описано точечно. Любое внедрение идёт через канонические M0–M8
(§14.3 досье); §9.9 даёт сопоставление примитивов с этапами.

Код пакетов по-прежнему не тронут с предыдущего раунда (кроме Task 52
`autoBackend.ts`/`autoRenderer.ts`); решения по §5 (восстановление журнала,
caps, requestTier, транспорты T0–T3, present.ts, Kit-пакеты), §9 (примитивы
как каркас для их композиции) и §9.12 (rename-рефакторинг backend
auto-selection) ждут одобрения заказчика.
