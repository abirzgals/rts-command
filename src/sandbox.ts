// ═══════════════════════════════════════════════════════════════════════════
//  RTS Command — Sandbox / Playground
//  Drag-and-drop entities onto a live 3D battlefield using real ECS systems.
//  No AI system — the user manually places and controls both factions.
// ═══════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'
import { createWorld, addComponent, removeComponent, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'

// ── Renderer / Scene ────────────────────────────────────────────────────────
import { initRenderer, renderer, scene, camera, RTSCamera, setGroundPlane, raycaster, groundPlane } from './render/engine'
import { createMeshPools } from './render/meshPools'

// ── ECS Archetypes ──────────────────────────────────────────────────────────
import { spawnUnit, spawnBuilding, spawnResourceNode, spawnObstacle } from './ecs/archetypes'

// ── Config constants ────────────────────────────────────────────────────────
import {
  FACTION_PLAYER, FACTION_ENEMY,
  RES_MINERALS,
  MAP_SIZE, UNIT_DEFS, BUILDING_DEFS,
  UT_WORKER, UT_MARINE, UT_TANK,
} from './game/config'

// ── Terrain ─────────────────────────────────────────────────────────────────
import { generateTerrain, getTerrainHeight, reseedTerrain } from './terrain/heightmap'
import { generateMazeTerrain, getMazeSpawns, getMazeGoal } from './terrain/mazeTerrain'
import { createTerrainMesh, terrainMesh, waterMesh, updateWater } from './terrain/terrainMesh'

// ── Pathfinding ─────────────────────────────────────────────────────────────
import { initNavGrid } from './pathfinding/navGrid'
import { buildSectorGraph } from './pathfinding/sectorGraph'

// ── ECS Systems (NO aiSystem!) ──────────────────────────────────────────────
import { movementSystem } from './ecs/systems/movementSystem'
import { combatSystem } from './ecs/systems/combatSystem'
import { resourceSystem } from './ecs/systems/resourceSystem'
import { productionSystem } from './ecs/systems/productionSystem'
import { projectileSystem } from './ecs/systems/projectileSystem'
import { deathSystem } from './ecs/systems/deathSystem'
import { renderSystem } from './ecs/systems/renderSystem'
import { supplySystem } from './ecs/systems/supplySystem'
import { selectionVisualSystem } from './ecs/systems/selectionVisualSystem'
import { pathfindingSystem } from './ecs/systems/pathfindingSystem'
import { animationSystem } from './ecs/systems/animationSystem'
import { updateAllAnimations } from './render/animatedMeshManager'
import { updateEffects } from './render/effects'
import { initHPBars, updateHPBars } from './render/hpBars'
import { spawnMoveMarker } from './render/effects'
import { initDebugOverlay, updateDebugOverlay } from './render/debugOverlay'
import { initSharedButtons } from './ui/sharedButtons'

// ── ECS Components (for selection / deletion) ───────────────────────────────
import {
  Position, Faction, Health, UnitTypeC, Dead,
  Selectable, Selected, ResourceNode,
  MoveTarget, AttackTarget, MoveSpeed,
} from './ecs/components'

// ── Globals ─────────────────────────────────────────────────────────────────
import { spatialHash } from './globals'
import { gameState } from './game/state'

// ═══════════════════════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════════════════════

let world: IWorld = createWorld()
let rtsCamera: RTSCamera
let paused = true  // start paused — place units first, then press Play
let entityCount = 0
let selectedEntity: number | null = null
let lastTime = 0

// Mobile: selected palette item for tap-to-place
let mobilePlacePayload: DragPayload | null = null

// ── DOM refs ────────────────────────────────────────────────────────────────
const canvas = document.getElementById('sandbox-canvas') as HTMLCanvasElement
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement
const btnRegen = document.getElementById('btn-regen') as HTMLButtonElement
const btnMaze = document.getElementById('btn-maze') as HTMLButtonElement
const elFPS = document.getElementById('fps') as HTMLSpanElement
const elEntityCount = document.getElementById('entity-count') as HTMLSpanElement
const elSelectedInfo = document.getElementById('selected-info') as HTMLSpanElement

// FPS tracking
let frameCount = 0
let fpsAccum = 0
let displayFps = 0

// ═══════════════════════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════════════════════

async function init() {
  // 1. Generate terrain heightmap + types
  generateTerrain()

  // 2. Init Three.js renderer with our canvas
  initRenderer(canvas)
  handleResize() // set correct size from the start

  // 3. Create terrain mesh and register ground plane
  const tmesh = createTerrainMesh()
  setGroundPlane(tmesh)

  // 4. Build navigation grid + sector graph from terrain data
  initNavGrid()
  buildSectorGraph()

  // 5. Load 3D models and create instanced mesh pools
  await createMeshPools()

  // 6. Init HP bar overlay + debug + shared buttons
  initHPBars()
  initDebugOverlay()
  initSharedButtons()
  ;(window as any).__ecsWorld = world // expose for telemetry (F2)

  // 7. Camera — start centered at map origin
  rtsCamera = new RTSCamera()
  rtsCamera.target.set(0, getTerrainHeight(0, 0), 0)
  rtsCamera.setHeightFunction(getTerrainHeight)

  // 8. Wire up controls
  wireControls()
  wireDragDrop()
  wireSelection()

  // 9. Start game loop
  requestAnimationFrame(gameLoop)
}

init()

// ═══════════════════════════════════════════════════════════════════════════
//  Resize handling (canvas does NOT fill the full window)
// ═══════════════════════════════════════════════════════════════════════════

function handleResize() {
  const rect = canvas.getBoundingClientRect()
  const w = rect.width
  const h = rect.height
  const dpr = Math.min(window.devicePixelRatio, 2)

  renderer.setSize(w, h, false)
  renderer.setPixelRatio(dpr)
  canvas.width = w * dpr
  canvas.height = h * dpr

  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

window.addEventListener('resize', handleResize)

// ═══════════════════════════════════════════════════════════════════════════
//  Game Loop (no AI system!)
// ═══════════════════════════════════════════════════════════════════════════

function gameLoop(time: number) {
  requestAnimationFrame(gameLoop)

  const dt = Math.min((time - lastTime) / 1000, 0.1)
  lastTime = time

  // FPS counter
  frameCount++
  fpsAccum += dt
  if (fpsAccum >= 0.5) {
    displayFps = Math.round(frameCount / fpsAccum)
    frameCount = 0
    fpsAccum = 0
    elFPS.textContent = `${displayFps} FPS`
  }

  // Camera
  rtsCamera.update(dt)

  // ECS systems (skip simulation when paused)
  if (!paused) {
    supplySystem(world, dt)
    productionSystem(world, dt)
    resourceSystem(world, dt)
    combatSystem(world, dt)
    projectileSystem(world, dt)
    pathfindingSystem(world, dt)
    movementSystem(world, dt)
    deathSystem(world, dt)
    animationSystem(world, dt)
  }

  // Rendering always runs
  renderSystem(world, dt)
  updateAllAnimations(dt)
  updateEffects(dt)
  updateWater(dt)
  selectionVisualSystem(world, dt)
  updateDebugOverlay(world)

  renderer.render(scene, camera)

  updateHPBars(world)

  // Update status bar
  elEntityCount.textContent = String(entityCount)
  updateSelectedInfo()
}

// ═══════════════════════════════════════════════════════════════════════════
//  Toolbar Controls
// ═══════════════════════════════════════════════════════════════════════════

function wireControls() {
  // Pause / Play
  btnPause.textContent = 'Play'  // start paused
  btnPause.addEventListener('click', () => {
    paused = !paused
    btnPause.textContent = paused ? 'Play' : 'Pause'
    btnPause.classList.toggle('primary', !paused)
    // When pressing Play, clear palette selection
    if (!paused) {
      mobilePlacePayload = null
      document.querySelectorAll('.palette-card').forEach(c => c.classList.remove('selected'))
      console.log('[sandbox] Play pressed. entityCount:', entityCount, 'spatialHash size:', (spatialHash as any).entityCells?.size)
    }
  })

  // Reset All
  btnReset.addEventListener('click', resetAll)

  // Regenerate Map
  btnRegen.addEventListener('click', regenerateMap)

  // Maze Test
  btnMaze.addEventListener('click', loadMazeTest)
}

function resetAll() {
  paused = true
  btnPause.textContent = 'Play'
  btnPause.classList.remove('primary')

  // Mark every entity with Position as dead
  const nearby: number[] = []
  spatialHash.query(0, 0, MAP_SIZE * 2, nearby)
  for (const eid of nearby) {
    if (!hasComponent(world, Dead, eid)) {
      addComponent(world, Dead, eid)
    }
  }

  // Run deathSystem to clean them all up
  deathSystem(world, 0)

  // Reset game state resources
  const pr = gameState.getResources(FACTION_PLAYER)
  pr.minerals = 400; pr.gas = 0; pr.supplyCurrent = 0; pr.supplyMax = 0
  const er = gameState.getResources(FACTION_ENEMY)
  er.minerals = 400; er.gas = 0; er.supplyCurrent = 0; er.supplyMax = 0

  entityCount = 0
  selectedEntity = null
  spatialHash.clear()
}

function regenerateMap() {
  // 1. Reset all entities
  resetAll()

  // 2. Remove existing terrain + water meshes from scene
  //    createTerrainMesh adds both terrain and a water plane, so remove both
  const toRemove: THREE.Object3D[] = []
  scene.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh
      // Identify terrain mesh and water mesh
      if (mesh === terrainMesh || mesh === waterMesh) {
        toRemove.push(mesh)
      }
    }
  })
  for (const obj of toRemove) {
    scene.remove(obj)
    const m = obj as THREE.Mesh
    m.geometry.dispose()
    if (Array.isArray(m.material)) {
      m.material.forEach(mat => mat.dispose())
    } else {
      (m.material as THREE.Material).dispose()
    }
  }

  // 3. Reseed + re-generate terrain heightmap + types
  reseedTerrain()
  generateTerrain()

  // 4. Recreate terrain mesh + ground plane
  const newMesh = createTerrainMesh()
  setGroundPlane(newMesh)

  // 5. Reinit navigation grid + sector graph
  initNavGrid()
  buildSectorGraph()
}

