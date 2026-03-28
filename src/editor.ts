// ═══════════════════════════════════════════════════════════════════════════
//  RTS Command — Unit Editor
//  Stand-alone Three.js viewer with full stats, animation, and effects editing
// ═══════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

// ─── Types ─────────────────────────────────────────────────────────────────

type ModelCategory = 'units' | 'buildings' | 'resources' | 'obstacles'

interface ModelConfig {
  name: string
  key: string
  category: ModelCategory
  modelUrl: string
  scale: number
  rotationOffset: number // radians
  icon: string
  // Optional stats (units only)
  hp?: number
  speed?: number
  armor?: number
  damage?: number
  range?: number
  cooldown?: number
  splash?: number
  selectionRadius?: number
  collisionRadius?: number
}

interface EffectsConfig {
  firePoint: { x: number; y: number; z: number }
  muzzle: { color: string; intensity: number; range: number; duration: number }
  projectile: { type: 'bullet' | 'shell'; color: string; size: number; speed: number; arcHeight: number }
  impact: { type: 'sparks' | 'fire' | 'dust' | 'explosion'; color: string; size: number; particles: number; lifetime: number }
  explosion: { colors: string[]; radius: number; particles: number }
  smoke: { color: string; opacity: number; lifetime: number; count: number }
}

// ─── All Model Configs ────────────────────────────────────────────────────

const ALL_MODELS: ModelConfig[] = [
  // ── Units ──
  { key: 'worker', name: 'Worker', category: 'units', modelUrl: '/models/worker.glb', scale: 1.0, rotationOffset: 0, icon: '\u26CF',
    hp: 40, speed: 3.5, armor: 0, damage: 5, range: 1.2, cooldown: 1.5, splash: 0, selectionRadius: 0.4, collisionRadius: 0.4 },
  { key: 'marine', name: 'Marine', category: 'units', modelUrl: '/models/marine.glb', scale: 1.0, rotationOffset: 0, icon: '\u2694',
    hp: 55, speed: 3.0, armor: 0, damage: 8, range: 6, cooldown: 0.8, splash: 0, selectionRadius: 0.4, collisionRadius: 0.4 },
  { key: 'tank', name: 'Tank', category: 'units', modelUrl: '/models/tank-v3.glb', scale: 0.55, rotationOffset: Math.PI, icon: '\u2617',
    hp: 160, speed: 2.0, armor: 2, damage: 30, range: 8, cooldown: 2.5, splash: 1.5, selectionRadius: 1.2, collisionRadius: 1.2 },
  // ── Buildings ──
  { key: 'command-center', name: 'Command Center', category: 'buildings', modelUrl: '/models/command-center.glb', scale: 5.0, rotationOffset: 0, icon: '\u2302',
    hp: 1500, armor: 1, selectionRadius: 2.0, collisionRadius: 2.0 },
  { key: 'supply-depot', name: 'Supply Depot', category: 'buildings', modelUrl: '/models/supply-depot.glb', scale: 4.0, rotationOffset: 0, icon: '\u2302',
    hp: 400, armor: 0, selectionRadius: 1.2, collisionRadius: 1.2 },
  { key: 'barracks', name: 'Barracks', category: 'buildings', modelUrl: '/models/barracks.glb', scale: 4.5, rotationOffset: 0, icon: '\u2302',
    hp: 800, armor: 1, selectionRadius: 1.5, collisionRadius: 1.5 },
  { key: 'factory', name: 'Factory', category: 'buildings', modelUrl: '/models/factory.glb', scale: 4.5, rotationOffset: 0, icon: '\u2692',
    hp: 1000, armor: 1, selectionRadius: 1.8, collisionRadius: 1.8 },
  // ── Resources ──
  { key: 'minerals', name: 'Minerals', category: 'resources', modelUrl: '/models/gold.glb', scale: 1.5, rotationOffset: 0, icon: '\u2666' },
  // ── Obstacles ──
  { key: 'rock1', name: 'Rock 1', category: 'obstacles', modelUrl: '/models/rock1.glb', scale: 5.0, rotationOffset: 0, icon: '\u26F0' },
  { key: 'rock2', name: 'Rock 2', category: 'obstacles', modelUrl: '/models/rock2.glb', scale: 5.0, rotationOffset: 0, icon: '\u26F0' },
  { key: 'tree1', name: 'Tree', category: 'obstacles', modelUrl: '/models/tree1.glb', scale: 6.0, rotationOffset: 0, icon: '\u2663' },
  { key: 'boulder', name: 'Boulder', category: 'obstacles', modelUrl: '/models/boulder.glb', scale: 6.0, rotationOffset: 0, icon: '\u2B24' },
]

const MODEL_MAP = new Map<string, ModelConfig>()
ALL_MODELS.forEach(m => MODEL_MAP.set(m.key, m))

// Legacy alias for code that uses UnitConfig shape
type UnitConfig = ModelConfig

const DEFAULT_EFFECTS: EffectsConfig = {
  firePoint: { x: 0, y: 1.5, z: 0.6 },
  muzzle: { color: '#ffaa44', intensity: 8, range: 12, duration: 0.1 },
  projectile: { type: 'bullet', color: '#ffee44', size: 0.08, speed: 25, arcHeight: 4 },
  impact: { type: 'sparks', color: '#ffaa22', size: 0.4, particles: 6, lifetime: 0.3 },
  explosion: { colors: ['#ff6600', '#ff4400', '#441100'], radius: 2.0, particles: 8 },
  smoke: { color: '#888888', opacity: 0.6, lifetime: 0.75, count: 4 },
}

const FACTION_COLORS = {
  player: new THREE.Color(0x4499ff),
  enemy: new THREE.Color(0xff4455),
}

// ─── State ─────────────────────────────────────────────────────────────────

let currentKey = 'worker'
let currentCategory: ModelCategory = 'units'
let currentFaction: 'player' | 'enemy' = 'player'
let config: ModelConfig = { ...ALL_MODELS[0] }
let effects: EffectsConfig = JSON.parse(JSON.stringify(DEFAULT_EFFECTS))

// Keep legacy alias
let currentUnit = 'worker'

// ─── Face Pick Mode ───────────────────────────────────────────────────────

let pickMode = false
const raycaster = new THREE.Raycaster()
const pickMouse = new THREE.Vector2()
const _tmpQ = new THREE.Quaternion()

// Attachment info: bone + local offset (follows animation)
interface AttachmentInfo {
  bone: THREE.Bone | THREE.Object3D
  localOffset: THREE.Vector3
  localNormal: THREE.Vector3
}
let firePointAttachment: AttachmentInfo | null = null

// ─── Animation Events ────────────────────────────────────────────────────

interface AnimEvent {
  id: number
  type: string
  label: string
  animation: string | null  // null = not attached
  time: number              // seconds within the animation
}

let animEvents: AnimEvent[] = []
let nextEventId = 1
let selectedEventId: number | null = null

// ─── Three.js Core ─────────────────────────────────────────────────────────

let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
let clock: THREE.Clock

// ─── Model State ───────────────────────────────────────────────────────────

const gltfCache = new Map<string, GLTF>()
const loader = new GLTFLoader()
let currentModel: THREE.Object3D | null = null
let currentMixer: THREE.AnimationMixer | null = null
let currentActions = new Map<string, THREE.AnimationAction>()
let activeAction: THREE.AnimationAction | null = null
let activeClipName = ''
let animSpeed = 1.0
let crossfadeDuration = 0.15
let turretBone: THREE.Bone | null = null
let barrelBone: THREE.Bone | null = null

// ─── Overlay Objects ───────────────────────────────────────────────────────

let selectionRing: THREE.Mesh | null = null
let attackRangeRing: THREE.Line | null = null
let collisionRing: THREE.Line | null = null
let firePointMarker: THREE.Mesh | null = null
let fireDirectionArrow: THREE.ArrowHelper | null = null
let hpBarGroup: THREE.Group | null = null

const overlayVisibility: Record<string, boolean> = {
  selectionRing: true,
  attackRange: true,
  collisionBoundary: true,
  firePoint: true,
  hpBar: true,
  processEvents: false,
}

// Track which events already fired this animation loop to avoid re-triggering
const firedEventIds = new Set<number>()
let lastAnimTime = -1

// ─── Live Effects ──────────────────────────────────────────────────────────

interface LiveEffect {
  objects: THREE.Object3D[]
  update: (dt: number) => boolean // return false to remove
}
const liveEffects: LiveEffect[] = []

// ─── Stats Definition ──────────────────────────────────────────────────────

interface StatDef {
  key: keyof UnitConfig
  label: string
  min: number
  max: number
  step: number
  suffix?: string
}

const STAT_DEFS: StatDef[] = [
  { key: 'hp', label: 'HP', min: 1, max: 500, step: 1 },
  { key: 'speed', label: 'Speed', min: 0.5, max: 10, step: 0.1 },
  { key: 'armor', label: 'Armor', min: 0, max: 10, step: 1 },
  { key: 'damage', label: 'Damage', min: 1, max: 100, step: 1 },
  { key: 'range', label: 'Range', min: 0.5, max: 20, step: 0.5 },
  { key: 'cooldown', label: 'Cooldown', min: 0.1, max: 5, step: 0.1, suffix: 's' },
  { key: 'splash', label: 'Splash', min: 0, max: 5, step: 0.1 },
  { key: 'selectionRadius', label: 'Sel. Radius', min: 0.1, max: 3, step: 0.05 },
  { key: 'collisionRadius', label: 'Col. Radius', min: 0.1, max: 3, step: 0.05 },
  { key: 'scale', label: 'Model Scale', min: 0.1, max: 3, step: 0.05 },
  { key: 'rotationOffset', label: 'Rotation', min: 0, max: 6.2832, step: 0.0175, suffix: '`' },
]

// ═══════════════════════════════════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

