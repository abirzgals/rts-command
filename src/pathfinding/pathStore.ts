export interface Waypoint {
  x: number
  z: number
}

const paths = new Map<number, Waypoint[]>()
let nextPathId = 1

export function storePath(waypoints: Waypoint[]): number {
  const id = nextPathId++
  paths.set(id, waypoints)
  return id
}

export function getPath(id: number): Waypoint[] | undefined {
  return paths.get(id)
}

export function removePath(id: number) {
  paths.delete(id)
}
