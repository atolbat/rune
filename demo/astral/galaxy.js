// "astral" demo — the galaxy: generation + the rules of the world.
//
// A small seeded universe: a spiral galaxy of star systems joined by travel
// lanes, planets orbiting their stars, two powers spreading across the map.
// Everything here is pure state + simulation — no rendering, no DOM: the
// renderer and the UI read the same structures.
//
// Seeded determinism: the same seed → the same galaxy (mulberry32; the seed
// is taken from ?seed= or the epoch, and shown in the log so a run can be
// replayed by URL).

/** Deterministic 32-bit RNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function rng() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── the star catalog ────────────────────────────────────────────────────────

const STAR_CLASSES = [
  { key: 'O', name: 'blue giant',  color: [0.62, 0.78, 1.0],  size: 15, weight: 6,  planets: [3, 6], planetBias: 1.0 },
  { key: 'B', name: 'blue star',   color: [0.70, 0.84, 1.0],  size: 11, weight: 10, planets: [2, 5], planetBias: 0.9 },
  { key: 'A', name: 'white star',  color: [0.95, 0.97, 1.0],  size: 9,  weight: 16, planets: [1, 4], planetBias: 0.7 },
  { key: 'G', name: 'yellow star', color: [1.0, 0.92, 0.68],  size: 8,  weight: 26, planets: [2, 5], planetBias: 1.25 },
  { key: 'K', name: 'orange star', color: [1.0, 0.78, 0.52],  size: 7,  weight: 24, planets: [1, 4], planetBias: 1.1 },
  { key: 'M', name: 'red dwarf',   color: [1.0, 0.55, 0.45],  size: 5,  weight: 18, planets: [0, 3], planetBias: 0.8 },
]

const PLANET_TYPES = [
  { key: 'rock', name: 'Rocky',     color: [0.78, 0.65, 0.50], slots: 3, mine: 1.0, farm: 0.7, lab: 1.0 },
  { key: 'gas',  name: 'Gas giant', color: [0.85, 0.72, 0.60], slots: 2, mine: 0.6, farm: 0.4, lab: 1.4 },
  { key: 'ice',  name: 'Frozen',    color: [0.62, 0.82, 0.95], slots: 2, mine: 0.8, farm: 0.5, lab: 1.2 },
  { key: 'lava', name: 'Volcanic',  color: [1.0, 0.55, 0.35],  slots: 3, mine: 1.5, farm: 0.2, lab: 0.8 },
]

const SYL_A = ['Ke', 'Al', 'Ve', 'Tha', 'Or', 'Ny', 'Ze', 'Cal', 'Mir', 'Sar', 'Eri', 'Pol', 'Tan', 'Vor', 'Lum', 'Rig']
const SYL_B = ['pha', 'nir', 'dra', 'thes', 'mir', 'kon', 'var', 'lia', 'tus', 'ren', 'dor', 'gan', 'sha', 'bel', 'qor', 'wyn']
const SYL_C = ['', 'a', 'is', 'on', 'ar', 'ux', 'eth', 'or', 'an', 'ys']

// ─── the world model ─────────────────────────────────────────────────────────

export const BUILDINGS = {
  mine: { key: 'mine', name: 'Deep Mine',   cost: 60, energyUp: 0.4, out: { res: 'minerals', base: 1.6 } },
  farm: { key: 'farm', name: 'Solar Farm',  cost: 50, energyUp: 0,   out: { res: 'energy',   base: 1.1 } },
  lab:  { key: 'lab',  name: 'Orbital Lab', cost: 80, energyUp: 0.6, out: { res: 'science',  base: 0.75 } },
}

export const SHIPS = {
  colony: { key: 'colony', name: 'Colony Ship', cost: { minerals: 120, energy: 20 }, speed: 11, colonizeTime: 9 },
  war:    { key: 'war',    name: 'Corvette',     cost: { minerals: 90,  energy: 30 }, speed: 17 },
}

export const TECHS = [
  { at: 50,  key: 'drives',   name: 'Ion Drives',       desc: '+35% ship speed' },
  { at: 150, key: 'hydro',    name: 'Hydroponics',      desc: '+50% solar farm output' },
  { at: 400, key: 'cores',    name: 'Deep Core Mining', desc: '+50% mine output' },
  { at: 900, key: 'charters', name: 'Colonial Charters', desc: 'colonization twice as fast' },
]

export const OWNER = { NONE: 0, PLAYER: 1, RIVAL: 2 }
export const RIVAL_COLOR = [1.0, 0.42, 0.38]
export const PLAYER_COLOR = [0.55, 0.78, 1.0]
export const GALAXY_RADIUS = 840

/** The world: systems, lanes, ships, economy — created by generateWorld. */
export function generateWorld(seed) {
  const rng = mulberry32(seed)

  // ── the spiral arms ──
  const systemCount = 72
  const ARM_TWIST = 2.35
  const systems = []
  for (let i = 0; i < systemCount; i++) {
    const bulge = rng() < 0.14
    let x, y
    if (bulge) {
      const a = rng() * Math.PI * 2
      const r = rng() * 170
      x = Math.cos(a) * r
      y = Math.sin(a) * r
    } else {
      const arm = i % 3
      const t = 0.12 + rng() * 0.88
      const r = 90 + t * (GALAXY_RADIUS - 120)
      const angle = (arm / 3) * Math.PI * 2 + t * Math.PI * ARM_TWIST + (rng() - 0.5) * 0.42
      const jitterR = (rng() - 0.5) * 110
      x = Math.cos(angle) * (r + jitterR)
      y = Math.sin(angle) * (r + jitterR)
    }

    // the star class (weighted pick)
    let pick = rng() * 100
    let cls = STAR_CLASSES[3]
    for (const c of STAR_CLASSES) {
      pick -= c.weight
      if (pick <= 0) { cls = c; break }
    }

    // the planets
    const planetCount = Math.round(cls.planets[0] + rng() * (cls.planets[1] - cls.planets[0]) * cls.planetBias)
    const planets = []
    let orbit = 3.4 + rng() * 1.4
    for (let p = 0; p < planetCount; p++) {
      const pType = PLANET_TYPES[Math.min(PLANET_TYPES.length - 1, Math.floor(rng() * PLANET_TYPES.length))]
      const size = 0.55 + rng() * (pType.key === 'gas' ? 1.35 : 0.65)
      planets.push({
        id: p,
        type: pType,
        size,
        orbit,
        phase: rng() * Math.PI * 2,
        speed: (0.14 / Math.sqrt(orbit)) * (rng() < 0.12 ? -1 : 1),
        buildings: [],
        queue: null, // { building, progress }
      })
      orbit += 2.1 + rng() * 1.7
    }

    systems.push({
      id: i,
      x, y,
      cls,
      name: nameOf(rng),
      planets,
      owner: OWNER.NONE,
      colonizing: null, // { shipId, progress }
      shipQueue: null,  // { kind, progress }
      lanes: [],
    })
  }

  // ── the travel lanes: k-nearest candidates + a union-find connectivity pass ──
  const lanes = []
  const laneKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`)
  const seen = new Set()
  const candidates = []
  for (const s of systems) {
    const near = systems
      .filter(o => o.id !== s.id)
      .map(o => ({ o, d: Math.hypot(o.x - s.x, o.y - s.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
    for (const { o } of near) candidates.push({ a: s.id, b: o.id, d: Math.hypot(o.x - s.x, o.y - s.y) })
  }
  candidates.sort((x, y) => x.d - y.d)
  const parent = systems.map((_, i) => i)
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a, b) => { parent[find(a)] = find(b) }
  const degree = systems.map(() => 0)
  const link = (a, b, d) => {
    const k = laneKey(a, b)
    if (seen.has(k)) return
    seen.add(k)
    lanes.push({ a, b, d })
    systems[a].lanes.push(b)
    systems[b].lanes.push(a)
    degree[a]++
    degree[b]++
  }
  for (const c of candidates) {
    if (find(c.a) !== find(c.b)) { link(c.a, c.b, c.d); union(c.a, c.b) }
  }
  // every system gets ≥ 2 lanes (loops + strategic choices)
  for (const s of systems) {
    if (degree[s.id] >= 2) continue
    const near = systems
      .filter(o => o.id !== s.id && !s.lanes.includes(o.id))
      .sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y))
    for (const o of near) {
      if (degree[s.id] >= 2) break
      link(s.id, o.id, Math.hypot(o.x - s.x, o.y - s.y))
    }
  }

  // ── homeworlds: a good star near an arm's start (player) + the far side (rival) ──
  const colonizable = systems.filter(s => s.planets.length > 0)
  const good = colonizable.filter(s => s.planets.length >= 2 && (s.cls.key === 'G' || s.cls.key === 'K'))
  const byAngle = good.slice().sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x))
  const home = byAngle[Math.floor(byAngle.length * 0.1)] ?? good[0] ?? colonizable[0]
  let rival = byAngle[Math.floor(byAngle.length * 0.72)] ?? good[1]
  if (rival === home) rival = byAngle[Math.floor(byAngle.length * 0.5)] ?? colonizable[1]
  claimSystem(home, OWNER.PLAYER)
  claimSystem(rival, OWNER.RIVAL)
  // the rival seeds a second system (the pressure is real)
  const rivalSecond = systems
    .filter(s => s.owner === OWNER.NONE && s.planets.length > 0 && s.lanes.includes(rival.id))[0]
  if (rivalSecond !== undefined) claimSystem(rivalSecond, OWNER.RIVAL)

  const world = {
    seed,
    rng, // kept: the AI rolls with it (a replayed seed replays the AI too)
    systems,
    lanes,
    colonizableCount: colonizable.length,
    ships: [],
    nextShipId: 1,
    econ: { minerals: 250, energy: 120, science: 0 },
    tech: { drives: false, hydro: false, cores: false, charters: false },
    rivalTimer: 26,
    effects: [], // one-shot world flashes { x, y, t, kind }
    outcome: null, // 'won' | 'lost'
    stats: { colonized: 1, rivalSystems: 2, shipsBuilt: 0 },
  }

  // the starting fleet: two colony ships + one corvette at home
  spawnShip(world, 'colony', home.id)
  spawnShip(world, 'colony', home.id)
  spawnShip(world, 'war', home.id)
  return world
}

function nameOf(rng) {
  const a = SYL_A[Math.floor(rng() * SYL_A.length)]
  const b = SYL_B[Math.floor(rng() * SYL_B.length)]
  const c = SYL_C[Math.floor(rng() * SYL_C.length)]
  return (a + b + c).replace(/^./, ch => ch.toUpperCase())
}

/** Claim a system for an owner (the first planet gains the settlement). */
export function claimSystem(system, owner) {
  system.owner = owner
  system.colonizing = null
  const first = system.planets[0]
  if (first !== undefined && !first.buildings.includes('colony')) first.buildings.push('colony')
}

// ─── pathfinding (BFS over the lane graph) ───────────────────────────────────

export function lanePath(world, fromId, toId) {
  if (fromId === toId) return [fromId]
  const prev = world.systems.map(() => -2)
  prev[fromId] = -1
  const queue = [fromId]
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]
    if (cur === toId) break
    for (const next of world.systems[cur].lanes) {
      if (prev[next] === -2) { prev[next] = cur; queue.push(next) }
    }
  }
  if (prev[toId] === -2) return null
  const path = []
  for (let at = toId; at !== -1; at = prev[at]) path.push(at)
  path.reverse()
  return path
}

// ─── ships ───────────────────────────────────────────────────────────────────

export function spawnShip(world, kind, systemId) {
  const sys = world.systems[systemId]
  const spec = SHIPS[kind]
  const id = world.nextShipId++
  // parked ships keep station in a slow orbit of their system (golden-angle
  // spread — ships never stack, and they live outside the star's core glow)
  const parkA = (id * 2.399) % (Math.PI * 2)
  const parkR = 8.5 + (id % 6) * 2.2
  const ship = {
    id,
    kind,
    owner: OWNER.PLAYER,
    x: sys.x + Math.cos(parkA) * parkR,
    y: sys.y + Math.sin(parkA) * parkR,
    angle: parkA + Math.PI / 2,
    parkA,
    parkR,
    speed: spec.speed,
    state: 'idle', // idle | move | colonize
    at: systemId,
    path: null,
    seg: 0,
    t: 0,
  }
  world.ships.push(ship)
  world.stats.shipsBuilt++
  return ship
}

/** Order a ship to a destination system (BFS from its current system). */
export function orderShip(world, ship, toId) {
  const path = lanePath(world, ship.at, toId)
  if (path === null || path.length === 0) return false
  if (ship.state === 'colonize') {
    // a recalled colony ship: the claim in progress is abandoned
    const target = world.systems.find(s => s.colonizing?.shipId === ship.id)
    if (target !== undefined) target.colonizing = null
    ship.state = 'idle'
  }
  ship.path = path
  ship.seg = 0
  ship.t = 0
  ship.state = 'move'
  return true
}

// ─── the simulation tick ─────────────────────────────────────────────────────

export function stepWorld(world, dt, events) {
  if (world.outcome !== null || dt <= 0) return
  const { econ, tech } = world

  // ── the economy: every building produces ──
  for (const sys of world.systems) {
    if (sys.owner !== OWNER.PLAYER) continue
    for (const planet of sys.planets) {
      for (const b of planet.buildings) {
        const spec = BUILDINGS[b]
        if (spec === undefined) continue
        const site = planet.type
        let rate = spec.out.base
        if (spec.out.res === 'minerals') rate *= site.mine * (tech.cores ? 1.5 : 1)
        if (spec.out.res === 'energy') rate *= site.farm * (tech.hydro ? 1.5 : 1)
        econ[spec.out.res] += rate * dt
        econ.energy -= spec.energyUp * dt
      }
    }
  }
  econ.energy = Math.max(0, econ.energy)

  // ── the tech unlocks ──
  for (const t of TECHS) {
    if (!tech[t.key] && econ.science >= t.at) {
      tech[t.key] = true
      events.push(`tech: ${t.name} — ${t.desc}`)
    }
  }

  // ── building queues (the player's systems) ──
  for (const sys of world.systems) {
    if (sys.owner !== OWNER.PLAYER) continue
    for (const planet of sys.planets) {
      const q = planet.queue
      if (q === null) continue
      q.progress += dt
      const spec = BUILDINGS[q.building]
      if (q.progress >= buildTime(spec)) {
        planet.buildings.push(q.building)
        planet.queue = null
        events.push(`built: ${spec.name} on ${sys.name} · ${planet.type.name}`)
      }
    }
    // ship queues
    const sq = sys.shipQueue
    if (sq !== null) {
      sq.progress += dt
      if (sq.progress >= SHIP_TIME) {
        sys.shipQueue = null
        const ship = spawnShip(world, sq.kind, sys.id)
        events.push(`ship: ${SHIPS[sq.kind].name} "${shipName(ship)}" ready at ${sys.name}`)
      }
    }
  }

  // ── colonization in progress ──
  const chartersK = tech.charters ? 2 : 1
  for (const sys of world.systems) {
    const c = sys.colonizing
    if (c === null) continue
    const ship = world.ships.find(s => s.id === c.shipId)
    if (ship === undefined) { sys.colonizing = null; continue }
    c.progress += (dt / SHIPS.colony.colonizeTime) * chartersK
    if (c.progress >= 1) {
      world.ships.splice(world.ships.indexOf(ship), 1)
      claimSystem(sys, OWNER.PLAYER)
      world.stats.colonized++
      world.effects.push({ x: sys.x, y: sys.y, t: 0, kind: 'claim' })
      events.push(`colony: ${sys.name} settled (${world.stats.colonized} systems)`)
    }
  }

  // ── ship movement ──
  const drivesK = tech.drives ? 1.35 : 1
  for (const ship of world.ships) {
    if (ship.state !== 'move') continue
    let remain = ship.speed * drivesK * dt
    while (remain > 0 && ship.path !== null) {
      const from = world.systems[ship.path[ship.seg]]
      const to = world.systems[ship.path[ship.seg + 1]]
      if (to === undefined) {
        ship.state = 'idle'; ship.path = null; ship.at = from.id
        ship.parkA = Math.atan2(ship.y - from.y, ship.x - from.x)
        break
      }
      const segLen = Math.hypot(to.x - from.x, to.y - from.y) || 1
      const segLeft = (1 - ship.t) * segLen
      if (remain < segLeft) {
        ship.t += remain / segLen
        remain = 0
      } else {
        remain -= segLeft
        ship.seg++
        ship.t = 0
        ship.at = to.id
        if (ship.seg + 1 >= ship.path.length) {
          ship.state = 'idle'
          ship.path = null
          // keep station where the approach ended (the orbit continues from
          // the arrival bearing — no teleport to a fixed offset)
          ship.parkA = Math.atan2(ship.y - to.y, ship.x - to.x)
          ship.parkR = Math.min(19.5, Math.max(8.5, Math.hypot(ship.x - to.x, ship.y - to.y)))
          // a colony ship arriving at an unowned system starts colonizing
          if (ship.kind === 'colony' && to.owner === OWNER.NONE && to.planets.length > 0 && to.colonizing === null) {
            ship.state = 'colonize'
            to.colonizing = { shipId: ship.id, progress: 0 }
            events.push(`colonize: ${shipName(ship)} starts settling ${to.name}`)
          }
          break
        }
      }
    }
    if (ship.path !== null) {
      const from = world.systems[ship.path[ship.seg]]
      const to = world.systems[ship.path[ship.seg + 1]]
      ship.x = from.x + (to.x - from.x) * ship.t
      ship.y = from.y + (to.y - from.y) * ship.t
      ship.angle = Math.atan2(to.y - from.y, to.x - from.x)
    }
  }

  // ── the ships keeping station: a slow orbit of their system (idle ships
  // visibly patrol the map instead of hiding in the star's glow; a settling
  // colony ship circles its target slower) ──
  for (const ship of world.ships) {
    if (ship.state === 'move') continue
    const sys = world.systems[ship.at]
    ship.parkA += (ship.state === 'colonize' ? 0.16 : 0.3) * dt
    ship.x = sys.x + Math.cos(ship.parkA) * ship.parkR
    ship.y = sys.y + Math.sin(ship.parkA) * ship.parkR
    ship.angle = ship.parkA + Math.PI / 2
  }

  // ── the rival: a slow tide that warship presence blocks ──
  world.rivalTimer -= dt
  if (world.rivalTimer <= 0) {
    world.rivalTimer = 24 + world.rng() * 16
    tryRivalExpand(world, events)
  }

  // ── the outcome ──
  let playerCount = 0
  let rivalCount = 0
  for (const sys of world.systems) {
    if (sys.owner === OWNER.PLAYER) playerCount++
    else if (sys.owner === OWNER.RIVAL) rivalCount++
  }
  world.stats.rivalSystems = rivalCount
  const need = Math.ceil(world.colonizableCount * 0.6)
  if (playerCount >= need) world.outcome = 'won'
  else if (rivalCount >= need) world.outcome = 'lost'

  // ── the one-shot effects age ──
  for (const fx of world.effects) fx.t += dt
  for (let i = world.effects.length - 1; i >= 0; i--) {
    if (world.effects[i].t > 2.4) world.effects.splice(i, 1)
  }
}

function tryRivalExpand(world, events) {
  // candidate: unowned colonizable systems 1-2 lanes from a rival system
  const dist = world.systems.map(() => -1)
  const queue = []
  for (const s of world.systems) {
    if (s.owner === OWNER.RIVAL) { dist[s.id] = 0; queue.push(s.id) }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]
    if (dist[cur] >= 2) continue
    for (const next of world.systems[cur].lanes) {
      if (dist[next] === -1) { dist[next] = dist[cur] + 1; queue.push(next) }
    }
  }
  const candidates = world.systems.filter(s =>
    s.owner === OWNER.NONE && s.planets.length > 0 && dist[s.id] >= 1 && dist[s.id] <= 2)
  // a player corvette parked AT the system denies the claim
  const blocked = new Set(world.ships.filter(s => s.kind === 'war' && s.state !== 'move').map(s => s.at))
  const open = candidates.filter(s => !blocked.has(s.id))
  if (open.length === 0) return
  const target = open[Math.floor(world.rng() * open.length)]
  claimSystem(target, OWNER.RIVAL)
  world.effects.push({ x: target.x, y: target.y, t: 0, kind: 'rivalClaim' })
  events.push(`rival: the Hegemony claims ${target.name}`)
}

export const SHIP_TIME = 10 // both ship classes: 10 s
export const buildTime = spec => spec.cost * 0.1 // 60 → 6 s, 80 → 8 s

const NAME_SYLLABLES = ['Alk', 'Bor', 'Cir', 'Dax', 'Elo', 'Fyn', 'Gor', 'Hali', 'Ith', 'Jor', 'Kry', 'Lum', 'Mir', 'Nor', 'Osk', 'Pyr']
export const shipName = ship => `${NAME_SYLLABLES[ship.id % NAME_SYLLABLES.length]}-${ship.id * 7 + 13}`

/** Try to pay a cost; returns false (and changes nothing) if unaffordable. */
export function pay(world, cost) {
  if (world.econ.minerals < cost.minerals || world.econ.energy < cost.energy) return false
  world.econ.minerals -= cost.minerals
  world.econ.energy -= cost.energy
  return true
}

/** Queue a building on a planet (one per planet). */
export function queueBuilding(world, sys, planet, key) {
  if (planet.queue !== null) return false
  const spec = BUILDINGS[key]
  if (planet.buildings.length >= planet.type.slots) return false
  if (!pay(world, { minerals: spec.cost, energy: 0 })) return false
  planet.queue = { building: key, progress: 0 }
  return true
}

/** Queue a ship at a system (one per system). */
export function queueShip(world, sys, kind) {
  if (sys.shipQueue !== null) return false
  if (!pay(world, SHIPS[kind].cost)) return false
  sys.shipQueue = { kind, progress: 0 }
  return true
}

/** Total per-second production (the top-bar readout). */
export function production(world) {
  const rates = { minerals: 0, energy: 0, science: 0 }
  for (const sys of world.systems) {
    if (sys.owner !== OWNER.PLAYER) continue
    for (const planet of sys.planets) {
      for (const b of planet.buildings) {
        const spec = BUILDINGS[b]
        if (spec === undefined) continue
        let rate = spec.out.base
        if (spec.out.res === 'minerals') rate *= planet.type.mine * (world.tech.cores ? 1.5 : 1)
        if (spec.out.res === 'energy') rate *= planet.type.farm * (world.tech.hydro ? 1.5 : 1)
        rates[spec.out.res] += rate
      }
    }
  }
  return rates
}
