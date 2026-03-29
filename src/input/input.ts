import * as THREE from 'three'
import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, Selected, Selectable, MoveTarget, Velocity,
  AttackTarget, ResourceNode, ResourceDropoff, WorkerC, IsBuilding, UnitTypeC,
  Producer, PathFollower, BuildProgress,
} from '../ecs/components'
import {
  FACTION_PLAYER, BUILDING_DEFS, UNIT_DEFS,
  BT_COMMAND_CENTER, BT_SUPPLY_DEPOT, BT_BARRACKS, BT_FACTORY,
} from '../game/config'
import { gameState } from '../game/state'
import { raycastGround, camera, scene } from '../render/engine'
import { toggleDebug } from '../render/debugOverlay'
import { spawnMoveMarker } from '../render/effects'
import { spawnBuilding } from '../ecs/archetypes'
import { spatialHash } from '../globals'
import { getTerrainHeight } from '../terrain/heightmap'

const _vec3 = new THREE.Vector3()

// ── State ────────────────────────────────────────────────────
export let mouseX = 0
export let mouseY = 0
export let mouseWorldX = 0
export let mouseWorldZ = 0
let isDragging = false
let dragStartX = 0
let dragStartY = 0
const DRAG_THRESHOLD = 5
let forceAttackMode = false // when true, next click = attack anything

export function setForceAttackMode(on: boolean) {
  forceAttackMode = on
  const canvas = document.getElementById('game-canvas')
  if (canvas) canvas.style.cursor = on ? 'crosshair' : ''
  // Show indicator
  const el = document.getElementById('build-mode')!
  if (on) {
    el.textContent = 'Attack mode — Click target, ESC to cancel'
    el.style.display = 'block'
    el.style.background = 'rgba(255,50,50,0.9)'
  } else {
    el.style.display = 'none'
    el.style.background = ''
  }
}

const selectionBoxEl = document.getElementById('selection-box')!
const buildModeEl = document.getElementById('build-mode')!

// ── Build preview ghost ──────────────────────────────────────
let buildPreview: THREE.Mesh | null = null
let buildPreviewRadius = 0
const GRID_SNAP = 2 // snap to 2-unit grid for buildings

function snapToGrid(v: number): number {
  return Math.round(v / GRID_SNAP) * GRID_SNAP
}

function createBuildPreview(radius: number) {
  removeBuildPreview()
  const geo = new THREE.CylinderGeometry(radius, radius, 0.3, 24)
  const mat = new THREE.MeshBasicMaterial({
    color: 0x44ff88, transparent: true, opacity: 0.35,
    side: THREE.DoubleSide, depthWrite: false,
  })
  buildPreview = new THREE.Mesh(geo, mat)
  buildPreview.renderOrder = 50
  buildPreviewRadius = radius

  // Add range ring
  const ringGeo = new THREE.RingGeometry(radius - 0.05, radius + 0.05, 32)
  ringGeo.rotateX(-Math.PI / 2)
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x44ff88, transparent: true, opacity: 0.6,
    side: THREE.DoubleSide, depthWrite: false,
  })
  const ring = new THREE.Mesh(ringGeo, ringMat)
  ring.position.y = 0.2
  buildPreview.add(ring)

  scene.add(buildPreview)
}

function removeBuildPreview() {
  if (buildPreview) {
    scene.remove(buildPreview)
    buildPreview.geometry.dispose()
    ;(buildPreview.material as THREE.Material).dispose()
    buildPreview.children.forEach(c => {
      const m = c as THREE.Mesh
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
    })
    buildPreview = null
  }
}

function updateBuildPreview() {
  if (!buildPreview || gameState.buildMode === null) return
  const sx = snapToGrid(mouseWorldX)
  const sz = snapToGrid(mouseWorldZ)
  const y = getTerrainHeight(sx, sz)
  buildPreview.position.set(sx, y + buildPreviewRadius * 0.5, sz)
}

