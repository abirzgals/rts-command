import { createWorld } from 'bitecs'
import type { IWorld } from 'bitecs'
import { initRenderer, renderer, scene, camera, RTSCamera, setGroundPlane } from './render/engine'
import { createMeshPools } from './render/meshPools'
import { initInput } from './input/input'
import { spawnUnit, spawnBuilding, spawnResourceNode, spawnObstacle } from './ecs/archetypes'
import {
  FACTION_PLAYER, FACTION_ENEMY, UT_WORKER, UT_MARINE, UT_TANK, UT_JEEP, UT_ROCKET,
  BT_COMMAND_CENTER, BT_SUPPLY_DEPOT, BT_BARRACKS, BT_FACTORY,
  RES_MINERALS, RES_GAS,
} from './game/config'

// Terrain
import { generateTerrain, getTerrainHeight, getTerrainTypeAt, T_CLIFF, T_WATER, T_ROCK, GRID_RES, gridToWorld } from './terrain/heightmap'
import { isWorldWalkable } from './pathfinding/navGrid'
import { createTerrainMesh, updateWater } from './terrain/terrainMesh'
import { initNavGrid } from './pathfinding/navGrid'
import { buildSectorGraph } from './pathfinding/sectorGraph'

// Systems
import { movementSystem } from './ecs/systems/movementSystem'
import { combatSystem } from './ecs/systems/combatSystem'
import { resourceSystem } from './ecs/systems/resourceSystem'
import { productionSystem } from './ecs/systems/productionSystem'
import { projectileSystem } from './ecs/systems/projectileSystem'
import { deathSystem } from './ecs/systems/deathSystem'
import { renderSystem } from './ecs/systems/renderSystem'
import { supplySystem } from './ecs/systems/supplySystem'
import { aiSystem, seedAIRng } from './ecs/systems/aiSystem'
import { selectionVisualSystem } from './ecs/systems/selectionVisualSystem'
import { pathfindingSystem } from './ecs/systems/pathfindingSystem'
import { animationSystem } from './ecs/systems/animationSystem'
import { commandQueueSystem } from './ecs/systems/commandQueueSystem'
import { updateAllAnimations } from './render/animatedMeshManager'
import { initDebugOverlay, updateDebugOverlay } from './render/debugOverlay'
import { updateEffects, updateFallingPieces, updateBloodDecals } from './render/effects'
import { initHPBars, updateHPBars } from './render/hpBars'
import { initNotifications } from './ui/notifications'
import { initUnitCamera, updateUnitCamera } from './render/unitCamera'
import { isFPSMode, updateFPSMode, getFPSEntity } from './input/fpsMode'
import { checkVictory, isGameOver } from './game/victory'
import { profilerBeginFrame, profilerEndFrame, profilerBegin, profilerEnd, updateProfilerDisplay, setProfilerRenderer, setProfilerScene, captureGPUStats } from './debug/profiler'
import { isDebugEnabled } from './render/debugOverlay'
import { playMenuMusic, playIngameMusic, stopMusic, preloadSfx, setSoundEnabled } from './audio/audioManager'

// UI
import { updateHUD } from './ui/hud'
import { initFogOfWar, updateFogOfWar, renderFogOverlay, fogTexture, setFogMode, type FogMode } from './render/fogOfWar'
import { PRESETS, applyPreset, loadBindings, loadBindingsFromServer, listServerPresets, getPresetName, saveBindings } from './input/keybindings'
import { openSettingsUI } from './ui/settingsUI'
import { setTerrainFogMap } from './terrain/terrainMesh'
import { updateMinimap } from './ui/minimap'
import { initSharedButtons } from './ui/sharedButtons'
import { fetchMapList, fetchMap, loadMapIntoTerrain } from './terrain/mapData'

// ── World ────────────────────────────────────────────────────
const world: IWorld = createWorld()
;(window as any).__ecsWorld = world // expose for telemetry (F2)

// ── Init ─────────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas') as HTMLCanvasElement

// ── Async init ───────────────────────────────────────────────
let rtsCamera: RTSCamera

