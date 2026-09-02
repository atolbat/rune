/*
 * demo/shared/demo-shell.js — shared shell for every rune demo (the demo standard).
 *
 * It gives each demo:
 *   1. a mobile-first layout (the canvas spans the full width, touch targets >= 44px);
 *   2. an Auto / WebGL2 / WebGPU backend toggle (segmented control);
 *   3. an "errors & events" log panel with a Copy button: it intercepts
 *      console.error/warn, window.onerror, unhandledrejection, WebGPU refusal
 *      (#reason from showAny) and demo-module load failures (watchdog).
 *
 * Layouts (mount option `layout`):
 *   'page'       — documentation-style page: header, stage, toolbar, log (default);
 *   'fullscreen' — immersive viewer: the stage fills the whole viewport and all
 *                  controls hide behind a compact menu button (FAB) — built
 *                  mobile-first, maximally compact.
 *
 * Failure resilience: this script is classic (not a module) — it keeps working
 * where ES modules fail to load (file://). If the demo module has not called
 * markReady() within 6 s, the log explains the likely cause (missing bundle,
 * opened via file://, Pages not deployed).
 *
 * Wiring:
 *   <link rel="stylesheet" href="../shared/demo-shell.css">
 *   <div id="app"></div>
 *   <script src="../shared/demo-shell.js"></script>
 *   <script type="module" src="./main.js"></script>
 *
 * API (see mount below): shell.slot, shell.setBadge(text, kind), shell.markReady(),
 * shell.log.{info,event,warn,error}, shell.mode; mount options:
 * { layout, title, desc, hint, defaults:{mode}, onMode, onPause, onResume }.
 */
