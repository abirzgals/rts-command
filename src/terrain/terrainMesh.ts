import * as THREE from 'three'
import { MAP_SIZE } from '../game/config'
import {
  GRID_RES, heightData, terrainType,
  T_GRASS, T_DIRT, T_ROCK, T_WATER, T_CLIFF, T_DARK_GRASS,
} from './heightmap'
import { scene } from '../render/engine'

// ═══════════════════════════════════════════════════════════════
//  Photorealistic Terrain  —  Multi-texture splatted ShaderMaterial
//  + Animated water mesh with caustics, ripples, reflections
// ═══════════════════════════════════════════════════════════════

export let terrainMesh: THREE.Mesh
export let waterMesh: THREE.Mesh

// ── Procedural texture generation ────────────────────────────

const TEX_SIZE = 512 // resolution of each tiled texture

/** Seeded pseudo-random for reproducible textures */
function makeRand(seed: number) {
  let s = seed
  return () => { s = (s * 16807 + 7) % 2147483647; return (s & 0x7fffffff) / 0x7fffffff }
}

/** Generate a simple 2D noise field (value noise) */
function valueNoise(size: number, seed: number): Float32Array {
  const rand = makeRand(seed)
  const grid = 16
  const values = new Float32Array((grid + 1) * (grid + 1))
  for (let i = 0; i < values.length; i++) values[i] = rand()

  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * grid
      const gy = (y / size) * grid
      const ix = Math.floor(gx), iy = Math.floor(gy)
      const fx = gx - ix, fy = gy - iy
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
      const v00 = values[iy * (grid + 1) + ix]
      const v10 = values[iy * (grid + 1) + ix + 1]
      const v01 = values[(iy + 1) * (grid + 1) + ix]
      const v11 = values[(iy + 1) * (grid + 1) + ix + 1]
      out[y * size + x] = (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy
    }
  }
  return out
}

/** Fractal Brownian Motion from value noise layers */
function fbmNoise(size: number, seed: number, octaves: number): Float32Array {
  const out = new Float32Array(size * size)
  let amp = 1, totalAmp = 0
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(size, seed + o * 1000)
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp
    totalAmp += amp
    amp *= 0.5
  }
  for (let i = 0; i < out.length; i++) out[i] /= totalAmp
  return out
}

/** Create a DataTexture from RGBA Uint8 data */
function makeDataTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data as unknown as BufferSource, size, size, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

// ── Individual biome texture generators ──────────────────────

function generateGrassTexture(): THREE.DataTexture {
  const sz = TEX_SIZE
  const noise1 = fbmNoise(sz, 100, 5)
  const noise2 = fbmNoise(sz, 200, 3)
  const data = new Uint8Array(sz * sz * 4)
  const rand = makeRand(333)

  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      const i = y * sz + x
      const n1 = noise1[i]
      const n2 = noise2[i]

      // Base green with variation
      let r = 45 + n1 * 50 - 15
      let g = 110 + n1 * 70 + n2 * 30 - 20
      let b = 35 + n1 * 25

      // Grass blade hints: vertical streaks
      const blade = Math.sin(x * 0.8 + n2 * 20) * 0.5 + 0.5
      g += blade * 18
      r -= blade * 5

      // Dark spots (clumps)
      if (n2 > 0.65) { r *= 0.8; g *= 0.85; b *= 0.8 }

      // Tiny bright highlights (dew)
      if (rand() > 0.995) { r += 30; g += 40; b += 15 }

      const idx = i * 4
      data[idx] = Math.max(0, Math.min(255, r | 0))
      data[idx + 1] = Math.max(0, Math.min(255, g | 0))
      data[idx + 2] = Math.max(0, Math.min(255, b | 0))
      data[idx + 3] = 255
    }
  }
  return makeDataTexture(data, sz)
}

function generateDirtTexture(): THREE.DataTexture {
  const sz = TEX_SIZE
  const noise1 = fbmNoise(sz, 300, 5)
  const noise2 = fbmNoise(sz, 400, 4)
  const data = new Uint8Array(sz * sz * 4)

  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      const i = y * sz + x
      const n1 = noise1[i]
      const n2 = noise2[i]

      // Sandy brown base
      let r = 140 + n1 * 60 + n2 * 20
      let g = 110 + n1 * 45 + n2 * 15
      let b = 70 + n1 * 30

      // Pebble spots
      if (n2 > 0.7) { r -= 20; g -= 15; b -= 10 }

      // Cracks
      const crack = Math.abs(Math.sin(x * 0.15 + n1 * 10) * Math.cos(y * 0.12 + n2 * 8))
      if (crack < 0.05) { r -= 25; g -= 20; b -= 15 }

      const idx = i * 4
      data[idx] = Math.max(0, Math.min(255, r | 0))
      data[idx + 1] = Math.max(0, Math.min(255, g | 0))
      data[idx + 2] = Math.max(0, Math.min(255, b | 0))
      data[idx + 3] = 255
    }
  }
  return makeDataTexture(data, sz)
}

