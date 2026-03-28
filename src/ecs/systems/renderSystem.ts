import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Rotation, MeshRef, Dead, AttackTarget, Health } from '../components'
import { getPool, getAllPools } from '../../render/meshPools'
import { getAnimManager } from '../../render/animatedMeshManager'

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

  // Mark all instanced pool matrices as needing update
  for (const [, pool] of getAllPools()) {
    if (pool.activeCount > 0) {
      pool.mesh.instanceMatrix.needsUpdate = true
    }
  }
}
