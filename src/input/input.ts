import * as THREE from 'three'
import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, Selected, Selectable, MoveTarget,
  AttackTarget, ResourceNode, ResourceDropoff, WorkerC, IsBuilding, UnitTypeC,
  Producer, PathFollower,
} from '../ecs/components'
import {
  FACTION_PLAYER, BUILDING_DEFS, UNIT_DEFS,
  BT_COMMAND_CENTER, BT_SUPPLY_DEPOT, BT_BARRACKS, BT_FACTORY,
} from '../game/config'
import { gameState } from '../game/state'
import { raycastGround, camera } from '../render/engine'
import { spawnBuilding } from '../ecs/archetypes'
import { spatialHash } from '../globals'

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

const selectionBoxEl = document.getElementById('selection-box')!
const buildModeEl = document.getElementById('build-mode')!

// Queries
let selectableQuery: ReturnType<typeof defineQuery>
let selectedQuery: ReturnType<typeof defineQuery>
let playerUnitQuery: ReturnType<typeof defineQuery>
let playerBuildingQuery: ReturnType<typeof defineQuery>

export function initInput(world: IWorld) {
  selectableQuery = defineQuery([Selectable, Position, Faction])
  selectedQuery = defineQuery([Selected])
  playerUnitQuery = defineQuery([Position, Faction, Selectable])
  playerBuildingQuery = defineQuery([Position, Faction, IsBuilding])

  const canvas = document.getElementById('game-canvas')!

  canvas.addEventListener('mousedown', (e) => onMouseDown(e, world))
  canvas.addEventListener('mousemove', (e) => onMouseMove(e, world))
  canvas.addEventListener('mouseup', (e) => onMouseUp(e, world))
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  window.addEventListener('keydown', (e) => onKeyDown(e, world))
}

function onMouseDown(e: MouseEvent, world: IWorld) {
  if (e.button === 0) { // Left click
    if (gameState.buildMode !== null) {
      placeBuildingAtCursor(world)
      return
    }
    isDragging = true
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

  if (e.button === 2) { // Right click
    handleRightClick(world, e.clientX, e.clientY)
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

  gameState.spend(FACTION_PLAYER, def.cost)
  spawnBuilding(world, buildingType, FACTION_PLAYER, mouseWorldX, mouseWorldZ)

  gameState.buildMode = null
  buildModeEl.style.display = 'none'
}

function onKeyDown(e: KeyboardEvent, world: IWorld) {
  if (e.key === 'Escape') {
    if (gameState.buildMode !== null) {
      gameState.buildMode = null
      buildModeEl.style.display = 'none'
    } else {
      clearSelection(world)
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