function loadMazeTest() {
  // 1. Reset everything
  resetAll()

  // 2. Remove terrain meshes
  const toRemove: THREE.Object3D[] = []
  scene.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh
      if (mesh === terrainMesh || mesh === waterMesh) toRemove.push(mesh)
    }
  })
  for (const obj of toRemove) {
    scene.remove(obj)
    const m = obj as THREE.Mesh
    m.geometry.dispose()
    if (Array.isArray(m.material)) m.material.forEach(mat => mat.dispose())
    else (m.material as THREE.Material).dispose()
  }

  // 3. Generate maze terrain (overwrites heightData/terrainType)
  generateMazeTerrain()

  // 4. Recreate terrain mesh
  const newMesh = createTerrainMesh()
  setGroundPlane(newMesh)

  // 5. Rebuild nav + sectors
  initNavGrid()
  buildSectorGraph()

  // 6. Spawn units
  const TYPE_MAP = { worker: UT_WORKER, marine: UT_MARINE, tank: UT_TANK } as const
  const spawns = getMazeSpawns()
  const playerUnits: number[] = []

  for (const s of spawns) {
    const eid = spawnUnit(world, TYPE_MAP[s.type], s.faction, s.x, s.z)
    entityCount++
    if (s.faction === FACTION_PLAYER) playerUnits.push(eid)
  }

  // 7. Send all player units to the maze goal
  const [goalX, goalZ] = getMazeGoal()
  for (const eid of playerUnits) {
    addComponent(world, MoveTarget, eid)
    MoveTarget.x[eid] = goalX
    MoveTarget.z[eid] = goalZ
  }

  // 8. Move camera to maze start area, unpause
  rtsCamera.target.set(-20, getTerrainHeight(-20, -50), -50)
  paused = false
  btnPause.textContent = 'Pause'
  btnPause.classList.add('primary')
}

