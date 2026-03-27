import * as THREE from 'three'
import { scene } from './engine'
import {
  createWorkerGeometry,
  createMarineGeometry,
  createTankGeometry,
  createCommandCenterGeometry,
  createSupplyDepotGeometry,
  createBarracksGeometry,
  createFactoryGeometry,
  createMineralGeometry,
  createGasGeyserGeometry,
  createProjectileGeometry,
  createSelectionRingGeometry,
  createRockGeometry,
  createTreeGeometry,
  createBoulderGeometry,
  createCliffRockGeometry,
} from './models'
import { loadModels } from './modelLoader'
import { AnimatedMeshManager, registerAnimManager } from './animatedMeshManager'

/**
 * MeshPool manages an InstancedMesh for a single visual type.
 * Supports dynamic add/remove with O(1) operations via swap-remove.
 */
export class MeshPool {
  mesh: THREE.InstancedMesh
  private maxCount: number
  activeCount = 0
  private eidToIndex = new Map<number, number>()
  private indexToEid: number[]

  private _mat4 = new THREE.Matrix4()
  private _pos = new THREE.Vector3()
  private _quat = new THREE.Quaternion()
  private _scale = new THREE.Vector3(1, 1, 1)
  private _color = new THREE.Color()

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    maxCount: number,
    shadows = false,
  ) {
    this.maxCount = maxCount
    this.indexToEid = new Array(maxCount).fill(-1)

    this.mesh = new THREE.InstancedMesh(geometry, material, maxCount)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    if (shadows) {
      this.mesh.castShadow = true
      this.mesh.receiveShadow = true
    }

    scene.add(this.mesh)
  }

  add(eid: number, x: number, y: number, z: number, rotY: number, color?: THREE.Color): number {
    if (this.activeCount >= this.maxCount) {
      console.warn('MeshPool full!')
      return -1
    }

    const idx = this.activeCount
    this.activeCount++
    this.mesh.count = this.activeCount

    this.eidToIndex.set(eid, idx)
    this.indexToEid[idx] = eid

    this._quat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotY)
    this._mat4.compose(this._pos.set(x, y, z), this._quat, this._scale)
    this.mesh.setMatrixAt(idx, this._mat4)

    if (color) {
      this.mesh.setColorAt(idx, color)
    }

    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true

    return idx
  }

  remove(eid: number) {
    const idx = this.eidToIndex.get(eid)
    if (idx === undefined) return

    const lastIdx = this.activeCount - 1

    if (idx !== lastIdx) {
      const lastEid = this.indexToEid[lastIdx]
      this.mesh.getMatrixAt(lastIdx, this._mat4)
      this.mesh.setMatrixAt(idx, this._mat4)

      if (this.mesh.instanceColor) {
        this.mesh.getColorAt(lastIdx, this._color)
        this.mesh.setColorAt(idx, this._color)
      }

      this.eidToIndex.set(lastEid, idx)
      this.indexToEid[idx] = lastEid
    }

    this.eidToIndex.delete(eid)
    this.indexToEid[lastIdx] = -1
    this.activeCount--
    this.mesh.count = this.activeCount

    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  updateTransform(eid: number, x: number, y: number, z: number, rotY: number) {
    const idx = this.eidToIndex.get(eid)
    if (idx === undefined) return

    this._quat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotY)
    this._mat4.compose(this._pos.set(x, y, z), this._quat, this._scale)
    this.mesh.setMatrixAt(idx, this._mat4)
    this.mesh.instanceMatrix.needsUpdate = true
  }

  updateColor(eid: number, color: THREE.Color) {
    const idx = this.eidToIndex.get(eid)
    if (idx === undefined) return
    this.mesh.setColorAt(idx, color)
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  getIndex(eid: number): number {
    return this.eidToIndex.get(eid) ?? -1
  }

  dispose() {
    scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.dispose()
  }
}

// ── Pool registry ────────────────────────────────────────────
const pools = new Map<number, MeshPool>()

export function registerPool(id: number, pool: MeshPool) {
  pools.set(id, pool)
}

