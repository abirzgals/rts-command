import * as THREE from 'three'
import { scene } from './engine'
import { getTerrainHeight } from '../terrain/heightmap'
import { profCount } from '../debug/profiler'

// ── Smoke trail particles ───────────────────────────────────
interface SmokeParticle {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  vx: number
  vy: number
  vz: number
}

const smokeParticles: SmokeParticle[] = []
const MAX_SMOKE = 150 // cap active smoke particles
const smokeGeo = new THREE.SphereGeometry(0.15, 4, 4)
const smokeMat = new THREE.MeshBasicMaterial({
  color: 0x888888,
  transparent: true,
  opacity: 0.6,
  depthWrite: false,
})

export function spawnSmoke(x: number, y: number, z: number, count = 1) {
  for (let i = 0; i < count; i++) {
    if (smokeParticles.length >= MAX_SMOKE) return // cap
    const mesh = new THREE.Mesh(smokeGeo, smokeMat) // share material
    mesh.position.set(
      x + (Math.random() - 0.5) * 0.3,
      y + (Math.random() - 0.5) * 0.3,
      z + (Math.random() - 0.5) * 0.3,
    )
    scene.add(mesh)

    smokeParticles.push({
      mesh,
      life: 0,
      maxLife: 0.5 + Math.random() * 0.5,
      vx: (Math.random() - 0.5) * 1.5,
      vy: 1.0 + Math.random() * 2.0,
      vz: (Math.random() - 0.5) * 1.5,
    })
  }
}

// ── Explosion flash ─────────────────────────────────────────
interface Explosion {
  mesh: THREE.Mesh
  life: number
  maxLife: number
}

const explosions: Explosion[] = []
const explosionGeo = new THREE.SphereGeometry(1, 8, 8)

export function spawnExplosion(x: number, y: number, z: number, radius = 2.0) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff6600,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(explosionGeo, mat)
  mesh.position.set(x, y + 0.5, z)
  mesh.scale.setScalar(radius * 0.3)
  scene.add(mesh)

  explosions.push({ mesh, life: 0, maxLife: 0.4 })

  // Also spawn smoke burst
  spawnSmoke(x, y + 0.5, z, 6)
}

// ── Impact sparks (bullet/projectile hit) ───────────────────

const sparkGeo = new THREE.SphereGeometry(0.06, 4, 4)

export function spawnImpact(x: number, y: number, z: number, cfg?: { color?: string; size?: number; particles?: number; lifetime?: number }) {
  const count = cfg?.particles ?? 5
  const color = cfg?.color ? parseInt(cfg.color.replace('#', ''), 16) : 0xffaa22
  const lifetime = cfg?.lifetime ?? 0.3
  const size = cfg?.size ?? 0.4

  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false })
    const mesh = new THREE.Mesh(sparkGeo, mat)
    mesh.position.set(
      x + (Math.random() - 0.5) * size * 0.3,
      y + Math.random() * size * 0.3,
      z + (Math.random() - 0.5) * size * 0.3,
    )
    scene.add(mesh)

    const angle = Math.random() * Math.PI * 2
    const speed = 2 + Math.random() * 4
    smokeParticles.push({
      mesh,
      life: 0,
      maxLife: lifetime + Math.random() * 0.2,
      vx: Math.cos(angle) * speed,
      vy: 1 + Math.random() * 3,
      vz: Math.sin(angle) * speed,
    })
  }
}

// ── Muzzle/impact flash lights ──────────────────────────────
interface FlashLight {
  light: THREE.PointLight
  maxLife: number
  life: number       // counts up from 0
  baseIntensity: number
}

const flashLights: FlashLight[] = []
const MAX_FLASH_LIGHTS = 6

const flashGeo = new THREE.SphereGeometry(0.12, 6, 6)