// ═══════════════════════════════════════════════════════════════════════════
//  Drag & Drop from Palette
// ═══════════════════════════════════════════════════════════════════════════

interface DragPayload {
  type: 'unit' | 'building' | 'resource' | 'obstacle'
  id: number
  faction: number
}

function wireDragDrop() {
  const allCards = document.querySelectorAll('.palette-card[draggable]')

  // ── Desktop: HTML5 drag-and-drop ──
  allCards.forEach(card => {
    card.addEventListener('dragstart', (e: Event) => {
      const evt = e as DragEvent
      const el = evt.currentTarget as HTMLElement
      const payload: DragPayload = {
        type: el.dataset.type as DragPayload['type'],
        id: parseInt(el.dataset.id!, 10),
        faction: parseInt(el.dataset.faction!, 10),
      }
      evt.dataTransfer!.setData('application/json', JSON.stringify(payload))
      evt.dataTransfer!.effectAllowed = 'copy'
      el.classList.add('dragging')
    })

    card.addEventListener('dragend', (e: Event) => {
      const el = (e as DragEvent).currentTarget as HTMLElement
      el.classList.remove('dragging')
    })
  })

  canvas.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
  })

  canvas.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault()
    const raw = e.dataTransfer!.getData('application/json')
    if (!raw) return
    let payload: DragPayload
    try { payload = JSON.parse(raw) } catch { return }
    const pos = raycastCanvasToGround(e.clientX, e.clientY)
    if (!pos) return
    spawnFromPayload(payload, pos.x, pos.z)
  })

  // ── Mobile: tap card to select, tap canvas to place ──
  allCards.forEach(card => {
    card.addEventListener('click', (e: Event) => {
      e.preventDefault()
      const el = e.currentTarget as HTMLElement
      // Toggle selection
      const wasSelected = el.classList.contains('selected')
      allCards.forEach(c => c.classList.remove('selected'))
      mobilePlacePayload = null

      if (!wasSelected) {
        el.classList.add('selected')
        mobilePlacePayload = {
          type: el.dataset.type as DragPayload['type'],
          id: parseInt(el.dataset.id!, 10),
          faction: parseInt(el.dataset.faction!, 10),
        }
      }
    })
  })

  // Touch on canvas: place selected unit
  canvas.addEventListener('touchend', (e: TouchEvent) => {
    if (!mobilePlacePayload) return
    e.preventDefault()
    const touch = e.changedTouches[0]
    const pos = raycastCanvasToGround(touch.clientX, touch.clientY)
    if (!pos) return
    spawnFromPayload(payload_copy(mobilePlacePayload), pos.x, pos.z)
    // Keep the payload selected so user can place multiple
  })
}

