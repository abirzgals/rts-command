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
import { UT_TANK, UT_JEEP, UT_ROCKET } from '../game/config'
import { getTerrainHeight, getTerrainTypeAt, T_WATER } from '../terrain/heightmap'
import { isWorldWalkable } from '../pathfinding/navGrid'
import { spatialHash } from '../globals'
import { getPlayerFaction } from '../game/factions'
import { playSfx } from '../audio/audioManager'
import { removePath } from '../pathfinding/pathStore'
import { spawnProjectile } from '../ecs/archetypes'
import { getAnimManager } from '../render/animatedMeshManager'
import { MeshRef } from '../ecs/components'
import { editorConfig } from '../render/meshPools'
import { Projectile } from '../ecs/components'
import { spawnMuzzleFlash, spawnSmoke } from '../render/effects'

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
const VEHICLE_IDS = new Set([UT_TANK, UT_JEEP, UT_ROCKET])
// Third-person offset for vehicles: behind and above
const VEHICLE_CAM_BACK = 3.0
const VEHICLE_CAM_UP = 2.0
let isVehicle = false

// Damage effects
let shakeIntensity = 0
let damageFlashAlpha = 0
let lastHP = -1

// Movement
const keys = { w: false, a: false, s: false, d: false }

// Shooting
let shooting = false

// UI elements
let crosshairEl: HTMLDivElement | null = null
let fpsHudEl: HTMLDivElement | null = null
let vignetteEl: HTMLDivElement | null = null

// ── Public API ──────────────────────────────────────────────
export function isFPSMode(): boolean { return active }
export function getFPSEntity(): number { return controlledEid }

export function enterFPSMode(eid: number, w: IWorld) {
  if (active) return
  if (hasComponent(w, Dead, eid) || hasComponent(w, IsBuilding, eid)) return

  active = true
  controlledEid = eid
  world = w
  isVehicle = hasComponent(w, UnitTypeC, eid) && VEHICLE_IDS.has(UnitTypeC.id[eid])

  // Init camera
  fpsCam = new THREE.PerspectiveCamera(85, window.innerWidth / window.innerHeight, 0.3, 300)
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

  // FPS HUD (HP bar)
  if (!fpsHudEl) {
    fpsHudEl = document.createElement('div')
    fpsHudEl.id = 'fps-hud'
    fpsHudEl.style.cssText = `
      position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
      z-index:100; pointer-events:none; text-align:center;
    `
    fpsHudEl.innerHTML = `
      <div style="width:200px;height:8px;background:rgba(0,0,0,0.6);border-radius:4px;border:1px solid #444">
        <div id="fps-hp-fill" style="height:100%;background:#4caf50;border-radius:3px;transition:width 0.2s"></div>
      </div>
      <div id="fps-hp-text" style="color:#ccc;font-size:11px;margin-top:2px;font-family:monospace"></div>
    `
    document.body.appendChild(fpsHudEl)
  }
  fpsHudEl.style.display = 'block'

  // Damage vignette overlay
  if (!vignetteEl) {
    vignetteEl = document.createElement('div')
    vignetteEl.id = 'fps-vignette'
    vignetteEl.style.cssText = `
      position:fixed; inset:0; z-index:95; pointer-events:none;
      background: radial-gradient(ellipse at center, transparent 50%, rgba(180,0,0,0.6) 100%);
      opacity:0; transition:opacity 0.1s;
    `
    document.body.appendChild(vignetteEl)
  }

  // Init HP tracking
  if (hasComponent(w, Health, eid)) lastHP = Health.current[eid]
  shakeIntensity = 0
  damageFlashAlpha = 0

  // Hide RTS UI
  toggleUI(false)

  // Listeners
  document.addEventListener('mousedown', onMouseDown)
  document.addEventListener('mouseup', onFPSMouseUp)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  document.addEventListener('pointerlockchange', onPointerLockChange)
}

