import * as THREE from 'three'
import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Rotation, MeshRef, Dead, AttackTarget, Health, WorkerC, MoveTarget, PathFollower, Velocity, Faction } from '../components'
import { getPath } from '../../pathfinding/pathStore'
import { getPool, getAllPools } from '../../render/meshPools'
import { getAnimManager } from '../../render/animatedMeshManager'
import { isVisibleAt } from '../../render/fogOfWar'
import { getPlayerFaction } from '../../game/factions'

// ── Multiplayer interpolation (one-tick-behind + velocity) ───
// Stores two past snapshots and derived velocities for smooth rendering.
const SZ = 8000
// Tick N-1 positions (start of interpolation)
const fromX = new Float32Array(SZ)
const fromY = new Float32Array(SZ)
const fromZ = new Float32Array(SZ)
const fromRot = new Float32Array(SZ)
// Tick N positions (end of interpolation)
const toX = new Float32Array(SZ)
const toY = new Float32Array(SZ)
const toZ = new Float32Array(SZ)
const toRot = new Float32Array(SZ)
let lerpAlpha = 1.0
let interpActive = false

/** Call BEFORE each simulation tick: shift current→from, post-tick positions become→to */
export function snapshotBeforeTick(world: IWorld) {
  const entities = renderQuery(world)
  for (const eid of entities) {
    fromX[eid] = toX[eid]; fromY[eid] = toY[eid]; fromZ[eid] = toZ[eid]; fromRot[eid] = toRot[eid]
  }
  interpActive = true
}

/** Call AFTER simulation tick: capture new positions as interpolation target */
export function snapshotAfterTick(world: IWorld) {
  const entities = renderQuery(world)
  for (const eid of entities) {
    toX[eid] = Position.x[eid]
    toY[eid] = Position.y[eid]
    toZ[eid] = Position.z[eid]
    toRot[eid] = hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0
  }
}

/** Initialize both buffers (call on first tick) */
export function initInterpolation(world: IWorld) {
  const entities = renderQuery(world)
  for (const eid of entities) {
    const x = Position.x[eid], y = Position.y[eid], z = Position.z[eid]
    const r = hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0
    fromX[eid] = x; fromY[eid] = y; fromZ[eid] = z; fromRot[eid] = r
    toX[eid] = x; toY[eid] = y; toZ[eid] = z; toRot[eid] = r
  }
}

export function setLerpAlpha(alpha: number) { lerpAlpha = alpha }

// Interpolated position cache — updated each frame by renderSystem, readable by hpBars etc.
const vizX = new Float32Array(SZ)
const vizY = new Float32Array(SZ)
const vizZ = new Float32Array(SZ)
/** Get the interpolated visual position for an entity (valid after renderSystem runs) */
export function getVizPos(eid: number): { x: number; y: number; z: number } {
  return { x: vizX[eid], y: vizY[eid], z: vizZ[eid] }
}
export function isInterpolating(): boolean { return interpActive && lerpAlpha < 0.999 }

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

/** Smooth interpolation with ease for natural deceleration */
function smoothT(t: number): number {
  // Smoothstep — no abrupt starts or stops
  return t * t * (3 - 2 * t)
}
// Carry visual: small crystal for workers carrying resources
const carryGeo = new THREE.OctahedronGeometry(0.15, 0)
const carryMatMineral = new THREE.MeshBasicMaterial({ color: 0x44ccff, transparent: true, opacity: 0.9 })
const carryMatGas = new THREE.MeshBasicMaterial({ color: 0x44ff66, transparent: true, opacity: 0.9 })
const carryMeshes = new Map<number, THREE.Mesh>()

const renderQuery = defineQuery([Position, MeshRef])