function payload_copy(p: DragPayload): DragPayload {
  return { type: p.type, id: p.id, faction: p.faction }
}

/** Raycast from screen coords to the ground plane, accounting for canvas offset */
function raycastCanvasToGround(clientX: number, clientY: number): THREE.Vector3 | null {
  const rect = canvas.getBoundingClientRect()
  const mouse = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )
  raycaster.setFromCamera(mouse, camera)

  const intersects: THREE.Intersection[] = []
  if (groundPlane) {
    raycaster.intersectObject(groundPlane, false, intersects)
  }
  return intersects.length > 0 ? intersects[0].point : null
}

/** Spawn an entity from a drag payload at world (x, z). Auto-pauses if running. */
function spawnFromPayload(payload: DragPayload, x: number, z: number) {
  if (!paused) {
    paused = true
    btnPause.textContent = 'Play'
    btnPause.classList.remove('primary')
  }
  switch (payload.type) {
    case 'unit':
      spawnUnit(world, payload.id, payload.faction, x, z)
      entityCount++
      break

    case 'building':
      spawnBuilding(world, payload.id, payload.faction, x, z, true)
      entityCount++
      break

    case 'resource':
      spawnResourceNode(world, payload.id, x, z, 1500)
      entityCount++
      break

    case 'obstacle':
      spawnObstacle(world, payload.id, x, z)
      entityCount++
      break
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Click Selection & Deletion
// ═══════════════════════════════════════════════════════════════════════════

// ── Box selection state ──
let isDragging = false
let dragStartX = 0
let dragStartY = 0
const selBox = document.getElementById('selection-box')!

function wireSelection() {
  canvas.addEventListener('mousedown', onMouseDown)
  canvas.addEventListener('mousemove', onMouseMove)
  canvas.addEventListener('mouseup', onMouseUp)
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    onRightClick(e)
  })
  window.addEventListener('keydown', onKeyDown)
}

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  // If placing from palette, place immediately
  if (mobilePlacePayload) {
    const pos = raycastCanvasToGround(e.clientX, e.clientY)
    if (pos) spawnFromPayload(payload_copy(mobilePlacePayload), pos.x, pos.z)
    return
  }
  isDragging = true
  dragStartX = e.clientX
  dragStartY = e.clientY
  selBox.style.display = 'none'
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging) return
  const dx = e.clientX - dragStartX
  const dy = e.clientY - dragStartY
  // Only show box if dragged more than 5px
  if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return

  selBox.style.display = 'block'
  selBox.style.left = Math.min(dragStartX, e.clientX) + 'px'
  selBox.style.top = Math.min(dragStartY, e.clientY) + 'px'
  selBox.style.width = Math.abs(dx) + 'px'
  selBox.style.height = Math.abs(dy) + 'px'
}