function init() {
  const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement
  const viewport = document.getElementById('viewport') as HTMLDivElement

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setClearColor(0x1a1e2e)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0

  // Scene
  scene = new THREE.Scene()

  // Camera
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200)
  camera.position.set(4, 3.5, 4)

  // Controls
  controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 1, 0)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = 1.5
  controls.maxDistance = 30
  controls.maxPolarAngle = Math.PI / 2 - 0.05
  controls.update()

  // Clock
  clock = new THREE.Clock()

  // Lighting
  setupLighting()

  // Ground grid
  setupGround()

  // Resize handler
  function onResize() {
    const rect = viewport.getBoundingClientRect()
    camera.aspect = rect.width / rect.height
    camera.updateProjectionMatrix()
    renderer.setSize(rect.width, rect.height)
  }
  window.addEventListener('resize', onResize)
  // Immediate sizing
  requestAnimationFrame(onResize)

  // UI wiring
  wireModelSelector()
  wireFactionToggle()
  buildStatsUI()
  wireOverlayToggles()
  wireAnimationControls()
  wireTurretControls()
  wireEffectControls()
  wirePickFace()
  wireAnimEvents()
  wireBottomBar()
  wireExportModal()

  // Load first model
  loadModel(currentKey).then(() => {
    const overlay = document.getElementById('loading-overlay')!
    overlay.classList.add('hidden')
    setTimeout(() => overlay.remove(), 300)
  })

  // Render loop
  requestAnimationFrame(animate)
}

// ─── Lighting ──────────────────────────────────────────────────────────────

function setupLighting() {
  const hemi = new THREE.HemisphereLight(0x87ceeb, 0x4a3520, 0.4)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xffffff, 1.4)
  sun.position.set(5, 10, 4)
  sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024)
  sun.shadow.camera.left = -8
  sun.shadow.camera.right = 8
  sun.shadow.camera.top = 8
  sun.shadow.camera.bottom = -8
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = 30
  sun.shadow.bias = -0.002
  scene.add(sun)

  const fill = new THREE.DirectionalLight(0x4488cc, 0.35)
  fill.position.set(-4, 4, -4)
  scene.add(fill)

  const ambient = new THREE.AmbientLight(0x334455, 0.25)
  scene.add(ambient)
}

// ─── Ground ────────────────────────────────────────────────────────────────

function setupGround() {
  // Grid helper
  const grid = new THREE.GridHelper(20, 20, 0x2a2e3a, 0x1e222e)
  grid.position.y = 0.001
  scene.add(grid)

  // Ground plane
  const groundGeo = new THREE.PlaneGeometry(20, 20)
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x1a1e2e,
    roughness: 0.9,
    metalness: 0,
  })
  const ground = new THREE.Mesh(groundGeo, groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)
}

// ═══════════════════════════════════════════════════════════════════════════
//  MODEL LOADING
// ═══════════════════════════════════════════════════════════════════════════

async function loadModel(modelKey: string) {
  const def = MODEL_MAP.get(modelKey)
  if (!def) return

  currentKey = modelKey
  currentUnit = modelKey
  config = { ...def }

  // Remove old model
  if (currentModel) {
    scene.remove(currentModel)
    disposeObject(currentModel)
    currentModel = null
  }
  currentMixer = null
  currentActions.clear()
  activeAction = null
  activeClipName = ''
  turretBone = null
  barrelBone = null
  firePointAttachment = null
  animEvents = []
  selectedEventId = null
  // Hide pick info & reset events UI
  const pickInfo = document.getElementById('pick-info')
  if (pickInfo) pickInfo.style.display = 'none'
  const editPanel = document.getElementById('event-edit-panel')
  if (editPanel) editPanel.style.display = 'none'
  if ((window as any).__renderEventsList) (window as any).__renderEventsList()

  // Load or use cache
  let gltf = gltfCache.get(def.modelUrl)
  if (!gltf) {
    gltf = await loader.loadAsync(def.modelUrl)
    gltfCache.set(def.modelUrl, gltf)
  }

  // Clone the scene
  const model = SkeletonUtils.clone(gltf.scene)
  model.scale.setScalar(config.scale)
  model.rotation.y = config.rotationOffset

  // Apply faction tint
  applyFactionTint(model)

  // Enable shadows
  model.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      (child as THREE.Mesh).castShadow = true;
      (child as THREE.Mesh).receiveShadow = true
    }
  })

  scene.add(model)
  currentModel = model

  // Set up animations
  if (gltf.animations.length > 0) {
    currentMixer = new THREE.AnimationMixer(model)
    for (const clip of gltf.animations) {
      const action = currentMixer.clipAction(clip)
      currentActions.set(clip.name, action)
    }
    // Play Idle if available
    const idle = currentActions.get('Idle')
    if (idle) {
      idle.play()
      activeAction = idle
      activeClipName = 'Idle'
    } else {
      // Play first clip
      const first = gltf.animations[0]
      if (first) {
        const act = currentActions.get(first.name)!
        act.play()
        activeAction = act
        activeClipName = first.name
      }
    }
  }

  // Find turret/barrel bones
  model.traverse((child) => {
    if ((child as THREE.Bone).isBone) {
      if (child.name === 'Turret') turretBone = child as THREE.Bone
      if (child.name === 'Barrel') barrelBone = child as THREE.Bone
    }
  })

  // Adjust camera for model size
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  const dist = Math.max(4, maxDim * 2.0)
  camera.position.set(dist * 0.8, dist * 0.7, dist * 0.8)
  controls.target.set(0, size.y * 0.4, 0)
  controls.update()

  // Update UI
  updateStatsUI()
  updateAnimUI(gltf)
  updateBadges(gltf)
  updateOverlays()
  updateTurretSectionVisibility()

  // Show/hide effects panel for non-units
  const effectSections = document.querySelectorAll<HTMLElement>('.effects-section')
  effectSections.forEach(el => {
    el.style.display = config.category === 'units' ? 'block' : 'none'
  })
}

function applyFactionTint(model: THREE.Object3D) {
  const factionColor = FACTION_COLORS[currentFaction]
  model.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (let i = 0; i < mats.length; i++) {
        const orig = mats[i] as THREE.MeshStandardMaterial
        const mat = orig.clone()
        mat.color.lerp(factionColor, 0.35)
        mat.emissive.copy(factionColor).multiplyScalar(0.08)
        mats[i] = mat
      }
      mesh.material = mats.length === 1 ? mats[0] : mats
    }
  })
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      mesh.geometry?.dispose()
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) m.dispose()
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
//  OVERLAYS
// ═══════════════════════════════════════════════════════════════════════════

function updateOverlays() {
  // Clean up old overlays
  removeOverlays()

  // Selection ring
  const selRadius = config.selectionRadius ?? 1.0
  const ringGeo = new THREE.RingGeometry(selRadius * 0.75, selRadius * 1.0, 48)
  ringGeo.rotateX(-Math.PI / 2)
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x00ff44, transparent: true, opacity: 0.45,
    side: THREE.DoubleSide, depthWrite: false,
  })
  selectionRing = new THREE.Mesh(ringGeo, ringMat)
  selectionRing.position.y = 0.02
  selectionRing.visible = overlayVisibility.selectionRing
  scene.add(selectionRing)

  // Attack range circle (dashed)
  const atkRange = config.range ?? 1.0
  attackRangeRing = createDashedCircle(atkRange, 0x58a6ff, 64)
  attackRangeRing.position.y = 0.03
  attackRangeRing.visible = overlayVisibility.attackRange && atkRange > 0
  scene.add(attackRangeRing)

  // Collision boundary (red)
  const colRadius = config.collisionRadius ?? 1.0
  collisionRing = createDashedCircle(colRadius, 0xff4444, 32)
  collisionRing.position.y = 0.04
  collisionRing.visible = overlayVisibility.collisionBoundary
  scene.add(collisionRing)

  // Fire point marker (shared by muzzle flash + projectile spawn)
  const fpGeo = new THREE.SphereGeometry(0.1, 10, 10)
  const fpMat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.85 })
  firePointMarker = new THREE.Mesh(fpGeo, fpMat)
  firePointMarker.position.set(effects.firePoint.x, effects.firePoint.y, effects.firePoint.z)
  firePointMarker.visible = overlayVisibility.firePoint

  // Attach to turret/barrel bone if present (rotates with turret)
  if (barrelBone) {
    barrelBone.add(firePointMarker)
  } else if (turretBone) {
    turretBone.add(firePointMarker)
  } else {
    scene.add(firePointMarker)
  }

  // Fire direction arrow (in world space, updated each frame)
  fireDirectionArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 1.5, 0xff4400, 0.3, 0.15
  )
  fireDirectionArrow.visible = overlayVisibility.firePoint
  scene.add(fireDirectionArrow)

  // HP bar preview
  hpBarGroup = createHPBarPreview()
  hpBarGroup.position.y = 3.5
  hpBarGroup.visible = overlayVisibility.hpBar
  scene.add(hpBarGroup)
}

function removeOverlays() {
  if (selectionRing) { scene.remove(selectionRing); selectionRing.geometry.dispose(); (selectionRing.material as THREE.Material).dispose(); selectionRing = null }
  if (attackRangeRing) { scene.remove(attackRangeRing); attackRangeRing.geometry.dispose(); (attackRangeRing.material as THREE.Material).dispose(); attackRangeRing = null }
  if (collisionRing) { scene.remove(collisionRing); collisionRing.geometry.dispose(); (collisionRing.material as THREE.Material).dispose(); collisionRing = null }
  if (firePointMarker) { firePointMarker.removeFromParent(); firePointMarker.geometry.dispose(); (firePointMarker.material as THREE.Material).dispose(); firePointMarker = null }
  if (fireDirectionArrow) { scene.remove(fireDirectionArrow); fireDirectionArrow.dispose(); fireDirectionArrow = null }
  if (hpBarGroup) { scene.remove(hpBarGroup); disposeObject(hpBarGroup); hpBarGroup = null }
}

/** Get the horizontal fire direction in world space.
 *  Uses the picked face normal if available, otherwise model forward + turret yaw. */
