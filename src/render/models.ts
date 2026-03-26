import * as THREE from 'three'

// Helper: clone geometry, apply transform, ensure non-indexed
function part(
  geo: THREE.BufferGeometry,
  tx = 0, ty = 0, tz = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
): THREE.BufferGeometry {
  let g = geo.clone()
  if (g.index) g = g.toNonIndexed()
  const m = new THREE.Matrix4()
  m.compose(
    new THREE.Vector3(tx, ty, tz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  )
  g.applyMatrix4(m)
  return g
}

/** Custom merge: concatenate position + normal arrays, skip UV. */
function merge(...parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0
  for (const g of parts) totalVerts += g.attributes.position.count

  const pos = new Float32Array(totalVerts * 3)
  const norm = new Float32Array(totalVerts * 3)

  let offset = 0
  for (const g of parts) {
    const gPos = g.attributes.position.array as Float32Array
    const gNorm = g.attributes.normal.array as Float32Array
    pos.set(gPos, offset * 3)
    norm.set(gNorm, offset * 3)
    offset += g.attributes.position.count
    g.dispose()
  }

  const result = new THREE.BufferGeometry()
  result.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  result.setAttribute('normal', new THREE.BufferAttribute(norm, 3))
  return result
}

// ── Shared primitives ────────────────────────────────────────
const _box = new THREE.BoxGeometry(1, 1, 1)
const _sphere = new THREE.SphereGeometry(1, 8, 6)
const _cylinder = new THREE.CylinderGeometry(1, 1, 1, 8)
const _cone = new THREE.ConeGeometry(1, 1, 6)
const _octahedron = new THREE.OctahedronGeometry(1, 0)

// ═══════════════════════════════════════════════════════════════
//  UNITS
// ═══════════════════════════════════════════════════════════════

export function createWorkerGeometry(): THREE.BufferGeometry {
  return merge(
    // Torso
    part(_box, 0, 0.45, 0, 0, 0, 0, 0.32, 0.4, 0.2),
    // Head
    part(_sphere, 0, 0.78, 0, 0, 0, 0, 0.12, 0.13, 0.12),
    // Hard hat
    part(_cylinder, 0, 0.88, 0, 0, 0, 0, 0.15, 0.04, 0.15),
    part(_cone, 0, 0.94, 0, 0, 0, 0, 0.12, 0.08, 0.12),
    // Left arm
    part(_box, -0.22, 0.42, 0, 0, 0, 0.2, 0.08, 0.35, 0.08),
    // Right arm
    part(_box, 0.22, 0.42, 0, 0, 0, -0.2, 0.08, 0.35, 0.08),
    // Left leg
    part(_box, -0.09, 0.12, 0, 0, 0, 0, 0.1, 0.24, 0.1),
    // Right leg
    part(_box, 0.09, 0.12, 0, 0, 0, 0, 0.1, 0.24, 0.1),
    // Pickaxe handle (right hand)
    part(_cylinder, 0.3, 0.55, 0.08, 0.4, 0, 0, 0.015, 0.3, 0.015),
    // Pickaxe head
    part(_box, 0.32, 0.72, 0.12, 0.4, 0, 0, 0.14, 0.03, 0.03),
    // Boots
    part(_box, -0.09, 0.02, 0.03, 0, 0, 0, 0.11, 0.06, 0.14),
    part(_box, 0.09, 0.02, 0.03, 0, 0, 0, 0.11, 0.06, 0.14),
  )
}

export function createMarineGeometry(): THREE.BufferGeometry {
  return merge(
    // Armored torso
    part(_box, 0, 0.48, 0, 0, 0, 0, 0.38, 0.44, 0.24),
    // Chest plate detail
    part(_box, 0, 0.52, 0.13, 0, 0, 0, 0.3, 0.3, 0.04),
    // Head
    part(_sphere, 0, 0.82, 0, 0, 0, 0, 0.13, 0.14, 0.13),
    // Helmet
    part(_box, 0, 0.9, 0, 0, 0, 0, 0.3, 0.12, 0.28),
    // Visor
    part(_box, 0, 0.82, 0.14, 0, 0, 0, 0.22, 0.06, 0.02),
    // Left shoulder pad
    part(_box, -0.28, 0.62, 0, 0, 0, 0, 0.16, 0.08, 0.2),
    // Right shoulder pad
    part(_box, 0.28, 0.62, 0, 0, 0, 0, 0.16, 0.08, 0.2),
    // Left arm
    part(_box, -0.28, 0.38, 0, 0, 0, 0.15, 0.1, 0.32, 0.1),
    // Right arm (holding gun)
    part(_box, 0.25, 0.38, 0.08, 0.2, 0, -0.1, 0.1, 0.32, 0.1),
    // Gun body
    part(_box, 0.2, 0.45, 0.28, 0, 0, 0, 0.06, 0.08, 0.35),
    // Gun barrel
    part(_cylinder, 0.2, 0.45, 0.52, Math.PI / 2, 0, 0, 0.025, 0.14, 0.025),
    // Gun stock
    part(_box, 0.2, 0.4, 0.08, -0.3, 0, 0, 0.05, 0.04, 0.15),
    // Left leg
    part(_box, -0.1, 0.12, 0, 0, 0, 0, 0.12, 0.28, 0.12),
    // Right leg
    part(_box, 0.1, 0.12, 0, 0, 0, 0, 0.12, 0.28, 0.12),
    // Boots
    part(_box, -0.1, 0.02, 0.03, 0, 0, 0, 0.13, 0.06, 0.16),
    part(_box, 0.1, 0.02, 0.03, 0, 0, 0, 0.13, 0.06, 0.16),
    // Backpack
    part(_box, 0, 0.48, -0.16, 0, 0, 0, 0.24, 0.3, 0.1),
  )
}

export function createTankGeometry(): THREE.BufferGeometry {
  return merge(
    // Hull body
    part(_box, 0, 0.2, 0, 0, 0, 0, 1.1, 0.28, 1.5),
    // Hull front slope
    part(_box, 0, 0.28, 0.7, -0.3, 0, 0, 1.0, 0.2, 0.3),
    // Hull rear
    part(_box, 0, 0.28, -0.7, 0, 0, 0, 0.9, 0.2, 0.2),
    // Left track
    part(_box, -0.6, 0.12, 0, 0, 0, 0, 0.18, 0.24, 1.5),
    part(_box, -0.6, 0.0, 0, 0, 0, 0, 0.2, 0.06, 1.6), // track bottom
    // Right track
    part(_box, 0.6, 0.12, 0, 0, 0, 0, 0.18, 0.24, 1.5),
    part(_box, 0.6, 0.0, 0, 0, 0, 0, 0.2, 0.06, 1.6),
    // Track wheels (left)
    part(_cylinder, -0.6, 0.12, 0.5, 0, 0, Math.PI / 2, 0.09, 0.2, 0.09),
    part(_cylinder, -0.6, 0.12, 0, 0, 0, Math.PI / 2, 0.09, 0.2, 0.09),
    part(_cylinder, -0.6, 0.12, -0.5, 0, 0, Math.PI / 2, 0.09, 0.2, 0.09),
    // Track wheels (right)
    part(_cylinder, 0.6, 0.12, 0.5, 0, 0, Math.PI / 2, 0.09, 0.2, 0.09),
    part(_cylinder, 0.6, 0.12, 0, 0, 0, Math.PI / 2, 0.09, 0.2, 0.09),
    part(_cylinder, 0.6, 0.12, -0.5, 0, 0, Math.PI / 2, 0.09, 0.2, 0.09),
    // Turret base
    part(_cylinder, 0, 0.42, -0.05, 0, 0, 0, 0.35, 0.08, 0.35),
    // Turret body
    part(_box, 0, 0.54, -0.1, 0, 0, 0, 0.5, 0.2, 0.6),
    // Turret front
    part(_box, 0, 0.54, 0.22, -0.1, 0, 0, 0.44, 0.16, 0.12),
    // Barrel
    part(_cylinder, 0, 0.54, 0.7, Math.PI / 2, 0, 0, 0.04, 0.55, 0.04),
    // Barrel tip (muzzle brake)
    part(_cylinder, 0, 0.54, 1.0, Math.PI / 2, 0, 0, 0.055, 0.06, 0.055),
    // Commander hatch
    part(_cylinder, -0.12, 0.66, -0.15, 0, 0, 0, 0.08, 0.04, 0.08),
    // Exhaust pipes
    part(_cylinder, -0.2, 0.42, -0.65, -0.2, 0, 0, 0.03, 0.12, 0.03),
    part(_cylinder, 0.2, 0.42, -0.65, -0.2, 0, 0, 0.03, 0.12, 0.03),
  )
}

// ═══════════════════════════════════════════════════════════════
//  BUILDINGS
// ═══════════════════════════════════════════════════════════════

export function createCommandCenterGeometry(): THREE.BufferGeometry {
  return merge(
    // Main structure
    part(_box, 0, 1.0, 0, 0, 0, 0, 3.2, 2.0, 3.2),
    // Roof overhang
    part(_box, 0, 2.05, 0, 0, 0, 0, 3.6, 0.12, 3.6),
    // Roof top
    part(_box, 0, 2.3, 0, 0, 0, 0, 2.4, 0.4, 2.4),
    // Communications antenna
    part(_cylinder, 0.6, 3.0, 0.6, 0, 0, 0, 0.04, 1.0, 0.04),
    part(_sphere, 0.6, 3.55, 0.6, 0, 0, 0, 0.08, 0.08, 0.08),
    // Dish
    part(_cone, 0.6, 3.3, 0.6, -0.3, 0, 0, 0.15, 0.06, 0.15),
    // Front entrance
    part(_box, 0, 0.6, 1.62, 0, 0, 0, 0.8, 1.2, 0.08),
    // Door recess
    part(_box, 0, 0.5, 1.55, 0, 0, 0, 0.6, 1.0, 0.1),
    // Windows (left)
    part(_box, -1.2, 1.3, 1.62, 0, 0, 0, 0.4, 0.3, 0.06),
    // Windows (right)
    part(_box, 1.2, 1.3, 1.62, 0, 0, 0, 0.4, 0.3, 0.06),
    // Landing pad markings (flat on top)
    part(_box, 0, 2.12, 0, 0, 0, 0, 1.8, 0.02, 1.8),
    // Support pillars
    part(_box, -1.4, 0.5, -1.4, 0, 0, 0, 0.2, 1.0, 0.2),
    part(_box, 1.4, 0.5, -1.4, 0, 0, 0, 0.2, 1.0, 0.2),
    part(_box, -1.4, 0.5, 1.4, 0, 0, 0, 0.2, 1.0, 0.2),
    part(_box, 1.4, 0.5, 1.4, 0, 0, 0, 0.2, 1.0, 0.2),
  )
}

export function createSupplyDepotGeometry(): THREE.BufferGeometry {
  return merge(
    // Main container
    part(_box, 0, 0.5, 0, 0, 0, 0, 1.8, 1.0, 1.8),
    // Reinforcement ribs
    part(_box, 0, 0.5, 0.92, 0, 0, 0, 1.7, 0.9, 0.04),
    part(_box, 0, 0.5, -0.92, 0, 0, 0, 1.7, 0.9, 0.04),
    part(_box, 0.92, 0.5, 0, 0, 0, 0, 0.04, 0.9, 1.7),
    part(_box, -0.92, 0.5, 0, 0, 0, 0, 0.04, 0.9, 1.7),
    // Top vents
    part(_box, -0.4, 1.02, 0, 0, 0, 0, 0.3, 0.06, 0.8),
    part(_box, 0.4, 1.02, 0, 0, 0, 0, 0.3, 0.06, 0.8),
    // Lid edges
    part(_box, 0, 1.02, 0, 0, 0, 0, 1.9, 0.05, 1.9),
    // Base
    part(_box, 0, 0.03, 0, 0, 0, 0, 2.0, 0.06, 2.0),
  )
}

export function createBarracksGeometry(): THREE.BufferGeometry {
  return merge(
    // Main structure
    part(_box, 0, 0.85, 0, 0, 0, 0, 2.3, 1.7, 2.3),
    // Roof (angled)
    part(_box, 0, 1.85, 0, 0, 0, 0, 2.5, 0.15, 2.5),
    part(_box, 0, 2.0, 0, 0, 0, 0, 1.6, 0.2, 2.4),
    part(_box, 0, 2.15, 0, 0, 0, 0, 0.8, 0.12, 2.3),
    // Front entrance (wider)
    part(_box, 0, 0.55, 1.18, 0, 0, 0, 1.0, 1.1, 0.08),
    // Door recess
    part(_box, 0, 0.5, 1.1, 0, 0, 0, 0.7, 0.9, 0.15),
    // Weapon rack (side detail)
    part(_box, 1.17, 0.8, 0, 0, 0, 0, 0.06, 0.6, 0.8),
    // Barricades at entrance
    part(_box, -0.5, 0.2, 1.4, 0, 0, 0, 0.15, 0.4, 0.3),
    part(_box, 0.5, 0.2, 1.4, 0, 0, 0, 0.15, 0.4, 0.3),
    // Flag pole
    part(_cylinder, -1.0, 1.8, -1.0, 0, 0, 0, 0.02, 1.0, 0.02),
    part(_box, -1.0, 2.2, -0.88, 0, 0, 0, 0.02, 0.2, 0.22),
  )
}

export function createFactoryGeometry(): THREE.BufferGeometry {
  return merge(
    // Main building
    part(_box, 0, 1.0, 0, 0, 0, 0, 2.8, 2.0, 2.8),
    // Roof
    part(_box, 0, 2.05, 0, 0, 0, 0, 3.0, 0.12, 3.0),
    // Smokestack
    part(_cylinder, 1.0, 2.4, -1.0, 0, 0, 0, 0.15, 0.8, 0.15),
    part(_cylinder, 1.0, 2.85, -1.0, 0, 0, 0, 0.2, 0.12, 0.2),
    // Second smokestack
    part(_cylinder, 1.0, 2.2, -0.5, 0, 0, 0, 0.12, 0.5, 0.12),
    part(_cylinder, 1.0, 2.5, -0.5, 0, 0, 0, 0.16, 0.1, 0.16),
    // Garage door (large opening)
    part(_box, 0, 0.7, 1.42, 0, 0, 0, 1.6, 1.4, 0.08),
    // Garage door panels
    part(_box, 0, 0.7, 1.35, 0, 0, 0, 1.4, 1.2, 0.06),
    // Crane arm (on top)
    part(_box, -0.8, 2.2, 0.4, 0, 0, 0, 0.08, 0.08, 2.0),
    part(_box, -0.8, 2.15, 1.3, 0, 0, 0, 0.04, 0.3, 0.04), // crane cable
    // Ventilation units
    part(_box, -1.0, 2.15, -1.0, 0, 0, 0, 0.4, 0.18, 0.4),
    // Side pipes
    part(_cylinder, -1.42, 0.6, 0, Math.PI / 2, 0, 0, 0.06, 1.4, 0.06),
    part(_cylinder, -1.42, 0.8, 0, Math.PI / 2, 0, 0, 0.06, 1.4, 0.06),
    // Base platform
    part(_box, 0, 0.03, 0, 0, 0, 0, 3.2, 0.06, 3.2),
  )
}

// ═══════════════════════════════════════════════════════════════
//  RESOURCES
// ═══════════════════════════════════════════════════════════════

export function createMineralGeometry(): THREE.BufferGeometry {
  // Cluster of crystals at different angles
  return merge(
    // Central large crystal
    part(_octahedron, 0, 0.6, 0, 0, 0, 0.1, 0.25, 0.65, 0.2),
    // Left crystal (tilted)
    part(_octahedron, -0.35, 0.45, 0.1, 0, 0, 0.35, 0.18, 0.5, 0.15),
    // Right crystal (tilted other way)
    part(_octahedron, 0.3, 0.4, -0.05, 0, 0, -0.25, 0.2, 0.45, 0.16),
    // Small front crystal
    part(_octahedron, 0.05, 0.3, 0.3, 0.2, 0, 0, 0.12, 0.35, 0.1),
    // Small back crystal
    part(_octahedron, -0.15, 0.35, -0.25, -0.15, 0.3, 0, 0.14, 0.38, 0.12),
    // Base rock
    part(_box, 0, 0.06, 0, 0, 0.1, 0, 0.7, 0.12, 0.6),
  )
}

export function createGasGeyserGeometry(): THREE.BufferGeometry {
  return merge(
    // Base rock formation
    part(_cylinder, 0, 0.12, 0, 0, 0, 0, 0.8, 0.24, 0.8),
    // Vent pipe
    part(_cylinder, 0, 0.5, 0, 0, 0, 0, 0.35, 0.6, 0.35),
    // Vent rim
    part(_cylinder, 0, 0.82, 0, 0, 0, 0, 0.45, 0.06, 0.45),
    // Inner vent (darker)
    part(_cylinder, 0, 0.84, 0, 0, 0, 0, 0.28, 0.04, 0.28),
    // Steam wisps (thin cones going up)
    part(_cone, 0.1, 1.1, 0.05, 0, 0, 0.1, 0.06, 0.5, 0.06),
    part(_cone, -0.08, 1.2, -0.05, 0, 0, -0.08, 0.04, 0.6, 0.04),
    part(_cone, 0, 1.0, -0.1, 0, 0, 0, 0.05, 0.4, 0.05),
    // Rock detail around base
    part(_box, 0.5, 0.08, 0.4, 0, 0.3, 0, 0.3, 0.16, 0.2),
    part(_box, -0.4, 0.08, 0.5, 0, -0.2, 0, 0.25, 0.16, 0.25),
    part(_box, -0.3, 0.08, -0.5, 0, 0.5, 0, 0.28, 0.16, 0.22),
  )
}

// ═══════════════════════════════════════════════════════════════
//  PROJECTILE
// ═══════════════════════════════════════════════════════════════

export function createProjectileGeometry(): THREE.BufferGeometry {
  return merge(
    part(_sphere, 0, 0, 0, 0, 0, 0, 0.08, 0.08, 0.08),
    // Trail
    part(_cone, 0, 0, -0.12, Math.PI / 2, 0, 0, 0.04, 0.16, 0.04),
  )
}

// ═══════════════════════════════════════════════════════════════
//  OBSTACLES (rocks, trees, boulders, cliff rocks)
// ═══════════════════════════════════════════════════════════════

export function createRockGeometry(): THREE.BufferGeometry {
  return merge(
    // Main body — irregular rock shape
    part(_box, 0, 0.4, 0, 0.15, 0.3, 0.1, 1.0, 0.8, 0.9),
    part(_box, 0.2, 0.55, 0.1, -0.1, 0.5, 0.2, 0.6, 0.5, 0.7),
    part(_box, -0.15, 0.3, -0.1, 0.2, -0.2, 0, 0.7, 0.5, 0.6),
    // Top
    part(_octahedron, 0.05, 0.75, 0, 0.2, 0.4, 0, 0.35, 0.25, 0.3),
    // Base
    part(_box, 0, 0.08, 0, 0, 0.1, 0, 1.2, 0.16, 1.1),
  )
}

export function createTreeGeometry(): THREE.BufferGeometry {
  return merge(
    // Trunk
    part(_cylinder, 0, 0.8, 0, 0, 0, 0, 0.12, 1.6, 0.12),
    // Trunk detail
    part(_cylinder, 0.05, 0.5, 0.05, 0.1, 0.3, 0, 0.08, 0.6, 0.08),
    // Canopy layers (cone + sphere shapes)
    part(_cone, 0, 2.2, 0, 0, 0, 0, 0.9, 1.2, 0.9),
    part(_cone, 0, 2.8, 0, 0, 0.3, 0, 0.7, 1.0, 0.7),
    part(_cone, 0, 3.2, 0, 0, 0.6, 0, 0.45, 0.8, 0.45),
    // Some branch details
    part(_box, 0.5, 1.6, 0, 0, 0, 0.4, 0.6, 0.06, 0.06),
    part(_box, -0.3, 1.4, 0.2, 0, 0, -0.3, 0.5, 0.05, 0.05),
    // Roots at base
    part(_box, 0.15, 0.05, 0.12, 0, 0.3, 0, 0.3, 0.1, 0.08),
    part(_box, -0.1, 0.05, -0.15, 0, -0.5, 0, 0.25, 0.1, 0.08),
  )
}

export function createBoulderGeometry(): THREE.BufferGeometry {
  return merge(
    // Large rounded boulder
    part(_sphere, 0, 0.7, 0, 0, 0, 0, 0.9, 0.7, 0.85),
    // Angular details
    part(_box, 0.3, 0.5, 0.2, 0.3, 0.5, 0.2, 0.5, 0.4, 0.5),
    part(_box, -0.2, 0.4, -0.3, -0.2, -0.3, 0, 0.6, 0.35, 0.45),
    // Smaller rock on top
    part(_octahedron, 0.15, 1.1, -0.1, 0.4, 0.2, 0, 0.3, 0.2, 0.25),
    // Base
    part(_box, 0, 0.06, 0, 0, 0, 0, 1.3, 0.12, 1.2),
  )
}

export function createCliffRockGeometry(): THREE.BufferGeometry {
  return merge(
    // Tall jagged cliff rock formation
    part(_box, 0, 1.2, 0, 0.05, 0.15, 0.08, 1.4, 2.4, 1.0),
    part(_box, 0.3, 1.6, 0.2, -0.1, 0.3, 0.15, 0.8, 2.0, 0.7),
    part(_box, -0.2, 1.0, -0.15, 0.15, -0.2, -0.1, 0.9, 1.8, 0.8),
    // Peak
    part(_octahedron, 0.1, 2.6, 0, 0.2, 0.5, 0, 0.5, 0.6, 0.4),
    part(_octahedron, -0.15, 2.3, 0.15, -0.3, 0.1, 0, 0.35, 0.5, 0.3),
    // Wide base
    part(_box, 0, 0.15, 0, 0, 0.1, 0, 2.0, 0.3, 1.6),
    // Debris around base
    part(_box, 0.9, 0.1, 0.5, 0.3, 0.5, 0.2, 0.3, 0.2, 0.25),
    part(_box, -0.7, 0.1, -0.4, -0.2, -0.3, 0, 0.35, 0.2, 0.3),
  )
}

// ═══════════════════════════════════════════════════════════════
//  SELECTION RING
// ═══════════════════════════════════════════════════════════════

export function createSelectionRingGeometry(radius: number): THREE.BufferGeometry {
  const innerRadius = radius * 0.75
  const outerRadius = radius * 1.0
  const ring = new THREE.RingGeometry(innerRadius, outerRadius, 32)
  ring.rotateX(-Math.PI / 2)
  // Convert to non-indexed to match other geometries
  if (ring.index) return ring.toNonIndexed()
  return ring
}