// ── Map selection overlay ────────────────────────────────────

interface MapSelection {
  map: 'random' | { name: string }
  fog: FogMode
  startingArmy: boolean
}

async function showMapSelector(): Promise<MapSelection> {
  // Load saved keybindings before showing menu
  loadBindings()
  // Respect sound preference
  const soundPref = localStorage.getItem('rts-sound')
  if (soundPref === 'off') setSoundEnabled(false)
  else playMenuMusic()

  const overlay = document.createElement('div')
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '1000',
    background: 'url(/images/menu-bg.jpg) center/cover no-repeat, #0a0a14',
    display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    fontFamily: "'Segoe UI', Arial, sans-serif",
  })

  const box = document.createElement('div')
  Object.assign(box.style, {
    background: 'rgba(10,10,25,0.85)', border: '1px solid rgba(100,150,255,0.2)', borderRadius: '12px',
    backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
    padding: '32px', minWidth: '360px', maxWidth: '500px', textAlign: 'center',
  })

  box.innerHTML = `
    <h1 style="color:#8af;font-size:24px;margin-bottom:4px">RTS Command</h1>
    <p style="color:#666;font-size:13px;margin-bottom:16px">Select a map to start</p>
    <div id="map-selector-list" style="margin-bottom:12px;max-height:200px;overflow-y:auto">
      <div style="color:#666">Loading maps...</div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <div style="flex:1;text-align:left;padding:8px 12px;background:#1a1a2a;border-radius:6px;border:1px solid #333">
        <div style="color:#888;font-size:11px;margin-bottom:6px">FOG OF WAR</div>
        <label style="color:#ccc;font-size:12px;display:block;margin:3px 0;cursor:pointer">
          <input type="radio" name="fog" value="normal" checked style="margin-right:4px">Normal
        </label>
        <label style="color:#ccc;font-size:12px;display:block;margin:3px 0;cursor:pointer">
          <input type="radio" name="fog" value="revealed" style="margin-right:4px">Map Revealed
        </label>
        <label style="color:#ccc;font-size:12px;display:block;margin:3px 0;cursor:pointer">
          <input type="radio" name="fog" value="disabled" style="margin-right:4px">Disabled
        </label>
      </div>
      <div style="flex:1;text-align:left;padding:8px 12px;background:#1a1a2a;border-radius:6px;border:1px solid #333">
        <div style="color:#888;font-size:11px;margin-bottom:6px">CONTROLS</div>
        <select id="menu-controls" style="width:100%;padding:6px;border:1px solid #444;border-radius:4px;background:#252535;color:#fff;font-size:12px;margin-bottom:6px">
          <option value="">Loading...</option>
        </select>
        <button id="menu-settings-btn" style="width:100%;padding:5px;border:1px solid #555;border-radius:4px;background:#252535;color:#aaf;cursor:pointer;font-size:12px">Customize Keys...</button>
        <label style="color:#ccc;font-size:12px;display:block;margin-top:8px;cursor:pointer">
          <input type="checkbox" id="menu-sound" checked style="margin-right:4px">Sound &amp; Music
        </label>
        <label style="color:#ccc;font-size:12px;display:block;margin-top:4px;cursor:pointer">
          <input type="checkbox" id="menu-army" style="margin-right:4px">Starting Army
        </label>
      </div>
    </div>
    <button id="btn-quick-start" style="
      padding:10px 32px;border:1px solid #4a8a4a;border-radius:6px;
      background:#2a5a2a;color:#fff;cursor:pointer;font-size:14px;width:100%
    "></button>
  `
  overlay.appendChild(box)
  document.body.appendChild(overlay)

  // Fetch maps
  let maps: { name: string; modified: string }[] = []
  try { maps = await fetchMapList() } catch { /* empty */ }

  const listEl = document.getElementById('map-selector-list')!
  if (maps.length === 0) {
    listEl.innerHTML = '<div style="color:#666;padding:12px">No saved maps. Use Map Editor to create one.</div>'
  } else {
    listEl.innerHTML = maps.map(m => `
      <div class="map-select-item" data-name="${m.name}" style="
        padding:10px 16px;margin:4px 0;border:1px solid #333;border-radius:6px;
        background:#1a1a2a;cursor:pointer;text-align:left;
      ">
        <div style="color:#aaf;font-size:14px">${m.name}</div>
        <div style="color:#666;font-size:11px">${new Date(m.modified).toLocaleString()}</div>
      </div>
    `).join('')
  }

  // Populate controls dropdown
  const controlsSelect = document.getElementById('menu-controls') as HTMLSelectElement
  ;(async () => {
    const serverPresets = await listServerPresets()
    controlsSelect.innerHTML = ''
    const currentName = getPresetName()
    // Built-in presets
    for (const p of PRESETS) {
      const opt = document.createElement('option')
      opt.value = `builtin:${p.name}`
      opt.textContent = p.name
      if (p.name === currentName) opt.selected = true
      controlsSelect.appendChild(opt)
    }
    // Server presets
    for (const name of serverPresets) {
      const opt = document.createElement('option')
      opt.value = `server:${name}`
      opt.textContent = name
      controlsSelect.appendChild(opt)
    }
    // Current if custom
    if (currentName === 'Custom') {
      const opt = document.createElement('option')
      opt.value = 'custom'
      opt.textContent = 'Custom'
      opt.selected = true
      controlsSelect.appendChild(opt)
    }
  })()

  controlsSelect.addEventListener('change', async () => {
    const val = controlsSelect.value
    if (val.startsWith('builtin:')) {
      const name = val.replace('builtin:', '')
      const preset = PRESETS.find(p => p.name === name)
      if (preset) { applyPreset(preset); saveBindings() }
    } else if (val.startsWith('server:')) {
      const name = val.replace('server:', '')
      await loadBindingsFromServer(name)
      saveBindings()
    }
  })

  document.getElementById('menu-settings-btn')!.addEventListener('click', () => {
    openSettingsUI()
  })

  // Sound preference
  const soundCheckbox = document.getElementById('menu-sound') as HTMLInputElement
  const savedSound = localStorage.getItem('rts-sound')
  const soundEnabled = savedSound !== 'off'
  soundCheckbox.checked = soundEnabled
  if (!soundEnabled) stopMusic()
  soundCheckbox.addEventListener('change', () => {
    localStorage.setItem('rts-sound', soundCheckbox.checked ? 'on' : 'off')
    if (soundCheckbox.checked) {
      setSoundEnabled(true)
      playMenuMusic()
    } else {
      setSoundEnabled(false)
      stopMusic()
    }
  })

  function getSelectedFog(): FogMode {
    const checked = overlay.querySelector<HTMLInputElement>('input[name="fog"]:checked')
    return (checked?.value as FogMode) || 'normal'
  }

  function getStartingArmy(): boolean {
    return (document.getElementById('menu-army') as HTMLInputElement)?.checked ?? false
  }

  // Quick start button — last played map or random
  const lastMap = localStorage.getItem('rts-last-map')
  const quickBtn = document.getElementById('btn-quick-start')!
  quickBtn.textContent = lastMap ? `Play: ${lastMap}` : 'Random Map'

  return new Promise(resolve => {
    quickBtn.addEventListener('click', () => {
      const fog = getSelectedFog()
      overlay.remove()
      if (lastMap) {
        localStorage.setItem('rts-last-map', lastMap)
        resolve({ map: { name: lastMap }, fog, startingArmy: getStartingArmy() })
      } else if (maps.length > 0) {
        // Pick a random map from the list
        const pick = maps[Math.floor(Math.random() * maps.length)]
        localStorage.setItem('rts-last-map', pick.name)
        resolve({ map: { name: pick.name }, fog, startingArmy: getStartingArmy() })
      } else {
        resolve({ map: 'random', fog, startingArmy: getStartingArmy() })
      }
    })

    // Map items
    for (const el of listEl.querySelectorAll('.map-select-item')) {
      (el as HTMLElement).addEventListener('mouseenter', () => {
        (el as HTMLElement).style.borderColor = '#4a6a9a'
      })
      ;(el as HTMLElement).addEventListener('mouseleave', () => {
        (el as HTMLElement).style.borderColor = '#333'
      })
      el.addEventListener('click', () => {
        const name = (el as HTMLElement).dataset.name!
        const fog = getSelectedFog()
        localStorage.setItem('rts-last-map', name)
        overlay.remove()
        resolve({ map: { name }, fog, startingArmy: getStartingArmy() })
      })
    }
  })
}