function getFireDirection(): THREE.Vector3 {
  // If a face was picked, use its normal transformed to world space
  if (firePointAttachment) {
    const worldNormal = firePointAttachment.localNormal.clone()
    // Transform local normal to world space through the attachment bone
    const boneQ = new THREE.Quaternion()
    firePointAttachment.bone.getWorldQuaternion(boneQ)
    worldNormal.applyQuaternion(boneQ)
    // Flatten to horizontal
    worldNormal.y = 0
    if (worldNormal.lengthSq() > 0.001) {
      worldNormal.normalize()
      return worldNormal
    }
  }

  // Fallback: model forward + turret yaw
  const fwd = new THREE.Vector3(0, 0, -1)
  if (!currentModel) return fwd

  currentModel.getWorldQuaternion(_tmpQ)

  if (turretBone) {
    const boneQ = new THREE.Quaternion()
    turretBone.getWorldQuaternion(boneQ)
    const modelInv = _tmpQ.clone().invert()
    const localBoneQ = modelInv.multiply(boneQ)
    const euler = new THREE.Euler().setFromQuaternion(localBoneQ)
    const yawOnly = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, euler.y, 0))
    currentModel.getWorldQuaternion(_tmpQ)
    fwd.applyQuaternion(_tmpQ)
    fwd.applyQuaternion(yawOnly)
  } else {
    fwd.applyQuaternion(_tmpQ)
  }

  fwd.y = 0
  if (fwd.lengthSq() > 0.001) fwd.normalize()
  return fwd
}

function createDashedCircle(radius: number, color: number, segments: number): THREE.Line {
  const points: THREE.Vector3[] = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius))
  }
  const geo = new THREE.BufferGeometry().setFromPoints(points)
  const mat = new THREE.LineDashedMaterial({
    color,
    dashSize: 0.3,
    gapSize: 0.15,
    transparent: true,
    opacity: 0.6,
  })
  const line = new THREE.Line(geo, mat)
  line.computeLineDistances()
  return line
}

function createHPBarPreview(): THREE.Group {
  const group = new THREE.Group()

  // Background
  const bgGeo = new THREE.PlaneGeometry(1.0, 0.1)
  const bgMat = new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide, depthTest: false })
  const bg = new THREE.Mesh(bgGeo, bgMat)
  bg.renderOrder = 999
  group.add(bg)

  // Fill (green - 75%)
  const fillGeo = new THREE.PlaneGeometry(0.75, 0.08)
  const fillMat = new THREE.MeshBasicMaterial({ color: 0x4caf50, side: THREE.DoubleSide, depthTest: false })
  const fill = new THREE.Mesh(fillGeo, fillMat)
  fill.position.x = -0.125 // offset to left-align
  fill.position.z = 0.001
  fill.renderOrder = 1000
  group.add(fill)

  return group
}

// ═══════════════════════════════════════════════════════════════════════════
//  UI WIRING
// ═══════════════════════════════════════════════════════════════════════════

// ─── Unit Tabs ─────────────────────────────────────────────────────────────

function wireModelSelector() {
  const catTabs = document.querySelectorAll<HTMLDivElement>('.cat-tab')
  const grid = document.getElementById('model-grid')!

  function renderGrid(cat: ModelCategory) {
    grid.innerHTML = ''
    const models = ALL_MODELS.filter(m => m.category === cat)
    for (const m of models) {
      const card = document.createElement('div')
      card.className = `model-card ${m.key === currentKey ? 'active' : ''}`
      card.dataset.key = m.key
      card.innerHTML = `<span class="card-icon">${m.icon}</span>${m.name}`
      card.addEventListener('click', () => {
        grid.querySelectorAll('.model-card').forEach(c => c.classList.remove('active'))
        card.classList.add('active')
        loadModel(m.key)
      })
      grid.appendChild(card)
    }
  }

  catTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      catTabs.forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      currentCategory = tab.dataset.cat as ModelCategory
      renderGrid(currentCategory)
    })
  })

  // Initial render
  renderGrid('units')
}

// ─── Faction Toggle ────────────────────────────────────────────────────────

function wireFactionToggle() {
  const btns = document.querySelectorAll<HTMLButtonElement>('.faction-btn')
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => { b.classList.remove('active-player', 'active-enemy') })
      const faction = btn.dataset.faction as 'player' | 'enemy'
      currentFaction = faction
      btn.classList.add(faction === 'player' ? 'active-player' : 'active-enemy')
      // Re-tint the model
      if (currentModel) {
        retintModel()
      }
    })
  })
}

function retintModel() {
  if (!currentModel) return
  const factionColor = FACTION_COLORS[currentFaction]
  // Re-clone materials and retint
  const gltf = gltfCache.get(config.modelUrl)
  if (!gltf) return

  // Walk original scene to get original colors
  const origMeshes: THREE.MeshStandardMaterial[] = []
  gltf.scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) origMeshes.push(m as THREE.MeshStandardMaterial)
    }
  })

  let origIdx = 0
  currentModel.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (let i = 0; i < mats.length; i++) {
        const orig = origMeshes[origIdx] || origMeshes[origMeshes.length - 1]
        if (orig) {
          const mat = (mats[i] as THREE.MeshStandardMaterial)
          mat.color.copy(orig.color).lerp(factionColor, 0.35)
          mat.emissive.copy(factionColor).multiplyScalar(0.08)
          mat.needsUpdate = true
        }
        origIdx++
      }
    }
  })
}

// ─── Stats UI ──────────────────────────────────────────────────────────────

function buildStatsUI() {
  const container = document.getElementById('stats-container')!
  container.innerHTML = ''

  for (const stat of STAT_DEFS) {
    const row = document.createElement('div')
    row.className = 'stat-row'

    const label = document.createElement('span')
    label.className = 'stat-label'
    label.textContent = stat.label

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.className = 'stat-slider'
    slider.min = String(stat.min)
    slider.max = String(stat.max)
    slider.step = String(stat.step)
    slider.id = `stat-${stat.key}`

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'stat-input'
    input.id = `stat-${stat.key}-val`

    // Slider -> input sync
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value)
      ;(config as any)[stat.key] = val
      if (stat.key === 'rotationOffset') {
        input.value = Math.round(val * 180 / Math.PI) + '\u00B0'
      } else {
        input.value = formatStatValue(val, stat)
      }
      onStatChanged(stat.key)
    })

    // Input -> slider sync (on Enter or blur)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commitInput(stat, slider, input)
        input.blur()
      }
    })
    input.addEventListener('blur', () => {
      commitInput(stat, slider, input)
    })
    input.addEventListener('focus', () => {
      input.select()
    })

    row.appendChild(label)
    row.appendChild(slider)
    row.appendChild(input)
    container.appendChild(row)
  }
}

function commitInput(stat: StatDef, slider: HTMLInputElement, input: HTMLInputElement) {
  let raw = input.value.replace(/[^\d.\-]/g, '')
  let val = parseFloat(raw)
  if (isNaN(val)) val = (config as any)[stat.key]
  if (stat.key === 'rotationOffset') {
    // Input is in degrees, convert to radians
    val = val * Math.PI / 180
  }
  val = Math.max(stat.min, Math.min(stat.max, val))
  ;(config as any)[stat.key] = val
  slider.value = String(val)
  if (stat.key === 'rotationOffset') {
    input.value = Math.round(val * 180 / Math.PI) + '\u00B0'
  } else {
    input.value = formatStatValue(val, stat)
  }
  onStatChanged(stat.key)
}

function formatStatValue(val: number, stat: StatDef): string {
  if (stat.step >= 1) return String(Math.round(val))
  return val.toFixed(stat.step < 0.1 ? 2 : 1) + (stat.suffix || '')
}

function updateStatsUI() {
  for (const stat of STAT_DEFS) {
    const slider = document.getElementById(`stat-${stat.key}`) as HTMLInputElement
    const input = document.getElementById(`stat-${stat.key}-val`) as HTMLInputElement
    const row = slider?.closest('.stat-row') as HTMLElement | null
    if (!slider || !input) continue
    const val = (config as any)[stat.key] as number
    // Hide stats that don't apply (undefined on this model)
    if (row) {
      const hasVal = (config as any)[stat.key] !== undefined
      row.style.display = hasVal ? 'flex' : 'none'
    }
    if (val === undefined) continue
    slider.value = String(val)
    if (stat.key === 'rotationOffset') {
      input.value = Math.round(val * 180 / Math.PI) + '\u00B0'
    } else {
      input.value = formatStatValue(val, stat)
    }
  }
  // Update stats section title
  const statsTitle = document.querySelector('#stats-section .section-title')
  if (statsTitle) {
    const cat = config.category
    const label = cat === 'units' ? 'Unit Stats' : cat === 'buildings' ? 'Building Stats' : 'Model Config'
    statsTitle.innerHTML = `<span class="icon">&#9878;</span> ${label}`
  }
}

function onStatChanged(key: string) {
  if (key === 'scale' && currentModel) {
    currentModel.scale.setScalar(config.scale)
  }
  if (key === 'rotationOffset' && currentModel) {
    currentModel.rotation.y = config.rotationOffset
  }
  if (key === 'selectionRadius' || key === 'collisionRadius' || key === 'range') {
    updateOverlays()
  }
}

// ─── Overlay Toggles ───────────────────────────────────────────────────────

function wireOverlayToggles() {
  const container = document.getElementById('overlays-container')!
  const overlayDefs: { key: string; label: string }[] = [
    { key: 'selectionRing', label: 'Selection Ring' },
    { key: 'attackRange', label: 'Attack Range' },
    { key: 'collisionBoundary', label: 'Collision Boundary' },
    { key: 'firePoint', label: 'Fire Point' },
    { key: 'hpBar', label: 'HP Bar Preview' },
    { key: 'processEvents', label: 'Process Events' },
  ]

  for (const def of overlayDefs) {
    const row = document.createElement('div')
    row.className = 'toggle-row'

    const label = document.createElement('span')
    label.className = 'toggle-label'
    label.textContent = def.label

    const toggle = document.createElement('div')
    toggle.className = `toggle-switch ${overlayVisibility[def.key] ? 'on' : ''}`
    toggle.addEventListener('click', () => {
      overlayVisibility[def.key] = !overlayVisibility[def.key]
      toggle.classList.toggle('on')
      applyOverlayVisibility()
    })

    row.appendChild(label)
    row.appendChild(toggle)
    container.appendChild(row)
  }
}

