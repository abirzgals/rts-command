import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, IsBuilding, Producer, WorkerC, AttackC,
  MoveTarget, AttackTarget, AttackMove, Health, Dead, UnitTypeC,
  PathFollower, StuckState, Velocity, MoveSpeed,
} from '../components'
import {
  UT_WORKER, UT_MARINE, UT_TANK, UT_JEEP, UT_TROOPER,
  BT_COMMAND_CENTER, BT_BARRACKS, BT_SUPPLY_DEPOT, BT_FACTORY,
  BUILDING_DEFS, UNIT_DEFS, MAP_SIZE,
} from '../../game/config'
import { gameState } from '../../game/state'
import { spawnBuilding } from '../archetypes'
import { queueProduction } from '../../input/input'
import { spatialHash } from '../../globals'
import { isVisibleAt } from '../../render/fogOfWar'
import { getAIFaction, getPlayerFaction } from '../../game/factions'
import { isWorldWalkable } from '../../pathfinding/navGrid'
import { worldToGrid } from '../../terrain/heightmap'
import { sectorId, findSectorPath } from '../../pathfinding/sectorGraph'

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
const ASSIST_RADIUS   = 18    // idle units within this radius of a fighting ally will join
const MAP_HALF        = MAP_SIZE / 2

// ── Queries ─────────────────────────────────────────────────
const enemyUnitQuery     = defineQuery([Position, Faction, Health])
const enemyBuildingQuery = defineQuery([Position, Faction, IsBuilding])
const playerBuildingQuery = defineQuery([Position, Faction, IsBuilding])

// ═══════════════════════════════════════════════════════════════
//  Seeded RNG — deterministic per map, seeded at game start
// ═══════════════════════════════════════════════════════════════
let aiSeed = 1
export function seedAIRng(seed: number) { aiSeed = seed | 0 || 1 }
function aiRng(): number {
  aiSeed = (aiSeed * 1664525 + 1013904223) & 0x7fffffff
  return aiSeed / 0x7fffffff
}

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
let attackCount = 0               // how many attacks AI has launched
let attackTargetX = NaN           // actual attack destination (may differ from player base)
let attackTargetZ = NaN

