import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, IsBuilding, Producer, WorkerC, AttackC,
  MoveTarget, AttackTarget, AttackMove, Health, Dead, UnitTypeC,
  PathFollower, StuckState, Velocity, MoveSpeed, ResourceNode, CollisionRadius,
} from '../components'
import {
  UT_WORKER, UT_MARINE, UT_TANK, UT_JEEP, UT_TROOPER, UT_ROCKET,
  BT_COMMAND_CENTER, BT_BARRACKS, BT_SUPPLY_DEPOT, BT_FACTORY,
  BUILDING_DEFS, UNIT_DEFS, MAP_SIZE,
} from '../../game/config'
import { gameState } from '../../game/state'
import { spawnBuilding } from '../archetypes'
import { queueProduction } from '../../input/input'
import { spatialHash } from '../../globals'
import { isVisibleAt } from '../../render/fogOfWar'
import { getAIFaction, getPlayerFaction } from '../../game/factions'
import { isFPSMode, getFPSEntity } from '../../input/fpsMode'
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
const ASSIST_RADIUS   = 20    // idle units within this radius of a fighting ally will join
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
//  AI Memory — per-faction state (supports AI vs AI in FPS mode)
// ═══════════════════════════════════════════════════════════════

interface AIBrain {
  state: AIState
  timer: number
  scoutEid: number | null
  scoutWaypoints: { x: number; z: number }[]
  scoutWaypointIdx: number
  knownEnemyBaseX: number; knownEnemyBaseZ: number
  suspectedBaseX: number; suspectedBaseZ: number
  scoutLastX: number; scoutLastZ: number
  rallyX: number; rallyZ: number
  stagingTimer: number; attackOrderIssued: boolean
  attackCount: number; attackTimer: number
  attackTargetX: number; attackTargetZ: number
  knownArmyX: number; knownArmyZ: number; knownArmySupply: number
  hasBarracks: boolean; hasFactory: boolean
}

function createBrain(): AIBrain {
  return {
    state: AIState.SCOUTING, timer: AI_TICK,
    scoutEid: null, scoutWaypoints: [], scoutWaypointIdx: 0,
    knownEnemyBaseX: NaN, knownEnemyBaseZ: NaN,
    suspectedBaseX: NaN, suspectedBaseZ: NaN,
    scoutLastX: NaN, scoutLastZ: NaN,
    rallyX: NaN, rallyZ: NaN,
    stagingTimer: 0, attackOrderIssued: false,
    attackCount: 0, attackTimer: 0,
    attackTargetX: NaN, attackTargetZ: NaN,
    knownArmyX: NaN, knownArmyZ: NaN, knownArmySupply: 0,
    hasBarracks: false, hasFactory: false,
  }
}

// Two brains: one per faction
const brains: Record<number, AIBrain> = { 0: createBrain(), 1: createBrain() }

// Active brain pointer — set by current tick
let B: AIBrain = brains[1]
// Which faction this brain controls / which is the enemy
let aiFaction = 1
let enemyFaction = 0

// Legacy module-level aliases (point to active brain for existing code)
// These are reassigned each tick before any function uses them
let aiState: AIState
let aiTimer: number
let scoutEid: number | null
let scoutWaypoints: { x: number; z: number }[]
let scoutWaypointIdx: number
let knownPlayerBaseX: number; let knownPlayerBaseZ: number
let suspectedBaseX: number; let suspectedBaseZ: number
let scoutLastX: number; let scoutLastZ: number
let rallyX: number; let rallyZ: number
let stagingTimer: number; let attackOrderIssued: boolean
let attackCount: number; let attackTimer: number; let attackTargetX: number; let attackTargetZ: number
let knownArmyX: number; let knownArmyZ: number; let knownArmySupply: number
let hasBarracks: boolean; let hasFactory: boolean

/** Load brain state into module-level aliases */
function loadBrain(faction: number) {
  B = brains[faction]
  aiFaction = faction
  enemyFaction = faction === 0 ? 1 : 0
  aiState = B.state; aiTimer = B.timer
  scoutEid = B.scoutEid; scoutWaypoints = B.scoutWaypoints; scoutWaypointIdx = B.scoutWaypointIdx
  knownPlayerBaseX = B.knownEnemyBaseX; knownPlayerBaseZ = B.knownEnemyBaseZ
  suspectedBaseX = B.suspectedBaseX; suspectedBaseZ = B.suspectedBaseZ
  scoutLastX = B.scoutLastX; scoutLastZ = B.scoutLastZ
  rallyX = B.rallyX; rallyZ = B.rallyZ
  stagingTimer = B.stagingTimer; attackOrderIssued = B.attackOrderIssued
  attackCount = B.attackCount; attackTimer = B.attackTimer; attackTargetX = B.attackTargetX; attackTargetZ = B.attackTargetZ
  knownArmyX = B.knownArmyX; knownArmyZ = B.knownArmyZ; knownArmySupply = B.knownArmySupply
  hasBarracks = B.hasBarracks; hasFactory = B.hasFactory
}