(function () {
  'use strict'

  var SHELL_VERSION = '1.1.0'
  var MAX_ENTRIES = 400
  var READY_TIMEOUT_MS = 6000

  function mount(options) {
    var opts = {
      layout: 'page',
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
    if (app === null) throw new Error('RuneDemoShell: <div id="app"> is missing in the HTML')

    var fullscreen = opts.layout === 'fullscreen'
    if (fullscreen) document.body.classList.add('rd-fs')

    var SEG =
      '<div class="rd-seg" role="radiogroup" aria-label="Backend">' +
      '  <input type="radio" name="rd-mode" id="mode-auto" value="auto">' +
      '  <label for="mode-auto">Auto</label>' +
      '  <input type="radio" name="rd-mode" id="mode-webgl2" value="webgl2">' +
      '  <label for="mode-webgl2">WebGL2</label>' +
      '  <input type="radio" name="rd-mode" id="mode-webgpu" value="webgpu">' +
      '  <label for="mode-webgpu">WebGPU</label>' +
      '</div>'

    var ACTIONS =
      '<div class="rd-actions">' +
      '  <button type="button" class="rd-btn" id="pause">Pause</button>' +
      '  <button type="button" class="rd-btn" id="resume">Resume</button>' +
      '</div>'

    var LOG =
      '<section class="rd-log' + (fullscreen ? ' rd-collapsed' : '') + '" id="rd-log">' +
      '  <div class="rd-log-bar">' +
      '    <button type="button" class="rd-btn" id="log-toggle" aria-expanded="' + String(!fullscreen) + '">Log <span class="rd-count" id="log-count">0</span></button>' +
      (fullscreen ? '' : '<span class="rd-log-title">errors & events</span>') +
      '    <div class="rd-actions">' +
      '      <button type="button" class="rd-btn" id="log-copy">Copy</button>' +
      '      <button type="button" class="rd-btn" id="log-clear">Clear</button>' +
      '    </div>' +
      '  </div>' +
      '  <ol class="rd-log-list" id="log-list"></ol>' +
      '</section>'

    var STAGE =
      '<section class="rd-stage" id="rd-stage">' +
      '  <div class="rd-slot" id="rd-slot"></div>' +
      '  <span class="rd-badge" id="backend">\u2026</span>' +
      '  <pre class="rd-reason" id="reason"></pre>' +
      '</section>'

    app.innerHTML = fullscreen
      ? STAGE +
        '<button type="button" class="rd-fab" id="rd-fab" aria-label="Menu" aria-expanded="false" aria-controls="rd-sheet">\u2630</button>' +
        '<div class="rd-sheet" id="rd-sheet" hidden>' +
        '  <div class="rd-sheet-head"><span class="rd-sheet-title"></span></div>' +
        SEG +
        ACTIONS +
        LOG +
        '</div>'
      : '<header class="rd-head">' +
        '  <h1 class="rd-title"></h1>' +
        '  <p class="rd-desc"></p>' +
        '</header>' +
        STAGE +
        '<section class="rd-toolbar">' +
        SEG +
        ACTIONS +
        '</section>' +
        LOG +
        '<p class="rd-hint"></p>'

    if (fullscreen) {
      app.querySelector('.rd-sheet-title').textContent = opts.title
    } else {
      app.querySelector('.rd-title').textContent = opts.title
      app.querySelector('.rd-desc').textContent = opts.desc
      app.querySelector('.rd-hint').innerHTML = opts.hint
    }

    var slot = app.querySelector('#rd-slot')
    var badge = app.querySelector('#backend')
    var reason = app.querySelector('#reason')
    var logSection = app.querySelector('#rd-log')
    var logList = app.querySelector('#log-list')
    var logCount = app.querySelector('#log-count')
    var logToggle = app.querySelector('#log-toggle')
    var fab = app.querySelector('#rd-fab')
    var sheet = app.querySelector('#rd-sheet')

    /* ---------- log ---------- */

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
      logToggle.append('Log ', logCount)
      if (collapsed && unread > 0) logToggle.append(' (+' + unread + ')')
    }

    function push(level, msg) {
      var text = String(msg)
      if (text.length > 2000) text = text.slice(0, 2000) + ' \u2026[truncated]'
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

    /* console interception (originals still fire — devtools keep working) */
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

    /* page-level global errors */
    window.addEventListener('error', function (event) {
      var where = event.filename !== undefined ? ' (' + event.filename.split('/').pop() + ':' + event.lineno + ')' : ''
      push('error', 'window.onerror: ' + event.message + where)
    })
    window.addEventListener('unhandledrejection', function (event) {
      push('error', 'unhandledrejection: ' + formatValue(event.reason))
    })

    /* WebGPU refusal from showAny: the library writes into #reason — mirror it into the log */
    var reasonObserver = new MutationObserver(function () {
      var text = (reason.textContent || '').trim()
      if (text !== '') push('warn', text.replace(/\s+/g, ' '))
    })
    reasonObserver.observe(reason, { childList: true, characterData: true, subtree: true })

    /* ---------- log panel: collapse/expand, copy, clear ---------- */

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
        log.event('Log copied to clipboard (' + via + ', ' + entries.length + ' entries)')
        if (button) {
          var original = button.textContent
          button.textContent = 'Copied'
          setTimeout(function () { button.textContent = original }, 1500)
        }
      }
      var fail = function (error) {
        log.error('Failed to copy log: ' + formatValue(error))
      }
      if (navigator.clipboard !== undefined && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done('clipboard API') }, function (error) {
          legacyCopy(text) ? done('textarea fallback') : fail(error)
        })
      } else {
        legacyCopy(text) ? done('textarea fallback') : fail(new Error('clipboard unavailable (https or localhost required)'))
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

    /* ---------- backend toggle ---------- */

    function currentMode() {
      var checked = app.querySelector('input[name="rd-mode"]:checked')
      return checked !== null ? checked.value : 'auto'
    }

    app.querySelector('.rd-seg').addEventListener('change', function (event) {
      if (event.target !== null && event.target.name === 'rd-mode') {
        opts.onMode !== null && opts.onMode(event.target.value)
      }
    })

    /* ---------- pause / resume ---------- */

    app.querySelector('#pause').addEventListener('click', function () { opts.onPause !== null && opts.onPause() })
    app.querySelector('#resume').addEventListener('click', function () { opts.onResume !== null && opts.onResume() })

    /* ---------- fullscreen: FAB + sheet (compact, hidden by default) ---------- */

    function setSheetOpen(open) {
      sheet.hidden = !open
      fab.setAttribute('aria-expanded', String(open))
    }

    if (fullscreen) {
      fab.addEventListener('click', function () { setSheetOpen(sheet.hidden) })
      /* tap anywhere outside the sheet (e.g. on the scene) closes it */
      document.addEventListener('pointerdown', function (event) {
        if (sheet.hidden) return
        var target = event.target
        if (target instanceof Node && (sheet.contains(target) || fab.contains(target))) return
        setSheetOpen(false)
      })
    }

    /* ---------- badge ---------- */

    function setBadge(text, kind) {
      badge.textContent = text
      badge.className = 'rd-badge' + (kind !== undefined ? ' rd-badge--' + kind : '')
    }

    /* ---------- watchdog: the demo module never initialized ---------- */

    var ready = false
    function markReady() {
      if (ready) return
      ready = true
      push('event', 'Demo initialized (shell ' + SHELL_VERSION + ')')
      updateCounter()
    }

    if (location.protocol === 'file:') {
      log.warn('The page is opened via file:// — ES modules and fetch do not work this way. Run locally: bun run demo \u2192 http://localhost:8080/demo/ or open the GitHub Pages link from demo/README.md.')
      setBadge('file:// not supported', 'err')
    }
    log.event('Shell ' + SHELL_VERSION + ' started')
    log.info('URL: ' + location.href)
    log.info('Viewport: ' + window.innerWidth + 'x' + window.innerHeight + ', DPR ' + window.devicePixelRatio)

    setTimeout(function () {
      if (ready) return
      push('error', 'The demo module did not initialize within ' + READY_TIMEOUT_MS / 1000 + ' s. Likely causes:')
      push('info', '1) the bundle is not built — run bun run build (or bun run demo); 2) the page is opened via file:// — a server is required; 3) on GitHub Pages — check that the pages workflow ran and dist/ is deployed; 4) an error in main.js — see the ERROR entries above.')
      setBadge('demo failed to start', 'err')
      setCollapsed(false)
      if (fullscreen) setSheetOpen(true)
    }, READY_TIMEOUT_MS)

    /* ---------- public API ---------- */

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
