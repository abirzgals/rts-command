import * as THREE from 'three'
import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, Selected, Selectable, MoveTarget, Velocity, Health, AttackC,
  AttackTarget, AttackMove, ResourceNode, ResourceDropoff, WorkerC, IsBuilding, UnitTypeC,
  Producer, PathFollower, BuildProgress, Dead, CollisionRadius, UnitMode, MODE_MOVE, MODE_ATTACK_MOVE,
} from '../ecs/components'
import {
  BUILDING_DEFS, UNIT_DEFS,
  BT_COMMAND_CENTER, BT_SUPPLY_DEPOT, BT_BARRACKS, BT_FACTORY,
} from '../game/config'
import { getPlayerFaction } from '../game/factions'
import { gameState } from '../game/state'
import { raycastGround, camera, scene } from '../render/engine'
import { getPool } from '../render/meshPools'
import { toggleDebug, isDebugEnabled } from '../render/debugOverlay'
import { spawnMoveMarker, spawnActionIndicator } from '../render/effects'
import { spawnBuilding } from '../ecs/archetypes'
import { spatialHash, rtsCameraRef } from '../globals'
import { getTerrainHeight } from '../terrain/heightmap'
import { isWorldWalkable } from '../pathfinding/navGrid'
import { findPathHierarchical } from '../pathfinding/astar'
import { removePath } from '../pathfinding/pathStore'
import { pushCommand, clearQueue, getQueue, type Command } from '../ecs/commandQueue'
import { matchesAction, getMouseMode, loadBindings, getBindingLabel } from './keybindings'
import { notifyNotEnoughMinerals, notifyNotEnoughGas, notifyNotEnoughSupply } from '../ui/notifications'
import { playSfx } from '../audio/audioManager'
import { isFPSMode } from './fpsMode'
import { UT_WORKER, UT_MARINE, UT_TANK, UT_JEEP, UT_ROCKET, UT_TROOPER } from '../game/config'

const UT_SOUND_KEY: Record<number, string> = {
  [UT_WORKER]: 'worker', [UT_MARINE]: 'marine', [UT_TANK]: 'tank',
  [UT_JEEP]: 'jeep', [UT_ROCKET]: 'rocket', [UT_TROOPER]: 'trooper',
}

/** Get sound key for the first selected unit (e.g. 'marine') */
function getSelectedUnitSoundKey(world: IWorld): string {
  const selected = selectedQuery(world)
  for (const eid of selected) {
    if (hasComponent(world, UnitTypeC, eid) && !hasComponent(world, IsBuilding, eid)) {
      return UT_SOUND_KEY[UnitTypeC.id[eid]] || 'marine'
    }
  }
  return 'marine'
}

const _vec3 = new THREE.Vector3()

// ── State ────────────────────────────────────────────────────
export let mouseX = 0
export let mouseY = 0
export let mouseWorldX = 0
export let mouseWorldZ = 0
export let hoverEid = -1 // entity under mouse cursor
let isDragging = false
let dragStartX = 0
let dragStartY = 0
const DRAG_THRESHOLD = 5
let forceAttackMode = false // when true, next click = attack anything

// ── Control Groups (Ctrl+1-9 assign, 1-9 select, Shift+1-9 add) ──
const controlGroups = new Map<number, Set<number>>() // group number -> entity IDs
export function getControlGroup(num: number): Set<number> | undefined {
  return controlGroups.get(num)
}
export function getEntityGroup(eid: number): number | undefined {
  for (const [num, set] of controlGroups) {
    if (set.has(eid)) return num
  }
  return undefined
}
let rallyMode = false       // when true, next click = set rally point
let shiftHeld = false
let lastClickTime = 0
let lastClickEid = -1
const DOUBLE_CLICK_TIME = 400 // ms

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