/** Save module-level aliases back to brain */
function saveBrain() {
  B.state = aiState; B.timer = aiTimer
  B.scoutEid = scoutEid; B.scoutWaypoints = scoutWaypoints; B.scoutWaypointIdx = scoutWaypointIdx
  B.knownEnemyBaseX = knownPlayerBaseX; B.knownEnemyBaseZ = knownPlayerBaseZ
  B.suspectedBaseX = suspectedBaseX; B.suspectedBaseZ = suspectedBaseZ
  B.scoutLastX = scoutLastX; B.scoutLastZ = scoutLastZ
  B.rallyX = rallyX; B.rallyZ = rallyZ
  B.stagingTimer = stagingTimer; B.attackOrderIssued = attackOrderIssued
  B.attackCount = attackCount; B.attackTimer = attackTimer; B.attackTargetX = attackTargetX; B.attackTargetZ = attackTargetZ
  B.knownArmyX = knownArmyX; B.knownArmyZ = knownArmyZ; B.knownArmySupply = knownArmySupply
  B.hasBarracks = hasBarracks; B.hasFactory = hasFactory
}

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

  // Collect ALL reachable walkable points
  const all: { x: number; z: number; score: number }[] = []
  for (let x = -MAP_HALF + SCOUT_GRID_STEP / 2; x < MAP_HALF; x += SCOUT_GRID_STEP) {
    for (let z = -MAP_HALF + SCOUT_GRID_STEP / 2; z < MAP_HALF; z += SCOUT_GRID_STEP) {
      if (!isWorldWalkable(x, z)) continue
      const [gx, gz] = worldToGrid(x, z)
      const wpSector = sectorId(gx, gz)
      if (wpSector !== homeSector && !findSectorPath(homeSector, wpSector)) continue

      // Score: higher = more likely to be enemy base
      const distFromHome = Math.sqrt((x - homeX) ** 2 + (z - homeZ) ** 2)
      // Bases are typically in corners/edges, far from our base
      // Check how much walkable area surrounds this point (bases need open space)
      let walkableNeighbors = 0
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (isWorldWalkable(x + dx * 3, z + dz * 3)) walkableNeighbors++
        }
      }
      // Score: far from home + open area = likely base spot
      const openness = walkableNeighbors / 25 // 0-1
      const score = distFromHome * openness
      all.push({ x, z, score })
    }
  }

  // Sort by score: best candidates first (far + open), then fill with rest
  all.sort((a, b) => b.score - a.score)

  // Take top candidates as priority, then rest in distance order
  const priority = all.slice(0, Math.min(8, all.length))
  const rest = all.slice(8).sort((a, b) => {
    // Alternate between far and near for coverage
    const dA = (a.x - homeX) ** 2 + (a.z - homeZ) ** 2
    const dB = (b.x - homeX) ** 2 + (b.z - homeZ) ** 2
    return dB - dA // farthest first for rest
  })
  return [...priority, ...rest].map(p => ({ x: p.x, z: p.z }))
}

// ═══════════════════════════════════════════════════════════════
//  Main AI system
// ═══════════════════════════════════════════════════════════════

export function aiSystem(world: IWorld, dt: number) {
  // Always run AI for the enemy faction
  runAIForFaction(world, dt, getAIFaction())

  // In FPS mode: also run AI for the player's faction (AI vs AI + player as FPS unit)
  if (isFPSMode()) {
    runAIForFaction(world, dt, getPlayerFaction())
  }
}

