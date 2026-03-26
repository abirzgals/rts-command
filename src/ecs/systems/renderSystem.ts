import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Rotation, MeshRef, Dead } from '../components'
import { getPool, getAllPools } from '../../render/meshPools'

const renderQuery = defineQuery([Position, MeshRef])

export function renderSystem(world: IWorld, _dt: number) {
  const entities = renderQuery(world)

  for (const eid of entities) {
    if (hasComponent(world, Dead, eid)) continue

    const pool = getPool(MeshRef.poolId[eid])
    if (!pool) continue

    const rotY = hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0
    pool.updateTransform(eid, Position.x[eid], Position.y[eid], Position.z[eid], rotY)
  }

  // Mark all pool matrices as needing update
  for (const [, pool] of getAllPools()) {
    if (pool.activeCount > 0) {
      pool.mesh.instanceMatrix.needsUpdate = true
    }
  }
}
