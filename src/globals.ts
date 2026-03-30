import { SpatialHash } from './utils/spatial'

/** Global spatial hash — shared across all modules */
export const spatialHash = new SpatialHash(10)

/** Performance budget — throttle heavy systems when FPS drops */
export let perfBudget = { maxPaths: 4, combatSkip: false }
let fpsHistory: number[] = []
export function updatePerfBudget(dt: number) {
  const fps = dt > 0 ? 1 / dt : 60
  fpsHistory.push(fps)
  if (fpsHistory.length > 30) fpsHistory.shift()
  const avgFps = fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length
  if (avgFps < 20) {
    perfBudget.maxPaths = 1
    perfBudget.combatSkip = true
  } else if (avgFps < 30) {
    perfBudget.maxPaths = 2
    perfBudget.combatSkip = false
  } else {
    perfBudget.maxPaths = 4
    perfBudget.combatSkip = false
  }
}

/** Touch pan state — shared between input and engine (avoids circular import) */
export let touchPanDeltaX = 0
export let touchPanDeltaZ = 0
export function setTouchPan(dx: number, dz: number) { touchPanDeltaX = dx; touchPanDeltaZ = dz }
export function consumeTouchPan() { touchPanDeltaX = 0; touchPanDeltaZ = 0 }