export function getPool(id: number): MeshPool | undefined {
  return pools.get(id)
}

export function getAllPools(): Map<number, MeshPool> {
  return pools
}

// ── Selection ring mesh (managed directly, not via pool) ─────
export let selectionRingMesh: THREE.InstancedMesh
const MAX_SELECTION_RINGS = 500
const _ringMat4 = new THREE.Matrix4()
const _ringPos = new THREE.Vector3()
const _ringQuat = new THREE.Quaternion()
const _ringScale = new THREE.Vector3(1, 1, 1)

export function createSelectionRingMesh() {
  const geo = createSelectionRingGeometry(1.0)
  const mat = new THREE.MeshBasicMaterial({
    color: 0x00ff44,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,  // don't write to depth buffer (ring is flat decal)
    depthTest: true,    // DO read depth buffer so units occlude the far side
  })
  selectionRingMesh = new THREE.InstancedMesh(geo, mat, MAX_SELECTION_RINGS)
  selectionRingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  selectionRingMesh.count = 0
  selectionRingMesh.frustumCulled = false
  selectionRingMesh.renderOrder = -1 // render BEFORE units so depth test works
  scene.add(selectionRingMesh)
}

export function updateSelectionRings(positions: { x: number; y: number; z: number; radius: number }[]) {
  const count = Math.min(positions.length, MAX_SELECTION_RINGS)
  selectionRingMesh.count = count

  for (let i = 0; i < count; i++) {
    const { x, y, z, radius } = positions[i]
    const scale = radius * 1.5
    _ringScale.set(scale, scale, scale)
    // Place ring at the entity's terrain Y + small offset to avoid z-fighting
    _ringMat4.compose(_ringPos.set(x, y + 0.05, z), _ringQuat, _ringScale)
    selectionRingMesh.setMatrixAt(i, _ringMat4)
  }

  if (count > 0) {
    selectionRingMesh.instanceMatrix.needsUpdate = true
  }
}