// Queries
let selectableQuery: ReturnType<typeof defineQuery>
let selectedQuery: ReturnType<typeof defineQuery>
let playerUnitQuery: ReturnType<typeof defineQuery>
let playerBuildingQuery: ReturnType<typeof defineQuery>

// ── Touch state ─────────────────────────────────────────────
let isMoveMode = false // when true, next tap = move command
let touchPanStartX = 0
let touchPanStartZ = 0
let touchStartScreenX = 0
let touchStartScreenY = 0
let touchStartTime = 0
let lastPinchDist = 0
let isTouchPanning = false
let isTouchBoxSelecting = false
let longPressTimer: ReturnType<typeof setTimeout> | null = null
const TOUCH_TAP_THRESHOLD = 12
const TOUCH_TAP_TIME = 300 // ms
const LONG_PRESS_TIME = 400 // ms — hold this long to start box select

/** Exported so camera can be panned from touch handler */
export let touchPanDeltaX = 0
export let touchPanDeltaZ = 0
export function consumeTouchPan() { touchPanDeltaX = 0; touchPanDeltaZ = 0 }

export function initInput(world: IWorld) {
  selectableQuery = defineQuery([Selectable, Position, Faction])
  selectedQuery = defineQuery([Selected])
  playerUnitQuery = defineQuery([Position, Faction, Selectable])
  playerBuildingQuery = defineQuery([Position, Faction, IsBuilding])

  const canvas = document.getElementById('game-canvas')!

  // Mouse events
  canvas.addEventListener('mousedown', (e) => onMouseDown(e, world))
  canvas.addEventListener('mousemove', (e) => onMouseMove(e, world))
  canvas.addEventListener('mouseup', (e) => onMouseUp(e, world))
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  window.addEventListener('keydown', (e) => onKeyDown(e, world))

  // Touch events
  canvas.addEventListener('touchstart', (e) => onTouchStart(e, world), { passive: false })
  canvas.addEventListener('touchmove', (e) => onTouchMove(e, world), { passive: false })
  canvas.addEventListener('touchend', (e) => onTouchEnd(e, world), { passive: false })

  // Move mode button
  const moveBtn = document.getElementById('touch-move-btn')
  if (moveBtn) {
    moveBtn.addEventListener('click', () => {
      isMoveMode = !isMoveMode
      moveBtn.classList.toggle('active', isMoveMode)
    })
  }

  // Debug toggle button
  const debugBtn = document.getElementById('debug-btn')
  if (debugBtn) {
    debugBtn.addEventListener('click', () => {
      toggleDebug()
      debugBtn.classList.toggle('active')
    })
  }
}

let rmbStartX = 0
let rmbStartY = 0

function onMouseDown(e: MouseEvent, world: IWorld) {
  if (e.button === 0) { // Left click
    if (forceAttackMode) {
      forceAttackTarget(world, e.clientX, e.clientY)
      return
    }
    if (gameState.buildMode !== null) {
      placeBuildingAtCursor(world)
      return
    }
    isDragging = true
    dragStartX = e.clientX
    dragStartY = e.clientY
  }
  if (e.button === 2) { // Track right-button start for pan detection
    rmbStartX = e.clientX
    rmbStartY = e.clientY
  }
}

function onMouseMove(e: MouseEvent, _world: IWorld) {
  mouseX = e.clientX
  mouseY = e.clientY

  const hit = raycastGround(e.clientX, e.clientY)
  if (hit) {
    mouseWorldX = hit.x
    mouseWorldZ = hit.z
    updateBuildPreview()
  }

  // Update selection box visual
  if (isDragging) {
    const dx = Math.abs(e.clientX - dragStartX)
    const dy = Math.abs(e.clientY - dragStartY)
    if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
      const left = Math.min(dragStartX, e.clientX)
      const top = Math.min(dragStartY, e.clientY)
      const w = Math.abs(e.clientX - dragStartX)
      const h = Math.abs(e.clientY - dragStartY)
      selectionBoxEl.style.display = 'block'
      selectionBoxEl.style.left = left + 'px'
      selectionBoxEl.style.top = top + 'px'
      selectionBoxEl.style.width = w + 'px'
      selectionBoxEl.style.height = h + 'px'
    }
  }
}

