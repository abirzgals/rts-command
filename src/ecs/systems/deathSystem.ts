import { defineQuery, removeEntity, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Dead, Position, Faction, MeshRef, IsBuilding, SupplyProvider,
  SupplyCost, ResourceNode, Producer, UnitTypeC, PathFollower,
} from '../components'
import { getPool } from '../../render/meshPools'
import { getAnimManager } from '../../render/animatedMeshManager'
import { gameState } from '../../game/state'
import { spatialHash } from '../../globals'
import { unblockCells } from '../../pathfinding/navGrid'
import { BUILDING_DEFS } from '../../game/config'
import { removePath } from '../../pathfinding/pathStore'

const deadQuery = defineQuery([Dead])

export function deathSystem(world: IWorld, _dt: number) {
  const dead = deadQuery(world)

  for (const eid of dead) {
    // Update supply
    if (hasComponent(world, SupplyCost, eid)) {
      const faction = hasComponent(world, Faction, eid) ? Faction.id[eid] : 0
      const res = gameState.getResources(faction)
      res.supplyCurrent = Math.max(0, res.supplyCurrent - SupplyCost.amount[eid])
    }

    if (hasComponent(world, SupplyProvider, eid)) {
      const faction = hasComponent(world, Faction, eid) ? Faction.id[eid] : 0
      const res = gameState.getResources(faction)
      res.supplyMax = Math.max(0, res.supplyMax - SupplyProvider.amount[eid])
    }

    // Clean up production queue
    if (hasComponent(world, Producer, eid)) {
      gameState.removeQueue(eid)
    }

    // Unblock nav grid for buildings
    if (hasComponent(world, IsBuilding, eid)) {
      const bdef = BUILDING_DEFS[UnitTypeC.id[eid]]
      if (bdef) unblockCells(Position.x[eid], Position.z[eid], bdef.radius)
    }

    // Clean up path
    if (hasComponent(world, PathFollower, eid)) {
      removePath(PathFollower.pathId[eid])
    }

    // Remove from mesh pool or animated manager
    if (hasComponent(world, MeshRef, eid)) {
      const poolId = MeshRef.poolId[eid]
      const animMgr = getAnimManager(poolId)
      if (animMgr) {
        animMgr.remove(eid)
      } else {
        const pool = getPool(poolId)
        if (pool) pool.remove(eid)
      }
    }

    // Remove from spatial hash
    spatialHash.remove(eid)

    // Remove entity
    removeEntity(world, eid)
  }
}
