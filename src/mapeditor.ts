/**
 * Map Editor — terrain painting, height sculpting, object placement, save/load.
 */

import * as THREE from 'three'
import { initRenderer, renderer, scene, camera, RTSCamera, setGroundPlane, groundPlane } from './render/engine'
import { createMeshPools, getPool } from './render/meshPools'
import { generateTerrain, getTerrainHeight, heightData, terrainType, GRID_RES, worldToGrid, gridToWorld, T_WATER, T_GRASS, T_DIRT, T_ROCK, T_CLIFF, T_DARK_GRASS } from './terrain/heightmap'
import { createTerrainMesh, terrainMesh, waterMesh, updateWater, replaceTerrainTexture } from './terrain/terrainMesh'
import { initNavGrid } from './pathfinding/navGrid'
import { buildSectorGraph } from './pathfinding/sectorGraph'
import { applyPreset, type PresetName } from './terrain/terrainPresets'
import { applyBrush, type BrushTool, type BrushSettings } from './terrain/terrainEditor'
import { serializeCurrentMap, loadMapIntoTerrain, fetchMapList, fetchMap, saveMap, deleteMap, type MapObject, type SpawnPoints } from './terrain/mapData'
import { initSharedButtons } from './ui/sharedButtons'
import { invalidateDebugOverlay } from './render/debugOverlay'

// ── State ────────────────────────────────────────────────────

let rtsCamera: RTSCamera
let currentTool: BrushTool | 'objects' | 'spawns' = 'paint'
const brushSettings: BrushSettings = { tool: 'paint', radius: 5, strength: 0.5, terrainType: T_GRASS }

let placedObjects: MapObject[] = []
let objectMeshes: THREE.Object3D[] = [] // visual representations
let spawnPoints: SpawnPoints = { player: { x: -65, z: -65 }, enemy: { x: 65, z: 65 } }
let spawnMarkers: THREE.Mesh[] = []

let selectedObjPool = 20 // minerals by default
let selectedSpawn: 'player' | 'enemy' = 'player'

// Mirror modes: paint/place on one half, auto-mirror to the other
type MirrorMode = 'none' | 'lr' | 'tb' | 'diag'
let mirrorMode: MirrorMode = 'none'

let isPainting = false
let lastTime = 0

// ── DOM refs ─────────────────────────────────────────────────

const canvas = document.getElementById('map-canvas') as HTMLCanvasElement
const elMapName = document.getElementById('map-name') as HTMLInputElement
const elFps = document.getElementById('fps')!
const elStatusTool = document.getElementById('status-tool')!
const elStatusPos = document.getElementById('status-pos')!
const elStatusHeight = document.getElementById('status-height')!
const elStatusType = document.getElementById('status-type')!
const elMapList = document.getElementById('map-list')!
const elBrushCursor = document.getElementById('brush-cursor')!

const TERRAIN_TYPES = ['Grass', 'Dirt', 'Rock', 'Water', 'Cliff', 'DkGrass']

// ── Init ─────────────────────────────────────────────────────

async function init() {
  // 1. Generate default terrain
  applyPreset('islands')

  // 2. Renderer
  initRenderer(canvas)

  // 3. Terrain mesh
  const tmesh = createTerrainMesh()
  setGroundPlane(tmesh)

  // 4. Nav grid (for reference only)
  initNavGrid()
  buildSectorGraph()

  // 5. Load mesh pools (for object placement)
  await createMeshPools()

  // 6. Camera
  rtsCamera = new RTSCamera()
  rtsCamera.target.set(0, 3, 0)
  rtsCamera.setHeightFunction(getTerrainHeight)

  // 7. Spawn markers
  createSpawnMarkers()

  // 8. UI
  initSharedButtons()
  wireUI()
  refreshMapList()

  // 9. Render loop
  requestAnimationFrame(loop)
}

function loop(time: number) {
  requestAnimationFrame(loop)
  const dt = Math.min((time - lastTime) / 1000, 0.1)
  lastTime = time

  rtsCamera.update(dt)
  updateWater(dt)

  renderer.render(scene, camera)

  // FPS
  if (dt > 0) elFps.textContent = `${Math.round(1 / dt)} FPS`
}