function generateSandTexture(): THREE.DataTexture {
  const sz = TEX_SIZE
  const noise1 = fbmNoise(sz, 500, 4)
  const noise2 = fbmNoise(sz, 600, 3)
  const data = new Uint8Array(sz * sz * 4)

  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      const i = y * sz + x
      const n1 = noise1[i]
      const n2 = noise2[i]

      // Warm sand
      let r = 210 + n1 * 30 + n2 * 10
      let g = 190 + n1 * 25 + n2 * 8
      let b = 145 + n1 * 20

      // Wind ripple patterns
      const ripple = Math.sin(x * 0.05 + y * 0.02 + n1 * 6) * 0.5 + 0.5
      r += ripple * 8
      g += ripple * 6
      b += ripple * 4

      // Wet sand near edges (slightly darker)
      if (n2 < 0.3) { r -= 15; g -= 10; b += 5 }

      const idx = i * 4
      data[idx] = Math.max(0, Math.min(255, r | 0))
      data[idx + 1] = Math.max(0, Math.min(255, g | 0))
      data[idx + 2] = Math.max(0, Math.min(255, b | 0))
      data[idx + 3] = 255
    }
  }
  return makeDataTexture(data, sz)
}

function generateRockTexture(): THREE.DataTexture {
  const sz = TEX_SIZE
  const noise1 = fbmNoise(sz, 700, 6)
  const noise2 = fbmNoise(sz, 800, 4)
  const data = new Uint8Array(sz * sz * 4)

  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      const i = y * sz + x
      const n1 = noise1[i]
      const n2 = noise2[i]

      // Grey rock
      let base = 95 + n1 * 70 + n2 * 25
      let r = base + 8
      let g = base + 3
      let b = base

      // Moss tint on some rock
      if (n2 > 0.55 && n1 > 0.4) { r -= 10; g += 12; b -= 5 }

      // Veins / strata lines
      const strata = Math.sin(y * 0.1 + x * 0.03 + n1 * 15) * 0.5 + 0.5
      if (strata < 0.1) { r -= 15; g -= 12; b -= 10 }

      const idx = i * 4
      data[idx] = Math.max(0, Math.min(255, r | 0))
      data[idx + 1] = Math.max(0, Math.min(255, g | 0))
      data[idx + 2] = Math.max(0, Math.min(255, b | 0))
      data[idx + 3] = 255
    }
  }
  return makeDataTexture(data, sz)
}

function generateCliffTexture(): THREE.DataTexture {
  const sz = TEX_SIZE
  const noise1 = fbmNoise(sz, 900, 5)
  const noise2 = fbmNoise(sz, 1000, 4)
  const data = new Uint8Array(sz * sz * 4)

  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      const i = y * sz + x
      const n1 = noise1[i]
      const n2 = noise2[i]

      // Dark grey-brown cliff face
      let base = 70 + n1 * 55
      let r = base + 15 + n2 * 10
      let g = base + 8 + n2 * 5
      let b = base + n2 * 3

      // Horizontal strata (layered rock look)
      const layer = Math.sin(y * 0.25 + n1 * 8) * 0.5 + 0.5
      r += layer * 12
      g += layer * 8
      b += layer * 5

      // Dark crevices
      if (n1 < 0.25) { r *= 0.7; g *= 0.7; b *= 0.7 }

      const idx = i * 4
      data[idx] = Math.max(0, Math.min(255, r | 0))
      data[idx + 1] = Math.max(0, Math.min(255, g | 0))
      data[idx + 2] = Math.max(0, Math.min(255, b | 0))
      data[idx + 3] = 255
    }
  }
  return makeDataTexture(data, sz)
}

