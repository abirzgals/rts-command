import { createWorld } from 'bitecs'
import type { IWorld } from 'bitecs'
import { initRenderer, renderer, scene, camera, RTSCamera, setGroundPlane } from './render/engine'
import { createMeshPools } from './render/meshPools'
import { initInput } from './input/input'
import { spawnUnit, spawnBuilding, spawnResourceNode, spawnObstacle } from './ecs/archetypes'
import {
  FACTION_PLAYER, FACTION_ENEMY, UT_WORKER, UT_MARINE, UT_TANK, UT_JEEP, UT_ROCKET,
  BT_COMMAND_CENTER, BT_SUPPLY_DEPOT, BT_BARRACKS, BT_FACTORY,
  RES_MINERALS, RES_GAS, BUILDING_DEFS, UNIT_DEFS,
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
import { setTerrainFogMap, setFogDarkenMode } from './terrain/terrainMesh'
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
  multiplayer?: { faction: number; seed: number; vsAI?: boolean }
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
    <div style="display:flex;gap:8px;margin-top:8px">
      <button id="btn-multiplayer" style="
        flex:1;padding:10px 12px;border:1px solid #4a6a9a;border-radius:6px;
        background:#1a3a5a;color:#adf;cursor:pointer;font-size:14px
      ">PvP Online</button>
      <button id="btn-vs-ai" style="
        flex:1;padding:10px 12px;border:1px solid #6a5a3a;border-radius:6px;
        background:#3a2a1a;color:#fc8;cursor:pointer;font-size:14px
      ">vs AI Online</button>
    </div>
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
    const el = document.getElementById('menu-army') as HTMLInputElement
    const val = el?.checked ?? false
    console.log(`[MENU] getStartingArmy: element=${!!el}, checked=${val}`)
    return val
  }

  // Quick start button — last played map or random
  const lastMap = localStorage.getItem('rts-last-map')
  const quickBtn = document.getElementById('btn-quick-start')!
  quickBtn.textContent = lastMap ? `Play: ${lastMap}` : 'Random Map'

  return new Promise(resolve => {
    quickBtn.addEventListener('click', () => {
      const fog = getSelectedFog()
      const army = getStartingArmy()
      overlay.remove()
      if (lastMap) {
        localStorage.setItem('rts-last-map', lastMap)
        resolve({ map: { name: lastMap }, fog, startingArmy: army })
      } else if (maps.length > 0) {
        const pick = maps[Math.floor(Math.random() * maps.length)]
        localStorage.setItem('rts-last-map', pick.name)
        resolve({ map: { name: pick.name }, fog, startingArmy: army })
      } else {
        resolve({ map: 'random', fog, startingArmy: army })
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
        const army = getStartingArmy()
        localStorage.setItem('rts-last-map', name)
        overlay.remove()
        resolve({ map: { name }, fog, startingArmy: army })
      })
    }

    // Shared multiplayer connect helper
    async function startMultiplayer(btn: HTMLButtonElement, mode: 'pvp' | 'ai') {
      btn.textContent = 'Connecting...'
      btn.disabled = true

      const { connect: wsConnect, quickPlay: wsQuickPlay, playVsAI: wsPlayVsAI, on: wsOn } = await import('./network/netClient')
      const wsUrl = location.protocol === 'https:' ? `wss://${location.host}` : `ws://${location.host}`
      try {
        await wsConnect(wsUrl)
      } catch {
        btn.textContent = 'Connection failed — retry'
        btn.disabled = false
        return
      }

      // Pick a map
      const mapName = maps.length > 0 ? maps[Math.floor(Math.random() * maps.length)].name : 'random'
      if (mode === 'ai') {
        wsPlayVsAI('Player', mapName)
        btn.textContent = 'Starting vs AI...'
      } else {
        wsQuickPlay('Player', mapName)
        btn.textContent = 'Waiting for opponent...'
      }

      let mpFaction = 0
      wsOn('room_created', (d: any) => { mpFaction = d.faction ?? 0; if (mode === 'pvp') btn.textContent = 'Waiting for opponent...' })
      wsOn('room_joined', (d: any) => { mpFaction = d.faction ?? 1; btn.textContent = 'Starting...' })

      wsOn('game_start', (data: any) => {
        overlay.remove()
        resolve({
          map: data.mapName === 'random' ? 'random' : { name: data.mapName },
          fog: 'normal',
          startingArmy: false,
          multiplayer: { faction: mpFaction, seed: data.seed, vsAI: !!data.vsAI },
        })
      })
    }

    document.getElementById('btn-multiplayer')!.addEventListener('click', () => {
      startMultiplayer(document.getElementById('btn-multiplayer')! as HTMLButtonElement, 'pvp')
    })
    document.getElementById('btn-vs-ai')!.addEventListener('click', () => {
      startMultiplayer(document.getElementById('btn-vs-ai')! as HTMLButtonElement, 'ai')
    })
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

  // Multiplayer setup
  const isMP = !!selection.multiplayer
  if (isMP) {
    setPlayerFaction(selection.multiplayer!.faction)
    seedAIRng(selection.multiplayer!.seed)
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
  if (!isMP) seedAIRng(Date.now())

  // 5. Load 3D models and create mesh pools
  await createMeshPools()

  // 6. Init input handling
  initInput(world)

  // Register network command handlers for multiplayer
  registerNetHandlers({
    applyImmediate: (w, eids, cmd) => {
      for (const eid of eids) {
        clearQueue(eid)
        if (hc2(w, AttackTarget, eid)) rc2(w, AttackTarget, eid)
        if (hc2(w, PathFollower, eid)) rc2(w, PathFollower, eid)

        if (cmd.type === 'attack' && cmd.targetEid !== undefined) {
          ac2(w, AttackTarget, eid); AttackTarget.eid[eid] = cmd.targetEid
          ac2(w, MoveTarget, eid)
          MoveTarget.x[eid] = EcsPosition.x[cmd.targetEid]
          MoveTarget.z[eid] = EcsPosition.z[cmd.targetEid]
        } else if (cmd.type === 'attackMove' && cmd.x !== undefined) {
          ac2(w, MoveTarget, eid); MoveTarget.x[eid] = cmd.x; MoveTarget.z[eid] = cmd.z!
          ac2(w, AttackMove, eid); AttackMove.destX[eid] = cmd.x; AttackMove.destZ[eid] = cmd.z!
        } else if (cmd.type === 'gather' && cmd.targetEid !== undefined) {
          if (hc2(w, WorkerC, eid)) {
            WorkerC.state[eid] = 1; WorkerC.targetNode[eid] = cmd.targetEid
            ac2(w, MoveTarget, eid)
            MoveTarget.x[eid] = EcsPosition.x[cmd.targetEid]
            MoveTarget.z[eid] = EcsPosition.z[cmd.targetEid]
          }
        } else if (cmd.type === 'build' && cmd.targetEid !== undefined) {
          if (hc2(w, WorkerC, eid)) {
            WorkerC.state[eid] = 4; WorkerC.buildTarget[eid] = cmd.targetEid
            ac2(w, MoveTarget, eid)
            MoveTarget.x[eid] = EcsPosition.x[cmd.targetEid]
            MoveTarget.z[eid] = EcsPosition.z[cmd.targetEid]
          }
        } else if (cmd.type === 'move' && cmd.x !== undefined) {
          ac2(w, MoveTarget, eid); MoveTarget.x[eid] = cmd.x; MoveTarget.z[eid] = cmd.z!
        }
      }
    },
    applyProduce: (buildingEid, unitType) => {
      const def = UNIT_DEFS[unitType]
      if (!def) return
      const faction = EcsFaction.id[buildingEid]
      if (!gameState.canAfford(faction, def.cost)) return
      const res = gameState.getResources(faction)
      if (res.supplyCurrent + def.supply > res.supplyMax) return
      gameState.spend(faction, def.cost)
      res.supplyCurrent += def.supply
      const queue = gameState.getQueue(buildingEid)
      queue.push({ unitType, remaining: def.buildTime })
      if (Producer.active[buildingEid] === 0 && queue.length === 1) {
        Producer.active[buildingEid] = 1
        Producer.unitType[buildingEid] = unitType
        Producer.duration[buildingEid] = def.buildTime
        Producer.progress[buildingEid] = 0
      }
    },
    applyBuildPlace: (w, buildingType, x, z, faction, workerEids) => {
      const eid = spawnBuilding(w, buildingType, faction, x, z)
      for (const wid of workerEids) {
        pushCommand(wid, { type: 'build', targetEid: eid })
      }
    },
  })

  // 7. Camera — start at player base
  rtsCamera = new RTSCamera()
  ;(window as any).__rtsCamera = rtsCamera
  setRtsCameraRef(rtsCamera)
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

import {
  Producer, Position as EcsPosition, Faction as EcsFaction, IsBuilding, ResourceNode, Dead, CollisionRadius,
  MoveTarget, AttackTarget, AttackMove, WorkerC, PathFollower,
} from './ecs/components'
import { spatialHash, updatePerfBudget, setRtsCameraRef } from './globals'
import { gameState } from './game/state'
import { isMultiplayer, isVsAI, submitTurn, isTurnReady, consumeTurnCommands } from './network/netClient'
import { setPlayerFaction } from './game/factions'
import { applyNetworkCommands, registerNetHandlers, clearQueue, pushCommand } from './ecs/commandQueue'
import { defineQuery as dq2, hasComponent as hc2, addComponent as ac2, removeComponent as rc2 } from 'bitecs'

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

/** Find a safe spot for a building near (cx,cz), avoiding resources and other buildings */
function findSafeBuildSpot(world: IWorld, cx: number, cz: number, hintX: number, hintZ: number, buildRadius: number): { x: number; z: number } {
  // Collect resource positions near CC for corridor avoidance
  const resources: { x: number; z: number }[] = []
  const _n: number[] = []
  spatialHash.query(cx, cz, 25, _n)
  for (const eid of _n) {
    if (!hc2(world, ResourceNode, eid) || hc2(world, Dead, eid)) continue
    resources.push({ x: EcsPosition.x[eid], z: EcsPosition.z[eid] })
  }

  const spacing = buildRadius + 2.0
  const CORRIDOR = buildRadius + 3.0

  // Try hint direction first, then expanding search
  const hintAngle = Math.atan2(hintZ - cz, hintX - cx)
  const hintDist = Math.sqrt((hintX - cx) ** 2 + (hintZ - cz) ** 2)

  for (let attempt = 0; attempt < 48; attempt++) {
    // First try hint, then spiral outward
    let angle: number, dist: number
    if (attempt === 0) {
      angle = hintAngle; dist = hintDist
    } else {
      const ring = Math.floor((attempt - 1) / 12) + 2
      const a = ((attempt - 1) % 12)
      angle = (a / 12) * Math.PI * 2 + ring * 0.5
      dist = ring * 3
    }

    const sx = cx + Math.cos(angle) * dist
    const sz = cz + Math.sin(angle) * dist

    if (!isWorldWalkable(sx, sz)) continue

    // Check no building/resource overlap
    _n.length = 0
    spatialHash.query(sx, sz, spacing + 2, _n)
    let blocked = false
    for (const eid of _n) {
      if (!hc2(world, IsBuilding, eid) && !hc2(world, ResourceNode, eid)) continue
      if (hc2(world, Dead, eid)) continue
      const dx = EcsPosition.x[eid] - sx, dz = EcsPosition.z[eid] - sz
      const d = Math.sqrt(dx * dx + dz * dz)
      const oR = hc2(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 1.5
      if (d < spacing + oR) { blocked = true; break }
    }
    if (blocked) continue

    // Check not in mineral corridor
    let inCorridor = false
    for (const m of resources) {
      const mx = m.x - cx, mz = m.z - cz
      const mLen = Math.sqrt(mx * mx + mz * mz) || 1
      const mnx = mx / mLen, mnz = mz / mLen
      const px = sx - cx, pz = sz - cz
      const proj = px * mnx + pz * mnz
      if (proj > -2 && proj < mLen + 2) {
        const perpDist = Math.abs(px * (-mnz) + pz * mnx)
        if (perpDist < CORRIDOR) { inCorridor = true; break }
      }
    }
    if (inCorridor) continue

    return { x: sx, z: sz }
  }
  // Fallback: hint position (shouldn't happen often)
  return { x: hintX, z: hintZ }
}

/** Find a clear spot for a unit near (cx,cz), avoiding buildings */
function findSafeUnitSpot(world: IWorld, cx: number, cz: number, unitRadius: number): { x: number; z: number } {
  for (let ring = 1; ring <= 4; ring++) {
    const dist = ring * 2.5
    for (let a = 0; a < 8; a++) {
      const angle = (a / 8) * Math.PI * 2 + ring * 0.3
      const sx = cx + Math.cos(angle) * dist
      const sz = cz + Math.sin(angle) * dist
      if (!isWorldWalkable(sx, sz)) continue
      const _n: number[] = []
      spatialHash.query(sx, sz, unitRadius + 2, _n)
      let ok = true
      for (const eid of _n) {
        if (!hc2(world, IsBuilding, eid) || hc2(world, Dead, eid)) continue
        const dx = EcsPosition.x[eid] - sx, dz = EcsPosition.z[eid] - sz
        const d = Math.sqrt(dx * dx + dz * dz)
        const oR = hc2(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 1.5
        if (d < unitRadius + oR + 0.3) { ok = false; break }
      }
      if (ok) return { x: sx, z: sz }
    }
  }
  return { x: cx, z: cz }
}

function spawnStartingArmy(world: IWorld, faction: number, cx: number, cz: number) {
  // Extra buildings for supply — placed safely
  const spots = [
    findSafeBuildSpot(world, cx, cz, cx + 6, cz + 5, BUILDING_DEFS[BT_SUPPLY_DEPOT].radius),
    findSafeBuildSpot(world, cx, cz, cx - 6, cz + 5, BUILDING_DEFS[BT_SUPPLY_DEPOT].radius),
    findSafeBuildSpot(world, cx, cz, cx + 8, cz - 5, BUILDING_DEFS[BT_BARRACKS].radius),
    findSafeBuildSpot(world, cx, cz, cx - 8, cz - 5, BUILDING_DEFS[BT_FACTORY].radius),
  ]
  spawnBuilding(world, BT_SUPPLY_DEPOT, faction, spots[0].x, spots[0].z, true)
  spawnBuilding(world, BT_SUPPLY_DEPOT, faction, spots[1].x, spots[1].z, true)
  spawnBuilding(world, BT_BARRACKS, faction, spots[2].x, spots[2].z, true)
  spawnBuilding(world, BT_FACTORY, faction, spots[3].x, spots[3].z, true)

  // Units — placed safely around base
  const marineR = UNIT_DEFS[UT_MARINE]?.radius ?? 0.4
  for (let i = 0; i < 10; i++) {
    const s = findSafeUnitSpot(world, cx + Math.cos((i / 10) * Math.PI * 2) * 8, cz + Math.sin((i / 10) * Math.PI * 2) * 8, marineR)
    spawnUnit(world, UT_MARINE, faction, s.x, s.z)
  }
  const jeepR = UNIT_DEFS[UT_JEEP]?.radius ?? 0.8
  for (const [dx, dz] of [[12, 3], [12, -3]]) {
    const s = findSafeUnitSpot(world, cx + dx, cz + dz, jeepR)
    spawnUnit(world, UT_JEEP, faction, s.x, s.z)
  }
  const tankS = findSafeUnitSpot(world, cx + 15, cz, UNIT_DEFS[UT_TANK]?.radius ?? 1.2)
  spawnUnit(world, UT_TANK, faction, tankS.x, tankS.z)
  const rocketS = findSafeUnitSpot(world, cx + 18, cz, UNIT_DEFS[UT_ROCKET]?.radius ?? 1.0)
  spawnUnit(world, UT_ROCKET, faction, rocketS.x, rocketS.z)

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.5
    const s = findSafeUnitSpot(world, cx + Math.cos(a) * 5, cz + Math.sin(a) * 5, 0.4)
    spawnUnit(world, UT_WORKER, faction, s.x, s.z)
  }
}

function setupMap(world: IWorld, startingArmy = false) {
  console.log(`[SETUP] setupMap called: isLoadedMap=${isLoadedMap}, startingArmy=${startingArmy}`)
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
    // ── Random map: resources FIRST so findSafeBuildSpot can see them ──
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 0.6 + Math.PI * 0.7
      const dist = 10 + (i % 2) * 2.5
      spawnResourceNode(world, RES_MINERALS, px + Math.cos(angle) * dist, pz + Math.sin(angle) * dist, 1500)
    }
    spawnResourceNode(world, RES_GAS, px + 12, pz - 8, 2000)
    spawnResourceNode(world, RES_GAS, px - 8, pz + 12, 2000)

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 0.6 + Math.PI * 1.7
      const dist = 10 + (i % 2) * 2.5
      spawnResourceNode(world, RES_MINERALS, ex + Math.cos(angle) * dist, ez + Math.sin(angle) * dist, 1500)
    }
    spawnResourceNode(world, RES_GAS, ex - 12, ez + 8, 2000)
    spawnResourceNode(world, RES_GAS, ex + 8, ez - 12, 2000)

    // Player base
    spawnBuilding(world, BT_COMMAND_CENTER, FACTION_PLAYER, px, pz, true)
    const pSD = findSafeBuildSpot(world, px, pz, px - 6, pz + 5, BUILDING_DEFS[BT_SUPPLY_DEPOT].radius)
    spawnBuilding(world, BT_SUPPLY_DEPOT, FACTION_PLAYER, pSD.x, pSD.z, true)
    const pBR = findSafeBuildSpot(world, px, pz, px + 8, pz - 5, BUILDING_DEFS[BT_BARRACKS].radius)
    spawnBuilding(world, BT_BARRACKS, FACTION_PLAYER, pBR.x, pBR.z, true)
    const pFA = findSafeBuildSpot(world, px, pz, px - 7, pz - 6, BUILDING_DEFS[BT_FACTORY].radius)
    spawnBuilding(world, BT_FACTORY, FACTION_PLAYER, pFA.x, pFA.z, true)

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

    // Enemy base
    spawnBuilding(world, BT_COMMAND_CENTER, FACTION_ENEMY, ex, ez, true)
    const eSD = findSafeBuildSpot(world, ex, ez, ex + 6, ez - 5, BUILDING_DEFS[BT_SUPPLY_DEPOT].radius)
    spawnBuilding(world, BT_SUPPLY_DEPOT, FACTION_ENEMY, eSD.x, eSD.z, true)
    const eBR = findSafeBuildSpot(world, ex, ez, ex - 8, ez + 5, BUILDING_DEFS[BT_BARRACKS].radius)
    spawnBuilding(world, BT_BARRACKS, FACTION_ENEMY, eBR.x, eBR.z, true)

    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + 0.3
      spawnUnit(world, UT_WORKER, FACTION_ENEMY, ex + Math.cos(angle) * 5, ez + Math.sin(angle) * 5)
    }

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

const MP_TURN_DURATION = 0.1 // 100ms per turn = 10 turns/sec
let mpTurnAccum = 0
let mpTurnSubmitted = false

function runSimulation(dt: number) {
  profilerBegin('ECS')
  prof('Supply', () => supplySystem(world, dt))
  prof('CommandQueue', () => commandQueueSystem(world, dt))
  if (!isMultiplayer() || isVsAI()) prof('AI', () => aiSystem(world, dt)) // AI runs in single-player and vs-AI multiplayer
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

  // ── Simulation tick ──
  if (isMultiplayer()) {
    // Turn-based: accumulate time, submit commands, wait for confirmation
    mpTurnAccum += dt
    if (mpTurnAccum >= MP_TURN_DURATION && !mpTurnSubmitted) {
      submitTurn()
      mpTurnSubmitted = true
    }
    if (isTurnReady()) {
      const cmds = consumeTurnCommands()
      if (cmds) {
        applyNetworkCommands(world, cmds[0]) // faction 0 commands
        applyNetworkCommands(world, cmds[1]) // faction 1 commands
        runSimulation(MP_TURN_DURATION)
        mpTurnAccum -= MP_TURN_DURATION
        mpTurnSubmitted = false
      }
    }
  } else {
    // Single-player: run every frame as before
    runSimulation(dt)
  }

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
  setFogDarkenMode(!!fpsCamera)
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
