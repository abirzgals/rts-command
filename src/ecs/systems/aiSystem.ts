import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, IsBuilding, Producer, WorkerC, AttackC,
  MoveTarget, AttackTarget, AttackMove, Health, Dead, UnitTypeC,
  PathFollower, StuckState, Velocity, MoveSpeed,
} from '../components'
import {
  FACTION_ENEMY, FACTION_PLAYER, UT_WORKER, UT_MARINE, UT_TANK, UT_JEEP, UT_TROOPER,
  BT_COMMAND_CENTER, BT_BARRACKS, BT_SUPPLY_DEPOT, BT_FACTORY,
  BUILDING_DEFS, UNIT_DEFS, MAP_SIZE,
} from '../../game/config'
import { gameState } from '../../game/state'
import { spawnBuilding } from '../archetypes'
import { queueProduction } from '../../input/input'
import { spatialHash } from '../../globals'
import { isVisibleAt } from '../../render/fogOfWar'

// ═══════════════════════════════════════════════════════════════
//  AI State Machine
// ═══════════════════════════════════════════════════════════════

const enum AIState {
  SCOUTING   = 0,
  BUILDING   = 1,
  STAGING    = 2,
  ATTACKING  = 3,
  DEFENDING  = 4,
}

const STATE_NAMES = ['SCOUTING', 'BUILDING', 'STAGING', 'ATTACKING', 'DEFENDING']

// ── Config ──────────────────────────────────────────────────
const AI_TICK         = 3.0   // seconds between decisions
const SCOUT_GRID_STEP = 25    // spacing for systematic scout waypoints
const RALLY_DIST      = 25    // how far from player base to stage units
const RALLY_GATHER_R  = 12    // units within this radius count as "gathered"
const MIN_ATTACK_ARMY = 8     // supply worth of army before attacking
const FULL_ATTACK_ARMY = 16   // supply worth for full-strength attack
const DEFENSE_RADIUS  = 20    // how far from CC to detect threats
const DEFENSE_GUARD   = 2     // minimum combat units kept at home
const STAGING_TIMEOUT = 45    // seconds: max wait at staging point
const REGROUP_RADIUS  = 15    // units further than this from centroid need to regroup
const MAP_HALF        = MAP_SIZE / 2

// ── Queries ─────────────────────────────────────────────────
const enemyUnitQuery     = defineQuery([Position, Faction, Health])
const enemyBuildingQuery = defineQuery([Position, Faction, IsBuilding])
const playerBuildingQuery = defineQuery([Position, Faction, IsBuilding])

// ═══════════════════════════════════════════════════════════════
//  AI Memory (persistent across ticks)
// ═══════════════════════════════════════════════════════════════

let aiState: AIState = AIState.SCOUTING
let aiTimer = 0

// Scouting
let scoutEid: number | null = null               // entity doing the scouting
let scoutWaypoints: { x: number; z: number }[] = [] // systematic grid of points
let scoutWaypointIdx = 0

// Known player base location (found by scouting or combat contact)
let knownPlayerBaseX = NaN
let knownPlayerBaseZ = NaN

// Staging / rally point
let rallyX = NaN
let rallyZ = NaN
let stagingTimer = 0
let attackOrderIssued = false

// Building state
let hasBarracks = false
let hasFactory  = false

// Debug
export let aiDebugStatus = ''

// ═══════════════════════════════════════════════════════════════
//  Scout waypoint generation
//  Systematic grid scan biased toward the far half of the map
//  (where the player is likely to be).
// ═══════════════════════════════════════════════════════════════

function generateScoutWaypoints(homeX: number, homeZ: number): { x: number; z: number }[] {
  const pts: { x: number; z: number }[] = []
  // Build a grid of points covering the map
  for (let x = -MAP_HALF + SCOUT_GRID_STEP / 2; x < MAP_HALF; x += SCOUT_GRID_STEP) {
    for (let z = -MAP_HALF + SCOUT_GRID_STEP / 2; z < MAP_HALF; z += SCOUT_GRID_STEP) {
      pts.push({ x, z })
    }
  }
  // Sort by distance from home -- explore far side first (player is likely opposite corner)
  pts.sort((a, b) => {
    const dA = (a.x - homeX) ** 2 + (a.z - homeZ) ** 2
    const dB = (b.x - homeX) ** 2 + (b.z - homeZ) ** 2
    return dB - dA // farthest first
  })
  return pts
}