function runAIForFaction(world: IWorld, dt: number, faction: number) {
  loadBrain(faction)

  aiTimer += dt
  if (aiTimer < AI_TICK) { saveBrain(); return }
  aiTimer = 0

  // ── Census: count everything ────────────────────────────────
  const census = takeCensus(world)
  if (census.commandCenter === null) {
    aiDebugStatus = `AI Faction: ${aiFaction} | NO COMMAND CENTER FOUND`
    if (aiFaction === getAIFaction()) (window as any).__aiDebugStatus = aiDebugStatus
    saveBrain()
    return
  }

  const res = gameState.getResources(aiFaction)
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
    `AI Faction: ${aiFaction} | State: ${STATE_NAMES[aiState]}`,
    `Workers:${census.workerCount} Marines:${census.marineCount} Tanks:${census.tankCount} Jeeps:${census.jeepCount} Troopers:${census.trooperCount}`,
    `Army supply: ${armySupply} | CC:${census.commandCenter !== null ? 'Y' : 'N'} Rax:${hasBarracks ? 'Y' : 'N'} Fac:${hasFactory ? 'Y' : 'N'}`,
    `Min:${Math.floor(res.minerals)} Gas:${Math.floor(res.gas)} Sup:${res.supplyCurrent}/${res.supplyMax}`,
    `Player base: ${hasFoundPlayerBase() ? `(${Math.round(knownPlayerBaseX)}, ${Math.round(knownPlayerBaseZ)})` : 'unknown'} | Attacks: ${attackCount}`,
    knownArmySupply >= 4 ? `Player army: ${knownArmySupply} supply @ (${Math.round(knownArmyX)}, ${Math.round(knownArmyZ)})` : '',
  ]
  if (decisions.length > 0) lines.push('> ' + decisions.join(' | '))
  aiDebugStatus = lines.filter(l => l).join('\n')
  // Only show debug for the enemy AI (not player's AI in FPS mode)
  if (aiFaction === getAIFaction()) {
    ;(window as any).__aiDebugStatus = aiDebugStatus
  }
  saveBrain()
}

// ═══════════════════════════════════════════════════════════════
//  State transitions
// ═══════════════════════════════════════════════════════════════

function transitionTo(state: AIState) {
  aiState = state
  stagingTimer = 0
  attackOrderIssued = false
  attackTimer = 0
}

function hasFoundPlayerBase(): boolean {
  return !isNaN(knownPlayerBaseX)
}

/** Reset AI state — call after team swap so AI re-evaluates from scratch */
export function resetAIState(world?: IWorld) {
  // Reset the AI brain for the current AI faction
  const f = getAIFaction()
  brains[f] = createBrain()
  loadBrain(f)

  if (world) {
    analyzeInheritedState(world)
  } else {
    aiState = AIState.SCOUTING
  }
  saveBrain()
}

