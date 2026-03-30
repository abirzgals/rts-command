import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, IsBuilding, Producer, WorkerC,
  MoveTarget, AttackTarget, AttackMove, Health, Dead, UnitTypeC,
  PathFollower, StuckState, Velocity,
} from '../components'
import {
  FACTION_ENEMY, FACTION_PLAYER, UT_WORKER, UT_MARINE, UT_TANK,
  BT_COMMAND_CENTER, BT_BARRACKS, BT_SUPPLY_DEPOT, BT_FACTORY,
  BUILDING_DEFS, UNIT_DEFS,
} from '../../game/config'
import { gameState } from '../../game/state'
import { spawnBuilding } from '../archetypes'
import { queueProduction } from '../../input/input'
import { spatialHash } from '../../globals'

const enemyUnitQuery = defineQuery([Position, Faction, Health])
const enemyBuildingQuery = defineQuery([Position, Faction, IsBuilding])
const playerBuildingQuery = defineQuery([Position, Faction, IsBuilding])

let aiTimer = 0
const AI_TICK = 3.0 // seconds between AI decisions
let attackWaveTimer = 0
const ATTACK_WAVE_INTERVAL = 60 // seconds between attack waves
let hasBarracks = false
let hasFactory = false

// Debug info
export let aiDebugStatus = ''

