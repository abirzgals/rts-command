import { SpatialHash } from './utils/spatial'

/** Global spatial hash — shared across all modules */
export const spatialHash = new SpatialHash(10)
