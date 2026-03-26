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
  const geo = createSelectionRingGeometry(1.0) // unit-size ring, will scale per entity
  const mat = new THREE.MeshBasicMaterial({
    color: 0x00ff44,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
  })
  selectionRingMesh = new THREE.InstancedMesh(geo, mat, MAX_SELECTION_RINGS)
  selectionRingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  selectionRingMesh.count = 0
  selectionRingMesh.frustumCulled = false
  selectionRingMesh.renderOrder = 1 // render on top of ground
  scene.add(selectionRingMesh)
}

export function updateSelectionRings(positions: { x: number; z: number; radius: number }[]) {
  const count = Math.min(positions.length, MAX_SELECTION_RINGS)
  selectionRingMesh.count = count

  for (let i = 0; i < count; i++) {
    const { x, z, radius } = positions[i]
    const scale = radius * 1.5
    _ringScale.set(scale, scale, scale)
    _ringMat4.compose(_ringPos.set(x, 0.08, z), _ringQuat, _ringScale)
    selectionRingMesh.setMatrixAt(i, _ringMat4)
  }

  if (count > 0) {
    selectionRingMesh.instanceMatrix.needsUpdate = true
  }
}

// ── Factory: create all mesh pools ───────────────────────────
export function createMeshPools() {
  const MAX_UNITS = 4000
  const MAX_BUILDINGS = 500
  const MAX_RESOURCES = 200
  const MAX_PROJECTILES = 1000

  // Phong material for nicer shading on detailed models
  const unitMat = () => new THREE.MeshPhongMaterial({
    color: 0xffffff,
    shininess: 20,
    flatShading: true,
  })

  const buildingMat = () => new THREE.MeshPhongMaterial({
    color: 0xffffff,
    shininess: 10,
    flatShading: true,
  })

  const SHADOWS = true

  // ── Unit pools (IDs 0-9) ─────────────────────
  registerPool(0, new MeshPool(createWorkerGeometry(), unitMat(), MAX_UNITS, SHADOWS))
  registerPool(1, new MeshPool(createMarineGeometry(), unitMat(), MAX_UNITS, SHADOWS))
  registerPool(2, new MeshPool(createTankGeometry(), unitMat(), MAX_UNITS, SHADOWS))

  // ── Building pools (IDs 10-19) ───────────────
  registerPool(10, new MeshPool(createCommandCenterGeometry(), buildingMat(), MAX_BUILDINGS, SHADOWS))
  registerPool(11, new MeshPool(createSupplyDepotGeometry(), buildingMat(), MAX_BUILDINGS, SHADOWS))
  registerPool(12, new MeshPool(createBarracksGeometry(), buildingMat(), MAX_BUILDINGS, SHADOWS))
  registerPool(13, new MeshPool(createFactoryGeometry(), buildingMat(), MAX_BUILDINGS, SHADOWS))

  // ── Resource pools (IDs 20-21) ───────────────
  const mineralMat = new THREE.MeshPhongMaterial({
    color: 0x4fc3f7, emissive: 0x1a5070, emissiveIntensity: 0.4,
    shininess: 80, flatShading: true,
  })
  registerPool(20, new MeshPool(createMineralGeometry(), mineralMat, MAX_RESOURCES, SHADOWS))

  const gasMat = new THREE.MeshPhongMaterial({
    color: 0x66bb6a, emissive: 0x1a4a1a, emissiveIntensity: 0.5,
    shininess: 30, flatShading: true,
  })
  registerPool(21, new MeshPool(createGasGeyserGeometry(), gasMat, MAX_RESOURCES, SHADOWS))

  // ── Obstacle pools (IDs 22-25) ───────────────
  const MAX_OBSTACLES = 600
  const obstacleMat = new THREE.MeshPhongMaterial({
    color: 0x888580, shininess: 10, flatShading: true,
  })
  registerPool(22, new MeshPool(createRockGeometry(), obstacleMat, MAX_OBSTACLES, SHADOWS))
  registerPool(23, new MeshPool(
    createTreeGeometry(),
    new THREE.MeshPhongMaterial({ color: 0x446633, shininess: 5, flatShading: true }),
    MAX_OBSTACLES, SHADOWS,
  ))
  registerPool(24, new MeshPool(createBoulderGeometry(), obstacleMat, MAX_OBSTACLES, SHADOWS))
  registerPool(25, new MeshPool(
    createCliffRockGeometry(),
    new THREE.MeshPhongMaterial({ color: 0x6a6560, shininess: 8, flatShading: true }),
    MAX_OBSTACLES, SHADOWS,
  ))

  // ── Projectiles (ID 30) ──────────────────────
  registerPool(30, new MeshPool(
    createProjectileGeometry(),
    new THREE.MeshBasicMaterial({ color: 0xffcc00 }),
    MAX_PROJECTILES,
  ))

  // Enable instance colors on pools that need per-faction colors
  for (const id of [0, 1, 2, 10, 11, 12, 13]) {
    const pool = pools.get(id)!
    const max = id < 10 ? MAX_UNITS : MAX_BUILDINGS
    pool.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(max * 3),
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
