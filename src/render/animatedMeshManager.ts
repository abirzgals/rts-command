import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import { scene } from './engine'
import { getTerrainHeight } from '../terrain/heightmap'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

const loader = new GLTFLoader()

export type AnimName = 'Idle' | 'Run' | 'Shoot_OneHanded' | 'Shoot' | 'Punch' | 'Death' | 'PickUp' | 'Run_Carry' | 'Walk'

interface RecoilState {
  barrelOffset: number    // current barrel slide-back (local Z)
  barrelVelocity: number  // spring velocity
  hullPitch: number       // current hull nose-up pitch (radians)
  hullPitchVel: number    // spring velocity
  active: boolean
}

interface AnimatedUnit {
  mesh: THREE.Object3D
  mixer: THREE.AnimationMixer
  actions: Map<string, THREE.AnimationAction>
  currentAnim: string
  turretBone?: THREE.Object3D
  barrelBone?: THREE.Object3D
  recoil?: RecoilState
}

/**
 * Manages individual SkinnedMesh clones for animated units.
 * Each entity gets its own mesh + AnimationMixer.
 */
export class AnimatedMeshManager {
  private gltf: GLTF | null = null
  private units = new Map<number, AnimatedUnit>()
  private scale: number
  private url: string
  private rotationOffset: number
  alignToTerrain = false  // vehicles: true, infantry: false

  constructor(url: string, scale: number, rotationOffset = 0) {
    this.url = url
    this.scale = scale
    this.rotationOffset = rotationOffset
  }

  async load(): Promise<void> {
    this.gltf = await loader.loadAsync(this.url)
    console.log(`[anim] Loaded ${this.url} with ${this.gltf.animations.length} animations`)
  }