function applyOverlayVisibility() {
  if (selectionRing) selectionRing.visible = overlayVisibility.selectionRing
  if (attackRangeRing) attackRangeRing.visible = overlayVisibility.attackRange
  if (collisionRing) collisionRing.visible = overlayVisibility.collisionBoundary
  if (firePointMarker) firePointMarker.visible = overlayVisibility.firePoint
  if (fireDirectionArrow) fireDirectionArrow.visible = overlayVisibility.firePoint
  if (hpBarGroup) hpBarGroup.visible = overlayVisibility.hpBar
}

// ─── Animation Controls ────────────────────────────────────────────────────

function wireAnimationControls() {
  const animSelect = document.getElementById('anim-select') as HTMLSelectElement
  const playBtn = document.getElementById('anim-play')!
  const pauseBtn = document.getElementById('anim-pause')!
  const stopBtn = document.getElementById('anim-stop')!
  const speedSlider = document.getElementById('anim-speed') as HTMLInputElement
  const speedVal = document.getElementById('anim-speed-val') as HTMLInputElement
  const crossfadeSlider = document.getElementById('anim-crossfade') as HTMLInputElement
  const crossfadeVal = document.getElementById('anim-crossfade-val') as HTMLInputElement
  const timeline = document.getElementById('anim-timeline')!

  animSelect.addEventListener('change', () => {
    playClip(animSelect.value)
  })

  playBtn.addEventListener('click', () => {
    if (activeAction) {
      activeAction.paused = false
      activeAction.play()
    }
  })

  pauseBtn.addEventListener('click', () => {
    if (activeAction) activeAction.paused = true
  })

  stopBtn.addEventListener('click', () => {
    if (activeAction) {
      activeAction.stop()
      activeAction.reset()
    }
  })

  speedSlider.addEventListener('input', () => {
    animSpeed = parseFloat(speedSlider.value)
    speedVal.value = animSpeed.toFixed(1) + 'x'
    if (currentMixer) currentMixer.timeScale = animSpeed
  })

  crossfadeSlider.addEventListener('input', () => {
    crossfadeDuration = parseFloat(crossfadeSlider.value)
    crossfadeVal.value = crossfadeDuration.toFixed(2) + 's'
  })

  // Timeline scrubbing
  let scrubbing = false
  timeline.addEventListener('mousedown', (e) => {
    scrubbing = true
    scrubTimeline(e, timeline)
  })
  window.addEventListener('mousemove', (e) => {
    if (scrubbing) scrubTimeline(e, timeline)
  })
  window.addEventListener('mouseup', () => { scrubbing = false })
}

function scrubTimeline(e: MouseEvent, timeline: HTMLElement) {
  if (!activeAction) return
  const rect = timeline.getBoundingClientRect()
  const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const clip = activeAction.getClip()
  activeAction.time = t * clip.duration
  activeAction.paused = true
  activeAction.play()
  if (currentMixer) currentMixer.update(0)
}

function playClip(name: string) {
  if (!name || !currentActions.has(name)) return

  const nextAction = currentActions.get(name)!
  if (activeAction && activeAction !== nextAction) {
    activeAction.fadeOut(crossfadeDuration)
  }

  nextAction.reset()
  nextAction.fadeIn(crossfadeDuration)
  nextAction.play()
  activeAction = nextAction
  activeClipName = name
  firedEventIds.clear()
  lastAnimTime = -1

  // Highlight in clip list
  document.querySelectorAll('.clip-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-clip') === name)
  })

  // Update dropdown
  const sel = document.getElementById('anim-select') as HTMLSelectElement
  sel.value = name
}

function updateAnimUI(gltf: GLTF) {
  const animSelect = document.getElementById('anim-select') as HTMLSelectElement
  const clipList = document.getElementById('clip-list')!

  // Clear
  animSelect.innerHTML = ''
  clipList.innerHTML = ''

  if (gltf.animations.length === 0) {
    animSelect.innerHTML = '<option value="">-- no animations --</option>'
    return
  }

  for (const clip of gltf.animations) {
    // Dropdown option
    const opt = document.createElement('option')
    opt.value = clip.name
    opt.textContent = clip.name
    animSelect.appendChild(opt)

    // Clip list item
    const item = document.createElement('div')
    item.className = `clip-item ${clip.name === activeClipName ? 'active' : ''}`
    item.setAttribute('data-clip', clip.name)

    const playBtn = document.createElement('button')
    playBtn.className = 'clip-play-btn'
    playBtn.innerHTML = '&#9654;'
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      playClip(clip.name)
    })

    const nameSpan = document.createElement('span')
    nameSpan.className = 'clip-name'
    nameSpan.textContent = clip.name

    const durSpan = document.createElement('span')
    durSpan.className = 'clip-duration'
    durSpan.textContent = clip.duration.toFixed(2) + 's'

    item.appendChild(playBtn)
    item.appendChild(nameSpan)
    item.appendChild(durSpan)
    item.addEventListener('click', () => playClip(clip.name))
    clipList.appendChild(item)
  }

  // Select active
  animSelect.value = activeClipName
}

// ─── Turret Controls ───────────────────────────────────────────────────────

function wireTurretControls() {
  const yawSlider = document.getElementById('turret-yaw') as HTMLInputElement
  const yawVal = document.getElementById('turret-yaw-val') as HTMLInputElement
  const pitchSlider = document.getElementById('barrel-pitch') as HTMLInputElement
  const pitchVal = document.getElementById('barrel-pitch-val') as HTMLInputElement

  yawSlider.addEventListener('input', () => {
    const deg = parseFloat(yawSlider.value)
    yawVal.value = deg + '\u00B0'
    if (turretBone) {
      turretBone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg * Math.PI / 180)
    }
  })

  pitchSlider.addEventListener('input', () => {
    const deg = parseFloat(pitchSlider.value)
    pitchVal.value = deg + '\u00B0'
    if (barrelBone) {
      // Barrel bone rest pose points along -Z (forward) in glTF space.
      // Pitch rotates around local X axis to tilt up/down.
      const rad = deg * Math.PI / 180
      barrelBone.quaternion.setFromEuler(new THREE.Euler(rad, 0, 0))
    }
  })
}

function updateTurretSectionVisibility() {
  const section = document.getElementById('turret-section')!
  section.style.display = turretBone ? 'block' : 'none'
}

// ─── Effect Controls ───────────────────────────────────────────────────────

function wireEffectControls() {
  // ── Fire point (shared position) ──
  wireSliderPair('fp-x', 'fp-x-val', (v) => {
    effects.firePoint.x = v
    if (firePointMarker) firePointMarker.position.x = v
  })
  wireSliderPair('fp-y', 'fp-y-val', (v) => {
    effects.firePoint.y = v
    if (firePointMarker) firePointMarker.position.y = v
  })
  wireSliderPair('fp-z', 'fp-z-val', (v) => {
    effects.firePoint.z = v
    if (firePointMarker) firePointMarker.position.z = v
  })

  // ── Muzzle flash ──
  wireSliderPair('muzzle-intensity', 'muzzle-intensity-val', (v) => { effects.muzzle.intensity = v })
  wireSliderPair('muzzle-range', 'muzzle-range-val', (v) => { effects.muzzle.range = v })
  wireSliderPair('muzzle-duration', 'muzzle-duration-val', (v) => { effects.muzzle.duration = v }, 's')

  const muzzleColor = document.getElementById('muzzle-color') as HTMLInputElement
  muzzleColor.addEventListener('input', () => { effects.muzzle.color = muzzleColor.value })

  document.getElementById('fire-btn')!.addEventListener('click', fireEffect)

  // ── Projectile ──
  const projType = document.getElementById('proj-type') as HTMLSelectElement
  projType.addEventListener('change', () => {
    effects.projectile.type = projType.value as 'bullet' | 'shell'
    updateProjDefaults()
  })

  const projColor = document.getElementById('proj-color') as HTMLInputElement
  projColor.addEventListener('input', () => { effects.projectile.color = projColor.value })

  wireSliderPair('proj-size', 'proj-size-val', (v) => { effects.projectile.size = v })
  wireSliderPair('proj-speed', 'proj-speed-val', (v) => { effects.projectile.speed = v })
  wireSliderPair('proj-arc', 'proj-arc-val', (v) => { effects.projectile.arcHeight = v })

  document.getElementById('launch-btn')!.addEventListener('click', launchEffect)

  // ── Impact ──
  const impactType = document.getElementById('impact-type') as HTMLSelectElement
  if (impactType) {
    impactType.addEventListener('change', () => {
      effects.impact.type = impactType.value as any
      // Set sensible defaults per type
      const defaults: Record<string, { color: string; size: number; particles: number; lifetime: number }> = {
        sparks: { color: '#ffaa22', size: 0.4, particles: 8, lifetime: 0.3 },
        fire: { color: '#ff4400', size: 0.6, particles: 6, lifetime: 0.5 },
        dust: { color: '#aa9977', size: 0.5, particles: 5, lifetime: 0.6 },
        explosion: { color: '#ff6600', size: 0.8, particles: 10, lifetime: 0.4 },
      }
      const d = defaults[impactType.value] || defaults.sparks
      ;(document.getElementById('impact-color') as HTMLInputElement).value = d.color
      setSliderValue('impact-size', d.size)
      setSliderValue('impact-particles', d.particles)
      setSliderValue('impact-lifetime', d.lifetime)
      effects.impact = { type: impactType.value as any, ...d }
    })
  }
  const impactColor = document.getElementById('impact-color') as HTMLInputElement
  if (impactColor) impactColor.addEventListener('input', () => { effects.impact.color = impactColor.value })
  wireSliderPair('impact-size', 'impact-size-val', (v) => { effects.impact.size = v })
  wireSliderPair('impact-particles', 'impact-particles-val', (v) => { effects.impact.particles = Math.round(v) })
  wireSliderPair('impact-lifetime', 'impact-lifetime-val', (v) => { effects.impact.lifetime = v }, 's')
  const impactBtn = document.getElementById('impact-btn')
  if (impactBtn) impactBtn.addEventListener('click', impactEffect)

  // ── Explosion ──
  wireSliderPair('expl-radius', 'expl-radius-val', (v) => { effects.explosion.radius = v })
  wireSliderPair('expl-particles', 'expl-particles-val', (v) => { effects.explosion.particles = Math.round(v) })

  document.getElementById('explode-btn')!.addEventListener('click', explodeEffect)

  // Explosion color swatches
  const swatches = document.querySelectorAll<HTMLDivElement>('#explosion-swatches .swatch')
  swatches.forEach(sw => {
    sw.addEventListener('click', () => {
      sw.classList.toggle('active')
      updateExplosionColors()
    })
  })

  // ── Smoke ──
  const smokeColor = document.getElementById('smoke-color') as HTMLInputElement
  smokeColor.addEventListener('input', () => { effects.smoke.color = smokeColor.value })

  wireSliderPair('smoke-opacity', 'smoke-opacity-val', (v) => { effects.smoke.opacity = v })
  wireSliderPair('smoke-lifetime', 'smoke-lifetime-val', (v) => { effects.smoke.lifetime = v }, 's')
  wireSliderPair('smoke-count', 'smoke-count-val', (v) => { effects.smoke.count = Math.round(v) })

  document.getElementById('puff-btn')!.addEventListener('click', puffEffect)
}

