import { addEntity, addComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Rotation, Velocity, Faction, UnitTypeC, Health, AttackC,
  MoveSpeed, Armor, Selectable, MeshRef, CollisionRadius,
  WorkerC, ResourceDropoff, IsBuilding, BuildProgress, Producer,
  SupplyProvider, SupplyCost, ResourceNode, Projectile, Selected,
  ArcProjectile, TurnRate, Acceleration, MaxSlope, CurrentSpeed, StuckState,
} from './components'
import {
  UNIT_DEFS, BUILDING_DEFS, FACTION_PLAYER, UT_WORKER,
  type UnitDef, type BuildingDef,
} from '../game/config'
import { getPool, getFactionColor, editorConfig } from '../render/meshPools'
import { getAnimManager } from '../render/animatedMeshManager'
import { spatialHash } from '../globals'
import { getTerrainHeight } from '../terrain/heightmap'
import { blockCells } from '../pathfinding/navGrid'

// Map unit meshPool IDs → editor config keys
const UNIT_POOL_TO_KEY: Record<number, string> = { 0: 'worker', 1: 'marine', 2: 'tank' }

/** Read a stat from editorConfig (if available), falling back to UnitDef value */
function cfgStat(def: UnitDef, key: string): number {
  const cfgKey = UNIT_POOL_TO_KEY[def.meshPool]
  const val = cfgKey ? editorConfig?.[cfgKey]?.[key] : undefined
  return val ?? (def as any)[key]
}

export function spawnUnit(
  world: IWorld,
  unitType: number,
  faction: number,
  x: number,
  z: number,
): number {
  const def = UNIT_DEFS[unitType]
  if (!def) throw new Error(`Unknown unit type: ${unitType}`)

  const eid = addEntity(world)

  // Animated GLB models have feet at Y=0, no offset needed
  const y = getTerrainHeight(x, z)

  addComponent(world, Position, eid)
  Position.x[eid] = x
  Position.y[eid] = y
  Position.z[eid] = z

  addComponent(world, Rotation, eid)
  Rotation.y[eid] = 0

  addComponent(world, Velocity, eid)

  addComponent(world, Faction, eid)
  Faction.id[eid] = faction

  addComponent(world, UnitTypeC, eid)
  UnitTypeC.id[eid] = unitType

  // All stats: read from editorConfig (persistent volume) → fallback to code defaults
  addComponent(world, Health, eid)
  Health.current[eid] = cfgStat(def, 'hp')
  Health.max[eid] = cfgStat(def, 'hp')

  addComponent(world, MoveSpeed, eid)
  MoveSpeed.value[eid] = cfgStat(def, 'speed')

  addComponent(world, TurnRate, eid)
  TurnRate.value[eid] = cfgStat(def, 'turnRate')

  addComponent(world, Acceleration, eid)
  Acceleration.value[eid] = cfgStat(def, 'acceleration')

  addComponent(world, MaxSlope, eid)
  MaxSlope.value[eid] = cfgStat(def, 'maxSlope')

  addComponent(world, CurrentSpeed, eid)
  CurrentSpeed.value[eid] = 0

  addComponent(world, StuckState, eid)
  StuckState.phase[eid] = 0
  StuckState.timer[eid] = 0

  addComponent(world, Armor, eid)
  Armor.value[eid] = cfgStat(def, 'armor')

  addComponent(world, Selectable, eid)
  Selectable.radius[eid] = cfgStat(def, 'selectionRadius') ?? def.radius

  addComponent(world, CollisionRadius, eid)
  CollisionRadius.value[eid] = cfgStat(def, 'collisionRadius') ?? def.radius

  addComponent(world, SupplyCost, eid)
  SupplyCost.amount[eid] = def.supply

  if (def.attack) {
    addComponent(world, AttackC, eid)
    AttackC.damage[eid] = cfgStat(def, 'damage') ?? def.attack.damage
    AttackC.range[eid] = cfgStat(def, 'range') ?? def.attack.range
    AttackC.cooldown[eid] = cfgStat(def, 'cooldown') ?? def.attack.cooldown
    AttackC.timer[eid] = 0
    AttackC.splash[eid] = cfgStat(def, 'splash') ?? def.attack.splash ?? 0
  }

  if (unitType === UT_WORKER) {
    addComponent(world, WorkerC, eid)
    WorkerC.state[eid] = 0 // idle
  }

  // Rendering
  addComponent(world, MeshRef, eid)
  MeshRef.poolId[eid] = def.meshPool

  const color = getFactionColor(faction, false)

  // Try animated manager first (unit pools 0-2), fallback to instanced pool
  const animMgr = getAnimManager(def.meshPool)
  if (animMgr) {
    animMgr.add(eid, x, y, z, 0, color)
    MeshRef.instanceIdx[eid] = 0
  } else {
    const pool = getPool(def.meshPool)
    if (pool) {
      const idx = pool.add(eid, x, y, z, 0, color)
      MeshRef.instanceIdx[eid] = idx
    }
  }

  // Spatial hash
  spatialHash.insert(eid, x, z)

  return eid
}

