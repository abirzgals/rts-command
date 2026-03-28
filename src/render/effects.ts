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

export function spawnMuzzleFlash(x: number, y: number, z: number) {
  const light = new THREE.PointLight(0xffaa44, 8, 12)
  light.position.set(x, y + 1.5, z)
  scene.add(light)
  muzzleFlashes.push({ light, life: 0.1 })
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
}
