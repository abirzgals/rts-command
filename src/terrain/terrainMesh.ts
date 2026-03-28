import * as THREE from 'three'
import { MAP_SIZE } from '../game/config'
import {
  GRID_RES, heightData, terrainType,
  T_GRASS, T_DIRT, T_ROCK, T_WATER, T_CLIFF, T_DARK_GRASS,
  getTerrainHeight,
} from './heightmap'
import { scene } from '../render/engine'

export let terrainMesh: THREE.Mesh
export let waterMesh: THREE.Mesh

// ── Biome colors ────────────────────────────────────────────
const BIOME_COLORS: Record<number, THREE.Color> = {
  [T_GRASS]:      new THREE.Color(0.28, 0.52, 0.18),
  [T_DARK_GRASS]: new THREE.Color(0.18, 0.38, 0.12),
  [T_DIRT]:       new THREE.Color(0.52, 0.42, 0.28), // also used as sand
  [T_ROCK]:       new THREE.Color(0.42, 0.40, 0.38),
  [T_WATER]:      new THREE.Color(0.32, 0.45, 0.35), // underwater ground
  [T_CLIFF]:      new THREE.Color(0.35, 0.32, 0.30),
}

// ── Water uniforms ──────────────────────────────────────────
let waterUniforms: { time: { value: number } } | null = null

export function updateWater(dt: number) {
  if (waterUniforms) waterUniforms.time.value += dt
}

// ── Main terrain creation ───────────────────────────────────

export function createTerrainMesh(): THREE.Mesh {
  // 1. Build geometry from heightmap
  const geo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, GRID_RES - 1, GRID_RES - 1)
  geo.rotateX(-Math.PI / 2)

  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)

    const gx = Math.round((x + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const gz = Math.round((z + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const cgx = Math.max(0, Math.min(GRID_RES - 1, gx))
    const cgz = Math.max(0, Math.min(GRID_RES - 1, gz))

    const h = heightData[cgz * GRID_RES + cgx]
    pos.setY(i, h)

    // Vertex color from biome type with slight noise variation
    const tt = terrainType[cgz * GRID_RES + cgx]
    const base = BIOME_COLORS[tt] || BIOME_COLORS[T_GRASS]

    // Add subtle variation based on position
    const noise = Math.sin(x * 0.5) * Math.cos(z * 0.7) * 0.04 + Math.sin(x * 1.3 + z * 0.9) * 0.03
    // Height-based darkening in valleys, brightening on peaks
    const heightFactor = 0.9 + Math.min(h, 10) * 0.015

    colors[i * 3]     = Math.max(0, Math.min(1, base.r * heightFactor + noise))
    colors[i * 3 + 1] = Math.max(0, Math.min(1, base.g * heightFactor + noise))
    colors[i * 3 + 2] = Math.max(0, Math.min(1, base.b * heightFactor + noise * 0.5))
  }

  pos.needsUpdate = true
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()

  // 2. Material — MeshStandardMaterial with vertex colors = shadows work natively
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.0,
    flatShading: false,
  })

  terrainMesh = new THREE.Mesh(geo, mat)
  terrainMesh.receiveShadow = true
  terrainMesh.castShadow = false
  scene.add(terrainMesh)

  // 3. Water plane
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
      waterColor: { value: new THREE.Color(0.15, 0.35, 0.55) },
      foamColor: { value: new THREE.Color(0.6, 0.75, 0.85) },
    },
    vertexShader: `
      uniform float time;
      varying vec2 vUv;
      varying float vWaveHeight;
      void main() {
        vUv = uv;
        vec3 p = position;
        float wave = sin(p.x * 0.3 + time * 1.2) * 0.3
                   + sin(p.z * 0.4 + time * 0.8) * 0.2
                   + sin((p.x + p.z) * 0.2 + time * 1.5) * 0.15;
        p.y = -1.2 + wave;
        vWaveHeight = wave;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 waterColor;
      uniform vec3 foamColor;
      uniform float time;
      varying vec2 vUv;
      varying float vWaveHeight;
      void main() {
        // Animated caustics pattern
        float caustic = sin(vUv.x * 40.0 + time * 2.0) * sin(vUv.y * 40.0 + time * 1.5) * 0.5 + 0.5;
        caustic = pow(caustic, 3.0) * 0.3;

        // Blend water color with caustics
        vec3 col = waterColor + caustic * foamColor;

        // Edge foam from wave peaks
        float foam = smoothstep(0.2, 0.4, vWaveHeight) * 0.3;
        col = mix(col, foamColor, foam);

        // Fresnel-like opacity variation
        float alpha = 0.55 + caustic * 0.15;

        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  waterMesh = new THREE.Mesh(waterGeo, waterMat)
  waterMesh.renderOrder = 1
  scene.add(waterMesh)
}
