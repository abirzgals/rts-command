import { defineQuery, hasComponent, removeComponent, addComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Producer, Position, Faction, IsBuilding, BuildProgress, Health, UnitTypeC, WorkerC, Dead, MoveTarget, ResourceNode } from '../components'
import { UNIT_DEFS, BUILDING_DEFS, UT_WORKER } from '../../game/config'
import { getTerrainHeight } from '../../terrain/heightmap'
import { gameState } from '../../game/state'
import { spawnUnit } from '../archetypes'
import { spatialHash } from '../../globals'

const producerQuery = defineQuery([Producer, Position, Faction, IsBuilding])
const buildingQuery = defineQuery([BuildProgress, Position, IsBuilding, Health])
const workerQuery = defineQuery([WorkerC, Position, Faction])
const BUILD_RANGE = 4.0 // max distance worker can build from

export function productionSystem(world: IWorld, dt: number) {
  // ── Unit production ──────────────────────────────────────
  const producers = producerQuery(world)

  for (const eid of producers) {
    if (Producer.active[eid] !== 1) continue

    // Check if building is still under construction
    if (hasComponent(world, BuildProgress, eid)) continue

    Producer.progress[eid] += dt

    if (Producer.progress[eid] >= Producer.duration[eid]) {
      // Spawn the unit
      const unitType = Producer.unitType[eid]
      const faction = Faction.id[eid]
      const rallyX = Producer.rallyX[eid]
      const rallyZ = Producer.rallyZ[eid]
      const rallyTarget = Producer.rallyTargetEid[eid]

      // Spawn near building, not at rally point
      const spawnX = Position.x[eid] + 3
      const spawnZ = Position.z[eid] + 3
      const newEid = spawnUnit(world, unitType, faction, spawnX, spawnZ)

      // Send to rally point
      addComponent(world, MoveTarget, newEid)
      MoveTarget.x[newEid] = rallyX
      MoveTarget.z[newEid] = rallyZ

      // If worker + rally on resource → auto-gather
      if (unitType === UT_WORKER && rallyTarget > 0 &&
          hasComponent(world, ResourceNode, rallyTarget) && !hasComponent(world, Dead, rallyTarget)) {
        WorkerC.state[newEid] = 1 // movingToResource
        WorkerC.targetNode[newEid] = rallyTarget
      }

      // Check queue for next item
      const queue = gameState.getQueue(eid)
      queue.shift() // remove completed item

      if (queue.length > 0) {
        const next = queue[0]
        Producer.unitType[eid] = next.unitType
        Producer.progress[eid] = 0
        Producer.duration[eid] = next.remaining
      } else {
        Producer.active[eid] = 0
        Producer.progress[eid] = 0
      }
    }
  }

  // ── Building construction (worker-driven) ────────────────
  const buildings = buildingQuery(world)

  for (const eid of buildings) {
    const bx = Position.x[eid]
    const bz = Position.z[eid]
    const bFaction = Faction.id[eid]

    // Check if any worker (state=5, building) is nearby
    let hasBuilder = false
    const nearby: number[] = []
    spatialHash.query(bx, bz, BUILD_RANGE + 1, nearby)
    for (const wid of nearby) {
      if (hasComponent(world, Dead, wid)) continue
      if (!hasComponent(world, WorkerC, wid)) continue
      if (Faction.id[wid] !== bFaction) continue
      if (WorkerC.state[wid] !== 5) continue // 5 = building
      if (WorkerC.buildTarget[wid] !== eid) continue
      const dx = Position.x[wid] - bx
      const dz = Position.z[wid] - bz
      if (dx * dx + dz * dz < BUILD_RANGE * BUILD_RANGE) {
        hasBuilder = true
        break
      }
    }

    if (!hasBuilder) continue // no worker building → paused

    // Progress construction
    const progressDelta = dt / BuildProgress.duration[eid]
    BuildProgress.progress[eid] = Math.min(1, BuildProgress.progress[eid] + progressDelta)

    // Gradual cost: spend resources proportionally
    const totalMinerals = BuildProgress.costMinerals[eid]
    const totalGas = BuildProgress.costGas[eid]
    const targetSpent = BuildProgress.progress[eid]
    const prevSpent = BuildProgress.spent[eid]

    if (targetSpent > prevSpent) {
      const delta = targetSpent - prevSpent
      const mineralsToSpend = Math.floor(totalMinerals * delta)
      const gasToSpend = Math.floor(totalGas * delta)

      const res = gameState.getResources(bFaction)
      if (res.minerals >= mineralsToSpend && res.gas >= gasToSpend) {
        res.minerals -= mineralsToSpend
        res.gas -= gasToSpend
        BuildProgress.spent[eid] = targetSpent
      } else {
        // Can't afford — stall construction
        BuildProgress.progress[eid] -= progressDelta
        continue
      }
    }

    // HP rises with progress
    const maxHp = Health.max[eid]
    Health.current[eid] = Math.min(maxHp, maxHp * 0.1 + maxHp * 0.9 * BuildProgress.progress[eid])

    // Keep at ground level during construction
    const terrainY = getTerrainHeight(bx, bz)
    Position.y[eid] = terrainY

    if (BuildProgress.progress[eid] >= 1) {
      removeComponent(world, BuildProgress, eid)
      Health.current[eid] = maxHp
      Position.y[eid] = terrainY
    }
  }
}