function addFlashLight(x: number, y: number, z: number, color: number, intensity: number, range: number, duration: number) {
  // If at cap, replace the oldest (shortest remaining life)
  if (flashLights.length >= MAX_FLASH_LIGHTS) {
    let oldestIdx = 0, oldestRemaining = Infinity
    for (let i = 0; i < flashLights.length; i++) {
      const remaining = flashLights[i].maxLife - flashLights[i].life
      if (remaining < oldestRemaining) { oldestRemaining = remaining; oldestIdx = i }
    }
    scene.remove(flashLights[oldestIdx].light)
    flashLights[oldestIdx].light.dispose()
    flashLights.splice(oldestIdx, 1)
  }
  const light = new THREE.PointLight(color, intensity, range)
  light.castShadow = false
  light.position.set(x, y, z)
  scene.add(light)
  flashLights.push({ light, maxLife: duration, life: 0, baseIntensity: intensity })
}

/** Spawn a small impact flash at hit point */
export function spawnImpactFlash(x: number, y: number, z: number) {
  addFlashLight(x, y, z, 0xffaa44, 4, 5, 0.15)
}

const muzzleMatCache = new Map<number, THREE.MeshBasicMaterial>()

export function spawnMuzzleFlash(x: number, y: number, z: number, cfg?: { color?: string; intensity?: number; range?: number; duration?: number }) {
  const colorVal = cfg?.color ? parseInt(cfg.color.replace('#', ''), 16) : 0xffaa44

  // Flash light — 300ms with exponential decay
  addFlashLight(x, y, z, colorVal, cfg?.intensity ?? 6, cfg?.range ?? 8, 0.3)

  // Visible flash sphere
  if (!muzzleMatCache.has(colorVal)) {
    muzzleMatCache.set(colorVal, new THREE.MeshBasicMaterial({
      color: colorVal, transparent: true, opacity: 0.9, depthWrite: false,
    }))
  }
  const mesh = new THREE.Mesh(flashGeo, muzzleMatCache.get(colorVal)!)
  mesh.position.set(x, y, z)
  mesh.scale.setScalar(0.5)
  scene.add(mesh)
  explosions.push({ mesh, life: 0, maxLife: 0.15 })
}

// ── Action target indicator (animated dashed circle) ────────

interface ActionIndicator {
  line: THREE.Line
  life: number
  maxLife: number
}

const actionIndicators: ActionIndicator[] = []

/**
 * Spawn an animated dashed circle around a target entity.
 * @param x,y,z — world position of target
 * @param radius — visual boundary radius
 * @param color — 'attack' (red), 'gather' (green), 'assist' (white)
 */
export function spawnActionIndicator(
  x: number, y: number, z: number,
  radius: number,
  color: 'attack' | 'gather' | 'assist',
) {
  const segments = 64
  const points: THREE.Vector3[] = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    points.push(new THREE.Vector3(
      Math.cos(angle) * radius,
      0,
      Math.sin(angle) * radius,
    ))
  }
  const geo = new THREE.BufferGeometry().setFromPoints(points)

  const hex = color === 'attack' ? 0xff3333 : color === 'gather' ? 0x44ff88 : 0xffffff
  const mat = new THREE.LineDashedMaterial({
    color: hex,
    dashSize: radius * 0.4,
    gapSize: radius * 0.25,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    linewidth: 1,
  })

  const line = new THREE.Line(geo, mat)
  line.computeLineDistances() // required for LineDashedMaterial
  line.position.set(x, y + 0.2, z)
  line.renderOrder = 51
  scene.add(line)

  actionIndicators.push({ line, life: 0, maxLife: 1.0 })
}

function updateActionIndicators(dt: number) {
  for (let i = actionIndicators.length - 1; i >= 0; i--) {
    const ind = actionIndicators[i]
    ind.life += dt

    if (ind.life >= ind.maxLife) {
      scene.remove(ind.line)
      ind.line.geometry.dispose()
      ;(ind.line.material as THREE.Material).dispose()
      actionIndicators.splice(i, 1)
      continue
    }

    const t = ind.life / ind.maxLife
    const mat = ind.line.material as THREE.LineDashedMaterial

    // Rotate the circle to animate the dashes
    ind.line.rotation.y = ind.life * 3.0

    // Fade out in second half
    mat.opacity = t < 0.5 ? 1.0 : 2.0 * (1.0 - t)

    // Slight pulse scale
    const pulse = 1.0 + Math.sin(ind.life * 8) * 0.03
    ind.line.scale.setScalar(pulse)
  }
}

