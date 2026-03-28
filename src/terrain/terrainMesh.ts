import * as THREE from 'three'
import { MAP_SIZE } from '../game/config'
import {
  GRID_RES, heightData, terrainType,
  T_GRASS, T_DIRT, T_ROCK, T_WATER, T_CLIFF, T_DARK_GRASS,
} from './heightmap'
import { scene } from '../render/engine'

export let terrainMesh: THREE.Mesh
export let waterMesh: THREE.Mesh

let waterUniforms: { time: { value: number } } | null = null
export function updateWater(dt: number) {
  if (waterUniforms) waterUniforms.time.value += dt
}

// ── Biome base colors (used immediately, replaced by textures when loaded) ─

const BIOME_COLORS: [number, number, number][] = []
BIOME_COLORS[T_GRASS]      = [0.30, 0.50, 0.18]
BIOME_COLORS[T_DARK_GRASS] = [0.20, 0.38, 0.12]
BIOME_COLORS[T_DIRT]       = [0.50, 0.40, 0.25]
BIOME_COLORS[T_ROCK]       = [0.42, 0.40, 0.38]
BIOME_COLORS[T_CLIFF]      = [0.35, 0.32, 0.30]
BIOME_COLORS[T_WATER]      = [0.30, 0.42, 0.32]

// Terrain type → texture mapping
const BIOME_TEX_MAP: Record<number, string> = {
  [T_GRASS]: '/textures/grass.jpg',
  [T_DARK_GRASS]: '/textures/grass.jpg',
  [T_DIRT]: '/textures/dirt.jpg',
  [T_ROCK]: '/textures/rock.jpg',
  [T_CLIFF]: '/textures/cliff.jpg',
  [T_WATER]: '/textures/dirt.jpg',
}

// ── Bake textures into vertex colors ────────────────────────

/** Load an image and draw it to a canvas for pixel sampling */
function loadImageData(url: string): Promise<ImageData> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      resolve(ctx.getImageData(0, 0, img.width, img.height))
    }
    img.onerror = () => {
      // Fallback: 1x1 gray
      const c = document.createElement('canvas')
      c.width = 1; c.height = 1
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#888'
      ctx.fillRect(0, 0, 1, 1)
      resolve(ctx.getImageData(0, 0, 1, 1))
    }
    img.src = url
  })
}

/** Sample a pixel from ImageData using tiled UV coordinates */
function sampleTexture(img: ImageData, u: number, v: number): [number, number, number] {
  // Tile the UVs
  const x = ((u % 1) + 1) % 1
  const y = ((v % 1) + 1) % 1
  const px = Math.floor(x * img.width) % img.width
  const py = Math.floor(y * img.height) % img.height
  const i = (py * img.width + px) * 4
  return [img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255]
}

// ── Build geometry ──────────────────────────────────────────