// ═══════════════════════════════════════════════════════════════
//  Main AI system
// ═══════════════════════════════════════════════════════════════

export function aiSystem(world: IWorld, dt: number) {
  aiTimer += dt
  if (aiTimer < AI_TICK) return
  aiTimer = 0

  // ── Census: count everything ────────────────────────────────
  const census = takeCensus(world)
  if (!census.commandCenter) return // no CC = no AI

  const res = gameState.getResources(FACTION_ENEMY)
  const homeX = Position.x[census.commandCenter]
  const homeZ = Position.z[census.commandCenter]

  // ── Passive income (simulates worker gathering) ─────────────
  if (census.workerCount > 0) {
    res.minerals += census.workerCount * 2
    res.gas += Math.floor(census.workerCount * 0.5)
  }

  // ── Unstick AI units ────────────────────────────────────────
  unstickUnits(world, census)

  // ── Check for threats at home base ──────────────────────────
  const threatSupply = assessThreatAtBase(world, homeX, homeZ)
  if (threatSupply > 0 && aiState !== AIState.ATTACKING) {
    if (aiState !== AIState.DEFENDING) {
      transitionTo(AIState.DEFENDING)
    }
  } else if (aiState === AIState.DEFENDING && threatSupply === 0) {
    transitionTo(hasFoundPlayerBase() ? AIState.BUILDING : AIState.SCOUTING)
  }

  // ── Check if staging area was spotted by player ─────────────
  if (aiState === AIState.STAGING && !isNaN(rallyX)) {
    if (isVisibleAt(rallyX, rallyZ)) {
      // We've been spotted -- attack now before they prepare
      transitionTo(AIState.ATTACKING)
    }
  }

  // ── State machine ──────────────────────────────────────────
  const decisions: string[] = []

  switch (aiState) {
    case AIState.SCOUTING:
      tickScouting(world, census, homeX, homeZ, decisions)
      break
    case AIState.BUILDING:
      tickBuilding(world, census, res, homeX, homeZ, decisions)
      break
    case AIState.STAGING:
      tickStaging(world, census, decisions)
      break
    case AIState.ATTACKING:
      tickAttacking(world, census, decisions)
      break
    case AIState.DEFENDING:
      tickDefending(world, census, homeX, homeZ, decisions)
      break
  }

  // Economy runs in every state (except maybe during all-in attack)
  tickEconomy(world, census, res, homeX, homeZ, decisions)

  // Worker self-defense
  tickWorkerDefense(world, census, homeX, homeZ, decisions)

  // ── Debug overlay ──────────────────────────────────────────
  const armySupply = census.armySupply
  const lines: string[] = [
    `State: ${STATE_NAMES[aiState]}`,
    `Workers:${census.workerCount} Marines:${census.marineCount} Tanks:${census.tankCount} Jeeps:${census.jeepCount} Troopers:${census.trooperCount}`,
    `Army supply: ${armySupply} | CC:${census.commandCenter ? 'Y' : 'N'} Rax:${hasBarracks ? 'Y' : 'N'} Fac:${hasFactory ? 'Y' : 'N'}`,
    `Min:${Math.floor(res.minerals)} Gas:${Math.floor(res.gas)} Sup:${res.supplyCurrent}/${res.supplyMax}`,
    `Player base: ${hasFoundPlayerBase() ? `(${Math.round(knownPlayerBaseX)}, ${Math.round(knownPlayerBaseZ)})` : 'unknown'}`,
  ]
  if (decisions.length > 0) lines.push('> ' + decisions.join(' | '))
  aiDebugStatus = lines.join('\n')
  ;(window as any).__aiDebugStatus = aiDebugStatus
}

// ═══════════════════════════════════════════════════════════════
//  State transitions
// ═══════════════════════════════════════════════════════════════

function transitionTo(state: AIState) {
  aiState = state
  stagingTimer = 0
  attackOrderIssued = false
}

function hasFoundPlayerBase(): boolean {
  return !isNaN(knownPlayerBaseX)
}