function onMouseUp(e: MouseEvent) {
  if (e.button !== 0) return
  if (!isDragging) return
  isDragging = false

  const dx = Math.abs(e.clientX - dragStartX)
  const dy = Math.abs(e.clientY - dragStartY)

  if (dx < 5 && dy < 5) {
    // Single click — select one entity
    selBox.style.display = 'none'
    onCanvasClick(e)
    return
  }

  // Box select — find all entities within the screen-space rectangle
  selBox.style.display = 'none'

  // Clear previous selection
  if (selectedEntity !== null && hasComponent(world, Selected, selectedEntity)) {
    removeComponent(world, Selected, selectedEntity)
  }
  selectedEntity = null

  const rect = canvas.getBoundingClientRect()
  const x1 = Math.min(dragStartX, e.clientX)
  const y1 = Math.min(dragStartY, e.clientY)
  const x2 = Math.max(dragStartX, e.clientX)
  const y2 = Math.max(dragStartY, e.clientY)

  // Raycast corners to get world-space bounds
  const topLeft = raycastCanvasToGround(x1, y1)
  const botRight = raycastCanvasToGround(x2, y2)
  if (!topLeft || !botRight) return

  const minX = Math.min(topLeft.x, botRight.x)
  const maxX = Math.max(topLeft.x, botRight.x)
  const minZ = Math.min(topLeft.z, botRight.z)
  const maxZ = Math.max(topLeft.z, botRight.z)

  // Query spatial hash for the area
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const range = Math.max(maxX - minX, maxZ - minZ) / 2 + 2
  const nearby: number[] = []
  spatialHash.query(cx, cz, range, nearby)

  // Select all entities within the box using screen-space check
  let firstSelected = -1
  for (const eid of nearby) {
    if (hasComponent(world, Dead, eid)) continue
    if (!hasComponent(world, Position, eid)) continue
    if (!hasComponent(world, Selectable, eid)) continue

    // Project to screen and check if inside box
    const sv = new THREE.Vector3(Position.x[eid], Position.y[eid] + 1, Position.z[eid])
    sv.project(camera)
    const sx = ((sv.x + 1) / 2) * rect.width + rect.left
    const sy = ((-sv.y + 1) / 2) * rect.height + rect.top

    if (sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2) {
      addComponent(world, Selected, eid)
      if (firstSelected < 0) firstSelected = eid
    }
  }
  if (firstSelected >= 0) selectedEntity = firstSelected
}

function onCanvasClick(e: MouseEvent) {
  // If placing units from palette, don't select
  if (mobilePlacePayload) {
    const pos = raycastCanvasToGround(e.clientX, e.clientY)
    if (pos) spawnFromPayload(payload_copy(mobilePlacePayload), pos.x, pos.z)
    return
  }

  // Clear previous selection
  if (selectedEntity !== null && hasComponent(world, Selected, selectedEntity)) {
    removeComponent(world, Selected, selectedEntity)
  }
  selectedEntity = null

  // Raycast to ground to get world position
  const pos = raycastCanvasToGround(e.clientX, e.clientY)
  if (!pos) return

  // Query spatial hash for nearby entities
  const nearby: number[] = []
  spatialHash.query(pos.x, pos.z, 3.0, nearby)

  // Find the closest entity to the click point
  let bestEid = -1
  let bestDist = Infinity

  for (const eid of nearby) {
    if (hasComponent(world, Dead, eid)) continue
    if (!hasComponent(world, Position, eid)) continue

    const dx = Position.x[eid] - pos.x
    const dz = Position.z[eid] - pos.z
    const dist = Math.sqrt(dx * dx + dz * dz)

    // Check if within selection radius
    const radius = hasComponent(world, Selectable, eid) ? Selectable.radius[eid] : 1.0
    if (dist < radius + 1.5 && dist < bestDist) {
      bestDist = dist
      bestEid = eid
    }
  }

  if (bestEid >= 0) {
    selectedEntity = bestEid
    if (hasComponent(world, Selectable, bestEid)) {
      addComponent(world, Selected, bestEid)
    }
  }
}

