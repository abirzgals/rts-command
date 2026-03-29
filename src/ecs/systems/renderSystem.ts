import * as THREE from 'three'
import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Rotation, MeshRef, Dead, AttackTarget, Health, WorkerC } from '../components'
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

      // Turret aiming: rotate turret/barrel toward attack target
      if (animMgr.hasTurret(eid) && hasComponent(world, AttackTarget, eid)) {
        const targetEid = AttackTarget.eid[eid]
        if (hasComponent(world, Position, targetEid) && !hasComponent(world, Dead, targetEid)) {
          const tx = Position.x[targetEid]
          const ty = Position.y[targetEid]
          const tz = Position.z[targetEid]
          animMgr.updateTurretAim(eid, tx, ty, tz, dt)
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
