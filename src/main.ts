import { createWorld } from 'bitecs'
import type { IWorld } from 'bitecs'
import { initRenderer, renderer, scene, camera, RTSCamera, setGroundPlane } from './render/engine'
import { createMeshPools } from './render/meshPools'
import { initInput } from './input/input'
import { spawnUnit, spawnBuilding, spawnResourceNode, spawnObstacle } from './ecs/archetypes'
import {
  FACTION_PLAYER, FACTION_ENEMY, UT_WORKER, UT_MARINE, UT_TANK,
  BT_COMMAND_CENTER, BT_SUPPLY_DEPOT, BT_BARRACKS, BT_FACTORY,
  RES_MINERALS, RES_GAS,
} from './game/config'

// Terrain
import { generateTerrain, getTerrainHeight, getTerrainTypeAt, T_CLIFF, T_WATER, T_ROCK, GRID_RES, gridToWorld } from './terrain/heightmap'
import { isWorldWalkable } from './pathfinding/navGrid'
import { createTerrainMesh, updateWater } from './terrain/terrainMesh'
import { initNavGrid } from './pathfinding/navGrid'

// Systems
import { movementSystem } from './ecs/systems/movementSystem'
import { combatSystem } from './ecs/systems/combatSystem'
import { resourceSystem } from './ecs/systems/resourceSystem'
import { productionSystem } from './ecs/systems/productionSystem'
import { projectileSystem } from './ecs/systems/projectileSystem'
import { deathSystem } from './ecs/systems/deathSystem'
import { renderSystem } from './ecs/systems/renderSystem'
import { supplySystem } from './ecs/systems/supplySystem'
import { aiSystem } from './ecs/systems/aiSystem'
import { selectionVisualSystem } from './ecs/systems/selectionVisualSystem'
import { pathfindingSystem } from './ecs/systems/pathfindingSystem'
import { animationSystem } from './ecs/systems/animationSystem'
import { updateAllAnimations } from './render/animatedMeshManager'
import { initDebugOverlay, updateDebugOverlay } from './render/debugOverlay'
import { updateEffects } from './render/effects'
import { initHPBars, updateHPBars } from './render/hpBars'

// UI
import { updateHUD } from './ui/hud'
import { updateMinimap } from './ui/minimap'
import { initSharedButtons } from './ui/sharedButtons'

// ── World ────────────────────────────────────────────────────
const world: IWorld = createWorld()

// ── Init ─────────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas') as HTMLCanvasElement

// ── Async init ───────────────────────────────────────────────
let rtsCamera: RTSCamera

async function init() {
  // 1. Generate terrain data
  generateTerrain()

  // 2. Init Three.js renderer + lighting
  initRenderer(canvas)

  // 3. Create terrain mesh from heightmap data
  const terrainMeshObj = createTerrainMesh()
  setGroundPlane(terrainMeshObj)

  // 4. Init navigation grid from terrain
  initNavGrid()

  // 5. Load 3D models and create mesh pools
  await createMeshPools()

  // 6. Init input handling
  initInput(world)

  // 7. Camera
  rtsCamera = new RTSCamera()
  rtsCamera.target.set(-80, getTerrainHeight(-80, -80), -80)
  rtsCamera.setHeightFunction(getTerrainHeight)

  // 8. Debug overlay + HP bars + shared buttons
  initDebugOverlay()
  initHPBars()
  initSharedButtons()

  // 9. Spawn initial map
  setupMap(world)

  // 9. Start game loop
  requestAnimationFrame(gameLoop)
}

init()

