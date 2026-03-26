import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Faction, SupplyProvider, SupplyCost, Dead, BuildProgress } from '../components'
import { FACTION_PLAYER, FACTION_ENEMY } from '../../game/config'
import { gameState } from '../../game/state'

const providerQuery = defineQuery([SupplyProvider, Faction])
const costQuery = defineQuery([SupplyCost, Faction])

export function supplySystem(world: IWorld, _dt: number) {
  // Recalculate supply every frame (simple and correct)
  const factions = [FACTION_PLAYER, FACTION_ENEMY]

  for (const f of factions) {
    gameState.resources[f].supplyMax = 0
    gameState.resources[f].supplyCurrent = 0
  }

  // Count supply providers (only completed buildings)
  const providers = providerQuery(world)
  for (const eid of providers) {
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, BuildProgress, eid)) continue
    const faction = Faction.id[eid]
    gameState.resources[faction].supplyMax += SupplyProvider.amount[eid]
  }

  // Count supply usage
  const consumers = costQuery(world)
  for (const eid of consumers) {
    if (hasComponent(world, Dead, eid)) continue
    const faction = Faction.id[eid]
    gameState.resources[faction].supplyCurrent += SupplyCost.amount[eid]
  }
}
