/**
 * Spatial hash grid for efficient range queries.
 * Cell size should roughly match the max query range.
 */
export class SpatialHash {
  private cellSize: number
  private invCellSize: number
  private cells = new Map<number, Set<number>>()
  // Track each entity's cell key for fast removal
  private entityCells = new Map<number, number>()

  constructor(cellSize = 10) {
    this.cellSize = cellSize
    this.invCellSize = 1 / cellSize
  }

  private key(cx: number, cz: number): number {
    // Cantor pairing shifted to handle negatives
    const a = cx + 10000
    const b = cz + 10000
    return a * 20001 + b
  }

  private cellCoord(v: number): number {
    return Math.floor(v * this.invCellSize)
  }

  insert(eid: number, x: number, z: number) {
    const cx = this.cellCoord(x)
    const cz = this.cellCoord(z)
    const k = this.key(cx, cz)

    let cell = this.cells.get(k)
    if (!cell) {
      cell = new Set()
      this.cells.set(k, cell)
    }
    cell.add(eid)
    this.entityCells.set(eid, k)
  }

  remove(eid: number) {
    const k = this.entityCells.get(eid)
    if (k !== undefined) {
      const cell = this.cells.get(k)
      if (cell) {
        cell.delete(eid)
        if (cell.size === 0) this.cells.delete(k)
      }
      this.entityCells.delete(eid)
    }
  }

  update(eid: number, x: number, z: number) {
    const cx = this.cellCoord(x)
    const cz = this.cellCoord(z)
    const newKey = this.key(cx, cz)
    const oldKey = this.entityCells.get(eid)

    if (oldKey === newKey) return

    // Remove from old cell
    if (oldKey !== undefined) {
      const old = this.cells.get(oldKey)
      if (old) {
        old.delete(eid)
        if (old.size === 0) this.cells.delete(oldKey)
      }
    }

    // Insert into new cell
    let cell = this.cells.get(newKey)
    if (!cell) {
      cell = new Set()
      this.cells.set(newKey, cell)
    }
    cell.add(eid)
    this.entityCells.set(eid, newKey)
  }

  /**
   * Find all entities within `range` of (x, z).
   * Returns entity IDs into the provided array (avoids allocation).
   */
  query(x: number, z: number, range: number, result: number[]): number {
    result.length = 0
    const r = range + this.cellSize * 0.5 // expand slightly for edge cases
    const minCx = this.cellCoord(x - r)
    const maxCx = this.cellCoord(x + r)
    const minCz = this.cellCoord(z - r)
    const maxCz = this.cellCoord(z + r)
    const rangeSq = range * range

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const cell = this.cells.get(this.key(cx, cz))
        if (cell) {
          for (const eid of cell) {
            result.push(eid)
          }
        }
      }
    }
    return result.length
  }

  clear() {
    this.cells.clear()
    this.entityCells.clear()
  }
}
