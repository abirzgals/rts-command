import { FACTION_PLAYER, FACTION_ENEMY } from './config'

export interface FactionResources {
  minerals: number
  gas: number
  supplyCurrent: number
  supplyMax: number
}

export interface ProductionQueueItem {
  unitType: number
  remaining: number // seconds
}

class GameState {
  resources: Record<number, FactionResources> = {
    [FACTION_PLAYER]: { minerals: 400, gas: 0, supplyCurrent: 0, supplyMax: 0 },
    [FACTION_ENEMY]: { minerals: 400, gas: 0, supplyCurrent: 0, supplyMax: 0 },
  }

  // Production queues per building entity
  productionQueues = new Map<number, ProductionQueueItem[]>()

  // Build mode state
  buildMode: number | null = null // building type ID, or null
  buildGhost: number | null = null // temp entity for ghost

  // Camera
  cameraTarget = { x: 0, y: 0, z: 0 }

  paused = false
  gameOver = false
  winner: number | null = null

  getResources(faction: number): FactionResources {
    return this.resources[faction]
  }

  canAfford(faction: number, cost: { minerals: number; gas: number }): boolean {
    const r = this.resources[faction]
    return r.minerals >= cost.minerals && r.gas >= cost.gas
  }

  spend(faction: number, cost: { minerals: number; gas: number }) {
    const r = this.resources[faction]
    r.minerals -= cost.minerals
    r.gas -= cost.gas
  }

  addResources(faction: number, type: number, amount: number) {
    const r = this.resources[faction]
    if (type === 0) r.minerals += amount
    else r.gas += amount
  }

  getQueue(buildingEid: number): ProductionQueueItem[] {
    let q = this.productionQueues.get(buildingEid)
    if (!q) {
      q = []
      this.productionQueues.set(buildingEid, q)
    }
    return q
  }

  removeQueue(buildingEid: number) {
    this.productionQueues.delete(buildingEid)
  }
}

export const gameState = new GameState()
