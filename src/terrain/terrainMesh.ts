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

// ── Splat map from terrain types ────────────────────────────

function generateSplatMap(): THREE.DataTexture {
  const raw = new Float32Array(GRID_RES * GRID_RES * 4)
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const i = (gz * GRID_RES + gx) * 4
      const tt = terrainType[gz * GRID_RES + gx]
      raw[i]     = (tt === T_GRASS || tt === T_DARK_GRASS) ? 1 : 0
      raw[i + 1] = (tt === T_DIRT || tt === T_WATER) ? 1 : 0
      raw[i + 2] = (tt === T_ROCK) ? 1 : 0
      raw[i + 3] = (tt === T_CLIFF) ? 1 : 0
    }
  }
  // 2-pass blur
  const tmp = new Float32Array(raw.length)
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? raw : tmp
    const dst = pass === 0 ? tmp : raw
    for (let gz = 0; gz < GRID_RES; gz++) {
      for (let gx = 0; gx < GRID_RES; gx++) {
        let r = 0, g = 0, b = 0, a = 0, w = 0
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.max(0, Math.min(GRID_RES - 1, gx + dx))
            const nz = Math.max(0, Math.min(GRID_RES - 1, gz + dz))
            const ni = (nz * GRID_RES + nx) * 4
            const wt = (dx === 0 && dz === 0) ? 4 : (dx === 0 || dz === 0) ? 2 : 1
            r += src[ni] * wt; g += src[ni+1] * wt; b += src[ni+2] * wt; a += src[ni+3] * wt; w += wt
          }
        }
        const di = (gz * GRID_RES + gx) * 4
        dst[di] = r/w; dst[di+1] = g/w; dst[di+2] = b/w; dst[di+3] = a/w
      }
    }
  }
  const data = new Uint8Array(GRID_RES * GRID_RES * 4)
  for (let i = 0; i < GRID_RES * GRID_RES; i++) {
    const si = i * 4
    const sum = raw[si] + raw[si+1] + raw[si+2] + raw[si+3]
    const inv = sum > 0.001 ? 255 / sum : 0
    data[si] = raw[si]*inv; data[si+1] = raw[si+1]*inv; data[si+2] = raw[si+2]*inv; data[si+3] = raw[si+3]*inv
  }
  const tex = new THREE.DataTexture(data, GRID_RES, GRID_RES, THREE.RGBAFormat)
  tex.needsUpdate = true
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  return tex
}

// ── Main ────────────────────────────────────────────────────