// ── Game init ────────────────────────────────────────────────

let mapSpawnPoints = { player: { x: -65, z: -65 }, enemy: { x: 65, z: 65 } }
let mapObjects: any[] = []
let isLoadedMap = false

async function init() {
  // 0. Map selection
  const selection = await showMapSelector()

  if (selection.map === 'random') {
    // 1a. Procedural terrain
    generateTerrain()
  } else {
    // 1b. Load saved map
    const mapData = await fetchMap(selection.map.name)
    const result = loadMapIntoTerrain(mapData)
    mapSpawnPoints = result.spawnPoints
    mapObjects = result.objects
    isLoadedMap = true
  }

  // Apply fog of war setting
  setFogMode(selection.fog)

  // 2. Init Three.js renderer + lighting
  initRenderer(canvas)

  // 3. Create terrain mesh from heightmap data
  const terrainMeshObj = createTerrainMesh()
  setGroundPlane(terrainMeshObj)

  // 4. Init navigation grid + sector graph from terrain
  initNavGrid()
  buildSectorGraph()

  // Seed AI RNG deterministically from map seed
  seedAIRng(Date.now())

  // 5. Load 3D models and create mesh pools
  await createMeshPools()

  // 6. Init input handling
  initInput(world)

  // 7. Camera — start at player base
  rtsCamera = new RTSCamera()
  ;(window as any).__rtsCamera = rtsCamera
  const camX = mapSpawnPoints.player.x
  const camZ = mapSpawnPoints.player.z
  rtsCamera.target.set(camX, getTerrainHeight(camX, camZ), camZ)
  rtsCamera.setHeightFunction(getTerrainHeight)

  // 8. Fog of war
  initFogOfWar()
  setTerrainFogMap(fogTexture)

  // 9. Debug overlay + HP bars + shared buttons
  initDebugOverlay()
  setProfilerRenderer(renderer)
  setProfilerScene(scene)
  initHPBars()
  initSharedButtons()
  initNotifications()
  initUnitCamera()

  // 9. Spawn initial entities (bases, resources, obstacles)
  setupMap(world, selection.startingArmy)

  // 10. If loaded map had objects, spawn them
  for (const obj of mapObjects) {
    if (obj.type === 'resource') {
      spawnResourceNode(world, obj.poolId === 21 ? RES_GAS : RES_MINERALS, obj.x, obj.z, obj.amount ?? 1500)
    } else {
      spawnObstacle(world, obj.poolId, obj.x, obj.z)
    }
  }

  // Set rally points on CCs to nearest minerals
  initRallyPoints(world)

  // Start ingame music + preload SFX
  playIngameMusic()
  preloadSfx()

  // Start game loop
  requestAnimationFrame(gameLoop)
}

