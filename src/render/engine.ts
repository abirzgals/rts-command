import * as THREE from 'three'
import { MAP_SIZE } from '../game/config'
import { touchPanDeltaX, touchPanDeltaZ, consumeTouchPan } from '../input/input'

// ── Shared renderer state ────────────────────────────────────
export let renderer: THREE.WebGLRenderer
export let scene: THREE.Scene
export let camera: THREE.PerspectiveCamera
export let raycaster: THREE.Raycaster
export let groundPlane: THREE.Mesh

const _pointer = new THREE.Vector2()

export function initRenderer(canvas: HTMLCanvasElement) {
  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setClearColor(0x88aacc)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.1

  // Scene
  scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(0x8faab8, 0.003)

  // Camera
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 400)
  camera.position.set(-80, 40, -60)
  camera.lookAt(-80, 0, -80)

  // ── Lighting (photorealistic setup) ──────────────────
  // Hemisphere light: warm sky above, cool ground bounce below
  const hemi = new THREE.HemisphereLight(0x9ec5e8, 0x5a4a3a, 0.6)
  scene.add(hemi)

  // Sun (warm directional with high-res shadows)
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.5)
  sun.position.set(60, 100, 40)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  sun.shadow.camera.left = -130
  sun.shadow.camera.right = 130
  sun.shadow.camera.top = 130
  sun.shadow.camera.bottom = -130
  sun.shadow.camera.near = 10
  sun.shadow.camera.far = 300
  sun.shadow.bias = -0.0005
  sun.shadow.normalBias = 0.02
  scene.add(sun)

  // Fill light (cool blue from opposite side for dimension)
  const fill = new THREE.DirectionalLight(0x5599dd, 0.35)
  fill.position.set(-50, 40, -70)
  scene.add(fill)

  // Back-rim light (subtle warm kick from behind)
  const rim = new THREE.DirectionalLight(0xffcc88, 0.2)
  rim.position.set(-30, 60, 80)
  scene.add(rim)

  // Subtle ambient base
  const ambient = new THREE.AmbientLight(0x3a4455, 0.35)
  scene.add(ambient)

  // Raycaster
  raycaster = new THREE.Raycaster()

  // Resize handler
  window.addEventListener('resize', onResize)
}

/** Called by main.ts after terrain mesh is created */
export function setGroundPlane(mesh: THREE.Mesh) {
  groundPlane = mesh
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

// ── Camera controller (fixed angle, no rotation) ─────────────
export class RTSCamera {
  target = new THREE.Vector3(-80, 0, -80)
  distance = 45
  minDistance = 12
  maxDistance = 110
  // Fixed viewing angle: camera looks from south toward north, tilted down
  pitch = 0.95 // ~55° from horizontal — classic RTS angle

  panSpeed = 40
  edgeMargin = 30
  edgeScrollSpeed = 25

  private keys = new Set<string>()
  private getTerrainHeight: ((x: number, z: number) => number) | null = null

  constructor() {
    window.addEventListener('keydown', (e) => this.keys.add(e.code))
    window.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('wheel', (e) => {
      this.distance += e.deltaY * 0.06
      this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance))
    }, { passive: true })
  }

  setHeightFunction(fn: (x: number, z: number) => number) {
    this.getTerrainHeight = fn
  }

  update(dt: number) {
    // Pan directions aligned to screen: W=up(north), S=down(south), A=left(west), D=right(east)
    let panX = 0, panZ = 0
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp'))    panZ -= 1
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown'))  panZ += 1
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft'))  panX -= 1
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) panX += 1

    // Edge scrolling
    // (handled by the game when mouse is at screen edges — optional future addition)

    const speed = this.keys.has('ShiftLeft') ? this.panSpeed * 2 : this.panSpeed
    this.target.x += panX * speed * dt
    this.target.z += panZ * speed * dt

    // Apply touch pan
    if (touchPanDeltaX !== 0 || touchPanDeltaZ !== 0) {
      this.target.x += touchPanDeltaX
      this.target.z += touchPanDeltaZ
      consumeTouchPan()
    }

    const half = MAP_SIZE / 2
    this.target.x = Math.max(-half, Math.min(half, this.target.x))
    this.target.z = Math.max(-half, Math.min(half, this.target.z))

    // Follow terrain height
    if (this.getTerrainHeight) {
      this.target.y = this.getTerrainHeight(this.target.x, this.target.z)
    }

    // Camera sits behind (south of) and above the target — fixed angle, no yaw rotation
    const offY = Math.sin(this.pitch) * this.distance
    const offZ = Math.cos(this.pitch) * this.distance // positive Z = south of target

    camera.position.set(
      this.target.x,
      this.target.y + offY,
      this.target.z + offZ,
    )
    camera.lookAt(this.target)
  }
}

// ── Utility: raycast ground ──────────────────────────────────
const _groundIntersects: THREE.Intersection[] = []

export function raycastGround(screenX: number, screenY: number): THREE.Vector3 | null {
  _pointer.x = (screenX / window.innerWidth) * 2 - 1
  _pointer.y = -(screenY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(_pointer, camera)
  _groundIntersects.length = 0
  raycaster.intersectObject(groundPlane, false, _groundIntersects)
  return _groundIntersects.length > 0 ? _groundIntersects[0].point : null
}