  add(eid: number, x: number, y: number, z: number, rotY: number, color?: THREE.Color): number {
    if (!this.gltf) return -1

    // Clone with SkeletonUtils to properly clone SkinnedMesh + Skeleton
    const clone = SkeletonUtils.clone(this.gltf.scene)
    clone.scale.setScalar(this.scale)
    clone.position.set(x, y, z)
    clone.rotation.y = rotY + this.rotationOffset

    // Apply faction color — subtle emissive glow only, keep original textures
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (let i = 0; i < mats.length; i++) {
          const orig = mats[i] as THREE.MeshStandardMaterial
          const mat = orig.clone()
          if (color) {
            // Don't touch base color — only add subtle emissive tint
            mat.emissive.copy(color).multiplyScalar(0.12)
          }
          mats[i] = mat
        }
        mesh.material = mats.length === 1 ? mats[0] : mats
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })

    scene.add(clone)

    // Set up animation mixer
    const mixer = new THREE.AnimationMixer(clone)
    const actions = new Map<string, THREE.AnimationAction>()

    for (const clip of this.gltf.animations) {
      const action = mixer.clipAction(clip)
      actions.set(clip.name, action)
    }

    // Start with Idle
    const idle = actions.get('Idle')
    if (idle) {
      idle.play()
    }

    // Find turret/barrel bones for independent rotation
    // Find turret/barrel by name — can be Bone (tank-v3) or Object3D (jeep, rocket-tank)
    let turretBone: THREE.Object3D | undefined
    let barrelBone: THREE.Object3D | undefined
    clone.traverse((child) => {
      if (child.name === 'Turret') turretBone = child
      if (child.name === 'Barrel') barrelBone = child
    })

    this.units.set(eid, { mesh: clone, mixer, actions, currentAnim: 'Idle', turretBone, barrelBone })
    return 0
  }

  remove(eid: number) {
    const unit = this.units.get(eid)
    if (!unit) return

    unit.mixer.stopAllAction()
    scene.remove(unit.mesh)

    // Dispose materials and geometries
    unit.mesh.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh
        mesh.geometry.dispose()
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) m.dispose()
      }
    })

    this.units.delete(eid)
  }

  // Reusable vectors for terrain normal computation
  private static _nA = new THREE.Vector3()
  private static _nB = new THREE.Vector3()
  private static _up = new THREE.Vector3(0, 1, 0)
  private static _qTerrain = new THREE.Quaternion()

  updateTransform(eid: number, x: number, y: number, z: number, rotY: number) {
    const unit = this.units.get(eid)
    if (!unit) return
    unit.mesh.position.set(x, y, z)

    if (this.alignToTerrain) {
      // Vehicles: tilt to match terrain slope
      const S = 0.5
      const hL = getTerrainHeight(x - S, z)
      const hR = getTerrainHeight(x + S, z)
      const hF = getTerrainHeight(x, z - S)
      const hB = getTerrainHeight(x, z + S)

      const nx = -(hR - hL)
      const nz = -(hB - hF)
      const ny = 2 * S
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz)

      AnimatedMeshManager._nA.set(nx / len, ny / len, nz / len)
      AnimatedMeshManager._qTerrain.setFromUnitVectors(AnimatedMeshManager._up, AnimatedMeshManager._nA)
      unit.mesh.quaternion.copy(AnimatedMeshManager._qTerrain)
      unit.mesh.rotateY(rotY + this.rotationOffset)
    } else {
      // Infantry: stay upright
      unit.mesh.rotation.set(0, rotY + this.rotationOffset, 0)
    }
  }

  // Reusable objects to avoid per-frame allocations
  private static _v3 = new THREE.Vector3()
  private static _q1 = new THREE.Quaternion()
  private static _up = new THREE.Vector3(0, 1, 0)
  private static _right = new THREE.Vector3(1, 0, 0)

  /**
   * Rotate turret toward a world-space target, and pitch barrel to aim at it.
   * Uses smooth interpolation (slerp) for natural rotation.
   */
  updateTurretAim(eid: number, targetX: number, targetY: number, targetZ: number, dt: number) {
    const unit = this.units.get(eid)
    if (!unit?.turretBone) return

    // Convert target to mesh local space (accounts for position, rotation, scale)
    const lt = AnimatedMeshManager._v3.set(targetX, targetY, targetZ)
    unit.mesh.worldToLocal(lt)

    // Turret yaw: barrel faces -Z at rest in glTF/Three.js local space.
    // To rotate -Z toward (lt.x, lt.z), yaw = atan2(-x, -z).
    const yaw = Math.atan2(-lt.x, -lt.z)
    const q = AnimatedMeshManager._q1
    q.setFromAxisAngle(AnimatedMeshManager._up, yaw)
    unit.turretBone.quaternion.slerp(q, Math.min(1, dt * 4))

    // Barrel pitch: tilt up/down toward target
    if (unit.barrelBone) {
      const horizDist = Math.sqrt(lt.x * lt.x + lt.z * lt.z)
      // Barrel pivot is at ~Y=1.8 in model local space
      const dy = lt.y - 1.8
      const pitch = Math.atan2(dy, horizDist)
      q.setFromAxisAngle(AnimatedMeshManager._right, pitch)
      unit.barrelBone.quaternion.slerp(q, Math.min(1, dt * 4))
    }
  }

  /** Check if this unit has turret bones */
  hasTurret(eid: number): boolean {
    return !!this.units.get(eid)?.turretBone
  }

  /**
   * Get the world-space position of a fire point defined by a local offset
   * relative to a named bone. If boneName is not found, falls back to
   * barrel → turret → mesh root.
   */
  getFirePointWorld(eid: number, localX: number, localY: number, localZ: number, boneName?: string): THREE.Vector3 | null {
    const unit = this.units.get(eid)
    if (!unit) return null

    // Find the parent bone
    let parent: THREE.Object3D | null = null
    if (boneName) {
      unit.mesh.traverse((child) => {
        if (child.name === boneName) parent = child
      })
    }
    if (!parent) parent = unit.barrelBone || unit.turretBone || unit.mesh

    // Transform local offset to world space
    const v = AnimatedMeshManager._v3.set(localX, localY, localZ)
    parent.localToWorld(v)
    return v.clone()
  }

  playAnimation(eid: number, name: string, crossFadeDuration = 0.15) {
    const unit = this.units.get(eid)
    if (!unit) return
    if (unit.currentAnim === name) return

    const prev = unit.actions.get(unit.currentAnim)
    const next = unit.actions.get(name)
    if (!next) return

    next.reset()

    // One-shot animations (Death, Punch, Shoot) don't loop
    // PickUp loops when used for gathering/building
    if (name === 'Death' || name === 'Punch' || name === 'Shoot_OneHanded' || name === 'Shoot') {
      next.setLoop(THREE.LoopOnce, 1)
      next.clampWhenFinished = true
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity)
    }

    if (prev) {
      prev.fadeOut(crossFadeDuration)
    }
    next.fadeIn(crossFadeDuration).play()

    unit.currentAnim = name
  }

  getCurrentAnim(eid: number): string | undefined {
    return this.units.get(eid)?.currentAnim
  }

  /**
   * Trigger recoil on a unit — barrel slides back on a spring,
   * hull pitches up from the kick. Both spring back smoothly.
   */
  triggerRecoil(eid: number) {
    const unit = this.units.get(eid)
    if (!unit || !unit.barrelBone) return

    if (!unit.recoil) {
      unit.recoil = { barrelOffset: 0, barrelVelocity: 0, hullPitch: 0, hullPitchVel: 0, active: false }
    }

    // Kick: barrel snaps backward, hull nose kicks up
    unit.recoil.barrelVelocity = 8.0   // barrel slides back fast
    unit.recoil.hullPitchVel = -3.0    // hull nose kicks up (negative = pitch backward)
    unit.recoil.active = true
  }

  /** Update all animation mixers + recoil springs — call once per frame */
  updateMixers(dt: number) {
    // Spring constants
    const BARREL_STIFFNESS = 120   // how fast barrel returns
    const BARREL_DAMPING = 8       // how quickly oscillation dies
    const BARREL_MAX = 0.6         // max slide-back distance
    const HULL_STIFFNESS = 40      // how fast hull pitch returns
    const HULL_DAMPING = 6         // hull pitch damping
    const HULL_MAX_PITCH = 0.06    // max hull pitch (radians, ~3.5°)

    for (const [, unit] of this.units) {
      unit.mixer.update(dt)

      // Update recoil spring physics
      if (unit.recoil?.active && unit.barrelBone) {
        const r = unit.recoil

        // Barrel spring: F = -kx - cv (spring + damping)
        const barrelForce = -BARREL_STIFFNESS * r.barrelOffset - BARREL_DAMPING * r.barrelVelocity
        r.barrelVelocity += barrelForce * dt
        r.barrelOffset += r.barrelVelocity * dt
        r.barrelOffset = Math.max(-BARREL_MAX, Math.min(0.1, r.barrelOffset))

        // Apply barrel offset along its local Z axis (slide back = +Z in bone space)
        unit.barrelBone.position.z = r.barrelOffset

        // Hull spring: pitch up/down
        const hullForce = -HULL_STIFFNESS * r.hullPitch - HULL_DAMPING * r.hullPitchVel
        r.hullPitchVel += hullForce * dt
        r.hullPitch += r.hullPitchVel * dt
        r.hullPitch = Math.max(-HULL_MAX_PITCH, Math.min(HULL_MAX_PITCH, r.hullPitch))

        // Apply hull pitch to the root mesh
        unit.mesh.rotation.x = r.hullPitch

        // Deactivate when settled
        if (Math.abs(r.barrelOffset) < 0.001 && Math.abs(r.barrelVelocity) < 0.01 &&
            Math.abs(r.hullPitch) < 0.0005 && Math.abs(r.hullPitchVel) < 0.005) {
          r.barrelOffset = 0
          r.hullPitch = 0
          r.active = false
          unit.barrelBone.position.z = 0
          unit.mesh.rotation.x = 0
        }
      }
    }
  }

  get activeCount(): number {
    return this.units.size
  }

  has(eid: number): boolean {
    return this.units.has(eid)
  }

  getUnitMesh(eid: number): THREE.Object3D | null {
    return this.units.get(eid)?.mesh ?? null
  }

  setVisible(eid: number, visible: boolean) {
    const entry = this.units.get(eid)
    if (entry) entry.mesh.visible = visible
  }
}

// ── Registry of animated managers by pool ID ─────────────────
const animManagers = new Map<number, AnimatedMeshManager>()

export function registerAnimManager(poolId: number, mgr: AnimatedMeshManager) {
  animManagers.set(poolId, mgr)
}

export function getAnimManager(poolId: number): AnimatedMeshManager | undefined {
  return animManagers.get(poolId)
}

export function getAllAnimManagers(): Map<number, AnimatedMeshManager> {
  return animManagers
}

/** Update all animation mixers each frame */
export function updateAllAnimations(dt: number) {
  for (const [, mgr] of animManagers) {
    mgr.updateMixers(dt)
  }
}
