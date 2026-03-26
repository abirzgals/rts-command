import { MAP_SIZE } from '../game/config'

// ── Grid resolution ──────────────────────────────────────────
export const GRID_RES = 200
export const CELL_SIZE = MAP_SIZE / GRID_RES
const HALF = MAP_SIZE / 2

// ── Terrain type IDs ─────────────────────────────────────────
export const T_GRASS = 0
export const T_DIRT = 1
export const T_ROCK = 2
export const T_WATER = 3
export const T_CLIFF = 4
export const T_DARK_GRASS = 5

// ── Data arrays ──────────────────────────────────────────────
export const heightData = new Float32Array(GRID_RES * GRID_RES)
export const terrainType = new Uint8Array(GRID_RES * GRID_RES)

// ── Base and resource locations that MUST be flat/walkable ───
const BASE_POSITIONS = [
  { x: -80, z: -80 }, // player
  { x: 80, z: 80 },   // enemy
]
const BASE_FLAT_RADIUS = 30  // guaranteed flat area around each base
const BASE_HEIGHT = 3.0      // guaranteed base height (well above water)

// ── Perlin noise ─────────────────────────────────────────────
const perm = new Uint8Array(512)
;(() => {
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  let seed = 42
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[p[i], p[j]] = [p[j], p[i]]
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]
})()

function fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10) }
function lerp(a: number, b: number, t: number) { return a + t * (b - a) }

function grad(hash: number, x: number, y: number): number {
  const h = hash & 3
  const u = h < 2 ? x : y
  const v = h < 2 ? y : x
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v)
}

function noise2D(x: number, y: number): number {
  const X = Math.floor(x) & 255
  const Y = Math.floor(y) & 255
  const xf = x - Math.floor(x)
  const yf = y - Math.floor(y)
  const u = fade(xf)
  const v = fade(yf)
  return lerp(
    lerp(grad(perm[perm[X] + Y], xf, yf), grad(perm[perm[X + 1] + Y], xf - 1, yf), u),
    lerp(grad(perm[perm[X] + Y + 1], xf, yf - 1), grad(perm[perm[X + 1] + Y + 1], xf - 1, yf - 1), u),
    v,
  )
}

function fbm(x: number, y: number, octaves: number, lac: number, gain: number): number {
  let sum = 0, amp = 1, freq = 1, max = 0
  for (let i = 0; i < octaves; i++) {
    sum += noise2D(x * freq, y * freq) * amp
    max += amp; amp *= gain; freq *= lac
  }
  return sum / max
}

// ── Coordinate conversion ────────────────────────────────────
export function worldToGrid(wx: number, wz: number): [number, number] {
  return [
    Math.max(0, Math.min(GRID_RES - 1, Math.floor((wx + HALF) / CELL_SIZE))),
    Math.max(0, Math.min(GRID_RES - 1, Math.floor((wz + HALF) / CELL_SIZE))),
  ]
}

export function gridToWorld(gx: number, gz: number): [number, number] {
  return [gx * CELL_SIZE - HALF + CELL_SIZE * 0.5, gz * CELL_SIZE - HALF + CELL_SIZE * 0.5]
}

// ── Distance to nearest base ─────────────────────────────────
function distToNearestBase(wx: number, wz: number): number {
  let min = Infinity
  for (const b of BASE_POSITIONS) {
    const d = Math.sqrt((wx - b.x) ** 2 + (wz - b.z) ** 2)
    if (d < min) min = d
  }
  return min
}