export function exitFPSMode() {
  if (!active) return
  active = false

  // Unlock pointer
  document.exitPointerLock()

  // Hide FPS UI
  if (crosshairEl) crosshairEl.style.display = 'none'
  if (fpsHudEl) fpsHudEl.style.display = 'none'
  if (vignetteEl) vignetteEl.style.opacity = '0'

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

  shooting = false
  // Cleanup listeners
  document.removeEventListener('mousedown', onMouseDown)
  document.removeEventListener('mouseup', onFPSMouseUp)
  document.removeEventListener('mousemove', onMouseMove)
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

  // Clear AI-issued movement orders (but keep AttackTarget — player's manual aim)
  if (hasComponent(world, MoveTarget, controlledEid)) removeComponent(world, MoveTarget, controlledEid)
  if (hasComponent(world, PathFollower, controlledEid)) {
    removePath(PathFollower.pathId[controlledEid])
    removeComponent(world, PathFollower, controlledEid)
  }

  const speed = hasComponent(world, MoveSpeed, controlledEid) ? MoveSpeed.value[controlledEid] : 5

  // Movement direction relative to yaw — combine keyboard + mobile analog
  let fwd = 0, strafe = 0
  if (keys.w) fwd += 1
  if (keys.s) fwd -= 1
  if (keys.a) strafe += 1
  if (keys.d) strafe -= 1
  // Mobile analog overrides if active
  if (moveInputX !== 0 || moveInputZ !== 0) {
    strafe = -moveInputX
    fwd = moveInputZ
  }

  let mx = Math.sin(yaw) * fwd + Math.cos(yaw) * strafe
  let mz = Math.cos(yaw) * fwd - Math.sin(yaw) * strafe
  const len = Math.sqrt(mx * mx + mz * mz)

  // Move position directly (bypass RTS movement system)
  if (len > 0.1) {
    mx /= len; mz /= len
    const moveScale = Math.min(len, 1)
    const stepX = mx * speed * moveScale * dt
    const stepZ = mz * speed * moveScale * dt
    const curX = Position.x[controlledEid]
    const curZ = Position.z[controlledEid]
    let newX = curX + stepX
    let newZ = curZ + stepZ

    // Terrain collision — wall slide
    const walkable = isWorldWalkable(newX, newZ) && getTerrainTypeAt(newX, newZ) !== T_WATER
    if (walkable) {
      Position.x[controlledEid] = newX
      Position.z[controlledEid] = newZ
    } else {
      // Try axis-separated slide
      const xOk = isWorldWalkable(curX + stepX, curZ) && getTerrainTypeAt(curX + stepX, curZ) !== T_WATER
      const zOk = isWorldWalkable(curX, curZ + stepZ) && getTerrainTypeAt(curX, curZ + stepZ) !== T_WATER
      if (xOk) Position.x[controlledEid] = curX + stepX
      if (zOk) Position.z[controlledEid] = curZ + stepZ
    }
    Position.y[controlledEid] = getTerrainHeight(Position.x[controlledEid], Position.z[controlledEid])
    spatialHash.update(controlledEid, Position.x[controlledEid], Position.z[controlledEid])
  }
  // Keep velocity zeroed so RTS movement system doesn't interfere
  Velocity.x[controlledEid] = 0
  Velocity.z[controlledEid] = 0

  // Update unit rotation to match look direction
  if (hasComponent(world, Rotation, controlledEid)) {
    Rotation.y[controlledEid] = yaw
  }

  // Damage detection — camera shake + vignette
  if (hasComponent(world, Health, controlledEid)) {
    const hp = Health.current[controlledEid]
    if (lastHP >= 0 && hp < lastHP) {
      // Took damage!
      const dmgPct = (lastHP - hp) / Health.max[controlledEid]
      shakeIntensity = Math.min(0.5, shakeIntensity + dmgPct * 2)
      damageFlashAlpha = Math.min(1, damageFlashAlpha + dmgPct * 3)
    }
    lastHP = hp

    // Update FPS HUD
    const hpPct = Math.max(0, hp / Health.max[controlledEid] * 100)
    const hpFill = document.getElementById('fps-hp-fill')
    const hpText = document.getElementById('fps-hp-text')
    if (hpFill) {
      hpFill.style.width = `${hpPct}%`
      hpFill.style.background = hpPct > 50 ? '#4caf50' : hpPct > 25 ? '#ff9800' : '#f44336'
    }
    if (hpText) hpText.textContent = `${Math.ceil(hp)} / ${Health.max[controlledEid]}`
  }

  // Decay shake and flash
  shakeIntensity *= Math.pow(0.05, dt) // fast decay
  damageFlashAlpha *= Math.pow(0.02, dt)
  if (vignetteEl) vignetteEl.style.opacity = String(Math.min(0.8, damageFlashAlpha))

  // Position camera: first-person for infantry, third-person for vehicles
  const ux = Position.x[controlledEid]
  const uz = Position.z[controlledEid]
  const groundY = getTerrainHeight(ux, uz)

  // Look direction from yaw + pitch
  const lookDir = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  )

  // Apply camera shake
  const shakeX = (Math.random() - 0.5) * shakeIntensity
  const shakeY = (Math.random() - 0.5) * shakeIntensity

  let camX: number, camY: number, camZ: number
  if (isVehicle) {
    // Third-person: camera behind and above the vehicle
    const uy = groundY + VEHICLE_CAM_UP
    camX = ux - lookDir.x * VEHICLE_CAM_BACK + shakeX
    camY = uy + VEHICLE_CAM_BACK * 0.4 + shakeY // extra height from distance
    camZ = uz - lookDir.z * VEHICLE_CAM_BACK
  } else {
    // First-person: camera inside unit's head
    const uy = groundY + EYE_HEIGHT
    camX = ux + shakeX
    camY = uy + shakeY
    camZ = uz
  }

  fpsCam.position.set(camX, camY, camZ)
  fpsCam.lookAt(camX + lookDir.x, camY + lookDir.y, camZ + lookDir.z)
  fpsCam.aspect = window.innerWidth / window.innerHeight
  fpsCam.updateProjectionMatrix()

  // Auto-fire: if crosshair is on an enemy within range, shoot automatically
  let autoFire = false
  if (hasComponent(world, AttackC, controlledEid)) {
    const range = AttackC.range[controlledEid]
    const myFaction = hasComponent(world, Faction, controlledEid) ? Faction.id[controlledEid] : -1
    const nearby: number[] = []
    spatialHash.query(ux, uz, range, nearby)
    for (const eid of nearby) {
      if (eid === controlledEid) continue
      if (hasComponent(world, Dead, eid)) continue
      if (!hasComponent(world, Faction, eid) || Faction.id[eid] === myFaction) continue
      // Vector from camera to enemy center
      const ex = Position.x[eid], ey = Position.y[eid] + 0.8, ez = Position.z[eid]
      const dx = ex - camX, dy = ey - camY, dz = ez - camZ
      if (dx * dx + dy * dy + dz * dz > range * range) continue
      // Must be in front of camera
      if (dx * lookDir.x + dy * lookDir.y + dz * lookDir.z < 0) continue
      // Perpendicular distance from enemy to look ray (cross product magnitude)
      const cx = dy * lookDir.z - dz * lookDir.y
      const cy = dz * lookDir.x - dx * lookDir.z
      const cz = dx * lookDir.y - dy * lookDir.x
      const perpDist = Math.sqrt(cx * cx + cy * cy + cz * cz)
      const cr = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.5
      if (perpDist < cr + 0.3) { autoFire = true; break }
    }
  }

  // Continuous fire while mouse/touch held OR auto-fire on crosshair target
  if ((shooting || autoFire) && AttackC.timer[controlledEid] <= 0) {
    fpsShoot()
  }

  return fpsCam
}

