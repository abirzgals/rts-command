# Supreme Commander-Style Hierarchical Pathfinding

Technical specification for the pathfinding and movement systems implemented in
**rts-command**. The architecture draws from Supreme Commander's approach:
sector-based hierarchical A\*, distance-transform clearance maps, and a
physics-lite movement pipeline with turn rates, acceleration, and stuck
escalation.

---

## Table of Contents

1. [Grid & Sector Layout](#1-grid--sector-layout)
2. [Distance Transform Clearance Maps](#2-distance-transform-clearance-maps)
3. [Sector Graph & Portal Detection](#3-sector-graph--portal-detection)
4. [Hierarchical A\*](#4-hierarchical-a)
5. [Fine-Grained A\* (Corridor-Constrained)](#5-fine-grained-a-corridor-constrained)
6. [Line-of-Sight Smoothing & Corner Cutting Prevention](#6-line-of-sight-smoothing--corner-cutting-prevention)
7. [SupCom Movement Pipeline](#7-supcom-movement-pipeline)
8. [Axis-Separated Wall Sliding](#8-axis-separated-wall-sliding)
9. [Stuck Escalation](#9-stuck-escalation)
10. [ECS Components](#10-ecs-components)
11. [Unit Parameters](#11-unit-parameters)
12. [File Map](#12-file-map)

---

## 1. Grid & Sector Layout

| Property | Value |
|----------|-------|
| World grid | 200 x 200 cells |
| Sector size | 16 x 16 cells |
| Sector grid | 13 x 13 = 169 sectors |
| Cell data | walkability, height, dynamic cost (buildings) |

The nav grid is the single source of truth for terrain passability. Each cell
stores a height value (sampled from the terrain heightmap) and a dynamic cost
that is bumped to >= 50 when a building footprint occupies the cell.

---

## 2. Distance Transform Clearance Maps

Replaces the old O(n * r^2) per-node circular clearance check with an O(n)
two-pass **Chebyshev distance transform**.

### Algorithm (pseudocode)

```
// Forward pass (top-left to bottom-right)
for z in 0..H:
  for x in 0..W:
    if not walkable(x, z):
      clearance[x][z] = 0
    else:
      top       = clearance[x][z-1]   // 0 if out of bounds
      left      = clearance[x-1][z]
      topLeft   = clearance[x-1][z-1]
      clearance[x][z] = min(top, left, topLeft) + 1

// Backward pass (bottom-right to top-left)
for z in (H-1)..0:
  for x in (W-1)..0:
    bottom      = clearance[x][z+1]
    right       = clearance[x+1][z]
    bottomRight = clearance[x+1][z+1]
    clearance[x][z] = min(clearance[x][z], min(bottom, right, bottomRight) + 1)
```

### Slope Data

Per-cell `slopeData[x][z]` stores the maximum height delta between the cell and
its four cardinal neighbors. Computed once alongside the clearance map.

### Lookup

```ts
isClearForUnit(gx: number, gz: number, radiusCells: number, maxSlope: number): boolean
```

Returns `true` when:
- `clearance[gx][gz] >= radiusCells`
- `slopeData[gx][gz] <= maxSlope`

### Rebuild Trigger

`pathfindingSystem` tracks the building count each tick. When it changes the
clearance map and slope data are fully recomputed. This is fast enough at 200x200
(~80k cells, two passes) to run synchronously.

---

## 3. Sector Graph & Portal Detection

**File:** `src/pathfinding/sectorGraph.ts`

### Portal Detection

For every pair of horizontally or vertically adjacent sectors, scan the shared
border (16 cells). Find contiguous runs of cell pairs where both sides are
passable. Place a **portal** at the midpoint of each run.

```
for each pair of adjacent sectors (A, B):
  scan shared border cells left-to-right (or top-to-bottom)
  track current run of passable pairs
  when run ends (or border ends):
    if runLength > 0:
      create portal at midpoint of run
      link portal to both sectors
```

Each portal stores:
- Grid coordinates of the midpoint cell on each side
- References to both owning sectors
- Edge cost (Euclidean distance between the two midpoint cells, always ~1.0)

### Sector Adjacency

Sectors are connected through their shared portals. The sector graph is an
undirected weighted graph where:
- **Nodes** = portals
- **Edges** = connections between portals within the same sector (cost =
  Euclidean distance between portal midpoints) and cross-sector portal links
  (cost ~1.0).

The graph is rebuilt whenever the nav grid clearance map is rebuilt (i.e., when
buildings change).

---

## 4. Hierarchical A\*

The top-level entry point is `findPathHierarchical(start, goal, radiusCells,
maxSlope)`.

### Step 1 -- Sector-Level Corridor

Run A\* over the sector graph to find the sequence of sectors from the start
sector to the goal sector. The result is a **corridor** -- an ordered list of
sector indices.

```
sectorPath = sectorAStar(startSector, goalSector)
// e.g. [42, 43, 44, 57, 58]
```

If no sector-level path exists, return null (unreachable).

### Step 2 -- Fine A\* with Corridor Constraint

Expand the corridor by 1 sector in each direction (padding) to allow minor
detours, then run cell-level A\* constrained to only expand nodes within the
padded corridor.

### Step 3 -- Fallback

If the corridor-constrained fine A\* fails (can happen with narrow diagonal
passages), fall back to **unconstrained** full-grid A\*. This is slower but
guarantees a path if one exists.

```
path = corridorAStar(start, goal, corridor, radiusCells, maxSlope)
if path is null:
  path = unconstrainedAStar(start, goal, radiusCells, maxSlope)
```

---

## 5. Fine-Grained A\* (Corridor-Constrained)

Standard A\* on the 200x200 cell grid with these modifications:

### Expansion Rules

- 8-directional movement (4 cardinal + 4 diagonal)
- Diagonal cost: sqrt(2); cardinal cost: 1.0
- **Corner cutting prevention:** a diagonal expansion from (x, z) to (x+dx,
  z+dz) is only allowed if both (x+dx, z) and (x, z+dz) are passable.
- Each expanded cell must satisfy `isClearForUnit(x, z, radiusCells, maxSlope)`.
- Each expanded cell must be within the padded corridor (sector membership
  check).

### Heuristic

Octile distance (consistent, admissible for 8-dir grids):

```
h(n, goal) = max(|dx|, |dz|) + (sqrt(2) - 1) * min(|dx|, |dz|)
```

### Post-Processing

The raw A\* path is smoothed via **line-of-sight checks** (see next section) to
remove unnecessary intermediate waypoints.

---

## 6. Line-of-Sight Smoothing & Corner Cutting Prevention

After A\* produces a cell path, a greedy LOS pass removes redundant waypoints:

```
smoothed = [path[0]]
current = 0
for i in 2..path.length:
  if not lineOfSight(path[current], path[i]):
    smoothed.push(path[i - 1])
    current = i - 1
smoothed.push(path[last])
```

### DDA Line-of-Sight Check

Uses DDA (Digital Differential Analyzer) rasterization. On **diagonal steps**
(where both x and z change simultaneously), both axis-aligned neighbor cells are
checked to prevent corner cutting:

```
function lineOfSight(a, b):
  dx, dz = b.x - a.x, b.z - a.z
  steps = max(|dx|, |dz|)
  xInc, zInc = dx / steps, dz / steps
  x, z = a.x, a.z
  for i in 0..steps:
    gx, gz = round(x), round(z)
    if not passable(gx, gz): return false
    // diagonal step: check both cardinal neighbors
    if gx != prevGx and gz != prevGz:
      if not passable(prevGx, gz): return false
      if not passable(gx, prevGz): return false
    prevGx, prevGz = gx, gz
    x += xInc; z += zInc
  return true
```

---

## 7. SupCom Movement Pipeline

**File:** `src/ecs/systems/movementSystem.ts`

Executed once per tick per unit that has an active path. The pipeline runs in
this order:

### 7.1 Waypoint Advancement

```
if distance(position, currentWaypoint) < 0.8:
  advance to next waypoint
  if no more waypoints: stop unit, clear path, return
```

### 7.2 Desired Direction

```
desiredDir = normalize(currentWaypoint - position)
```

### 7.3 Turn Rate (Smooth Rotation)

Units do not snap to their desired heading. Rotation is rate-limited:

```
targetYaw = atan2(desiredDir.x, desiredDir.z)
delta = wrapAngle(targetYaw - currentYaw)       // wrap to [-PI, PI]
maxTurn = turnRate * dt
newYaw = currentYaw + clamp(delta, -maxTurn, maxTurn)
```

**Speed reduction while turning:** units slow down proportionally to how far off
their heading is from the desired direction:

```
facing = vec3(sin(newYaw), 0, cos(newYaw))
speedFactor = max(0, dot(facing, desiredDir))
```

A unit facing 90 degrees away from its waypoint has `speedFactor = 0` and will
rotate in place until it faces roughly forward.

### 7.4 Acceleration / Deceleration

```
targetSpeed = moveSpeed * speedFactor
if curSpeed < targetSpeed:
  curSpeed = min(curSpeed + accel * dt, targetSpeed)
else:
  curSpeed = max(curSpeed - decel * dt, targetSpeed)   // decel = 2 * accel
```

### 7.5 Position Update

```
velocity = facing * curSpeed
newX = position.x + velocity.x * dt
newZ = position.z + velocity.z * dt
```

The new position is then run through **axis-separated wall sliding** (see next
section). After resolution:

```
position.y = terrainHeightAt(position.x, position.z)
```

### 7.6 Stuck Detection

After the position update, check if the unit has barely moved. If so, increment
the stuck timer and potentially escalate (see Section 9).

---

## 8. Axis-Separated Wall Sliding

Prevents units from stopping dead when brushing against obstacles. Applied after
computing `(newX, newZ)` from velocity.

### Algorithm

```
function resolveCollision(oldX, oldZ, newX, newZ, radius, maxSlope):

  // 1. Try full movement
  if passable(newX, newZ, radius, maxSlope):
    return (newX, newZ)

  // 2. Try each axis independently
  xOk = passable(newX, oldZ, radius, maxSlope)
  zOk = passable(oldX, newZ, radius, maxSlope)

  if xOk and zOk:
    // Diagonal corner case: both axes work alone but not together
    // Pick the axis with the larger velocity component
    if |newX - oldX| >= |newZ - oldZ|:
      return (newX, oldZ)
    else:
      return (oldX, newZ)

  if xOk: return (newX, oldZ)
  if zOk: return (oldX, newZ)

  // 3. Both blocked: don't move, trigger stuck detection
  return (oldX, oldZ)
```

### Footprint Check

`passable(x, z, radius, maxSlope)` tests 5 sample points:
- Center: `(x, z)`
- North edge: `(x, z - radius)`
- South edge: `(x, z + radius)`
- West edge: `(x - radius, z)`
- East edge: `(x + radius, z)`

Each point must satisfy:
1. Within grid bounds
2. Walkable terrain (not water)
3. `dynamicCost < 50` (no building)
4. `slopeData <= maxSlope`

---

## 9. Stuck Escalation

A state machine that progressively tries harder to get the unit unstuck.

| Phase | Name | Duration | Action |
|-------|------|----------|--------|
| 0 | Normal | 1.5 s | No action; just waiting for natural unstuck |
| 1 | Wiggle | 0.5 s | Apply random perpendicular impulse to velocity |
| 2 | Repath | 2.0 s cooldown | Request a brand new path from `findPathHierarchical` |
| 3 | Give up | -- | Clear path, stop unit |

```
function updateStuck(unit, dt):
  if unit moved significantly this tick:
    unit.stuckState = { phase: 0, timer: 0 }
    return

  unit.stuckState.timer += dt

  switch unit.stuckState.phase:
    case 0:
      if timer > 1.5:
        phase = 1; timer = 0
    case 1:
      // apply perpendicular wiggle impulse
      if timer > 0.5:
        phase = 2; timer = 0
    case 2:
      // request full repath
      if timer > 2.0:
        phase = 3; timer = 0
    case 3:
      clearPath(unit)
      unit.curSpeed = 0
```

---

## 10. ECS Components

New components added to support the movement model:

| Component | Type | Description |
|-----------|------|-------------|
| `TurnRate` | `{ value: f32 }` | Maximum rotation speed in radians/sec |
| `Acceleration` | `{ value: f32 }` | Linear acceleration in units/sec^2 |
| `MaxSlope` | `{ value: f32 }` | Maximum passable height delta per cell |
| `CurrentSpeed` | `{ value: f32 }` | Actual speed this tick (vs `MoveSpeed` = max) |
| `StuckState` | `{ phase: u8, timer: f32 }` | Stuck escalation state machine |

These are attached at spawn time (see `src/ecs/archetypes.ts`) and configured
per unit type in `src/game/config.ts`.

---

## 11. Unit Parameters

| Unit | Speed | TurnRate (rad/s) | Accel (u/s^2) | MaxSlope | Radius (cells) |
|--------|-------|------------------|---------------|----------|-----------------|
| Worker | 3.5 | 6.0 | 8.0 | 2.0 | 0.4 |
| Marine | 3.0 | 5.0 | 7.0 | 2.5 | 0.4 |
| Tank | 2.0 | 1.5 | 3.0 | 1.5 | 1.2 |

**Design notes:**
- Workers are fast and agile (high turn rate, high accel) for harvesting.
- Marines are slightly slower but handle steep terrain better (maxSlope 2.5).
- Tanks are heavy: slow turn rate (1.5 rad/s), slow acceleration, and a large
  radius (1.2 cells) which means the clearance map filters out narrow passages.

All parameters are exposed in the **Unit Editor** (`editor.html`) and
round-trip through JSON config serialization.

---

## 12. File Map

### New Files

| File | Purpose |
|------|---------|
| `src/pathfinding/sectorGraph.ts` | Sector graph construction, portal detection, sector-level A\* |

### Modified Files

| File | Changes |
|------|---------|
| `src/pathfinding/navGrid.ts` | Added `slopeData`, Chebyshev distance transform clearance, `isClearForUnit()` |
| `src/pathfinding/astar.ts` | Rewritten: hierarchical A\* with corridor constraint, slope-aware expansion, corner cut prevention |
| `src/ecs/components.ts` | Added `TurnRate`, `Acceleration`, `MaxSlope`, `CurrentSpeed`, `StuckState` |
| `src/game/config.ts` | Added `turnRate`, `acceleration`, `maxSlope` to `UnitDef` |
| `src/ecs/archetypes.ts` | Spawns units with new components |
| `src/ecs/systems/pathfindingSystem.ts` | Calls `findPathHierarchical`, passes unit radius + maxSlope, detects building count changes for clearance rebuild |
| `src/ecs/systems/movementSystem.ts` | Rewritten: full SupCom movement pipeline (turn rate, accel, wall slide, stuck escalation) |
| `src/main.ts` | Calls `buildSectorGraph()` after `initNavGrid()` |
| `src/sandbox.ts` | Same sector graph initialization |
| `src/editor.ts` | Added turnRate / acceleration / maxSlope fields to UI and config serialization |

---

## Performance Characteristics

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| Clearance map rebuild | O(W * H) | Two-pass distance transform, ~80k cells |
| Sector graph rebuild | O(S * B) | S = ~169 sectors, B = 16 border cells each |
| Sector-level A\* | O(P log P) | P = portal count (~300-500 typically) |
| Corridor-constrained A\* | O(C log C) | C = cells in padded corridor (small fraction of 40k) |
| Unconstrained A\* fallback | O(N log N) | N = up to 40k cells, rare |
| Movement pipeline | O(1) per unit | Fixed number of math ops + 5 passability lookups |

The hierarchical approach means most pathfinding queries touch only a few hundred
cells rather than the full 40,000-cell grid, providing roughly an order of
magnitude speedup over flat A\* for cross-map paths.
