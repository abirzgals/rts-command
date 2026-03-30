import * as THREE from 'three'
import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, Selected, Selectable, MoveTarget, Velocity,
  AttackTarget, AttackMove, ResourceNode, ResourceDropoff, WorkerC, IsBuilding, UnitTypeC,
  Producer, PathFollower, BuildProgress, Dead, CollisionRadius,
} from '../ecs/components'
import {
  FACTION_PLAYER, BUILDING_DEFS, UNIT_DEFS,
  BT_COMMAND_CENTER, BT_SUPPLY_DEPOT, BT_BARRACKS, BT_FACTORY,
} from '../game/config'
import { gameState } from '../game/state'
import { raycastGround, camera, scene } from '../render/engine'
import { getPool } from '../render/meshPools'
import { toggleDebug } from '../render/debugOverlay'
import { spawnMoveMarker, spawnActionIndicator } from '../render/effects'
import { spawnBuilding } from '../ecs/archetypes'
import { spatialHash } from '../globals'
import { getTerrainHeight } from '../terrain/heightmap'
import { isWorldWalkable } from '../pathfinding/navGrid'
import { findPathHierarchical } from '../pathfinding/astar'
import { removePath } from '../pathfinding/pathStore'
import { pushCommand, clearQueue, type Command } from '../ecs/commandQueue'

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