// ── Input handlers ──────────────────────────────────────────
function onMouseMove(e: MouseEvent) {
  if (!active) return
  yaw -= e.movementX * MOUSE_SENS
  pitch -= e.movementY * MOUSE_SENS // normal: mouse up = look up
  pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch))
}

const UT_KEY: Record<number, string> = { 0:'worker',1:'marine',2:'tank',3:'jeep',4:'rocket',5:'trooper' }

function fpsShoot() {
  if (!active || !world) return

  const eid = controlledEid
  if (!hasComponent(world, AttackC, eid)) return

  const range = AttackC.range[eid]
  const damage = AttackC.damage[eid]
  const burstSize = AttackC.burstSize[eid] || 1

  // Burst fire: same logic as RTS combat system
  if (burstSize > 1) {
    AttackC.burstRemaining[eid]--
    if (AttackC.burstRemaining[eid] <= 0) {
      // Burst finished — full reload
      AttackC.timer[eid] = AttackC.cooldown[eid]
      AttackC.burstRemaining[eid] = burstSize
    } else {
      // Next shot in burst
      AttackC.timer[eid] = AttackC.burstDelay[eid]
    }
  } else {
    AttackC.timer[eid] = AttackC.cooldown[eid]
  }
  const utId = hasComponent(world, UnitTypeC, eid) ? UnitTypeC.id[eid] : 1
  const unitKey = UT_KEY[utId] || 'marine'

  // Eye position (camera)
  const ux = Position.x[eid], uz = Position.z[eid]
  const uy = getTerrainHeight(ux, uz) + EYE_HEIGHT

  // Look direction from camera center (crosshair)
  const lookX = Math.sin(yaw) * Math.cos(pitch)
  const lookY = Math.sin(pitch)
  const lookZ = Math.cos(yaw) * Math.cos(pitch)

  // Aim point: where the crosshair hits at max range
  const aimX = ux + lookX * range
  const aimY = uy + lookY * range
  const aimZ = uz + lookZ * range

  // Get fire point from editor config (bone-attached hand position)
  const key = UT_KEY[utId]
  const cfg = key ? editorConfig?.[key] : null
  const projCfg = cfg?.projectile ?? null
  const muzzleCfg = cfg?.muzzle ?? null
  const projSpeed = projCfg?.speed ?? 25

  let fpX = ux + lookX * 0.5
  let fpY = uy + lookY * 0.5 - 0.3
  let fpZ = uz + lookZ * 0.5

  if (hasComponent(world, MeshRef, eid)) {
    const poolId = MeshRef.poolId[eid]
    const animMgr = getAnimManager(poolId)
    const fp = cfg?.firePoint
    if (animMgr && animMgr.has(eid) && fp) {
      const worldFp = animMgr.getFirePointWorld(eid, fp.x ?? 0, fp.y ?? 1.5, fp.z ?? 0, fp.boneName)
      if (worldFp) { fpX = worldFp.x; fpY = worldFp.y; fpZ = worldFp.z }
    }
  }

  // Calculate direction from hand → aim point (converges at crosshair)
  const toAimX = aimX - fpX
  const toAimY = aimY - fpY
  const toAimZ = aimZ - fpZ
  const toAimLen = Math.sqrt(toAimX * toAimX + toAimY * toAimY + toAimZ * toAimZ) || 1
  const dirX = toAimX / toAimLen
  const dirY = toAimY / toAimLen
  const dirZ = toAimZ / toAimLen

  // Determine projectile type — same logic as combatSystem
  const splash = AttackC.splash[eid]
  const projType = projCfg?.type ?? (splash > 0 ? 'shell' : 'bullet')
  const finalSpeed = projCfg?.speed ?? (projType === 'shell' ? 15 : projType === 'rocket' ? 8 : 25)
  const trailFire = projCfg?.trailFire ?? (projType === 'rocket' ? 3 : 0)
  const trailSmoke = projCfg?.trailSmoke ?? (projType === 'rocket' ? 2 : 0)

  // Sound + muzzle flash
  if (projType === 'rocket') {
    playSfx('rocket-launch')
    spawnSmoke(fpX, fpY, fpZ, 5)
  } else {
    playSfx(`${unitKey}-shot`)
  }
  spawnMuzzleFlash(fpX, fpY, fpZ, muzzleCfg)

  // Spawn projectile with correct type
  const myFaction = hasComponent(world, Faction, eid) ? Faction.id[eid] : 0
  const projEid = spawnProjectile(world, fpX, fpZ, 0xFFFFFFFF, damage, finalSpeed,
    { ...projCfg, type: projType, trailFire, trailSmoke }, myFaction, fpY)
  Projectile.dirX[projEid] = dirX
  Projectile.dirY[projEid] = dirY
  Projectile.dirZ[projEid] = dirZ
  Projectile.maxRange[projEid] = range
  Projectile.traveled[projEid] = 0
  Projectile.targetEid[projEid] = 0xFFFFFFFF
}