export function renderSystem(world: IWorld, dt: number) {
  const entities = renderQuery(world)

  for (const eid of entities) {
    if (hasComponent(world, Dead, eid)) continue

    const poolId = MeshRef.poolId[eid]
    // Interpolate between from (tick N-1) and to (tick N) with smoothstep
    let x: number, y: number, z: number, rotY: number
    if (interpActive && lerpAlpha < 0.999) {
      x = lerp(fromX[eid], toX[eid], lerpAlpha)
      y = lerp(fromY[eid], toY[eid], lerpAlpha)
      z = lerp(fromZ[eid], toZ[eid], lerpAlpha)
      rotY = lerpAngle(fromRot[eid], toRot[eid], lerpAlpha)
    } else {
      x = Position.x[eid]; y = Position.y[eid]; z = Position.z[eid]
      rotY = hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0
    }
    // Cache for other systems (hpBars, etc.)
    vizX[eid] = x; vizY[eid] = y; vizZ[eid] = z

    // Try animated manager first
    const animMgr = getAnimManager(poolId)
    if (animMgr && animMgr.has(eid)) {
      animMgr.updateTransform(eid, x, y, z, rotY)

      // Turret aiming
      if (animMgr.hasTurret(eid)) {
        if (hasComponent(world, AttackTarget, eid)) {
          // Priority 1: aim at attack target
          const targetEid = AttackTarget.eid[eid]
          if (hasComponent(world, Position, targetEid) && !hasComponent(world, Dead, targetEid)) {
            animMgr.updateTurretAim(eid, Position.x[targetEid], Position.y[targetEid], Position.z[targetEid], dt)
          }
        } else if (hasComponent(world, MoveTarget, eid)) {
          // Priority 2: aim at move destination
          const my = y + 1.0
          animMgr.updateTurretAim(eid, MoveTarget.x[eid], my, MoveTarget.z[eid], dt * 2) // faster rotation
        } else if (hasComponent(world, PathFollower, eid)) {
          // Priority 3: aim at next waypoint
          const path = getPath(PathFollower.pathId[eid])
          const wpIdx = PathFollower.waypointIndex[eid]
          if (path && wpIdx < path.length) {
            const wp = path[wpIdx]
            animMgr.updateTurretAim(eid, wp.x, y + 1.0, wp.z, dt * 2)
          }
        }
      }

      continue
    }

    // Fallback to instanced mesh pool
    const pool = getPool(poolId)
    if (!pool) continue
    pool.updateTransform(eid, x, y, z, rotY)
  }

  // Worker carry visual: show/hide crystal when carrying resources
  for (const eid of entities) {
    if (hasComponent(world, Dead, eid)) continue
    if (!hasComponent(world, WorkerC, eid)) continue

    const carrying = WorkerC.carryAmount[eid] > 0

    if (carrying && !carryMeshes.has(eid)) {
      // Create carry crystal — blue for minerals, green for gas
      const mat = WorkerC.carryType[eid] === 1 ? carryMatGas : carryMatMineral
      const crystal = new THREE.Mesh(carryGeo, mat)
      crystal.renderOrder = 10
      const mgr = getAnimManager(MeshRef.poolId[eid])
      if (mgr && mgr.has(eid)) {
        mgr.getUnitMesh(eid)?.parent?.add(crystal)
      }
      carryMeshes.set(eid, crystal)
    } else if (!carrying && carryMeshes.has(eid)) {
      const crystal = carryMeshes.get(eid)!
      crystal.parent?.remove(crystal)
      carryMeshes.delete(eid)
    }

    // Update position: in front of worker, at chest height
    if (carryMeshes.has(eid)) {
      const crystal = carryMeshes.get(eid)!
      // Hide crystal if enemy worker is in fog of war
      const isEnemy = hasComponent(world, Faction, eid) && Faction.id[eid] !== getPlayerFaction()
      crystal.visible = !isEnemy || isVisibleAt(Position.x[eid], Position.z[eid])

      const rot = hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0
      crystal.position.set(
        Position.x[eid] + Math.sin(rot) * 0.4,
        Position.y[eid] + 0.8,
        Position.z[eid] + Math.cos(rot) * 0.4,
      )
      crystal.rotation.y += 0.05 // spin
    }
  }

  // Mark all instanced pool matrices as needing update
  for (const [, pool] of getAllPools()) {
    if (pool.activeCount > 0) {
      pool.mesh.instanceMatrix.needsUpdate = true
    }
  }
}
