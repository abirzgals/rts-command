// ─── First-Person Shooter mode ──────────────────────────────────
// When activated, player controls a single unit in FPS view.
// WASD movement, mouse look, left click to shoot.
// ESC to return to RTS mode. AI controls the rest of the army.

import * as THREE from 'three'
import { hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Rotation, Velocity, MoveSpeed, AttackC, AttackTarget,
  MoveTarget, PathFollower, Dead, Faction, Health, Selected,
  IsBuilding, UnitTypeC, CollisionRadius,
} from '../ecs/components'
import { scene, renderer, camera } from '../render/engine'
import { getTerrainHeight } from '../terrain/heightmap'
import { spatialHash } from '../globals'
import { getPlayerFaction } from '../game/factions'
import { playSfx } from '../audio/audioManager'

// ── State ───────────────────────────────────────────────────
let active = false
let controlledEid = -1
let world: IWorld | null = null
let fpsCam: THREE.PerspectiveCamera | null = null

// Mouse look
let yaw = 0    // horizontal angle (radians)
let pitch = 0  // vertical angle (radians, clamped)
const PITCH_MIN = -Math.PI / 3
const PITCH_MAX = Math.PI / 4
const MOUSE_SENS = 0.002
const EYE_HEIGHT = 1.8

// Movement
const keys = { w: false, a: false, s: false, d: false }

// Crosshair
let crosshairEl: HTMLDivElement | null = null

// ── Public API ──────────────────────────────────────────────
export function isFPSMode(): boolean { return active }
export function getFPSEntity(): number { return controlledEid }