function generateDarkGrassTexture(): THREE.DataTexture {
  const sz = TEX_SIZE
  const noise1 = fbmNoise(sz, 1100, 5)
  const noise2 = fbmNoise(sz, 1200, 3)
  const data = new Uint8Array(sz * sz * 4)
  const rand = makeRand(444)

  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      const i = y * sz + x
      const n1 = noise1[i]
      const n2 = noise2[i]

      // Darker, richer green (elevated lush grass)
      let r = 30 + n1 * 35
      let g = 80 + n1 * 55 + n2 * 25
      let b = 28 + n1 * 20

      // Thicker blade texture
      const blade = Math.sin(x * 1.2 + n2 * 15) * 0.5 + 0.5
      g += blade * 15
      r -= blade * 3

      // Mushroom/flower spots
      if (rand() > 0.998) { r += 40; g += 10; b += 20 }

      const idx = i * 4
      data[idx] = Math.max(0, Math.min(255, r | 0))
      data[idx + 1] = Math.max(0, Math.min(255, g | 0))
      data[idx + 2] = Math.max(0, Math.min(255, b | 0))
      data[idx + 3] = 255
    }
  }
  return makeDataTexture(data, sz)
}

// ── Splat map generation (smooth blend weights) ──────────────

/**
 * Build a splat map texture from terrainType[].
 * We store blend weights for 6 terrain types across two RGBA textures:
 *   splatMap1: R=grass, G=dirt, B=rock, A=water
 *   splatMap2: R=cliff, G=darkGrass, B=unused, A=unused
 *
 * Blending is done with a Gaussian blur kernel over the terrain type grid
 * to produce smooth transitions between biomes.
 */
function generateSplatMaps(): { splat1: THREE.DataTexture; splat2: THREE.DataTexture } {
  const sz = GRID_RES

  // Raw one-hot weights per terrain type (6 channels)
  const raw = new Float32Array(sz * sz * 6)
  for (let i = 0; i < sz * sz; i++) {
    const t = terrainType[i]
    const channel = t < 6 ? t : 0
    raw[i * 6 + channel] = 1.0
  }

  // Gaussian blur for smooth transitions (radius 3)
  const BLUR_RADIUS = 3
  const blurred = new Float32Array(sz * sz * 6)

  // Build 1D Gaussian kernel
  const kernelSize = BLUR_RADIUS * 2 + 1
  const kernel = new Float32Array(kernelSize)
  const sigma = BLUR_RADIUS * 0.5
  let kernelSum = 0
  for (let k = 0; k < kernelSize; k++) {
    const d = k - BLUR_RADIUS
    kernel[k] = Math.exp(-0.5 * (d * d) / (sigma * sigma))
    kernelSum += kernel[k]
  }
  for (let k = 0; k < kernelSize; k++) kernel[k] /= kernelSum

  // Horizontal pass → temp
  const temp = new Float32Array(sz * sz * 6)
  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      for (let c = 0; c < 6; c++) {
        let sum = 0
        for (let k = -BLUR_RADIUS; k <= BLUR_RADIUS; k++) {
          const sx = Math.max(0, Math.min(sz - 1, x + k))
          sum += raw[(y * sz + sx) * 6 + c] * kernel[k + BLUR_RADIUS]
        }
        temp[(y * sz + x) * 6 + c] = sum
      }
    }
  }

  // Vertical pass → blurred
  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      for (let c = 0; c < 6; c++) {
        let sum = 0
        for (let k = -BLUR_RADIUS; k <= BLUR_RADIUS; k++) {
          const sy = Math.max(0, Math.min(sz - 1, y + k))
          sum += temp[(sy * sz + x) * 6 + c] * kernel[k + BLUR_RADIUS]
        }
        blurred[(y * sz + x) * 6 + c] = sum
      }
    }
  }

  // Normalize so weights sum to 1 and pack into RGBA textures
  const data1 = new Uint8Array(sz * sz * 4)
  const data2 = new Uint8Array(sz * sz * 4)

  for (let i = 0; i < sz * sz; i++) {
    let total = 0
    for (let c = 0; c < 6; c++) total += blurred[i * 6 + c]
    if (total < 0.001) total = 1

    // splat1: grass, dirt, rock, water
    data1[i * 4 + 0] = Math.round((blurred[i * 6 + 0] / total) * 255)  // T_GRASS
    data1[i * 4 + 1] = Math.round((blurred[i * 6 + 1] / total) * 255)  // T_DIRT
    data1[i * 4 + 2] = Math.round((blurred[i * 6 + 2] / total) * 255)  // T_ROCK
    data1[i * 4 + 3] = Math.round((blurred[i * 6 + 3] / total) * 255)  // T_WATER

    // splat2: cliff, dark_grass, (unused), (unused)
    data2[i * 4 + 0] = Math.round((blurred[i * 6 + 4] / total) * 255)  // T_CLIFF
    data2[i * 4 + 1] = Math.round((blurred[i * 6 + 5] / total) * 255)  // T_DARK_GRASS
    data2[i * 4 + 2] = 0
    data2[i * 4 + 3] = 255
  }

  const makeSplatTex = (d: Uint8Array) => {
    const tex = new THREE.DataTexture(d as unknown as BufferSource, sz, sz, THREE.RGBAFormat)
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    tex.magFilter = THREE.LinearFilter
    tex.minFilter = THREE.LinearFilter
    tex.needsUpdate = true
    return tex
  }

  return { splat1: makeSplatTex(data1), splat2: makeSplatTex(data2) }
}