function onMouseDown(e: MouseEvent) {
  if (!active || e.button !== 0) return
  shooting = true
}

function onFPSMouseUp(e: MouseEvent) {
  if (e.button !== 0) return
  shooting = false
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
  const ids = ['top-bar', 'bottom-panel', 'minimap-container']
  for (const id of ids) {
    const el = document.getElementById(id)
    if (el) el.style.display = display
  }
  // Unit camera stays visible in FPS mode (click to exit)
  // Show/hide mobile controls
  if (touchControlsEl) touchControlsEl.style.display = show ? 'none' : 'flex'
}

// ── Mobile touch controls ───────────────────────────────────
// Full-screen touch: left side = move joystick, right side = look
// Fire button bottom-right, exit button top-right

let touchControlsEl: HTMLDivElement | null = null
let moveStickEl: HTMLDivElement | null = null
let moveKnobEl: HTMLDivElement | null = null
let moveTouchId = -1
let moveOriginX = 0, moveOriginY = 0
let moveInputX = 0, moveInputZ = 0 // -1 to 1 analog

let lookTouchId = -1
let lookLastX = 0, lookLastY = 0

const STICK_RADIUS = 50
const STICK_DEAD = 0.2

/** Analog move input for FPS update (replaces keys.w/a/s/d on mobile) */
export function getMobileMove(): { x: number; z: number } {
  return { x: moveInputX, z: moveInputZ }
}