function setupMap(world: IWorld) {
  const px = -80, pz = -80

  // Player base
  spawnBuilding(world, BT_COMMAND_CENTER, FACTION_PLAYER, px, pz, true)
  spawnBuilding(world, BT_SUPPLY_DEPOT, FACTION_PLAYER, px - 5, pz + 4, true)

  // Starting workers
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2
    spawnUnit(world, UT_WORKER, FACTION_PLAYER, px + Math.cos(angle) * 3, pz + Math.sin(angle) * 3)
  }

  // Starting barracks + factory (pre-built)
  spawnBuilding(world, BT_BARRACKS, FACTION_PLAYER, px + 6, pz - 3, true)
  spawnBuilding(world, BT_FACTORY, FACTION_PLAYER, px + 6, pz + 5, true)

  // Starting marines
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2
    spawnUnit(world, UT_MARINE, FACTION_PLAYER, px + 10 + Math.cos(angle) * 3, pz + Math.sin(angle) * 3)
  }

  // Starting tanks
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2
    spawnUnit(world, UT_TANK, FACTION_PLAYER, px + 15 + Math.cos(angle) * 2, pz + Math.sin(angle) * 2)
  }

  // Player mineral patches
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 0.8 + Math.PI * 0.6
    const dist = 12 + (i % 3) * 2
    spawnResourceNode(world, RES_MINERALS, px + Math.cos(angle) * dist, pz + Math.sin(angle) * dist, 1500)
  }

  // Player gas
  spawnResourceNode(world, RES_GAS, px + 14, pz - 6, 2000)
  spawnResourceNode(world, RES_GAS, px - 6, pz + 14, 2000)

  // Enemy base
  const ex = 80, ez = 80
  spawnBuilding(world, BT_COMMAND_CENTER, FACTION_ENEMY, ex, ez, true)
  spawnBuilding(world, BT_SUPPLY_DEPOT, FACTION_ENEMY, ex + 5, ez - 4, true)

  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2
    spawnUnit(world, UT_WORKER, FACTION_ENEMY, ex + Math.cos(angle) * 3, ez + Math.sin(angle) * 3)
  }

  // Enemy minerals
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 0.8 + Math.PI * 1.6
    const dist = 12 + (i % 3) * 2
    spawnResourceNode(world, RES_MINERALS, ex + Math.cos(angle) * dist, ez + Math.sin(angle) * dist, 1500)
  }

  spawnResourceNode(world, RES_GAS, ex - 14, ez + 6, 2000)
  spawnResourceNode(world, RES_GAS, ex + 6, ez - 14, 2000)

  // Middle contested resources
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2
    spawnResourceNode(world, RES_MINERALS, Math.cos(angle) * 15, Math.sin(angle) * 15, 2000)
  }
  spawnResourceNode(world, RES_GAS, 5, 5, 3000)
  spawnResourceNode(world, RES_GAS, -5, -5, 3000)

  // Scattered resources
  const spots = [[-40, 0], [0, -40], [40, 0], [0, 40], [-50, 50], [50, -50]]
  for (const [sx, sz] of spots) {
    for (let i = 0; i < 4; i++) {
      spawnResourceNode(world, RES_MINERALS,
        sx + (Math.random() - 0.5) * 8,
        sz + (Math.random() - 0.5) * 8,
        1000,
      )
    }
  }

  // ── Scatter 3D obstacles across the map ──────────────────
  spawnMapObstacles(world)
}

