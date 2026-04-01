import * as THREE from 'three'
import { addEntity, addComponent, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Rotation, Velocity, Faction, UnitTypeC, Health, AttackC,
  MoveSpeed, Armor, Selectable, MeshRef, CollisionRadius,
  WorkerC, ResourceDropoff, IsBuilding, BuildProgress, Producer,
  SupplyProvider, SupplyCost, ResourceNode, Projectile, Selected,
  ArcProjectile, TurnRate, Acceleration, MaxSlope, CurrentSpeed, StuckState, UnitMode, SightRadius,
} from './components'
import {
  UNIT_DEFS, BUILDING_DEFS, FACTION_PLAYER, UT_WORKER,
  type UnitDef, type BuildingDef,
} from '../game/config'
import { getPool, getFactionColor, editorConfig, getScene } from '../render/meshPools'
import { getAnimManager } from '../render/animatedMeshManager'
import { spatialHash } from '../globals'
import { getTerrainHeight } from '../terrain/heightmap'
import { blockCells } from '../pathfinding/navGrid'
import { createResourceEffect } from '../render/effects'

// Map unit meshPool IDs → editor config keys
const UNIT_POOL_TO_KEY: Record<number, string> = { 0: 'worker', 1: 'marine', 2: 'tank', 3: 'jeep', 4: 'rocket', 5: 'trooper' }

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

  addComponent(world, UnitMode, eid)
  UnitMode.mode[eid] = 0 // default: move

  // Sight radius: from editor config, or 1.3x attack range, minimum 8
  addComponent(world, SightRadius, eid)
  const cfgVision = cfgStat(def, 'visionRadius')
  if (cfgVision && cfgVision > 0) {
    SightRadius.value[eid] = cfgVision
  } else {
    const atkRange = def.attack ? cfgStat(def, 'range') ?? def.attack.range : 0
    SightRadius.value[eid] = Math.max(8, atkRange * 1.3)
  }

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
    const burst = cfgStat(def, 'burstSize') ?? 1
    AttackC.burstSize[eid] = burst
    AttackC.burstDelay[eid] = cfgStat(def, 'burstDelay') ?? 0.2
    AttackC.burstRemaining[eid] = burst
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
  const buildingY = preBuilt ? terrainY : terrainY

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

  // Sight radius for buildings
  addComponent(world, SightRadius, eid)
  SightRadius.value[eid] = def.attack ? Math.max(12, def.attack.range * 1.3) : 12

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

  const resY = getTerrainHeight(x, z)

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

  // Ambient glow + sparkle/steam particles
  createResourceEffect(x, resY, z, type)

  spatialHash.insert(eid, x, z)

  return eid
}

// Track individual projectile meshes — updated by projectileSystem, cleaned on death
export const projectileMeshes = new Map<number, THREE.Object3D>()
const projMatCache = new Map<string, THREE.Material>()
const shellGeo = new THREE.SphereGeometry(1, 8, 6) // shared, scaled per-shell
const rocketGeo = new THREE.CylinderGeometry(0.5, 0.8, 3, 6) // elongated, scaled

// Store per-projectile effect configs (impact, explosion) — read on hit
export interface ProjectileEffectCfg {
  impact?: { color?: string; size?: number; particles?: number; lifetime?: number }
  explosion?: { colors?: string[]; radius?: number; particles?: number }
  smoke?: { color?: string; count?: number }
}
export const projectileEffects = new Map<number, ProjectileEffectCfg>()

export function removeProjectileMesh(eid: number) {
  const obj = projectileMeshes.get(eid)
  if (obj) {
    getScene().remove(obj)
    // Dispose geometry (each tracer has unique BufferGeometry), but NOT shared materials
    if ((obj as any).geometry) (obj as any).geometry.dispose()
    projectileMeshes.delete(eid)
  }
}