export function aiSystem(world: IWorld, dt: number) {
  aiTimer += dt
  attackWaveTimer += dt

  if (aiTimer < AI_TICK) return
  aiTimer = 0

  const res = gameState.getResources(FACTION_ENEMY)

  // Count enemy buildings and units by type
  let workerCount = 0
  let marineCount = 0
  let tankCount = 0
  let commandCenter: number | null = null
  let barracks: number | null = null
  let factory: number | null = null
  hasBarracks = false
  hasFactory = false

  const buildings = enemyBuildingQuery(world)
  for (const eid of buildings) {
    if (Faction.id[eid] !== FACTION_ENEMY) continue
    if (hasComponent(world, Dead, eid)) continue
    const ut = UnitTypeC.id[eid]
    if (ut === BT_COMMAND_CENTER) commandCenter = eid
    if (ut === BT_BARRACKS) { barracks = eid; hasBarracks = true }
    if (ut === BT_FACTORY) { factory = eid; hasFactory = true }
  }

  const units = enemyUnitQuery(world)
  for (const eid of units) {
    if (Faction.id[eid] !== FACTION_ENEMY) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    const ut = UnitTypeC.id[eid]
    if (ut === UT_WORKER) workerCount++
    if (ut === UT_MARINE) marineCount++
    if (ut === UT_TANK) tankCount++
  }

  // ── Build debug status ───────────────────────────────
  const waveIn = Math.max(0, Math.ceil(ATTACK_WAVE_INTERVAL - attackWaveTimer))
  const lines: string[] = [
    `Workers: ${workerCount} | Marines: ${marineCount} | Tanks: ${tankCount}`,
    `Buildings: CC:${commandCenter ? 'Y' : 'N'} Barracks:${hasBarracks ? 'Y' : 'N'} Factory:${hasFactory ? 'Y' : 'N'}`,
    `Minerals: ${Math.floor(res.minerals)} Gas: ${Math.floor(res.gas)} Supply: ${res.supplyCurrent}/${res.supplyMax}`,
    `Next wave: ${waveIn}s (need ${Math.max(0, 5 - marineCount - tankCount)} more units)`,
  ]
  const decisions: string[] = []

  // ── Build economy ───────────────────────────────────
  // Produce workers (up to 8)
  if (commandCenter && workerCount < 8 && res.supplyCurrent < res.supplyMax) {
    const def = UNIT_DEFS[UT_WORKER]
    if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
      queueProduction(commandCenter, UT_WORKER)
      decisions.push('Producing worker')
    } else decisions.push('Want worker, no money')
  }

  // Build supply if needed
  if (res.supplyMax - res.supplyCurrent < 5 && commandCenter) {
    const def = BUILDING_DEFS[BT_SUPPLY_DEPOT]
    if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
      const cx = Position.x[commandCenter]
      const cz = Position.z[commandCenter]
      const angle = Math.random() * Math.PI * 2
      spawnBuilding(world, BT_SUPPLY_DEPOT, FACTION_ENEMY, cx + Math.cos(angle) * 6, cz + Math.sin(angle) * 6, true)
      gameState.spend(FACTION_ENEMY, def.cost)
    }
  }

  // Build barracks
  if (!hasBarracks && commandCenter) {
    const def = BUILDING_DEFS[BT_BARRACKS]
    if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
      const cx = Position.x[commandCenter]
      const cz = Position.z[commandCenter]
      spawnBuilding(world, BT_BARRACKS, FACTION_ENEMY, cx + 8, cz + 4, true)
      gameState.spend(FACTION_ENEMY, def.cost)
    }
  }

  // Build factory (after having some marines)
  if (!hasFactory && hasBarracks && marineCount >= 3 && commandCenter) {
    const def = BUILDING_DEFS[BT_FACTORY]
    if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
      const cx = Position.x[commandCenter]
      const cz = Position.z[commandCenter]
      spawnBuilding(world, BT_FACTORY, FACTION_ENEMY, cx - 8, cz + 4, true)
      gameState.spend(FACTION_ENEMY, def.cost)
    }
  }

  // ── Produce army ────────────────────────────────────
  if (barracks && marineCount < 15 && res.supplyCurrent < res.supplyMax) {
    const def = UNIT_DEFS[UT_MARINE]
    if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
      queueProduction(barracks, UT_MARINE)
    }
  }

  if (factory && tankCount < 5 && res.supplyCurrent < res.supplyMax) {
    const def = UNIT_DEFS[UT_TANK]
    if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
      queueProduction(factory, UT_TANK)
    }
  }

  // ── Attack waves ────────────────────────────────────
  if (attackWaveTimer >= ATTACK_WAVE_INTERVAL && marineCount + tankCount >= 5) {
    attackWaveTimer = 0
    sendAttackWave(world)
    decisions.push('ATTACK WAVE SENT!')
  } else if (marineCount + tankCount < 5) {
    decisions.push('Building army...')
  } else {
    decisions.push(`Waiting for wave timer (${waveIn}s)`)
  }

  // ── Give AI passive income (simulates worker gathering) ───
  if (workerCount > 0) {
    res.minerals += workerCount * 2 // per AI tick
    res.gas += Math.floor(workerCount * 0.5)
  }

  // ── Unstuck AI units: if stuck (phase >= 2), give new random move ──
  for (const eid of units) {
    if (Faction.id[eid] !== FACTION_ENEMY) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (!hasComponent(world, StuckState, eid)) continue

    if (StuckState.phase[eid] >= 2) {
      // Unit gave up pathfinding — send to random nearby walkable point
      const rx = Position.x[eid] + (Math.random() - 0.5) * 20
      const rz = Position.z[eid] + (Math.random() - 0.5) * 20
      StuckState.phase[eid] = 0
      StuckState.timer[eid] = 0
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = rx
      MoveTarget.z[eid] = rz
    }
  }

  if (decisions.length > 0) lines.push('Decisions: ' + decisions.join(', '))
  aiDebugStatus = lines.join('\n')
  ;(window as any).__aiDebugStatus = aiDebugStatus
}

function sendAttackWave(world: IWorld) {
  // Find a player building to target
  const pBuildings = playerBuildingQuery(world)
  let targetX = -80 // default player base area
  let targetZ = -80

  for (const eid of pBuildings) {
    if (Faction.id[eid] !== FACTION_PLAYER) continue
    if (hasComponent(world, Dead, eid)) continue
    targetX = Position.x[eid]
    targetZ = Position.z[eid]
    break
  }

  // Send all idle combat units
  const units = enemyUnitQuery(world)
  for (const eid of units) {
    if (Faction.id[eid] !== FACTION_ENEMY) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (hasComponent(world, WorkerC, eid)) continue

    // Give attack-move command toward player base
    const destX = targetX + (Math.random() - 0.5) * 10
    const destZ = targetZ + (Math.random() - 0.5) * 10
    addComponent(world, MoveTarget, eid)
    MoveTarget.x[eid] = destX
    MoveTarget.z[eid] = destZ
    addComponent(world, AttackMove, eid)
    AttackMove.destX[eid] = destX
    AttackMove.destZ[eid] = destZ
  }
}
