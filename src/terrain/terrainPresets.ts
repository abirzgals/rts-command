/**
 * Terrain heightmap presets.
 * Each preset writes directly into the global heightData/terrainType arrays.
 */

import {
  GRID_RES, heightData, terrainType, gridToWorld,
  T_GRASS, T_DIRT, T_ROCK, T_WATER, T_CLIFF, T_DARK_GRASS,
} from './heightmap'

const TOTAL = GRID_RES * GRID_RES

// ── Simple Perlin noise (standalone, no global seed dependency) ─

const perm = new Uint8Array(512)

function seed(s: number) {
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  const rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 }
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]] }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]
}

function fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10) }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t }

const grad2 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]]
function noise2(x: number, y: number): number {
  const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255
  const xf = x - Math.floor(x), yf = y - Math.floor(y)
  const u = fade(xf), v = fade(yf)
  const aa = perm[perm[xi] + yi], ab = perm[perm[xi] + yi + 1]
  const ba = perm[perm[xi + 1] + yi], bb = perm[perm[xi + 1] + yi + 1]
  const g = (h: number, dx: number, dy: number) => { const g2 = grad2[h & 7]; return g2[0] * dx + g2[1] * dy }
  return lerp(
    lerp(g(aa, xf, yf), g(ba, xf - 1, yf), u),
    lerp(g(ab, xf, yf - 1), g(bb, xf - 1, yf - 1), u), v,
  )
}

function fbm(x: number, y: number, oct: number, lac: number, gain: number): number {
  let sum = 0, max = 0, amp = 1, freq = 1
  for (let i = 0; i < oct; i++) {
    sum += noise2(x * freq, y * freq) * amp
    max += amp; amp *= gain; freq *= lac
  }
  return sum / max
}

// ── Terrain type classification ──────────────────────────────

function classifyTerrain() {
  for (let i = 0; i < TOTAL; i++) {
    const h = heightData[i]
    if (h < -0.5) terrainType[i] = T_WATER
    else if (h < 2.0) terrainType[i] = T_GRASS
    else if (h < 4.5) terrainType[i] = T_DIRT
    else if (h < 7.0) terrainType[i] = T_DARK_GRASS
    else terrainType[i] = T_ROCK
  }
  // Cliff detection
  for (let gz = 1; gz < GRID_RES - 1; gz++) {
    for (let gx = 1; gx < GRID_RES - 1; gx++) {
      const i = gz * GRID_RES + gx
      const h = heightData[i]
      const maxSlope = Math.max(
        Math.abs(h - heightData[i - 1]),
        Math.abs(h - heightData[i + 1]),
        Math.abs(h - heightData[i - GRID_RES]),
        Math.abs(h - heightData[i + GRID_RES]),
      )
      if (maxSlope > 3.0 && terrainType[i] !== T_WATER) terrainType[i] = T_CLIFF
    }
  }
}

// ── Edge water (push edges below water level) ────────────────

function applyEdgeWater(depth = 10, border = 12) {
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const edgeDist = Math.min(gx, gz, GRID_RES - 1 - gx, GRID_RES - 1 - gz)
      if (edgeDist < border) {
        const t = 1 - edgeDist / border
        heightData[gz * GRID_RES + gx] -= t * t * depth
      }
    }
  }
}

// ── Presets ───────────────────────────────────────────────────

export type PresetName = 'flat' | 'islands' | 'mountains' | 'valleys' | 'canyon' | 'archipelago'

export function applyPreset(preset: PresetName, seedVal?: number) {
  seed(seedVal ?? (Date.now() % 2147483647))

  switch (preset) {
    case 'flat': presetFlat(); break
    case 'islands': presetIslands(); break
    case 'mountains': presetMountains(); break
    case 'valleys': presetValleys(); break
    case 'canyon': presetCanyon(); break
    case 'archipelago': presetArchipelago(); break
  }

  classifyTerrain()
}

function presetFlat() {
  heightData.fill(3.0)
  terrainType.fill(T_GRASS)
}

function presetIslands() {
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const [wx, wz] = gridToWorld(gx, gz)
      const nx = wx * 0.012, nz = wz * 0.012
      // Base: below water
      let h = -2.0
      // Islands rise with noise
      h += fbm(nx, nz, 4, 2.0, 0.5) * 12
      // Distance from center falloff
      const dc = Math.sqrt(wx * wx + wz * wz) / 100
      h -= dc * dc * 3
      heightData[gz * GRID_RES + gx] = h
    }
  }
  applyEdgeWater(8, 15)
}

function presetMountains() {
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const [wx, wz] = gridToWorld(gx, gz)
      const nx = wx * 0.008, nz = wz * 0.008
      let h = fbm(nx, nz, 5, 2.2, 0.5) * 25
      h += fbm(nx * 3 + 50, nz * 3 + 50, 3, 2.0, 0.45) * 8
      // Ridge effect
      h = Math.abs(h) * 0.8
      heightData[gz * GRID_RES + gx] = h
    }
  }
  applyEdgeWater()
}

function presetValleys() {
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const [wx, wz] = gridToWorld(gx, gz)
      const nx = wx * 0.01, nz = wz * 0.01
      // High base with carved valleys
      let h = 8.0
      const valley = fbm(nx, nz, 3, 2.0, 0.5)
      h += valley * 15
      // Sharp valley carves
      const carve = Math.abs(fbm(nx * 2 + 30, nz * 2 + 30, 2, 2.5, 0.4))
      h -= carve * 12
      heightData[gz * GRID_RES + gx] = h
    }
  }
  applyEdgeWater()
}

function presetCanyon() {
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const [wx, wz] = gridToWorld(gx, gz)
      const nx = wx * 0.008, nz = wz * 0.008
      // Flat mesa
      let h = 6.0
      // Canyon carved by a winding path
      const wind = Math.sin(nz * 3 + fbm(nx * 2, nz * 2, 2, 2.0, 0.5) * 4) * 0.5 + 0.5
      const canyonDist = Math.abs(nx * 10 - wind * 3)
      if (canyonDist < 2.0) {
        const t = canyonDist / 2.0
        h = lerp(-1.0, h, t * t) // deep canyon floor
      }
      h += fbm(nx * 4 + 100, nz * 4 + 100, 2, 2.0, 0.4) * 2
      heightData[gz * GRID_RES + gx] = h
    }
  }
  applyEdgeWater(6, 10)
}

function presetArchipelago() {
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const [wx, wz] = gridToWorld(gx, gz)
      const nx = wx * 0.015, nz = wz * 0.015
      // Water base with scattered islands
      let h = -1.5
      h += fbm(nx, nz, 3, 2.0, 0.55) * 8
      // Sharp island edges
      if (h > 0) h = h * 1.5
      h += fbm(nx * 5 + 200, nz * 5 + 200, 2, 2.0, 0.4) * 1.5
      heightData[gz * GRID_RES + gx] = h
    }
  }
  applyEdgeWater(5, 8)
}