// ── Terrain rebuild ──────────────────────────────────────────

function rebuildTerrain() {
  // Remove old meshes
  if (terrainMesh) { scene.remove(terrainMesh); terrainMesh.geometry.dispose(); (terrainMesh.material as THREE.Material).dispose() }
  if (waterMesh) { scene.remove(waterMesh); waterMesh.geometry.dispose(); (waterMesh.material as THREE.Material).dispose() }

  const tmesh = createTerrainMesh()
  setGroundPlane(tmesh)
  initNavGrid()
  buildSectorGraph()
  invalidateDebugOverlay()
}

/** Auto-texture: classify terrain type from height + slope */
function autoTextureFromGeometry() {
  const G = GRID_RES
  for (let gz = 0; gz < G; gz++) {
    for (let gx = 0; gx < G; gx++) {
      const i = gz * G + gx
      const h = heightData[i]

      // Compute slope (max height diff to cardinal neighbors)
      let slope = 0
      if (gx > 0)   slope = Math.max(slope, Math.abs(h - heightData[i - 1]))
      if (gx < G-1)  slope = Math.max(slope, Math.abs(h - heightData[i + 1]))
      if (gz > 0)   slope = Math.max(slope, Math.abs(h - heightData[i - G]))
      if (gz < G-1)  slope = Math.max(slope, Math.abs(h - heightData[i + G]))

      // Classification rules:
      // 0.70 = tan(35°) — matches navGrid unwalkable threshold
      if (h < -1.2) {
        terrainType[i] = T_WATER
      } else if (slope > 0.70) {
        terrainType[i] = T_CLIFF  // steep = cliff texture + unwalkable
      } else if (h > 7.0) {
        terrainType[i] = T_ROCK
      } else if (h > 4.5) {
        terrainType[i] = T_DARK_GRASS
      } else if (h > 2.0) {
        terrainType[i] = T_DIRT
      } else {
        terrainType[i] = T_GRASS
      }
    }
  }
  rebuildTerrain()
}

// ── Spawn markers ────────────────────────────────────────────

function createSpawnMarkers() {
  const geo = new THREE.ConeGeometry(1.5, 3, 8)
  const matP = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.7 })
  const matE = new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.7 })

  const mP = new THREE.Mesh(geo, matP)
  const mE = new THREE.Mesh(geo, matE)

  updateSpawnMarkerPos(mP, spawnPoints.player)
  updateSpawnMarkerPos(mE, spawnPoints.enemy)

  scene.add(mP, mE)
  spawnMarkers = [mP, mE]
}

function updateSpawnMarkerPos(marker: THREE.Mesh, pos: { x: number; z: number }) {
  const y = getTerrainHeight(pos.x, pos.z)
  marker.position.set(pos.x, y + 3, pos.z)
}

// ── Raycasting ───────────────────────────────────────────────

const raycaster = new THREE.Raycaster()
const mouse = new THREE.Vector2()

function raycastGround(clientX: number, clientY: number): THREE.Vector3 | null {
  const rect = canvas.getBoundingClientRect()
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(mouse, camera)

  if (groundPlane) {
    const hits = raycaster.intersectObject(groundPlane)
    if (hits.length > 0) return hits[0].point
  }

  // Fallback: intersect Y=3 plane
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -3)
  const target = new THREE.Vector3()
  raycaster.ray.intersectPlane(plane, target)
  return target
}

// ── Mirror helpers ───────────────────────────────────────────

/** Get mirrored world coordinates based on current mirror mode */
function getMirrorPoints(wx: number, wz: number): [number, number][] {
  const points: [number, number][] = [[wx, wz]]
  if (mirrorMode === 'lr') points.push([-wx, wz])     // flip X
  if (mirrorMode === 'tb') points.push([wx, -wz])      // flip Z
  if (mirrorMode === 'diag') points.push([-wx, -wz])   // flip both (180° rotation)
  return points
}