export function spawnProjectile(
  world: IWorld,
  fromX: number,
  fromZ: number,
  targetEid: number,
  damage: number,
  speed = 25,
  cfg?: { color?: string; size?: number; trailFire?: number; trailSmoke?: number; type?: string },
  ownerFaction = 0xFF,
  fromY?: number,
): number {
  const eid = addEntity(world)

  // Use provided Y or default to terrain + 1.5
  const spawnY = fromY ?? (getTerrainHeight(fromX, fromZ) + 1.5)
  addComponent(world, Position, eid)
  Position.x[eid] = fromX
  Position.y[eid] = spawnY
  Position.z[eid] = fromZ

  // Compute direction toward target's CURRENT position (no homing — can miss)
  let dirX = 0, dirY = 0, dirZ = 1, maxRange = 30
  if (targetEid < 0xFFFFFFFF && hasComponent(world, Position, targetEid)) {
    const tx = Position.x[targetEid]
    const ty = Position.y[targetEid] + 1.0 // aim at center mass
    const tz = Position.z[targetEid]
    const dx = tx - fromX, dy = ty - spawnY, dz = tz - fromZ
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist > 0.01) { dirX = dx / dist; dirY = dy / dist; dirZ = dz / dist }
    maxRange = Math.max(dist + 5, 20) // overshoot a bit past target
  }

  addComponent(world, Projectile, eid)
  Projectile.targetEid[eid] = 0xFFFFFFFF // all projectiles are directional now
  Projectile.damage[eid] = damage
  Projectile.speed[eid] = speed
  Projectile.dirX[eid] = dirX
  Projectile.dirY[eid] = dirY
  Projectile.dirZ[eid] = dirZ
  Projectile.maxRange[eid] = maxRange
  Projectile.traveled[eid] = 0
  Projectile.spawnX[eid] = fromX
  Projectile.spawnY[eid] = spawnY
  Projectile.spawnZ[eid] = fromZ
  Projectile.faction[eid] = ownerFaction
  Projectile.trailFire[eid] = cfg?.trailFire ?? 0
  Projectile.trailSmoke[eid] = cfg?.trailSmoke ?? 0

  const projType = cfg?.type ?? 'bullet'
  const colorVal = cfg?.color ? parseInt(cfg.color.replace('#', ''), 16) : 0xffee44

  if (projType === 'shell') {
    // 3D sphere for tank shells
    const shellSize = cfg?.size ?? 0.2
    const matKey = `shell_${colorVal}`
    if (!projMatCache.has(matKey)) {
      projMatCache.set(matKey, new THREE.MeshBasicMaterial({ color: colorVal }))
    }
    const sphere = new THREE.Mesh(shellGeo, projMatCache.get(matKey)!)
    sphere.scale.setScalar(shellSize)
    sphere.position.set(fromX, spawnY, fromZ)
    sphere.frustumCulled = false
    getScene().add(sphere)
    projectileMeshes.set(eid, sphere)
  } else if (projType === 'rocket') {
    // Elongated capsule for rockets
    const rocketSize = cfg?.size ?? 0.15
    const matKey = `rocket_${colorVal}`
    if (!projMatCache.has(matKey)) {
      projMatCache.set(matKey, new THREE.MeshBasicMaterial({ color: colorVal }))
    }
    const rocket = new THREE.Mesh(rocketGeo, projMatCache.get(matKey)!)
    rocket.scale.set(rocketSize, rocketSize, rocketSize * 3)
    rocket.position.set(fromX, spawnY, fromZ)
    rocket.frustumCulled = false
    getScene().add(rocket)
    projectileMeshes.set(eid, rocket)
  } else {
    // Tracer line for bullets
    const matKey = `line_${colorVal}`
    if (!projMatCache.has(matKey)) {
      projMatCache.set(matKey, new THREE.LineBasicMaterial({
        color: colorVal, transparent: true, opacity: 0.8, linewidth: 1,
      }) as any)
    }
    const tracerGeo = new THREE.BufferGeometry()
    const positions = new Float32Array(6)
    positions[0] = fromX; positions[1] = spawnY; positions[2] = fromZ
    positions[3] = fromX; positions[4] = spawnY; positions[5] = fromZ
    tracerGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const tracer = new THREE.Line(tracerGeo, projMatCache.get(matKey)!)
    tracer.frustumCulled = false
    tracer.renderOrder = 10
    getScene().add(tracer)
    projectileMeshes.set(eid, tracer as any)
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
  cfgArcHeight?: number,
  trailFire = 0,
  trailSmoke = 0,
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
  ArcProjectile.duration[eid] = Math.max(0.6, dist / 15)
  ArcProjectile.arcHeight[eid] = cfgArcHeight ?? Math.max(4, dist * 0.4)
  ArcProjectile.damage[eid] = damage
  ArcProjectile.splash[eid] = splash
  ArcProjectile.targetEid[eid] = targetEid
  ArcProjectile.trailFire[eid] = trailFire
  ArcProjectile.trailSmoke[eid] = trailSmoke

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