function createTouchControls() {
  if (touchControlsEl) return
  if (!('ontouchstart' in window)) return

  touchControlsEl = document.createElement('div')
  touchControlsEl.id = 'fps-touch-overlay'
  touchControlsEl.style.cssText = `
    position:fixed; inset:0; z-index:89; display:none;
    -webkit-tap-highlight-color:transparent;
  `

  // Move joystick base (visible circle, bottom-left)
  moveStickEl = document.createElement('div')
  moveStickEl.style.cssText = `
    position:absolute; bottom:40px; left:30px; width:${STICK_RADIUS * 2}px; height:${STICK_RADIUS * 2}px;
    border-radius:50%; background:rgba(255,255,255,0.1); border:2px solid rgba(255,255,255,0.25);
    pointer-events:none;
  `
  moveKnobEl = document.createElement('div')
  moveKnobEl.style.cssText = `
    position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
    width:40px; height:40px; border-radius:50%;
    background:rgba(255,255,255,0.35); border:1px solid rgba(255,255,255,0.5);
    pointer-events:none;
  `
  moveStickEl.appendChild(moveKnobEl)
  touchControlsEl.appendChild(moveStickEl)

  // Fire button
  const fireBtn = document.createElement('div')
  fireBtn.style.cssText = `
    position:absolute; bottom:180px; right:30px; width:70px; height:70px;
    border-radius:50%; background:rgba(220,60,30,0.6); border:2px solid rgba(255,100,80,0.5);
    display:flex; align-items:center; justify-content:center;
    font-size:28px; color:#fff; user-select:none;
    -webkit-tap-highlight-color:transparent;
  `
  fireBtn.textContent = '🎯'
  fireBtn.addEventListener('touchstart', (e) => {
    e.preventDefault()
    e.stopPropagation()
    shooting = true
    fireBtn.style.background = 'rgba(255,100,50,0.8)'
  })
  fireBtn.addEventListener('touchend', (e) => {
    e.preventDefault()
    shooting = false
    fireBtn.style.background = 'rgba(220,60,30,0.6)'
  })
  touchControlsEl.appendChild(fireBtn)

  // Exit button
  const exitBtn = document.createElement('div')
  exitBtn.style.cssText = `
    position:absolute; top:12px; left:50%; transform:translateX(-50%);
    padding:8px 24px; background:rgba(180,40,40,0.7); border:1px solid rgba(255,80,80,0.4);
    border-radius:20px; color:#fff; font-size:13px; font-weight:600;
    user-select:none; -webkit-tap-highlight-color:transparent;
  `
  exitBtn.textContent = 'EXIT FPS'
  exitBtn.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); exitFPSMode() })
  touchControlsEl.appendChild(exitBtn)

  // Touch handler on the full overlay
  touchControlsEl.addEventListener('touchstart', fpsTouchStart, { passive: false })
  touchControlsEl.addEventListener('touchmove', fpsTouchMove, { passive: false })
  touchControlsEl.addEventListener('touchend', fpsTouchEnd, { passive: false })
  touchControlsEl.addEventListener('touchcancel', fpsTouchEnd, { passive: false })

  document.body.appendChild(touchControlsEl)
}