function wireSliderPair(sliderId: string, valId: string, onChange: (v: number) => void, suffix = '') {
  const slider = document.getElementById(sliderId) as HTMLInputElement
  const valEl = document.getElementById(valId) as HTMLInputElement
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value)
    const step = parseFloat(slider.step)
    valEl.value = (step >= 1 ? String(Math.round(v)) : v.toFixed(step < 0.1 ? 2 : (step < 1 ? 1 : 0))) + suffix
    onChange(v)
  })
}

function updateProjDefaults() {
  const isBullet = effects.projectile.type === 'bullet'
  const arcRow = document.getElementById('proj-arc-row')!
  arcRow.style.display = isBullet ? 'none' : 'flex'

  if (isBullet) {
    setSliderValue('proj-speed', 25)
    setSliderValue('proj-size', 0.08)
    setSliderValue('proj-y', 1.0)
    const colorEl = document.getElementById('proj-color') as HTMLInputElement
    colorEl.value = '#ffee44'
    effects.projectile = { ...effects.projectile, speed: 25, size: 0.08, color: '#ffee44' }
  } else {
    setSliderValue('proj-speed', 15)
    setSliderValue('proj-size', 0.12)
    setSliderValue('proj-arc', 4)
    const colorEl = document.getElementById('proj-color') as HTMLInputElement
    colorEl.value = '#ff4400'
    effects.projectile = { ...effects.projectile, speed: 15, size: 0.12, color: '#ff4400', arcHeight: 4 }
  }
}

function setSliderValue(id: string, val: number) {
  const slider = document.getElementById(id) as HTMLInputElement
  if (!slider) return
  slider.value = String(val)
  slider.dispatchEvent(new Event('input'))
}

function updateExplosionColors() {
  const swatches = document.querySelectorAll<HTMLDivElement>('#explosion-swatches .swatch')
  const colors: string[] = []
  swatches.forEach(sw => {
    if (sw.classList.contains('active')) {
      colors.push(sw.dataset.color!)
    }
  })
  if (colors.length > 0) effects.explosion.colors = colors
}

// ─── Effect Previews ───────────────────────────────────────────────────────

function fireEffect() {
  const color = new THREE.Color(effects.muzzle.color)
  // Get world position from the fire point marker (attached to turret/barrel bone)
  const worldPos = new THREE.Vector3()
  if (firePointMarker) {
    firePointMarker.getWorldPosition(worldPos)
  } else {
    worldPos.set(effects.firePoint.x, effects.firePoint.y, effects.firePoint.z)
  }

  const light = new THREE.PointLight(color, effects.muzzle.intensity, effects.muzzle.range)
  light.position.copy(worldPos)
  scene.add(light)

  // Flash sphere
  const flashGeo = new THREE.SphereGeometry(0.12, 8, 8)
  const flashMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
  })
  const flashMesh = new THREE.Mesh(flashGeo, flashMat)
  flashMesh.position.copy(worldPos)
  scene.add(flashMesh)

  let elapsed = 0
  const duration = effects.muzzle.duration

  liveEffects.push({
    objects: [light, flashMesh],
    update(dt) {
      elapsed += dt
      if (elapsed >= duration) {
        scene.remove(light)
        scene.remove(flashMesh)
        light.dispose()
        flashGeo.dispose()
        flashMat.dispose()
        return false
      }
      const t = elapsed / duration
      light.intensity = effects.muzzle.intensity * (1 - t)
      flashMat.opacity = 0.9 * (1 - t)
      flashMesh.scale.setScalar(1 + t * 2)
      return true
    },
  })

  showStatus('Muzzle flash fired!')
}

function launchEffect() {
  const isBullet = effects.projectile.type === 'bullet'
  const color = new THREE.Color(effects.projectile.color)
  const size = effects.projectile.size
  const speed = effects.projectile.speed

  const geo = new THREE.SphereGeometry(size, 8, 8)
  const mat = new THREE.MeshBasicMaterial({ color })
  const proj = new THREE.Mesh(geo, mat)

  const startPos = new THREE.Vector3()
  if (firePointMarker) {
    firePointMarker.getWorldPosition(startPos)
  } else {
    startPos.set(effects.firePoint.x, effects.firePoint.y, effects.firePoint.z)
  }
  const fireDir = getFireDirection()
  const endPos = startPos.clone().addScaledVector(fireDir, 8)
  endPos.y = 0.3
  proj.position.copy(startPos)
  scene.add(proj)

  // Trail
  const trailGeo = new THREE.ConeGeometry(size * 0.5, size * 3, 4)
  trailGeo.rotateX(Math.PI / 2)
  const trailMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 })
  const trail = new THREE.Mesh(trailGeo, trailMat)
  proj.add(trail)
  trail.position.z = -size * 2

  let elapsed = 0
  const totalDist = startPos.distanceTo(endPos)
  const totalTime = totalDist / speed
  const arcHeight = isBullet ? 0.2 : effects.projectile.arcHeight

  // Orient projectile toward target initially
  proj.lookAt(endPos)

  const prevPos = startPos.clone()

  liveEffects.push({
    objects: [proj],
    update(dt) {
      elapsed += dt
      const t = Math.min(1, elapsed / totalTime)

      // Lerp position
      prevPos.copy(proj.position)
      proj.position.lerpVectors(startPos, endPos, t)
      // Add arc
      const arcT = Math.sin(t * Math.PI) * arcHeight
      proj.position.y += arcT

      // Orient projectile along movement direction
      if (t < 1) {
        const lookTarget = proj.position.clone()
        const tNext = Math.min(1, t + 0.01)
        lookTarget.lerpVectors(startPos, endPos, tNext)
        lookTarget.y += Math.sin(tNext * Math.PI) * arcHeight
        proj.lookAt(lookTarget)
      }

      if (t >= 1) {
        scene.remove(proj)
        geo.dispose()
        mat.dispose()
        trailGeo.dispose()
        trailMat.dispose()
        // Spawn impact effect at hit point
        spawnImpact(endPos.x, endPos.y, endPos.z)
        return false
      }
      return true
    },
  })

  showStatus(`${isBullet ? 'Bullet' : 'Shell'} launched!`)
}

function spawnExplosion(x: number, y: number, z: number) {
  const radius = effects.explosion.radius
  const particleCount = effects.explosion.particles
  const colors = effects.explosion.colors.map(c => new THREE.Color(c))

  // Central flash
  const flashGeo = new THREE.SphereGeometry(1, 8, 8)
  const flashMat = new THREE.MeshBasicMaterial({
    color: colors[0] || 0xff6600,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  })
  const flash = new THREE.Mesh(flashGeo, flashMat)
  flash.position.set(x, y + 0.5, z)
  flash.scale.setScalar(radius * 0.3)
  scene.add(flash)

  // Particles
  const particles: { mesh: THREE.Mesh; vx: number; vy: number; vz: number; life: number; maxLife: number }[] = []
  const partGeo = new THREE.SphereGeometry(0.15, 4, 4)

  for (let i = 0; i < particleCount; i++) {
    const pColor = colors[i % colors.length] || 0xff6600
    const pMat = new THREE.MeshBasicMaterial({ color: pColor, transparent: true, opacity: 0.8, depthWrite: false })
    const pMesh = new THREE.Mesh(partGeo, pMat)
    pMesh.position.set(
      x + (Math.random() - 0.5) * 0.5,
      y + 0.5 + Math.random() * 0.5,
      z + (Math.random() - 0.5) * 0.5,
    )
    scene.add(pMesh)
    particles.push({
      mesh: pMesh,
      vx: (Math.random() - 0.5) * 4,
      vy: 2 + Math.random() * 3,
      vz: (Math.random() - 0.5) * 4,
      life: 0,
      maxLife: 0.3 + Math.random() * 0.4,
    })
  }

  let elapsed = 0
  const maxLife = 0.5

  liveEffects.push({
    objects: [flash, ...particles.map(p => p.mesh)],
    update(dt) {
      elapsed += dt
      const t = elapsed / maxLife

      // Flash
      const flashScale = radius * 0.3 * (1 + elapsed * 8)
      flash.scale.setScalar(flashScale)
      if (t < 0.3) flashMat.color.set(colors[0] || 0xffaa00)
      else if (t < 0.6) flashMat.color.set(colors[1] || 0xff4400)
      else flashMat.color.set(colors[2] || 0x441100)
      flashMat.opacity = 0.9 * (1 - t)

      // Particles
      for (const p of particles) {
        p.life += dt
        if (p.life < p.maxLife) {
          p.mesh.position.x += p.vx * dt
          p.mesh.position.y += p.vy * dt
          p.mesh.position.z += p.vz * dt
          p.vy -= 9.8 * dt // gravity
          const pt = p.life / p.maxLife
          p.mesh.scale.setScalar(0.5 + pt * 1.5);
          (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - pt)
        } else {
          p.mesh.visible = false
        }
      }

      if (elapsed >= maxLife) {
        scene.remove(flash)
        flashGeo.dispose()
        flashMat.dispose()
        for (const p of particles) {
          scene.remove(p.mesh);
          (p.mesh.material as THREE.Material).dispose()
        }
        partGeo.dispose()
        return false
      }
      return true
    },
  })
}