// ── Generate heightmap ───────────────────────────────────────
export function generateTerrain() {
  // ── Pass 1: raw noise height ──
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const [wx, wz] = gridToWorld(gx, gz)
      const nx = wx * 0.008, nz = wz * 0.008

      let h = fbm(nx, nz, 4, 2.2, 0.5) * 20
      h += fbm(nx * 3 + 100, nz * 3 + 100, 3, 2.0, 0.45) * 7

      // Create sharp plateau edges for cliff-like terrain
      // Quantize height into steps for a StarCraft-like multi-level map
      const rawH = h
      if (h > 6) h = 6 + (h - 6) * 2.5     // amplify high ground
      if (h > 3 && h < 5) h = lerp(h, 4.0, 0.4) // plateau at level 2
      if (h > 8) h = lerp(h, 10.0, 0.3)          // plateau at level 3

      h += fbm(nx * 8 + 200, nz * 8 + 200, 2, 2.0, 0.4) * 1.5

      heightData[gz * GRID_RES + gx] = h
    }
  }

  // ── Pass 2: Force-flatten base areas (HARD override) ──
  for (const base of BASE_POSITIONS) {
    for (let gz = 0; gz < GRID_RES; gz++) {
      for (let gx = 0; gx < GRID_RES; gx++) {
        const [wx, wz] = gridToWorld(gx, gz)
        const dist = Math.sqrt((wx - base.x) ** 2 + (wz - base.z) ** 2)

        if (dist < BASE_FLAT_RADIUS) {
          const i = gz * GRID_RES + gx
          if (dist < BASE_FLAT_RADIUS * 0.7) {
            // Inner zone: completely flat
            heightData[i] = BASE_HEIGHT
          } else {
            // Outer zone: smooth transition to natural terrain
            const t = (dist - BASE_FLAT_RADIUS * 0.7) / (BASE_FLAT_RADIUS * 0.3)
            const smooth = t * t * (3 - 2 * t) // smoothstep
            heightData[i] = lerp(BASE_HEIGHT, Math.max(heightData[i], BASE_HEIGHT * 0.5), smooth)
          }
        }
      }
    }
  }

  // ── Pass 3: Carve navigable corridors between bases ──
  // Main diagonal corridor
  carveCorridorBetween(-80, -80, 80, 80, 14, BASE_HEIGHT * 0.8)
  // Side routes
  carveCorridorBetween(-80, -80, 0, 40, 10, BASE_HEIGHT * 0.7)
  carveCorridorBetween(0, 40, 80, 80, 10, BASE_HEIGHT * 0.7)
  carveCorridorBetween(-80, -80, -40, 0, 10, BASE_HEIGHT * 0.7)
  carveCorridorBetween(-40, 0, 80, 80, 10, BASE_HEIGHT * 0.7)

  // ── Pass 4: Push map edges into water ──
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const edgeDist = Math.min(gx, gz, GRID_RES - 1 - gx, GRID_RES - 1 - gz)
      if (edgeDist < 12) {
        const t = 1 - edgeDist / 12
        const i = gz * GRID_RES + gx
        heightData[i] -= t * t * 10
      }
    }
  }

  // ── Pass 5: Classify terrain types ──
  for (let i = 0; i < GRID_RES * GRID_RES; i++) {
    const h = heightData[i]
    if (h < -0.5) terrainType[i] = T_WATER
    else if (h < 2.0) terrainType[i] = T_GRASS
    else if (h < 4.5) terrainType[i] = T_DIRT
    else if (h < 7.0) terrainType[i] = T_DARK_GRASS
    else terrainType[i] = T_ROCK
  }

  // ── Pass 6: Detect cliffs ──
  for (let gz = 1; gz < GRID_RES - 1; gz++) {
    for (let gx = 1; gx < GRID_RES - 1; gx++) {
      const i = gz * GRID_RES + gx
      const h = heightData[i]
      const maxSlope = Math.max(
        Math.abs(h - heightData[i - 1]),
        Math.abs(h - heightData[i + 1]),
        Math.abs(h - heightData[(gz - 1) * GRID_RES + gx]),
        Math.abs(h - heightData[(gz + 1) * GRID_RES + gx]),
      )
      if (maxSlope > 3.0 && terrainType[i] !== T_WATER) {
        terrainType[i] = T_CLIFF
      }
    }
  }

  // ── Pass 7: GUARANTEE base areas are walkable ──
  for (const base of BASE_POSITIONS) {
    for (let gz = 0; gz < GRID_RES; gz++) {
      for (let gx = 0; gx < GRID_RES; gx++) {
        const [wx, wz] = gridToWorld(gx, gz)
        const dist = Math.sqrt((wx - base.x) ** 2 + (wz - base.z) ** 2)
        if (dist < BASE_FLAT_RADIUS) {
          const i = gz * GRID_RES + gx
          // Force grass/dirt in base area — never water/cliff/rock
          if (terrainType[i] === T_WATER || terrainType[i] === T_CLIFF || terrainType[i] === T_ROCK) {
            terrainType[i] = dist < 15 ? T_DIRT : T_GRASS
          }
        }
      }
    }
  }
}

function carveCorridorBetween(x1: number, z1: number, x2: number, z2: number, width: number, minHeight: number) {
  // For each grid cell, compute distance to the line segment and carve if close enough
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const [wx, wz] = gridToWorld(gx, gz)
      const dist = distToSegment(wx, wz, x1, z1, x2, z2)

      if (dist < width) {
        const i = gz * GRID_RES + gx
        const h = heightData[i]
        const blend = 1 - (dist / width)
        const target = Math.max(minHeight, Math.min(h, minHeight + 3))
        heightData[i] = lerp(h, target, blend * blend)
      }
    }
  }
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az
  const len2 = dx * dx + dz * dz
  if (len2 === 0) return Math.sqrt((px - ax) ** 2 + (pz - az) ** 2)
  let t = ((px - ax) * dx + (pz - az) * dz) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cz = az + t * dz
  return Math.sqrt((px - cx) ** 2 + (pz - cz) ** 2)
}

// ── Height sampling (bilinear interpolation) ─────────────────
export function getTerrainHeight(wx: number, wz: number): number {
  const gxf = (wx + HALF) / CELL_SIZE
  const gzf = (wz + HALF) / CELL_SIZE
  const gx0 = Math.max(0, Math.min(GRID_RES - 2, Math.floor(gxf)))
  const gz0 = Math.max(0, Math.min(GRID_RES - 2, Math.floor(gzf)))

  const fx = gxf - gx0
  const fz = gzf - gz0

  return lerp(
    lerp(heightData[gz0 * GRID_RES + gx0], heightData[gz0 * GRID_RES + gx0 + 1], fx),
    lerp(heightData[(gz0 + 1) * GRID_RES + gx0], heightData[(gz0 + 1) * GRID_RES + gx0 + 1], fx),
    fz,
  )
}

export function getTerrainTypeAt(wx: number, wz: number): number {
  const [gx, gz] = worldToGrid(wx, wz)
  return terrainType[gz * GRID_RES + gx]
}