// ── Terrain shader ───────────────────────────────────────────

const terrainVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;

  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormal = normalize(normalMatrix * normal);
    vHeight = position.y;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const terrainFragmentShader = /* glsl */ `
  uniform sampler2D splatMap1;  // R=grass G=dirt B=rock A=water
  uniform sampler2D splatMap2;  // R=cliff G=darkGrass
  uniform sampler2D texGrass;
  uniform sampler2D texDirt;
  uniform sampler2D texRock;
  uniform sampler2D texCliff;
  uniform sampler2D texDarkGrass;
  uniform sampler2D texSand;

  uniform float mapSize;
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform vec3 ambientColor;
  uniform float time;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;

  // Triplanar mapping to avoid UV stretch on steep surfaces
  vec4 triplanar(sampler2D tex, vec3 worldPos, vec3 normal, float scale) {
    vec3 blending = abs(normal);
    blending = normalize(max(blending, 0.00001));
    float b = blending.x + blending.y + blending.z;
    blending /= b;

    vec4 xaxis = texture2D(tex, worldPos.yz * scale);
    vec4 yaxis = texture2D(tex, worldPos.xz * scale);
    vec4 zaxis = texture2D(tex, worldPos.xy * scale);

    return xaxis * blending.x + yaxis * blending.y + zaxis * blending.z;
  }

  void main() {
    // Sample splat weights using UV (maps directly to terrain grid)
    vec4 splat1 = texture2D(splatMap1, vUv);
    vec4 splat2 = texture2D(splatMap2, vUv);

    float wGrass     = splat1.r;
    float wDirt      = splat1.g;
    float wRock      = splat1.b;
    float wWater     = splat1.a;
    float wCliff     = splat2.r;
    float wDarkGrass = splat2.g;

    // Texture scale (tiles per world unit)
    float baseScale = 0.12;
    float cliffScale = 0.15;

    // For steep surfaces (cliffs), use triplanar; for flat, use world XZ
    float steepness = 1.0 - abs(vNormal.y);

    // Sample each biome texture
    vec4 cGrass, cDirt, cRock, cCliff, cDarkGrass, cSand;

    if (steepness > 0.5) {
      // Triplanar for steep surfaces
      cGrass     = triplanar(texGrass, vWorldPos, vNormal, baseScale);
      cDirt      = triplanar(texDirt, vWorldPos, vNormal, baseScale);
      cRock      = triplanar(texRock, vWorldPos, vNormal, baseScale);
      cCliff     = triplanar(texCliff, vWorldPos, vNormal, cliffScale);
      cDarkGrass = triplanar(texDarkGrass, vWorldPos, vNormal, baseScale);
      cSand      = triplanar(texSand, vWorldPos, vNormal, baseScale);
    } else {
      vec2 uvWorld = vWorldPos.xz * baseScale;
      cGrass     = texture2D(texGrass, uvWorld);
      cDirt      = texture2D(texDirt, uvWorld);
      cRock      = texture2D(texRock, uvWorld);
      cCliff     = texture2D(texCliff, vWorldPos.xz * cliffScale);
      cDarkGrass = texture2D(texDarkGrass, uvWorld);
      cSand      = texture2D(texSand, uvWorld);
    }

    // Water regions: blend sand texture for the shore/ground under water
    // instead of showing grass underwater
    vec4 cWaterGround = cSand;

    // Blend all biomes
    vec3 albedo = cGrass.rgb * wGrass
                + cDirt.rgb * wDirt
                + cRock.rgb * wRock
                + cWaterGround.rgb * wWater
                + cCliff.rgb * wCliff
                + cDarkGrass.rgb * wDarkGrass;

    // Height-based variation: darken valleys, lighten peaks
    float heightFactor = smoothstep(-2.0, 12.0, vHeight);
    albedo *= mix(0.82, 1.1, heightFactor);

    // Slope darkening (crevices are darker)
    float slopeFactor = mix(1.0, 0.7, smoothstep(0.3, 0.8, steepness));
    albedo *= slopeFactor;

    // ── Lighting ──
    vec3 N = normalize(vNormal);
    vec3 L = normalize(sunDir);
    float NdotL = max(dot(N, L), 0.0);

    // Simple diffuse + ambient
    vec3 diffuse = sunColor * NdotL;
    vec3 ambient = ambientColor;

    // Rim lighting for depth
    vec3 V = normalize(cameraPosition - vWorldPos);
    float rim = 1.0 - max(dot(N, V), 0.0);
    rim = smoothstep(0.5, 1.0, rim) * 0.15;

    vec3 lighting = ambient + diffuse + vec3(rim * 0.3, rim * 0.35, rim * 0.5);
    vec3 color = albedo * lighting;

    // Fog (match scene fog)
    float fogDist = length(vWorldPos - cameraPosition);
    float fogFactor = 1.0 - exp(-fogDist * 0.004 * fogDist * 0.004);
    vec3 fogColor = vec3(0.56, 0.67, 0.72);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
  }
`

