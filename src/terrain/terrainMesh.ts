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

let waterUniforms: { time: { value: number } } | null = null
export function updateWater(dt: number) {
  if (waterUniforms) waterUniforms.time.value += dt
}

// ── Splat map: encode terrain type weights per vertex as a texture ───

function generateSplatMap(): THREE.DataTexture {
  // 4 channels: R=grass, G=dirt, B=rock, A=cliff
  // Gaussian blur for smooth transitions
  const raw = new Float32Array(GRID_RES * GRID_RES * 4)

  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const i = (gz * GRID_RES + gx) * 4
      const tt = terrainType[gz * GRID_RES + gx]
      // One-hot encoding
      raw[i]     = (tt === T_GRASS || tt === T_DARK_GRASS) ? 1 : 0 // R = grass
      raw[i + 1] = (tt === T_DIRT || tt === T_WATER) ? 1 : 0        // G = dirt/sand
      raw[i + 2] = (tt === T_ROCK) ? 1 : 0                          // B = rock
      raw[i + 3] = (tt === T_CLIFF) ? 1 : 0                         // A = cliff
    }
  }

  // Gaussian blur (3x3 kernel, 2 passes) for smooth transitions
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
            const weight = (dx === 0 && dz === 0) ? 4 : (dx === 0 || dz === 0) ? 2 : 1
            r += src[ni] * weight
            g += src[ni + 1] * weight
            b += src[ni + 2] * weight
            a += src[ni + 3] * weight
            w += weight
          }
        }
        const di = (gz * GRID_RES + gx) * 4
        dst[di] = r / w; dst[di + 1] = g / w; dst[di + 2] = b / w; dst[di + 3] = a / w
      }
    }
  }

  // Normalize so weights sum to 1
  const data = new Uint8Array(GRID_RES * GRID_RES * 4)
  for (let i = 0; i < GRID_RES * GRID_RES; i++) {
    const si = i * 4
    const sum = raw[si] + raw[si + 1] + raw[si + 2] + raw[si + 3]
    const inv = sum > 0.001 ? 255 / sum : 0
    data[si]     = Math.round(raw[si] * inv)
    data[si + 1] = Math.round(raw[si + 1] * inv)
    data[si + 2] = Math.round(raw[si + 2] * inv)
    data[si + 3] = Math.round(raw[si + 3] * inv)
  }

  const tex = new THREE.DataTexture(data, GRID_RES, GRID_RES, THREE.RGBAFormat)
  tex.needsUpdate = true
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  return tex
}

// ── Terrain shader (receives shadows via Three.js #include) ─────

const terrainVertexShader = `
  varying vec2 vUv;
  varying vec2 vWorldUV;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  #include <common>
  #include <shadowmap_pars_vertex>

  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldUV = worldPos.xz * 0.1; // tile textures every 10 world units
    vNormal = normalize(normalMatrix * normal);

    gl_Position = projectionMatrix * viewMatrix * worldPos;

    #include <beginnormal_vertex>
    #include <defaultnormal_vertex>
    #include <shadowmap_vertex>
  }
`

const terrainFragmentShader = `
  uniform sampler2D splatMap;
  uniform sampler2D texGrass;
  uniform sampler2D texDirt;
  uniform sampler2D texRock;
  uniform sampler2D texCliff;
  uniform vec3 sunDirection;

  varying vec2 vUv;
  varying vec2 vWorldUV;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  #include <common>
  #include <packing>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>

  void main() {
    // Sample splat weights
    vec4 splat = texture2D(splatMap, vUv);

    // Sample tiled textures at world UV
    vec3 grass = texture2D(texGrass, vWorldUV).rgb;
    vec3 dirt = texture2D(texDirt, vWorldUV).rgb;
    vec3 rock = texture2D(texRock, vWorldUV * 0.7).rgb;
    vec3 cliff = texture2D(texCliff, vWorldUV * 0.5).rgb;

    // Blend by splat weights
    vec3 albedo = grass * splat.r + dirt * splat.g + rock * splat.b + cliff * splat.a;

    // Simple lighting
    float NdotL = max(dot(vNormal, sunDirection), 0.0);
    float ambient = 0.35;
    float diffuse = NdotL * 0.65;

    // Shadow
    float shadow = getShadowMask();

    // Height-based variation
    float heightFade = 0.9 + clamp(vWorldPos.y * 0.015, 0.0, 0.2);

    vec3 color = albedo * (ambient + diffuse * shadow) * heightFade;

    // Fog
    float fogDist = length(vWorldPos - cameraPosition);
    float fog = 1.0 - exp(-fogDist * fogDist * 0.000012);
    vec3 fogColor = vec3(0.56, 0.67, 0.72);
    color = mix(color, fogColor, clamp(fog, 0.0, 0.7));

    gl_FragColor = vec4(color, 1.0);
  }
`

// ── Main terrain creation ───────────────────────────────────

export function createTerrainMesh(): THREE.Mesh {
  const loader = new THREE.TextureLoader()

  // Load textures with repeat wrapping
  function loadTex(url: string): THREE.Texture {
    const tex = loader.load(url)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  const texGrass = loadTex('/textures/grass.jpg')
  const texDirt = loadTex('/textures/dirt.jpg')
  const texRock = loadTex('/textures/rock.jpg')
  const texCliff = loadTex('/textures/cliff.jpg')

  // Build geometry from heightmap
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

  // Generate splat map
  const splatMap = generateSplatMap()

  // Get sun direction from scene
  let sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize()
  scene.traverse((obj) => {
    if ((obj as THREE.DirectionalLight).isDirectionalLight && (obj as THREE.DirectionalLight).castShadow) {
      sunDir = (obj as THREE.DirectionalLight).position.clone().normalize()
    }
  })

  // Custom shader material that receives shadows
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsLib.lights,
      splatMap: { value: splatMap },
      texGrass: { value: texGrass },
      texDirt: { value: texDirt },
      texRock: { value: texRock },
      texCliff: { value: texCliff },
      sunDirection: { value: sunDir },
    },
    vertexShader: terrainVertexShader,
    fragmentShader: terrainFragmentShader,
    lights: true,
  })

  terrainMesh = new THREE.Mesh(geo, mat)
  terrainMesh.receiveShadow = true
  terrainMesh.castShadow = false
  scene.add(terrainMesh)

  // Water
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
        float caustic = sin(vUv.x * 40.0 + time * 2.0) * sin(vUv.y * 40.0 + time * 1.5) * 0.5 + 0.5;
        caustic = pow(caustic, 3.0) * 0.3;
        vec3 col = waterColor + caustic * foamColor;
        float foam = smoothstep(0.2, 0.4, vWaveHeight) * 0.3;
        col = mix(col, foamColor, foam);
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