/** Mirror entire terrain: copy one half onto the other */
function mirrorTerrainNow() {
  const H = GRID_RES, MID = H / 2
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < H; gx++) {
      let sgx = gx, sgz = gz // source grid coords
      if (mirrorMode === 'lr' && gx >= MID) sgx = H - 1 - gx
      else if (mirrorMode === 'tb' && gz >= MID) sgz = H - 1 - gz
      else if (mirrorMode === 'diag' && (gx + gz >= H - 1)) { sgx = H - 1 - gx; sgz = H - 1 - gz }
      else continue // this cell IS the source — skip

      const si = sgz * H + sgx
      const di = gz * H + gx
      heightData[di] = heightData[si]
      terrainType[di] = terrainType[si]
    }
  }
  // Also mirror objects
  const mirrored: MapObject[] = []
  for (const obj of placedObjects) {
    const pts = getMirrorPoints(obj.x, obj.z)
    if (pts.length > 1) {
      mirrored.push({ ...obj, x: pts[1][0], z: pts[1][1], rotation: obj.rotation + Math.PI })
    }
  }
  placedObjects.push(...mirrored)

  // Auto-set spawns symmetrically
  if (mirrorMode !== 'none') {
    const sp = spawnPoints.player
    const mp = getMirrorPoints(sp.x, sp.z)
    if (mp.length > 1) {
      spawnPoints.enemy = { x: mp[1][0], z: mp[1][1] }
      updateSpawnMarkerPos(spawnMarkers[1], spawnPoints.enemy)
    }
  }

  rebuildTerrain()
}

// ── Mouse handling ───────────────────────────────────────────

function onMouseDown(e: MouseEvent) {
  if (e.button === 2) return
  if (e.button !== 0) return

  const pos = raycastGround(e.clientX, e.clientY)
  if (!pos) return

  if (currentTool === 'objects') {
    for (const [mx, mz] of getMirrorPoints(pos.x, pos.z)) placeObject(mx, mz)
  } else if (currentTool === 'spawns') {
    placeSpawn(pos.x, pos.z)
  } else if (currentTool === 'delete') {
    isPainting = true
    deleteObjectAt(pos.x, pos.z)
  } else {
    isPainting = true
    for (const [mx, mz] of getMirrorPoints(pos.x, pos.z)) applyBrush(mx, mz, brushSettings, 0.05)
  }
}

function onMouseMove(e: MouseEvent) {
  const pos = raycastGround(e.clientX, e.clientY)
  if (!pos) return

  const [gx, gz] = worldToGrid(pos.x, pos.z)
  const i = gz * GRID_RES + gx
  elStatusPos.textContent = `Pos: ${pos.x.toFixed(0)}, ${pos.z.toFixed(0)}`
  elStatusHeight.textContent = `H: ${heightData[i]?.toFixed(1) ?? '-'}`
  elStatusType.textContent = `Type: ${TERRAIN_TYPES[terrainType[i]] ?? '-'}`

  if (currentTool !== 'objects' && currentTool !== 'spawns' && currentTool !== 'delete') {
    elBrushCursor.style.display = 'block'
    const r = brushSettings.radius * 8
    elBrushCursor.style.width = r * 2 + 'px'
    elBrushCursor.style.height = r * 2 + 'px'
    elBrushCursor.style.left = e.clientX + 'px'
    elBrushCursor.style.top = e.clientY + 'px'
  } else {
    elBrushCursor.style.display = 'none'
  }

  // Continuous painting/deleting — mirrored
  if (isPainting && currentTool === 'delete') {
    deleteObjectAt(pos.x, pos.z)
  }
  if (isPainting && !['objects', 'spawns', 'delete'].includes(currentTool)) {
    for (const [mx, mz] of getMirrorPoints(pos.x, pos.z)) applyBrush(mx, mz, brushSettings, 0.016)
  }
}

function onMouseUp() {
  if (isPainting) {
    isPainting = false
    // Rebuild water mesh after paint stroke (water cells may have changed)
    rebuildTerrain()
  }
}

// ── Object placement ─────────────────────────────────────────

function placeObject(wx: number, wz: number) {
  const y = getTerrainHeight(wx, wz)
  const rot = Math.random() * Math.PI * 2
  const isResource = selectedObjPool === 20 || selectedObjPool === 21

  const obj: MapObject = {
    type: isResource ? 'resource' : 'obstacle',
    poolId: selectedObjPool,
    x: wx, z: wz, rotation: rot,
    amount: isResource ? 1500 : undefined,
  }
  placedObjects.push(obj)

  // Visual
  const pool = getPool(selectedObjPool)
  if (pool) {
    const idx = pool.add(placedObjects.length + 1000, wx, y + (isResource ? 0.8 : 0), wz, rot)
  }
}

