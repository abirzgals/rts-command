import { defineQuery, hasComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Producer, Position, Faction, IsBuilding, BuildProgress, Health, UnitTypeC } from '../components'
import { UNIT_DEFS, BUILDING_DEFS } from '../../game/config'
import { getTerrainHeight } from '../../terrain/heightmap'
import { gameState } from '../../game/state'
import { spawnUnit } from '../archetypes'

const producerQuery = defineQuery([Producer, Position, Faction, IsBuilding])
const buildingQuery = defineQuery([BuildProgress, Position, IsBuilding, Health])

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

      spawnUnit(world, unitType, faction, rallyX, rallyZ)

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

  // ── Building construction ────────────────────────────────
  const buildings = buildingQuery(world)

  for (const eid of buildings) {
    BuildProgress.progress[eid] += dt / BuildProgress.duration[eid]

    // Slowly restore HP as building constructs
    const maxHp = Health.max[eid]
    Health.current[eid] = Math.min(maxHp, maxHp * 0.1 + maxHp * 0.9 * BuildProgress.progress[eid])

    // Rise up visually on terrain
    const terrainY = getTerrainHeight(Position.x[eid], Position.z[eid])
    const bdef = BUILDING_DEFS[UnitTypeC.id[eid]]
    const fullHeight = bdef ? bdef.radius * 0.5 : 1.0
    Position.y[eid] = terrainY + BuildProgress.progress[eid] * fullHeight

    if (BuildProgress.progress[eid] >= 1) {
      // Construction complete
      removeComponent(world, BuildProgress, eid)
      Health.current[eid] = maxHp
      Position.y[eid] = terrainY + fullHeight
    }
  }
}
