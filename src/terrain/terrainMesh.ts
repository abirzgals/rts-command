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
  // Create a shore mask texture: 1.0 = water, 0.0 = land
  // With gradient at edges for smooth shore transitions
  const maskData = new Uint8Array(GRID_RES * GRID_RES * 4)
  const isWater = new Uint8Array(GRID_RES * GRID_RES)

  // First pass: mark water cells
  for (let i = 0; i < GRID_RES * GRID_RES; i++) {
    isWater[i] = terrainType[i] === T_WATER ? 1 : 0
  }

  // Second pass: compute distance to nearest land (in cells, max 10)
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const idx = gz * GRID_RES + gx
      if (!isWater[idx]) {
        // Land: 0
        maskData[idx * 4] = 0
      } else {
        // Water: find distance to nearest land cell
        let minDist = 10
        for (let dz = -10; dz <= 10; dz++) {
          for (let dx = -10; dx <= 10; dx++) {
            const nx = gx + dx, nz = gz + dz
            if (nx < 0 || nx >= GRID_RES || nz < 0 || nz >= GRID_RES) continue
            if (!isWater[nz * GRID_RES + nx]) {
              const d = Math.sqrt(dx * dx + dz * dz)
              if (d < minDist) minDist = d
            }
          }
        }
        // 0 = at shore, 255 = deep (10+ cells from land)
        maskData[idx * 4] = Math.min(255, Math.round(minDist * 25.5))
      }
      maskData[idx * 4 + 1] = maskData[idx * 4]
      maskData[idx * 4 + 2] = maskData[idx * 4]
      maskData[idx * 4 + 3] = 255
    }
  }

  const maskTex = new THREE.DataTexture(maskData, GRID_RES, GRID_RES, THREE.RGBAFormat)
  maskTex.needsUpdate = true
  maskTex.minFilter = THREE.LinearFilter
  maskTex.magFilter = THREE.LinearFilter

  const waterLevel = -1.2
  const g = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 64, 64)
  g.rotateX(-Math.PI / 2)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setY(i, waterLevel)
  pos.needsUpdate = true

  waterUniforms = { time: { value: 0 } }

  const m = new THREE.ShaderMaterial({
    uniforms: {
      time: waterUniforms.time,
      shoreMask: { value: maskTex },
      deepColor:  { value: new THREE.Color(0.08, 0.22, 0.40) },
      shallowColor: { value: new THREE.Color(0.18, 0.48, 0.58) },
      foamColor:  { value: new THREE.Color(0.85, 0.92, 0.96) },
    },
    vertexShader: `
      uniform float time;
      varying vec2 vUv;
      varying vec2 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xz;
        wp.y += sin(wp.x * 0.4 + time * 0.7) * 0.03 + sin(wp.z * 0.3 + time * 0.5) * 0.02;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform sampler2D shoreMask;
      uniform vec3 deepColor, shallowColor, foamColor;
      varying vec2 vUv;
      varying vec2 vWorld;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                   mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
      }

      void main() {
        float dist = texture2D(shoreMask, vUv).r; // 0=land, >0=water

        // Discard land pixels
        if (dist < 0.01) discard;

        // Shore foam: only in first ~3 cells from land (dist 0.01 to ~0.12)
        // dist is encoded as cellDistance * 25.5 / 255, so 3 cells ≈ 0.3
        float shore = 1.0 - smoothstep(0.02, 0.12, dist);

        // Animated foam wave pattern at shore edge
        float foamWave = sin(shore * 15.0 - time * 2.5) * 0.5 + 0.5;
        float foamNoise = noise(vWorld * 0.5 + time * 0.15);
        float foam = shore * (0.5 + 0.5 * foamWave) * (0.6 + 0.4 * foamNoise);

        // Subtle caustics everywhere on water
        float c1 = noise(vWorld * 0.2 + vec2(time * 0.08));
        float c2 = noise(vWorld * 0.35 - vec2(time * 0.06, time * 0.1));
        float caustic = pow(c1 * c2, 1.5) * 0.2;

        // Water color: uniform deep color + subtle caustic shimmer
        vec3 col = deepColor + caustic * vec3(0.15, 0.2, 0.25);

        // Mix in white foam at shore
        col = mix(col, foamColor, foam * 0.8);

        // Constant opacity for all water
        float alpha = 0.7;

        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  })

  waterMesh = new THREE.Mesh(g, m)
  waterMesh.renderOrder = 1
  scene.add(waterMesh)
}