export function spawnBuilding(
  world: IWorld,
  buildingType: number,
  faction: number,
  x: number,
  z: number,
  preBuilt = false,
): number {
  const def = BUILDING_DEFS[buildingType]
  if (!def) throw new Error(`Unknown building type: ${buildingType}`)

  const eid = addEntity(world)

  const terrainY = getTerrainHeight(x, z)
  const buildingY = preBuilt ? terrainY + def.radius * 0.5 : terrainY + 0.1

  addComponent(world, Position, eid)
  Position.x[eid] = x
  Position.y[eid] = buildingY
  Position.z[eid] = z

  addComponent(world, Rotation, eid)
  addComponent(world, Faction, eid)
  Faction.id[eid] = faction

  addComponent(world, UnitTypeC, eid)
  UnitTypeC.id[eid] = buildingType

  addComponent(world, Health, eid)
  Health.current[eid] = preBuilt ? def.hp : def.hp * 0.1

  // Block navigation grid
  blockCells(x, z, def.radius)
  Health.max[eid] = def.hp

  addComponent(world, Armor, eid)
  Armor.value[eid] = def.armor

  addComponent(world, Selectable, eid)
  Selectable.radius[eid] = def.radius

  addComponent(world, CollisionRadius, eid)
  CollisionRadius.value[eid] = def.radius

  addComponent(world, IsBuilding, eid)

  if (!preBuilt) {
    addComponent(world, BuildProgress, eid)
    BuildProgress.progress[eid] = 0
    BuildProgress.duration[eid] = def.buildTime
  }

  if (def.supply) {
    addComponent(world, SupplyProvider, eid)
    SupplyProvider.amount[eid] = def.supply
  }

  if (def.canProduce) {
    addComponent(world, Producer, eid)
    Producer.active[eid] = 0
    Producer.rallyX[eid] = x + def.radius + 2
    Producer.rallyZ[eid] = z
  }

  if (def.isDropoff) {
    addComponent(world, ResourceDropoff, eid)
  }

  if (def.attack) {
    addComponent(world, AttackC, eid)
    AttackC.damage[eid] = def.attack.damage
    AttackC.range[eid] = def.attack.range
    AttackC.cooldown[eid] = def.attack.cooldown
    AttackC.timer[eid] = 0
  }

  // Rendering
  addComponent(world, MeshRef, eid)
  MeshRef.poolId[eid] = def.meshPool

  const pool = getPool(def.meshPool)
  if (pool) {
    const color = getFactionColor(faction, true)
    const y = buildingY
    const idx = pool.add(eid, x, y, z, 0, color)
    MeshRef.instanceIdx[eid] = idx
  }

  spatialHash.insert(eid, x, z)

  return eid
}

export function spawnResourceNode(
  world: IWorld,
  type: number, // 0=mineral, 1=gas
  x: number,
  z: number,
  amount = 1500,
): number {
  const eid = addEntity(world)

  const resY = getTerrainHeight(x, z) + (type === 0 ? 0.8 : 0.6)

  addComponent(world, Position, eid)
  Position.x[eid] = x
  Position.y[eid] = resY
  Position.z[eid] = z

  addComponent(world, Rotation, eid)
  addComponent(world, ResourceNode, eid)
  ResourceNode.type[eid] = type
  ResourceNode.amount[eid] = amount

  addComponent(world, Selectable, eid)
  Selectable.radius[eid] = 0.8

  addComponent(world, CollisionRadius, eid)
  CollisionRadius.value[eid] = 0.8

  // Rendering
  addComponent(world, MeshRef, eid)
  const poolId = type === 0 ? 20 : 21
  MeshRef.poolId[eid] = poolId

  const pool = getPool(poolId)
  if (pool) {
    const idx = pool.add(eid, x, resY, z, Math.random() * Math.PI * 2)
    MeshRef.instanceIdx[eid] = idx
  }

  spatialHash.insert(eid, x, z)

  return eid
}

