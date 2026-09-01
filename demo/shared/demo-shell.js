/*
 * demo/shared/demo-shell.js — общий каркас ВСЕХ демо rune (стандарт демо).
 *
 * Даёт каждому демо:
 *   1. мобильную вёрстку (канвас на всю ширину, тач-цели >= 44px);
 *   2. тумблер бэкендов Авто / WebGL2 / WebGPU (сегментированный контрол);
 *   3. лог-панель «ошибки и события» с кнопкой «Копировать»: перехватывает
 *      console.error/warn, window.onerror, unhandledrejection, отказ WebGPU
 *      (#reason от showAny) и падение загрузки самого демо-модуля (watchdog).
 *
 * Сценарий отказоустойчивости: скрипт классический (не module) — работает
 * даже там, где ES-модули не грузятся (file://). Если демо-модуль не вызвал
 * markReady() за 6 с, лог сам объясняет вероятную причину (нет бандла,
 * открыто через file://, Pages не задеплоен).
 *
 * Подключение:
 *   <link rel="stylesheet" href="../shared/demo-shell.css">
 *   <div id="app"></div>
 *   <script src="../shared/demo-shell.js"></script>
 *   <script type="module" src="./main.js"></script>
 *
 * API (см. mount ниже): shell.slot, shell.setBadge(text, kind),
 * shell.markReady(), shell.log.{info,event,warn,error}, shell.mode,
 * опции mount: { title, desc, hint, defaults:{mode}, onMode, onPause, onResume }.
 */
