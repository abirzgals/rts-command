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
  // Encode terrain height into RGBA texture (R channel, 0-255)
  const waterLevel = -1.2
  const hmData = new Uint8Array(GRID_RES * GRID_RES * 4)
  for (let i = 0; i < GRID_RES * GRID_RES; i++) {
    // 0 = far below water, 128 = at water level, 255 = high above water
    const v = Math.max(0, Math.min(255, Math.round((heightData[i] - waterLevel) * 8 + 128)))
    hmData[i * 4] = v
    hmData[i * 4 + 1] = v
    hmData[i * 4 + 2] = v
    hmData[i * 4 + 3] = 255
  }
  const hmTex = new THREE.DataTexture(hmData, GRID_RES, GRID_RES, THREE.RGBAFormat)
  hmTex.needsUpdate = true
  hmTex.minFilter = THREE.LinearFilter
  hmTex.magFilter = THREE.LinearFilter

  const g = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 64, 64)
  g.rotateX(-Math.PI / 2)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setY(i, waterLevel)
  pos.needsUpdate = true

  waterUniforms = { time: { value: 0 } }

  const m = new THREE.ShaderMaterial({
    uniforms: {
      time: waterUniforms.time,
      heightMap: { value: hmTex },
      deepColor:  { value: new THREE.Color(0.10, 0.25, 0.45) },
      shallowColor: { value: new THREE.Color(0.20, 0.50, 0.60) },
      foamColor:  { value: new THREE.Color(0.85, 0.92, 0.97) },
    },
    vertexShader: `
      uniform float time;
      varying vec2 vUv;
      varying vec2 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xz;
        // Very subtle ripple
        wp.y += sin(wp.x * 0.4 + time * 0.7) * 0.03 + sin(wp.z * 0.3 + time * 0.5) * 0.02;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform sampler2D heightMap;
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
        float h = texture2D(heightMap, vUv).r; // 0-1, 0.5 = water level

        // Land check: if terrain is above water, make fully transparent
        if (h > 0.55) discard;

        // Shore proximity: strongest at waterline (h ≈ 0.5)
        float shore = smoothstep(0.35, 0.50, h); // 0=deep, 1=at shoreline

        // Animated shore foam
        float foamWave = sin(shore * 25.0 - time * 2.5) * 0.5 + 0.5;
        float foamNoise = noise(vWorld * 0.4 + time * 0.15);
        float foam = shore * shore * (0.5 + 0.5 * foamWave * foamNoise);

        // Caustics
        float c1 = noise(vWorld * 0.25 + vec2(time * 0.12));
        float c2 = noise(vWorld * 0.4 - vec2(time * 0.08, time * 0.15));
        float caustic = pow(c1 * c2, 1.5) * 0.3;

        // Color blend: deep blue → shallow teal → white foam
        vec3 col = mix(deepColor, shallowColor, shore + caustic * 0.5);
        col = mix(col, foamColor, foam);

        // Opacity: deep water opaque, near shore slightly less
        float alpha = 0.7 - shore * 0.15 + caustic * 0.1;

        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  })

  waterMesh = new THREE.Mesh(g, m)
  waterMesh.renderOrder = 1
  scene.add(waterMesh)
}