function onMouseUp(e: MouseEvent, world: IWorld) {
  if (e.button === 0 && isDragging) {
    isDragging = false
    selectionBoxEl.style.display = 'none'

    const dx = Math.abs(e.clientX - dragStartX)
    const dy = Math.abs(e.clientY - dragStartY)

    if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) {
      handleClick(world, e.clientX, e.clientY)
    } else {
      handleBoxSelect(world, dragStartX, dragStartY, e.clientX, e.clientY)
    }
  }

  if (e.button === 2) { // Right click — only if not a camera pan drag
    const rmbDx = Math.abs(e.clientX - rmbStartX)
    const rmbDy = Math.abs(e.clientY - rmbStartY)
    if (rmbDx < DRAG_THRESHOLD && rmbDy < DRAG_THRESHOLD) {
      handleRightClick(world, e.clientX, e.clientY)
    }
  }
}

function clearSelection(world: IWorld) {
  const selected = selectedQuery(world)
  for (const eid of selected) {
    removeComponent(world, Selected, eid)
  }
}

function handleClick(world: IWorld, sx: number, sy: number) {
  const hit = raycastGround(sx, sy)
  if (!hit) return

  // Find closest selectable entity near click
  const nearby: number[] = []
  spatialHash.query(hit.x, hit.z, 3, nearby)

  let closestEid = -1
  let closestDist = Infinity

  for (const eid of nearby) {
    if (!hasComponent(world, Selectable, eid)) continue
    const dx = Position.x[eid] - hit.x
    const dz = Position.z[eid] - hit.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    const radius = Selectable.radius[eid]
    if (dist < radius + 1 && dist < closestDist) {
      closestDist = dist
      closestEid = eid
    }
  }

  clearSelection(world)

  if (closestEid >= 0) {
    addComponent(world, Selected, closestEid)
  }
}

function handleBoxSelect(world: IWorld, x1: number, y1: number, x2: number, y2: number) {
  clearSelection(world)

  const minX = Math.min(x1, x2)
  const maxX = Math.max(x1, x2)
  const minY = Math.min(y1, y2)
  const maxY = Math.max(y1, y2)

  // Project all selectable player entities to screen and check if in box
  const entities = selectableQuery(world)

  for (const eid of entities) {
    if (Faction.id[eid] !== FACTION_PLAYER) continue
    if (hasComponent(world, IsBuilding, eid)) continue // Don't box-select buildings

    _vec3.set(Position.x[eid], Position.y[eid], Position.z[eid])
    _vec3.project(camera)

    const screenX = ((_vec3.x + 1) / 2) * window.innerWidth
    const screenY = ((-_vec3.y + 1) / 2) * window.innerHeight

    if (screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY) {
      addComponent(world, Selected, eid)
    }
  }
}