export function setRallyMode(on: boolean) {
  rallyMode = on
  const canvas = document.getElementById('game-canvas')
  if (canvas) canvas.style.cursor = on ? 'crosshair' : ''
  const el = document.getElementById('build-mode')!
  if (on) {
    el.textContent = 'Rally mode — Click to set rally point, ESC to cancel'
    el.style.display = 'block'
    el.style.background = 'rgba(255,200,0,0.9)'
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
let buildPreviewOwnsGeo = false
const GRID_SNAP = 2 // snap to 2-unit grid for buildings

function snapToGrid(v: number): number {
  return Math.round(v / GRID_SNAP) * GRID_SNAP
}

function createBuildPreview(radius: number, meshPoolId: number) {
  removeBuildPreview()

  // Try to clone the actual building model from its mesh pool
  const pool = getPool(meshPoolId)
  if (pool) {
    const srcGeo = pool.mesh.geometry.clone()
    srcGeo.computeBoundingSphere()
    const ghostMat = new THREE.MeshBasicMaterial({
      color: 0x44ff88,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    buildPreview = new THREE.Mesh(srcGeo, ghostMat)
    buildPreviewOwnsGeo = true
  } else {
    // Fallback: flat cylinder
    const geo = new THREE.CylinderGeometry(radius, radius, 0.3, 24)
    const mat = new THREE.MeshBasicMaterial({
      color: 0x44ff88, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthWrite: false,
    })
    buildPreview = new THREE.Mesh(geo, mat)
    buildPreviewOwnsGeo = true
  }

  buildPreview.frustumCulled = false
  buildPreview.renderOrder = 50
  buildPreviewRadius = radius

  // Add range ring on the ground
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
    if (buildPreviewOwnsGeo) buildPreview.geometry.dispose()
    ;(buildPreview.material as THREE.Material).dispose()
    buildPreview.children.forEach(c => {
      const m = c as THREE.Mesh
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
    })
    buildPreview = null
    buildPreviewOwnsGeo = false
  }
}

function canPlaceBuilding(x: number, z: number, radius: number): boolean {
  if (!isWorldWalkable(x, z)) return false
  // Check overlap with existing buildings (radius + radius)
  const nearby: number[] = []
  spatialHash.query(x, z, radius + 5, nearby)
  for (const eid of nearby) {
    if (!hasComponent(currentWorld!, IsBuilding, eid)) continue
    if (hasComponent(currentWorld!, Dead, eid)) continue
    const cr = hasComponent(currentWorld!, CollisionRadius, eid) ? CollisionRadius.value[eid] : 1.0
    const dx = Position.x[eid] - x
    const dz = Position.z[eid] - z
    const minDist = cr + radius
    if (dx * dx + dz * dz < minDist * minDist) return false
  }
  return true
}

let currentWorld: IWorld | null = null

function updateBuildPreview() {
  if (!buildPreview || gameState.buildMode === null) return
  const sx = snapToGrid(mouseWorldX)
  const sz = snapToGrid(mouseWorldZ)
  const y = getTerrainHeight(sx, sz)
  buildPreview.position.set(sx, y, sz)

  const def = BUILDING_DEFS[gameState.buildMode]
  const canAfford = def ? gameState.canAfford(getPlayerFaction(), def.cost) : true
  const canPlace = def ? canPlaceBuilding(sx, sz, def.radius) : true
  const mat = buildPreview.material as THREE.MeshPhongMaterial | THREE.MeshBasicMaterial
  if (!canAfford || !canPlace) {
    mat.color.setHex(0xff4444)
    mat.opacity = 0.35
  } else {
    mat.color.setHex(0x44ff88)
    mat.opacity = 0.4
  }
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
// touchPan moved to globals.ts to break circular import with engine.ts
import { setTouchPan } from '../globals'

export function initInput(world: IWorld) {
  currentWorld = world
  loadBindings()
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
  window.addEventListener('keydown', (e) => { shiftHeld = e.shiftKey; onKeyDown(e, world) })
  window.addEventListener('keyup', (e) => { shiftHeld = e.shiftKey })

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

  // Deselect button
  const deselectBtn = document.getElementById('deselect-btn')
  if (deselectBtn) {
    deselectBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      clearSelection(world)
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
let rmbHeld = false      // right button currently held
let wasRotating = false   // both buttons were used for camera rotation

function onMouseDown(e: MouseEvent, world: IWorld) {
  if (isFPSMode()) return
  if (e.button === 2) {
    rmbHeld = true
    rmbStartX = e.clientX
    rmbStartY = e.clientY
    // If left is already dragging, cancel selection — entering rotate mode
    if (isDragging) {
      isDragging = false
      wasRotating = true
      selectionBoxEl.style.display = 'none'
    }
  }
  if (e.button === 0) { // Left click
    // If right button is held, this is camera rotate — skip selection
    if (rmbHeld) {
      wasRotating = true
      return
    }
    if (forceAttackMode) {
      forceAttackTarget(world, e.clientX, e.clientY)
      return
    }
    if (rallyMode) {
      setRallyFromClick(world, e.clientX, e.clientY)
      return
    }
    if (gameState.buildMode !== null) {
      placeBuildingAtCursor(world)
      return
    }
    isDragging = true
    wasRotating = false
    dragStartX = e.clientX
    dragStartY = e.clientY
  }
}

function onMouseMove(e: MouseEvent, _world: IWorld) {
  if (isFPSMode()) return
  mouseX = e.clientX
  mouseY = e.clientY

  const hit = raycastGround(e.clientX, e.clientY)
  if (hit) {
    mouseWorldX = hit.x
    mouseWorldZ = hit.z
    updateBuildPreview()

    // Find entity under cursor for hover highlight
    const nearby: number[] = []
    spatialHash.query(hit.x, hit.z, 3, nearby)
    hoverEid = -1
    let bestDist = Infinity
    for (const eid of nearby) {
      if (!hasComponent(_world, Selectable, eid)) continue
      if (hasComponent(_world, Dead, eid)) continue
      const dx = Position.x[eid] - hit.x
      const dz = Position.z[eid] - hit.z
      const dist = Math.sqrt(dx * dx + dz * dz)
      const radius = Selectable.radius[eid]
      if (dist <= radius && dist < bestDist) {
        bestDist = dist
        hoverEid = eid
      }
    }
  } else {
    hoverEid = -1
  }

  // Update selection box visual (suppress if both buttons held = rotating)
  if (isDragging && !rmbHeld) {
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
  if (isFPSMode()) return
  if (e.button === 0) {
    if (isDragging && !wasRotating) {
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
    // If was rotating, just clean up
    if (wasRotating && !rmbHeld) wasRotating = false
    isDragging = false
    selectionBoxEl.style.display = 'none'
  }

  if (e.button === 2) {
    rmbHeld = false
    // Right click command — only if not a camera rotate
    if (!wasRotating) {
      const rmbDx = Math.abs(e.clientX - rmbStartX)
      const rmbDy = Math.abs(e.clientY - rmbStartY)
      if (rmbDx < DRAG_THRESHOLD && rmbDy < DRAG_THRESHOLD) {
        handleRightClick(world, e.clientX, e.clientY)
      }
    }
    wasRotating = false
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

  const selected = selectedQuery(world)
  const hasSelection = selected.length > 0

  // Find closest selectable entity near click
  // When units are selected, prioritize actionable targets (resources, enemies, build sites)
  // over already-selected friendlies so commands work correctly
  const nearby: number[] = []
  spatialHash.query(hit.x, hit.z, 3, nearby)

  let closestEid = -1
  let closestDist = Infinity

  if (hasSelection) {
    // With units selected: find what we clicked, prioritized by type
    // Priority: enemy > resource/buildsite > friendly
    let bestEnemy = -1, bestEnemyDist = Infinity
    let bestRes = -1, bestResDist = Infinity
    let bestFriendly = -1, bestFriendlyDist = Infinity

    for (const eid of nearby) {
      if (!hasComponent(world, Selectable, eid)) continue
      if (hasComponent(world, Dead, eid)) continue
      const dx = Position.x[eid] - hit.x
      const dz = Position.z[eid] - hit.z
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist > Selectable.radius[eid]) continue

      const hasFaction = hasComponent(world, Faction, eid)
      if (hasFaction && Faction.id[eid] !== getPlayerFaction() && dist < bestEnemyDist) {
        bestEnemyDist = dist; bestEnemy = eid
      } else if ((hasComponent(world, ResourceNode, eid) || hasComponent(world, BuildProgress, eid)) && dist < bestResDist) {
        bestResDist = dist; bestRes = eid
      } else if (hasFaction && Faction.id[eid] === getPlayerFaction() && dist < bestFriendlyDist) {
        bestFriendlyDist = dist; bestFriendly = eid
      }
    }
    // Pick by priority
    if (bestEnemy >= 0) { closestEid = bestEnemy; closestDist = bestEnemyDist }
    else if (bestRes >= 0) { closestEid = bestRes; closestDist = bestResDist }
    else if (bestFriendly >= 0) { closestEid = bestFriendly; closestDist = bestFriendlyDist }
  } else {
    // No selection: just find the closest entity
    for (const eid of nearby) {
      if (!hasComponent(world, Selectable, eid)) continue
      if (hasComponent(world, Dead, eid)) continue
      const dx = Position.x[eid] - hit.x
      const dz = Position.z[eid] - hit.z
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist <= Selectable.radius[eid] && dist < closestDist) {
        closestDist = dist; closestEid = eid
      }
    }
  }

  // Classify what we clicked
  const clickedFriendly = closestEid >= 0 && hasComponent(world, Faction, closestEid) &&
    Faction.id[closestEid] === getPlayerFaction()
  const clickedEnemy = closestEid >= 0 && hasComponent(world, Faction, closestEid) &&
    Faction.id[closestEid] !== getPlayerFaction() && !hasComponent(world, Dead, closestEid)
  const clickedResource = closestEid >= 0 && hasComponent(world, ResourceNode, closestEid) &&
    !hasComponent(world, Dead, closestEid)
  const clickedBuildSite = closestEid >= 0 && hasComponent(world, BuildProgress, closestEid) &&
    hasComponent(world, Faction, closestEid) && Faction.id[closestEid] === getPlayerFaction()
  const clickedDamagedBuilding = closestEid >= 0 && clickedFriendly &&
    hasComponent(world, IsBuilding, closestEid) && !hasComponent(world, BuildProgress, closestEid) &&
    hasComponent(world, Health, closestEid) && Health.current[closestEid] < Health.max[closestEid]

  // ── Double-click on friendly → select all visible units of same type ──
  const now = performance.now()
  if (closestEid >= 0 && clickedFriendly && !clickedResource &&
      closestEid === lastClickEid && (now - lastClickTime) < DOUBLE_CLICK_TIME) {
    const clickedType = hasComponent(world, UnitTypeC, closestEid) ? UnitTypeC.id[closestEid] : -1
    const isBuilding = hasComponent(world, IsBuilding, closestEid)
    if (!shiftHeld) clearSelection(world)
    // Select all visible player units of same type
    const entities = selectableQuery(world)
    for (const eid of entities) {
      if (Faction.id[eid] !== getPlayerFaction()) continue
      if (hasComponent(world, Dead, eid)) continue
      if (hasComponent(world, IsBuilding, eid) !== isBuilding) continue
      if (!hasComponent(world, UnitTypeC, eid) || UnitTypeC.id[eid] !== clickedType) continue
      // Check if on screen
      _vec3.set(Position.x[eid], Position.y[eid], Position.z[eid])
      _vec3.project(camera)
      const screenX = ((_vec3.x + 1) / 2) * window.innerWidth
      const screenY = ((-_vec3.y + 1) / 2) * window.innerHeight
      if (screenX >= 0 && screenX <= window.innerWidth && screenY >= 0 && screenY <= window.innerHeight) {
        addComponent(world, Selected, eid)
      }
    }
    lastClickTime = 0
    lastClickEid = -1
    return
  }
  lastClickTime = now
  lastClickEid = closestEid

  // ── No units selected → select whatever we clicked ──
  if (!hasSelection) {
    if (closestEid >= 0) {
      if (!shiftHeld) clearSelection(world)
      addComponent(world, Selected, closestEid)
    }
    return
  }

  // ── Click on friendly unit/building → select it ──
  // Exception: workers clicking on build site or damaged building → repair/build command
  const hasWorkers = selected.some(eid =>
    hasComponent(world, WorkerC, eid) && Faction.id[eid] === getPlayerFaction()
  )
  const isBuildingTarget = clickedBuildSite || clickedDamagedBuilding
  if (clickedFriendly && !clickedResource && !(hasWorkers && isBuildingTarget)) {
    if (shiftHeld) {
      if (hasComponent(world, Selected, closestEid)) {
        removeComponent(world, Selected, closestEid)
      } else {
        addComponent(world, Selected, closestEid)
      }
    } else {
      clearSelection(world)
      addComponent(world, Selected, closestEid)
    }
    return
  }

  // ── Check if only producer buildings selected → rally / unit command queue ──
  const producerBuildings = selected.filter(eid =>
    hasComponent(world, IsBuilding, eid) && hasComponent(world, Producer, eid) &&
    Faction.id[eid] === getPlayerFaction()
  )
  const movableUnits = selected.filter(eid =>
    Faction.id[eid] === getPlayerFaction() && !hasComponent(world, IsBuilding, eid)
  )

  // In Starcraft mode, left click only selects — commands go via right click
  if (getMouseMode() === 'starcraft') {
    if (closestEid < 0) clearSelection(world)
    return
  }

  const isMobile = 'ontouchstart' in window
  if (movableUnits.length === 0 && producerBuildings.length > 0 && !isMobile) {
    // SupCom desktop: left-click ground with building selected = set rally
    issueBuildingCommand(world, producerBuildings, hit, closestEid, clickedEnemy, clickedResource, shiftHeld)
    return
  }

  if (movableUnits.length === 0) {
    if (closestEid >= 0 && clickedFriendly) {
      clearSelection(world)
      addComponent(world, Selected, closestEid)
    }
    return
  }

  issueCommand(world, movableUnits, hit, closestEid, clickedEnemy, clickedResource, clickedBuildSite, shiftHeld, clickedDamagedBuilding)
}

function handleBoxSelect(world: IWorld, x1: number, y1: number, x2: number, y2: number) {
  if (!shiftHeld) clearSelection(world)

  const minX = Math.min(x1, x2)
  const maxX = Math.max(x1, x2)
  const minY = Math.min(y1, y2)
  const maxY = Math.max(y1, y2)

  // Project all selectable player entities to screen and check if in box
  const entities = selectableQuery(world)

  for (const eid of entities) {
    if (Faction.id[eid] !== getPlayerFaction()) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (hasComponent(world, Dead, eid)) continue

    _vec3.set(Position.x[eid], Position.y[eid], Position.z[eid])
    _vec3.project(camera)

    const screenX = ((_vec3.x + 1) / 2) * window.innerWidth
    const screenY = ((-_vec3.y + 1) / 2) * window.innerHeight

    if (screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY) {
      if (shiftHeld && hasComponent(world, Selected, eid)) {
        removeComponent(world, Selected, eid) // toggle off
      } else {
        addComponent(world, Selected, eid)
      }
    }
  }
}

/** Set rally point and queue commands on a building — transferred to produced units */
function issueBuildingCommand(
  world: IWorld,
  buildings: number[],
  hit: THREE.Vector3,
  closestEid: number,
  clickedEnemy: boolean,
  clickedResource: boolean,
  queue: boolean,
) {
  // Determine command type
  let cmdType: 'move' | 'attack' | 'gather' = 'move'
  if (clickedEnemy) cmdType = 'attack'
  else if (clickedResource) cmdType = 'gather'

  // Visual feedback
  if (closestEid >= 0 && cmdType !== 'move') {
    const tr = hasComponent(world, Selectable, closestEid) ? Selectable.radius[closestEid] : 0.8
    const color = cmdType === 'attack' ? 'attack' : 'gather'
    spawnActionIndicator(Position.x[closestEid], Position.y[closestEid], Position.z[closestEid], tr + 0.3, color)
  }
  spawnMoveMarker(hit.x, hit.y, hit.z)

  // Check for resource target
  let resEid = 0
  if (clickedResource && closestEid >= 0) resEid = closestEid

  for (const eid of buildings) {
    if (!queue) {
      // Set rally point (first command)
      Producer.rallyX[eid] = hit.x
      Producer.rallyZ[eid] = hit.z
      Producer.rallyTargetEid[eid] = resEid
      // Clear queued commands for this building
      clearQueue(eid)
    }

    // Build the command
    let cmd: Command
    if (cmdType === 'attack' && closestEid >= 0) {
      cmd = { type: 'attack', targetEid: closestEid }
    } else if (cmdType === 'gather' && closestEid >= 0) {
      cmd = { type: 'gather', targetEid: closestEid }
    } else {
      cmd = { type: 'move', x: hit.x, z: hit.z }
    }

    if (queue) {
      pushCommand(eid, cmd)
    } else {
      // First command is the rally point itself — queue additional ones after it
      // The rally point command will be the first action for produced units
    }
  }
}

/** Find a walkable spot at `dist` from (cx,cz), preferring direction toward (fromX,fromZ) */
function findWalkableSpotAround(cx: number, cz: number, dist: number, fromX: number, fromZ: number) {
  const dx = fromX - cx, dz = fromZ - cz
  const baseAngle = Math.atan2(dx, dz)
  // Try preferred direction first, then sweep around
  for (let i = 0; i < 16; i++) {
    const angle = baseAngle + (i % 2 === 0 ? 1 : -1) * Math.floor((i + 1) / 2) * (Math.PI / 8)
    const mx = cx + Math.sin(angle) * dist
    const mz = cz + Math.cos(angle) * dist
    if (isWorldWalkable(mx, mz)) return { x: mx, z: mz }
  }
  // Fallback: try larger distance
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2
    const mx = cx + Math.sin(angle) * (dist + 2)
    const mz = cz + Math.cos(angle) * (dist + 2)
    if (isWorldWalkable(mx, mz)) return { x: mx, z: mz }
  }
  return { x: cx + Math.sin(baseAngle) * dist, z: cz + Math.cos(baseAngle) * dist }
}

function handleRightClick(world: IWorld, sx: number, sy: number) {
  if (gameState.buildMode !== null) {
    cancelBuildMode()
    return
  }
  if (getMouseMode() === 'starcraft') {
    // Starcraft: right click = issue command to selected units
    issueCommandFromClick(world, sx, sy)
    return
  }
  clearSelection(world)
}

/** Issue a command from a click position — used by Starcraft right-click */
function issueCommandFromClick(world: IWorld, sx: number, sy: number) {
  const hit = raycastGround(sx, sy)
  if (!hit) return

  const selected = selectedQuery(world)
  if (selected.length === 0) return

  // Find closest entity near click (same priority as handleClick)
  const nearby: number[] = []
  spatialHash.query(hit.x, hit.z, 3, nearby)

  let closestEid = -1
  let bestEnemy = -1, bestEnemyDist = Infinity
  let bestRes = -1, bestResDist = Infinity

  for (const eid of nearby) {
    if (!hasComponent(world, Selectable, eid)) continue
    if (hasComponent(world, Dead, eid)) continue
    const dx = Position.x[eid] - hit.x
    const dz = Position.z[eid] - hit.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist > Selectable.radius[eid]) continue

    const hasFaction = hasComponent(world, Faction, eid)
    if (hasFaction && Faction.id[eid] !== getPlayerFaction() && dist < bestEnemyDist) {
      bestEnemyDist = dist; bestEnemy = eid
    } else if ((hasComponent(world, ResourceNode, eid) || hasComponent(world, BuildProgress, eid)) && dist < bestResDist) {
      bestResDist = dist; bestRes = eid
    }
  }
  if (bestEnemy >= 0) closestEid = bestEnemy
  else if (bestRes >= 0) closestEid = bestRes

  const clickedEnemy = closestEid >= 0 && hasComponent(world, Faction, closestEid) &&
    Faction.id[closestEid] !== getPlayerFaction()
  const clickedResource = closestEid >= 0 && hasComponent(world, ResourceNode, closestEid)
  const clickedBuildSite = closestEid >= 0 && hasComponent(world, BuildProgress, closestEid) &&
    hasComponent(world, Faction, closestEid) && Faction.id[closestEid] === getPlayerFaction()
  const clickedDamagedBuilding = closestEid >= 0 && hasComponent(world, Faction, closestEid) &&
    Faction.id[closestEid] === getPlayerFaction() && hasComponent(world, IsBuilding, closestEid) &&
    !hasComponent(world, BuildProgress, closestEid) && hasComponent(world, Health, closestEid) &&
    Health.current[closestEid] < Health.max[closestEid]

  // Producer buildings: set rally
  const producerBuildings = selected.filter(eid =>
    hasComponent(world, IsBuilding, eid) && hasComponent(world, Producer, eid) &&
    Faction.id[eid] === getPlayerFaction()
  )
  const movableUnits = selected.filter(eid =>
    Faction.id[eid] === getPlayerFaction() && !hasComponent(world, IsBuilding, eid)
  )

  if (movableUnits.length === 0 && producerBuildings.length > 0) {
    issueBuildingCommand(world, producerBuildings, hit, closestEid, clickedEnemy, clickedResource, shiftHeld)
    return
  }

  if (movableUnits.length > 0) {
    issueCommand(world, movableUnits, hit, closestEid, clickedEnemy, clickedResource, clickedBuildSite, shiftHeld, clickedDamagedBuilding)
  }

  if (!clickedEnemy && !clickedResource && !clickedBuildSite && !clickedDamagedBuilding) {
    spawnMoveMarker(hit.x, hit.y, hit.z)
  }
}

// ── Unified command issuing (used by left-click with selection) ──

function issueCommand(
  world: IWorld,
  movableUnits: number[],
  hit: THREE.Vector3,
  closestEid: number,
  clickedEnemy: boolean,
  clickedResource: boolean,
  clickedBuildSite: boolean,
  queue: boolean,
  clickedDamagedBuilding = false,
) {
  const count = movableUnits.length
  if (count === 0) return

  // Determine command type and show indicator
  let cmdType: 'move' | 'attack' | 'gather' | 'build' | 'repair' = 'move'
  if (clickedEnemy) cmdType = 'attack'
  else if (clickedResource) cmdType = 'gather'
  else if (clickedBuildSite) cmdType = 'build'
  else if (clickedDamagedBuilding) cmdType = 'repair'

  // Voice line (unit-specific)
  const uKey = getSelectedUnitSoundKey(world)
  if (cmdType === 'attack') playSfx(`${uKey}-attack`)
  else if (cmdType === 'move') playSfx(`${uKey}-move`)
  else playSfx(`${uKey}-confirm`)

  // Show visual feedback
  if (closestEid >= 0 && cmdType !== 'move') {
    const tr = hasComponent(world, Selectable, closestEid) ? Selectable.radius[closestEid] : 0.8
    const color = cmdType === 'attack' ? 'attack' : cmdType === 'build' ? 'assist' : 'gather'
    spawnActionIndicator(Position.x[closestEid], Position.y[closestEid], Position.z[closestEid], tr + 0.3, color)
  } else {
    spawnMoveMarker(hit.x, hit.y, hit.z)
  }

  // ── Queue mode (shift held) — add to queue, don't interrupt ──
  if (queue) {
    for (const eid of movableUnits) {
      if (cmdType === 'attack' && closestEid >= 0) {
        pushCommand(eid, { type: 'attack', targetEid: closestEid })
      } else if (cmdType === 'gather' && closestEid >= 0) {
        pushCommand(eid, { type: 'gather', targetEid: closestEid })
      } else if (cmdType === 'build' && closestEid >= 0) {
        pushCommand(eid, { type: 'build', targetEid: closestEid })
      } else {
        pushCommand(eid, { type: 'move', x: hit.x, z: hit.z })
      }
    }
    return
  }

  // ── Immediate mode — clear queue, execute now ──

  // Formation slots for move commands
  let slots: { x: number; z: number }[] | null = null
  let assignments: Map<number, number> | null = null

  if (cmdType === 'move' && count > 0) {
    // Sort units: largest first so they get center slots
    const sorted = [...movableUnits].sort((a, b) => {
      const ra = hasComponent(world, CollisionRadius, a) ? CollisionRadius.value[a] : 0.4
      const rb = hasComponent(world, CollisionRadius, b) ? CollisionRadius.value[b] : 0.4
      return rb - ra
    })
    const srcX = Position.x[sorted[0]]
    const srcZ = Position.z[sorted[0]]

    // Place units one by one with per-unit spacing
    slots = []
    const placed: { x: number; z: number; r: number }[] = []

    for (const eid of sorted) {
      const unitR = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.4
      if (placed.length === 0) {
        // First unit at target
        slots.push({ x: hit.x, z: hit.z })
        placed.push({ x: hit.x, z: hit.z, r: unitR })
        continue
      }

      // Find nearest open spot that doesn't overlap placed units
      let bestX = hit.x, bestZ = hit.z, bestDist = Infinity
      const spacing = unitR * 2.5
      const searchR = Math.ceil(Math.sqrt(count)) + 2
      for (let ring = 1; ring <= searchR && bestDist > 0.01; ring++) {
        for (let a = 0; a < ring * 6; a++) {
          const angle = (a / (ring * 6)) * Math.PI * 2
          const sx = hit.x + Math.cos(angle) * ring * spacing
          const sz = hit.z + Math.sin(angle) * ring * spacing
          // Check overlap with already placed
          let overlap = false
          for (const p of placed) {
            const minDist = unitR + p.r + 0.3
            const dx = sx - p.x, dz = sz - p.z
            if (dx * dx + dz * dz < minDist * minDist) { overlap = true; break }
          }
          if (overlap) continue
          if (!isWorldWalkable(sx, sz)) continue
          const d = (sx - hit.x) ** 2 + (sz - hit.z) ** 2
          if (d < bestDist) { bestDist = d; bestX = sx; bestZ = sz }
        }
      }
      slots.push({ x: bestX, z: bestZ })
      placed.push({ x: bestX, z: bestZ, r: unitR })
    }

    // Reorder slots to match original movableUnits order
    const slotByEid = new Map<number, { x: number; z: number }>()
    for (let i = 0; i < sorted.length; i++) slotByEid.set(sorted[i], slots[i])
    slots = movableUnits.map(eid => slotByEid.get(eid) || { x: hit.x, z: hit.z })

    // Direct 1:1 slot assignment — slots already matched per unit
    assignments = new Map()
    for (let i = 0; i < movableUnits.length; i++) {
      assignments.set(movableUnits[i], i)
    }
  }

  for (const eid of movableUnits) {
    // Clear current commands and queue
    clearQueue(eid)
    if (hasComponent(world, AttackTarget, eid)) removeComponent(world, AttackTarget, eid)
    if (hasComponent(world, PathFollower, eid)) removeComponent(world, PathFollower, eid)

    if (cmdType === 'attack' && closestEid >= 0) {
      addComponent(world, AttackTarget, eid)
      AttackTarget.eid[eid] = closestEid
      // Move to attack position based on attacker's range
      const tgtX = Position.x[closestEid], tgtZ = Position.z[closestEid]
      const tgtR = hasComponent(world, CollisionRadius, closestEid) ? CollisionRadius.value[closestEid] : 0
      const atkRange = hasComponent(world, AttackC, eid) ? AttackC.range[eid] : 1.5
      // Stand at: target edge + 80% of attack range (so unit is comfortably in range)
      const standDist = tgtR + Math.max(1.0, atkRange * 0.8)
      addComponent(world, MoveTarget, eid)
      const { x: mx, z: mz } = findWalkableSpotAround(
        tgtX, tgtZ, standDist,
        Position.x[eid], Position.z[eid],
      )
      MoveTarget.x[eid] = mx
      MoveTarget.z[eid] = mz
    } else if (cmdType === 'gather' && closestEid >= 0 && hasComponent(world, WorkerC, eid)) {
      WorkerC.state[eid] = 1
      WorkerC.targetNode[eid] = closestEid
      const buildingEnts = playerBuildingQuery(world)
      let nearestDropoff = 0xFFFFFFFF, nearestDD = Infinity
      for (const bid of buildingEnts) {
        if (Faction.id[bid] !== getPlayerFaction() || !hasComponent(world, ResourceDropoff, bid)) continue
        const dd = (Position.x[bid] - Position.x[eid]) ** 2 + (Position.z[bid] - Position.z[eid]) ** 2
        if (dd < nearestDD) { nearestDD = dd; nearestDropoff = bid }
      }
      WorkerC.returnTarget[eid] = nearestDropoff
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = Position.x[closestEid]
      MoveTarget.z[eid] = Position.z[closestEid]
    } else if (cmdType === 'build' && closestEid >= 0 && hasComponent(world, WorkerC, eid)) {
      WorkerC.state[eid] = 4
      WorkerC.buildTarget[eid] = closestEid
      const bx = Position.x[closestEid], bz = Position.z[closestEid]
      const bRadius = hasComponent(world, Selectable, closestEid) ? Selectable.radius[closestEid] : 2.0
      const dx = Position.x[eid] - bx, dz = Position.z[eid] - bz
      const d = Math.sqrt(dx * dx + dz * dz) || 1
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = bx + (dx / d) * (bRadius + 1.0)
      MoveTarget.z[eid] = bz + (dz / d) * (bRadius + 1.0)
    } else if (cmdType === 'repair' && closestEid >= 0 && hasComponent(world, WorkerC, eid)) {
      WorkerC.state[eid] = 6 // movingToRepair
      WorkerC.buildTarget[eid] = closestEid
      const bx = Position.x[closestEid], bz = Position.z[closestEid]
      const bRadius = hasComponent(world, Selectable, closestEid) ? Selectable.radius[closestEid] : 2.0
      const dx = Position.x[eid] - bx, dz = Position.z[eid] - bz
      const d = Math.sqrt(dx * dx + dz * dz) || 1
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = bx + (dx / d) * (bRadius + 1.0)
      MoveTarget.z[eid] = bz + (dz / d) * (bRadius + 1.0)
    } else {
      // Move to formation slot (plain move — no attack-move)
      const slotIdx = assignments?.get(eid) ?? 0
      const slot = slots ? slots[slotIdx] : { x: hit.x, z: hit.z }
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = slot.x
      MoveTarget.z[eid] = slot.z
      if (hasComponent(world, AttackMove, eid)) {
        removeComponent(world, AttackMove, eid)
      }
    }
  }
}

function placeBuildingAtCursor(world: IWorld) {
  const buildingType = gameState.buildMode!
  const def = BUILDING_DEFS[buildingType]
  if (!def) return

  if (!gameState.canAfford(getPlayerFaction(), def.cost)) return

  const sx = snapToGrid(mouseWorldX)
  const sz = snapToGrid(mouseWorldZ)
  if (!canPlaceBuilding(sx, sz, def.radius)) return

  const buildingEid = spawnBuilding(world, buildingType, getPlayerFaction(), sx, sz)

  // Store total cost in BuildProgress for gradual spending
  if (hasComponent(world, BuildProgress, buildingEid)) {
    BuildProgress.costMinerals[buildingEid] = def.cost.minerals
    BuildProgress.costGas[buildingEid] = def.cost.gas
    BuildProgress.spent[buildingEid] = 0
  }

  // Send a worker to build — with shift, distribute round-robin across selected workers
  const selected = selectedQuery(world)
  const workers = selected.filter(eid =>
    hasComponent(world, WorkerC, eid) && Faction.id[eid] === getPlayerFaction()
  )

  if (workers.length > 0) {
    if (shiftHeld) {
      // Round-robin: assign to the worker with the fewest queued commands
      const worker = workers.reduce((best, eid) => {
        const bestQ = getQueue(best).length
        const thisQ = getQueue(eid).length
        return thisQ < bestQ ? eid : best
      })
      pushCommand(worker, { type: 'build', targetEid: buildingEid })
    } else {
      // Immediate: send first worker
      const worker = workers[0]
      WorkerC.state[worker] = 4
      WorkerC.buildTarget[worker] = buildingEid
      const wx = Position.x[worker], wz = Position.z[worker]
      const dx = wx - sx, dz = wz - sz
      const d = Math.sqrt(dx * dx + dz * dz) || 1
      addComponent(world, MoveTarget, worker)
      MoveTarget.x[worker] = sx + (dx / d) * (def.radius + 1.0)
      MoveTarget.z[worker] = sz + (dz / d) * (def.radius + 1.0)
    }
  }

  if (shiftHeld) {
    spawnMoveMarker(sx, getTerrainHeight(sx, sz), sz)
  } else {
    gameState.buildMode = null
    buildModeEl.style.display = 'none'
    removeBuildPreview()
    // Deselect workers after placing building (not shift-queued)
    clearSelection(world)
  }
}

function setRallyFromClick(world: IWorld, sx: number, sy: number) {
  const hit = raycastGround(sx, sy)
  if (!hit) { setRallyMode(false); return }

  const selected = selectedQuery(world)

  // Check if clicked on a resource
  const nearbyR: number[] = []
  spatialHash.query(hit.x, hit.z, 2, nearbyR)
  let resEid = 0
  for (const r of nearbyR) {
    if (hasComponent(world, ResourceNode, r) && !hasComponent(world, Dead, r)) {
      const dx = Position.x[r] - hit.x, dz = Position.z[r] - hit.z
      if (dx * dx + dz * dz < 4) { resEid = r; break }
    }
  }

  for (const eid of selected) {
    if (!hasComponent(world, IsBuilding, eid) || !hasComponent(world, Producer, eid)) continue
    Producer.rallyX[eid] = hit.x
    Producer.rallyZ[eid] = hit.z
    Producer.rallyTargetEid[eid] = resEid
  }

  if (resEid > 0) {
    const tr = hasComponent(world, Selectable, resEid) ? Selectable.radius[resEid] : 0.8
    spawnActionIndicator(Position.x[resEid], Position.y[resEid], Position.z[resEid], tr + 0.3, 'gather')
  }
  spawnMoveMarker(hit.x, hit.y, hit.z)
  setRallyMode(false)
}

function forceAttackTarget(world: IWorld, sx: number, sy: number) {
  const hit = raycastGround(sx, sy)
  if (!hit) { setForceAttackMode(false); return }

  // Find ANY entity near click point (including own units/buildings)
  const nearby: number[] = []
  spatialHash.query(hit.x, hit.z, 3, nearby)

  const selected = selectedQuery(world)
  const selectedSet = new Set(selected)

  let targetEid = -1
  let targetDist = Infinity

  for (const eid of nearby) {
    if (!hasComponent(world, Position, eid)) continue
    if (selectedSet.has(eid)) continue // don't target yourself
    const dx = Position.x[eid] - hit.x
    const dz = Position.z[eid] - hit.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    const radius = hasComponent(world, Selectable, eid) ? Selectable.radius[eid] :
                   hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.5
    if (dist <= radius && dist < targetDist) {
      targetEid = eid
      targetDist = dist
    }
  }
  playSfx(`${getSelectedUnitSoundKey(world)}-attack`)

  if (targetEid >= 0) {
    const tr = hasComponent(world, Selectable, targetEid) ? Selectable.radius[targetEid] : 0.8
    spawnActionIndicator(Position.x[targetEid], Position.y[targetEid], Position.z[targetEid], tr + 0.3, 'attack')
    for (const eid of selected) {
      if (!hasComponent(world, Position, eid)) continue
      if (shiftHeld) {
        pushCommand(eid, { type: 'attack', targetEid })
      } else {
        clearQueue(eid)
        addComponent(world, AttackTarget, eid)
        AttackTarget.eid[eid] = targetEid
      }
    }
  } else {
    spawnMoveMarker(hit.x, hit.y, hit.z)
    for (const eid of selected) {
      if (shiftHeld) {
        pushCommand(eid, { type: 'attackMove', x: hit.x, z: hit.z })
      } else {
        clearQueue(eid)
        addComponent(world, MoveTarget, eid)
        MoveTarget.x[eid] = hit.x
        MoveTarget.z[eid] = hit.z
        // Mark as attack-move so combat system auto-acquires en route
        addComponent(world, AttackMove, eid)
        AttackMove.destX[eid] = hit.x
        AttackMove.destZ[eid] = hit.z
      }
    }
  }

  setForceAttackMode(false)
}

function onKeyDown(e: KeyboardEvent, world: IWorld) {
  // FPS mode handles its own keys — block all RTS hotkeys
  if (isFPSMode()) return
  // F1 handled by sharedButtons.ts

  if (matchesAction(e, 'cancel')) {
    if (forceAttackMode) {
      setForceAttackMode(false)
    } else if (rallyMode) {
      setRallyMode(false)
    } else if (gameState.buildMode !== null) {
      gameState.buildMode = null
      buildModeEl.style.display = 'none'
      removeBuildPreview()
    } else {
      clearSelection(world)
    }
    return
  }

  if (matchesAction(e, 'attackMove')) {
    const selected = selectedQuery(world)
    if (selected.length > 0) setForceAttackMode(true)
    return
  }

  if (matchesAction(e, 'stop') && !e.ctrlKey) {
    const selected = selectedQuery(world)
    for (const eid of selected) {
      if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
      if (hasComponent(world, AttackMove, eid)) removeComponent(world, AttackMove, eid)
      if (hasComponent(world, PathFollower, eid)) { removePath(PathFollower.pathId[eid]); removeComponent(world, PathFollower, eid) }
      Velocity.x[eid] = 0; Velocity.z[eid] = 0
      clearQueue(eid)
      if (hasComponent(world, WorkerC, eid)) WorkerC.state[eid] = 0
    }
    return
  }

  if (matchesAction(e, 'buildBarracks')) {
    const selected = selectedQuery(world)
    if (selected.some(eid => hasComponent(world, WorkerC, eid) && Faction.id[eid] === getPlayerFaction())) {
      enterBuildMode(BT_BARRACKS)
    }
    return
  }
  if (matchesAction(e, 'buildSupplyDepot')) { enterBuildMode(BT_SUPPLY_DEPOT); return }
  if (matchesAction(e, 'buildFactory')) { enterBuildMode(BT_FACTORY); return }
  if (matchesAction(e, 'buildCommandCenter')) { enterBuildMode(BT_COMMAND_CENTER); return }

  if (matchesAction(e, 'produce')) {
    // Produce first available unit
    const selected = selectedQuery(world)
    for (const eid of selected) {
      if (hasComponent(world, Producer, eid) && Faction.id[eid] === getPlayerFaction()) {
        const ut = UnitTypeC.id[eid]
        const bdef = BUILDING_DEFS[ut]
        if (bdef?.canProduce && bdef.canProduce.length > 0) {
          queueProduction(eid, bdef.canProduce[0])
        }
      }
    }
    return
  }

  // Control groups: Ctrl+1-9 assign, Shift+1-9 add, 1-9 select
  if (e.key >= '1' && e.key <= '9' && !e.altKey) {
    const num = parseInt(e.key)
    if (e.ctrlKey) {
      // Ctrl+N: assign selected to group N
      e.preventDefault()
      const selected = selectedQuery(world)
      // Remove these units from other groups first
      for (const [, set] of controlGroups) {
        for (const eid of selected) set.delete(eid)
      }
      controlGroups.set(num, new Set(selected))
      return
    } else if (e.shiftKey) {
      // Shift+N: add selected to group N
      const selected = selectedQuery(world)
      let group = controlGroups.get(num)
      if (!group) { group = new Set(); controlGroups.set(num, group) }
      for (const eid of selected) group.add(eid)
      return
    } else if (!isDebugEnabled()) {
      // N: select group (without debug mode — debug uses 1-9 for spawning)
      const group = controlGroups.get(num)
      if (group && group.size > 0) {
        clearSelection(world)
        // Clean dead entities from group
        for (const eid of group) {
          if (hasComponent(world, Dead, eid) || !hasComponent(world, Position, eid)) {
            group.delete(eid)
          } else {
            addComponent(world, Selected, eid)
          }
        }
      }
      return
    }
  }

  // Select all army (Ctrl+A)
  if (e.key === 'a' && e.ctrlKey) {
    e.preventDefault()
    clearSelection(world)
    const ents = selectableQuery(world)
    for (const eid of ents) {
      if (Faction.id[eid] !== getPlayerFaction()) continue
      if (hasComponent(world, IsBuilding, eid)) continue
      if (hasComponent(world, WorkerC, eid)) continue
      addComponent(world, Selected, eid)
    }
    return
  }
}

function showMobileBuildConfirm(world: IWorld) {
  buildModeEl.innerHTML = `Tap to reposition | <button id="build-confirm-btn" style="margin:0 6px;padding:4px 16px;border:1px solid #0f0;border-radius:4px;background:rgba(0,120,0,0.8);color:#fff;cursor:pointer;font-size:14px">Build</button><button id="build-cancel-btn" style="padding:4px 12px;border:1px solid #f44;border-radius:4px;background:rgba(120,0,0,0.8);color:#fff;cursor:pointer;font-size:14px">Cancel</button>`
  document.getElementById('build-confirm-btn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    placeBuildingAtCursor(world)
  })
  document.getElementById('build-cancel-btn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    gameState.buildMode = null
    buildModeEl.style.display = 'none'
    removeBuildPreview()
  })
}

export function cancelBuildMode() {
  gameState.buildMode = null
  buildModeEl.style.display = 'none'
  removeBuildPreview()
  // Restore action buttons
  const actionEl = document.getElementById('action-buttons')
  if (actionEl) actionEl.innerHTML = ''
}

export function enterBuildMode(buildingType: number) {
  const def = BUILDING_DEFS[buildingType]
  if (!def) return
  if (!gameState.canAfford(getPlayerFaction(), def.cost)) return

  gameState.buildMode = buildingType
  buildModeEl.textContent = `Building: ${def.name} — Click to place, ESC to cancel`
  buildModeEl.style.display = 'block'
  createBuildPreview(def.radius, def.meshPool)

  // Show Cancel button in action panel
  const actionEl = document.getElementById('action-buttons')
  if (actionEl) {
    actionEl.innerHTML = ''
    const cancelBtn = document.createElement('div')
    cancelBtn.className = 'action-btn'
    cancelBtn.innerHTML = '<span class="icon">❌</span><span class="label">Cancel</span>'
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); cancelBuildMode() })
    actionEl.appendChild(cancelBtn)
  }
}

