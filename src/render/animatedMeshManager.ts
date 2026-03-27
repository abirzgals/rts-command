import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import { scene } from './engine'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

const loader = new GLTFLoader()

export type AnimName = 'Idle' | 'Run' | 'Shoot_OneHanded' | 'Shoot' | 'Punch' | 'Death' | 'PickUp' | 'Run_Carry' | 'Walk'

interface AnimatedUnit {
  mesh: THREE.Object3D
  mixer: THREE.AnimationMixer
  actions: Map<string, THREE.AnimationAction>
  currentAnim: string
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

    // Apply faction color tint
    if (color) {
      clone.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (let i = 0; i < mats.length; i++) {
            const orig = mats[i] as THREE.MeshStandardMaterial
            const mat = orig.clone()
            // Tint by multiplying with faction color
            mat.color.lerp(color, 0.35)
            mat.emissive.copy(color).multiplyScalar(0.08)
            mats[i] = mat
          }
          mesh.material = mats.length === 1 ? mats[0] : mats
          mesh.castShadow = true
          mesh.receiveShadow = true
        }
      })
    }

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

    this.units.set(eid, { mesh: clone, mixer, actions, currentAnim: 'Idle' })
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

  updateTransform(eid: number, x: number, y: number, z: number, rotY: number) {
    const unit = this.units.get(eid)
    if (!unit) return
    unit.mesh.position.set(x, y, z)
    unit.mesh.rotation.y = rotY + this.rotationOffset
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
    if (name === 'Death' || name === 'Punch' || name === 'Shoot_OneHanded' || name === 'Shoot' || name === 'PickUp') {
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

  /** Update all animation mixers — call once per frame */
  updateMixers(dt: number) {
    for (const [, unit] of this.units) {
      unit.mixer.update(dt)
    }
  }

  get activeCount(): number {
    return this.units.size
  }

  has(eid: number): boolean {
    return this.units.has(eid)
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
