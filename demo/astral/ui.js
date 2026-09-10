// "astral" demo — the HTML UI layer: the resource bar, the contextual panel,
// the world labels and the outcome overlay. Plain DOM on top of the shell's
// fullscreen stage (the model-viewer pattern — the canvas fills the viewport,
// the UI floats). Labels are world-projected each frame (the vfx "labels
// projected" standard).

import { BUILDINGS, SHIPS, TECHS, OWNER, production } from './galaxy.js?v=1'
import { worldToScreen } from './shaders.js?v=3'

const ICON = { minerals: '◆', energy: '⚡', science: '✦' }

/** The settlement planet.buildings carries is not in BUILDINGS (it is not
 * buildable) — the panel labels it by name instead of crashing on undefined. */
const BUILDING_LABEL = { mine: BUILDINGS.mine.name, farm: BUILDINGS.farm.name, lab: BUILDINGS.lab.name, colony: 'Settlement' }

export function createUI(world, view, actions) {
  const root = document.createElement('div')
  root.className = 'as-root'

  // ── the top bar ──
  const top = document.createElement('div')
  top.className = 'as-top'
  const res = document.createElement('div')
  res.className = 'as-res'
  const resMin = chip('as-min')
  const resEnergy = chip('as-energy')
  const resSci = chip('as-sci')
  res.append(resMin.el, resEnergy.el, resSci.el)

  const territory = document.createElement('div')
  territory.className = 'as-territory'
  const terrBar = document.createElement('div')
  terrBar.className = 'as-terr-bar'
  const terrYou = document.createElement('div')
  terrYou.className = 'as-terr-you'
  const terrRival = document.createElement('div')
  terrRival.className = 'as-terr-rival'
  terrBar.append(terrYou, terrRival)
  const terrLabel = document.createElement('span')
  terrLabel.className = 'as-terr-label'
  territory.append(terrBar, terrLabel)

  const speed = document.createElement('div')
  speed.className = 'as-speed'
  const speedButtons = []
  for (const s of [0, 1, 2, 4]) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = s === 0 ? '❚❚' : `${s}×`
    b.dataset.speed = String(s)
    b.addEventListener('click', () => actions.setSpeed(s))
    speedButtons.push(b)
    speed.append(b)
  }

  top.append(res, territory, speed)
  root.append(top)

  // ── the labels layer ──
  const labelLayer = document.createElement('div')
  labelLayer.className = 'as-labels'
  root.append(labelLayer)
  const systemLabels = world.systems.map(sys => {
    const el = document.createElement('div')
    el.className = 'as-label'
    const name = document.createElement('span')
    name.className = 'as-label-name'
    name.textContent = sys.name
    const sub = document.createElement('span')
    sub.className = 'as-label-sub'
    el.append(name, sub)
    el.style.display = 'none'
    labelLayer.append(el)
    return { sys, el, name, sub }
  })

  // ── the bottom panel ──
  const panel = document.createElement('div')
  panel.className = 'as-panel'
  const panelHead = document.createElement('div')
  panelHead.className = 'as-panel-head'
  const panelTitle = document.createElement('span')
  panelTitle.className = 'as-panel-title'
  const backBtn = document.createElement('button')
  backBtn.type = 'button'
  backBtn.className = 'as-back'
  backBtn.textContent = '← Galaxy'
  backBtn.hidden = true
  backBtn.addEventListener('click', () => actions.exitSystem())
  panelHead.append(panelTitle, backBtn)
  const panelBody = document.createElement('div')
  panelBody.className = 'as-panel-body'
  panel.append(panelHead, panelBody)
  root.append(panel)

  // ── the outcome overlay ──
  const overlay = document.createElement('div')
  overlay.className = 'as-overlay'
  overlay.hidden = true
  const overlayCard = document.createElement('div')
  overlayCard.className = 'as-overlay-card'
  const overlayTitle = document.createElement('h2')
  const overlayText = document.createElement('p')
  const restart = document.createElement('button')
  restart.type = 'button'
  restart.textContent = 'New galaxy'
  restart.addEventListener('click', () => actions.restart())
  overlayCard.append(overlayTitle, overlayText, restart)
  overlay.append(overlayCard)
  root.append(overlay)

  // ── the hint ──
  const hint = document.createElement('div')
  hint.className = 'as-hint'
  hint.textContent = 'drag to pan · pinch to zoom · twist to rotate · tap a system, tap again to enter'
  root.append(hint)
  let hintKilled = false
  const killHint = () => { if (!hintKilled) { hintKilled = true; hint.classList.add('as-gone') } }
  setTimeout(killHint, 9000)

  document.body.append(root)

  // ── the label projection (called every frame — through the live MVP) ──
  const screenPt = { x: 0, y: 0 }
  function projectLabels(cam, w, h) {
    for (const label of systemLabels) {
      const sys = label.sys
      const pt = worldToScreen(sys.x, sys.y, w, h, screenPt)
      if (pt === null) { label.el.style.display = 'none'; continue }
      const sx = pt.x
      const sy = pt.y
      const margin = 70
      const visible = sx > -margin && sx < w + margin && sy > 30 && sy < h - 60
      const owned = sys.owner !== OWNER.NONE
      const zoomed = cam.z > 0.85
      if (!visible || (!owned && !zoomed && sys.id !== view.selectedSystem)) {
        label.el.style.display = 'none'
        continue
      }
      label.el.style.display = ''
      label.el.style.transform = `translate(${sx.toFixed(1)}px, ${(sy + 16).toFixed(1)}px)`
      label.el.classList.toggle('as-owned', sys.owner === OWNER.PLAYER)
      label.el.classList.toggle('as-rival', sys.owner === OWNER.RIVAL)
      label.name.textContent = sys.name
      if (sys.colonizing !== null) label.sub.textContent = `settling ${(sys.colonizing.progress * 100).toFixed(0)}%`
      else if (owned) label.sub.textContent = countBuildings(sys) > 0 ? `${countBuildings(sys)} builds · ${sys.planets.length}p` : `${sys.planets.length} planets`
      else label.sub.textContent = sys.planets.length > 0 ? `${sys.planets.length} planets` : 'no planets'
    }
  }

  // ── the top bar + panel refresh (throttled from the frame loop) ──
  let uiClock = 0
  function tick(dt, cam, w, h) {
    uiClock += dt
    projectLabels(cam, w, h)
    if (uiClock < 0.2) return
    uiClock = 0
    refreshTop()
    refreshPanel()
  }

  function refreshTop() {
    const { econ } = world
    const rates = production(world)
    resMin.el.textContent = `${ICON.minerals} ${econ.minerals.toFixed(0)} +${rates.minerals.toFixed(1)}`
    resEnergy.el.textContent = `${ICON.energy} ${econ.energy.toFixed(0)} +${rates.energy.toFixed(1)}`
    resSci.el.textContent = `${ICON.science} ${econ.science.toFixed(0)} +${rates.science.toFixed(1)}`

    let you = 0
    let rival = 0
    for (const sys of world.systems) {
      if (sys.owner === OWNER.PLAYER) you++
      else if (sys.owner === OWNER.RIVAL) rival++
    }
    const need = Math.ceil(world.colonizableCount * 0.6)
    const youPct = Math.min(100, (you / need) * 100)
    const rivalPct = Math.min(100, (rival / need) * 100)
    terrYou.style.width = `${youPct.toFixed(1)}%`
    terrRival.style.width = `${rivalPct.toFixed(1)}%`
    terrLabel.textContent = `${you} you · ${rival} Hegemony · goal ${need}`

    for (const b of speedButtons) {
      const active = Number(b.dataset.speed) === view.speed
      b.classList.toggle('as-active', active)
      b.setAttribute('aria-pressed', String(active))
    }
  }

  function refreshPanel() {
    killHint()
    backBtn.hidden = view.mode !== 'system'
    panel.classList.toggle('as-open', view.selectedSystem >= 0 || view.selectedShipObj !== null || view.selectedPlanet >= 0)
    const ship = view.selectedShipObj
    if (ship !== null) {
      panelTitle.textContent = `${SHIPS[ship.kind].name} “${actions.shipNameOf(ship)}”`
      renderShipPanel(ship)
      return
    }
    if (view.mode === 'system' && view.system !== null && view.selectedPlanet >= 0) {
      const planet = view.system.planets[view.selectedPlanet]
      if (planet !== undefined) {
        panelTitle.textContent = `${view.system.name} · ${planet.type.name}`
        renderPlanetPanel(view.system, planet)
        return
      }
    }
    const sys = view.system !== null ? view.system : world.systems[view.selectedSystem]
    if (sys === undefined || sys === null) {
      panelTitle.textContent = ''
      panelBody.replaceChildren()
      return
    }
    panelTitle.textContent = sys.name
    renderSystemPanel(sys)
  }

  function renderSystemPanel(sys) {
    panelBody.replaceChildren()
    const head = row()
    head.append(span('as-dim', `${sys.cls.name} · ${sys.planets.length} planets · ${sys.lanes.length} lanes`))
    if (sys.owner === OWNER.PLAYER) head.append(span('as-you', 'yours'))
    else if (sys.owner === OWNER.RIVAL) head.append(span('as-riv', 'Hegemony'))
    else head.append(span('as-neutral', 'unclaimed'))
    panelBody.append(head)

    if (sys.owner === OWNER.PLAYER) {
      // the build rows
      for (let pi = 0; pi < sys.planets.length; pi++) {
        const planet = sys.planets[pi]
        const r = row('as-planet-row')
        r.addEventListener('click', () => actions.selectPlanet(sys, pi))
        const label = span('as-planet-name', `● ${planet.type.name}`)
        label.style.color = rgbOf(planet.type.color)
        const info = span('as-dim', planetDesc(planet))
        r.append(label, info)
        panelBody.append(r)
      }
      // the ship buttons
      const r = row('as-actions')
      for (const kind of ['colony', 'war']) {
        const spec = SHIPS[kind]
        const b = button(`Build ${spec.name} · ${spec.cost.minerals}${ICON.minerals} ${spec.cost.energy}${ICON.energy}`)
        b.disabled = sys.shipQueue !== null || world.econ.minerals < spec.cost.minerals || world.econ.energy < spec.cost.energy
        b.addEventListener('click', () => actions.queueShip(sys, kind))
        r.append(b)
      }
      panelBody.append(r)
      if (sys.shipQueue !== null) {
        const q = row()
        const total = 10
        q.append(span('as-progress', `${SHIPS[sys.shipQueue.kind].name} — ${((sys.shipQueue.progress / total) * 100).toFixed(0)}%`))
        panelBody.append(q)
      }
    } else if (sys.owner === OWNER.NONE && sys.planets.length > 0) {
      const idle = world.ships.filter(s => s.kind === 'colony' && s.state === 'idle')
      const r = row('as-actions')
      const b = button(idle.length > 0 ? `Send nearest colony ship (${idle.length} ready)` : 'No idle colony ships — build one first')
      b.disabled = idle.length === 0
      b.addEventListener('click', () => actions.sendNearestColony(sys))
      r.append(b)
      panelBody.append(r)
      if (sys.colonizing !== null) {
        panelBody.append(span('as-progress', `settling — ${(sys.colonizing.progress * 100).toFixed(0)}%`))
      }
    } else if (sys.owner === OWNER.RIVAL) {
      panelBody.append(span('as-dim', 'A Hegemony holding. Park a corvette AT a system to block their expansion.'))
    }
  }

  function renderPlanetPanel(sys, planet) {
    panelBody.replaceChildren()
    panelBody.append(rowOf(span('as-dim', planetDesc(planet))))
    const buildings = row('as-builds')
    for (const b of planet.buildings) {
      buildings.append(span('as-built', BUILDING_LABEL[b] ?? b))
    }
    panelBody.append(buildings)
    if (planet.queue !== null) {
      panelBody.append(span('as-progress', `${BUILDINGS[planet.queue.building].name} — ${((planet.queue.progress / (BUILDINGS[planet.queue.building].cost * 0.1)) * 100).toFixed(0)}%`))
    }
    if (sys.owner !== OWNER.PLAYER) return
    if (planet.buildings.length >= planet.type.slots) {
      panelBody.append(span('as-dim', 'all slots used'))
      return
    }
    const r = row('as-actions')
    for (const key of ['mine', 'farm', 'lab']) {
      const spec = BUILDINGS[key]
      const b = button(`${spec.name} · ${spec.cost}${ICON.minerals}`)
      b.disabled = planet.queue !== null || world.econ.minerals < spec.cost
      b.addEventListener('click', () => actions.queueBuilding(sys, planet, key))
      r.append(b)
    }
    panelBody.append(r)
  }

  function renderShipPanel(ship) {
    panelBody.replaceChildren()
    const status = ship.state === 'move' ? 'en route' : ship.state === 'colonize' ? 'settling' : 'standing by'
    panelBody.append(rowOf(span('as-dim', `${status} · ${ship.state === 'move' ? `${ship.path.length - 1 - ship.seg} lanes to go` : `at ${world.systems[ship.at].name}`}`)))
    if (ship.state !== 'colonize') {
      panelBody.append(span('as-dim', 'tap a system on the map to send this ship'))
    }
  }

  function showOutcome(outcome) {
    overlay.hidden = false
    if (outcome === 'won') {
      overlayTitle.textContent = 'The galaxy is yours'
      overlayTitle.className = 'as-win'
      overlayText.textContent = `${world.stats.colonized} systems settled · ${world.stats.shipsBuilt} ships built · seed ${world.seed}`
    } else {
      overlayTitle.textContent = 'The Hegemony wins'
      overlayTitle.className = 'as-lose'
      overlayText.textContent = `They control the threshold first. Your systems: ${world.stats.colonized}. Seed ${world.seed}.`
    }
  }

  return { tick, refreshPanel, showOutcome, projectLabels, dispose: () => root.remove() }
}

// ─── small DOM helpers ───────────────────────────────────────────────────────

function chip(cls) {
  const el = document.createElement('span')
  el.className = `as-chip ${cls}`
  return { el }
}

function row(cls) {
  const el = document.createElement('div')
  el.className = `as-row ${cls ?? ''}`.trim()
  return el
}

function rowOf(...children) {
  const r = row()
  r.append(...children)
  return r
}

function span(cls, text) {
  const el = document.createElement('span')
  el.className = cls
  el.textContent = text
  return el
}

function button(text) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'as-btn'
  el.textContent = text
  return el
}

function planetDesc(planet) {
  const buildings = planet.buildings.length
  return `slots ${planet.buildings.length}/${planet.type.slots}${buildings > 0 ? ` · ${buildings} built` : ''}${planet.queue !== null ? ' · building' : ''}`
}

function countBuildings(sys) {
  let n = 0
  for (const p of sys.planets) n += p.buildings.length
  return n
}

function rgbOf(c) {
  return `rgb(${(c[0] * 255) | 0}, ${(c[1] * 255) | 0}, ${(c[2] * 255) | 0})`
}
