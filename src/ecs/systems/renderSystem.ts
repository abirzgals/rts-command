import * as THREE from 'three'
import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Rotation, MeshRef, Dead, AttackTarget, Health, WorkerC, MoveTarget, PathFollower, Velocity, Faction } from '../components'
import { getPath } from '../../pathfinding/pathStore'
import { getPool, getAllPools } from '../../render/meshPools'
import { getAnimManager } from '../../render/animatedMeshManager'
import { isVisibleAt } from '../../render/fogOfWar'
import { getPlayerFaction } from '../../game/factions'

// ── Multiplayer interpolation (one-tick-behind) ─────────────
// Double-buffer: interpolate between tick N-1 and tick N.
// Visual is always one tick behind simulation, but perfectly smooth.
const SZ = 8000
const bufAX = new Float32Array(SZ) // tick N-1 positions
const bufAY = new Float32Array(SZ)
const bufAZ = new Float32Array(SZ)
const bufARot = new Float32Array(SZ)
const bufBX = new Float32Array(SZ) // tick N positions
const bufBY = new Float32Array(SZ)
const bufBZ = new Float32Array(SZ)
const bufBRot = new Float32Array(SZ)
let lerpAlpha = 1.0

/** Call BEFORE each simulation tick: shift bufB → bufA, snapshot current → bufB */
export function snapshotPositions(world: IWorld) {
  const entities = renderQuery(world)
  for (const eid of entities) {
    // Shift B → A
    bufAX[eid] = bufBX[eid]; bufAY[eid] = bufBY[eid]; bufAZ[eid] = bufBZ[eid]; bufARot[eid] = bufBRot[eid]
    // Current → B
    bufBX[eid] = Position.x[eid]; bufBY[eid] = Position.y[eid]; bufBZ[eid] = Position.z[eid]
    bufBRot[eid] = hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0
  }
}

/** Set interpolation alpha (0-1): 0 = tick N-1, 1 = tick N */
export function setLerpAlpha(alpha: number) { lerpAlpha = alpha }

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
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
    // Interpolate between tick N-1 (bufA) and tick N (bufB) for smooth MP rendering
    const x = lerpAlpha < 0.999 ? lerp(bufAX[eid], bufBX[eid], lerpAlpha) : Position.x[eid]
    const y = lerpAlpha < 0.999 ? lerp(bufAY[eid], bufBY[eid], lerpAlpha) : Position.y[eid]
    const z = lerpAlpha < 0.999 ? lerp(bufAZ[eid], bufBZ[eid], lerpAlpha) : Position.z[eid]
    const rotY = lerpAlpha < 0.999 ? lerpAngle(bufARot[eid], bufBRot[eid], lerpAlpha) : (hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0)

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