function spawnImpact(x: number, y: number, z: number) {
  const cfg = effects.impact
  const color = new THREE.Color(cfg.color)
  const geo = new THREE.SphereGeometry(0.04, 4, 4)

  const isSparks = cfg.type === 'sparks'
  const isFire = cfg.type === 'fire'
  const isDust = cfg.type === 'dust'

  // Flash at impact point
  const flashGeo = new THREE.SphereGeometry(cfg.size * 0.5, 6, 6)
  const flashMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.9, depthWrite: false,
  })
  const flash = new THREE.Mesh(flashGeo, flashMat)
  flash.position.set(x, y + 0.1, z)
  scene.add(flash)

  // Point light for flash
  const light = new THREE.PointLight(color, 4, cfg.size * 6)
  light.position.set(x, y + 0.2, z)
  scene.add(light)

  // Particles
  const parts: { mesh: THREE.Mesh; vx: number; vy: number; vz: number; life: number; maxLife: number }[] = []
  for (let i = 0; i < cfg.particles; i++) {
    const pMat = new THREE.MeshBasicMaterial({
      color: isSparks ? new THREE.Color().setHSL(0.08 + Math.random() * 0.06, 1, 0.5 + Math.random() * 0.4) : color,
      transparent: true, opacity: isSparks ? 1.0 : 0.7, depthWrite: false,
    })
    const pMesh = new THREE.Mesh(geo, pMat)
    pMesh.position.set(x, y + 0.1, z)
    const spread = isSparks ? 6 : isDust ? 2 : 4
    const upward = isSparks ? 4 + Math.random() * 4 : isFire ? 2 + Math.random() * 3 : 1 + Math.random() * 2
    pMesh.scale.setScalar(isSparks ? 0.5 + Math.random() * 0.5 : 1)
    scene.add(pMesh)
    parts.push({
      mesh: pMesh,
      vx: (Math.random() - 0.5) * spread,
      vy: upward,
      vz: (Math.random() - 0.5) * spread,
      life: 0,
      maxLife: cfg.lifetime * (0.4 + Math.random() * 0.6),
    })
  }

  let elapsed = 0
  const totalLife = cfg.lifetime

  liveEffects.push({
    objects: [flash, light as any, ...parts.map(p => p.mesh)],
    update(dt) {
      elapsed += dt
      const t = elapsed / totalLife

      // Flash shrinks and fades
      flash.scale.setScalar(1 - t * 0.5)
      flashMat.opacity = 0.9 * Math.max(0, 1 - t * 3)
      light.intensity = 4 * Math.max(0, 1 - t * 4)

      // Particles
      for (const p of parts) {
        p.life += dt
        if (p.life >= p.maxLife) { p.mesh.visible = false; continue }
        const pt = p.life / p.maxLife
        p.mesh.position.x += p.vx * dt
        p.mesh.position.y += p.vy * dt
        p.mesh.position.z += p.vz * dt
        if (isSparks) {
          p.vy -= 12 * dt // heavy gravity for sparks
          p.mesh.scale.setScalar((1 - pt) * 0.6)
        } else if (isFire) {
          p.vy -= 2 * dt
          p.mesh.scale.setScalar(0.5 + pt * 2);
          (p.mesh.material as THREE.MeshBasicMaterial).color.setHSL(0.08 - pt * 0.08, 1, 0.5 - pt * 0.3)
        } else if (isDust) {
          p.vy -= 1 * dt
          p.mesh.scale.setScalar(0.5 + pt * 3)
        } else {
          p.vy -= 8 * dt
          p.mesh.scale.setScalar(1 + pt)
        }
        ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = (isSparks ? 1.0 : 0.7) * (1 - pt)
      }

      if (elapsed >= totalLife) {
        scene.remove(flash); flashGeo.dispose(); flashMat.dispose()
        scene.remove(light); light.dispose()
        for (const p of parts) { scene.remove(p.mesh); (p.mesh.material as THREE.Material).dispose() }
        geo.dispose()
        return false
      }
      return true
    },
  })
}

function impactEffect() {
  spawnImpact(0, 0.3, 2)
  showStatus('Impact effect!')
}

function explodeEffect() {
  spawnExplosion(0, 0, 0)
  showStatus('Explosion triggered!')
}

function puffEffect() {
  const color = new THREE.Color(effects.smoke.color)
  const count = effects.smoke.count
  const opacity = effects.smoke.opacity
  const lifetime = effects.smoke.lifetime

  const geo = new THREE.SphereGeometry(0.15, 4, 4)
  const particles: { mesh: THREE.Mesh; vx: number; vy: number; vz: number; life: number; maxLife: number }[] = []

  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(
      (Math.random() - 0.5) * 0.3,
      1.5 + (Math.random() - 0.5) * 0.3,
      (Math.random() - 0.5) * 0.3,
    )
    scene.add(mesh)
    particles.push({
      mesh,
      vx: (Math.random() - 0.5) * 1.5,
      vy: 1.0 + Math.random() * 2.0,
      vz: (Math.random() - 0.5) * 1.5,
      life: 0,
      maxLife: lifetime * (0.5 + Math.random()),
    })
  }

  let maxElapsed = 0

  liveEffects.push({
    objects: particles.map(p => p.mesh),
    update(dt) {
      let allDone = true
      for (const p of particles) {
        p.life += dt
        if (p.life >= p.maxLife) {
          p.mesh.visible = false
          continue
        }
        allDone = false
        const t = p.life / p.maxLife
        p.mesh.position.x += p.vx * dt
        p.mesh.position.y += p.vy * dt
        p.mesh.position.z += p.vz * dt

        const scale = 0.3 + t * 1.5
        p.mesh.scale.setScalar(scale);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = opacity * (1 - t)
      }

      maxElapsed += dt

      if (allDone || maxElapsed > lifetime * 2) {
        for (const p of particles) {
          scene.remove(p.mesh);
          (p.mesh.material as THREE.Material).dispose()
        }
        geo.dispose()
        return false
      }
      return true
    },
  })

  showStatus('Smoke puff!')
}

// ─── Face Pick Mode ───────────────────────────────────────────────────────

function wirePickFace() {
  const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement
  const pickBtn = document.getElementById('pick-face-btn')!
  const pickStatus = document.getElementById('pick-status')!
  const pickInfo = document.getElementById('pick-info')!
  const pickCancelBtn = document.getElementById('pick-cancel-btn')!

  function enterPickMode() {
    pickMode = true
    canvas.classList.add('pick-mode')
    controls.enabled = false
    pickStatus.style.display = 'block'
    pickBtn.classList.add('picking')
  }

  function exitPickMode() {
    pickMode = false
    canvas.classList.remove('pick-mode')
    controls.enabled = true
    pickStatus.style.display = 'none'
    pickBtn.classList.remove('picking')
  }

  pickBtn.addEventListener('click', () => {
    if (pickMode) { exitPickMode(); return }
    enterPickMode()
  })

  pickCancelBtn.addEventListener('click', () => exitPickMode())

  canvas.addEventListener('click', (e) => {
    if (!pickMode || !currentModel) return

    const rect = canvas.getBoundingClientRect()
    pickMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    pickMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1

    raycaster.setFromCamera(pickMouse, camera)

    const meshes: THREE.Mesh[] = []
    currentModel.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh)
    })

    const intersects = raycaster.intersectObjects(meshes, false)
    if (intersects.length === 0) return

    const hit = intersects[0]
    const hitMesh = hit.object as THREE.Mesh
    const hitPoint = hit.point.clone()
    const hitNormal = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0)

    const normalMatrix = new THREE.Matrix3().getNormalMatrix(hitMesh.matrixWorld)
    hitNormal.applyMatrix3(normalMatrix).normalize()

    const attachParent = findBestBone(hitMesh, hit) || currentModel
    const parentWorldInv = new THREE.Matrix4().copy(attachParent.matrixWorld).invert()
    const localOffset = hitPoint.clone().applyMatrix4(parentWorldInv)
    const localNormal = hitNormal.clone().transformDirection(parentWorldInv)

    firePointAttachment = { bone: attachParent, localOffset, localNormal }

    // Reparent fire point marker
    if (firePointMarker) {
      firePointMarker.removeFromParent()
      attachParent.add(firePointMarker)
      firePointMarker.position.copy(localOffset)
    }

    // Update shared fire point sliders
    setSliderValue('fp-x', localOffset.x)
    setSliderValue('fp-y', localOffset.y)
    setSliderValue('fp-z', localOffset.z)
    effects.firePoint.x = localOffset.x
    effects.firePoint.y = localOffset.y
    effects.firePoint.z = localOffset.z

    const boneName = (attachParent as THREE.Bone).isBone ? attachParent.name : 'mesh root'
    pickInfo.style.display = 'block'
    pickInfo.textContent = `Fire point attached to: ${boneName} | (${localOffset.x.toFixed(2)}, ${localOffset.y.toFixed(2)}, ${localOffset.z.toFixed(2)})`

    highlightFace(hit)
    exitPickMode()
    showStatus(`Fire point attached to ${boneName}`)
  })
}