// ── Move target marker (green ring that fades) ─────────────

interface TargetMarker {
  ring: THREE.Mesh
  life: number
}

const targetMarkers: TargetMarker[] = []

export function spawnMoveMarker(x: number, y: number, z: number) {
  const geo = new THREE.RingGeometry(0.3, 0.6, 24)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.MeshBasicMaterial({
    color: 0x44ff66,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const ring = new THREE.Mesh(geo, mat)
  ring.position.set(x, y + 0.15, z)
  ring.renderOrder = 50
  scene.add(ring)
  targetMarkers.push({ ring, life: 2.0 })
}

// ── Tank death explosion + debris ───────────────────────────
interface Debris {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  vx: number
  vy: number
  vz: number
  rotSpeed: THREE.Vector3
}

const debrisPieces: Debris[] = []
const debrisGeos = [
  new THREE.BoxGeometry(0.4, 0.2, 0.3),
  new THREE.BoxGeometry(0.6, 0.15, 0.25),
  new THREE.BoxGeometry(0.3, 0.3, 0.5),
  new THREE.CylinderGeometry(0.1, 0.1, 0.5, 6),
]
const debrisMat = new THREE.MeshPhongMaterial({
  color: 0x555555,
  flatShading: true,
})

export function spawnTankDeathExplosion(x: number, y: number, z: number) {
  // Central shockwave explosion
  spawnExplosion(x, y, z, 1.75)

  // Fire burst flash
  const fireMat = new THREE.MeshBasicMaterial({
    color: 0xff8800, transparent: true, opacity: 0.9, depthWrite: false,
  })
  const fireMesh = new THREE.Mesh(explosionGeo, fireMat)
  fireMesh.position.set(x, y + 1.0, z)
  fireMesh.scale.setScalar(0.8)
  scene.add(fireMesh)
  explosions.push({ mesh: fireMesh, life: 0, maxLife: 0.6 })

  // Secondary fire explosion
  const fire2 = new THREE.Mesh(explosionGeo, fireMat.clone())
  fire2.position.set(x + (Math.random() - 0.5) * 1.5, y + 0.5, z + (Math.random() - 0.5) * 1.5)
  fire2.scale.setScalar(0.4)
  scene.add(fire2)
  explosions.push({ mesh: fire2, life: 0, maxLife: 0.8 })

  // Bright flash light
  addFlashLight(x, y + 2, z, 0xff6600, 20, 25, 0.5)

  // Spawn debris pieces — bigger, more dramatic
  const DEBRIS_COUNT = 14
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    const geoIdx = Math.floor(Math.random() * debrisGeos.length)
    const geo = debrisGeos[geoIdx]
    const mat = debrisMat.clone()
    // Variety: dark metal, burnt, or glowing hot
    const colorRoll = Math.random()
    mat.color.setHex(colorRoll > 0.7 ? 0x884411 : colorRoll > 0.4 ? 0x555555 : 0x333333)
    if (colorRoll > 0.85) {
      mat.emissive = new THREE.Color(0xff4400)
      mat.emissiveIntensity = 0.5
    }
    const mesh = new THREE.Mesh(geo, mat)
    const scale = 0.8 + Math.random() * 1.2
    mesh.scale.setScalar(scale)
    mesh.position.set(
      x + (Math.random() - 0.5) * 1.0,
      y + 0.5 + Math.random() * 0.8,
      z + (Math.random() - 0.5) * 1.0,
    )
    scene.add(mesh)

    const angle = Math.random() * Math.PI * 2
    const speed = 4 + Math.random() * 8
    debrisPieces.push({
      mesh,
      life: 0,
      maxLife: 4.0 + Math.random() * 3.0,
      vx: Math.cos(angle) * speed,
      vy: 5 + Math.random() * 10,
      vz: Math.sin(angle) * speed,
      rotSpeed: new THREE.Vector3(
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 12,
      ),
    })
  }

  // Heavy smoke column
  spawnSmoke(x, y + 0.5, z, 18)

  // Fire particles lingering on ground
  spawnFireExplosion(x, y, z, 2.5)
}

// ── Update all effects each frame ───────────────────────────
export function updateEffects(dt: number) {
  profCount('fx.smoke', smokeParticles.length)
  profCount('fx.lights', flashLights.length)
  // Smoke particles
  for (let i = smokeParticles.length - 1; i >= 0; i--) {
    const p = smokeParticles[i]
    p.life += dt

    if (p.life >= p.maxLife) {
      scene.remove(p.mesh)
      ;(p.mesh.material as THREE.Material).dispose()
      smokeParticles.splice(i, 1)
      continue
    }

    const t = p.life / p.maxLife
    p.mesh.position.x += p.vx * dt
    p.mesh.position.y += p.vy * dt
    p.mesh.position.z += p.vz * dt

    // Grow and fade
    const scale = 0.3 + t * 1.5
    p.mesh.scale.setScalar(scale)
    ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - t)
  }

  // Explosions
  for (let i = explosions.length - 1; i >= 0; i--) {
    const e = explosions[i]
    e.life += dt

    if (e.life >= e.maxLife) {
      scene.remove(e.mesh)
      ;(e.mesh.material as THREE.Material).dispose()
      explosions.splice(i, 1)
      continue
    }

    const t = e.life / e.maxLife
    // Expand rapidly then fade
    const scale = e.mesh.scale.x * (1 + dt * 8)
    e.mesh.scale.setScalar(scale)

    const mat = e.mesh.material as THREE.MeshBasicMaterial
    // Orange → red → dark
    mat.color.setHex(t < 0.3 ? 0xffaa00 : t < 0.6 ? 0xff4400 : 0x441100)
    mat.opacity = 0.9 * (1 - t)
  }

  // Flash lights — exponential decay (bright start, gradual fade)
  for (let i = flashLights.length - 1; i >= 0; i--) {
    const f = flashLights[i]
    f.life += dt
    if (f.life >= f.maxLife) {
      scene.remove(f.light)
      f.light.dispose()
      flashLights.splice(i, 1)
    } else {
      // Exponential decay: starts at full intensity, fades slowly then drops fast
      const t = f.life / f.maxLife // 0→1
      const decay = Math.pow(1 - t, 3) // cubic falloff: slow start, fast end
      f.light.intensity = f.baseIntensity * decay
    }
  }

  // Debris pieces (tank death)
  const GRAVITY = -15
  for (let i = debrisPieces.length - 1; i >= 0; i--) {
    const d = debrisPieces[i]
    d.life += dt

    if (d.life >= d.maxLife) {
      scene.remove(d.mesh)
      ;(d.mesh.material as THREE.Material).dispose()
      debrisPieces.splice(i, 1)
      continue
    }

    // Physics: gravity + velocity
    d.vy += GRAVITY * dt
    d.mesh.position.x += d.vx * dt
    d.mesh.position.y += d.vy * dt
    d.mesh.position.z += d.vz * dt

    // Clamp to ground
    if (d.mesh.position.y < 0.1) {
      d.mesh.position.y = 0.1
      d.vy = -d.vy * 0.3 // bounce with damping
      d.vx *= 0.7
      d.vz *= 0.7
    }

    // Tumble rotation
    d.mesh.rotation.x += d.rotSpeed.x * dt
    d.mesh.rotation.y += d.rotSpeed.y * dt
    d.mesh.rotation.z += d.rotSpeed.z * dt

    // Smoke trail while airborne (first 2 seconds only)
    if (d.life < 2.0 && d.mesh.position.y > 0.5 && Math.random() < 0.3) {
      spawnSmoke(d.mesh.position.x, d.mesh.position.y, d.mesh.position.z, 1)
    }

    // Fade out in last second
    const remaining = d.maxLife - d.life
    if (remaining < 1.0) {
      const mat = d.mesh.material as THREE.MeshPhongMaterial
      if (!mat.transparent) {
        mat.transparent = true
      }
      mat.opacity = remaining
    }
  }

  // Target markers (move command indicators)
  for (let i = targetMarkers.length - 1; i >= 0; i--) {
    const m = targetMarkers[i]
    m.life -= dt
    if (m.life <= 0) {
      scene.remove(m.ring)
      m.ring.geometry.dispose()
      ;(m.ring.material as THREE.Material).dispose()
      targetMarkers.splice(i, 1)
      continue
    }
    // Shrink and fade
    const t = m.life / 2.0
    ;(m.ring.material as THREE.MeshBasicMaterial).opacity = t * 0.8
    m.ring.scale.setScalar(0.5 + t * 0.5)
  }

  // ── Resource effects (crystals + gas) ─────────────────────
  updateActionIndicators(dt)
  updateTrailParticles(dt)
  updateFireParticles(dt)
  updateResourceEffects(dt)
}