export function queueProduction(buildingEid: number, unitType: number) {
  const def = UNIT_DEFS[unitType]
  if (!def) return

  const faction = Faction.id[buildingEid]
  if (!gameState.canAfford(faction, def.cost)) {
    if (faction === getPlayerFaction()) {
      const res = gameState.getResources(faction)
      if (res.minerals < def.cost.minerals) notifyNotEnoughMinerals()
      else notifyNotEnoughGas()
    }
    return
  }

  const res = gameState.getResources(faction)
  if (res.supplyCurrent + def.supply > res.supplyMax) {
    if (faction === getPlayerFaction()) notifyNotEnoughSupply()
    return
  }

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
  // On mobile, tap = left click (select or command)
  handleClick(world, sx, sy)
}

// ── Touch handlers ──────────────────────────────────────────

function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
}

let twoFingerPrevX = 0
let twoFingerPrevY = 0

function onTouchStart(e: TouchEvent, _world: IWorld) {
  if (isFPSMode()) return
  e.preventDefault()

  if (e.touches.length === 1) {
    const t = e.touches[0]
    touchStartScreenX = t.clientX
    touchStartScreenY = t.clientY
    touchStartTime = performance.now()
    isTouchPanning = false
    isTouchBoxSelecting = false
    cancelLongPress()
  }

  if (e.touches.length === 2) {
    cancelLongPress()
    // Cancel any in-progress box select
    if (isTouchBoxSelecting) {
      isTouchBoxSelecting = false
      selectionBoxEl.style.display = 'none'
    }
    // Start pinch + pan
    const dx = e.touches[0].clientX - e.touches[1].clientX
    const dy = e.touches[0].clientY - e.touches[1].clientY
    lastPinchDist = Math.sqrt(dx * dx + dy * dy)
    twoFingerPrevX = (e.touches[0].clientX + e.touches[1].clientX) / 2
    twoFingerPrevY = (e.touches[0].clientY + e.touches[1].clientY) / 2
    isTouchPanning = true
  }
}