import { Producer, Position as EcsPosition, Faction as EcsFaction, IsBuilding, ResourceNode, Dead } from './ecs/components'
import { spatialHash, updatePerfBudget } from './globals'
import { defineQuery as dq2, hasComponent as hc2 } from 'bitecs'

function initRallyPoints(world: IWorld) {
  const producers = dq2([Producer, EcsPosition, EcsFaction, IsBuilding])(world)
  for (const eid of producers) {
    const bx = EcsPosition.x[eid], bz = EcsPosition.z[eid]
    // Find nearest mineral within 20 units
    const nearby: number[] = []
    spatialHash.query(bx, bz, 20, nearby)
    let bestDist = Infinity, bestEid = 0
    for (const r of nearby) {
      if (!hc2(world, ResourceNode, r)) continue
      if (hc2(world, Dead, r)) continue
      // Prioritize minerals (type 0) over gas (type 1)
      const isMinerals = ResourceNode.type[r] === 0
      const dx = EcsPosition.x[r] - bx, dz = EcsPosition.z[r] - bz
      const dist = dx * dx + dz * dz + (isMinerals ? 0 : 10000)
      if (dist < bestDist) { bestDist = dist; bestEid = r }
    }
    if (bestEid > 0) {
      Producer.rallyX[eid] = EcsPosition.x[bestEid]
      Producer.rallyZ[eid] = EcsPosition.z[bestEid]
      Producer.rallyTargetEid[eid] = bestEid
    }
  }
}