// ═══════════════════════════════════════════════════════════════
// ── Rocket trail — fire + smoke behind flying projectile ─────
// Spawned every frame while projectile is in flight

interface TrailParticle {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  vx: number; vy: number; vz: number
  isFire: boolean
}

const trailParticles: TrailParticle[] = []
const trailFireGeo = new THREE.SphereGeometry(0.3, 5, 5)
const trailSmokeGeo = new THREE.SphereGeometry(0.4, 4, 4)

export function spawnRocketTrail(x: number, y: number, z: number, count = 3) {
  for (let i = 0; i < count; i++) {
    const isFire = i < Math.ceil(count * 0.6)
    const geo = isFire ? trailFireGeo : trailSmokeGeo
    const mat = new THREE.MeshBasicMaterial({
      color: isFire ? (Math.random() > 0.5 ? 0xff6600 : 0xff2200) : 0x999999,
      transparent: true,
      opacity: isFire ? 0.9 : 0.6,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(
      x + (Math.random() - 0.5) * 0.3,
      y + (Math.random() - 0.5) * 0.3,
      z + (Math.random() - 0.5) * 0.3,
    )
    scene.add(mesh)

    trailParticles.push({
      mesh,
      life: 0,
      maxLife: isFire ? 0.4 + Math.random() * 0.4 : 0.8 + Math.random() * 1.0,
      vx: (Math.random() - 0.5) * 1.0,
      vy: 0.5 + Math.random() * 1.5,
      vz: (Math.random() - 0.5) * 1.0,
      isFire,
    })
  }
}

function updateTrailParticles(dt: number) {
  for (let i = trailParticles.length - 1; i >= 0; i--) {
    const p = trailParticles[i]
    p.life += dt

    if (p.life >= p.maxLife) {
      scene.remove(p.mesh)
      ;(p.mesh.material as THREE.Material).dispose()
      trailParticles.splice(i, 1)
      continue
    }

    const t = p.life / p.maxLife
    p.mesh.position.x += p.vx * dt
    p.mesh.position.y += p.vy * dt
    p.mesh.position.z += p.vz * dt

    const mat = p.mesh.material as THREE.MeshBasicMaterial

    if (p.isFire) {
      // Fire: bright start, flicker, shrink
      const flicker = 0.8 + Math.sin(p.life * 20) * 0.2
      const scale = (1.0 - t * 0.7) * flicker
      p.mesh.scale.setScalar(scale)
      mat.color.setHex(t < 0.3 ? 0xff6600 : t < 0.6 ? 0xff2200 : 0x881100)
      mat.opacity = (1 - t) * 0.9
    } else {
      // Smoke: grow and fade
      const scale = 0.5 + t * 2.0
      p.mesh.scale.setScalar(scale)
      mat.opacity = 0.5 * (1 - t)
    }
  }
}

// ── Fire explosion with long-living fire particles ──────────

interface FireParticle {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  vx: number; vy: number; vz: number
}

const fireParticles: FireParticle[] = []
const fireGeo = new THREE.SphereGeometry(0.25, 4, 4)

export function spawnFireExplosion(x: number, y: number, z: number, radius = 3.0) {
  // Big central explosion
  spawnExplosion(x, y, z, radius)

  // Fire flash light
  addFlashLight(x, y + 1.5, z, 0xff4400, 15, 20, 0.4)

  // Long-living fire particles that linger on the ground
  const FIRE_COUNT = 15
  for (let i = 0; i < FIRE_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2
    const dist = Math.random() * radius * 0.8
    const fx = x + Math.cos(angle) * dist
    const fz = z + Math.sin(angle) * dist

    const fireMat = new THREE.MeshBasicMaterial({
      color: 0xff6600,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(fireGeo, fireMat)
    mesh.position.set(fx, y + 0.3 + Math.random() * 0.5, fz)
    mesh.scale.setScalar(0.3 + Math.random() * 0.5)
    scene.add(mesh)

    fireParticles.push({
      mesh,
      life: 0,
      maxLife: 2.0 + Math.random() * 3.0, // 2-5 seconds of fire
      vx: (Math.random() - 0.5) * 0.3,
      vy: 0.3 + Math.random() * 0.8,
      vz: (Math.random() - 0.5) * 0.3,
    })
  }

  // Heavy smoke
  spawnSmoke(x, y + 0.5, z, 15)
}

function updateFireParticles(dt: number) {
  for (let i = fireParticles.length - 1; i >= 0; i--) {
    const p = fireParticles[i]
    p.life += dt

    if (p.life >= p.maxLife) {
      scene.remove(p.mesh)
      ;(p.mesh.material as THREE.Material).dispose()
      fireParticles.splice(i, 1)
      continue
    }

    const t = p.life / p.maxLife

    // Rise slowly, flicker
    p.mesh.position.x += p.vx * dt
    p.mesh.position.y += p.vy * dt
    p.mesh.position.z += p.vz * dt

    // Color transition: orange → red → dark
    const mat = p.mesh.material as THREE.MeshBasicMaterial
    if (t < 0.3) {
      mat.color.setHex(0xff6600) // orange
    } else if (t < 0.6) {
      mat.color.setHex(0xff2200) // red
    } else {
      mat.color.setHex(0x441100) // dark ember
    }

    // Flicker size
    const flicker = 0.8 + Math.sin(p.life * 15) * 0.2
    const scale = (1 - t * 0.5) * flicker
    p.mesh.scale.setScalar(scale * 0.5)

    // Fade out
    mat.opacity = (1 - t) * 0.8
  }
}

// Resource node ambient effects
// ═══════════════════════════════════════════════════════════════

interface ResourceFX {
  particles: THREE.Points
  positions: Float32Array
  velocities: Float32Array // vy per particle
  lives: Float32Array
  maxLife: Float32Array
  count: number
  type: number // 0=mineral, 1=gas
  baseX: number
  baseY: number
  baseZ: number
}

const resourceEffects: ResourceFX[] = []

const MINERAL_PARTICLE_COUNT = 20
const GAS_PARTICLE_COUNT = 15

/** Create ambient effects for a resource node */
export function createResourceEffect(x: number, y: number, z: number, type: number) {
  const isMinerals = type === 0

  // Sparkle/steam particles
  const count = isMinerals ? MINERAL_PARTICLE_COUNT : GAS_PARTICLE_COUNT
  const positions = new Float32Array(count * 3)
  const velocities = new Float32Array(count)
  const lives = new Float32Array(count)
  const maxLife = new Float32Array(count)

  // Initialize particles at random positions around the resource
  for (let i = 0; i < count; i++) {
    resetParticle(i, positions, velocities, lives, maxLife, x, y, z, isMinerals)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))

  const mat = new THREE.PointsMaterial({
    size: isMinerals ? 0.15 : 0.25,
    color: isMinerals ? 0x88eeff : 0x88ff88,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    sizeAttenuation: true,
    blending: THREE.AdditiveBlending,
  })

  const particles = new THREE.Points(geo, mat)
  particles.frustumCulled = false
  scene.add(particles)

  resourceEffects.push({
    particles, positions, velocities, lives, maxLife,
    count, type, baseX: x, baseY: y, baseZ: z,
  })
}

function resetParticle(
  i: number, pos: Float32Array, vel: Float32Array,
  lives: Float32Array, maxL: Float32Array,
  bx: number, by: number, bz: number,
  isMinerals: boolean,
) {
  const i3 = i * 3
  if (isMinerals) {
    // Sparkles: float up from crystal tips
    pos[i3] = bx + (Math.random() - 0.5) * 1.2
    pos[i3 + 1] = by + Math.random() * 0.8
    pos[i3 + 2] = bz + (Math.random() - 0.5) * 1.2
    vel[i] = 0.3 + Math.random() * 0.6 // upward speed
    maxL[i] = 1.0 + Math.random() * 2.0
  } else {
    // Gas steam: rise from vent
    pos[i3] = bx + (Math.random() - 0.5) * 0.5
    pos[i3 + 1] = by + 0.5 + Math.random() * 0.3
    pos[i3 + 2] = bz + (Math.random() - 0.5) * 0.5
    vel[i] = 0.5 + Math.random() * 1.0
    maxL[i] = 1.5 + Math.random() * 2.0
  }
  lives[i] = Math.random() * maxL[i] // stagger starts
}

function updateResourceEffects(dt: number) {
  for (const fx of resourceEffects) {
    const isMinerals = fx.type === 0

    // Update particles
    const pos = fx.positions
    for (let i = 0; i < fx.count; i++) {
      fx.lives[i] += dt
      const i3 = i * 3

      if (fx.lives[i] >= fx.maxLife[i]) {
        // Respawn
        resetParticle(i, pos, fx.velocities, fx.lives, fx.maxLife, fx.baseX, fx.baseY, fx.baseZ, isMinerals)
        fx.lives[i] = 0
        continue
      }

      const t = fx.lives[i] / fx.maxLife[i]

      // Move upward
      pos[i3 + 1] += fx.velocities[i] * dt

      if (isMinerals) {
        // Sparkles drift slightly sideways + twinkle
        pos[i3] += Math.sin(fx.lives[i] * 3 + i) * 0.1 * dt
        pos[i3 + 2] += Math.cos(fx.lives[i] * 2.5 + i * 0.7) * 0.1 * dt
      } else {
        // Gas spreads out as it rises
        pos[i3] += (Math.random() - 0.5) * 0.3 * dt
        pos[i3 + 2] += (Math.random() - 0.5) * 0.3 * dt
      }
    }

    // Update geometry
    ;(fx.particles.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true

    // Pulse particle opacity
    const mat = fx.particles.material as THREE.PointsMaterial
    const pulse = Math.sin(performance.now() * 0.002 + fx.baseX) * 0.3 + 0.7
    mat.opacity = isMinerals ? 0.7 + pulse * 0.3 : 0.4 + pulse * 0.2
  }
}

// ── Wreckage falling pieces ─────────────────────────────────
interface FallingPiece {
  mesh: THREE.Mesh
  vy: number        // vertical velocity
  vx: number        // horizontal drift
  vz: number
  rotSpeed: THREE.Vector3 // tumble rotation
  groundY: number
  life: number
  sinkTimer: number  // time before sinking starts
}

const fallingPieces: FallingPiece[] = []
const GRAVITY = -15
const SINK_SPEED = 1.5

export function spawnFallingPieces(pieces: THREE.Mesh[], groundY: number) {
  for (const mesh of pieces) {
    fallingPieces.push({
      mesh,
      vy: Math.random() * 3 + 1,       // slight upward pop
      vx: (Math.random() - 0.5) * 2,   // gentle sideways drift
      vz: (Math.random() - 0.5) * 2,
      rotSpeed: new THREE.Vector3(
        (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 3,
      ),
      groundY,
      life: 0,
      sinkTimer: 3.0,  // seconds before sinking
    })
  }
}

export function updateFallingPieces(dt: number) {
  profCount('fx.wreckage', fallingPieces.length)
  profCount('fx.blood', bloodDecals.length)
  for (let i = fallingPieces.length - 1; i >= 0; i--) {
    const p = fallingPieces[i]
    p.life += dt

    if (p.sinkTimer > 0) {
      // Phase 1: Falling + settling
      p.vy += GRAVITY * dt
      p.mesh.position.x += p.vx * dt
      p.mesh.position.y += p.vy * dt
      p.mesh.position.z += p.vz * dt

      // Tumble
      p.mesh.rotation.x += p.rotSpeed.x * dt
      p.mesh.rotation.y += p.rotSpeed.y * dt
      p.mesh.rotation.z += p.rotSpeed.z * dt

      // Ground collision
      if (p.mesh.position.y <= p.groundY) {
        p.mesh.position.y = p.groundY
        p.vy = Math.abs(p.vy) * 0.2 // tiny bounce
        if (Math.abs(p.vy) < 0.5) p.vy = 0
        // Reduce drift and spin on ground
        p.vx *= 0.8
        p.vz *= 0.8
        p.rotSpeed.multiplyScalar(0.8)
      }

      // Count down sink timer only after on ground
      if (p.mesh.position.y <= p.groundY + 0.1 && p.vy === 0) {
        p.sinkTimer -= dt
      }
    } else {
      // Phase 2: Sinking into ground
      p.mesh.position.y -= SINK_SPEED * dt

      // Remove when fully underground
      if (p.mesh.position.y < p.groundY - 3) {
        scene.remove(p.mesh)
        const mats = Array.isArray(p.mesh.material) ? p.mesh.material : [p.mesh.material]
        for (const m of mats) (m as THREE.Material).dispose()
        p.mesh.geometry.dispose()
        fallingPieces.splice(i, 1)
      }
    }
  }
}

// ── Blood decals ────────────────────────────────────────────
interface BloodDecal {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  fadeStart: number // life at which fading begins
}

const bloodDecals: BloodDecal[] = []
const MAX_BLOOD = 40
let bloodTexture: THREE.Texture | null = null
let bloodTextureLoading = false
const bloodGeo = new THREE.PlaneGeometry(1, 1)
let bloodMat: THREE.MeshBasicMaterial | null = null

function ensureBloodTexture(): THREE.Texture | null {
  if (bloodTexture) return bloodTexture
  if (bloodTextureLoading) return null
  bloodTextureLoading = true
  new THREE.TextureLoader().load('/images/blood-decal.png', (tex) => {
    bloodTexture = tex
    bloodMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  })
  return null
}

export function spawnBloodSplat(x: number, z: number, size: number) {
  ensureBloodTexture()
  if (!bloodMat) return

  // Remove oldest if at cap
  while (bloodDecals.length >= MAX_BLOOD) {
    const old = bloodDecals.shift()!
    scene.remove(old.mesh)
    old.mesh.geometry = undefined as any // shared geo, don't dispose
  }

  const y = getTerrainHeight(x, z) + 0.05
  const mesh = new THREE.Mesh(bloodGeo, bloodMat) // shared material
  mesh.rotation.x = -Math.PI / 2
  mesh.rotation.z = Math.random() * Math.PI * 2
  mesh.position.set(x + (Math.random() - 0.5) * 0.5, y, z + (Math.random() - 0.5) * 0.5)
  mesh.scale.setScalar(size)
  mesh.renderOrder = 1
  scene.add(mesh)

  bloodDecals.push({ mesh, life: 0, maxLife: 8, fadeStart: 4 })
}

/** Small blood hit splats — 1-2 tiny decals */
export function spawnBloodHit(x: number, z: number) {
  const count = 1 + Math.floor(Math.random() * 2)
  for (let i = 0; i < count; i++) {
    spawnBloodSplat(
      x + (Math.random() - 0.5) * 1.5,
      z + (Math.random() - 0.5) * 1.5,
      0.3 + Math.random() * 0.4, // small: 0.3-0.7
    )
  }
}

/** Death blood splash — larger pool */
export function spawnBloodDeath(x: number, z: number) {
  // Main pool
  spawnBloodSplat(x, z, 1.0 + Math.random() * 0.5)
  // Extra splatters
  for (let i = 0; i < 3; i++) {
    spawnBloodSplat(
      x + (Math.random() - 0.5) * 2,
      z + (Math.random() - 0.5) * 2,
      0.4 + Math.random() * 0.5,
    )
  }
}

export function updateBloodDecals(dt: number) {
  for (let i = bloodDecals.length - 1; i >= 0; i--) {
    const d = bloodDecals[i]
    d.life += dt

    if (d.life >= d.maxLife) {
      scene.remove(d.mesh)
      bloodDecals.splice(i, 1)
      continue
    }

    // Fade out by scaling down (shared material can't change opacity per-instance)
    if (d.life > d.fadeStart) {
      const t = (d.life - d.fadeStart) / (d.maxLife - d.fadeStart)
      d.mesh.scale.setScalar(d.mesh.scale.x * (1 - t * 0.02)) // gentle shrink
    }
  }
}