function onRightClick(e: MouseEvent) {
  const pos = raycastCanvasToGround(e.clientX, e.clientY)
  if (!pos) return

  // Show target marker
  spawnMoveMarker(pos.x, pos.y, pos.z)

  // Find enemy near click point
  const nearby: number[] = []
  spatialHash.query(pos.x, pos.z, 2.0, nearby)

  let targetEid = -1
  let targetDist = Infinity
  for (const eid of nearby) {
    if (hasComponent(world, Dead, eid)) continue
    if (!hasComponent(world, Health, eid)) continue
    const dx = Position.x[eid] - pos.x
    const dz = Position.z[eid] - pos.z
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < targetDist) { targetDist = d; targetEid = eid }
  }

  // Command all selected units
  const allSelected: number[] = []
  spatialHash.query(0, 0, 9999, allSelected)
  for (const eid of allSelected) {
    if (!hasComponent(world, Selected, eid)) continue
    if (hasComponent(world, Dead, eid)) continue

    const myFaction = hasComponent(world, Faction, eid) ? Faction.id[eid] : -1

    if (targetEid >= 0 && targetDist < 3 && hasComponent(world, Faction, targetEid) && Faction.id[targetEid] !== myFaction) {
      addComponent(world, AttackTarget, eid)
      AttackTarget.eid[eid] = targetEid
    } else if (hasComponent(world, MoveSpeed, eid)) {
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = pos.x
      MoveTarget.z[eid] = pos.z
      if (hasComponent(world, AttackTarget, eid)) {
        removeComponent(world, AttackTarget, eid)
      }
    }
  }
}

function onKeyDown(e: KeyboardEvent) {
  // Delete or Backspace: remove selected entity
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEntity !== null) {
    e.preventDefault()
    if (!hasComponent(world, Dead, selectedEntity)) {
      addComponent(world, Dead, selectedEntity)
      entityCount = Math.max(0, entityCount - 1)
    }
    selectedEntity = null
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Status Bar — Selected Entity Info
// ═══════════════════════════════════════════════════════════════════════════

function updateSelectedInfo() {
  if (selectedEntity === null || !hasComponent(world, Position, selectedEntity)) {
    elSelectedInfo.textContent = ''
    return
  }

  const eid = selectedEntity
  const parts: string[] = []

  // Name
  if (hasComponent(world, UnitTypeC, eid)) {
    const typeId = UnitTypeC.id[eid]
    const udef = UNIT_DEFS[typeId]
    const bdef = BUILDING_DEFS[typeId]
    if (udef) parts.push(udef.name)
    else if (bdef) parts.push(bdef.name)
    else parts.push(`Type ${typeId}`)
  } else if (hasComponent(world, ResourceNode, eid)) {
    parts.push(ResourceNode.type[eid] === RES_MINERALS ? 'Minerals' : 'Gas Geyser')
  } else {
    parts.push(`Entity #${eid}`)
  }

  // Faction
  if (hasComponent(world, Faction, eid)) {
    parts.push(Faction.id[eid] === FACTION_PLAYER ? '[Player]' : '[Enemy]')
  }

  // HP
  if (hasComponent(world, Health, eid)) {
    const hp = Math.round(Health.current[eid])
    const max = Math.round(Health.max[eid])
    parts.push(`HP: ${hp}/${max}`)
  }

  // Resource amount
  if (hasComponent(world, ResourceNode, eid)) {
    parts.push(`Amount: ${Math.round(ResourceNode.amount[eid])}`)
  }

  // Position
  const px = Math.round(Position.x[eid])
  const pz = Math.round(Position.z[eid])
  parts.push(`Pos: (${px}, ${pz})`)

  elSelectedInfo.textContent = parts.join('  |  ')
}