init()

function spawnStartingArmy(world: IWorld, faction: number, cx: number, cz: number) {
  // Extra buildings for supply (army needs ~30 supply)
  spawnBuilding(world, BT_SUPPLY_DEPOT, faction, cx + 6, cz + 5, true)
  spawnBuilding(world, BT_SUPPLY_DEPOT, faction, cx - 6, cz + 5, true)
  spawnBuilding(world, BT_BARRACKS, faction, cx + 8, cz - 5, true)
  spawnBuilding(world, BT_FACTORY, faction, cx - 8, cz - 5, true)

  // 10 marines
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    spawnUnit(world, UT_MARINE, faction, cx + Math.cos(a) * 8, cz + Math.sin(a) * 8)
  }
  // 2 jeeps
  spawnUnit(world, UT_JEEP, faction, cx + 12, cz + 3)
  spawnUnit(world, UT_JEEP, faction, cx + 12, cz - 3)
  // 1 tank
  spawnUnit(world, UT_TANK, faction, cx + 15, cz)
  // 1 rocket
  spawnUnit(world, UT_ROCKET, faction, cx + 18, cz)
  // Extra workers
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.5
    spawnUnit(world, UT_WORKER, faction, cx + Math.cos(a) * 5, cz + Math.sin(a) * 5)
  }
}