function findBestBone(mesh: THREE.Mesh, hit: THREE.Intersection): THREE.Object3D | null {
  // For skinned meshes, find the bone with highest influence on the hit face
  if (!(mesh as THREE.SkinnedMesh).isSkinnedMesh) {
    // For non-skinned, walk up to find a Bone parent or return model root
    let parent: THREE.Object3D | null = mesh
    while (parent) {
      if ((parent as THREE.Bone).isBone) return parent
      parent = parent.parent
    }
    return null
  }

  const skinnedMesh = mesh as THREE.SkinnedMesh
  const skinIndex = skinnedMesh.geometry.attributes.skinIndex
  const skinWeight = skinnedMesh.geometry.attributes.skinWeight
  if (!skinIndex || !skinWeight || !hit.face) return null

  // Get the 3 vertex indices of the hit face
  const faceIndices = [hit.face.a, hit.face.b, hit.face.c]

  // Accumulate bone weights across the face
  const boneWeights = new Map<number, number>()
  for (const vi of faceIndices) {
    for (let j = 0; j < 4; j++) {
      const boneIdx = skinIndex.getComponent(vi, j)
      const weight = skinWeight.getComponent(vi, j)
      if (weight > 0) {
        boneWeights.set(boneIdx, (boneWeights.get(boneIdx) || 0) + weight)
      }
    }
  }

  // Find the bone with highest total weight
  let bestBoneIdx = 0
  let bestWeight = 0
  for (const [idx, w] of boneWeights) {
    if (w > bestWeight) {
      bestWeight = w
      bestBoneIdx = idx
    }
  }

  // Get the actual bone from the skeleton
  const skeleton = skinnedMesh.skeleton
  if (skeleton && skeleton.bones[bestBoneIdx]) {
    return skeleton.bones[bestBoneIdx]
  }

  return null
}

function highlightFace(hit: THREE.Intersection) {
  if (!hit.face) return

  const hitMesh = hit.object as THREE.Mesh
  const geo = hitMesh.geometry

  // Create a small triangle highlight at the hit face
  const posAttr = geo.attributes.position
  const index = geo.index

  const vA = new THREE.Vector3()
  const vB = new THREE.Vector3()
  const vC = new THREE.Vector3()

  // hit.face.a/b/c are already resolved vertex indices
  vA.fromBufferAttribute(posAttr, hit.face.a)
  vB.fromBufferAttribute(posAttr, hit.face.b)
  vC.fromBufferAttribute(posAttr, hit.face.c)

  // Transform to world space
  vA.applyMatrix4(hitMesh.matrixWorld)
  vB.applyMatrix4(hitMesh.matrixWorld)
  vC.applyMatrix4(hitMesh.matrixWorld)

  const triGeo = new THREE.BufferGeometry().setFromPoints([vA, vB, vC])
  const triMat = new THREE.MeshBasicMaterial({
    color: 0x00ff88,
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
    depthTest: false,
  })
  const triMesh = new THREE.Mesh(triGeo, triMat)
  triMesh.renderOrder = 999
  scene.add(triMesh)

  // Remove after 1 second
  setTimeout(() => {
    scene.remove(triMesh)
    triGeo.dispose()
    triMat.dispose()
  }, 1000)
}

// ─── Animation Events ─────────────────────────────────────────────────────

function wireAnimEvents() {
  const addBtn = document.getElementById('add-event-btn')!
  const typeSelect = document.getElementById('new-event-type') as HTMLSelectElement
  const eventsList = document.getElementById('events-list')!
  const editPanel = document.getElementById('event-edit-panel')!
  const editTitle = document.getElementById('event-edit-title')!
  const animSelect = document.getElementById('event-anim-select') as HTMLSelectElement
  const timeSlider = document.getElementById('event-time') as HTMLInputElement
  const timeVal = document.getElementById('event-time-val') as HTMLInputElement
  const previewBtn = document.getElementById('event-preview-btn')!
  const detachBtn = document.getElementById('event-detach-btn')!
  const deleteBtn = document.getElementById('event-delete-btn')!

  addBtn.addEventListener('click', () => {
    let type = typeSelect.value
    let label = typeSelect.options[typeSelect.selectedIndex].text
    if (type === 'custom') {
      const name = prompt('Custom event name:')
      if (!name) return
      type = 'custom_' + name.toLowerCase().replace(/\s+/g, '_')
      label = name
    }

    const evt: AnimEvent = {
      id: nextEventId++,
      type,
      label,
      animation: null,
      time: 0,
    }
    animEvents.push(evt)
    renderEventsList()
    selectEvent(evt.id)
  })

  timeSlider.addEventListener('input', () => {
    const evt = animEvents.find(e => e.id === selectedEventId)
    if (!evt) return
    evt.time = parseFloat(timeSlider.value)
    timeVal.value = evt.time.toFixed(2) + 's'
    renderEventsList()
  })

  animSelect.addEventListener('change', () => {
    const evt = animEvents.find(e => e.id === selectedEventId)
    if (!evt) return
    const val = animSelect.value
    evt.animation = val || null
    if (val && currentActions.has(val)) {
      // Update time slider max to clip duration
      const clip = currentActions.get(val)!.getClip()
      timeSlider.max = String(clip.duration)
      if (evt.time > clip.duration) {
        evt.time = 0
        timeSlider.value = '0'
        timeVal.value = '0.00s'
      }
    }
    renderEventsList()
  })

  previewBtn.addEventListener('click', () => {
    const evt = animEvents.find(e => e.id === selectedEventId)
    if (!evt || !evt.animation) return
    previewEvent(evt)
  })

  detachBtn.addEventListener('click', () => {
    const evt = animEvents.find(e => e.id === selectedEventId)
    if (!evt) return
    evt.animation = null
    evt.time = 0
    renderEventsList()
    selectEvent(evt.id)
  })

  deleteBtn.addEventListener('click', () => {
    animEvents = animEvents.filter(e => e.id !== selectedEventId)
    selectedEventId = null
    editPanel.style.display = 'none'
    renderEventsList()
  })

  function selectEvent(id: number) {
    selectedEventId = id
    const evt = animEvents.find(e => e.id === id)
    if (!evt) { editPanel.style.display = 'none'; return }

    editPanel.style.display = 'block'
    editTitle.textContent = 'Edit: ' + evt.label

    // Populate animation dropdown with available clips
    animSelect.innerHTML = '<option value="">(not attached)</option>'
    for (const [name] of currentActions) {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      if (evt.animation === name) opt.selected = true
      animSelect.appendChild(opt)
    }

    // Set time slider
    if (evt.animation && currentActions.has(evt.animation)) {
      const clip = currentActions.get(evt.animation)!.getClip()
      timeSlider.max = String(clip.duration)
    } else {
      timeSlider.max = '2'
    }
    timeSlider.value = String(evt.time)
    timeVal.value = evt.time.toFixed(2) + 's'

    // Highlight in list
    eventsList.querySelectorAll('.event-item').forEach(el => {
      el.classList.toggle('selected', el.getAttribute('data-id') === String(id))
    })
  }

  function renderEventsList() {
    eventsList.innerHTML = ''
    for (const evt of animEvents) {
      const item = document.createElement('div')
      item.className = `event-item ${evt.id === selectedEventId ? 'selected' : ''}`
      item.setAttribute('data-id', String(evt.id))

      const dot = document.createElement('div')
      dot.className = `event-dot ${evt.animation ? 'attached' : 'detached'}`

      const name = document.createElement('span')
      name.className = `event-name ${evt.animation ? '' : 'detached'}`
      name.textContent = evt.label

      const info = document.createElement('span')
      info.className = 'event-info'
      if (evt.animation) {
        info.textContent = evt.animation.replace(/.*\|/, '') + ' @ ' + evt.time.toFixed(2) + 's'
      } else {
        info.textContent = 'not attached'
      }

      item.appendChild(dot)
      item.appendChild(name)
      item.appendChild(info)

      item.addEventListener('click', () => {
        selectEvent(evt.id)
        // If attached, jump to that animation + time
        if (evt.animation) {
          previewEvent(evt)
        }
      })

      eventsList.appendChild(item)
    }
  }

  // Expose for external use
  ;(window as any).__renderEventsList = renderEventsList
  ;(window as any).__selectEvent = selectEvent
}

function triggerEvent(evt: AnimEvent) {
  switch (evt.type) {
    case 'shot':
      fireEffect()
      launchEffect()
      break
    case 'muzzle_flash':
      fireEffect()
      break
    case 'impact':
    case 'melee_hit':
      explodeEffect()
      break
    case 'death':
      puffEffect()
      break
    default:
      // For custom events or others, fire muzzle + projectile
      if (evt.type.startsWith('custom_')) {
        fireEffect()
      }
      break
  }

  // Flash the event in the list
  const item = document.querySelector(`.event-item[data-id="${evt.id}"]`)
  if (item) {
    item.classList.add('selected')
    setTimeout(() => item.classList.remove('selected'), 300)
  }
}

function previewEvent(evt: AnimEvent) {
  if (!evt.animation || !currentActions.has(evt.animation)) return

  // Switch to the animation
  playClip(evt.animation)

  // Seek to the event time
  if (activeAction) {
    activeAction.time = evt.time
    activeAction.paused = true
    activeAction.play()
    if (currentMixer) currentMixer.update(0)
  }

  // Update anim dropdown in animation panel
  const animSel = document.getElementById('anim-select') as HTMLSelectElement
  animSel.value = evt.animation

  showStatus(`Event "${evt.label}" @ ${evt.time.toFixed(2)}s in ${evt.animation}`)
}

// ─── Bottom Bar ────────────────────────────────────────────────────────────

function wireBottomBar() {
  document.getElementById('save-btn')!.addEventListener('click', () => {
    saveConfigToFile()
  })

  document.getElementById('export-btn')!.addEventListener('click', () => {
    showExportModal()
  })

  document.getElementById('copy-btn')!.addEventListener('click', () => {
    const json = buildExportJSON()
    navigator.clipboard.writeText(json).then(() => {
      showStatus('Copied to clipboard!')
    }).catch(() => {
      showStatus('Copy failed - check permissions')
    })
  })

  document.getElementById('reset-btn')!.addEventListener('click', () => {
    const def = MODEL_MAP.get(currentKey)
    if (def) config = { ...def }
    effects = JSON.parse(JSON.stringify(DEFAULT_EFFECTS))
    updateStatsUI()
    resetEffectsUI()
    onStatChanged('scale')
    onStatChanged('rotationOffset')
    updateOverlays()
    showStatus('Reset to defaults')
  })
}

