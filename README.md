# rune

[![ci](https://github.com/atolbat/rune/actions/workflows/ci.yml/badge.svg)](https://github.com/atolbat/rune/actions/workflows/ci.yml)

Единый рендерер WebGL2 / WebGPU. Декларативные команды в духе regl,
реактивность на сигналах, ленты (tape) как валюта кадра. Чистая TypeScript-библиотека:
ноль runtime-зависимостей, DOM-free ядро, tests-first разработка.

## Пакеты

| Пакет | Содержание |
|--------|------------|
| `@rune/core` | Сигналы (версии/dirty), эпохи, ленты SoA, сегментный кэш live, std140-арена юниформов (value-compare, fround), AIMD-стриминг (куча приоритетов, окно байтов 2/16 МиБ, demand-бёрст), transient-пул, LayoutGuard. DOM-free по построению |
| `@rune/math` | Колонко-мажорные mat4 (WebGL-конвенция): out-первый стиль, ноль аллокаций на горячем пути |
| `@rune/prims` | Процедурные примитивы: cube с UV и полным размахом граней (6 регрессионных тестов), полноэкранный quad, каталог SHAPES для UI, адаптивный/квадтри-террейн |
| `@rune/webgl2` | Бэкенд WebGL2: GLSL-рефлексия, компилятор DrawSpec, executor лент (юниформы по имени, state-кэш, BindTarget), realGL (FBO-цели с depth-рендербуфером) + recordingGL |
| `@rune/webgpu` | Бэкенд WebGPU: WGSL-рефлексия, slice-арена 256-align, компилятор, executor (dynamic offsets, аплоады до пасса), realGPU (writeTexture origin, ленивые пайплайны, пассы на поверхности) + recordingGPU |
| `@rune/gl` | Мета-пакет: `createRenderer` / `createWebGpuRenderer` (авто-цикл, DPR, LayoutGuard, idle-слот стриминга), `surface()`/`pass()`, `show()` / `showOnWebGpu()` / `showAny()` / `showOn()` |
| `@rune/scene` | Плоский data-oriented сценовый граф: камеры, фрустум-отсечение, инстанс-группы, вынос конвейера в воркер поверх SharedArrayBuffer |
| `@rune/tape` | Запись лент в воркерах без GPU и проигрывание на владельце: stub-ленты, доставка кадров, кросс-мировой replay |
| `@rune/loaders` | Потоковые парсеры ассетов без GPU-кода: GLB/glTF, OBJ, MTL, FBX (бинарный и ASCII), картинки, конфиги; планировщик загрузки с AIMD-дисциплиной, `AssetLibrary` с LRU-кэшем |
| `@rune/kit` | Высокоуровневые утилиты поверх `@rune/gl`: AssetCache с refcount/TTL/churn-window, композитинг-гигиена канваса |
| `@rune/debug` | Инструменты отладки (этап M8 дорожной карты) |

## Установка

```bash
bun add @rune/gl
```

Библиотека распространяется в исходниках TypeScript (`exports` указывает на
`src/index.ts`) — бандлер или `bun` исполняют её напрямую, шаг сборки не нужен.

## Быстрый старт

Проход «N входов → фрагментный шейдер → цель» — единая структура *surface + pass*,
пишется в ту же ленту (opcode BindTarget) и работает в любом рендер-пассе:

```ts
import { createRenderer } from '@rune/gl'

const renderer = await createRenderer(canvas)   // авто-выбор бэкенда
const scene = renderer.surface({ width: 800, height: 600, depth: true })
const present = renderer.pass(FRAG, { inputs: { u_src: scene.texture } })

renderer.frame((ctx, record) => {
  record(scene.capture(drawCube), { mvp, model })  // сцена → поверхность
  record(present)                                  // поверхность → канвас
})
```

- **Генерация**: `surface.pass(FRAG)` — без входов, в поверхность; билтин-юниформы
  `u_time` / `u_resolution` / `u_texel` подставляются по объявлению.
- **Показ**: `renderer.pass(FRAG, { inputs: { u_src: texture } })` — на канвас.
- **Постпроцессинг**: `capture()` + цепочка pass'ов; каждая поверхность — и цель, и вход
  (pingpong из двух surface работает).
- Пользователь пишет только фрагментную стадию (GLSL `in vec2 v_uv` / WGSL
  `fsMain(@location(0) uv)`) — вершинную генерирует рантайм (quad из `@rune/prims`).
- v1 WebGPU: один текстурный вход на проход (bind-группа group 1).

## Разработка

```bash
bun install        # зависимости (workspace-симлинки чинит postinstall)
bun run lint       # ESLint (js.recommended + ts-eslint.recommended) — только packages/*/src
bun run typecheck  # строгие типы, 0 ошибок
bun run build      # сборка бандлов в dist/ (см. ниже)
bun test           # полный набор юнит/интеграционных тестов
```

Требуется Bun ≥ 1.1. CI (`​.github/workflows/ci.yml`) на каждый push в `dev`/`main`
и на PR прогоняет: lint → typecheck → build → test, затем headless-смок демо
в Chromium (SwiftShader). Артефакт `dist/` выкладывается на каждый пуш.

Разработка ведётся в ветке `dev`; `main` обновляется только вручную.

Тяжёлые бинарные фикстуры (например, Mixamo FBX в `@rune/loaders`) в репозиторий
не входят: соответствующие тесты включаются автоматически, если положить файл
по пути, указанному в тесте.

## Сборка

`bun run build` производит самодостаточные ESM-бандлы в `dist/`:

| Артефакт | Содержание |
|----------|------------|
| `rune.esm.js` | Мета-пакет `@rune/gl` целиком (core/math/prims/webgl2/webgpu) |
| `rune.esm.min.js` | Минифицированная копия с sourcemap |
| `rune-loaders.esm.js` | `@rune/loaders` (GLB/glTF, OBJ, FBX — без GPU-кода) |

Типы отдельно не собираются: библиотека распространяется в исходниках TS —
bun и бандлеры берут типы прямо из `src` через `exports`.

## Демо

`demo/` — страница, импортирующая собранный бандл: вращающийся куб через
`showAny()` (WebGPU с авто-фолбэком на WebGL2), бейдж бэкенда, пауза/резюм.

```bash
bun run demo        # сборка + статический сервер на http://localhost:8080/
bun run demo:smoke  # headless-проверка (Playwright + SwiftShader): анимация,
                    # бейдж, пауза, отсутствие ошибок консоли
```

## Дизайн-досье

Проектная документация живёт в [`docs/DESIGN.md`](docs/DESIGN.md) — addendum к
досье v1.0: сверка каталога оптимизаций, Контракт 4 (tier-лестница адаптера),
бенч-калибровка Mali-G57 MC2.

## Стиль кода

Мельчайшие внутренние функции; имена несут контракт; один скрытый класс на
сущность; ноль аллокаций на горячем пути кадра. Каждый этап: теория →
бенчмарк → победитель в дефолт. Юнит-тест порядка вызовов на рекордере
обязателен для tape-путей.

## Лицензия

[MIT](LICENSE)