function setupMap(world: IWorld, startingArmy = false) {
  const px = mapSpawnPoints.player.x, pz = mapSpawnPoints.player.z
  const ex = mapSpawnPoints.enemy.x, ez = mapSpawnPoints.enemy.z

  if (isLoadedMap) {
    // ── Loaded map: CC + 1 worker + 1 marine per side ──
    spawnBuilding(world, BT_COMMAND_CENTER, FACTION_PLAYER, px, pz, true)
    spawnUnit(world, UT_WORKER, FACTION_PLAYER, px + 4, pz + 3)
    spawnUnit(world, UT_MARINE, FACTION_PLAYER, px - 4, pz + 3)

    spawnBuilding(world, BT_COMMAND_CENTER, FACTION_ENEMY, ex, ez, true)
    spawnUnit(world, UT_WORKER, FACTION_ENEMY, ex + 4, ez + 3)
    spawnUnit(world, UT_MARINE, FACTION_ENEMY, ex - 4, ez + 3)

    if (startingArmy) {
      spawnStartingArmy(world, FACTION_PLAYER, px, pz)
      spawnStartingArmy(world, FACTION_ENEMY, ex, ez)
    }
  } else {
    // ── Random map: full starting base ──
    spawnBuilding(world, BT_COMMAND_CENTER, FACTION_PLAYER, px, pz, true)
    spawnBuilding(world, BT_SUPPLY_DEPOT, FACTION_PLAYER, px - 6, pz + 5, true)
    spawnBuilding(world, BT_BARRACKS, FACTION_PLAYER, px + 8, pz - 5, true)
    spawnBuilding(world, BT_FACTORY, FACTION_PLAYER, px - 7, pz - 6, true)

    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + 0.3
      spawnUnit(world, UT_WORKER, FACTION_PLAYER, px + Math.cos(angle) * 5, pz + Math.sin(angle) * 5)
    }
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2
      spawnUnit(world, UT_MARINE, FACTION_PLAYER, px + 12 + Math.cos(angle) * 3, pz + 3 + Math.sin(angle) * 3)
    }
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2
      spawnUnit(world, UT_TANK, FACTION_PLAYER, px + 18 + Math.cos(angle) * 3, pz + Math.sin(angle) * 3)
    }

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 0.6 + Math.PI * 0.7
      const dist = 10 + (i % 2) * 2.5
      spawnResourceNode(world, RES_MINERALS, px + Math.cos(angle) * dist, pz + Math.sin(angle) * dist, 1500)
    }
    spawnResourceNode(world, RES_GAS, px + 12, pz - 8, 2000)
    spawnResourceNode(world, RES_GAS, px - 8, pz + 12, 2000)

    spawnBuilding(world, BT_COMMAND_CENTER, FACTION_ENEMY, ex, ez, true)
    spawnBuilding(world, BT_SUPPLY_DEPOT, FACTION_ENEMY, ex + 6, ez - 5, true)
    spawnBuilding(world, BT_BARRACKS, FACTION_ENEMY, ex - 8, ez + 5, true)

    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + 0.3
      spawnUnit(world, UT_WORKER, FACTION_ENEMY, ex + Math.cos(angle) * 5, ez + Math.sin(angle) * 5)
    }

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 0.6 + Math.PI * 1.7
      const dist = 10 + (i % 2) * 2.5
      spawnResourceNode(world, RES_MINERALS, ex + Math.cos(angle) * dist, ez + Math.sin(angle) * dist, 1500)
    }
    spawnResourceNode(world, RES_GAS, ex - 12, ez + 8, 2000)
    spawnResourceNode(world, RES_GAS, ex + 8, ez - 12, 2000)

    if (startingArmy) {
      spawnStartingArmy(world, FACTION_PLAYER, px, pz)
      spawnStartingArmy(world, FACTION_ENEMY, ex, ez)
    }

    // Middle contested resources
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2
      spawnResourceNode(world, RES_MINERALS, Math.cos(angle) * 15, Math.sin(angle) * 15, 2000)
    }
    spawnResourceNode(world, RES_GAS, 5, 5, 3000)
    spawnResourceNode(world, RES_GAS, -5, -5, 3000)

    const spots = [[-40, 0], [0, -40], [40, 0], [0, 40], [-50, 50], [50, -50]]
    for (const [sx, sz] of spots) {
      for (let i = 0; i < 4; i++) {
        spawnResourceNode(world, RES_MINERALS, sx + (Math.random() - 0.5) * 8, sz + (Math.random() - 0.5) * 8, 1000)
      }
    }

    spawnMapObstacles(world)
  }
}