export function spawnProjectile(
  world: IWorld,
  fromX: number,
  fromZ: number,
  targetEid: number,
  damage: number,
): number {
  const eid = addEntity(world)

  addComponent(world, Position, eid)
  Position.x[eid] = fromX
  Position.y[eid] = 1.0
  Position.z[eid] = fromZ

  addComponent(world, Projectile, eid)
  Projectile.targetEid[eid] = targetEid
  Projectile.damage[eid] = damage
  Projectile.speed[eid] = 25

  addComponent(world, MeshRef, eid)
  MeshRef.poolId[eid] = 30

  const pool = getPool(30)
  if (pool) {
    const idx = pool.add(eid, fromX, 1.0, fromZ, 0)
    MeshRef.instanceIdx[eid] = idx
  }

  return eid
}

export function spawnArcProjectile(
  world: IWorld,
  fromX: number,
  fromZ: number,
  targetEid: number,
  damage: number,
  splash: number,
): number {
  const eid = addEntity(world)
  const fromY = getTerrainHeight(fromX, fromZ) + 2.0

  addComponent(world, Position, eid)
  Position.x[eid] = fromX
  Position.y[eid] = fromY
  Position.z[eid] = fromZ

  const tx = Position.x[targetEid]
  const tz = Position.z[targetEid]
  const dx = tx - fromX
  const dz = tz - fromZ
  const dist = Math.sqrt(dx * dx + dz * dz)

  addComponent(world, ArcProjectile, eid)
  ArcProjectile.startX[eid] = fromX
  ArcProjectile.startZ[eid] = fromZ
  ArcProjectile.targetX[eid] = tx
  ArcProjectile.targetZ[eid] = tz
  ArcProjectile.elapsed[eid] = 0
  ArcProjectile.duration[eid] = Math.max(0.6, dist / 15) // flight time based on distance
  ArcProjectile.arcHeight[eid] = Math.max(4, dist * 0.4) // higher arc for longer distance
  ArcProjectile.damage[eid] = damage
  ArcProjectile.splash[eid] = splash
  ArcProjectile.targetEid[eid] = targetEid

  // Use pool 31 for tank shells (we'll register it)
  addComponent(world, MeshRef, eid)
  MeshRef.poolId[eid] = 31

  const pool = getPool(31)
  if (pool) {
    const idx = pool.add(eid, fromX, fromY, fromZ, 0)
    MeshRef.instanceIdx[eid] = idx
  }

  return eid
}

/** Obstacle types: 22=rock, 23=tree, 24=boulder, 25=cliff_rock */
// Map pool IDs to editor config keys for obstacles
const OBSTACLE_POOL_TO_KEY: Record<number, string> = {
  22: 'rock1', 23: 'tree1', 24: 'boulder', 25: 'rock2',
}

export function spawnObstacle(
  world: IWorld,
  poolId: number,
  x: number,
  z: number,
  blockRadius?: number,
): number {
  const eid = addEntity(world)
  const y = getTerrainHeight(x, z)

  addComponent(world, Position, eid)
  Position.x[eid] = x
  Position.y[eid] = y
  Position.z[eid] = z

  addComponent(world, Rotation, eid)
  Rotation.y[eid] = Math.random() * Math.PI * 2

  addComponent(world, MeshRef, eid)
  MeshRef.poolId[eid] = poolId

  const pool = getPool(poolId)
  if (pool) {
    const idx = pool.add(eid, x, y, z, Rotation.y[eid])
    MeshRef.instanceIdx[eid] = idx
  }

  // Block radius: editor config > explicit param > auto-calculate from model scale
  const cfgKey = OBSTACLE_POOL_TO_KEY[poolId]
  const cfgEntry = cfgKey ? editorConfig?.[cfgKey] : null
  const radius = blockRadius
    ?? cfgEntry?.collisionRadius
    ?? (cfgEntry?.scale ? cfgEntry.scale * 0.4 : 0.8)

  blockCells(x, z, radius)

  return eid
}
