import * as THREE from 'three'
import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Rotation, MeshRef, Dead, AttackTarget, Health, WorkerC, MoveTarget, PathFollower, Velocity } from '../components'
import { getPath } from '../../pathfinding/pathStore'
import { getPool, getAllPools } from '../../render/meshPools'
import { getAnimManager } from '../../render/animatedMeshManager'
import { scene } from '../../render/engine'

// Carry visual: small crystal mesh shown when worker is carrying resources
const carryGeo = new THREE.OctahedronGeometry(0.15, 0)
const carryMatMineral = new THREE.MeshBasicMaterial({ color: 0x44ccff, transparent: true, opacity: 0.9 })
const carryMeshes = new Map<number, THREE.Mesh>() // eid → carry mesh

const renderQuery = defineQuery([Position, MeshRef])

export function renderSystem(world: IWorld, dt: number) {
  const entities = renderQuery(world)

  for (const eid of entities) {
    if (hasComponent(world, Dead, eid)) continue

    const poolId = MeshRef.poolId[eid]
    const rotY = hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0
    const x = Position.x[eid]
    const y = Position.y[eid]
    const z = Position.z[eid]

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
      // Create carry crystal
      const crystal = new THREE.Mesh(carryGeo, carryMatMineral)
      crystal.renderOrder = 10
      scene.add(crystal)
      carryMeshes.set(eid, crystal)
    } else if (!carrying && carryMeshes.has(eid)) {
      // Remove carry crystal
      const crystal = carryMeshes.get(eid)!
      scene.remove(crystal)
      carryMeshes.delete(eid)
    }

    // Update position: in front of worker, at chest height
    if (carryMeshes.has(eid)) {
      const crystal = carryMeshes.get(eid)!
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