// ── Factory: create all mesh pools ───────────────────────────
export async function createMeshPools() {
  const MAX_UNITS = 4000
  const MAX_BUILDINGS = 500
  const MAX_RESOURCES = 200
  const MAX_PROJECTILES = 1000
  const MAX_OBSTACLES = 600
  const SHADOWS = true

  // ── Animated unit managers (IDs 0-2) ─────────
  const workerMgr = new AnimatedMeshManager('/models/worker.glb', 1.0)
  const marineMgr = new AnimatedMeshManager('/models/marine.glb', 1.0)
  const tankMgr = new AnimatedMeshManager('/models/tank-v2.glb', 0.3, Math.PI / 2)

  await Promise.all([workerMgr.load(), marineMgr.load(), tankMgr.load()])

  registerAnimManager(0, workerMgr)
  registerAnimManager(1, marineMgr)
  registerAnimManager(2, tankMgr)

  // Load static .glb models in parallel for buildings/resources/obstacles
  const models = await loadModels([
    // Buildings
    { name: 'cc',        url: '/models/command-center.glb', scale: 5.0 },
    { name: 'supply',    url: '/models/supply-depot.glb',   scale: 4.0 },
    { name: 'barracks',  url: '/models/barracks.glb',       scale: 4.5 },
    { name: 'factory',   url: '/models/factory.glb',        scale: 4.5 },
    // Resources
    { name: 'gold',      url: '/models/gold.glb',     scale: 1.5 },
    // Obstacles
    { name: 'rock1',     url: '/models/rock1.glb',    scale: 2.0 },
    { name: 'rock2',     url: '/models/rock2.glb',    scale: 2.0 },
    { name: 'tree1',     url: '/models/tree1.glb',    scale: 2.5 },
    { name: 'boulder',   url: '/models/boulder.glb',  scale: 2.5 },
  ])

  // Helper: use loaded model or fall back to procedural
  const geo = (name: string, fallback: () => THREE.BufferGeometry) => {
    const m = models.get(name)
    return m ? m.geometry : fallback()
  }
  const mat = (name: string, fallback: THREE.Material) => {
    const m = models.get(name)
    return m ? m.material : fallback
  }

  const buildFallback = () => new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 10, flatShading: true })

  // ── Building pools (IDs 10-19) ───────────────
  registerPool(10, new MeshPool(geo('cc', createCommandCenterGeometry), mat('cc', buildFallback()), MAX_BUILDINGS, SHADOWS))
  registerPool(11, new MeshPool(geo('supply', createSupplyDepotGeometry), mat('supply', buildFallback()), MAX_BUILDINGS, SHADOWS))
  registerPool(12, new MeshPool(geo('barracks', createBarracksGeometry), mat('barracks', buildFallback()), MAX_BUILDINGS, SHADOWS))
  registerPool(13, new MeshPool(geo('factory', createFactoryGeometry), mat('factory', buildFallback()), MAX_BUILDINGS, SHADOWS))

  // ── Resource pools (IDs 20-21) ───────────────
  const mineralMat = new THREE.MeshPhongMaterial({
    color: 0x4fc3f7, emissive: 0x1a5070, emissiveIntensity: 0.4,
    shininess: 80, flatShading: true,
  })
  registerPool(20, new MeshPool(geo('gold', createMineralGeometry), mat('gold', mineralMat), MAX_RESOURCES, SHADOWS))

  const gasMat = new THREE.MeshPhongMaterial({
    color: 0x66bb6a, emissive: 0x1a4a1a, emissiveIntensity: 0.5,
    shininess: 30, flatShading: true,
  })
  registerPool(21, new MeshPool(createGasGeyserGeometry(), gasMat, MAX_RESOURCES, SHADOWS))

  // ── Obstacle pools (IDs 22-25) ───────────────
  const rockMat = new THREE.MeshPhongMaterial({ color: 0x888580, shininess: 10, flatShading: true })
  registerPool(22, new MeshPool(geo('rock1', createRockGeometry), mat('rock1', rockMat), MAX_OBSTACLES, SHADOWS))
  registerPool(23, new MeshPool(geo('tree1', createTreeGeometry), mat('tree1',
    new THREE.MeshPhongMaterial({ color: 0x446633, shininess: 5, flatShading: true })), MAX_OBSTACLES, SHADOWS))
  registerPool(24, new MeshPool(geo('boulder', createBoulderGeometry), mat('boulder', rockMat), MAX_OBSTACLES, SHADOWS))
  registerPool(25, new MeshPool(geo('rock2', createCliffRockGeometry), mat('rock2', rockMat), MAX_OBSTACLES, SHADOWS))

  // ── Projectiles (ID 30 = bullets, ID 31 = tank shells) ──
  registerPool(30, new MeshPool(
    createProjectileGeometry(),
    new THREE.MeshBasicMaterial({ color: 0xffee44, transparent: true, opacity: 0.9 }),
    MAX_PROJECTILES,
  ))

  // Tank shell — larger, red-orange
  const shellGeo = new THREE.CylinderGeometry(0.08, 0.15, 0.6, 6)
  shellGeo.rotateX(Math.PI / 2) // point forward
  registerPool(31, new MeshPool(
    shellGeo,
    new THREE.MeshBasicMaterial({ color: 0xff4400 }),
    200,
  ))

  // Enable instance colors on building pools
  for (const id of [10, 11, 12, 13]) {
    const pool = pools.get(id)!
    pool.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_BUILDINGS * 3),
      3,
    )
  }

  // Selection ring mesh
  createSelectionRingMesh()
}

// ── Faction colors ───────────────────────────────────────────
const PLAYER_COLOR = new THREE.Color(0x4499ff)
const ENEMY_COLOR = new THREE.Color(0xff4455)
const PLAYER_BUILDING_COLOR = new THREE.Color(0x3377dd)
const ENEMY_BUILDING_COLOR = new THREE.Color(0xdd3344)

export function getFactionColor(factionId: number, isBuilding: boolean): THREE.Color {
  if (isBuilding) {
    return factionId === 0 ? PLAYER_BUILDING_COLOR : ENEMY_BUILDING_COLOR
  }
  return factionId === 0 ? PLAYER_COLOR : ENEMY_COLOR
}