(function () {
  'use strict'

  var SHELL_VERSION = '1.0.0'
  var MAX_ENTRIES = 400
  var READY_TIMEOUT_MS = 6000

  function mount(options) {
    var opts = {
      title: 'rune demo',
      desc: '',
      hint: '',
      defaults: { mode: 'auto' },
      onMode: null,
      onPause: null,
      onResume: null,
    }
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined) {
        opts[key] = options[key]
      }
    }

    var app = document.getElementById('app')
    if (app === null) throw new Error('RuneDemoShell: в HTML нет <div id="app">')

    app.innerHTML =
      '<header class="rd-head">' +
      '  <h1 class="rd-title"></h1>' +
      '  <p class="rd-desc"></p>' +
      '</header>' +
      '<section class="rd-stage" id="rd-stage">' +
      '  <div class="rd-slot" id="rd-slot"></div>' +
      '  <span class="rd-badge" id="backend">\u2026</span>' +
      '  <pre class="rd-reason" id="reason"></pre>' +
      '</section>' +
      '<section class="rd-toolbar">' +
      '  <div class="rd-seg" role="radiogroup" aria-label="Бэкенд">' +
      '    <input type="radio" name="rd-mode" id="mode-auto" value="auto">' +
      '    <label for="mode-auto">Авто</label>' +
      '    <input type="radio" name="rd-mode" id="mode-webgl2" value="webgl2">' +
      '    <label for="mode-webgl2">WebGL2</label>' +
      '    <input type="radio" name="rd-mode" id="mode-webgpu" value="webgpu">' +
      '    <label for="mode-webgpu">WebGPU</label>' +
      '  </div>' +
      '  <div class="rd-actions">' +
      '    <button type="button" class="rd-btn" id="pause">Пауза</button>' +
      '    <button type="button" class="rd-btn" id="resume">Продолжить</button>' +
      '  </div>' +
      '</section>' +
      '<section class="rd-log" id="rd-log">' +
      '  <div class="rd-log-bar">' +
      '    <button type="button" class="rd-btn" id="log-toggle" aria-expanded="true">Лог <span class="rd-count" id="log-count">0</span></button>' +
      '    <span class="rd-log-title">ошибки и события</span>' +
      '    <div class="rd-actions">' +
      '      <button type="button" class="rd-btn" id="log-copy">Копировать</button>' +
      '      <button type="button" class="rd-btn" id="log-clear">Очистить</button>' +
      '    </div>' +
      '  </div>' +
      '  <ol class="rd-log-list" id="log-list"></ol>' +
      '</section>' +
      '<p class="rd-hint"></p>'

    app.querySelector('.rd-title').textContent = opts.title
    app.querySelector('.rd-desc').textContent = opts.desc
    app.querySelector('.rd-hint').innerHTML = opts.hint

    var slot = app.querySelector('#rd-slot')
    var badge = app.querySelector('#backend')
    var reason = app.querySelector('#reason')
    var logSection = app.querySelector('#rd-log')
    var logList = app.querySelector('#log-list')
    var logCount = app.querySelector('#log-count')
    var logToggle = app.querySelector('#log-toggle')

    /* ---------- лог ---------- */

    var entries = [] // { time, level, msg }
    var unread = 0
    var errorCount = 0
    var collapsed = false

    function timestamp() {
      var d = new Date()
      var pad = function (n, w) { return String(n).padStart(w || 2, '0') }
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3)
    }

    function render(entry) {
      var li = document.createElement('li')
      li.className = 'rd-entry rd-entry--' + entry.level
      var time = document.createElement('time')
      time.textContent = entry.time
      var level = document.createElement('span')
      level.className = 'rd-level'
      level.textContent = entry.level === 'error' ? 'ERROR' : entry.level === 'warn' ? 'WARN' : entry.level === 'event' ? 'EVENT' : 'INFO'
      var msg = document.createElement('span')
      msg.className = 'rd-msg'
      msg.textContent = entry.msg
      li.append(time, level, msg)
      return li
    }

    function autoscroll() {
      logList.scrollTop = logList.scrollHeight
    }

    function updateCounter() {
      logCount.textContent = String(entries.length)
      logCount.classList.toggle('rd-count--err', errorCount > 0)
      logToggle.textContent = ''
      logToggle.append('Лог ', logCount)
      if (collapsed && unread > 0) logToggle.append(' (+' + unread + ')')
    }

    function push(level, msg) {
      var text = String(msg)
      if (text.length > 2000) text = text.slice(0, 2000) + ' …[обрезано]'
      var entry = { time: timestamp(), level: level, msg: text }
      entries.push(entry)
      if (entries.length > MAX_ENTRIES) {
        entries.shift()
        if (logList.firstElementChild !== null) logList.firstElementChild.remove()
      }
      if (level === 'error') errorCount++
      if (collapsed) unread++
      logList.append(render(entry))
      updateCounter()
      autoscroll()
    }

    var log = {
      info: function (msg) { push('info', msg) },
      event: function (msg) { push('event', msg) },
      warn: function (msg) { push('warn', msg) },
      error: function (msg) { push('error', msg) },
    }

    /* перехват консоли (оригиналы вызываются дальше — devtools не страдают) */
    var nativeError = console.error.bind(console)
    var nativeWarn = console.warn.bind(console)
    console.error = function () {
      push('error', formatArgs(arguments))
      nativeError.apply(null, arguments)
    }
    console.warn = function () {
      push('warn', formatArgs(arguments))
      nativeWarn.apply(null, arguments)
    }

    function formatValue(value) {
      if (value instanceof Error) return value.stack !== undefined ? value.stack : value.message
      if (typeof value === 'object' && value !== null) {
        try { return JSON.stringify(value) } catch (error) { return String(value) }
      }
      return String(value)
    }

    function formatArgs(args) {
      var parts = []
      for (var i = 0; i < args.length; i++) parts.push(formatValue(args[i]))
      return parts.join(' ')
    }

    /* глобальные ошибки страницы */
    window.addEventListener('error', function (event) {
      var where = event.filename !== undefined ? ' (' + event.filename.split('/').pop() + ':' + event.lineno + ')' : ''
      push('error', 'window.onerror: ' + event.message + where)
    })
    window.addEventListener('unhandledrejection', function (event) {
      push('error', 'unhandledrejection: ' + formatValue(event.reason))
    })

    /* отказ WebGPU из showAny: библиотека пишет в #reason — дублируем в лог */
    var reasonObserver = new MutationObserver(function () {
      var text = (reason.textContent || '').trim()
      if (text !== '') push('warn', text.replace(/\s+/g, ' '))
    })
    reasonObserver.observe(reason, { childList: true, characterData: true, subtree: true })

    /* ---------- панель лога: свернуть/развернуть, копировать, очистить ---------- */

    function setCollapsed(state) {
      collapsed = state
      logSection.classList.toggle('rd-collapsed', state)
      logToggle.setAttribute('aria-expanded', String(!state))
      if (!state) unread = 0
      updateCounter()
    }

    logToggle.addEventListener('click', function () { setCollapsed(!collapsed) })

    app.querySelector('#log-clear').addEventListener('click', function () {
      entries = []
      errorCount = 0
      logList.replaceChildren()
      updateCounter()
    })

    app.querySelector('#log-copy').addEventListener('click', function () {
      var text = buildReport()
      copyText(text, this)
    })

    function buildReport() {
      var head = [
        'rune demo log — ' + opts.title,
        'url: ' + location.href,
        'time: ' + new Date().toISOString(),
        'viewport: ' + window.innerWidth + 'x' + window.innerHeight + ' (dpr ' + window.devicePixelRatio + ')',
        'mode: ' + currentMode(),
        'ua: ' + navigator.userAgent,
        'entries: ' + entries.length,
        '---',
      ]
      var lines = entries.map(function (entry) {
        return '[' + entry.time + '] ' + entry.level.toUpperCase() + ': ' + entry.msg
      })
      return head.concat(lines).join('\n')
    }

    function copyText(text, button) {
      var done = function (via) {
        log.event('Лог скопирован в буфер (' + via + ', ' + entries.length + ' записей)')
        if (button) {
          var original = button.textContent
          button.textContent = 'Скопировано'
          setTimeout(function () { button.textContent = original }, 1500)
        }
      }
      var fail = function (error) {
        log.error('Не удалось скопировать лог: ' + formatValue(error))
      }
      if (navigator.clipboard !== undefined && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done('clipboard API') }, function (error) {
          legacyCopy(text) ? done('textarea fallback') : fail(error)
        })
      } else {
        legacyCopy(text) ? done('textarea fallback') : fail(new Error('clipboard недоступен (нужен https или localhost)'))
      }
    }

    function legacyCopy(text) {
      try {
        var area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.append(area)
        area.select()
        var ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch (error) {
        return false
      }
    }

    /* ---------- тумблер бэкендов ---------- */

    function currentMode() {
      var checked = app.querySelector('input[name="rd-mode"]:checked')
      return checked !== null ? checked.value : 'auto'
    }

    app.querySelector('.rd-seg').addEventListener('change', function (event) {
      if (event.target !== null && event.target.name === 'rd-mode') {
        opts.onMode !== null && opts.onMode(event.target.value)
      }
    })

    /* ---------- пауза / продолжить ---------- */

    app.querySelector('#pause').addEventListener('click', function () { opts.onPause !== null && opts.onPause() })
    app.querySelector('#resume').addEventListener('click', function () { opts.onResume !== null && opts.onResume() })

    /* ---------- бейдж ---------- */

    function setBadge(text, kind) {
      badge.textContent = text
      badge.className = 'rd-badge' + (kind !== undefined ? ' rd-badge--' + kind : '')
    }

    /* ---------- watchdog: демо-модуль не инициализировался ---------- */

    var ready = false
    function markReady() {
      if (ready) return
      ready = true
      push('event', 'Демо инициализировалось (shell ' + SHELL_VERSION + ')')
      updateCounter()
    }

    if (location.protocol === 'file:') {
      log.warn('Страница открыта через file:// — ES-модули и fetch при этом не работают. Запустите локально: bun run demo → http://localhost:8080/demo/ или откройте GitHub Pages-ссылку из demo/README.md.')
      setBadge('file:// не поддерживается', 'err')
    }
    log.event('Shell ' + SHELL_VERSION + ' запущен')
    log.info('URL: ' + location.href)
    log.info('Viewport: ' + window.innerWidth + 'x' + window.innerHeight + ', DPR ' + window.devicePixelRatio)

    setTimeout(function () {
      if (ready) return
      push('error', 'Демо-модуль не инициализировался за ' + READY_TIMEOUT_MS / 1000 + ' с. Вероятные причины:')
      push('info', '1) не собран бандл — выполните bun run build (или bun run demo); 2) страница открыта через file:// — нужен сервер; 3) на GitHub Pages — проверьте, что workflow pages прошёл и dist/ задеплоен; 4) ошибка в main.js — см. ERROR-записи выше.')
      setBadge('демо не запустилось', 'err')
      setCollapsed(false)
    }, READY_TIMEOUT_MS)

    /* ---------- публичный API ---------- */

    var initialMode = opts.defaults.mode
    var defaultRadio = app.querySelector('input[name="rd-mode"][value="' + initialMode + '"]')
    if (defaultRadio !== null) defaultRadio.checked = true

    return {
      slot: slot,
      log: log,
      setBadge: setBadge,
      markReady: markReady,
      get mode() { return currentMode() },
    }
  }

  window.RuneDemoShell = { mount: mount, version: SHELL_VERSION }
})()