function spawnMapObstacles(world: IWorld) {
  const seed = 12345
  let s = seed
  const rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 }

  // Helper: check if position is far enough from bases
  const distToBase = (x: number, z: number) => Math.min(
    Math.sqrt((x + 80) ** 2 + (z + 80) ** 2),
    Math.sqrt((x - 80) ** 2 + (z - 80) ** 2),
  )

  // ── Cliff rocks along cliff edges ──
  for (let gz = 2; gz < GRID_RES - 2; gz += 3) {
    for (let gx = 2; gx < GRID_RES - 2; gx += 3) {
      const [wx, wz] = gridToWorld(gx, gz)
      if (getTerrainTypeAt(wx, wz) === T_CLIFF && distToBase(wx, wz) > 25) {
        if (rand() < 0.35) {
          spawnObstacle(world, 25, wx + (rand() - 0.5) * 1.5, wz + (rand() - 0.5) * 1.5, 2.0)
        }
      }
    }
  }

  // ── Rock clusters in rocky/elevated areas ──
  for (let gz = 3; gz < GRID_RES - 3; gz += 5) {
    for (let gx = 3; gx < GRID_RES - 3; gx += 5) {
      const [wx, wz] = gridToWorld(gx, gz)
      const tt = getTerrainTypeAt(wx, wz)
      if (tt === T_WATER || tt === T_CLIFF) continue
      if (distToBase(wx, wz) < 28) continue

      const h = getTerrainHeight(wx, wz)
      // More rocks in elevated/rocky areas
      const rockChance = tt === T_ROCK ? 0.6 : h > 5 ? 0.3 : 0.08
      if (rand() < rockChance) {
        const ox = wx + (rand() - 0.5) * 3
        const oz = wz + (rand() - 0.5) * 3
        if (getTerrainTypeAt(ox, oz) !== T_WATER) {
          spawnObstacle(world, rand() < 0.5 ? 22 : 24, ox, oz, 1.2)
        }
      }
    }
  }

  // ── Trees in grassy areas ──
  for (let gz = 2; gz < GRID_RES - 2; gz += 4) {
    for (let gx = 2; gx < GRID_RES - 2; gx += 4) {
      const [wx, wz] = gridToWorld(gx, gz)
      const tt = getTerrainTypeAt(wx, wz)
      if (tt === T_WATER || tt === T_CLIFF || tt === T_ROCK) continue
      if (distToBase(wx, wz) < 22) continue

      const h = getTerrainHeight(wx, wz)
      // Trees in low to mid elevation grass/dirt
      const treeChance = h > 0 && h < 5 ? 0.15 : 0.04
      if (rand() < treeChance) {
        const ox = wx + (rand() - 0.5) * 2.5
        const oz = wz + (rand() - 0.5) * 2.5
        if (getTerrainTypeAt(ox, oz) !== T_WATER && distToBase(ox, oz) > 20) {
          spawnObstacle(world, 23, ox, oz, 0.8)
        }
      }
    }
  }

  // ── Strategic rock walls between lane corridors ──
  const walls = [
    { cx: -30, cz: -30, angle: Math.PI / 4, count: 6 },
    { cx: 30, cz: 30, angle: Math.PI / 4, count: 6 },
    { cx: -20, cz: 20, angle: -Math.PI / 6, count: 4 },
    { cx: 20, cz: -20, angle: Math.PI / 3, count: 4 },
  ]
  for (const wall of walls) {
    for (let i = 0; i < wall.count; i++) {
      const t = (i - wall.count / 2) * 3.5
      const wx = wall.cx + Math.cos(wall.angle) * t + (rand() - 0.5) * 1.5
      const wz = wall.cz + Math.sin(wall.angle) * t + (rand() - 0.5) * 1.5
      const tt = getTerrainTypeAt(wx, wz)
      if (tt !== T_WATER && distToBase(wx, wz) > 15) {
        spawnObstacle(world, rand() < 0.4 ? 25 : 24, wx, wz, 1.8)
      }
    }
  }
}

// ── Game loop ────────────────────────────────────────────────
let lastTime = 0

function gameLoop(time: number) {
  requestAnimationFrame(gameLoop)

  const dt = Math.min((time - lastTime) / 1000, 0.1)
  lastTime = time

  // Minimap click
  const minimapTarget = (window as any).__minimapTarget
  if (minimapTarget) {
    rtsCamera.target.x = minimapTarget.x
    rtsCamera.target.z = minimapTarget.z
    ;(window as any).__minimapTarget = null
  }

  rtsCamera.update(dt)

  // ECS systems
  supplySystem(world, dt)
  aiSystem(world, dt)
  productionSystem(world, dt)
  resourceSystem(world, dt)
  combatSystem(world, dt)
  projectileSystem(world, dt)
  pathfindingSystem(world, dt)
  movementSystem(world, dt)
  deathSystem(world, dt)
  animationSystem(world, dt)
  renderSystem(world, dt)
  updateAllAnimations(dt)
  updateEffects(dt)
  updateWater(dt)
  selectionVisualSystem(world, dt)
  updateDebugOverlay(world)

  renderer.render(scene, camera)

  updateHPBars(world)
  updateHUD(world, dt, time)
  updateMinimap(world, time)
}