function buildGeometry(): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, GRID_RES - 1, GRID_RES - 1)
  geo.rotateX(-Math.PI / 2)

  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const gx = Math.round((x + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const gz = Math.round((z + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const cgx = Math.max(0, Math.min(GRID_RES - 1, gx))
    const cgz = Math.max(0, Math.min(GRID_RES - 1, gz))
    pos.setY(i, heightData[cgz * GRID_RES + cgx])
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}

/** Set vertex colors from biome base colors */
function setBaseColors(geo: THREE.PlaneGeometry): Float32Array {
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    const gx = Math.round((x + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const gz = Math.round((z + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const cgx = Math.max(0, Math.min(GRID_RES - 1, gx))
    const cgz = Math.max(0, Math.min(GRID_RES - 1, gz))

    const tt = terrainType[cgz * GRID_RES + cgx]
    const h = heightData[cgz * GRID_RES + cgx]
    const bc = BIOME_COLORS[tt] || BIOME_COLORS[T_GRASS]
    const hf = 0.9 + Math.min(h, 10) * 0.015
    const n = Math.sin(x * 0.5) * Math.cos(z * 0.7) * 0.03

    colors[i * 3]     = Math.max(0, Math.min(1, bc[0] * hf + n))
    colors[i * 3 + 1] = Math.max(0, Math.min(1, bc[1] * hf + n))
    colors[i * 3 + 2] = Math.max(0, Math.min(1, bc[2] * hf + n * 0.5))
  }
  return colors
}

/** Replace vertex colors with texture-sampled colors (called async after textures load) */
async function bakeTextureColors(geo: THREE.PlaneGeometry) {
  // Load all unique textures
  const urls = new Set(Object.values(BIOME_TEX_MAP))
  const loaded = new Map<string, ImageData>()
  await Promise.all([...urls].map(async (url) => {
    loaded.set(url, await loadImageData(url))
  }))

  const pos = geo.attributes.position
  const colors = geo.attributes.color as THREE.BufferAttribute
  const texScale = 0.1 // tile every 10 world units

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    const gx = Math.round((x + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const gz = Math.round((z + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const cgx = Math.max(0, Math.min(GRID_RES - 1, gx))
    const cgz = Math.max(0, Math.min(GRID_RES - 1, gz))

    const tt = terrainType[cgz * GRID_RES + cgx]
    const h = heightData[cgz * GRID_RES + cgx]
    const hf = 0.9 + Math.min(h, 10) * 0.015

    const texUrl = BIOME_TEX_MAP[tt] || BIOME_TEX_MAP[T_GRASS]
    const img = loaded.get(texUrl)
    if (!img) continue

    // Sample texture at tiled world coordinates
    const [r, g, b] = sampleTexture(img, x * texScale, z * texScale)

    // Blend with neighbors for smooth transitions (simple 1-cell blur)
    let br = r, bg = g, bb = b, w = 1
    for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
      const nx = Math.max(0, Math.min(GRID_RES - 1, cgx + dx))
      const nz = Math.max(0, Math.min(GRID_RES - 1, cgz + dz))
      const ntt = terrainType[nz * GRID_RES + nx]
      if (ntt !== tt) {
        const ntexUrl = BIOME_TEX_MAP[ntt] || BIOME_TEX_MAP[T_GRASS]
        const nimg = loaded.get(ntexUrl)
        if (nimg) {
          const [nr, ng, nb] = sampleTexture(nimg, x * texScale, z * texScale)
          br += nr * 0.3; bg += ng * 0.3; bb += nb * 0.3; w += 0.3
        }
      }
    }

    colors.setXYZ(i, (br / w) * hf, (bg / w) * hf, (bb / w) * hf)
  }
  colors.needsUpdate = true
}

// ── Main terrain creation ───────────────────────────────────

export function createTerrainMesh(): THREE.Mesh {
  const geo = buildGeometry()
  const baseColors = setBaseColors(geo)
  geo.setAttribute('color', new THREE.BufferAttribute(baseColors, 3))

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.0,
  })

  terrainMesh = new THREE.Mesh(geo, mat)
  terrainMesh.receiveShadow = true
  scene.add(terrainMesh)

  // Async: load textures and bake into vertex colors (upgrades appearance)
  bakeTextureColors(geo).catch(() => {})

  createWater()
  return terrainMesh
}

// ── Animated water ──────────────────────────────────────────

function createWater() {
  const waterGeo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 64, 64)
  waterGeo.rotateX(-Math.PI / 2)
  waterUniforms = { time: { value: 0 } }

  const waterMat = new THREE.ShaderMaterial({
    uniforms: {
      time: waterUniforms.time,
      waterColor: { value: new THREE.Color(0.12, 0.30, 0.50) },
      foamColor: { value: new THREE.Color(0.55, 0.70, 0.82) },
    },
    vertexShader: `
      uniform float time;
      varying vec2 vUv;
      varying float vWave;
      void main() {
        vUv = uv;
        vec3 p = position;
        float w = sin(p.x*0.3+time*1.2)*0.3 + sin(p.z*0.4+time*0.8)*0.2 + sin((p.x+p.z)*0.2+time*1.5)*0.15;
        p.y = -1.2 + w;
        vWave = w;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 waterColor, foamColor;
      uniform float time;
      varying vec2 vUv;
      varying float vWave;
      void main() {
        float c = pow(sin(vUv.x*40.0+time*2.0)*sin(vUv.y*40.0+time*1.5)*0.5+0.5, 3.0)*0.3;
        vec3 col = mix(waterColor + c*foamColor, foamColor, smoothstep(0.2,0.4,vWave)*0.3);
        gl_FragColor = vec4(col, 0.55 + c*0.15);
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  })

  waterMesh = new THREE.Mesh(waterGeo, waterMat)
  waterMesh.renderOrder = 1
  scene.add(waterMesh)
}