export function enterFPSMode(eid: number, w: IWorld) {
  if (active) return
  if (hasComponent(w, Dead, eid) || hasComponent(w, IsBuilding, eid)) return

  active = true
  controlledEid = eid
  world = w

  // Init camera
  fpsCam = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.3, 300)
  yaw = hasComponent(w, Rotation, eid) ? Rotation.y[eid] : 0
  pitch = 0

  // Clear unit's current orders
  if (hasComponent(w, MoveTarget, eid)) removeComponent(w, MoveTarget, eid)
  if (hasComponent(w, AttackTarget, eid)) removeComponent(w, AttackTarget, eid)
  if (hasComponent(w, PathFollower, eid)) removeComponent(w, PathFollower, eid)
  Velocity.x[eid] = 0
  Velocity.z[eid] = 0

  // Lock pointer (desktop) or show touch controls (mobile)
  const isMobile = 'ontouchstart' in window
  if (isMobile) {
    createTouchControls()
  } else {
    const canvas = renderer.domElement
    canvas.requestPointerLock()
  }

  // Show crosshair
  if (!crosshairEl) {
    crosshairEl = document.createElement('div')
    crosshairEl.id = 'fps-crosshair'
    crosshairEl.style.cssText = `
      position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
      width:20px; height:20px; z-index:100; pointer-events:none;
    `
    crosshairEl.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20">
        <line x1="10" y1="2" x2="10" y2="8" stroke="#0f0" stroke-width="1.5"/>
        <line x1="10" y1="12" x2="10" y2="18" stroke="#0f0" stroke-width="1.5"/>
        <line x1="2" y1="10" x2="8" y2="10" stroke="#0f0" stroke-width="1.5"/>
        <line x1="12" y1="10" x2="18" y2="10" stroke="#0f0" stroke-width="1.5"/>
        <circle cx="10" cy="10" r="1" fill="#0f0"/>
      </svg>
    `
    document.body.appendChild(crosshairEl)
  }
  crosshairEl.style.display = 'block'

  // Hide RTS UI
  toggleUI(false)

  // Listeners
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mousedown', onMouseDown)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  document.addEventListener('pointerlockchange', onPointerLockChange)
}

export function exitFPSMode() {
  if (!active) return
  active = false

  // Unlock pointer
  document.exitPointerLock()

  // Hide crosshair
  if (crosshairEl) crosshairEl.style.display = 'none'

  // Show RTS UI
  toggleUI(true)

  // Stop the unit
  if (world && controlledEid >= 0) {
    Velocity.x[controlledEid] = 0
    Velocity.z[controlledEid] = 0
    // Set rotation to last look direction
    if (hasComponent(world, Rotation, controlledEid)) {
      Rotation.y[controlledEid] = yaw
    }
  }

  // Cleanup listeners
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mousedown', onMouseDown)
  document.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('keyup', onKeyUp)
  document.removeEventListener('pointerlockchange', onPointerLockChange)

  controlledEid = -1
  world = null
  fpsCam = null
  keys.w = keys.a = keys.s = keys.d = false
}

// ── Per-frame update (called from game loop) ────────────────
export function updateFPSMode(dt: number): THREE.Camera | null {
  if (!active || !fpsCam || !world || controlledEid < 0) return null

  // Check if unit died
  if (hasComponent(world, Dead, controlledEid)) {
    exitFPSMode()
    return null
  }

  const speed = hasComponent(world, MoveSpeed, controlledEid) ? MoveSpeed.value[controlledEid] : 5

  // Movement direction relative to yaw
  let mx = 0, mz = 0
  if (keys.w) { mx += Math.sin(yaw); mz += Math.cos(yaw) }
  if (keys.s) { mx -= Math.sin(yaw); mz -= Math.cos(yaw) }
  if (keys.a) { mx += Math.cos(yaw); mz -= Math.sin(yaw) }
  if (keys.d) { mx -= Math.cos(yaw); mz += Math.sin(yaw) }
  const len = Math.sqrt(mx * mx + mz * mz)
  if (len > 0) {
    mx /= len; mz /= len
    Velocity.x[controlledEid] = mx * speed
    Velocity.z[controlledEid] = mz * speed
  } else {
    Velocity.x[controlledEid] = 0
    Velocity.z[controlledEid] = 0
  }

  // Update unit rotation to match look direction
  if (hasComponent(world, Rotation, controlledEid)) {
    Rotation.y[controlledEid] = yaw
  }

  // Position camera at unit's eyes
  const ux = Position.x[controlledEid]
  const uz = Position.z[controlledEid]
  const uy = getTerrainHeight(ux, uz) + EYE_HEIGHT

  fpsCam.position.set(ux, uy, uz)

  // Look direction from yaw + pitch
  const lookDir = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  )
  fpsCam.lookAt(ux + lookDir.x, uy + lookDir.y, uz + lookDir.z)
  fpsCam.aspect = window.innerWidth / window.innerHeight
  fpsCam.updateProjectionMatrix()

  return fpsCam
}

// ── Input handlers ──────────────────────────────────────────
function onMouseMove(e: MouseEvent) {
  if (!active) return
  yaw -= e.movementX * MOUSE_SENS
  pitch += e.movementY * MOUSE_SENS
  pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch))
}

function onMouseDown(e: MouseEvent) {
  if (!active || !world || e.button !== 0) return

  // Fire weapon
  const eid = controlledEid
  if (!hasComponent(world, AttackC, eid)) return
  if (AttackC.timer[eid] > 0) return

  // Find target in look direction via raycast
  const lookDir = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  )
  const ux = Position.x[eid], uz = Position.z[eid]
  const uy = getTerrainHeight(ux, uz) + EYE_HEIGHT
  const range = AttackC.range[eid]

  // Find closest enemy in look direction cone
  const nearby: number[] = []
  spatialHash.query(ux, uz, range, nearby)

  let bestTarget = -1
  let bestDot = 0.7 // must be roughly in front (cos ~45°)

  for (const other of nearby) {
    if (other === eid) continue
    if (!hasComponent(world, Faction, other)) continue
    if (Faction.id[other] === getPlayerFaction()) continue
    if (hasComponent(world, Dead, other)) continue
    if (!hasComponent(world, Health, other)) continue

    const dx = Position.x[other] - ux
    const dy = (Position.y[other] || getTerrainHeight(Position.x[other], Position.z[other])) - uy
    const dz = Position.z[other] - uz
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist > range || dist < 0.5) continue

    // Dot product with look direction
    const dot = (dx / dist) * lookDir.x + (dy / dist) * lookDir.y + (dz / dist) * lookDir.z
    if (dot > bestDot) {
      bestDot = dot
      bestTarget = other
    }
  }

  if (bestTarget >= 0) {
    // Attack the target
    addComponent(world, AttackTarget, eid)
    AttackTarget.eid[eid] = bestTarget
  } else {
    // Fire at ground point — trigger attack animation/sound
    const utId = hasComponent(world, UnitTypeC, eid) ? UnitTypeC.id[eid] : 1
    const UT_KEY: Record<number, string> = { 0:'worker',1:'marine',2:'tank',3:'jeep',4:'rocket',5:'trooper' }
    playSfx(`${UT_KEY[utId] || 'marine'}-shot`)
    AttackC.timer[eid] = AttackC.cooldown[eid]
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') { exitFPSMode(); return }
  if (e.key === 'w' || e.key === 'W') keys.w = true
  if (e.key === 'a' || e.key === 'A') keys.a = true
  if (e.key === 's' || e.key === 'S') keys.s = true
  if (e.key === 'd' || e.key === 'D') keys.d = true
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key === 'w' || e.key === 'W') keys.w = false
  if (e.key === 'a' || e.key === 'A') keys.a = false
  if (e.key === 's' || e.key === 'S') keys.s = false
  if (e.key === 'd' || e.key === 'D') keys.d = false
}

function onPointerLockChange() {
  if (!document.pointerLockElement && active) {
    exitFPSMode()
  }
}

// ── UI toggle ───────────────────────────────────────────────
function toggleUI(show: boolean) {
  const display = show ? '' : 'none'
  const ids = ['top-bar', 'bottom-panel', 'minimap-container', 'unitcam-container']
  for (const id of ids) {
    const el = document.getElementById(id)
    if (el) el.style.display = display
  }
  // Show/hide mobile controls
  if (touchControlsEl) touchControlsEl.style.display = show ? 'none' : 'flex'
}

// ── Mobile touch controls (dual virtual sticks) ─────────────
let touchControlsEl: HTMLDivElement | null = null
let moveStickOrigin = { x: 0, y: 0 }
let lookStickOrigin = { x: 0, y: 0 }
let moveStickActive = false
let lookStickActive = false
let moveTouchId = -1
let lookTouchId = -1

function createTouchControls() {
  if (touchControlsEl) return
  const isMobile = 'ontouchstart' in window
  if (!isMobile) return

  touchControlsEl = document.createElement('div')
  touchControlsEl.id = 'fps-touch'
  touchControlsEl.style.cssText = `
    position:fixed; bottom:0; left:0; right:0; height:50%;
    display:none; z-index:90; pointer-events:auto;
  `
  // Exit button
  const exitBtn = document.createElement('button')
  exitBtn.textContent = 'EXIT'
  exitBtn.style.cssText = `
    position:absolute; top:10px; right:10px; padding:8px 16px;
    background:rgba(200,50,50,0.8); border:1px solid #f66; border-radius:6px;
    color:#fff; font-size:14px; font-weight:bold; z-index:91; cursor:pointer;
  `
  exitBtn.addEventListener('touchstart', (e) => { e.preventDefault(); exitFPSMode() })
  touchControlsEl.appendChild(exitBtn)

  // Fire button
  const fireBtn = document.createElement('button')
  fireBtn.textContent = '🔥'
  fireBtn.style.cssText = `
    position:absolute; bottom:20px; right:20px; width:64px; height:64px;
    background:rgba(200,100,50,0.8); border:2px solid #fa0; border-radius:50%;
    color:#fff; font-size:28px; z-index:91; cursor:pointer;
  `
  fireBtn.addEventListener('touchstart', (e) => {
    e.preventDefault()
    onMouseDown({ button: 0 } as MouseEvent)
  })
  touchControlsEl.appendChild(fireBtn)

  // Touch areas: left half = move, right half = look
  touchControlsEl.addEventListener('touchstart', onTouchStart, { passive: false })
  touchControlsEl.addEventListener('touchmove', onTouchMove, { passive: false })
  touchControlsEl.addEventListener('touchend', onTouchEnd, { passive: false })

  document.body.appendChild(touchControlsEl)
}

function onTouchStart(e: TouchEvent) {
  e.preventDefault()
  const w = window.innerWidth
  for (const t of Array.from(e.changedTouches)) {
    if (t.clientX < w / 2 && !moveStickActive) {
      moveStickActive = true
      moveTouchId = t.identifier
      moveStickOrigin = { x: t.clientX, y: t.clientY }
    } else if (t.clientX >= w / 2 && !lookStickActive) {
      lookStickActive = true
      lookTouchId = t.identifier
      lookStickOrigin = { x: t.clientX, y: t.clientY }
    }
  }
}

function onTouchMove(e: TouchEvent) {
  e.preventDefault()
  for (const t of Array.from(e.changedTouches)) {
    if (t.identifier === moveTouchId && moveStickActive) {
      const dx = (t.clientX - moveStickOrigin.x) / 50
      const dy = (t.clientY - moveStickOrigin.y) / 50
      keys.w = dy < -0.3
      keys.s = dy > 0.3
      keys.a = dx < -0.3
      keys.d = dx > 0.3
    }
    if (t.identifier === lookTouchId && lookStickActive) {
      const dx = t.clientX - lookStickOrigin.x
      const dy = t.clientY - lookStickOrigin.y
      yaw -= dx * 0.003
      pitch += dy * 0.003
      pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch))
      lookStickOrigin = { x: t.clientX, y: t.clientY }
    }
  }
}

function onTouchEnd(e: TouchEvent) {
  for (const t of Array.from(e.changedTouches)) {
    if (t.identifier === moveTouchId) {
      moveStickActive = false
      moveTouchId = -1
      keys.w = keys.a = keys.s = keys.d = false
    }
    if (t.identifier === lookTouchId) {
      lookStickActive = false
      lookTouchId = -1
    }
  }
}