// ── Delete object at position ────────────────────────────────

function deleteObjectAt(wx: number, wz: number) {
  const RADIUS = 2.0
  let bestIdx = -1
  let bestDist = RADIUS

  for (let i = 0; i < placedObjects.length; i++) {
    const obj = placedObjects[i]
    const dx = obj.x - wx
    const dz = obj.z - wz
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
  }

  if (bestIdx >= 0) {
    placedObjects.splice(bestIdx, 1)
    // Rebuild all object visuals (simplest approach)
    rebuildObjectVisuals()
  }
}

function rebuildObjectVisuals() {
  // Clear all mesh pools used for objects (20-25)
  for (const poolId of [20, 21, 22, 23, 24, 25]) {
    const pool = getPool(poolId)
    if (pool) pool.clear()
  }
  // Re-add all placed objects
  for (let i = 0; i < placedObjects.length; i++) {
    const obj = placedObjects[i]
    const pool = getPool(obj.poolId)
    if (pool) {
      const y = getTerrainHeight(obj.x, obj.z) + (obj.type === 'resource' ? 0.8 : 0)
      pool.add(i + 2000, obj.x, y, obj.z, obj.rotation)
    }
  }
}

// ── Scatter nature objects ───────────────────────────────────

let scatterSeed = Date.now()

function scatterNature() {
  // Clear existing objects
  placedObjects.length = 0
  scatterSeed = Date.now()

  let s = scatterSeed % 2147483647
  const rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 }

  const MAP_HALF = 100
  // Keep spawn areas clear
  const distToSpawn = (x: number, z: number) => Math.min(
    Math.sqrt((x - spawnPoints.player.x) ** 2 + (z - spawnPoints.player.z) ** 2),
    Math.sqrt((x - spawnPoints.enemy.x) ** 2 + (z - spawnPoints.enemy.z) ** 2),
  )

  // Tree clusters: groups of 3-6 trees in natural clumps
  const CLUSTER_COUNT = 25
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    const cx = (rand() - 0.5) * MAP_HALF * 1.6
    const cz = (rand() - 0.5) * MAP_HALF * 1.6
    if (distToSpawn(cx, cz) < 25) continue

    const h = getTerrainHeight(cx, cz)
    if (h < -0.5 || h > 8) continue // no trees underwater or on peaks

    const count = 3 + Math.floor(rand() * 4)
    for (let i = 0; i < count; i++) {
      const tx = cx + (rand() - 0.5) * 6
      const tz = cz + (rand() - 0.5) * 6
      const th = getTerrainHeight(tx, tz)
      if (th < -0.5 || th > 8) continue
      placedObjects.push({
        type: 'obstacle', poolId: 23, // tree
        x: tx, z: tz, rotation: rand() * Math.PI * 2,
      })
    }
  }

  // Rock formations: scattered rocks and boulders on slopes and high ground
  const ROCK_COUNT = 40
  for (let i = 0; i < ROCK_COUNT; i++) {
    const rx = (rand() - 0.5) * MAP_HALF * 1.6
    const rz = (rand() - 0.5) * MAP_HALF * 1.6
    if (distToSpawn(rx, rz) < 20) continue

    const h = getTerrainHeight(rx, rz)
    if (h < -0.5) continue

    // Prefer higher ground and slopes for rocks
    const chance = h > 4 ? 0.8 : h > 2 ? 0.5 : 0.2
    if (rand() > chance) continue

    const poolId = rand() < 0.4 ? 24 : rand() < 0.7 ? 22 : 25 // boulder, rock1, rock2
    placedObjects.push({
      type: 'obstacle', poolId,
      x: rx, z: rz, rotation: rand() * Math.PI * 2,
    })
  }

  // Rebuild visuals
  rebuildObjectVisuals()

  // Mirror objects if mirror mode active
  if (mirrorMode !== 'none') {
    const origLen = placedObjects.length
    for (let i = 0; i < origLen; i++) {
      const obj = placedObjects[i]
      const pts = getMirrorPoints(obj.x, obj.z)
      if (pts.length > 1) {
        placedObjects.push({ ...obj, x: pts[1][0], z: pts[1][1], rotation: obj.rotation + Math.PI })
      }
    }
    rebuildObjectVisuals()
  }
}

