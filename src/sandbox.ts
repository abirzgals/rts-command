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
} from './game/config'

// ── Terrain ─────────────────────────────────────────────────────────────────
import { generateTerrain, getTerrainHeight, reseedTerrain } from './terrain/heightmap'
import { createTerrainMesh, terrainMesh } from './terrain/terrainMesh'

// ── Pathfinding ─────────────────────────────────────────────────────────────
import { initNavGrid } from './pathfinding/navGrid'

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

// ── ECS Components (for selection / deletion) ───────────────────────────────
import {
  Position, Faction, Health, UnitTypeC, Dead,
  Selectable, Selected, ResourceNode,
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

  // 4. Build navigation grid from terrain data
  initNavGrid()

  // 5. Load 3D models and create instanced mesh pools
  await createMeshPools()

  // 6. Init HP bar overlay
  initHPBars()

  // 7. Camera — start centered at map origin
  rtsCamera = new RTSCamera()
  rtsCamera.target.set(0, getTerrainHeight(0, 0), 0)
  rtsCamera.setHeightFunction(getTerrainHeight)

  // 8. Wire up controls
  wireControls()
  wireDragDrop()
  wireSelection()

  // 9. Spawn a test pair to verify combat works
  const testX = 0
  const testZ = 0
  spawnUnit(world, 1, FACTION_PLAYER, testX - 3, testZ) // Marine player
  spawnUnit(world, 1, FACTION_ENEMY, testX + 3, testZ)  // Marine enemy
  entityCount += 2
  console.log('[sandbox] Spawned test pair at', testX, testZ)

  // 10. Start game loop
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
  selectionVisualSystem(world, dt)

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
      // Identify terrain mesh (vertex-colored Lambert) and water plane (Phong, transparent)
      if (mesh === terrainMesh ||
          (mesh.geometry instanceof THREE.PlaneGeometry &&
           mesh.material instanceof THREE.MeshPhongMaterial &&
           (mesh.material as THREE.MeshPhongMaterial).transparent)) {
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

  // 5. Reinit navigation grid
  initNavGrid()
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

function wireSelection() {
  canvas.addEventListener('click', onCanvasClick)
  window.addEventListener('keydown', onKeyDown)
}

function onCanvasClick(e: MouseEvent) {
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