function handleRightClick(world: IWorld, sx: number, sy: number) {
  const hit = raycastGround(sx, sy)
  if (!hit) return

  const selected = selectedQuery(world)
  if (selected.length === 0) return

  // Check if selected entities are buildings → set rally point
  let hasBuildings = false
  let hasUnits = false
  for (const eid of selected) {
    if (hasComponent(world, IsBuilding, eid) && hasComponent(world, Producer, eid)) hasBuildings = true
    else if (!hasComponent(world, IsBuilding, eid)) hasUnits = true
  }

  if (hasBuildings && !hasUnits) {
    // Set rally point for all selected buildings
    // Check if clicking on a resource node
    const nearbyR: number[] = []
    spatialHash.query(hit.x, hit.z, 2, nearbyR)
    let resEid = 0
    for (const eid of nearbyR) {
      if (hasComponent(world, ResourceNode, eid) && !hasComponent(world, Dead, eid)) {
        const dx = Position.x[eid] - hit.x, dz = Position.z[eid] - hit.z
        if (dx * dx + dz * dz < 4) { resEid = eid; break }
      }
    }

    for (const eid of selected) {
      if (!hasComponent(world, Producer, eid)) continue
      Producer.rallyX[eid] = hit.x
      Producer.rallyZ[eid] = hit.z
      Producer.rallyTargetEid[eid] = resEid
    }
    spawnMoveMarker(hit.x, hit.y, hit.z)
    return
  }

  // Show target marker
  spawnMoveMarker(hit.x, hit.y, hit.z)

  // Check if right-clicked on an enemy or resource
  const nearby: number[] = []
  spatialHash.query(hit.x, hit.z, 3, nearby)

  let targetEid = -1
  let targetDist = Infinity
  let isResource = false

  for (const eid of nearby) {
    const dx = Position.x[eid] - hit.x
    const dz = Position.z[eid] - hit.z
    const dist = Math.sqrt(dx * dx + dz * dz)

    if (hasComponent(world, ResourceNode, eid) && dist < 2) {
      if (dist < targetDist) { targetEid = eid; targetDist = dist; isResource = true }
    } else if (hasComponent(world, Faction, eid) && Faction.id[eid] !== FACTION_PLAYER && dist < 2) {
      if (dist < targetDist) { targetEid = eid; targetDist = dist; isResource = false }
    }
  }

  // Check if right-clicked on a building under construction → assign workers to build
  let isBuildSite = false
  for (const eid of nearby) {
    if (!hasComponent(world, BuildProgress, eid)) continue
    if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== FACTION_PLAYER) continue
    const dx = Position.x[eid] - hit.x
    const dz = Position.z[eid] - hit.z
    if (dx * dx + dz * dz < 9) { // within 3 units
      isBuildSite = true
      const bx = Position.x[eid], bz = Position.z[eid]
      const bRadius = hasComponent(world, Selectable, eid) ? Selectable.radius[eid] : 2.0
      for (const wid of selected) {
        if (!hasComponent(world, WorkerC, wid)) continue
        WorkerC.state[wid] = 4 // movingToBuild
        WorkerC.buildTarget[wid] = eid
        // Target edge of building
        const wdx = Position.x[wid] - bx, wdz = Position.z[wid] - bz
        const wd = Math.sqrt(wdx * wdx + wdz * wdz) || 1
        addComponent(world, MoveTarget, wid)
        MoveTarget.x[wid] = bx + (wdx / wd) * (bRadius + 1.0)
        MoveTarget.z[wid] = bz + (wdz / wd) * (bRadius + 1.0)
      }
      break
    }
  }
  if (isBuildSite) return

  // Offset positions for formation
  const count = selected.length
  const cols = Math.ceil(Math.sqrt(count))
  const spacing = 1.5

  for (let i = 0; i < selected.length; i++) {
    const eid = selected[i]
    if (Faction.id[eid] !== FACTION_PLAYER) continue
    if (hasComponent(world, IsBuilding, eid)) continue

    // Remove existing commands
    if (hasComponent(world, AttackTarget, eid)) {
      removeComponent(world, AttackTarget, eid)
    }
    if (hasComponent(world, PathFollower, eid)) {
      removeComponent(world, PathFollower, eid)
    }

    if (targetEid >= 0 && !isResource) {
      // Attack command
      addComponent(world, AttackTarget, eid)
      AttackTarget.eid[eid] = targetEid
      // Still move toward target
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = Position.x[targetEid]
      MoveTarget.z[eid] = Position.z[targetEid]
    } else if (targetEid >= 0 && isResource && hasComponent(world, WorkerC, eid)) {
      // Gather command
      WorkerC.state[eid] = 1 // movingToRes
      WorkerC.targetNode[eid] = targetEid

      // Find nearest dropoff
      const buildingEnts = playerBuildingQuery(world)
      let nearestDropoff = 0xFFFFFFFF
      let nearestDD = Infinity
      for (const bid of buildingEnts) {
        if (Faction.id[bid] !== FACTION_PLAYER) continue
        if (!hasComponent(world, ResourceDropoff, bid)) continue
        const ddx = Position.x[bid] - Position.x[eid]
        const ddz = Position.z[bid] - Position.z[eid]
        const dd = ddx * ddx + ddz * ddz
        if (dd < nearestDD) { nearestDD = dd; nearestDropoff = bid }
      }
      WorkerC.returnTarget[eid] = nearestDropoff

      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = Position.x[targetEid]
      MoveTarget.z[eid] = Position.z[targetEid]
    } else {
      // Move command with formation offset
      const row = Math.floor(i / cols)
      const col = i % cols
      const offsetX = (col - (cols - 1) / 2) * spacing
      const offsetZ = (row - (Math.ceil(count / cols) - 1) / 2) * spacing

      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = hit.x + offsetX
      MoveTarget.z[eid] = hit.z + offsetZ
    }
  }
}

