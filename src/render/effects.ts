import * as THREE from 'three'
import { scene } from './engine'

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
const smokeGeo = new THREE.SphereGeometry(0.15, 4, 4)
const smokeMat = new THREE.MeshBasicMaterial({
  color: 0x888888,
  transparent: true,
  opacity: 0.6,
  depthWrite: false,
})

export function spawnSmoke(x: number, y: number, z: number, count = 1) {
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(smokeGeo, smokeMat.clone())
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

// ── Muzzle flash ────────────────────────────────────────────
interface MuzzleFlash {
  light: THREE.PointLight
  life: number
}

const muzzleFlashes: MuzzleFlash[] = []

export function spawnMuzzleFlash(x: number, y: number, z: number, cfg?: { color?: string; intensity?: number; range?: number; duration?: number }) {
  const color = cfg?.color ? parseInt(cfg.color.replace('#', ''), 16) : 0xffaa44
  const light = new THREE.PointLight(color, cfg?.intensity ?? 8, cfg?.range ?? 12)
  light.position.set(x, y, z)
  scene.add(light)
  muzzleFlashes.push({ light, life: cfg?.duration ?? 0.1 })
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
  // Big central explosion
  spawnExplosion(x, y, z, 3.0)

  // Extra fire burst
  const fireMat = new THREE.MeshBasicMaterial({
    color: 0xff8800,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  })
  const fireMesh = new THREE.Mesh(explosionGeo, fireMat)
  fireMesh.position.set(x, y + 1.0, z)
  fireMesh.scale.setScalar(0.5)
  scene.add(fireMesh)
  explosions.push({ mesh: fireMesh, life: 0, maxLife: 0.6 })

  // Spawn debris pieces that fly apart
  const DEBRIS_COUNT = 8
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    const geo = debrisGeos[Math.floor(Math.random() * debrisGeos.length)]
    const mat = debrisMat.clone()
    mat.color.setHex(Math.random() > 0.5 ? 0x555555 : 0x443322)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(
      x + (Math.random() - 0.5) * 0.5,
      y + 0.5 + Math.random() * 0.5,
      z + (Math.random() - 0.5) * 0.5,
    )
    scene.add(mesh)

    const angle = Math.random() * Math.PI * 2
    const speed = 3 + Math.random() * 5
    debrisPieces.push({
      mesh,
      life: 0,
      maxLife: 5.0,
      vx: Math.cos(angle) * speed,
      vy: 4 + Math.random() * 6,
      vz: Math.sin(angle) * speed,
      rotSpeed: new THREE.Vector3(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
      ),
    })
  }

  // Heavy smoke
  spawnSmoke(x, y + 0.5, z, 12)
}

// ── Update all effects each frame ───────────────────────────
export function updateEffects(dt: number) {
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

  // Muzzle flashes
  for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
    const f = muzzleFlashes[i]
    f.life -= dt
    if (f.life <= 0) {
      scene.remove(f.light)
      f.light.dispose()
      muzzleFlashes.splice(i, 1)
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
  updateFireParticles(dt)
  updateResourceEffects(dt)
}

// ═══════════════════════════════════════════════════════════════
// ── Rocket smoke trail ──────────────────────────────────────
// Spawned every frame while rocket is in flight

const rocketTrailGeo = new THREE.SphereGeometry(0.2, 4, 4)

export function spawnRocketTrail(x: number, y: number, z: number, count = 3) {
  for (let i = 0; i < count; i++) {
    const mat = smokeMat.clone()
    mat.color.setHex(i === 0 ? 0xff6600 : 0x888888) // first = fire, rest = smoke
    mat.opacity = i === 0 ? 0.8 : 0.5
    const mesh = new THREE.Mesh(rocketTrailGeo, mat)
    mesh.position.set(
      x + (Math.random() - 0.5) * 0.2,
      y + (Math.random() - 0.5) * 0.2,
      z + (Math.random() - 0.5) * 0.2,
    )
    scene.add(mesh)
    smokeParticles.push({
      mesh,
      life: 0,
      maxLife: 0.8 + Math.random() * 0.6,
      vx: (Math.random() - 0.5) * 0.5,
      vy: 0.5 + Math.random() * 1.0,
      vz: (Math.random() - 0.5) * 0.5,
    })
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
  const light = new THREE.PointLight(0xff4400, 15, 20)
  light.position.set(x, y + 1.5, z)
  scene.add(light)
  muzzleFlashes.push({ light, life: 0.3 })

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
  light: THREE.PointLight
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

  // Point light: cyan glow for minerals, green for gas
  const light = new THREE.PointLight(
    isMinerals ? 0x44ccff : 0x44ff66,
    isMinerals ? 3 : 2,
    isMinerals ? 8 : 6,
  )
  light.position.set(x, y + 1.0, z)
  scene.add(light)

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
    light, particles, positions, velocities, lives, maxLife,
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

    // Animate light intensity (pulsing glow)
    const pulse = Math.sin(performance.now() * 0.002 + fx.baseX) * 0.3 + 0.7
    fx.light.intensity = (isMinerals ? 3 : 2) * pulse

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

    // Fade material based on average particle life
    const mat = fx.particles.material as THREE.PointsMaterial
    mat.opacity = isMinerals ? 0.7 + pulse * 0.3 : 0.4 + pulse * 0.2
  }
}