function updateBuildPreview() {
  if (!buildPreview || gameState.buildMode === null) return
  const sx = snapToGrid(mouseWorldX)
  const sz = snapToGrid(mouseWorldZ)
  const y = getTerrainHeight(sx, sz)
  buildPreview.position.set(sx, y, sz)

  // Tint red if can't afford or blocked
  const def = BUILDING_DEFS[gameState.buildMode]
  const canAfford = def ? gameState.canAfford(FACTION_PLAYER, def.cost) : true
  const walkable = isWorldWalkable(sx, sz)
  const mat = buildPreview.material as THREE.MeshPhongMaterial | THREE.MeshBasicMaterial
  if (!canAfford || !walkable) {
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
  mouseX = e.clientX
  mouseY = e.clientY

  const hit = raycastGround(e.clientX, e.clientY)
  if (hit) {
    mouseWorldX = hit.x
    mouseWorldZ = hit.z
    updateBuildPreview()
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
  const nearby: number[] = []
  spatialHash.query(hit.x, hit.z, 3, nearby)

  let closestEid = -1
  let closestDist = Infinity

  for (const eid of nearby) {
    if (!hasComponent(world, Selectable, eid)) continue
    if (hasComponent(world, Dead, eid)) continue
    const dx = Position.x[eid] - hit.x
    const dz = Position.z[eid] - hit.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    const radius = Selectable.radius[eid]
    if (dist < radius + 1 && dist < closestDist) {
      closestDist = dist
      closestEid = eid
    }
  }

  // Classify what we clicked
  const clickedFriendly = closestEid >= 0 && hasComponent(world, Faction, closestEid) &&
    Faction.id[closestEid] === FACTION_PLAYER
  const clickedEnemy = closestEid >= 0 && hasComponent(world, Faction, closestEid) &&
    Faction.id[closestEid] !== FACTION_PLAYER && !hasComponent(world, Dead, closestEid)
  const clickedResource = closestEid >= 0 && hasComponent(world, ResourceNode, closestEid) &&
    !hasComponent(world, Dead, closestEid)
  const clickedBuildSite = closestEid >= 0 && hasComponent(world, BuildProgress, closestEid) &&
    hasComponent(world, Faction, closestEid) && Faction.id[closestEid] === FACTION_PLAYER

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
      if (Faction.id[eid] !== FACTION_PLAYER) continue
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

  // ── Click on friendly unit/building → select (or toggle with shift) ──
  if (clickedFriendly && !clickedResource && !clickedBuildSite) {
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

  // ── Units selected — issue command ──
  const movableUnits = selected.filter(eid =>
    Faction.id[eid] === FACTION_PLAYER && !hasComponent(world, IsBuilding, eid)
  )
  if (movableUnits.length === 0) {
    if (closestEid >= 0 && clickedFriendly) {
      clearSelection(world)
      addComponent(world, Selected, closestEid)
    }
    return
  }

  issueCommand(world, movableUnits, hit, closestEid, clickedEnemy, clickedResource, clickedBuildSite, shiftHeld)
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
    if (Faction.id[eid] !== FACTION_PLAYER) continue
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

function handleRightClick(world: IWorld, sx: number, sy: number) {
  const hit = raycastGround(sx, sy)
  const selected = selectedQuery(world)

  // If building with Producer selected → set rally point
  let hasProducer = false
  for (const eid of selected) {
    if (hasComponent(world, IsBuilding, eid) && hasComponent(world, Producer, eid)) {
      hasProducer = true
      if (hit) {
        // Check if rally on resource
        const nearbyR: number[] = []
        spatialHash.query(hit.x, hit.z, 2, nearbyR)
        let resEid = 0
        for (const r of nearbyR) {
          if (hasComponent(world, ResourceNode, r) && !hasComponent(world, Dead, r)) {
            const dx = Position.x[r] - hit.x, dz = Position.z[r] - hit.z
            if (dx * dx + dz * dz < 4) { resEid = r; break }
          }
        }
        Producer.rallyX[eid] = hit.x
        Producer.rallyZ[eid] = hit.z
        Producer.rallyTargetEid[eid] = resEid
        if (resEid > 0) {
          // Rally on resource — show gather indicator
          const tr = hasComponent(world, Selectable, resEid) ? Selectable.radius[resEid] : 0.8
          spawnActionIndicator(Position.x[resEid], Position.y[resEid], Position.z[resEid], tr + 0.3, 'gather')
        }
        spawnMoveMarker(hit.x, hit.y, hit.z)
      }
    }
  }
  if (hasProducer) return

  // Otherwise: deselect all
  clearSelection(world)
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
) {
  const count = movableUnits.length
  if (count === 0) return

  // Determine command type and show indicator
  let cmdType: 'move' | 'attack' | 'gather' | 'build' = 'move'
  if (clickedEnemy) cmdType = 'attack'
  else if (clickedResource) cmdType = 'gather'
  else if (clickedBuildSite) cmdType = 'build'

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
    let maxR = 0.5
    for (const eid of movableUnits) {
      if (hasComponent(world, CollisionRadius, eid)) maxR = Math.max(maxR, CollisionRadius.value[eid])
    }
    const cols = Math.ceil(Math.sqrt(count))
    const rows = Math.ceil(count / cols)
    const spacing = maxR * 2.8
    const srcX = Position.x[movableUnits[0]]
    const srcZ = Position.z[movableUnits[0]]

    slots = []
    for (let ring = 0; ring < 8 && slots.length < count; ring++) {
      const rStart = -Math.floor(rows / 2) - ring
      const rEnd = Math.ceil(rows / 2) + ring
      for (let r = rStart; r <= rEnd; r++) {
        for (let c = 0; c < cols + ring * 2; c++) {
          if (slots!.length >= count) break
          const sx = hit.x + (c - (cols + ring * 2 - 1) / 2) * spacing
          const sz = hit.z + r * spacing
          if (!isWorldWalkable(sx, sz)) continue
          const path = findPathHierarchical(srcX, srcZ, sx, sz, 0, 100)
          if (path && path.length >= 0) slots!.push({ x: sx, z: sz })
        }
        if (slots!.length >= count) break
      }
    }
    while (slots.length < count) slots.push({ x: hit.x, z: hit.z })

    // Angle-sorted slot assignment
    const unitAngles = movableUnits.map(eid => ({
      eid, angle: Math.atan2(Position.x[eid] - hit.x, Position.z[eid] - hit.z),
    }))
    unitAngles.sort((a, b) => a.angle - b.angle)
    const slotAngles = slots.map((s, i) => ({
      idx: i, angle: Math.atan2(s.x - hit.x, s.z - hit.z),
    }))
    slotAngles.sort((a, b) => a.angle - b.angle)
    assignments = new Map()
    for (let i = 0; i < unitAngles.length; i++) {
      assignments.set(unitAngles[i].eid, slotAngles[i % slotAngles.length].idx)
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
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = Position.x[closestEid]
      MoveTarget.z[eid] = Position.z[closestEid]
    } else if (cmdType === 'gather' && closestEid >= 0 && hasComponent(world, WorkerC, eid)) {
      WorkerC.state[eid] = 1
      WorkerC.targetNode[eid] = closestEid
      const buildingEnts = playerBuildingQuery(world)
      let nearestDropoff = 0xFFFFFFFF, nearestDD = Infinity
      for (const bid of buildingEnts) {
        if (Faction.id[bid] !== FACTION_PLAYER || !hasComponent(world, ResourceDropoff, bid)) continue
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
    } else {
      // Move to formation slot
      const slotIdx = assignments?.get(eid) ?? 0
      const slot = slots ? slots[slotIdx] : { x: hit.x, z: hit.z }
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = slot.x
      MoveTarget.z[eid] = slot.z
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
  // F1 handled by sharedButtons.ts

  if (e.key === 'Escape') {
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

  // Attack hotkey (A)
  if (e.key === 'a' || e.key === 'A') {
    const selected = selectedQuery(world)
    if (selected.length > 0) setForceAttackMode(true)
    return
  }

  // Stop hotkey (S) — stop moving, keep shooting in range
  if (e.key === 's' || e.key === 'S') {
    if (!e.ctrlKey) {
      const selected = selectedQuery(world)
      for (const eid of selected) {
        if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
        if (hasComponent(world, AttackMove, eid)) removeComponent(world, AttackMove, eid)
        if (hasComponent(world, PathFollower, eid)) { removePath(PathFollower.pathId[eid]); removeComponent(world, PathFollower, eid) }
        Velocity.x[eid] = 0; Velocity.z[eid] = 0
        clearQueue(eid)
        if (hasComponent(world, WorkerC, eid)) WorkerC.state[eid] = 0
      }
    }
    return
  }

  // Hold position hotkey (H) — stop moving, keep shooting in range
  if (e.key === 'h' || e.key === 'H') {
    const selected = selectedQuery(world)
    for (const eid of selected) {
      if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
      if (hasComponent(world, AttackMove, eid)) removeComponent(world, AttackMove, eid)
      if (hasComponent(world, PathFollower, eid)) { removePath(PathFollower.pathId[eid]); removeComponent(world, PathFollower, eid) }
      Velocity.x[eid] = 0; Velocity.z[eid] = 0
      clearQueue(eid)
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

function enterBuildMode(buildingType: number) {
  const def = BUILDING_DEFS[buildingType]
  if (!def) return
  if (!gameState.canAfford(FACTION_PLAYER, def.cost)) return

  gameState.buildMode = buildingType
  buildModeEl.innerHTML = `Building: ${def.name} — Click to place <button onclick="this.parentElement.style.display='none'" style="margin-left:12px;padding:2px 10px;border:1px solid #fff;border-radius:3px;background:rgba(0,0,0,0.5);color:#fff;cursor:pointer">Cancel</button>`
  buildModeEl.querySelector('button')?.addEventListener('click', () => {
    gameState.buildMode = null
    buildModeEl.style.display = 'none'
    removeBuildPreview()
  })
  buildModeEl.style.display = 'block'
  createBuildPreview(def.radius, def.meshPool)
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
  // On mobile, tap = left click (select or command)
  handleClick(world, sx, sy)
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
    setTouchPan(-(t.clientX - touchStartScreenX) * scale, -(t.clientY - touchStartScreenY) * scale)
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
    setTouchPan(0, 0)
    return
  }

  const elapsed = performance.now() - touchStartTime

  if (!isTouchPanning && elapsed < TOUCH_TAP_TIME) {
    // It's a tap
    if (gameState.buildMode !== null) {
      const def = BUILDING_DEFS[gameState.buildMode]
      if (def && !gameState.canAfford(FACTION_PLAYER, def.cost)) {
        gameState.buildMode = null
        buildModeEl.style.display = 'none'
        removeBuildPreview()
      } else {
        const hit = raycastGround(sx, sy)
        if (hit) {
          mouseWorldX = hit.x
          mouseWorldZ = hit.z
          updateBuildPreview()
          // Show confirm/cancel buttons for mobile
          showMobileBuildConfirm(world)
        }
      }
    } else if (rallyMode) {
      setRallyFromClick(world, sx, sy)
    } else if (forceAttackMode) {
      forceAttackTarget(world, sx, sy)
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
  setTouchPan(0, 0)
}
