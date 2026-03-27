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
}