// ═══════════════════════════════════════════════════════════════
//  STATE: SCOUTING
//  Send one fast unit to systematically explore the map.
//  Once the player base is found, transition to BUILDING.
// ═══════════════════════════════════════════════════════════════

function tickScouting(
  world: IWorld,
  census: Census,
  homeX: number, homeZ: number,
  decisions: string[],
) {
  // Try to discover player base from combat contact or lucky visibility
  if (tryDiscoverPlayerBase(world)) {
    decisions.push('Found player base!')
    transitionTo(AIState.BUILDING)
    return
  }

  // Generate waypoints on first call
  if (scoutWaypoints.length === 0) {
    scoutWaypoints = generateScoutWaypoints(homeX, homeZ)
    scoutWaypointIdx = 0
  }

  // Pick or validate scout unit
  if (!isValidScout(world, scoutEid)) {
    scoutEid = pickScout(world, census)
  }

  if (!scoutEid) {
    decisions.push('No scout available')
    // Even without a scout, keep building. Transition to building anyway
    // after a while -- we'll find the base through combat contact.
    if (census.armySupply >= MIN_ATTACK_ARMY) {
      transitionTo(AIState.BUILDING)
    }
    return
  }

  // If scout reached waypoint (or is idle), send to next
  const sx = Position.x[scoutEid]
  const sz = Position.z[scoutEid]
  const hasOrders = hasComponent(world, MoveTarget, scoutEid) || hasComponent(world, PathFollower, scoutEid)

  if (!hasOrders && scoutWaypointIdx < scoutWaypoints.length) {
    const wp = scoutWaypoints[scoutWaypointIdx]
    scoutWaypointIdx++
    sendMoveTo(world, scoutEid, wp.x, wp.z)
    decisions.push(`Scout → (${Math.round(wp.x)}, ${Math.round(wp.z)}) [${scoutWaypointIdx}/${scoutWaypoints.length}]`)
  } else if (scoutWaypointIdx >= scoutWaypoints.length) {
    // Exhausted all waypoints without finding base -- reset and try again
    scoutWaypointIdx = 0
    decisions.push('Scout grid exhausted, restarting')
  } else {
    decisions.push('Scout en route')
  }
}

function isValidScout(world: IWorld, eid: number | null): boolean {
  if (eid === null) return false
  if (hasComponent(world, Dead, eid)) return false
  if (!hasComponent(world, Position, eid)) return false
  if (Faction.id[eid] !== FACTION_ENEMY) return false
  return true
}

function pickScout(world: IWorld, census: Census): number | null {
  // Prefer a fast combat unit (marine or jeep) for scouting
  // Avoid sending workers
  let best: number | null = null
  let bestSpeed = 0

  for (const eid of census.combatUnits) {
    const speed = hasComponent(world, MoveSpeed, eid) ? MoveSpeed.value[eid] : 0
    if (speed > bestSpeed) {
      bestSpeed = speed
      best = eid
    }
  }
  return best
}

// ═══════════════════════════════════════════════════════════════
//  STATE: BUILDING
//  Grow economy and army. When army is strong enough, pick a
//  rally point and transition to STAGING.
// ═══════════════════════════════════════════════════════════════

function tickBuilding(
  world: IWorld,
  census: Census,
  res: ReturnType<typeof gameState.getResources>,
  homeX: number, homeZ: number,
  decisions: string[],
) {
  // If we haven't found the player yet, keep a scout going
  if (!hasFoundPlayerBase()) {
    tickScouting(world, census, homeX, homeZ, decisions)
  }

  // Check if army is strong enough to stage
  if (census.armySupply >= MIN_ATTACK_ARMY && hasFoundPlayerBase()) {
    // Pick a rally point: halfway between us and player, offset to avoid LOS
    computeRallyPoint(homeX, homeZ)
    transitionTo(AIState.STAGING)
    decisions.push(`Army ready (${census.armySupply} supply), moving to staging`)
    return
  }

  decisions.push(`Building army (${census.armySupply}/${MIN_ATTACK_ARMY} supply)`)
}