/** After team swap: check fog, find enemy base, assess force, pick correct state */
function analyzeInheritedState(world: IWorld) {
  // 1. Take census of new faction
  const census = takeCensus(world)
  console.log(`[AI] analyzeInheritedState: faction=${aiFaction} CC=${census.commandCenter} army=${census.armySupply} workers=${census.workerCount} rax=${hasBarracks} fac=${hasFactory}`)

  if (census.commandCenter === null) {
    aiState = AIState.SCOUTING
    console.log('[AI] No CC found, starting SCOUTING')
    return
  }

  // 2. Check if enemy base is already visible/known via fog
  const found = tryDiscoverPlayerBase(world)
  console.log(`[AI] Enemy base found: ${found} at (${Math.round(knownPlayerBaseX)}, ${Math.round(knownPlayerBaseZ)})`)

  // 3. Decide starting state based on situation
  if (found) {
    if (census.armySupply >= MIN_ATTACK_ARMY) {
      const homeX = Position.x[census.commandCenter]
      const homeZ = Position.z[census.commandCenter]
      computeRallyPoint(world, homeX, homeZ)
      aiState = AIState.STAGING
    } else {
      aiState = AIState.BUILDING
    }
  } else {
    aiState = AIState.SCOUTING
  }
  console.log(`[AI] Starting state: ${STATE_NAMES[aiState]}`)
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
    // Scout died or lost — remember last known position as suspected enemy location
    if (scoutEid !== null && !isNaN(scoutLastX)) {
      suspectedBaseX = scoutLastX
      suspectedBaseZ = scoutLastZ
      decisions.push(`Scout lost near (${Math.round(scoutLastX)}, ${Math.round(scoutLastZ)}) — suspected enemy area`)
    }
    scoutEid = pickScout(world, census)
  }

  // If we have a suspected base location, send army to investigate first
  if (!isNaN(suspectedBaseX) && census.armySupply >= 3) {
    // Send available combat units to check the suspected location
    for (const eid of census.combatUnits) {
      if (hasComponent(world, AttackTarget, eid)) continue
      if (hasComponent(world, MoveTarget, eid)) continue
      sendAttackMoveTo(world, eid, suspectedBaseX + aiRng() * 6 - 3, suspectedBaseZ + aiRng() * 6 - 3)
    }
    decisions.push(`Investigating suspected base @ (${Math.round(suspectedBaseX)}, ${Math.round(suspectedBaseZ)})`)
    suspectedBaseX = NaN // only send once
    suspectedBaseZ = NaN
    return
  }

  if (!scoutEid) {
    decisions.push('No scout available — building army')
    return
  }

  // Track scout position for death detection
  scoutLastX = Position.x[scoutEid]
  scoutLastZ = Position.z[scoutEid]

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
  if (Faction.id[eid] !== aiFaction) return false
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
    if (Faction.id[eid] !== enemyFaction) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (hasComponent(world, WorkerC, eid)) continue
    // Check if visible in AI's fog of war
    const px = Position.x[eid], pz = Position.z[eid]
    if (!isVisibleAt(px, pz, aiFaction)) continue
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
      const rx = rallyX + (aiRng() - 0.5) * 6
      const rz = rallyZ + (aiRng() - 0.5) * 6
      sendAttackMoveTo(world, eid, rx, rz)
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
  attackTimer += AI_TICK

  // Refresh player base location -- they might have expanded
  tryDiscoverPlayerBase(world)

  // Use the pre-computed attack target (army or base)
  let targetX = !isNaN(attackTargetX) ? attackTargetX : (hasFoundPlayerBase() ? knownPlayerBaseX : -MAP_HALF + 20)
  let targetZ = !isNaN(attackTargetZ) ? attackTargetZ : (hasFoundPlayerBase() ? knownPlayerBaseZ : -MAP_HALF + 20)

  // Re-scan player army — if we were targeting army and it moved, update target
  scanPlayerArmy(world)
  if (knownArmySupply >= 4) {
    targetX = knownArmyX
    targetZ = knownArmyZ
  }

  if (!attackOrderIssued) {
    const force = selectAttackForce(world, census)
    sendGroupAttackMove(world, force, targetX, targetZ)
    attackOrderIssued = true
    attackCount++
    attackTimer = 0
    const targetType = knownArmySupply >= 4 ? 'army' : 'base'
    decisions.push(`Attack #${attackCount} (${targetType}): ${force.length} units → (${Math.round(targetX)}, ${Math.round(targetZ)})`)
  }

  // Re-issue orders to idle units every few ticks (stuck recovery)
  let idleCount = 0
  const force = selectAttackForce(world, census)
  for (const eid of force) {
    const hasOrders = hasComponent(world, MoveTarget, eid)
      || hasComponent(world, PathFollower, eid)
      || hasComponent(world, AttackTarget, eid)
    if (!hasOrders) idleCount++
  }

  if (idleCount > 0 && force.length > 0) {
    // Re-send idle units to attack target
    for (const eid of force) {
      const hasOrders = hasComponent(world, MoveTarget, eid)
        || hasComponent(world, PathFollower, eid)
        || hasComponent(world, AttackTarget, eid)
      if (!hasOrders) {
        sendAttackMoveTo(world, eid, targetX + aiRng() * 8 - 4, targetZ + aiRng() * 8 - 4)
      }
    }
    decisions.push(`Re-sent ${idleCount} idle units`)
  }

  // Check if attack is spent
  if (census.armySupply <= 2) {
    decisions.push('Attack spent, rebuilding')
    attackTimer = 0
    transitionTo(AIState.BUILDING)
    return
  }

  // Attack timeout — if stuck for too long, give up and rebuild
  if (attackTimer > 60) {
    decisions.push('Attack timed out, rebuilding')
    attackTimer = 0
    transitionTo(AIState.BUILDING)
    return
  }

  decisions.push(`Attacking with ${census.combatUnits.length} units (${census.armySupply} supply) [${Math.round(attackTimer)}s] idle:${idleCount}`)
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
    if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== enemyFaction) continue
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
  if (census.commandCenter !== null && census.workerCount < 8 && res.supplyCurrent < res.supplyMax) {
    const def = UNIT_DEFS[UT_WORKER]
    if (gameState.canAfford(aiFaction, def.cost)) {
      queueProduction(census.commandCenter, UT_WORKER)
      decisions.push('+Worker')
    }
  }

  // ── Supply depots ──────────────────────────────────────────
  if (res.supplyMax - res.supplyCurrent < 5 && census.commandCenter !== null) {
    const def = BUILDING_DEFS[BT_SUPPLY_DEPOT]
    if (gameState.canAfford(aiFaction, def.cost)) {
      const spot = findBuildSpot(world, homeX, homeZ, def.radius ?? 3)
      if (spot) {
        spawnBuilding(world, BT_SUPPLY_DEPOT, aiFaction, spot.x, spot.z, true)
        gameState.spend(aiFaction, def.cost)
      }
    }
  }

  // ── Barracks ───────────────────────────────────────────────
  if (!hasBarracks && census.commandCenter !== null) {
    const def = BUILDING_DEFS[BT_BARRACKS]
    if (gameState.canAfford(aiFaction, def.cost)) {
      const spot = findBuildSpot(world, homeX, homeZ, def.radius ?? 1.5)
      if (spot) {
        spawnBuilding(world, BT_BARRACKS, aiFaction, spot.x, spot.z, true)
        gameState.spend(aiFaction, def.cost)
        decisions.push('+Barracks')
      }
    }
  }

  // ── Factory (after some marines) ───────────────────────────
  if (!hasFactory && hasBarracks && census.marineCount >= 3 && census.commandCenter !== null) {
    const def = BUILDING_DEFS[BT_FACTORY]
    if (gameState.canAfford(aiFaction, def.cost)) {
      const spot = findBuildSpot(world, homeX, homeZ, def.radius ?? 1.8)
      if (spot) {
        spawnBuilding(world, BT_FACTORY, aiFaction, spot.x, spot.z, true)
        gameState.spend(aiFaction, def.cost)
        decisions.push('+Factory')
      }
    }
  }

  // ── Army production ────────────────────────────────────────
  // During ATTACKING state, don't produce (all-in). Otherwise, build army.
  if (aiState !== AIState.ATTACKING) {
    // Barracks: marines and troopers
    if (census.barracks !== null && res.supplyCurrent < res.supplyMax) {
      if (census.marineCount < 10) {
        const def = UNIT_DEFS[UT_MARINE]
        if (gameState.canAfford(aiFaction, def.cost)) {
          queueProduction(census.barracks, UT_MARINE)
        }
      } else if (census.trooperCount < 4) {
        const def = UNIT_DEFS[UT_TROOPER]
        if (gameState.canAfford(aiFaction, def.cost)) {
          queueProduction(census.barracks, UT_TROOPER)
        }
      }
    }

    // Factory: balanced ratio — 2 jeeps : 1 tank : 1 rocket
    if (census.factory !== null && res.supplyCurrent < res.supplyMax) {
      // Pick what's most needed for balance
      const needJeep = census.jeepCount < census.tankCount * 2 + 2
      const needRocket = census.rocketCount < census.tankCount + 1
      const needTank = census.tankCount < 4

      if (needJeep) {
        const def = UNIT_DEFS[UT_JEEP]
        if (gameState.canAfford(aiFaction, def.cost)) {
          queueProduction(census.factory, UT_JEEP)
        }
      } else if (needTank) {
        const def = UNIT_DEFS[UT_TANK]
        if (gameState.canAfford(aiFaction, def.cost)) {
          queueProduction(census.factory, UT_TANK)
        }
      } else if (needRocket) {
        const def = UNIT_DEFS[UT_ROCKET]
        if (gameState.canAfford(aiFaction, def.cost)) {
          queueProduction(census.factory, UT_ROCKET)
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Smart building placement — avoid blocking worker paths
// ═══════════════════════════════════════════════════════════════

function findBuildSpot(world: IWorld, homeX: number, homeZ: number, buildRadius: number): { x: number; z: number } | null {
  // Find mineral positions near home to avoid blocking paths
  const mineralPositions: { x: number; z: number }[] = []
  const _near: number[] = []
  spatialHash.query(homeX, homeZ, 25, _near)
  for (const eid of _near) {
    if (!hasComponent(world, ResourceNode, eid)) continue
    if (hasComponent(world, Dead, eid)) continue
    mineralPositions.push({ x: Position.x[eid], z: Position.z[eid] })
  }

  // Try spots in expanding rings around home, skip mineral paths
  const spacing = buildRadius + 2.0 // extra clearance
  let bestSpot: { x: number; z: number } | null = null
  let bestScore = -Infinity

  for (let ring = 2; ring <= 6; ring++) {
    const dist = ring * 3
    for (let a = 0; a < 12; a++) {
      const angle = (a / 12) * Math.PI * 2 + ring * 0.5 // offset each ring
      const sx = homeX + Math.cos(angle) * dist
      const sz = homeZ + Math.sin(angle) * dist

      // Must be walkable
      if (!isWorldWalkable(sx, sz)) continue

      // Check clearance: no overlap with existing buildings/resources
      let blocked = false
      spatialHash.query(sx, sz, spacing + 2, _near)
      for (const eid of _near) {
        if (!hasComponent(world, IsBuilding, eid) && !hasComponent(world, ResourceNode, eid)) continue
        if (hasComponent(world, Dead, eid)) continue
        const dx = Position.x[eid] - sx, dz = Position.z[eid] - sz
        const d = Math.sqrt(dx * dx + dz * dz)
        const otherR = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 1.5
        if (d < spacing + otherR) { blocked = true; break }
      }
      if (blocked) continue

      // Hard block: skip if spot is in the corridor between CC and any mineral/gas
      const CORRIDOR_WIDTH = buildRadius + 3.0 // wide enough for units + building footprint
      let inCorridor = false
      for (const m of mineralPositions) {
        const mx = m.x - homeX, mz = m.z - homeZ
        const mLen = Math.sqrt(mx * mx + mz * mz) || 1
        const mnx = mx / mLen, mnz = mz / mLen
        // Project spot onto mineral line
        const px = sx - homeX, pz = sz - homeZ
        const proj = px * mnx + pz * mnz
        if (proj > -2 && proj < mLen + 2) {
          const perpDist = Math.abs(px * (-mnz) + pz * mnx)
          if (perpDist < CORRIDOR_WIDTH) { inCorridor = true; break }
        }
      }
      if (inCorridor) continue

      // Prefer closer spots (negative dist = closer is better)
      const score = -dist
      if (score > bestScore) {
        bestScore = score
        bestSpot = { x: sx, z: sz }
      }
    }
  }
  return bestSpot
}

// ═══════════════════════════════════════════════════════════════
//  Player base discovery
// ═══════════════════════════════════════════════════════════════

function tryDiscoverPlayerBase(world: IWorld): boolean {
  const pBuildings = playerBuildingQuery(world)
  for (const eid of pBuildings) {
    if (Faction.id[eid] !== enemyFaction) continue
    if (hasComponent(world, Dead, eid)) continue

    const bx = Position.x[eid]
    const bz = Position.z[eid]

    // Check if the building is visible in the AI faction's fog of war
    if (isVisibleAt(bx, bz, aiFaction)) {
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
    if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== enemyFaction) continue
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
  const homeX = census.commandCenter !== null ? Position.x[census.commandCenter] : 0
  const homeZ = census.commandCenter !== null ? Position.z[census.commandCenter] : 0

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
  rocketCount: number
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
    if (Faction.id[eid] !== aiFaction) continue
    if (hasComponent(world, Dead, eid)) continue
    const ut = UnitTypeC.id[eid]
    if (ut === BT_COMMAND_CENTER) commandCenter = eid
    if (ut === BT_BARRACKS) { barracks = eid; hasBarracks = true }
    if (ut === BT_FACTORY) { factory = eid; hasFactory = true }
  }

  const fpsUnit = isFPSMode() ? getFPSEntity() : -1

  let workerCount = 0
  let marineCount = 0
  let tankCount = 0
  let jeepCount = 0
  let rocketCount = 0
  let trooperCount = 0
  const combatUnits: number[] = []
  const workers: number[] = []
  let armySupply = 0

  const units = enemyUnitQuery(world)
  for (const eid of units) {
    if (Faction.id[eid] !== aiFaction) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (eid === fpsUnit) continue // FPS unit is player-controlled

    const ut = UnitTypeC.id[eid]
    switch (ut) {
      case UT_WORKER: workerCount++; workers.push(eid); break
      case UT_MARINE: marineCount++; combatUnits.push(eid); armySupply += 1; break
      case UT_TANK:   tankCount++;   combatUnits.push(eid); armySupply += 3; break
      case UT_JEEP:   jeepCount++;   combatUnits.push(eid); armySupply += 2; break
      case UT_ROCKET: rocketCount++; combatUnits.push(eid); armySupply += 4; break
      case UT_TROOPER: trooperCount++; combatUnits.push(eid); armySupply += 2; break
      default:                        combatUnits.push(eid); armySupply += 1; break
    }
  }

  return {
    commandCenter, barracks, factory,
    workerCount, marineCount, tankCount, jeepCount, rocketCount, trooperCount,
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
      if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== enemyFaction) continue
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
    if (Faction.id[eid] !== aiFaction) continue
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
