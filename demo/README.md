# Демо rune

Живые примеры работы рендерера. Каждое демо — **в своей папке** внутри `demo/`,
ссылается на **собранный бандл** библиотеки (`dist/rune.esm.js`) и имеет
стандартный каркас: мобильная вёрстка, тумблер бэкендов, лог-панель.

## Демо онлайн (GitHub Pages)

| Демо | Ссылка | Что показывает |
|------|--------|----------------|
| hello-cube | https://atolbat.github.io/rune/demo/hello-cube/ | Куб в одну строку: `showAny()` / `showOn()`, тумблер Авто/WebGL2/WebGPU, лог с копированием |
| model-viewer | https://atolbat.github.io/rune/demo/model-viewer/ | Три модели three.js examples: Forest House (glTF · AVIF · Draco), Samba Dancing (FBX), Nefertiti (glTF · object-space normal map). Кнопка «Загрузить» с прогресс-баром (`AssetLoader`), переключение моделей, вращение драгом, dual-source шейдеры GLSL+WGSL |

Обзор всех демо: **https://atolbat.github.io/rune/demo/**

Деплой автоматический: Pages настроен на **деплой из ветки `dev`** (корень
репозитория), поэтому демо работают сразу после пуша — собранный бандл
`dist/` коммитится вместе с демо (`.nojekyll` отключает Jekyll-обработку).
После изменений `packages/*/src` не забудьте `bun run build` и закоммитить
обновлённый `dist/` — CI предупреждает, если бандл в ветке устарел.

## Локальный запуск

```sh
bun install
bun run demo        # = build + статический сервер на :8080
```

Открыть: http://localhost:8080/demo/hello-cube/ (обзор — на `/demo/`).

Можно и без нашего сервера — любой статический сервер из корня репозитория
после `bun run build` (демо тянет `dist/rune.esm.js` относительным путём).

## Стандарт демо (обязательно для каждого нового демо)

1. **Своя папка**: `demo/<имя-демо>/` с `index.html` + `main.js`.
2. **Каркас-шелл**: подключить `../shared/demo-shell.css` и
   `../shared/demo-shell.js`, размечать только `<div id="app"></div>` —
   шапку, сцену, тумблер, лог рисует шелл (см. `demo/hello-cube/main.js`).
3. **Мобильная вёрстка**: канвас на всю ширину, тач-цели ≥ 44 px — это даёт
   шелл, не дублировать свою вёрстку.
4. **Тумблер бэкендов** Авто / WebGL2 / WebGPU (`onMode` → перезапуск сцены
   через `showAny`/`showOn`; отказ форсированного бэкенда — сообщение в лог,
   а не тишина).
5. **Лог-панель с кнопкой «Копировать»**: перехват `console.error/warn`,
   `window.onerror`, `unhandledrejection`, отказ WebGPU и watchdog «модуль
   не загрузился за 6 с» — всё уже внутри шелла. В лог пишем ключевые
   события (`shell.log.event/info/error`), чтобы по скопированному тексту
   можно было понять, что происходило.
6. **Путь к бандлу**: из папки демо — `../../dist/rune.esm.js`.
7. **Регистрация**: добавить карточку в `demo/index.html` (галерея) и строку
   в таблицу выше (ссылка в формате `https://atolbat.github.io/rune/demo/<имя>/`).
8. **Смок-тест**: если демо графическое — добавить проверки в
   `scripts/demo-smoke.mjs` (бейдж, живая анимация, тумблер, лог).

## Файлы

```
demo/
├── index.html          — галерея (посадочная на Pages: /rune/demo/)
├── README.md           — этот файл: ссылки + стандарт демо
├── shared/
│   ├── demo-shell.css  — общий стиль (mobile-first, тёмная тема)
│   └── demo-shell.js   — каркас: тумблер бэкендов, лог с копированием, watchdog
├── hello-cube/         — демо «куб в одну строку»
│   ├── index.html
│   └── main.js
└── model-viewer/       — демо «сцена с загрузчиком» (три модели three.js)
    ├── index.html
    ├── main.js
    └── assets/         — forest_house.glb, Nefertiti.glb, samba.fbx
                          + draco_wasm_wrapper.js / draco_decoder.wasm
```