function placeBuildingAtCursor(world: IWorld) {
  const buildingType = gameState.buildMode!
  const def = BUILDING_DEFS[buildingType]
  if (!def) return

  if (!gameState.canAfford(FACTION_PLAYER, def.cost)) return

  // Don't spend cost now — it's deducted gradually during construction
  const sx = snapToGrid(mouseWorldX)
  const sz = snapToGrid(mouseWorldZ)
  const buildingEid = spawnBuilding(world, buildingType, FACTION_PLAYER, sx, sz)

  // Store total cost in BuildProgress for gradual spending
  if (hasComponent(world, BuildProgress, buildingEid)) {
    BuildProgress.costMinerals[buildingEid] = def.cost.minerals
    BuildProgress.costGas[buildingEid] = def.cost.gas
    BuildProgress.spent[buildingEid] = 0
  }

  // Send selected workers to build it (target edge, not center)
  const selected = selectedQuery(world)
  for (const eid of selected) {
    if (!hasComponent(world, WorkerC, eid)) continue
    if (Faction.id[eid] !== FACTION_PLAYER) continue
    WorkerC.state[eid] = 4 // movingToBuild
    WorkerC.buildTarget[eid] = buildingEid
    // Move to edge of building, not center (center is nav-blocked)
    const wx = Position.x[eid], wz = Position.z[eid]
    const dx = wx - sx, dz = wz - sz
    const d = Math.sqrt(dx * dx + dz * dz) || 1
    addComponent(world, MoveTarget, eid)
    MoveTarget.x[eid] = sx + (dx / d) * (def.radius + 1.0)
    MoveTarget.z[eid] = sz + (dz / d) * (def.radius + 1.0)
    break
  }

  gameState.buildMode = null
  buildModeEl.style.display = 'none'
  removeBuildPreview()
}

function forceAttackTarget(world: IWorld, sx: number, sy: number) {
  const hit = raycastGround(sx, sy)
  if (!hit) { setForceAttackMode(false); return }

  // Find ANY entity near click point (including own units/buildings)
  const nearby: number[] = []
  spatialHash.query(hit.x, hit.z, 3, nearby)

  let targetEid = -1
  let targetDist = Infinity

  for (const eid of nearby) {
    if (!hasComponent(world, Position, eid)) continue
    const dx = Position.x[eid] - hit.x
    const dz = Position.z[eid] - hit.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist < targetDist && dist < 3) {
      targetEid = eid
      targetDist = dist
    }
  }

  const selected = selectedQuery(world)
  if (targetEid >= 0) {
    // Force-attack this entity (even friendly)
    for (const eid of selected) {
      if (!hasComponent(world, AttackTarget, eid) && !hasComponent(world, Position, eid)) continue
      addComponent(world, AttackTarget, eid)
      AttackTarget.eid[eid] = targetEid
    }
    spawnMoveMarker(Position.x[targetEid], Position.y[targetEid], Position.z[targetEid])
  } else {
    // Attack-move: move to position but attack anything on the way
    for (const eid of selected) {
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = hit.x
      MoveTarget.z[eid] = hit.z
    }
    spawnMoveMarker(hit.x, hit.y, hit.z)
  }

  setForceAttackMode(false)
}

