// walker/controls.js — Task 216/217 — MOBILE-FIRST INPUT.
//
// The touch vocabulary (the demo's primary input — the desktop rides the
// same state through pointer lock + WASD):
//   · LEFT half of the stage — the VIRTUAL JOYSTICK: the anchor lands at
//     touch-down, the stick vector = (cur − anchor)/TRAVEL clamped to the
//     unit disc (the analog strafe/forward — the character brick's
//     world-space dir, rotated by the camera yaw in main.js);
//   · RIGHT half — the LOOK drag (yaw/pitch deltas accumulate, consumed
//     by the frame);
//   · the JUMP button — a 96px touch target (bottom-right, thumb range),
//     held = the buffered jump (the brick's buffer law auto-bunnyhops).
//
// Task 217 (the field report: «управление неудобное на телефоне»):
//   · THE JOYSTICK IS VISIBLE — a base ring + a knob fade in at the
//     anchor and track the thumb (the Task-216 stick was invisible: you
//     flew blind across the unit disc);
//   · A DEAD ZONE — the first 14% of the travel is neutral (a resting
//     thumb no longer creeps), the rest rescaled to the full range;
//   · multi-touch unchanged: the joystick and the look drag track their
//     OWN pointerIds (ride together — move while looking).
//
// The desktop: click → pointer lock; mouse deltas look; WASD/arrows
// move; Space jumps.

// the stick's geometry (CSS px): the base ring's radius and the knob's
// max travel — the vector's magnitude hits 1.0 at the travel edge
const BASE_R = 58
const TRAVEL = 44
const DEAD = 0.14

