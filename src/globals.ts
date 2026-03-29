import { SpatialHash } from './utils/spatial'

/** Global spatial hash — shared across all modules */
export const spatialHash = new SpatialHash(10)

/** Touch pan state — shared between input and engine (avoids circular import) */
export let touchPanDeltaX = 0
export let touchPanDeltaZ = 0
export function setTouchPan(dx: number, dz: number) { touchPanDeltaX = dx; touchPanDeltaZ = dz }
export function consumeTouchPan() { touchPanDeltaX = 0; touchPanDeltaZ = 0 }