function fpsTouchStart(e: TouchEvent) {
  e.preventDefault()
  const hw = window.innerWidth / 2
  for (const t of Array.from(e.changedTouches)) {
    if (t.clientX < hw && moveTouchId < 0) {
      // Left side — move joystick
      moveTouchId = t.identifier
      moveOriginX = t.clientX
      moveOriginY = t.clientY
      // Show joystick at touch position
      if (moveStickEl) {
        moveStickEl.style.left = `${t.clientX - STICK_RADIUS}px`
        moveStickEl.style.top = `${t.clientY - STICK_RADIUS}px`
        moveStickEl.style.bottom = 'auto'
      }
    } else if (t.clientX >= hw && lookTouchId < 0) {
      // Right side — look (but not on fire/exit buttons handled by stopPropagation)
      lookTouchId = t.identifier
      lookLastX = t.clientX
      lookLastY = t.clientY
    }
  }
}

function fpsTouchMove(e: TouchEvent) {
  e.preventDefault()
  for (const t of Array.from(e.changedTouches)) {
    if (t.identifier === moveTouchId) {
      // Move joystick
      let dx = t.clientX - moveOriginX
      let dy = t.clientY - moveOriginY
      const dist = Math.sqrt(dx * dx + dy * dy)
      const clamped = Math.min(dist, STICK_RADIUS)
      if (dist > 0) { dx = (dx / dist) * clamped; dy = (dy / dist) * clamped }

      // Update knob position
      if (moveKnobEl) {
        moveKnobEl.style.left = `${50 + (dx / STICK_RADIUS) * 40}%`
        moveKnobEl.style.top = `${50 + (dy / STICK_RADIUS) * 40}%`
      }

      // Analog input normalized -1 to 1
      const nx = dx / STICK_RADIUS
      const ny = dy / STICK_RADIUS
      moveInputX = Math.abs(nx) > STICK_DEAD ? nx : 0
      moveInputZ = Math.abs(ny) > STICK_DEAD ? -ny : 0 // invert Y: up = forward
    }
    if (t.identifier === lookTouchId) {
      // Look — delta from last position
      const dx = t.clientX - lookLastX
      const dy = t.clientY - lookLastY
      yaw -= dx * 0.004
      pitch -= dy * 0.004
      pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch))
      lookLastX = t.clientX
      lookLastY = t.clientY
    }
  }
}

function fpsTouchEnd(e: TouchEvent) {
  for (const t of Array.from(e.changedTouches)) {
    if (t.identifier === moveTouchId) {
      moveTouchId = -1
      moveInputX = 0
      moveInputZ = 0
      // Reset knob
      if (moveKnobEl) {
        moveKnobEl.style.left = '50%'
        moveKnobEl.style.top = '50%'
      }
    }
    if (t.identifier === lookTouchId) {
      lookTouchId = -1
    }
  }
}