// ── Spawn points ─────────────────────────────────────────────

function placeSpawn(wx: number, wz: number) {
  if (selectedSpawn === 'player') {
    spawnPoints.player = { x: wx, z: wz }
    updateSpawnMarkerPos(spawnMarkers[0], spawnPoints.player)
    // Auto-mirror enemy spawn
    if (mirrorMode !== 'none') {
      const mp = getMirrorPoints(wx, wz)
      if (mp.length > 1) {
        spawnPoints.enemy = { x: mp[1][0], z: mp[1][1] }
        updateSpawnMarkerPos(spawnMarkers[1], spawnPoints.enemy)
      }
    }
  } else {
    spawnPoints.enemy = { x: wx, z: wz }
    updateSpawnMarkerPos(spawnMarkers[1], spawnPoints.enemy)
    // Auto-mirror player spawn
    if (mirrorMode !== 'none') {
      const mp = getMirrorPoints(wx, wz)
      if (mp.length > 1) {
        spawnPoints.player = { x: mp[1][0], z: mp[1][1] }
        updateSpawnMarkerPos(spawnMarkers[0], spawnPoints.player)
      }
    }
  }
}

// ── Save / Load ──────────────────────────────────────────────

async function onSave() {
  const name = elMapName.value.trim()
  if (!name) { alert('Enter a map name'); return }
  const data = serializeCurrentMap(name, placedObjects, spawnPoints)
  await saveMap(name, data)
  refreshMapList()
  console.log(`Map "${name}" saved`)
}

async function onLoad(name?: string) {
  const mapName = name || prompt('Map name to load:')
  if (!mapName) return

  try {
    const data = await fetchMap(mapName)
    const { objects, spawnPoints: sp } = loadMapIntoTerrain(data)

    placedObjects = objects
    spawnPoints = sp
    elMapName.value = data.metadata?.name || mapName

    rebuildTerrain()
    updateSpawnMarkerPos(spawnMarkers[0], spawnPoints.player)
    updateSpawnMarkerPos(spawnMarkers[1], spawnPoints.enemy)

    // Re-place object visuals
    for (const obj of placedObjects) {
      const pool = getPool(obj.poolId)
      if (pool) {
        const y = getTerrainHeight(obj.x, obj.z) + (obj.type === 'resource' ? 0.8 : 0)
        pool.add(Math.random() * 10000 | 0, obj.x, y, obj.z, obj.rotation)
      }
    }
    console.log(`Map "${mapName}" loaded (${objects.length} objects)`)
  } catch (e) {
    console.error('Failed to load map:', e)
  }
}

async function onDelete() {
  const name = elMapName.value.trim()
  if (!name) return
  if (!confirm(`Delete map "${name}"?`)) return
  await deleteMap(name)
  refreshMapList()
}

async function refreshMapList() {
  try {
    const maps = await fetchMapList()
    if (maps.length === 0) {
      elMapList.innerHTML = '<div style="color:#666">No saved maps</div>'
      return
    }
    elMapList.innerHTML = maps.map(m =>
      `<div style="padding:3px 0;cursor:pointer;border-bottom:1px solid #222" class="map-item" data-name="${m.name}">
        <span style="color:#aaf">${m.name}</span>
        <span style="color:#666;font-size:10px;margin-left:6px">${new Date(m.modified).toLocaleDateString()}</span>
      </div>`
    ).join('')
    // Click to load
    for (const el of elMapList.querySelectorAll('.map-item')) {
      el.addEventListener('click', () => onLoad((el as HTMLElement).dataset.name!))
    }
  } catch {
    elMapList.innerHTML = '<div style="color:#666">Failed to load</div>'
  }
}

// ── Wire UI ──────────────────────────────────────────────────

