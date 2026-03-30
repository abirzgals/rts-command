import { defineComponent, Types } from 'bitecs'

// ── Transform ────────────────────────────────────────────────
export const Position = defineComponent({
  x: Types.f32,
  y: Types.f32,
  z: Types.f32,
})

export const Rotation = defineComponent({
  y: Types.f32, // yaw only (RTS doesn't need pitch/roll)
})

export const Velocity = defineComponent({
  x: Types.f32,
  y: Types.f32,
  z: Types.f32,
})

// ── Identity ─────────────────────────────────────────────────
export const Faction = defineComponent({
  id: Types.ui8, // 0=player, 1=enemy
})

export const UnitTypeC = defineComponent({
  id: Types.ui8, // index into UNIT_TYPES
})

// ── Combat stats ─────────────────────────────────────────────
export const Health = defineComponent({
  current: Types.f32,
  max: Types.f32,
})

export const AttackC = defineComponent({
  damage: Types.f32,
  range: Types.f32,
  cooldown: Types.f32, // seconds between attacks
  timer: Types.f32,    // time until next attack
  splash: Types.f32,   // splash radius (0 = single target)
})

export const MoveSpeed = defineComponent({
  value: Types.f32,
})

export const Armor = defineComponent({
  value: Types.f32,
})

// ── Commands ─────────────────────────────────────────────────
export const MoveTarget = defineComponent({
  x: Types.f32,
  z: Types.f32,
})

export const AttackTarget = defineComponent({
  eid: Types.ui32,
})

// ── Economy ──────────────────────────────────────────────────
export const ResourceNode = defineComponent({
  type: Types.ui8,   // 0=minerals, 1=gas
  amount: Types.f32,
})

export const WorkerC = defineComponent({
  state: Types.ui8,      // 0=idle, 1=movingToRes, 2=gathering, 3=returning, 4=movingToBuild, 5=building
  targetNode: Types.ui32, // entity ID of resource node
  carryAmount: Types.f32,
  carryType: Types.ui8,
  gatherTimer: Types.f32,
  returnTarget: Types.ui32, // entity ID of command center
  buildTarget: Types.ui32,  // entity ID of building under construction
})

export const ResourceDropoff = defineComponent() // tag

// ── Buildings & Production ───────────────────────────────────
export const IsBuilding = defineComponent() // tag

export const BuildProgress = defineComponent({
  progress: Types.f32, // 0..1
  duration: Types.f32, // total build time
  costMinerals: Types.f32, // total mineral cost (for gradual spending)
  costGas: Types.f32,      // total gas cost
  spent: Types.f32,        // fraction of cost already spent (0..1)
})

export const Producer = defineComponent({
  active: Types.ui8,    // 1 = currently producing
  unitType: Types.ui8,
  progress: Types.f32,
  duration: Types.f32,
  rallyX: Types.f32,
  rallyZ: Types.f32,
  rallyTargetEid: Types.ui32, // 0 = ground, >0 = resource node entity
})

export const SupplyProvider = defineComponent({
  amount: Types.ui8,
})

export const SupplyCost = defineComponent({
  amount: Types.ui8,
})

// ── Pathfinding ──────────────────────────────────────────────
export const PathFollower = defineComponent({
  waypointIndex: Types.ui16,
  pathId: Types.ui32,
})

// ── Rendering ────────────────────────────────────────────────
export const MeshRef = defineComponent({
  poolId: Types.ui8,
  instanceIdx: Types.i32,
})

// ── Selection ────────────────────────────────────────────────
export const Selectable = defineComponent({
  radius: Types.f32,
})

export const Selected = defineComponent() // tag

// ── Flags ────────────────────────────────────────────────────
export const Dead = defineComponent() // tag

export const Projectile = defineComponent({
  targetEid: Types.ui32,
  damage: Types.f32,
  speed: Types.f32,
  trailFire: Types.ui8,   // particles per frame (0 = off)
  trailSmoke: Types.ui8,  // particles per frame (0 = off)
})

// Artillery projectile (tank shells) — follows parabolic arc
export const ArcProjectile = defineComponent({
  startX: Types.f32,
  startZ: Types.f32,
  targetX: Types.f32,
  targetZ: Types.f32,
  elapsed: Types.f32,
  duration: Types.f32,
  arcHeight: Types.f32,
  damage: Types.f32,
  splash: Types.f32,
  targetEid: Types.ui32,
  trailFire: Types.ui8,   // particles per frame (0 = off)
  trailSmoke: Types.ui8,  // particles per frame (0 = off)
})

// ── Collision size (for spatial hash) ────────────────────────
export const CollisionRadius = defineComponent({
  value: Types.f32,
})

// When set, unit moves to MoveTarget but stops to fight enemies in range
export const AttackMove = defineComponent({
  destX: Types.f32, // remember original destination
  destZ: Types.f32,
})

// ── SupCom-style movement physics ───────────────────────────
export const TurnRate = defineComponent({
  value: Types.f32, // radians/sec — how fast unit rotates
})

export const Acceleration = defineComponent({
  value: Types.f32, // units/sec² — how fast unit speeds up
})

export const MaxSlope = defineComponent({
  value: Types.f32, // max traversable height delta between adjacent cells
})

export const CurrentSpeed = defineComponent({
  value: Types.f32, // actual current speed (distinct from MoveSpeed max)
})

// Stuck escalation: 0=normal, 1=wiggle, 2=repath, 3=stopped
export const StuckState = defineComponent({
  phase: Types.ui8,
  timer: Types.f32,
})