function wireExportModal() {
  const modal = document.getElementById('export-modal')!
  const closeBtn = document.getElementById('modal-close-btn')!
  const copyBtn = document.getElementById('modal-copy-btn')!

  closeBtn.addEventListener('click', () => modal.classList.remove('visible'))
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('visible')
  })

  copyBtn.addEventListener('click', () => {
    const textarea = document.getElementById('export-json') as HTMLTextAreaElement
    navigator.clipboard.writeText(textarea.value).then(() => {
      showStatus('Copied to clipboard!')
    })
  })
}

function showExportModal() {
  const modal = document.getElementById('export-modal')!
  const textarea = document.getElementById('export-json') as HTMLTextAreaElement
  textarea.value = buildExportJSON()
  modal.classList.add('visible')
}

function buildExportJSON(): string {
  // Build a clean config object
  const modelConfig: Record<string, any> = {
    key: config.key,
    name: config.name,
    category: config.category,
    model: {
      url: config.modelUrl,
      scale: config.scale,
      rotationOffset: config.rotationOffset,
      rotationOffsetDeg: Math.round(config.rotationOffset * 180 / Math.PI),
    },
  }

  // Add stats if they exist
  const stats: Record<string, any> = {}
  for (const k of ['hp', 'speed', 'armor', 'damage', 'range', 'cooldown', 'splash'] as const) {
    if ((config as any)[k] !== undefined) stats[k] = (config as any)[k]
  }
  if (Object.keys(stats).length > 0) modelConfig.stats = stats

  const collision: Record<string, any> = {}
  if (config.selectionRadius !== undefined) collision.selectionRadius = config.selectionRadius
  if (config.collisionRadius !== undefined) collision.collisionRadius = config.collisionRadius
  if (Object.keys(collision).length > 0) modelConfig.collision = collision

  const exportObj: Record<string, any> = { model: modelConfig }

  // Only include effects for units
  if (config.category === 'units') {
    exportObj.effects = {
      muzzleFlash: { ...effects.muzzle, colorHex: '0x' + new THREE.Color(effects.muzzle.color).getHexString() },
      projectile: { ...effects.projectile, colorHex: '0x' + new THREE.Color(effects.projectile.color).getHexString() },
      explosion: { ...effects.explosion, colorsHex: effects.explosion.colors.map(c => '0x' + new THREE.Color(c).getHexString()) },
      smoke: { ...effects.smoke, colorHex: '0x' + new THREE.Color(effects.smoke.color).getHexString() },
    }
  }
  exportObj.faction = currentFaction

  // Include animation events
  if (animEvents.length > 0) {
    exportObj.events = animEvents.map(e => ({
      type: e.type,
      label: e.label,
      animation: e.animation,
      time: e.time,
    }))
  }

  return JSON.stringify(exportObj, null, 2)
}

function buildFullConfigJSON(): string {
  // Build config for ALL models
  const allConfigs: Record<string, any> = {}
  for (const m of ALL_MODELS) {
    const entry: Record<string, any> = {
      name: m.name,
      category: m.category,
      modelUrl: m.modelUrl,
      scale: m.scale,
      rotationOffset: m.rotationOffset,
      rotationOffsetDeg: Math.round(m.rotationOffset * 180 / Math.PI),
    }
    // If this is the currently edited model, use live config values
    if (m.key === currentKey) {
      entry.scale = config.scale
      entry.rotationOffset = config.rotationOffset
      entry.rotationOffsetDeg = Math.round(config.rotationOffset * 180 / Math.PI)
      for (const k of ['hp', 'speed', 'armor', 'damage', 'range', 'cooldown', 'splash', 'selectionRadius', 'collisionRadius'] as const) {
        if ((config as any)[k] !== undefined) entry[k] = (config as any)[k]
      }
    } else {
      for (const k of ['hp', 'speed', 'armor', 'damage', 'range', 'cooldown', 'splash', 'selectionRadius', 'collisionRadius'] as const) {
        if ((m as any)[k] !== undefined) entry[k] = (m as any)[k]
      }
    }
    allConfigs[m.key] = entry
  }
  return JSON.stringify(allConfigs, null, 2)
}

function saveConfigToFile() {
  const json = buildFullConfigJSON()
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'editor-config.json'
  a.click()
  URL.revokeObjectURL(url)
  showStatus('Config saved to editor-config.json')
}

function resetEffectsUI() {
  // Fire point
  setSliderValue('fp-x', DEFAULT_EFFECTS.firePoint.x)
  setSliderValue('fp-y', DEFAULT_EFFECTS.firePoint.y)
  setSliderValue('fp-z', DEFAULT_EFFECTS.firePoint.z)

  // Muzzle
  ;(document.getElementById('muzzle-color') as HTMLInputElement).value = DEFAULT_EFFECTS.muzzle.color
  setSliderValue('muzzle-intensity', DEFAULT_EFFECTS.muzzle.intensity)
  setSliderValue('muzzle-range', DEFAULT_EFFECTS.muzzle.range)
  setSliderValue('muzzle-duration', DEFAULT_EFFECTS.muzzle.duration)

  // Projectile
  ;(document.getElementById('proj-type') as HTMLSelectElement).value = DEFAULT_EFFECTS.projectile.type
  ;(document.getElementById('proj-color') as HTMLInputElement).value = DEFAULT_EFFECTS.projectile.color
  setSliderValue('proj-size', DEFAULT_EFFECTS.projectile.size)
  setSliderValue('proj-speed', DEFAULT_EFFECTS.projectile.speed)
  setSliderValue('proj-arc', DEFAULT_EFFECTS.projectile.arcHeight)
  document.getElementById('proj-arc-row')!.style.display = 'none'

  // Impact
  ;(document.getElementById('impact-type') as HTMLSelectElement).value = DEFAULT_EFFECTS.impact.type
  ;(document.getElementById('impact-color') as HTMLInputElement).value = DEFAULT_EFFECTS.impact.color
  setSliderValue('impact-size', DEFAULT_EFFECTS.impact.size)
  setSliderValue('impact-particles', DEFAULT_EFFECTS.impact.particles)
  setSliderValue('impact-lifetime', DEFAULT_EFFECTS.impact.lifetime)

  // Explosion
  setSliderValue('expl-radius', DEFAULT_EFFECTS.explosion.radius)
  setSliderValue('expl-particles', DEFAULT_EFFECTS.explosion.particles)
  document.querySelectorAll('#explosion-swatches .swatch').forEach(sw => sw.classList.add('active'))

  // Smoke
  ;(document.getElementById('smoke-color') as HTMLInputElement).value = DEFAULT_EFFECTS.smoke.color
  setSliderValue('smoke-opacity', DEFAULT_EFFECTS.smoke.opacity)
  setSliderValue('smoke-lifetime', DEFAULT_EFFECTS.smoke.lifetime)
  setSliderValue('smoke-count', DEFAULT_EFFECTS.smoke.count)
}

// ─── Status ────────────────────────────────────────────────────────────────

let statusTimeout: number | undefined
function showStatus(text: string) {
  const el = document.getElementById('status-text')!
  el.textContent = text
  el.style.color = '#58a6ff'
  if (statusTimeout) clearTimeout(statusTimeout)
  statusTimeout = window.setTimeout(() => {
    el.textContent = 'Ready'
    el.style.color = '#484f58'
  }, 2000)
}

// ─── Badge Updates ─────────────────────────────────────────────────────────

function updateBadges(gltf: GLTF) {
  document.getElementById('badge-model')!.textContent = config.modelUrl.split('/').pop() || '--'
  document.getElementById('badge-anims')!.textContent = gltf.animations.length + ' anims'

  // Count triangles
  let tris = 0
  gltf.scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      const geo = mesh.geometry
      if (geo.index) {
        tris += geo.index.count / 3
      } else if (geo.attributes.position) {
        tris += geo.attributes.position.count / 3
      }
    }
  })
  document.getElementById('badge-tris')!.textContent = Math.round(tris).toLocaleString() + ' tris'
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER LOOP
// ═══════════════════════════════════════════════════════════════════════════

let frameCount = 0
let fpsTime = 0

function animate() {
  requestAnimationFrame(animate)

  const dt = clock.getDelta()

  // FPS counter
  frameCount++
  fpsTime += dt
  if (fpsTime >= 0.5) {
    document.getElementById('fps-display')!.textContent = Math.round(frameCount / fpsTime) + ' fps'
    frameCount = 0
    fpsTime = 0
  }

  // Controls
  controls.update()

  // Animations
  if (currentMixer) {
    currentMixer.update(dt)
  }

  // Update timeline scrubber + process animation events
  if (activeAction) {
    const clip = activeAction.getClip()
    const currentTime = activeAction.time % clip.duration
    const progress = clip.duration > 0 ? currentTime / clip.duration : 0
    const progressEl = document.getElementById('anim-progress')
    if (progressEl) progressEl.style.width = (progress * 100) + '%'

    // Detect animation loop restart → clear fired events
    if (currentTime < lastAnimTime - 0.1) {
      firedEventIds.clear()
    }
    lastAnimTime = currentTime

    // Process events if enabled and animation is playing (not paused)
    if (overlayVisibility.processEvents && !activeAction.paused) {
      for (const evt of animEvents) {
        if (!evt.animation || evt.animation !== activeClipName) continue
        if (firedEventIds.has(evt.id)) continue

        // Check if current time has crossed the event time
        if (currentTime >= evt.time) {
          firedEventIds.add(evt.id)
          triggerEvent(evt)
        }
      }
    }
  }

  // Update fire direction arrow position and direction each frame
  if (fireDirectionArrow && fireDirectionArrow.visible && firePointMarker) {
    const arrowPos = new THREE.Vector3()
    firePointMarker.getWorldPosition(arrowPos)
    fireDirectionArrow.position.copy(arrowPos)
    const dir = getFireDirection()
    fireDirectionArrow.setDirection(dir)
  }

  // HP bar billboard
  if (hpBarGroup && hpBarGroup.visible) {
    hpBarGroup.quaternion.copy(camera.quaternion)
  }

  // Live effects
  for (let i = liveEffects.length - 1; i >= 0; i--) {
    const alive = liveEffects[i].update(dt)
    if (!alive) {
      liveEffects.splice(i, 1)
    }
  }

  // Render
  renderer.render(scene, camera)
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════════

init()
