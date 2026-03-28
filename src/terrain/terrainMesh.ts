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
  const g = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 64, 64)
  g.rotateX(-Math.PI / 2)
  waterUniforms = { time: { value: 0 } }
  const m = new THREE.ShaderMaterial({
    uniforms: { time: waterUniforms.time, wc: { value: new THREE.Color(0.12,0.30,0.50) }, fc: { value: new THREE.Color(0.55,0.70,0.82) } },
    vertexShader: `uniform float time; varying vec2 vu; varying float vw;
      void main(){ vu=uv; vec3 p=position;
        float w=sin(p.x*.3+time*1.2)*.3+sin(p.z*.4+time*.8)*.2+sin((p.x+p.z)*.2+time*1.5)*.15;
        p.y=-1.2+w; vw=w; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.); }`,
    fragmentShader: `uniform vec3 wc,fc; uniform float time; varying vec2 vu; varying float vw;
      void main(){ float c=pow(sin(vu.x*40.+time*2.)*sin(vu.y*40.+time*1.5)*.5+.5,3.)*.3;
        vec3 col=mix(wc+c*fc,fc,smoothstep(.2,.4,vw)*.3);
        gl_FragColor=vec4(col,.55+c*.15); }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  })
  waterMesh = new THREE.Mesh(g, m)
  waterMesh.renderOrder = 1
  scene.add(waterMesh)
}
