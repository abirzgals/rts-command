import { defineQuery, removeEntity, hasComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Dead, DeathTimer, Position, Faction, MeshRef, IsBuilding, SupplyProvider,
  SupplyCost, ResourceNode, Producer, UnitTypeC, PathFollower, WorkerC,
  MoveTarget, AttackTarget, Velocity, Wreckage, CollisionRadius,
} from '../components'
import { addComponent } from 'bitecs'
import { getPool } from '../../render/meshPools'
import { getAnimManager } from '../../render/animatedMeshManager'
import { gameState } from '../../game/state'
import { spatialHash } from '../../globals'
import { removeFromQueues } from '../commandQueue'
import { releaseAllNodes } from './resourceSystem'
import { onEnemyBuildingDeath } from '../../render/fogOfWar'
import { getPlayerFaction } from '../../game/factions'
import { unblockCells } from '../../pathfinding/navGrid'
import { BUILDING_DEFS, UT_TANK, UT_JEEP, UT_ROCKET } from '../../game/config'
import { removePath } from '../../pathfinding/pathStore'
import { spawnTankDeathExplosion, spawnFallingPieces } from '../../render/effects'
import { scene } from '../../render/engine'

const deadQuery = defineQuery([Dead])
const DEATH_ANIM_DURATION = 2.0 // seconds to play death animation

export function deathSystem(world: IWorld, dt: number) {
  const dead = deadQuery(world)

  for (const eid of dead) {
    // ── Phase 1: First frame of death — start animation, clean up gameplay state ──
    if (!hasComponent(world, DeathTimer, eid)) {
      addComponent(world, DeathTimer, eid)

      // Stop all movement/combat
      if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
      if (hasComponent(world, AttackTarget, eid)) removeComponent(world, AttackTarget, eid)
      if (hasComponent(world, PathFollower, eid)) removePath(PathFollower.pathId[eid])
      if (hasComponent(world, Velocity, eid)) { Velocity.x[eid] = 0; Velocity.z[eid] = 0 }

      // Start death animation (animated units)
      const poolId = hasComponent(world, MeshRef, eid) ? MeshRef.poolId[eid] : -1
      const animMgr = getAnimManager(poolId)
      let hasDeath = false
      if (animMgr && animMgr.has(eid)) {
        hasDeath = animMgr.playAnimation(eid, 'Death')
      }
      DeathTimer.remaining[eid] = hasDeath ? DEATH_ANIM_DURATION : 0.3

      // Supply update
      if (hasComponent(world, SupplyCost, eid)) {
        const faction = hasComponent(world, Faction, eid) ? Faction.id[eid] : 0
        gameState.getResources(faction).supplyCurrent = Math.max(0,
          gameState.getResources(faction).supplyCurrent - SupplyCost.amount[eid])
      }
      if (hasComponent(world, SupplyProvider, eid)) {
        const faction = hasComponent(world, Faction, eid) ? Faction.id[eid] : 0
        gameState.getResources(faction).supplyMax = Math.max(0,
          gameState.getResources(faction).supplyMax - SupplyProvider.amount[eid])
      }

      // Clean up production/path/workers
      if (hasComponent(world, Producer, eid)) gameState.removeQueue(eid)
      if (hasComponent(world, IsBuilding, eid)) {
        const bdef = BUILDING_DEFS[UnitTypeC.id[eid]]
        if (bdef) unblockCells(Position.x[eid], Position.z[eid], bdef.radius)
      }
      if (hasComponent(world, WorkerC, eid)) releaseAllNodes(eid)

      // Vehicle death explosion → wreckage (tanks, jeeps, rocket tanks)
      if (hasComponent(world, UnitTypeC, eid)) {
        const utId = UnitTypeC.id[eid]
        if (utId === UT_TANK || utId === UT_JEEP || utId === UT_ROCKET) {
          const vx = Position.x[eid], vy = Position.y[eid], vz = Position.z[eid]
          spawnTankDeathExplosion(vx, vy, vz)
          // Break model apart into falling pieces
          const poolId2 = MeshRef.poolId[eid]
          const animMgr2 = getAnimManager(poolId2)
          if (animMgr2) {
            const pieces = animMgr2.breakApart(eid, scene)
            if (pieces.length > 0) {
              spawnFallingPieces(pieces, vy)
            }
          }
          DeathTimer.remaining[eid] = 0.1 // entity removed quickly, pieces handle visuals
        }
      }

      // Fog snapshot for enemy buildings
      if (hasComponent(world, IsBuilding, eid) && hasComponent(world, Faction, eid) &&
          Faction.id[eid] !== getPlayerFaction()) {
        onEnemyBuildingDeath(eid, world)
      }

      // Remove from spatial hash
      spatialHash.remove(eid)
      removeFromQueues(eid)
      continue
    }

    // ── Phase 2: Count down timer ──
    DeathTimer.remaining[eid] -= dt
    if (DeathTimer.remaining[eid] > 0) continue

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

    removeEntity(world, eid)
  }
}
