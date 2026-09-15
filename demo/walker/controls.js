// walker/controls.js — Task 216 — MOBILE-FIRST INPUT.
//
// The touch vocabulary (the demo's primary input — the desktop rides the
// same state through pointer lock + WASD):
//   · LEFT half of the stage — the VIRTUAL JOYSTICK: the anchor lands at
//     touch-down, the stick vector = (cur − anchor)/48 clamped to the
//     unit disc (the analog strafe/forward — the character brick's
//     world-space dir, rotated by the camera yaw in main.js);
//   · RIGHT half — the LOOK drag (yaw/pitch deltas accumulate, consumed
//     by the frame);
//   · the JUMP button — a 64px touch target (bottom-right, thumb range),
//     held = the buffered jump (the brick's buffer law auto-bunnyhops).
//
// Multi-touch: the joystick and the look drag track their OWN pointerIds
// (ride together — move while looking). The desktop: click → pointer
// lock; mouse deltas look; WASD/arrows move; Space jumps.

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
  }
  let joyId = -1
  let lookId = -1
  let joyAnchor = null
  let lookLast = null
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

    // ── touch: the joystick (left) + the look drag (right) ─────────────
    const isLeft = e => (e.clientX - (stage ?? target).getBoundingClientRect().left) < (stage ?? target).clientWidth / 2
    target.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return
      state.isTouch = true
      if (jumpBtn !== null) jumpBtn.classList.add('touch')
      if (isLeft(e) && joyId === -1) {
        joyId = e.pointerId
        joyAnchor = { x: e.clientX, y: e.clientY }
        target.setPointerCapture(e.pointerId)
      } else if (lookId === -1) {
        lookId = e.pointerId
        lookLast = { x: e.clientX, y: e.clientY }
        target.setPointerCapture(e.pointerId)
      }
      e.preventDefault()
    }, { passive: false })
    target.addEventListener('pointermove', e => {
      if (e.pointerId === joyId && joyAnchor !== null) {
        const dx = (e.clientX - joyAnchor.x) / 48
        const dy = (e.clientY - joyAnchor.y) / 48
        const len = Math.hypot(dx, dy)
        const k = len > 1 ? 1 / len : 1
        state.moveX = dx * k
        state.moveY = dy * k
      } else if (e.pointerId === lookId && lookLast !== null) {
        state.lookDX += (e.clientX - lookLast.x) * lookSens * 1.6
        state.lookDY += (e.clientY - lookLast.y) * lookSens * 1.6
        lookLast = { x: e.clientX, y: e.clientY }
      }
      e.preventDefault()
    }, { passive: false })
    const release = e => {
      if (e.pointerId === joyId) { joyId = -1; joyAnchor = null; state.moveX = 0; state.moveY = 0 }
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