function onKeyDown(e: KeyboardEvent, world: IWorld) {
  // F1 handled by sharedButtons.ts

  if (e.key === 'Escape') {
    if (forceAttackMode) {
      setForceAttackMode(false)
    } else if (gameState.buildMode !== null) {
      gameState.buildMode = null
      buildModeEl.style.display = 'none'
      removeBuildPreview()
    } else {
      clearSelection(world)
    }
    return
  }

  // Attack hotkey (A)
  if (e.key === 'a' || e.key === 'A') {
    const selected = selectedQuery(world)
    if (selected.length > 0) setForceAttackMode(true)
    return
  }

  // Stop hotkey (S)
  if (e.key === 's' || e.key === 'S') {
    if (!e.ctrlKey) { // don't interfere with Ctrl+S
      const selected = selectedQuery(world)
      for (const eid of selected) {
        if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
        Velocity.x[eid] = 0; Velocity.z[eid] = 0
        if (hasComponent(world, WorkerC, eid)) WorkerC.state[eid] = 0
      }
    }
    return
  }

  // Hold position hotkey (H)
  if (e.key === 'h' || e.key === 'H') {
    const selected = selectedQuery(world)
    for (const eid of selected) {
      if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
      Velocity.x[eid] = 0; Velocity.z[eid] = 0
    }
    return
  }

  // Hotkeys for building
  if (e.key === 'b' || e.key === 'B') {
    // Check if a worker is selected
    const selected = selectedQuery(world)
    const hasWorker = selected.some(eid =>
      hasComponent(world, WorkerC, eid) && Faction.id[eid] === FACTION_PLAYER
    )
    if (hasWorker) {
      // Show build options — cycle through: B for barracks
      enterBuildMode(BT_BARRACKS)
    }
    return
  }
  if (e.key === 'v' || e.key === 'V') {
    enterBuildMode(BT_SUPPLY_DEPOT)
    return
  }
  if (e.key === 'f' || e.key === 'F') {
    enterBuildMode(BT_FACTORY)
    return
  }
  if (e.key === 'c' || e.key === 'C') {
    enterBuildMode(BT_COMMAND_CENTER)
    return
  }

  // Production hotkeys
  if (e.key === 'q' || e.key === 'Q') {
    // Produce first available unit
    const selected = selectedQuery(world)
    for (const eid of selected) {
      if (hasComponent(world, Producer, eid) && Faction.id[eid] === FACTION_PLAYER) {
        const ut = UnitTypeC.id[eid]
        const bdef = BUILDING_DEFS[ut]
        if (bdef?.canProduce && bdef.canProduce.length > 0) {
          queueProduction(eid, bdef.canProduce[0])
        }
      }
    }
    return
  }

  // Select all army (Ctrl+A)
  if (e.key === 'a' && e.ctrlKey) {
    e.preventDefault()
    clearSelection(world)
    const ents = selectableQuery(world)
    for (const eid of ents) {
      if (Faction.id[eid] !== FACTION_PLAYER) continue
      if (hasComponent(world, IsBuilding, eid)) continue
      if (hasComponent(world, WorkerC, eid)) continue
      addComponent(world, Selected, eid)
    }
    return
  }
}

function enterBuildMode(buildingType: number) {
  const def = BUILDING_DEFS[buildingType]
  if (!def) return
  if (!gameState.canAfford(FACTION_PLAYER, def.cost)) return

  gameState.buildMode = buildingType
  buildModeEl.textContent = `Building: ${def.name} — Click to place, ESC to cancel`
  buildModeEl.style.display = 'block'
  createBuildPreview(def.radius)
}