// Known player army concentrations
let knownArmyX = NaN
let knownArmyZ = NaN
let knownArmySupply = 0

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
  const [hgx, hgz] = worldToGrid(homeX, homeZ)
  const homeSector = sectorId(hgx, hgz)

  const pts: { x: number; z: number }[] = []
  // Build a grid of points — only walkable AND reachable from home via pathfinding
  for (let x = -MAP_HALF + SCOUT_GRID_STEP / 2; x < MAP_HALF; x += SCOUT_GRID_STEP) {
    for (let z = -MAP_HALF + SCOUT_GRID_STEP / 2; z < MAP_HALF; z += SCOUT_GRID_STEP) {
      if (!isWorldWalkable(x, z)) continue
      // Check sector-level reachability (fast — only 169 sectors)
      const [gx, gz] = worldToGrid(x, z)
      const wpSector = sectorId(gx, gz)
      if (wpSector !== homeSector && !findSectorPath(homeSector, wpSector)) continue
      pts.push({ x, z })
    }
  }

  // Sort: nearest first, then expand outward (explore nearby before far)
  pts.sort((a, b) => {
    const dA = (a.x - homeX) ** 2 + (a.z - homeZ) ** 2
    const dB = (b.x - homeX) ** 2 + (b.z - homeZ) ** 2
    return dA - dB // nearest first
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

  const res = gameState.getResources(getAIFaction())
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

  // Clear stale movement for idle units at home so they can auto-acquire
  for (const eid of census.combatUnits) {
    const d = Math.sqrt((Position.x[eid] - homeX) ** 2 + (Position.z[eid] - homeZ) ** 2)
    if (d < DEFENSE_RADIUS && !hasComponent(world, AttackTarget, eid)) {
      // At home and idle — clear MoveTarget so combat auto-acquire works
      if (hasComponent(world, MoveTarget, eid)) {
        const mx = MoveTarget.x[eid], mz = MoveTarget.z[eid]
        const dToMoveTarget = Math.sqrt((mx - Position.x[eid]) ** 2 + (mz - Position.z[eid]) ** 2)
        if (dToMoveTarget < 3) removeComponent(world, MoveTarget, eid) // arrived, clear
      }
    }
  }

  // Nearby assist: idle AI units join when a nearby ally is fighting
  tickNearbyAssist(world, census)

  // Worker self-defense
  tickWorkerDefense(world, census, homeX, homeZ, decisions)

  // ── Debug overlay ──────────────────────────────────────────
  const armySupply = census.armySupply
  const lines: string[] = [
    `State: ${STATE_NAMES[aiState]}`,
    `Workers:${census.workerCount} Marines:${census.marineCount} Tanks:${census.tankCount} Jeeps:${census.jeepCount} Troopers:${census.trooperCount}`,
    `Army supply: ${armySupply} | CC:${census.commandCenter ? 'Y' : 'N'} Rax:${hasBarracks ? 'Y' : 'N'} Fac:${hasFactory ? 'Y' : 'N'}`,
    `Min:${Math.floor(res.minerals)} Gas:${Math.floor(res.gas)} Sup:${res.supplyCurrent}/${res.supplyMax}`,
    `Player base: ${hasFoundPlayerBase() ? `(${Math.round(knownPlayerBaseX)}, ${Math.round(knownPlayerBaseZ)})` : 'unknown'} | Attacks: ${attackCount}`,
    knownArmySupply >= 4 ? `Player army: ${knownArmySupply} supply @ (${Math.round(knownArmyX)}, ${Math.round(knownArmyZ)})` : '',
  ]
  if (decisions.length > 0) lines.push('> ' + decisions.join(' | '))
  aiDebugStatus = lines.filter(l => l).join('\n')
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

/** Reset AI state — call after team swap so AI re-evaluates from scratch */
export function resetAIState() {
  aiState = AIState.SCOUTING
  aiTimer = 0
  scoutEid = null
  scoutWaypoints = []
  scoutWaypointIdx = 0
  knownPlayerBaseX = NaN
  knownPlayerBaseZ = NaN
  rallyX = NaN
  rallyZ = NaN
  stagingTimer = 0
  attackOrderIssued = false
  attackCount = 0
  attackTargetX = NaN
  attackTargetZ = NaN
  knownArmyX = NaN
  knownArmyZ = NaN
  knownArmySupply = 0
  hasBarracks = false
  hasFactory = false
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
    return
  }

  // If scout reached waypoint (or is idle/finished attack), send to next
  const hasOrders = hasComponent(world, MoveTarget, scoutEid) || hasComponent(world, PathFollower, scoutEid)
    || hasComponent(world, AttackTarget, scoutEid)

  if (!hasOrders && scoutWaypointIdx < scoutWaypoints.length) {
    const wp = scoutWaypoints[scoutWaypointIdx]
    scoutWaypointIdx++
    sendAttackMoveTo(world, scoutEid, wp.x, wp.z)
    decisions.push(`Scout A-move → (${Math.round(wp.x)}, ${Math.round(wp.z)}) [${scoutWaypointIdx}/${scoutWaypoints.length}]`)
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
  if (Faction.id[eid] !== getAIFaction()) return false
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
    // Pick a rally point — varies each attack, checks walkability
    computeRallyPoint(world, homeX, homeZ)
    transitionTo(AIState.STAGING)
    decisions.push(`Army ready (${census.armySupply} supply), moving to staging`)
    return
  }

  decisions.push(`Building army (${census.armySupply}/${MIN_ATTACK_ARMY} supply)`)
}

/** Scan for player army concentrations visible to AI units */
function scanPlayerArmy(world: IWorld): void {
  const units = enemyUnitQuery(world)
  // Find clusters of player combat units visible to AI
  const playerUnits: { x: number; z: number; supply: number }[] = []
  for (const eid of units) {
    if (Faction.id[eid] !== getPlayerFaction()) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (hasComponent(world, WorkerC, eid)) continue
    // Check if any AI unit can see this player unit (within sight range)
    const px = Position.x[eid], pz = Position.z[eid]
    const _near: number[] = []
    spatialHash.query(px, pz, 15, _near)
    let visible = false
    for (const other of _near) {
      if (Faction.id[other] !== getAIFaction()) continue
      if (hasComponent(world, Dead, other)) continue
      visible = true
      break
    }
    if (!visible) continue
    const ut = hasComponent(world, UnitTypeC, eid) ? UnitTypeC.id[eid] : -1
    const s = ut === UT_TANK ? 3 : (ut === UT_JEEP || ut === UT_TROOPER) ? 2 : 1
    playerUnits.push({ x: px, z: pz, supply: s })
  }
  if (playerUnits.length < 3) {
    knownArmySupply = 0
    return
  }
  // Compute centroid and total supply
  let cx = 0, cz = 0, total = 0
  for (const u of playerUnits) {
    cx += u.x * u.supply
    cz += u.z * u.supply
    total += u.supply
  }
  knownArmyX = cx / total
  knownArmyZ = cz / total
  knownArmySupply = total
}

function computeRallyPoint(world: IWorld, homeX: number, homeZ: number) {
  if (!hasFoundPlayerBase()) return

  // Decide attack target: player army (if significant) or base
  scanPlayerArmy(world)
  const targetArmy = knownArmySupply >= 4
  let destX: number, destZ: number
  if (targetArmy) {
    destX = knownArmyX
    destZ = knownArmyZ
  } else {
    destX = knownPlayerBaseX
    destZ = knownPlayerBaseZ
  }
  attackTargetX = destX
  attackTargetZ = destZ

  // Generate candidate staging positions around the attack target
  // Each attack uses a different approach angle
  const dx = destX - homeX
  const dz = destZ - homeZ
  const dist = Math.sqrt(dx * dx + dz * dz)
  const nx = dx / (dist || 1), nz = dz / (dist || 1) // direction toward target
  const perpX = -nz, perpZ = nx // perpendicular

  // Rotate approach angle based on attack count to vary staging position
  const angles = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 3, -Math.PI / 3, Math.PI / 6, -Math.PI / 6]
  const baseAngle = angles[attackCount % angles.length]
  // Add some randomness
  const angle = baseAngle + (aiRng() - 0.5) * 0.3

  const cos = Math.cos(angle), sin = Math.sin(angle)
  // Rotated direction from target back toward home
  const backX = -nx * cos - nz * sin
  const backZ = nx * sin - nz * cos

  const stageDist = Math.min(RALLY_DIST, dist * 0.4)
  const candidates: { x: number; z: number }[] = []

  // Main candidate
  candidates.push({
    x: destX + backX * stageDist,
    z: destZ + backZ * stageDist,
  })
  // Flank candidates
  candidates.push({
    x: destX + perpX * stageDist * 0.8 + backX * stageDist * 0.6,
    z: destZ + perpZ * stageDist * 0.8 + backZ * stageDist * 0.6,
  })
  candidates.push({
    x: destX - perpX * stageDist * 0.8 + backX * stageDist * 0.6,
    z: destZ - perpZ * stageDist * 0.8 + backZ * stageDist * 0.6,
  })
  // Midpoint between home and target
  candidates.push({
    x: (homeX + destX) / 2 + perpX * 10 * (aiRng() > 0.5 ? 1 : -1),
    z: (homeZ + destZ) / 2 + perpZ * 10 * (aiRng() > 0.5 ? 1 : -1),
  })

  // Pick the best candidate: walkable AND reachable from home via pathfinding
  const [hgx, hgz] = worldToGrid(homeX, homeZ)
  const homeSector = sectorId(hgx, hgz)

  for (const c of candidates) {
    // Clamp to map
    c.x = Math.max(-MAP_HALF + 5, Math.min(MAP_HALF - 5, c.x))
    c.z = Math.max(-MAP_HALF + 5, Math.min(MAP_HALF - 5, c.z))

    if (!isWorldWalkable(c.x, c.z)) continue

    // Check reachability via sector graph
    const [gx, gz] = worldToGrid(c.x, c.z)
    const cSector = sectorId(gx, gz)
    if (cSector !== homeSector && !findSectorPath(homeSector, cSector)) continue

    // Also verify path from staging to attack target
    const [tgx, tgz] = worldToGrid(destX, destZ)
    const tSector = sectorId(tgx, tgz)
    if (cSector !== tSector && !findSectorPath(cSector, tSector)) continue

    rallyX = c.x
    rallyZ = c.z
    return
  }

  // Fallback: find a walkable spot near home base (safe rally)
  // Try points along the line from home to target
  for (let t = 0.3; t <= 0.7; t += 0.1) {
    const fx = homeX + (destX - homeX) * t
    const fz = homeZ + (destZ - homeZ) * t
    if (isWorldWalkable(fx, fz)) {
      const [gx, gz] = worldToGrid(fx, fz)
      const fSector = sectorId(gx, gz)
      if (fSector === homeSector || findSectorPath(homeSector, fSector)) {
        rallyX = fx
        rallyZ = fz
        return
      }
    }
  }

  // Last resort: rally at home
  rallyX = homeX + aiRng() * 10 - 5
  rallyZ = homeZ + aiRng() * 10 - 5
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
      const rx = rallyX + (aiRng() - 0.5) * 6
      const rz = rallyZ + (aiRng() - 0.5) * 6
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

  // Use the pre-computed attack target (army or base)
  let targetX = !isNaN(attackTargetX) ? attackTargetX : (hasFoundPlayerBase() ? knownPlayerBaseX : -MAP_HALF + 20)
  let targetZ = !isNaN(attackTargetZ) ? attackTargetZ : (hasFoundPlayerBase() ? knownPlayerBaseZ : -MAP_HALF + 20)

  // Re-scan player army — if we were targeting army and it moved, update target
  scanPlayerArmy(world)
  if (knownArmySupply >= 4) {
    // Redirect attack toward player army concentration
    targetX = knownArmyX
    targetZ = knownArmyZ
  }

  if (!attackOrderIssued) {
    const force = selectAttackForce(world, census)
    sendGroupAttackMove(world, force, targetX, targetZ)
    attackOrderIssued = true
    attackCount++
    const targetType = knownArmySupply >= 4 ? 'army' : 'base'
    decisions.push(`Attack #${attackCount} (${targetType}): ${force.length} units → (${Math.round(targetX)}, ${Math.round(targetZ)})`)
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

  // Find the centroid of enemy threats at base to send defenders there
  const _near: number[] = []
  spatialHash.query(homeX, homeZ, DEFENSE_RADIUS, _near)
  let threatX = 0, threatZ = 0, threatCount = 0
  for (const eid of _near) {
    if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== getPlayerFaction()) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    threatX += Position.x[eid]
    threatZ += Position.z[eid]
    threatCount++
  }
  if (threatCount > 0) {
    threatX /= threatCount
    threatZ /= threatCount
  } else {
    threatX = homeX; threatZ = homeZ
  }

  // Send only enough to counter: threat * 1.5 supply worth of units
  const neededSupply = Math.ceil(threat * 1.5)

  // Combat units at home: actively attack-move toward the threat
  let homeDefenseSupply = 0
  for (const eid of census.combatUnits) {
    const d = Math.sqrt((Position.x[eid] - homeX) ** 2 + (Position.z[eid] - homeZ) ** 2)
    if (d < DEFENSE_RADIUS) {
      const ut = hasComponent(world, UnitTypeC, eid) ? UnitTypeC.id[eid] : -1
      homeDefenseSupply += ut === UT_TANK ? 3 : (ut === UT_JEEP || ut === UT_TROOPER) ? 2 : 1

      // If idle (no attack target), send to fight
      if (!hasComponent(world, AttackTarget, eid)) {
        sendAttackMoveTo(world, eid, threatX + (aiRng() - 0.5) * 4, threatZ + (aiRng() - 0.5) * 4)
      }
    }
  }

  // Already enough defenders?
  if (homeDefenseSupply >= neededSupply) {
    decisions.push(`Defense OK (${homeDefenseSupply}/${neededSupply} supply home)`)
    return
  }

  // Recall closest away units until we have enough
  const deficit = neededSupply - homeDefenseSupply
  let recalled = 0
  let recalledSupply = 0

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

    if (!hasComponent(world, AttackTarget, eid)) {
      sendAttackMoveTo(world, eid, threatX + (aiRng() - 0.5) * 6, threatZ + (aiRng() - 0.5) * 6)
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
    if (gameState.canAfford(getAIFaction(), def.cost)) {
      queueProduction(census.commandCenter, UT_WORKER)
      decisions.push('+Worker')
    }
  }

  // ── Supply depots ──────────────────────────────────────────
  if (res.supplyMax - res.supplyCurrent < 5 && census.commandCenter) {
    const def = BUILDING_DEFS[BT_SUPPLY_DEPOT]
    if (gameState.canAfford(getAIFaction(), def.cost)) {
      const angle = aiRng() * Math.PI * 2
      spawnBuilding(world, BT_SUPPLY_DEPOT, getAIFaction(),
        homeX + Math.cos(angle) * 6, homeZ + Math.sin(angle) * 6, true)
      gameState.spend(getAIFaction(), def.cost)
    }
  }

  // ── Barracks ───────────────────────────────────────────────
  if (!hasBarracks && census.commandCenter) {
    const def = BUILDING_DEFS[BT_BARRACKS]
    if (gameState.canAfford(getAIFaction(), def.cost)) {
      spawnBuilding(world, BT_BARRACKS, getAIFaction(), homeX + 8, homeZ + 4, true)
      gameState.spend(getAIFaction(), def.cost)
    }
  }

  // ── Factory (after some marines) ───────────────────────────
  if (!hasFactory && hasBarracks && census.marineCount >= 3 && census.commandCenter) {
    const def = BUILDING_DEFS[BT_FACTORY]
    if (gameState.canAfford(getAIFaction(), def.cost)) {
      spawnBuilding(world, BT_FACTORY, getAIFaction(), homeX - 8, homeZ + 4, true)
      gameState.spend(getAIFaction(), def.cost)
    }
  }

  // ── Army production ────────────────────────────────────────
  // During ATTACKING state, don't produce (all-in). Otherwise, build army.
  if (aiState !== AIState.ATTACKING) {
    if (census.barracks && census.marineCount < 15 && res.supplyCurrent < res.supplyMax) {
      const def = UNIT_DEFS[UT_MARINE]
      if (gameState.canAfford(getAIFaction(), def.cost)) {
        queueProduction(census.barracks, UT_MARINE)
      }
    }

    if (census.factory && census.tankCount < 5 && res.supplyCurrent < res.supplyMax) {
      const def = UNIT_DEFS[UT_TANK]
      if (gameState.canAfford(getAIFaction(), def.cost)) {
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
    if (Faction.id[eid] !== getPlayerFaction()) continue
    if (hasComponent(world, Dead, eid)) continue

    const bx = Position.x[eid]
    const bz = Position.z[eid]

    // Check if any AI unit can "see" this building
    // Simple check: is any AI unit within 15 units of this building?
    const _near: number[] = []
    spatialHash.query(bx, bz, 15, _near)
    for (const other of _near) {
      if (Faction.id[other] !== getAIFaction()) continue
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
    if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== getPlayerFaction()) continue
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
    const destX = targetX + (aiRng() - 0.5) * 10
    const destZ = targetZ + (aiRng() - 0.5) * 10
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
    if (Faction.id[eid] !== getAIFaction()) continue
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
    if (Faction.id[eid] !== getAIFaction()) continue
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

// ═══════════════════════════════════════════════════════════════
//  Nearby assist: idle AI units join when an ally is fighting
// ═══════════════════════════════════════════════════════════════
function tickNearbyAssist(world: IWorld, census: Census) {
  // Collect fighting units (have an AttackTarget)
  const fighters: number[] = []
  for (const eid of census.combatUnits) {
    if (hasComponent(world, AttackTarget, eid) && !hasComponent(world, Dead, eid)) {
      fighters.push(eid)
    }
  }
  if (fighters.length === 0) return

  // For each idle combat unit, check if any fighting ally is nearby
  for (const eid of census.combatUnits) {
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, AttackTarget, eid)) continue // already fighting
    if (hasComponent(world, WorkerC, eid)) continue // workers handled separately

    const ex = Position.x[eid], ez = Position.z[eid]

    for (const fighter of fighters) {
      const fx = Position.x[fighter], fz = Position.z[fighter]
      const dx = fx - ex, dz = fz - ez
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist > ASSIST_RADIUS) continue

      // Ally is fighting nearby — attack-move to the fight
      const targetEid = AttackTarget.eid[fighter]
      if (!hasComponent(world, Position, targetEid)) continue
      const tx = Position.x[targetEid], tz = Position.z[targetEid]
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = tx
      MoveTarget.z[eid] = tz
      addComponent(world, AttackMove, eid)
      AttackMove.destX[eid] = tx
      AttackMove.destZ[eid] = tz
      break // one assist order per tick is enough
    }
  }
}

let workerFleeTimer = 0  // cooldown to avoid spamming flee commands

function tickWorkerDefense(world: IWorld, census: Census, homeX: number, homeZ: number, decisions: string[]) {
  workerFleeTimer = Math.max(0, workerFleeTimer - AI_TICK)
  if (census.workers.length === 0) return

  const WORKER_MAX_CHASE = 12 // max distance from home before forced recall

  // First: recall ALL workers that are too far from home
  for (const wid of census.workers) {
    if (hasComponent(world, Dead, wid)) continue
    const wx = Position.x[wid], wz = Position.z[wid]
    const dHome = Math.sqrt((wx - homeX) ** 2 + (wz - homeZ) ** 2)
    if (dHome > WORKER_MAX_CHASE) {
      // Too far — stop fighting and go home immediately
      if (hasComponent(world, AttackTarget, wid)) removeComponent(world, AttackTarget, wid)
      if (hasComponent(world, AttackMove, wid)) removeComponent(world, AttackMove, wid)
      WorkerC.state[wid] = 0
      sendMoveTo(world, wid, homeX + (aiRng() - 0.5) * 6, homeZ + (aiRng() - 0.5) * 6)
    }
  }

  // Find threats near home base only
  const threatenedWorkers: number[] = []
  const nearbyEnemies = new Set<number>()

  for (const wid of census.workers) {
    if (hasComponent(world, Dead, wid)) continue
    const wx = Position.x[wid], wz = Position.z[wid]
    // Only consider workers near home
    if (Math.sqrt((wx - homeX) ** 2 + (wz - homeZ) ** 2) > WORKER_MAX_CHASE) continue

    const _near: number[] = []
    spatialHash.query(wx, wz, WORKER_THREAT_RADIUS, _near)
    for (const eid of _near) {
      if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== getPlayerFaction()) continue
      if (hasComponent(world, Dead, eid)) continue
      if (hasComponent(world, IsBuilding, eid)) continue
      nearbyEnemies.add(eid)
      if (!threatenedWorkers.includes(wid)) threatenedWorkers.push(wid)
    }
  }

  if (threatenedWorkers.length === 0 || nearbyEnemies.size === 0) return

  // Check if any workers are being directly attacked by the enemy
  let workersUnderAttack = false
  for (const wid of threatenedWorkers) {
    // A worker is "under attack" if an enemy has it as AttackTarget
    for (const enemy of nearbyEnemies) {
      if (hasComponent(world, AttackTarget, enemy) && AttackTarget.eid[enemy] === wid) {
        workersUnderAttack = true
        break
      }
    }
    if (workersUnderAttack) break
  }

  // Count nearby friendly combat units (non-workers) that can handle the threat
  let nearbyCombatHP = 0
  for (const eid of census.combatUnits) {
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, WorkerC, eid)) continue // don't count workers
    // Check if combat unit is near the threatened area
    for (const wid of threatenedWorkers) {
      const dx = Position.x[eid] - Position.x[wid], dz = Position.z[eid] - Position.z[wid]
      if (dx * dx + dz * dz < DEFENSE_RADIUS * DEFENSE_RADIUS) {
        if (hasComponent(world, Health, eid)) nearbyCombatHP += Health.current[eid]
        break
      }
    }
  }

  // Calculate enemy strength
  let enemyHP = 0
  for (const eid of nearbyEnemies) {
    if (hasComponent(world, Health, eid)) enemyHP += Health.current[eid]
  }

  // Workers only fight if:
  // 1. Workers are being directly attacked, OR
  // 2. Not enough combat units to handle the threat (combat HP < enemy HP)
  const combatCanHandle = nearbyCombatHP >= enemyHP
  const shouldFight = workersUnderAttack || !combatCanHandle

  if (shouldFight) {
    let workerHP = 0
    for (const wid of threatenedWorkers) {
      if (hasComponent(world, Health, wid)) workerHP += Health.current[wid]
    }

    // Even when fighting, if workers are massively outgunned, flee instead
    const totalFriendlyHP = workerHP + nearbyCombatHP
    if (totalFriendlyHP < enemyHP * 0.5) {
      // Totally outmatched — flee
      if (workerFleeTimer <= 0) {
        workerFleeTimer = 6
        for (const wid of threatenedWorkers) {
          if (hasComponent(world, WorkerC, wid)) WorkerC.state[wid] = 0
          if (hasComponent(world, AttackTarget, wid)) removeComponent(world, AttackTarget, wid)
          const wx = Position.x[wid], wz = Position.z[wid]
          const dx = homeX - wx, dz = homeZ - wz
          const d = Math.sqrt(dx * dx + dz * dz) || 1
          sendMoveTo(world, wid, wx + (dx / d) * WORKER_FLEE_DIST, wz + (dz / d) * WORKER_FLEE_DIST)
        }
        decisions.push(`Workers FLEE! (${threatenedWorkers.length}w vs ${nearbyEnemies.size}e, outmatched)`)
      }
      return
    }

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
        if (hasComponent(world, AttackTarget, wid)) continue
        addComponent(world, AttackTarget, wid)
        AttackTarget.eid[wid] = closestEnemy
      }
      decisions.push(`Workers FIGHT! (${threatenedWorkers.length}w vs ${nearbyEnemies.size}e, ${workersUnderAttack ? 'under attack' : 'no combat cover'})`)
    }
  } else {
    // Combat units are handling it — workers stay out of the fight
    // But stop any workers that were previously fighting
    for (const wid of threatenedWorkers) {
      if (hasComponent(world, AttackTarget, wid)) {
        removeComponent(world, AttackTarget, wid)
        WorkerC.state[wid] = 0 // reset to idle so they resume gathering
      }
    }
    decisions.push(`Workers STAND DOWN (combat handling ${nearbyEnemies.size}e)`)
  }
}

// ═══════════════════════════════════════════════════════════════
//  Unstick AI units (same as before)
// ═══════════════════════════════════════════════════════════════

function unstickUnits(world: IWorld, census: Census) {
  const units = enemyUnitQuery(world)
  for (const eid of units) {
    if (Faction.id[eid] !== getAIFaction()) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (!hasComponent(world, StuckState, eid)) continue

    if (StuckState.phase[eid] >= 2) {
      const rx = Position.x[eid] + (aiRng() - 0.5) * 20
      const rz = Position.z[eid] + (aiRng() - 0.5) * 20
      StuckState.phase[eid] = 0
      StuckState.timer[eid] = 0
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = rx
      MoveTarget.z[eid] = rz
    }
  }
}