function onTouchMove(e: TouchEvent, _world: IWorld) {
  if (isFPSMode()) return
  e.preventDefault()

  // ── Single finger: box select ──
  if (e.touches.length === 1) {
    const t = e.touches[0]
    const dx = Math.abs(t.clientX - touchStartScreenX)
    const dy = Math.abs(t.clientY - touchStartScreenY)

    // Start box selection after small movement
    if (!isTouchBoxSelecting && (dx > TOUCH_TAP_THRESHOLD || dy > TOUCH_TAP_THRESHOLD)) {
      isTouchBoxSelecting = true
      dragStartX = touchStartScreenX
      dragStartY = touchStartScreenY
    }

    if (isTouchBoxSelecting) {
      const left = Math.min(dragStartX, t.clientX)
      const top = Math.min(dragStartY, t.clientY)
      const w = Math.abs(t.clientX - dragStartX)
      const h = Math.abs(t.clientY - dragStartY)
      selectionBoxEl.style.display = 'block'
      selectionBoxEl.style.left = left + 'px'
      selectionBoxEl.style.top = top + 'px'
      selectionBoxEl.style.width = w + 'px'
      selectionBoxEl.style.height = h + 'px'
    }
  }

  // ── Two fingers: pan + pinch zoom ──
  if (e.touches.length === 2) {
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2

    // Pan camera — raycast previous and current midpoint to world for exact 1:1 finger tracking
    const prevHit = raycastGround(twoFingerPrevX, twoFingerPrevY)
    if (prevHit) {
      const px = prevHit.x, pz = prevHit.z // save before next raycast overwrites shared array
      const currHit = raycastGround(midX, midY)
      if (currHit) {
        setTouchPan(px - currHit.x, pz - currHit.z)
      }
    }
    twoFingerPrevX = midX
    twoFingerPrevY = midY
    const cam = rtsCameraRef

    // Pinch zoom — ratio-based (multiplicative) for consistent speed at all zoom levels
    const dx = e.touches[0].clientX - e.touches[1].clientX
    const dy = e.touches[0].clientY - e.touches[1].clientY
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (lastPinchDist > 0 && cam) {
      const ratio = dist / lastPinchDist // >1 spreading = zoom in, <1 pinching = zoom out
      cam.pinchZoom(ratio, midX, midY)
    }
    lastPinchDist = dist
  }
}

function onTouchEnd(e: TouchEvent, world: IWorld) {
  if (isFPSMode()) return
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
    setTouchPan(0, 0)
    return
  }

  // Two-finger pan finished
  if (isTouchPanning) {
    isTouchPanning = false
    setTouchPan(0, 0)
    return
  }

  // Single tap (no drag, no pan)
  if (gameState.buildMode !== null) {
    const def = BUILDING_DEFS[gameState.buildMode]
    if (def && !gameState.canAfford(getPlayerFaction(), def.cost)) {
      gameState.buildMode = null
      buildModeEl.style.display = 'none'
      removeBuildPreview()
    } else {
      const hit = raycastGround(sx, sy)
      if (hit) {
        mouseWorldX = hit.x
        mouseWorldZ = hit.z
        updateBuildPreview()
        showMobileBuildConfirm(world)
      }
    }
  } else if (rallyMode) {
    setRallyFromClick(world, sx, sy)
  } else if (forceAttackMode) {
    forceAttackTarget(world, sx, sy)
  } else {
    handleTouchTap(world, sx, sy)
  }

  isTouchPanning = false
  isTouchBoxSelecting = false
  setTouchPan(0, 0)
}