export function queueProduction(buildingEid: number, unitType: number) {
  const def = UNIT_DEFS[unitType]
  if (!def) return

  const faction = Faction.id[buildingEid]
  if (!gameState.canAfford(faction, def.cost)) return

  const res = gameState.getResources(faction)
  if (res.supplyCurrent + def.supply > res.supplyMax) return // no supply

  gameState.spend(faction, def.cost)
  res.supplyCurrent += def.supply // pre-reserve supply

  const queue = gameState.getQueue(buildingEid)
  queue.push({ unitType, remaining: def.buildTime })

  // If nothing is producing, start
  if (Producer.active[buildingEid] === 0 && queue.length === 1) {
    Producer.active[buildingEid] = 1
    Producer.unitType[buildingEid] = unitType
    Producer.progress[buildingEid] = 0
    Producer.duration[buildingEid] = def.buildTime
  }
}

/**
 * Smart touch tap: if player units are selected and we tap empty ground → move.
 * If we tap an entity → select it (or attack if enemy).
 */
function handleTouchTap(world: IWorld, sx: number, sy: number) {
  const hit = raycastGround(sx, sy)
  if (!hit) return

  // Check if tap hit an entity
  const nearby: number[] = []
  spatialHash.query(hit.x, hit.z, 3, nearby)

  let tappedEid = -1
  let tappedDist = Infinity
  for (const eid of nearby) {
    if (!hasComponent(world, Selectable, eid)) continue
    const dx = Position.x[eid] - hit.x
    const dz = Position.z[eid] - hit.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    const radius = Selectable.radius[eid]
    if (dist < radius + 1.5 && dist < tappedDist) {
      tappedDist = dist
      tappedEid = eid
    }
  }

  const selected = selectedQuery(world)
  const hasPlayerUnitsSelected = selected.some(eid =>
    Faction.id[eid] === FACTION_PLAYER && !hasComponent(world, IsBuilding, eid)
  )

  if (tappedEid >= 0) {
    // Tapped an entity
    if (hasPlayerUnitsSelected && hasComponent(world, Faction, tappedEid) && Faction.id[tappedEid] !== FACTION_PLAYER) {
      // Tapped enemy → attack command
      handleRightClick(world, sx, sy)
    } else if (hasPlayerUnitsSelected && hasComponent(world, ResourceNode, tappedEid)) {
      // Tapped resource → gather command
      handleRightClick(world, sx, sy)
    } else {
      // Tapped friendly unit/building → select it
      clearSelection(world)
      addComponent(world, Selected, tappedEid)
    }
  } else if (hasPlayerUnitsSelected) {
    // Tapped empty ground with units selected → move command
    handleRightClick(world, sx, sy)
  } else {
    // Nothing selected, tapped empty ground → deselect
    clearSelection(world)
  }
}

// ── Touch handlers ──────────────────────────────────────────

function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
}

function onTouchStart(e: TouchEvent, _world: IWorld) {
  e.preventDefault()

  if (e.touches.length === 1) {
    const t = e.touches[0]
    touchStartScreenX = t.clientX
    touchStartScreenY = t.clientY
    touchStartTime = performance.now()
    isTouchPanning = false
    isTouchBoxSelecting = false

    // Store world position for pan reference
    const hit = raycastGround(t.clientX, t.clientY)
    if (hit) {
      touchPanStartX = hit.x
      touchPanStartZ = hit.z
    }

    // Start long press timer → box selection mode
    cancelLongPress()
    longPressTimer = setTimeout(() => {
      longPressTimer = null
      // Enter box selection mode at current finger position
      isTouchBoxSelecting = true
      isTouchPanning = false
      // Show selection box starting from original touch position
      dragStartX = touchStartScreenX
      dragStartY = touchStartScreenY
      selectionBoxEl.style.display = 'block'
      selectionBoxEl.style.left = dragStartX + 'px'
      selectionBoxEl.style.top = dragStartY + 'px'
      selectionBoxEl.style.width = '0px'
      selectionBoxEl.style.height = '0px'
    }, LONG_PRESS_TIME)
  }

  if (e.touches.length === 2) {
    cancelLongPress()
    isTouchBoxSelecting = false
    selectionBoxEl.style.display = 'none'
    // Start pinch
    const dx = e.touches[0].clientX - e.touches[1].clientX
    const dy = e.touches[0].clientY - e.touches[1].clientY
    lastPinchDist = Math.sqrt(dx * dx + dy * dy)
    isTouchPanning = true
  }
}