export function createControls(opts = {}) {
  const lookSens = opts.lookSens ?? 0.0032
  const state = {
    // the analog move (screen space: x right, y DOWN = backward)
    moveX: 0, moveY: 0,
    jumpHeld: false,
    // the look (radians, consumed per frame)
    yaw: opts.yaw ?? 0, pitch: 0,
    lookDX: 0, lookDY: 0,
    isTouch: false,
    locked: false,
    joyActive: false,
  }
  let joyId = -1
  let lookId = -1
  let joyAnchor = null
  let lookLast = null
  let joyBase = null
  let joyKnob = null
  const keys = new Set()
  let jumpBtn = null

  function applyKeys() {
    // the keyboard overrides the touch stick only when keys are down
    let kx = 0, ky = 0
    if (keys.has('KeyW') || keys.has('ArrowUp')) ky -= 1
    if (keys.has('KeyS') || keys.has('ArrowDown')) ky += 1
    if (keys.has('KeyA') || keys.has('ArrowLeft')) kx -= 1
    if (keys.has('KeyD') || keys.has('ArrowRight')) kx += 1
    if (kx !== 0 || ky !== 0) { state.moveX = kx; state.moveY = ky }
    else if (joyId === -1 && state.isTouch === false) { state.moveX = 0; state.moveY = 0 }
  }

  function onKey(e, down) {
    if (e.code === 'Space') { state.jumpHeld = down; e.preventDefault(); return }
    keys[down ? 'add' : 'delete'](e.code)
    applyKeys()
  }

  /** The dead-zone curve: [0, DEAD] → 0, [DEAD, 1] → [0, 1] (linear). */
  function deadzone(v) {
    const m = Math.hypot(v[0], v[1])
    if (m <= DEAD) return [0, 0]
    const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m
    return [v[0] * k, v[1] * k]
  }

  /** Places the joystick visuals (anchor at (ax, ay) in stage coords). */
  function showJoy(stage, ax, ay) {
    if (joyBase === null) return
    const rect = stage.getBoundingClientRect()
    joyBase.style.left = `${ax - rect.left - BASE_R}px`
    joyBase.style.top = `${ay - rect.top - BASE_R}px`
    joyBase.style.opacity = '1'
    joyKnob.style.transform = 'translate(0px, 0px)'
  }
  function moveKnob(dx, dy) {
    if (joyKnob === null) return
    joyKnob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`
  }
  function hideJoy() {
    if (joyBase === null) return
    joyBase.style.opacity = '0'
  }

  function attach(target, stage) {
    // ── desktop: pointer lock + keys ───────────────────────────────────
    target.addEventListener('click', () => {
      if (state.isTouch) return
      if (typeof target.requestPointerLock === 'function' && !state.locked) {
        target.requestPointerLock()
      }
    })
    document.addEventListener('pointerlockchange', () => {
      state.locked = document.pointerLockElement === target
    })
    document.addEventListener('mousemove', e => {
      if (!state.locked) return
      state.lookDX += e.movementX * lookSens
      state.lookDY += e.movementY * lookSens
    })
    window.addEventListener('keydown', e => onKey(e, true))
    window.addEventListener('keyup', e => onKey(e, false))

    // ── the joystick visuals (over the stage, never catching pointers) ─
    if (typeof document !== 'undefined' && stage != null) {
      joyBase = document.createElement('div')
      joyBase.className = 'walker-joy'
      joyKnob = document.createElement('div')
      joyKnob.className = 'walker-joy-knob'
      joyBase.appendChild(joyKnob)
      stage.appendChild(joyBase)
    }

    // ── touch: the joystick (left) + the look drag (right) ─────────────
    const isLeft = e => (e.clientX - (stage ?? target).getBoundingClientRect().left) < (stage ?? target).clientWidth / 2
    target.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return
      state.isTouch = true
      if (jumpBtn !== null) jumpBtn.classList.add('touch')
      if (isLeft(e) && joyId === -1) {
        joyId = e.pointerId
        joyAnchor = { x: e.clientX, y: e.clientY }
        state.joyActive = true
        showJoy(stage ?? target, e.clientX, e.clientY)
        try { target.setPointerCapture(e.pointerId) } catch { /* a synthetic pointer (the gates) carries no capture */ }
      } else if (lookId === -1) {
        lookId = e.pointerId
        lookLast = { x: e.clientX, y: e.clientY }
        try { target.setPointerCapture(e.pointerId) } catch { /* ditto */ }
      }
      e.preventDefault()
    }, { passive: false })
    target.addEventListener('pointermove', e => {
      if (e.pointerId === joyId && joyAnchor !== null) {
        let dx = (e.clientX - joyAnchor.x) / TRAVEL
        let dy = (e.clientY - joyAnchor.y) / TRAVEL
        const len = Math.hypot(dx, dy)
        const k = len > 1 ? 1 / len : 1
        const v = deadzone([dx * k, dy * k])
        state.moveX = v[0]
        state.moveY = v[1]
        // the knob rides the thumb, clamped to the travel ring
        const kx = dx * k * TRAVEL
        const ky = dy * k * TRAVEL
        moveKnob(kx, ky)
      } else if (e.pointerId === lookId && lookLast !== null) {
        state.lookDX += (e.clientX - lookLast.x) * lookSens * 1.6
        state.lookDY += (e.clientY - lookLast.y) * lookSens * 1.6
        lookLast = { x: e.clientX, y: e.clientY }
      }
      e.preventDefault()
    }, { passive: false })
    const release = e => {
      if (e.pointerId === joyId) {
        joyId = -1; joyAnchor = null; state.moveX = 0; state.moveY = 0
        state.joyActive = false
        hideJoy()
      }
      if (e.pointerId === lookId) { lookId = -1; lookLast = null }
    }
    target.addEventListener('pointerup', release)
    target.addEventListener('pointercancel', release)

    // ── the JUMP button (touch's own control — big, thumb-range) ───────
    if (typeof document !== 'undefined' && stage != null) {
      jumpBtn = document.createElement('button')
      jumpBtn.type = 'button'
      jumpBtn.className = 'walker-jump'
      jumpBtn.textContent = 'JUMP'
      jumpBtn.addEventListener('pointerdown', e => { state.jumpHeld = true; state.isTouch = true; e.preventDefault() }, { passive: false })
      const up = e => { state.jumpHeld = false; e.preventDefault() }
      jumpBtn.addEventListener('pointerup', up)
      jumpBtn.addEventListener('pointercancel', up)
      jumpBtn.addEventListener('pointerleave', up)
      stage.appendChild(jumpBtn)
    }
  }

  /** The frame's input: consumes the look deltas, returns the world dir. */
  function consume(yaw) {
    // the camera basis: yaw 0 looks down −z (into the course)
    const fx = Math.sin(yaw), fz = -Math.cos(yaw)
    const rx = Math.cos(yaw), rz = Math.sin(yaw)
    const fwd = -state.moveY // stick up (−y) = forward
    const strafe = state.moveX
    const dirX = fx * fwd + rx * strafe
    const dirZ = fz * fwd + rz * strafe
    state.yaw = yaw
    const dx = state.lookDX
    const dy = state.lookDY
    state.lookDX = 0
    state.lookDY = 0
    return { dirX, dirZ, lookDX: dx, lookDY: dy, jumpHeld: state.jumpHeld }
  }

  return { state, attach, consume }
}