function spawnMapObstacles(world: IWorld) {
  const seed = 12345
  let s = seed
  const rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 }

  // Helper: check if position is far enough from bases (at -65,-65 and 65,65)
  const distToBase = (x: number, z: number) => Math.min(
    Math.sqrt((x + 65) ** 2 + (z + 65) ** 2),
    Math.sqrt((x - 65) ** 2 + (z - 65) ** 2),
  )

  // ── Cliff rocks along cliff edges ──
  for (let gz = 2; gz < GRID_RES - 2; gz += 3) {
    for (let gx = 2; gx < GRID_RES - 2; gx += 3) {
      const [wx, wz] = gridToWorld(gx, gz)
      if (getTerrainTypeAt(wx, wz) === T_CLIFF && distToBase(wx, wz) > 35) {
        if (rand() < 0.35) {
          spawnObstacle(world, 25, wx + (rand() - 0.5) * 1.5, wz + (rand() - 0.5) * 1.5)
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
      if (distToBase(wx, wz) < 35) continue

      const h = getTerrainHeight(wx, wz)
      // More rocks in elevated/rocky areas
      const rockChance = tt === T_ROCK ? 0.6 : h > 5 ? 0.3 : 0.08
      if (rand() < rockChance) {
        const ox = wx + (rand() - 0.5) * 3
        const oz = wz + (rand() - 0.5) * 3
        if (getTerrainTypeAt(ox, oz) !== T_WATER) {
          spawnObstacle(world, rand() < 0.5 ? 22 : 24, ox, oz)
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
      if (distToBase(wx, wz) < 35) continue

      const h = getTerrainHeight(wx, wz)
      // Trees in low to mid elevation grass/dirt
      const treeChance = h > 0 && h < 5 ? 0.15 : 0.04
      if (rand() < treeChance) {
        const ox = wx + (rand() - 0.5) * 2.5
        const oz = wz + (rand() - 0.5) * 2.5
        if (getTerrainTypeAt(ox, oz) !== T_WATER && distToBase(ox, oz) > 35) {
          spawnObstacle(world, 23, ox, oz)
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
      if (tt !== T_WATER && distToBase(wx, wz) > 35) {
        spawnObstacle(world, rand() < 0.4 ? 25 : 24, wx, wz)
      }
    }
  }
}

// ── Game loop ────────────────────────────────────────────────
let lastTime = 0

function prof(name: string, fn: () => void) {
  profilerBegin(name)
  fn()
  profilerEnd()
}

function gameLoop(time: number) {
  requestAnimationFrame(gameLoop)

  const dt = Math.min((time - lastTime) / 1000, 0.1)
  lastTime = time
  updatePerfBudget(dt)
  profilerBeginFrame()

  // FPS mode: update FPS camera, skip RTS camera
  const fpsCamera = isFPSMode() ? updateFPSMode(dt) : null
  const activeCamera = fpsCamera || camera

  if (!fpsCamera) {
    // Minimap click
    const minimapTarget = (window as any).__minimapTarget
    if (minimapTarget) {
      rtsCamera.target.x = minimapTarget.x
      rtsCamera.target.z = minimapTarget.z
      ;(window as any).__minimapTarget = null
    }
    prof('Camera', () => rtsCamera.update(dt))
  }

  // Victory check
  checkVictory(world, dt)
  if (isGameOver()) { profilerEndFrame(); return }

  // ECS systems
  profilerBegin('ECS')
  prof('Supply', () => supplySystem(world, dt))
  prof('CommandQueue', () => commandQueueSystem(world, dt))
  prof('AI', () => aiSystem(world, dt))
  prof('Production', () => productionSystem(world, dt))
  prof('Resources', () => resourceSystem(world, dt))
  prof('Combat', () => combatSystem(world, dt))
  prof('Projectiles', () => projectileSystem(world, dt))
  prof('Pathfinding', () => pathfindingSystem(world, dt))
  prof('Movement', () => movementSystem(world, dt))
  prof('Death', () => deathSystem(world, dt))
  prof('Animation', () => animationSystem(world, dt))
  prof('RenderSys', () => renderSystem(world, dt))
  profilerEnd()

  // Visual updates
  profilerBegin('Visual')
  prof('AnimMeshes', () => updateAllAnimations(dt))
  prof('Effects', () => updateEffects(dt))
  prof('Debris', () => updateFallingPieces(dt))
  prof('Blood', () => updateBloodDecals(dt))
  prof('Water', () => updateWater(dt))
  prof('Selection', () => selectionVisualSystem(world, dt))
  prof('FogOfWar', () => updateFogOfWar(world))
  prof('DebugOverlay', () => updateDebugOverlay(world))
  profilerEnd()

  // GPU render
  profilerBegin('Render')
  prof('Scene', () => { renderer.render(scene, activeCamera); captureGPUStats() })
  prof('FogOverlay', () => { if (!fpsCamera) renderFogOverlay(renderer, activeCamera) })
  profilerEnd()

  // UI
  profilerBegin('UI')
  prof('HPBars', () => updateHPBars(world))
  prof('HUD', () => updateHUD(world, dt, time))
  prof('Minimap', () => updateMinimap(world, time))
  prof('UnitCam', () => updateUnitCamera(world))
  profilerEnd()

  profilerEndFrame()
  updateProfilerDisplay(isDebugEnabled())
}