function computeRallyPoint(homeX: number, homeZ: number) {
  if (!hasFoundPlayerBase()) return

  // Point along the line from AI base to player base, RALLY_DIST away from player
  const dx = knownPlayerBaseX - homeX
  const dz = knownPlayerBaseZ - homeZ
  const dist = Math.sqrt(dx * dx + dz * dz)

  if (dist < RALLY_DIST * 2) {
    // Bases are very close -- rally at midpoint
    rallyX = (homeX + knownPlayerBaseX) / 2
    rallyZ = (homeZ + knownPlayerBaseZ) / 2
  } else {
    // Rally at RALLY_DIST from player base, on the line toward AI base
    const t = RALLY_DIST / dist
    rallyX = knownPlayerBaseX - dx * t
    rallyZ = knownPlayerBaseZ - dz * t
  }

  // Offset perpendicular to avoid being on the direct path
  // (player scouts often go straight toward enemy base)
  const perpX = -dz / (dist || 1)
  const perpZ = dx / (dist || 1)
  const offsetDir = Math.random() > 0.5 ? 1 : -1
  rallyX += perpX * 8 * offsetDir
  rallyZ += perpZ * 8 * offsetDir

  // Clamp to map bounds
  rallyX = Math.max(-MAP_HALF + 5, Math.min(MAP_HALF - 5, rallyX))
  rallyZ = Math.max(-MAP_HALF + 5, Math.min(MAP_HALF - 5, rallyZ))
}

// ═══════════════════════════════════════════════════════════════
//  STATE: STAGING
//  Send army to rally point. Wait until gathered. Then attack.
// ═══════════════════════════════════════════════════════════════

function tickStaging(
  world: IWorld,
  census: Census,
  decisions: string[],
) {
  stagingTimer += AI_TICK

  if (isNaN(rallyX)) {
    // No rally point -- shouldn't happen, go back to building
    transitionTo(AIState.BUILDING)
    return
  }

  // Send combat units to rally point (not workers, keep DEFENSE_GUARD at home)
  const unitsToSend = selectAttackForce(world, census)
  let gatheredCount = 0
  let totalSent = 0

  for (const eid of unitsToSend) {
    totalSent++
    const ux = Position.x[eid]
    const uz = Position.z[eid]
    const dToRally = Math.sqrt((ux - rallyX) ** 2 + (uz - rallyZ) ** 2)

    if (dToRally < RALLY_GATHER_R) {
      gatheredCount++
      // At rally point, idle
      continue
    }

    // Not at rally yet -- send there
    const hasOrders = hasComponent(world, MoveTarget, eid)
      || hasComponent(world, PathFollower, eid)
      || hasComponent(world, AttackTarget, eid)

    if (!hasOrders) {
      // Slight randomization so they don't all stack on one point
      const rx = rallyX + (Math.random() - 0.5) * 6
      const rz = rallyZ + (Math.random() - 0.5) * 6
      sendMoveTo(world, eid, rx, rz)
    }
  }

  const pctGathered = totalSent > 0 ? Math.round(100 * gatheredCount / totalSent) : 0
  decisions.push(`Staging: ${gatheredCount}/${totalSent} gathered (${pctGathered}%) | ${Math.round(stagingTimer)}s`)

  // Attack if:
  // 1. Most units gathered (>= 75%), or
  // 2. Staging timeout exceeded, or
  // 3. We have a really big army (>= FULL_ATTACK_ARMY supply)
  const gatherThreshold = totalSent > 0 && gatheredCount >= totalSent * 0.75
  const timedOut = stagingTimer >= STAGING_TIMEOUT
  const massiveArmy = census.armySupply >= FULL_ATTACK_ARMY

  if (gatherThreshold || timedOut || massiveArmy) {
    decisions.push('Launching attack!')
    transitionTo(AIState.ATTACKING)
  }
}

// ═══════════════════════════════════════════════════════════════
//  STATE: ATTACKING
//  All-in attack. Send everything at the player base.
//  Once the attack is over (most units dead), go back to BUILDING.
// ═══════════════════════════════════════════════════════════════

