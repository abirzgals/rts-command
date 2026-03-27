// ── Resource types ───────────────────────────────────────────
export const RES_MINERALS = 0
export const RES_GAS = 1

// ── Faction IDs ─────────────────────────────────────────────
export const FACTION_PLAYER = 0
export const FACTION_ENEMY = 1

// ── Unit type IDs ───────────────────────────────────────────
export const UT_WORKER = 0
export const UT_MARINE = 1
export const UT_TANK = 2

// ── Building type IDs (offset by 100 to distinguish) ────────
export const BT_COMMAND_CENTER = 100
export const BT_SUPPLY_DEPOT = 101
export const BT_BARRACKS = 102
export const BT_FACTORY = 103

export interface UnitDef {
  name: string
  hp: number
  speed: number
  armor: number
  attack?: { damage: number; range: number; cooldown: number; splash?: number }
  radius: number       // collision/selection radius
  supply: number       // supply cost
  cost: { minerals: number; gas: number }
  buildTime: number    // seconds
  meshPool: number     // which mesh pool to use
}

export interface BuildingDef {
  name: string
  hp: number
  armor: number
  radius: number
  supply?: number      // supply provided
  canProduce?: number[] // unit types this building can produce
  isDropoff?: boolean
  cost: { minerals: number; gas: number }
  buildTime: number
  meshPool: number
  attack?: { damage: number; range: number; cooldown: number }
}

export const UNIT_DEFS: Record<number, UnitDef> = {
  [UT_WORKER]: {
    name: 'Worker',
    hp: 40, speed: 3.5, armor: 0, radius: 0.4, supply: 1,
    attack: { damage: 5, range: 1.2, cooldown: 1.5 },
    cost: { minerals: 50, gas: 0 }, buildTime: 12,
    meshPool: 0,
  },
  [UT_MARINE]: {
    name: 'Marine',
    hp: 55, speed: 3.0, armor: 0, radius: 0.4, supply: 1,
    attack: { damage: 8, range: 6, cooldown: 0.8 },
    cost: { minerals: 50, gas: 0 }, buildTime: 18,
    meshPool: 1,
  },
  [UT_TANK]: {
    name: 'Tank',
    hp: 160, speed: 2.0, armor: 2, radius: 1.2, supply: 3,
    attack: { damage: 30, range: 8, cooldown: 2.5, splash: 1.5 },
    cost: { minerals: 150, gas: 75 }, buildTime: 30,
    meshPool: 2,
  },
}

export const BUILDING_DEFS: Record<number, BuildingDef> = {
  [BT_COMMAND_CENTER]: {
    name: 'Command Center',
    hp: 1500, armor: 1, radius: 2.0,
    supply: 15, canProduce: [UT_WORKER], isDropoff: true,
    cost: { minerals: 400, gas: 0 }, buildTime: 60,
    meshPool: 10,
  },
  [BT_SUPPLY_DEPOT]: {
    name: 'Supply Depot',
    hp: 400, armor: 0, radius: 1.2,
    supply: 10,
    cost: { minerals: 100, gas: 0 }, buildTime: 20,
    meshPool: 11,
  },
  [BT_BARRACKS]: {
    name: 'Barracks',
    hp: 800, armor: 1, radius: 1.5,
    canProduce: [UT_MARINE],
    cost: { minerals: 150, gas: 0 }, buildTime: 40,
    meshPool: 12,
  },
  [BT_FACTORY]: {
    name: 'Factory',
    hp: 1000, armor: 1, radius: 1.8,
    canProduce: [UT_TANK],
    cost: { minerals: 200, gas: 100 }, buildTime: 50,
    meshPool: 13,
  },
}

// Map dimensions
export const MAP_SIZE = 200
export const MAP_HALF = MAP_SIZE / 2
