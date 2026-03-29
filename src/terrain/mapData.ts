/**
 * Map data format: serialize, deserialize, compress, REST API.
 * Maps are stored as JSON with compressed heightData + terrainType.
 */

import { GRID_RES, heightData, terrainType, gridToWorld } from './heightmap'
import { textureOverrides, replaceTerrainTexture } from './terrainMesh'

const TOTAL = GRID_RES * GRID_RES

// ── Types ────────────────────────────────────────────────────

export interface MapObject {
  type: 'obstacle' | 'resource'
  poolId: number   // 20=minerals, 21=gas, 22-25=obstacles
  x: number
  z: number
  rotation: number
  amount?: number  // for resources
}

export interface SpawnPoints {
  player: { x: number; z: number }
  enemy: { x: number; z: number }
}

export interface MapData {
  metadata: {
    name: string
    size: number
    created: string
    modified: string
  }
  heightData: string    // base64-encoded delta-encoded Int16Array
  terrainType: string   // base64-encoded RLE Uint8Array
  objects: MapObject[]
  spawnPoints: SpawnPoints
  textures?: Record<string, string> // slot → URL overrides (e.g. { cliff: '/textures/myCliff.jpg' })
}

// ── Compression: height data ─────────────────────────────────
// Delta-encode Float32 → Int16 (×100 for 2-decimal precision) → base64

function encodeHeightData(data: Float32Array): string {
  const i16 = new Int16Array(data.length)
  let prev = 0
  for (let i = 0; i < data.length; i++) {
    const val = Math.round(data[i] * 100)
    i16[i] = val - prev
    prev = val
  }
  return arrayToBase64(new Uint8Array(i16.buffer))
}

function decodeHeightData(encoded: string, target: Float32Array): void {
  const bytes = base64ToArray(encoded)
  const i16 = new Int16Array(bytes.buffer)
  let acc = 0
  for (let i = 0; i < i16.length && i < target.length; i++) {
    acc += i16[i]
    target[i] = acc / 100
  }
}

// ── Compression: terrain type ────────────────────────────────
// RLE: [value, count16_hi, count16_lo, ...] → base64

function encodeTerrainType(data: Uint8Array): string {
  const pairs: number[] = []
  let i = 0
  while (i < data.length) {
    const val = data[i]
    let count = 1
    while (i + count < data.length && data[i + count] === val && count < 65535) count++
    pairs.push(val, (count >> 8) & 0xff, count & 0xff)
    i += count
  }
  return arrayToBase64(new Uint8Array(pairs))
}

function decodeTerrainType(encoded: string, target: Uint8Array): void {
  const bytes = base64ToArray(encoded)
  let ti = 0
  for (let i = 0; i < bytes.length - 2; i += 3) {
    const val = bytes[i]
    const count = (bytes[i + 1] << 8) | bytes[i + 2]
    for (let j = 0; j < count && ti < target.length; j++) {
      target[ti++] = val
    }
  }
}

// ── Base64 helpers ───────────────────────────────────────────

function arrayToBase64(arr: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i])
  return btoa(binary)
}

function base64ToArray(b64: string): Uint8Array {
  const binary = atob(b64)
  const arr = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i)
  return arr
}

// ── Serialize current terrain state → MapData ────────────────

export function serializeCurrentMap(
  name: string,
  objects: MapObject[],
  spawnPoints: SpawnPoints,
): MapData {
  return {
    metadata: {
      name,
      size: GRID_RES,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
    },
    heightData: encodeHeightData(heightData),
    terrainType: encodeTerrainType(terrainType),
    objects,
    spawnPoints,
    textures: Object.keys(textureOverrides).length > 0 ? { ...textureOverrides } : undefined,
  }
}

// ── Deserialize MapData → write into global heightData/terrainType ─

export function loadMapIntoTerrain(mapData: MapData): {
  objects: MapObject[]
  spawnPoints: SpawnPoints
} {
  decodeHeightData(mapData.heightData, heightData)
  decodeTerrainType(mapData.terrainType, terrainType)

  // Restore texture overrides
  for (const k of Object.keys(textureOverrides)) delete textureOverrides[k]
  if (mapData.textures) {
    for (const [slot, url] of Object.entries(mapData.textures)) {
      replaceTerrainTexture(slot, url)
    }
  }

  return {
    objects: mapData.objects || [],
    spawnPoints: mapData.spawnPoints || {
      player: { x: -65, z: -65 },
      enemy: { x: 65, z: 65 },
    },
  }
}

// ── REST API helpers ─────────────────────────────────────────

export async function fetchMapList(): Promise<{ name: string; modified: string }[]> {
  const res = await fetch('/api/maps')
  const json = await res.json()
  return json.data || []
}

export async function fetchMap(name: string): Promise<MapData> {
  const res = await fetch(`/api/maps/${encodeURIComponent(name)}`)
  const json = await res.json()
  return json.data
}

export async function saveMap(name: string, data: MapData): Promise<void> {
  await fetch(`/api/maps/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deleteMap(name: string): Promise<void> {
  await fetch(`/api/maps/${encodeURIComponent(name)}`, { method: 'DELETE' })
}
