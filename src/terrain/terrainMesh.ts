import * as THREE from 'three'
import { MAP_SIZE } from '../game/config'
import {
  GRID_RES, heightData, terrainType,
  T_GRASS, T_DIRT, T_ROCK, T_WATER, T_CLIFF, T_DARK_GRASS,
} from './heightmap'
import { scene } from '../render/engine'

export let terrainMesh: THREE.Mesh
export let waterMesh: THREE.Mesh

/** Replace a terrain texture at runtime (slot: 'grass'|'dirt'|'rock'|'cliff') */
export function replaceTerrainTexture(slot: string, url: string) {
  if (!terrainMesh) return
  const mat = terrainMesh.material as THREE.ShaderMaterial
  const uniformName = 'tex' + slot.charAt(0).toUpperCase() + slot.slice(1)
  const uniform = mat.uniforms[uniformName]
  if (!uniform) return
  const loader = new THREE.TextureLoader()
  const tex = loader.load(url)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.colorSpace = THREE.SRGBColorSpace
  // Dispose old texture
  if (uniform.value) uniform.value.dispose()
  uniform.value = tex
}

let waterUniforms: { time: { value: number } } | null = null
export function updateWater(dt: number) {
  if (waterUniforms) waterUniforms.time.value += dt
}

// Splat weights computed per-vertex in createTerrainMesh (no texture needed)

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
  // Geometry with per-vertex splat weights (no texture UV issues)
  const geo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, GRID_RES - 1, GRID_RES - 1)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position

  // Blur terrain types for smooth biome transitions (5x5 kernel)
  const blurred = new Float32Array(GRID_RES * GRID_RES * 4)
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      let r = 0, g = 0, b = 0, a = 0, w = 0
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = Math.max(0, Math.min(GRID_RES - 1, gx + dx))
          const nz = Math.max(0, Math.min(GRID_RES - 1, gz + dz))
          const tt = terrainType[nz * GRID_RES + nx]
          const wt = (dx === 0 && dz === 0) ? 4 : (Math.abs(dx) + Math.abs(dz) === 1) ? 2 : 1
          r += ((tt === T_GRASS || tt === T_DARK_GRASS) ? 1 : 0) * wt
          g += ((tt === T_DIRT) ? 1 : 0) * wt
          b += ((tt === T_ROCK || tt === T_WATER) ? 1 : 0) * wt
          a += ((tt === T_CLIFF) ? 1 : 0) * wt
          w += wt
        }
      }
      const di = (gz * GRID_RES + gx) * 4
      blurred[di] = r/w; blurred[di+1] = g/w; blurred[di+2] = b/w; blurred[di+3] = a/w
    }
  }

  // Encode splat weights directly as vertex attribute
  const splatWeights = new Float32Array(pos.count * 4)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    const gx = Math.round((x + MAP_SIZE/2) / (MAP_SIZE/(GRID_RES-1)))
    const gz = Math.round((z + MAP_SIZE/2) / (MAP_SIZE/(GRID_RES-1)))
    const cgx = Math.max(0, Math.min(GRID_RES-1, gx))
    const cgz = Math.max(0, Math.min(GRID_RES-1, gz))

    pos.setY(i, heightData[cgz * GRID_RES + cgx])

    const si = (cgz * GRID_RES + cgx) * 4
    const sum = blurred[si] + blurred[si+1] + blurred[si+2] + blurred[si+3]
    const inv = sum > 0.001 ? 1/sum : 0
    splatWeights[i*4]   = blurred[si] * inv
    splatWeights[i*4+1] = blurred[si+1] * inv
    splatWeights[i*4+2] = blurred[si+2] * inv
    splatWeights[i*4+3] = blurred[si+3] * inv
  }
  pos.needsUpdate = true
  geo.setAttribute('aSplat', new THREE.BufferAttribute(splatWeights, 4))
  geo.computeVertexNormals()

  // Get sun direction
  let sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize()
  scene.traverse((obj) => {
    if ((obj as THREE.DirectionalLight).isDirectionalLight && (obj as THREE.DirectionalLight).castShadow) {
      sunDir = (obj as THREE.DirectionalLight).position.clone().normalize()
    }
  })

  const customUniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    {
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
      attribute vec4 aSplat;
      varying vec4 vSplat;
      varying vec2 vTileUV;
      varying vec3 vNorm;
      varying float vHeight;

      #include <common>
      #include <shadowmap_pars_vertex>

      void main() {
        vSplat = aSplat;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vTileUV = worldPosition.xz * 0.1;
        vHeight = worldPosition.y;
        vNorm = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

        gl_Position = projectionMatrix * viewMatrix * worldPosition;

        vec3 transformedNormal = vNorm;
        #include <shadowmap_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D texGrass, texDirt, texRock, texCliff;
      uniform vec3 sunDir;

      varying vec4 vSplat;
      varying vec2 vTileUV;
      varying vec3 vNorm;
      varying float vHeight;

      #include <common>
      #include <packing>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>

      void main() {
        vec3 n = normalize(vNorm);

        vec3 tg = texture2D(texGrass, vTileUV).rgb;
        vec3 td = texture2D(texDirt,  vTileUV).rgb;
        vec3 tr = texture2D(texRock,  vTileUV * 0.7).rgb;
        // Cliff: triplanar projection for steep surfaces (avoids stretching)
        vec3 tcXY = texture2D(texCliff, vTileUV * 0.5).rgb;
        vec3 tcXZ = texture2D(texCliff, vec2(vTileUV.x, vHeight * 0.08) * 0.5).rgb;
        vec3 tcYZ = texture2D(texCliff, vec2(vTileUV.y, vHeight * 0.08) * 0.5).rgb;
        vec3 blend = abs(n);
        blend = blend / (blend.x + blend.y + blend.z + 0.001);
        vec3 tc = tcXZ * blend.y + tcXY * blend.z + tcYZ * blend.x;

        // Base painted albedo from splat weights
        vec3 painted = tg * vSplat.r + td * vSplat.g + tr * vSplat.b + tc * vSplat.a;

        // Slope-based cliff override: steep surfaces get cliff texture automatically
        // n.y = 1.0 for flat, 0.0 for vertical
        // Start blending cliff at ~35° (n.y < 0.82), full cliff at ~55° (n.y < 0.57)
        float slopeFactor = 1.0 - smoothstep(0.57, 0.82, n.y);
        vec3 albedo = mix(painted, tc, slopeFactor);

        float ndl = max(dot(n, sunDir), 0.0);
        float hf = 0.9 + clamp(vHeight * 0.015, 0.0, 0.2);

        float shadow = getShadowMask();

        vec3 col = albedo * (0.35 + 0.65 * ndl * shadow) * hf;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })

  terrainMesh = new THREE.Mesh(geo, mat)
  terrainMesh.castShadow = true
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
      varying float vWaveHeight;
      void main() {
        vShoreDist = color.r;
        vIsWater = color.g;
        vPoolSize = color.b;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xz;

        // Open water: gentle sway
        float openWave = sin(wp.x * 0.4 + time * 0.7) * 0.03
                       + sin(wp.z * 0.3 + time * 0.5) * 0.02;

        // Shore wave: water rises when foam approaches shore, falls when it recedes
        float waveZone = mix(0.15, 0.8, smoothstep(0.1, 0.7, vPoolSize));
        float wavePhase = vShoreDist / max(waveZone, 0.01);
        float shoreWave = sin(wavePhase * 12.0 + time * 1.2) * 0.5 + 0.5;
        // Only near shore, scaled by proximity
        float shoreInfluence = smoothstep(0.4, 0.0, vShoreDist);
        float tideRise = shoreWave * shoreInfluence * 0.15;

        wp.y += openWave + tideRise;
        vWaveHeight = shoreWave;
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
      varying float vWaveHeight;

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
        // Subtle caustic lines
        float caustic = pow(1.0 - v1, 4.0) * 0.2 + pow(1.0 - v2, 4.0) * 0.15;
        float v3 = voronoi(vWorld * 0.8 + vec2(time * 0.08, -time * 0.12));
        caustic += pow(1.0 - v3, 5.0) * 0.08;

        // === Shore foam — sharp near coast, blurry far away ===
        float waveZone = mix(0.15, 0.8, smoothstep(0.1, 0.7, vPoolSize));
        float wavePhase = vShoreDist / max(waveZone, 0.01);

        // Shore proximity: 1.0 at coast, 0.0 far away
        float shoreProx = smoothstep(0.6, 0.0, wavePhase) * smoothstep(0.0, 0.03, vShoreDist);

        // Animated wave crest — sharper when close to shore
        float waveLine = sin(wavePhase * 12.0 + time * 1.2) * 0.5 + 0.5;
        // Close to shore: sharp (pow 6), far from shore: soft (pow 1.5)
        float sharpness = mix(1.5, 6.0, smoothstep(0.3, 0.0, vShoreDist));
        waveLine = pow(waveLine, sharpness);

        // Foam texture: bubbly detail visible near shore, blurred far
        float detailScale = mix(2.0, 10.0, smoothstep(0.4, 0.0, vShoreDist));
        float foam1 = noise(vWorld * detailScale + time * 0.12);
        float foam2 = noise(vWorld * (detailScale * 0.6) - time * 0.08);
        // Sharp threshold near shore, soft blend far
        float threshold = mix(0.2, 0.45, smoothstep(0.3, 0.0, vShoreDist));
        float foamTex = smoothstep(threshold, threshold + 0.15, foam1)
                       * smoothstep(threshold, threshold + 0.2, foam2);

        // Combine wave + texture
        float foam = waveLine * shoreProx * mix(0.3, 0.9, foamTex);

        // Hard foam edge right at coastline (always sharp)
        float edgeFoam = smoothstep(0.06, 0.0, vShoreDist) * 0.8;
        foam = max(foam, edgeFoam);

        // === Final color ===
        vec3 col = deepColor + caustic * vec3(0.15, 0.22, 0.28);
        col = mix(col, foamColor, foam);

        // Transparency layers:
        // 1. Deep water base opacity
        float depthAlpha = mix(0.45, 0.85, smoothstep(0.5, 0.0, vShoreDist));
        // 2. Shore edge fade: water smoothly disappears at coastline
        float edgeFade = smoothstep(0.0, 0.06, vShoreDist);
        // 3. Foam makes water more opaque where visible
        float foamOpacity = foam * 0.4;

        float alpha = depthAlpha * edgeFade + foamOpacity;
        alpha = clamp(alpha, 0.0, 0.95);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  })

  waterMesh = new THREE.Mesh(g, m)
  waterMesh.renderOrder = 1
  scene.add(waterMesh)
}
