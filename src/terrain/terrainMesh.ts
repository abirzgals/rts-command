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

// ── Generate splat map texture from terrain types ───────────

function generateSplatMap(): THREE.DataTexture {
  // R=grass, G=dirt, B=rock, A=cliff
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

  // 2-pass Gaussian blur for smooth transitions
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
            r += src[ni] * wt; g += src[ni + 1] * wt; b += src[ni + 2] * wt; a += src[ni + 3] * wt
            w += wt
          }
        }
        const di = (gz * GRID_RES + gx) * 4
        dst[di] = r / w; dst[di + 1] = g / w; dst[di + 2] = b / w; dst[di + 3] = a / w
      }
    }
  }

  // Normalize and pack to Uint8
  const data = new Uint8Array(GRID_RES * GRID_RES * 4)
  for (let i = 0; i < GRID_RES * GRID_RES; i++) {
    const si = i * 4
    const sum = raw[si] + raw[si + 1] + raw[si + 2] + raw[si + 3]
    const inv = sum > 0.001 ? 255 / sum : 0
    data[si] = Math.round(raw[si] * inv)
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

// ── Main terrain creation ───────────────────────────────────

export function createTerrainMesh(): THREE.Mesh {
  const loader = new THREE.TextureLoader()

  function loadTex(url: string): THREE.Texture {
    const tex = loader.load(url)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  const texGrass = loadTex('/textures/grass.jpg')
  const texDirt = loadTex('/textures/dirt.jpg')
  const texRock = loadTex('/textures/rock.jpg')
  const texCliff = loadTex('/textures/cliff.jpg')
  const splatMap = generateSplatMap()

  // Build geometry
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

  // MeshStandardMaterial with onBeforeCompile to inject splat texture blending.
  // This way Three.js handles ALL shadow logic — we just change the diffuse color.
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.85,
    metalness: 0.0,
  })

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.splatMap = { value: splatMap }
    shader.uniforms.texGrass = { value: texGrass }
    shader.uniforms.texDirt = { value: texDirt }
    shader.uniforms.texRock = { value: texRock }
    shader.uniforms.texCliff = { value: texCliff }

    // Add uniforms and varyings to vertex shader
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
       varying vec2 vWorldUV;
       varying float vHeight;`
    )
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vec4 terrainWorldPos = modelMatrix * vec4(position, 1.0);
       vWorldUV = terrainWorldPos.xz * 0.1;
       vHeight = terrainWorldPos.y;`
    )

    // Inject splat blending into fragment shader
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
       uniform sampler2D splatMap;
       uniform sampler2D texGrass;
       uniform sampler2D texDirt;
       uniform sampler2D texRock;
       uniform sampler2D texCliff;
       varying vec2 vWorldUV;
       varying float vHeight;`
    )

    // Inject splat blending after color_fragment (which sets diffuseColor from the material color)
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       // Splat-blended terrain textures
       vec4 splat = texture2D(splatMap, vUv);
       vec3 tGrass = texture2D(texGrass, vWorldUV).rgb;
       vec3 tDirt = texture2D(texDirt, vWorldUV).rgb;
       vec3 tRock = texture2D(texRock, vWorldUV * 0.7).rgb;
       vec3 tCliff = texture2D(texCliff, vWorldUV * 0.5).rgb;
       vec3 terrainColor = tGrass * splat.r + tDirt * splat.g + tRock * splat.b + tCliff * splat.a;
       float hFade = 0.9 + clamp(vHeight * 0.015, 0.0, 0.2);
       diffuseColor = vec4(terrainColor * hFade, 1.0);`
    )
  }

  terrainMesh = new THREE.Mesh(geo, mat)
  terrainMesh.receiveShadow = true
  scene.add(terrainMesh)

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
