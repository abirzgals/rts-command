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
import { removeFromQueues } from '../commandQueue'
import { onEnemyBuildingDeath } from '../../render/fogOfWar'
import { FACTION_PLAYER } from '../../game/config'
import { unblockCells } from '../../pathfinding/navGrid'
import { BUILDING_DEFS, UT_TANK } from '../../game/config'
import { removePath } from '../../pathfinding/pathStore'
import { spawnTankDeathExplosion } from '../../render/effects'

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

    // Tank death: spawn explosion + debris effect
    if (hasComponent(world, UnitTypeC, eid) && UnitTypeC.id[eid] === UT_TANK) {
      spawnTankDeathExplosion(
        Position.x[eid],
        Position.y[eid],
        Position.z[eid],
      )
    }

    // Fog of war: snapshot enemy buildings dying in fog
    if (hasComponent(world, IsBuilding, eid) && hasComponent(world, Faction, eid) &&
        Faction.id[eid] !== FACTION_PLAYER) {
      onEnemyBuildingDeath(eid, world)
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

    // Remove from spatial hash and command queue
    spatialHash.remove(eid)
    removeFromQueues(eid)

    // Remove entity
    removeEntity(world, eid)
  }
}