// ── Water shader ─────────────────────────────────────────────

const waterVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  uniform float time;

  void main() {
    vUv = uv;
    vec3 pos = position;

    // Gentle wave displacement
    float wave1 = sin(pos.x * 0.3 + time * 1.2) * cos(pos.z * 0.2 + time * 0.8) * 0.15;
    float wave2 = sin(pos.x * 0.7 - time * 0.9) * cos(pos.z * 0.5 + time * 1.1) * 0.08;
    float wave3 = sin(pos.x * 1.5 + pos.z * 1.3 + time * 2.0) * 0.04;
    pos.y += wave1 + wave2 + wave3;

    // Perturb normal based on wave derivatives
    float dx = cos(pos.x * 0.3 + time * 1.2) * 0.3 * cos(pos.z * 0.2 + time * 0.8) * 0.15
             + cos(pos.x * 0.7 - time * 0.9) * 0.7 * cos(pos.z * 0.5 + time * 1.1) * 0.08;
    float dz = sin(pos.x * 0.3 + time * 1.2) * (-sin(pos.z * 0.2 + time * 0.8)) * 0.2 * 0.15
             + sin(pos.x * 0.7 - time * 0.9) * (-sin(pos.z * 0.5 + time * 1.1)) * 0.5 * 0.08;
    vNormal = normalize(vec3(-dx, 1.0, -dz));

    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const waterFragmentShader = /* glsl */ `
  uniform float time;
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform float mapSize;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  // Simple hash for caustics pattern
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float causticPattern(vec2 uv, float t) {
    vec2 p = uv * 8.0;
    float c = 0.0;

    // Layer 1
    vec2 i = floor(p);
    vec2 f = fract(p);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 neighbor = vec2(float(x), float(y));
        vec2 point = vec2(hash(i + neighbor), hash(i + neighbor + 17.0));
        point = 0.5 + 0.5 * sin(t * 0.6 + 6.2831 * point);
        float d = length(neighbor + point - f);
        c += exp(-4.0 * d);
      }
    }

    return c / 9.0;
  }

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 L = normalize(sunDir);

    // Fresnel: more reflective at grazing angles
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    fresnel = mix(0.15, 0.85, fresnel);

    // Deep water color
    vec3 deepColor = vec3(0.02, 0.12, 0.28);
    // Shallow/surface color
    vec3 shallowColor = vec3(0.05, 0.30, 0.45);

    // Distance from center affects depth perception
    float edgeDist = length(vWorldPos.xz) / (mapSize * 0.5);
    float depthBlend = smoothstep(0.3, 1.0, edgeDist);
    vec3 waterColor = mix(shallowColor, deepColor, depthBlend * 0.5);

    // Caustics
    vec2 causticUV = vWorldPos.xz * 0.03;
    float c1 = causticPattern(causticUV + vec2(time * 0.02, time * 0.01), time);
    float c2 = causticPattern(causticUV * 1.3 + vec2(-time * 0.015, time * 0.02), time * 0.7);
    float caustic = (c1 + c2) * 0.5;
    caustic = pow(caustic, 1.5) * 0.6;

    waterColor += vec3(caustic * 0.15, caustic * 0.25, caustic * 0.3);

    // Ripple rings (emanating from random points)
    float ripple = 0.0;
    for (int i = 0; i < 3; i++) {
      vec2 center = vec2(
        sin(float(i) * 2.4 + time * 0.1) * 30.0,
        cos(float(i) * 3.1 + time * 0.13) * 30.0
      );
      float d = length(vWorldPos.xz - center);
      float ring = sin(d * 1.5 - time * 3.0) * exp(-d * 0.04);
      ripple += ring * 0.02;
    }
    waterColor += vec3(ripple);

    // Specular highlight (sun reflection)
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 128.0);
    vec3 specular = sunColor * spec * 1.5;

    // Sky reflection tint
    vec3 skyReflect = vec3(0.45, 0.55, 0.70) * fresnel * 0.5;

    // Diffuse lighting
    float NdotL = max(dot(N, L), 0.0);
    vec3 diffuse = waterColor * (0.3 + 0.7 * NdotL);

    vec3 color = diffuse + specular + skyReflect;

    // Fog
    float fogDist = length(vWorldPos - cameraPosition);
    float fogFactor = 1.0 - exp(-fogDist * 0.004 * fogDist * 0.004);
    vec3 fogColor = vec3(0.56, 0.67, 0.72);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    // Transparency: more opaque in deep areas, more transparent near edges
    float alpha = mix(0.55, 0.85, fresnel);
    alpha = mix(alpha, alpha * 0.7, smoothstep(0.0, 0.5, 1.0 - depthBlend));

    gl_FragColor = vec4(color, alpha);
  }
`

// ── Water animation state ────────────────────────────────────

let waterUniforms: { [key: string]: THREE.IUniform } | null = null

/**
 * Call every frame to animate the water surface.
 * @param dt delta time in seconds (unused — we use elapsed clock time)
 */
export function updateWater(_dt: number) {
  if (waterUniforms) {
    waterUniforms.time.value += _dt
  }
}

// ── Main terrain creation ────────────────────────────────────

export function createTerrainMesh(): THREE.Mesh {
  // ── 1. Build geometry from heightmap ──
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

    const h = heightData[cgz * GRID_RES + cgx]
    pos.setY(i, h)
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()

  // ── 2. Generate procedural textures ──
  const texGrass = generateGrassTexture()
  const texDirt = generateDirtTexture()
  const texSand = generateSandTexture()
  const texRock = generateRockTexture()
  const texCliff = generateCliffTexture()
  const texDarkGrass = generateDarkGrassTexture()

  // ── 3. Generate splat blend maps ──
  const { splat1, splat2 } = generateSplatMaps()

  // ── 4. Build ShaderMaterial ──
  const sunDir = new THREE.Vector3(60, 100, 40).normalize()

  const terrainUniforms = {
    splatMap1: { value: splat1 },
    splatMap2: { value: splat2 },
    texGrass: { value: texGrass },
    texDirt: { value: texDirt },
    texRock: { value: texRock },
    texCliff: { value: texCliff },
    texDarkGrass: { value: texDarkGrass },
    texSand: { value: texSand },
    mapSize: { value: MAP_SIZE },
    sunDir: { value: sunDir },
    sunColor: { value: new THREE.Color(1.0, 0.95, 0.85) },
    ambientColor: { value: new THREE.Color(0.25, 0.28, 0.35) },
    time: { value: 0 },
  }

  const mat = new THREE.ShaderMaterial({
    uniforms: terrainUniforms,
    vertexShader: terrainVertexShader,
    fragmentShader: terrainFragmentShader,
    side: THREE.FrontSide,
  })

  terrainMesh = new THREE.Mesh(geo, mat)
  terrainMesh.receiveShadow = true
  scene.add(terrainMesh)

  // ── 5. Create animated water mesh ──
  const waterSegments = 128
  const waterGeo = new THREE.PlaneGeometry(MAP_SIZE * 1.2, MAP_SIZE * 1.2, waterSegments, waterSegments)
  waterGeo.rotateX(-Math.PI / 2)

  waterUniforms = {
    time: { value: 0 },
    sunDir: { value: sunDir },
    sunColor: { value: new THREE.Color(1.0, 0.95, 0.85) },
    mapSize: { value: MAP_SIZE },
  }

  const waterMat = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: waterVertexShader,
    fragmentShader: waterFragmentShader,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  })

  waterMesh = new THREE.Mesh(waterGeo, waterMat)
  waterMesh.position.y = -1.2
  waterMesh.renderOrder = 1
  scene.add(waterMesh)

  return terrainMesh
}