function wireUI() {
  // Tool buttons
  for (const btn of document.querySelectorAll<HTMLElement>('[data-tool]')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      const tool = btn.dataset.tool!
      currentTool = tool as any
      brushSettings.tool = (['paint', 'raise', 'lower', 'smooth', 'flatten'].includes(tool) ? tool : 'paint') as BrushTool
      elStatusTool.textContent = `Tool: ${tool.charAt(0).toUpperCase() + tool.slice(1)}`

      // Show/hide panels
      const isBrush = !['objects', 'spawns', 'delete'].includes(tool)
      document.getElementById('panel-paint')!.style.display = tool === 'paint' ? '' : 'none'
      document.getElementById('panel-brush')!.style.display = isBrush ? '' : 'none'
      document.getElementById('panel-objects')!.style.display = tool === 'objects' ? '' : 'none'
      document.getElementById('panel-spawns')!.style.display = tool === 'spawns' ? '' : 'none'
      document.getElementById('panel-delete')!.style.display = tool === 'delete' ? '' : 'none'
    })
  }

  // Mirror buttons
  for (const btn of document.querySelectorAll<HTMLElement>('[data-mirror]')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-mirror]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      mirrorMode = btn.dataset.mirror as MirrorMode
    })
  }
  document.getElementById('btn-mirror-now')!.addEventListener('click', () => {
    if (mirrorMode === 'none') { alert('Select a symmetry mode first'); return }
    mirrorTerrainNow()
  })

  // Auto-texture button
  document.getElementById('btn-auto-texture')!.addEventListener('click', autoTextureFromGeometry)
  document.getElementById('btn-scatter')!.addEventListener('click', scatterNature)

  // Paint type buttons: click = select, double-click = replace texture
  for (const btn of document.querySelectorAll<HTMLElement>('[data-paint]')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-paint]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      brushSettings.terrainType = parseInt(btn.dataset.paint!)
    })
    // Double-click opens texture library for slots that have textures
    if (btn.dataset.tex) {
      btn.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        const texFile = btn.dataset.tex!
        const slot = texFile.replace('.jpg', '').replace('.png', '')
        openTextureLibrary(slot, btn)
      })
    }
  }

  // Object buttons
  for (const btn of document.querySelectorAll<HTMLElement>('[data-obj]')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-obj]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      selectedObjPool = parseInt(btn.dataset.obj!)
    })
  }

  // Spawn buttons
  for (const btn of document.querySelectorAll<HTMLElement>('[data-spawn]')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-spawn]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      selectedSpawn = btn.dataset.spawn as 'player' | 'enemy'
    })
  }

  // Brush sliders
  const radiusSlider = document.getElementById('brush-radius') as HTMLInputElement
  const radiusVal = document.getElementById('brush-radius-val')!
  radiusSlider.addEventListener('input', () => {
    brushSettings.radius = parseInt(radiusSlider.value)
    radiusVal.textContent = radiusSlider.value
  })

  const strengthSlider = document.getElementById('brush-strength') as HTMLInputElement
  const strengthVal = document.getElementById('brush-strength-val')!
  strengthSlider.addEventListener('input', () => {
    brushSettings.strength = parseInt(strengthSlider.value) / 100
    strengthVal.textContent = brushSettings.strength.toFixed(1)
  })

  // Generate button
  document.getElementById('btn-generate')!.addEventListener('click', () => {
    const preset = (document.getElementById('preset-select') as HTMLSelectElement).value as PresetName
    applyPreset(preset)
    rebuildTerrain()
    updateSpawnMarkerPos(spawnMarkers[0], spawnPoints.player)
    updateSpawnMarkerPos(spawnMarkers[1], spawnPoints.enemy)
  })

  // Save / Load / Delete
  document.getElementById('btn-save')!.addEventListener('click', onSave)
  document.getElementById('btn-load')!.addEventListener('click', () => onLoad())
  document.getElementById('btn-delete')!.addEventListener('click', onDelete)

  // Canvas mouse events
  canvas.addEventListener('mousedown', onMouseDown)
  canvas.addEventListener('mousemove', onMouseMove)
  canvas.addEventListener('mouseup', onMouseUp)
  canvas.addEventListener('contextmenu', e => e.preventDefault())

  // Keyboard: Delete key removes last placed object
  window.addEventListener('keydown', e => {
    if (e.key === 'Delete' && placedObjects.length > 0) {
      placedObjects.pop()
      console.log('Removed last object')
    }
  })
}