function tickAttacking(
  world: IWorld,
  census: Census,
  decisions: string[],
) {
  // Refresh player base location -- they might have expanded
  tryDiscoverPlayerBase(world)

  const targetX = hasFoundPlayerBase() ? knownPlayerBaseX : -MAP_HALF + 20
  const targetZ = hasFoundPlayerBase() ? knownPlayerBaseZ : -MAP_HALF + 20

  if (!attackOrderIssued) {
    // Issue attack-move to all combat units
    const force = selectAttackForce(world, census)
    sendGroupAttackMove(world, force, targetX, targetZ)
    attackOrderIssued = true
    decisions.push(`Attack order: ${force.length} units → (${Math.round(targetX)}, ${Math.round(targetZ)})`)
  }

  // Check if attack is spent
  if (census.armySupply <= 2) {
    decisions.push('Attack spent, rebuilding')
    transitionTo(AIState.BUILDING)
    return
  }

  decisions.push(`Attacking with ${census.combatUnits.length} units (${census.armySupply} supply)`)
}

// ═══════════════════════════════════════════════════════════════
//  STATE: DEFENDING
//  Pull all nearby units back to base to fight off an attack.
// ═══════════════════════════════════════════════════════════════

function tickDefending(
  world: IWorld,
  census: Census,
  homeX: number, homeZ: number,
  decisions: string[],
) {
  const threat = assessThreatAtBase(world, homeX, homeZ)
  if (threat === 0) return

  // Send only enough to counter: threat * 1.5 supply worth of units
  const neededSupply = Math.ceil(threat * 1.5)

  // Count how much supply is already defending at home
  let homeDefenseSupply = 0
  for (const eid of census.combatUnits) {
    const d = Math.sqrt((Position.x[eid] - homeX) ** 2 + (Position.z[eid] - homeZ) ** 2)
    if (d < DEFENSE_RADIUS) {
      const ut = hasComponent(world, UnitTypeC, eid) ? UnitTypeC.id[eid] : -1
      homeDefenseSupply += ut === UT_TANK ? 3 : (ut === UT_JEEP || ut === UT_TROOPER) ? 2 : 1
    }
  }

  // Already enough defenders?
  if (homeDefenseSupply >= neededSupply) {
    decisions.push(`Defense OK (${homeDefenseSupply}/${neededSupply} supply home)`)
    return
  }

  // Recall closest units until we have enough
  const deficit = neededSupply - homeDefenseSupply
  let recalled = 0
  let recalledSupply = 0

  // Sort by distance to home (closest first — they arrive faster)
  const awayUnits = census.combatUnits
    .filter(eid => {
      const d = Math.sqrt((Position.x[eid] - homeX) ** 2 + (Position.z[eid] - homeZ) ** 2)
      return d >= DEFENSE_RADIUS
    })
    .sort((a, b) => {
      const dA = (Position.x[a] - homeX) ** 2 + (Position.z[a] - homeZ) ** 2
      const dB = (Position.x[b] - homeX) ** 2 + (Position.z[b] - homeZ) ** 2
      return dA - dB // closest first
    })

  for (const eid of awayUnits) {
    if (recalledSupply >= deficit) break

    const hasOrders = hasComponent(world, AttackTarget, eid)
    if (!hasOrders) {
      sendAttackMoveTo(world, eid, homeX + (Math.random() - 0.5) * 8, homeZ + (Math.random() - 0.5) * 8)
    }

    const ut = hasComponent(world, UnitTypeC, eid) ? UnitTypeC.id[eid] : -1
    recalledSupply += ut === UT_TANK ? 3 : (ut === UT_JEEP || ut === UT_TROOPER) ? 2 : 1
    recalled++
  }

  decisions.push(`Defending: threat=${threat} need=${neededSupply} home=${homeDefenseSupply} recalled=${recalled}`)
}

// ═══════════════════════════════════════════════════════════════
//  Economy (runs every tick regardless of state)
// ═══════════════════════════════════════════════════════════════