export function createTerrainMesh(): THREE.Mesh {
  const loader = new THREE.TextureLoader()
  function loadTex(url: string): THREE.Texture {
    const t = loader.load(url)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.minFilter = THREE.LinearMipmapLinearFilter
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }

  const texGrass = loadTex('/textures/grass.jpg')
  const texDirt  = loadTex('/textures/dirt.jpg')
  const texRock  = loadTex('/textures/rock.jpg')
  const texCliff = loadTex('/textures/cliff.jpg')
  const splatMap = generateSplatMap()

  // Geometry
  const geo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, GRID_RES - 1, GRID_RES - 1)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    const gx = Math.round((x + MAP_SIZE/2) / (MAP_SIZE/(GRID_RES-1)))
    const gz = Math.round((z + MAP_SIZE/2) / (MAP_SIZE/(GRID_RES-1)))
    pos.setY(i, heightData[Math.max(0,Math.min(GRID_RES-1,gz)) * GRID_RES + Math.max(0,Math.min(GRID_RES-1,gx))])
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()

  // Get sun direction
  let sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize()
  scene.traverse((obj) => {
    if ((obj as THREE.DirectionalLight).isDirectionalLight && (obj as THREE.DirectionalLight).castShadow) {
      sunDir = (obj as THREE.DirectionalLight).position.clone().normalize()
    }
  })

  // Full custom ShaderMaterial with manual shadow sampling
  const customUniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    {
      splatMap: { value: splatMap },
      texGrass: { value: texGrass },
      texDirt:  { value: texDirt },
      texRock:  { value: texRock },
      texCliff: { value: texCliff },
      sunDir:   { value: sunDir },
    }
  ])

  const mat = new THREE.ShaderMaterial({
    uniforms: customUniforms,
    lights: true,
    vertexShader: /* glsl */ `
      varying vec2 vSplatUV;
      varying vec2 vTileUV;
      varying vec3 vNorm;
      varying float vHeight;

      #include <common>
      #include <shadowmap_pars_vertex>

      void main() {
        vSplatUV = uv;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vTileUV = worldPosition.xz * 0.1;
        vHeight = worldPosition.y;
        vNorm = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

        gl_Position = projectionMatrix * viewMatrix * worldPosition;

        // Variables required by shadowmap_vertex include
        vec3 transformedNormal = vNorm;
        #include <shadowmap_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D splatMap, texGrass, texDirt, texRock, texCliff;
      uniform vec3 sunDir;

      varying vec2 vSplatUV, vTileUV;
      varying vec3 vNorm;
      varying float vHeight;

      #include <common>
      #include <packing>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>

      void main() {
        vec4 sp = texture2D(splatMap, vSplatUV);
        vec3 tg = texture2D(texGrass, vTileUV).rgb;
        vec3 td = texture2D(texDirt,  vTileUV).rgb;
        vec3 tr = texture2D(texRock,  vTileUV * 0.7).rgb;
        vec3 tc = texture2D(texCliff, vTileUV * 0.5).rgb;
        vec3 albedo = tg * sp.r + td * sp.g + tr * sp.b + tc * sp.a;

        float ndl = max(dot(normalize(vNorm), sunDir), 0.0);
        float hf = 0.9 + clamp(vHeight * 0.015, 0.0, 0.2);

        // Try shadow mask, fallback to 1.0
        float shadow = getShadowMask();

        vec3 col = albedo * (0.35 + 0.65 * ndl * shadow) * hf;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })

  terrainMesh = new THREE.Mesh(geo, mat)
  terrainMesh.receiveShadow = true
  scene.add(terrainMesh)

  createWater()
  return terrainMesh
}

// ── Water ───────────────────────────────────────────────────

function createWater() {
  const waterLevel = -1.2

  // Precompute per-grid-cell: is this water? distance to nearest land?
  const isWaterCell = new Uint8Array(GRID_RES * GRID_RES)
  for (let i = 0; i < GRID_RES * GRID_RES; i++) {
    isWaterCell[i] = terrainType[i] === T_WATER ? 1 : 0
  }

  // Distance to shore per cell (search radius 8 cells)
  const shoreDist = new Float32Array(GRID_RES * GRID_RES)
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const idx = gz * GRID_RES + gx
      if (!isWaterCell[idx]) { shoreDist[idx] = -1; continue }
      let minD = 99
      for (let dz = -8; dz <= 8; dz++) {
        for (let dx = -8; dx <= 8; dx++) {
          const nx = gx + dx, nz = gz + dz
          if (nx < 0 || nx >= GRID_RES || nz < 0 || nz >= GRID_RES) { minD = Math.min(minD, Math.sqrt(dx*dx+dz*dz)); continue }
          if (!isWaterCell[nz * GRID_RES + nx]) minD = Math.min(minD, Math.sqrt(dx*dx+dz*dz))
        }
      }
      shoreDist[idx] = minD
    }
  }

  // Flood-fill to find max depth per water body (= pool size)
  const poolMaxDist = new Float32Array(GRID_RES * GRID_RES)
  const visited = new Uint8Array(GRID_RES * GRID_RES)
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const idx = gz * GRID_RES + gx
      if (!isWaterCell[idx] || visited[idx]) continue
      // BFS to find all cells of this water body + max shore dist
      const queue: number[] = [idx]
      const body: number[] = []
      visited[idx] = 1
      let maxD = 0
      while (queue.length > 0) {
        const ci = queue.pop()!
        body.push(ci)
        if (shoreDist[ci] > maxD) maxD = shoreDist[ci]
        const cx = ci % GRID_RES, cz = (ci / GRID_RES) | 0
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx, nz = cz + dz
          if (nx < 0 || nx >= GRID_RES || nz < 0 || nz >= GRID_RES) continue
          const ni = nz * GRID_RES + nx
          if (!isWaterCell[ni] || visited[ni]) continue
          visited[ni] = 1
          queue.push(ni)
        }
      }
      // Set max depth for all cells in this body
      for (const ci of body) poolMaxDist[ci] = maxD
    }
  }

  // Build water mesh with per-vertex shore distance as vertex color
  const g = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, GRID_RES - 1, GRID_RES - 1)
  g.rotateX(-Math.PI / 2)
  const pos = g.attributes.position
  const colors = new Float32Array(pos.count * 3)

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    pos.setY(i, waterLevel)

    const gx = Math.round((x + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const gz = Math.round((z + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const cgx = Math.max(0, Math.min(GRID_RES - 1, gx))
    const cgz = Math.max(0, Math.min(GRID_RES - 1, gz))
    const idx = cgz * GRID_RES + cgx

    const d = shoreDist[idx]
    // R = shore distance normalized, G = is water, B = pool max depth normalized
    if (d < 0) {
      colors[i * 3] = 0; colors[i * 3 + 1] = 0; colors[i * 3 + 2] = 0
    } else {
      colors[i * 3] = Math.min(1, d / 8)                    // shore distance
      colors[i * 3 + 1] = 1                                  // is water
      colors[i * 3 + 2] = Math.min(1, poolMaxDist[idx] / 8) // pool size
    }
  }
  pos.needsUpdate = true
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  waterUniforms = { time: { value: 0 } }

  const m = new THREE.ShaderMaterial({
    uniforms: {
      time: waterUniforms.time,
      deepColor: { value: new THREE.Color(0.08, 0.22, 0.40) },
      foamColor: { value: new THREE.Color(0.85, 0.92, 0.96) },
    },
    vertexShader: `
      uniform float time;
      attribute vec3 color;
      varying float vShoreDist;
      varying float vIsWater;
      varying float vPoolSize;
      varying vec2 vWorld;
      void main() {
        vShoreDist = color.r;
        vIsWater = color.g;
        vPoolSize = color.b;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xz;
        wp.y += sin(wp.x * 0.4 + time * 0.7) * 0.03 + sin(wp.z * 0.3 + time * 0.5) * 0.02;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform vec3 deepColor, foamColor;
      varying float vShoreDist;
      varying float vIsWater;
      varying float vPoolSize;
      varying vec2 vWorld;

      // Hash and value noise
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      vec2 hash2(vec2 p) {
        return fract(sin(vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                   mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
      }

      // Voronoi for caustic light lines
      float voronoi(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        float minD = 1.0;
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec2 n = vec2(float(x), float(y));
            vec2 r = n + hash2(i + n) - f;
            minD = min(minD, dot(r, r));
          }
        }
        return sqrt(minD);
      }

      void main() {
        if (vIsWater < 0.5) discard;

        // === Voronoi caustic pattern (sharp light lines) ===
        // Two layers moving in opposite directions for interference
        float v1 = voronoi(vWorld * 0.4 + vec2(time * 0.15, time * 0.1));
        float v2 = voronoi(vWorld * 0.35 - vec2(time * 0.12, time * 0.08));
        // Sharp bright lines at cell edges (where voronoi distance is small)
        float caustic = pow(1.0 - v1, 4.0) * 0.5 + pow(1.0 - v2, 4.0) * 0.4;
        // Third finer layer for detail
        float v3 = voronoi(vWorld * 0.8 + vec2(time * 0.08, -time * 0.12));
        caustic += pow(1.0 - v3, 5.0) * 0.2;

        // === Shore waves — scale with pool size ===
        // Small pool (vPoolSize < 0.3): tiny wave band
        // Large pool (vPoolSize > 0.6): wide wave band
        float waveZone = mix(0.15, 0.8, smoothstep(0.1, 0.7, vPoolSize));

        // Wave runs toward shore, strength proportional to wave zone
        float wavePhase = vShoreDist / max(waveZone, 0.01);
        float wave = sin(wavePhase * 12.0 + time * 1.2) * 0.5 + 0.5;
        // Grows approaching shore, fades at the very edge
        float waveStrength = smoothstep(1.0, 0.2, wavePhase) * smoothstep(0.0, 0.06, vShoreDist);
        float foamNoise = noise(vWorld * 0.5 + time * 0.1);
        float foam = wave * waveStrength * (0.5 + 0.5 * foamNoise);

        // === Final color ===
        vec3 col = deepColor + caustic * vec3(0.25, 0.35, 0.4);
        col = mix(col, foamColor, foam);

        gl_FragColor = vec4(col, 0.7);
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  })

  waterMesh = new THREE.Mesh(g, m)
  waterMesh.renderOrder = 1
  scene.add(waterMesh)
}