// ── Texture Library Dialog ───────────────────────────────────

async function openTextureLibrary(slot: string, btnEl: HTMLElement) {
  // Create modal overlay
  const overlay = document.createElement('div')
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '2000',
    background: 'rgba(0,0,0,0.8)', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
  })

  const dialog = document.createElement('div')
  Object.assign(dialog.style, {
    background: '#1a1a2e', border: '1px solid #444', borderRadius: '10px',
    padding: '20px', width: '420px', maxHeight: '80vh', overflowY: 'auto',
  })

  dialog.innerHTML = `
    <h2 style="color:#8af;font-size:16px;margin-bottom:4px">Replace: ${slot}</h2>
    <p style="color:#666;font-size:12px;margin-bottom:16px">Choose a texture or upload a new one</p>
    <div id="tex-lib-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">
      <div style="color:#666;font-size:12px;padding:20px;text-align:center">Loading...</div>
    </div>
    <div style="display:flex;gap:8px">
      <button id="tex-upload-btn" style="flex:1;padding:8px;border:1px dashed #4a6a9a;border-radius:6px;background:#1a2a3a;color:#8af;cursor:pointer;font-size:13px">Upload New Texture</button>
      <button id="tex-cancel-btn" style="padding:8px 16px;border:1px solid #555;border-radius:6px;background:#2a2a3a;color:#ddd;cursor:pointer;font-size:13px">Cancel</button>
    </div>
    <input type="file" id="tex-lib-file" accept="image/jpeg,image/png,image/webp" style="display:none">
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  // Close on cancel or overlay click
  const close = () => overlay.remove()
  dialog.querySelector('#tex-cancel-btn')!.addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })

  // Fetch available textures from server + built-in defaults
  const grid = dialog.querySelector('#tex-lib-grid')!
  const builtIn = ['grass.jpg', 'dirt.jpg', 'rock.jpg', 'cliff.jpg', 'stone.jpg', 'leaf.jpg']
  let serverTextures: string[] = []
  try {
    const res = await fetch('/api/textures')
    const json = await res.json()
    serverTextures = json.data || []
  } catch { /* ignore */ }

  // Merge: server textures override built-in by name
  const all = new Set([...builtIn, ...serverTextures])

  grid.innerHTML = ''
  for (const file of all) {
    const isCustom = serverTextures.includes(file)
    const url = `/textures/${file}`
    const item = document.createElement('div')
    Object.assign(item.style, {
      cursor: 'pointer', borderRadius: '6px', border: '2px solid #333',
      overflow: 'hidden', background: '#111',
    })
    item.innerHTML = `
      <img src="${url}" style="width:100%;height:60px;object-fit:cover;display:block">
      <div style="font-size:10px;padding:3px 4px;color:${isCustom ? '#8f8' : '#aaa'};text-align:center">${file}${isCustom ? ' ★' : ''}</div>
    `
    item.addEventListener('mouseenter', () => item.style.borderColor = '#4a8a4a')
    item.addEventListener('mouseleave', () => item.style.borderColor = '#333')
    item.addEventListener('click', () => {
      // Apply this texture to the slot
      replaceTerrainTexture(slot, url)
      // Update the button thumbnail
      const img = btnEl.querySelector('img')
      if (img) img.src = url + '?t=' + Date.now()
      close()
    })
    grid.appendChild(item)
  }

  // Upload button
  const fileInput = dialog.querySelector('#tex-lib-file') as HTMLInputElement
  dialog.querySelector('#tex-upload-btn')!.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (!file) return

    // Read as base64 and upload to server persistent volume
    const reader = new FileReader()
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1]
      const name = file.name.replace(/[^a-zA-Z0-9._-]/g, '')
      try {
        await fetch(`/api/textures/${name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: base64 }),
        })
        // Apply immediately
        const url = `/textures/${name}?t=${Date.now()}`
        replaceTerrainTexture(slot, url)
        const img = btnEl.querySelector('img')
        if (img) img.src = url
        close()
      } catch (e) {
        console.error('Upload failed:', e)
      }
    }
    reader.readAsDataURL(file)
  })
}

// ── Start ────────────────────────────────────────────────────
init().catch(console.error)