function onTouchMove(e: TouchEvent, _world: IWorld) {
  e.preventDefault()

  if (e.touches.length === 1 && isTouchBoxSelecting) {
    // Update selection box
    const t = e.touches[0]
    const left = Math.min(dragStartX, t.clientX)
    const top = Math.min(dragStartY, t.clientY)
    const w = Math.abs(t.clientX - dragStartX)
    const h = Math.abs(t.clientY - dragStartY)
    selectionBoxEl.style.left = left + 'px'
    selectionBoxEl.style.top = top + 'px'
    selectionBoxEl.style.width = w + 'px'
    selectionBoxEl.style.height = h + 'px'
    return
  }

  if (e.touches.length === 1 && !isTouchPanning) {
    const t = e.touches[0]
    const dx = t.clientX - touchStartScreenX
    const dy = t.clientY - touchStartScreenY

    if (Math.abs(dx) > TOUCH_TAP_THRESHOLD || Math.abs(dy) > TOUCH_TAP_THRESHOLD) {
      cancelLongPress() // finger moved, not a long press
      isTouchPanning = true
    }
  }

  // Single-finger pan: translate camera based on screen delta
  if (e.touches.length === 1 && isTouchPanning) {
    const t = e.touches[0]
    const scale = 0.15
    touchPanDeltaX = -(t.clientX - touchStartScreenX) * scale
    touchPanDeltaZ = -(t.clientY - touchStartScreenY) * scale
    touchStartScreenX = t.clientX
    touchStartScreenY = t.clientY
  }

  // Two-finger pinch zoom
  if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX
    const dy = e.touches[0].clientY - e.touches[1].clientY
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (lastPinchDist > 0) {
      const delta = lastPinchDist - dist
      // Dispatch synthetic wheel event for camera zoom
      const canvas = document.getElementById('game-canvas')!
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: delta * 1.5,
        bubbles: true,
      }))
    }
    lastPinchDist = dist
  }
}

function onTouchEnd(e: TouchEvent, world: IWorld) {
  e.preventDefault()
  cancelLongPress()

  // Reset pinch when fingers lift
  if (e.touches.length < 2) {
    lastPinchDist = 0
  }

  // Only process on last finger release
  if (e.touches.length > 0) return

  const ct = e.changedTouches[0]
  const sx = ct.clientX
  const sy = ct.clientY

  // Box selection finish
  if (isTouchBoxSelecting) {
    selectionBoxEl.style.display = 'none'
    handleBoxSelect(world, dragStartX, dragStartY, sx, sy)
    isTouchBoxSelecting = false
    isTouchPanning = false
    touchPanDeltaX = 0
    touchPanDeltaZ = 0
    return
  }

  const elapsed = performance.now() - touchStartTime

  if (!isTouchPanning && elapsed < TOUCH_TAP_TIME) {
    // It's a tap
    if (gameState.buildMode !== null) {
      const hit = raycastGround(sx, sy)
      if (hit) {
        mouseWorldX = hit.x
        mouseWorldZ = hit.z
        placeBuildingAtCursor(world)
      }
    } else if (isMoveMode) {
      handleRightClick(world, sx, sy)
      isMoveMode = false
      const moveBtn = document.getElementById('touch-move-btn')
      if (moveBtn) moveBtn.classList.remove('active')
    } else {
      handleTouchTap(world, sx, sy)
    }
  }

  isTouchPanning = false
  isTouchBoxSelecting = false
  touchPanDeltaX = 0
  touchPanDeltaZ = 0
}