function tickEconomy(
  world: IWorld,
  census: Census,
  res: ReturnType<typeof gameState.getResources>,
  homeX: number, homeZ: number,
  decisions: string[],
) {
  // ── Workers (up to 8) ──────────────────────────────────────
  if (census.commandCenter && census.workerCount < 8 && res.supplyCurrent < res.supplyMax) {
    const def = UNIT_DEFS[UT_WORKER]
    if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
      queueProduction(census.commandCenter, UT_WORKER)
      decisions.push('+Worker')
    }
  }

  // ── Supply depots ──────────────────────────────────────────
  if (res.supplyMax - res.supplyCurrent < 5 && census.commandCenter) {
    const def = BUILDING_DEFS[BT_SUPPLY_DEPOT]
    if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
      const angle = Math.random() * Math.PI * 2
      spawnBuilding(world, BT_SUPPLY_DEPOT, FACTION_ENEMY,
        homeX + Math.cos(angle) * 6, homeZ + Math.sin(angle) * 6, true)
      gameState.spend(FACTION_ENEMY, def.cost)
    }
  }

  // ── Barracks ───────────────────────────────────────────────
  if (!hasBarracks && census.commandCenter) {
    const def = BUILDING_DEFS[BT_BARRACKS]
    if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
      spawnBuilding(world, BT_BARRACKS, FACTION_ENEMY, homeX + 8, homeZ + 4, true)
      gameState.spend(FACTION_ENEMY, def.cost)
    }
  }

  // ── Factory (after some marines) ───────────────────────────
  if (!hasFactory && hasBarracks && census.marineCount >= 3 && census.commandCenter) {
    const def = BUILDING_DEFS[BT_FACTORY]
    if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
      spawnBuilding(world, BT_FACTORY, FACTION_ENEMY, homeX - 8, homeZ + 4, true)
      gameState.spend(FACTION_ENEMY, def.cost)
    }
  }

  // ── Army production ────────────────────────────────────────
  // During ATTACKING state, don't produce (all-in). Otherwise, build army.
  if (aiState !== AIState.ATTACKING) {
    if (census.barracks && census.marineCount < 15 && res.supplyCurrent < res.supplyMax) {
      const def = UNIT_DEFS[UT_MARINE]
      if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
        queueProduction(census.barracks, UT_MARINE)
      }
    }

    if (census.factory && census.tankCount < 5 && res.supplyCurrent < res.supplyMax) {
      const def = UNIT_DEFS[UT_TANK]
      if (gameState.canAfford(FACTION_ENEMY, def.cost)) {
        queueProduction(census.factory, UT_TANK)
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Player base discovery
// ═══════════════════════════════════════════════════════════════

function tryDiscoverPlayerBase(world: IWorld): boolean {
  const pBuildings = playerBuildingQuery(world)
  for (const eid of pBuildings) {
    if (Faction.id[eid] !== FACTION_PLAYER) continue
    if (hasComponent(world, Dead, eid)) continue

    const bx = Position.x[eid]
    const bz = Position.z[eid]

    // Check if any AI unit can "see" this building
    // Simple check: is any AI unit within 15 units of this building?
    const _near: number[] = []
    spatialHash.query(bx, bz, 15, _near)
    for (const other of _near) {
      if (Faction.id[other] !== FACTION_ENEMY) continue
      if (hasComponent(world, Dead, other)) continue
      // Found it!
      knownPlayerBaseX = bx
      knownPlayerBaseZ = bz
      return true
    }
  }
  return false
}

// ═══════════════════════════════════════════════════════════════
//  Threat detection at home base — returns weighted threat supply
// ═══════════════════════════════════════════════════════════════

function assessThreatAtBase(world: IWorld, homeX: number, homeZ: number): number {
  const _near: number[] = []
  spatialHash.query(homeX, homeZ, DEFENSE_RADIUS, _near)
  let threatSupply = 0
  for (const eid of _near) {
    if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== FACTION_PLAYER) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    // Weight by unit type (same as census)
    const ut = hasComponent(world, UnitTypeC, eid) ? UnitTypeC.id[eid] : -1
    if (ut === UT_TANK) threatSupply += 3
    else if (ut === UT_JEEP || ut === UT_TROOPER) threatSupply += 2
    else threatSupply += 1
  }
  return threatSupply
}

// ═══════════════════════════════════════════════════════════════
//  Army selection: pick units for attack, leave home guard
// ═══════════════════════════════════════════════════════════════

function selectAttackForce(world: IWorld, census: Census): number[] {
  if (census.combatUnits.length <= DEFENSE_GUARD) {
    // Not enough to both guard and attack -- send everyone
    return [...census.combatUnits]
  }

  // Sort by distance to home (farthest first = most expendable for attack)
  const homeX = census.commandCenter ? Position.x[census.commandCenter] : 0
  const homeZ = census.commandCenter ? Position.z[census.commandCenter] : 0

  const sorted = [...census.combatUnits].sort((a, b) => {
    const dA = (Position.x[a] - homeX) ** 2 + (Position.z[a] - homeZ) ** 2
    const dB = (Position.x[b] - homeX) ** 2 + (Position.z[b] - homeZ) ** 2
    return dB - dA // farthest first
  })

  // Keep DEFENSE_GUARD closest units at home
  return sorted.slice(0, sorted.length - DEFENSE_GUARD)
}

// ═══════════════════════════════════════════════════════════════
//  Unit commands
// ═══════════════════════════════════════════════════════════════

function sendMoveTo(world: IWorld, eid: number, x: number, z: number) {
  addComponent(world, MoveTarget, eid)
  MoveTarget.x[eid] = x
  MoveTarget.z[eid] = z
  // Clear any existing attack orders so the unit actually moves
  if (hasComponent(world, AttackTarget, eid)) {
    removeComponent(world, AttackTarget, eid)
  }
  if (hasComponent(world, AttackMove, eid)) {
    removeComponent(world, AttackMove, eid)
  }
}

function sendAttackMoveTo(world: IWorld, eid: number, x: number, z: number) {
  addComponent(world, MoveTarget, eid)
  MoveTarget.x[eid] = x
  MoveTarget.z[eid] = z
  addComponent(world, AttackMove, eid)
  AttackMove.destX[eid] = x
  AttackMove.destZ[eid] = z
}

function sendGroupAttackMove(world: IWorld, units: number[], targetX: number, targetZ: number) {
  for (const eid of units) {
    const destX = targetX + (Math.random() - 0.5) * 10
    const destZ = targetZ + (Math.random() - 0.5) * 10
    sendAttackMoveTo(world, eid, destX, destZ)
  }
}

// ═══════════════════════════════════════════════════════════════
//  Census: count all AI entities
// ═══════════════════════════════════════════════════════════════

interface Census {
  commandCenter: number | null
  barracks: number | null
  factory: number | null
  workerCount: number
  marineCount: number
  tankCount: number
  jeepCount: number
  trooperCount: number
  combatUnits: number[]  // entity IDs of all non-worker combat units
  workers: number[]      // entity IDs of all workers
  armySupply: number     // total supply used by combat units
}

function takeCensus(world: IWorld): Census {
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

  let workerCount = 0
  let marineCount = 0
  let tankCount = 0
  let jeepCount = 0
  let trooperCount = 0
  const combatUnits: number[] = []
  const workers: number[] = []
  let armySupply = 0

  const units = enemyUnitQuery(world)
  for (const eid of units) {
    if (Faction.id[eid] !== FACTION_ENEMY) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue

    const ut = UnitTypeC.id[eid]
    switch (ut) {
      case UT_WORKER: workerCount++; workers.push(eid); break
      case UT_MARINE: marineCount++; combatUnits.push(eid); armySupply += 1; break
      case UT_TANK:   tankCount++;   combatUnits.push(eid); armySupply += 3; break
      case UT_JEEP:   jeepCount++;   combatUnits.push(eid); armySupply += 2; break
      case UT_TROOPER: trooperCount++; combatUnits.push(eid); armySupply += 2; break
      default:                        combatUnits.push(eid); armySupply += 1; break
    }
  }

  return {
    commandCenter, barracks, factory,
    workerCount, marineCount, tankCount, jeepCount, trooperCount,
    combatUnits, workers, armySupply,
  }
}

// ═══════════════════════════════════════════════════════════════
//  Worker self-defense: fight if strong, flee if weak
// ═══════════════════════════════════════════════════════════════

const WORKER_THREAT_RADIUS = 8   // detect threats this close to each worker
const WORKER_FIGHT_MULTIPLIER = 1.5  // workers fight if workerHP >= enemyHP * this
const WORKER_FLEE_DIST = 15      // how far workers run when fleeing

let workerFleeTimer = 0  // cooldown to avoid spamming flee commands

function tickWorkerDefense(world: IWorld, census: Census, homeX: number, homeZ: number, decisions: string[]) {
  workerFleeTimer = Math.max(0, workerFleeTimer - AI_TICK)
  if (census.workers.length === 0) return

  // Find threats near any worker
  const threatenedWorkers: number[] = []
  const nearbyEnemies = new Set<number>()

  for (const wid of census.workers) {
    if (hasComponent(world, Dead, wid)) continue
    const wx = Position.x[wid]
    const wz = Position.z[wid]

    const _near: number[] = []
    spatialHash.query(wx, wz, WORKER_THREAT_RADIUS, _near)
    for (const eid of _near) {
      if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== FACTION_PLAYER) continue
      if (hasComponent(world, Dead, eid)) continue
      if (hasComponent(world, IsBuilding, eid)) continue
      nearbyEnemies.add(eid)
      if (!threatenedWorkers.includes(wid)) threatenedWorkers.push(wid)
    }
  }

  if (threatenedWorkers.length === 0 || nearbyEnemies.size === 0) return

  // Calculate combat strength
  let enemyHP = 0
  let enemyDMG = 0
  for (const eid of nearbyEnemies) {
    if (hasComponent(world, Health, eid)) enemyHP += Health.current[eid]
    if (hasComponent(world, AttackC, eid)) enemyDMG += AttackC.damage[eid]
  }

  let workerHP = 0
  for (const wid of threatenedWorkers) {
    if (hasComponent(world, Health, wid)) workerHP += Health.current[wid]
  }

  const shouldFight = workerHP >= enemyHP * WORKER_FIGHT_MULTIPLIER

  if (shouldFight) {
    // Workers attack! Focus on the closest enemy
    let closestEnemy = -1
    let closestDist = Infinity
    const avgX = threatenedWorkers.reduce((s, w) => s + Position.x[w], 0) / threatenedWorkers.length
    const avgZ = threatenedWorkers.reduce((s, w) => s + Position.z[w], 0) / threatenedWorkers.length

    for (const eid of nearbyEnemies) {
      const dx = Position.x[eid] - avgX, dz = Position.z[eid] - avgZ
      const d = dx * dx + dz * dz
      if (d < closestDist) { closestDist = d; closestEnemy = eid }
    }

    if (closestEnemy >= 0) {
      for (const wid of threatenedWorkers) {
        // Only command idle workers or workers gathering (not already fighting)
        if (hasComponent(world, AttackTarget, wid)) continue
        addComponent(world, AttackTarget, wid)
        AttackTarget.eid[wid] = closestEnemy
      }
      decisions.push(`Workers FIGHT! (${threatenedWorkers.length}w vs ${nearbyEnemies.size}e)`)
    }
  } else {
    // Workers flee! Run away from enemies toward home base
    if (workerFleeTimer <= 0) {
      workerFleeTimer = 6 // don't spam flee commands

      for (const wid of threatenedWorkers) {
        // Clear gathering state so they actually run
        if (hasComponent(world, WorkerC, wid)) WorkerC.state[wid] = 0
        if (hasComponent(world, AttackTarget, wid)) removeComponent(world, AttackTarget, wid)

        // Flee toward home base
        const wx = Position.x[wid], wz = Position.z[wid]
        const dx = homeX - wx, dz = homeZ - wz
        const d = Math.sqrt(dx * dx + dz * dz) || 1
        const fleeX = wx + (dx / d) * WORKER_FLEE_DIST
        const fleeZ = wz + (dz / d) * WORKER_FLEE_DIST
        sendMoveTo(world, wid, fleeX, fleeZ)
      }
      decisions.push(`Workers FLEE! (${threatenedWorkers.length}w vs ${nearbyEnemies.size}e)`)
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Unstick AI units (same as before)
// ═══════════════════════════════════════════════════════════════

function unstickUnits(world: IWorld, census: Census) {
  const units = enemyUnitQuery(world)
  for (const eid of units) {
    if (Faction.id[eid] !== FACTION_ENEMY) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (!hasComponent(world, StuckState, eid)) continue

    if (StuckState.phase[eid] >= 2) {
      const rx = Position.x[eid] + (Math.random() - 0.5) * 20
      const rz = Position.z[eid] + (Math.random() - 0.5) * 20
      StuckState.phase[eid] = 0
      StuckState.timer[eid] = 0
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = rx
      MoveTarget.z[eid] = rz
    }
  }
}
