/**
 * Movement telemetry recorder.
 * Records per-tick snapshots of unit movement data.
 * On stuck or on demand, dumps last N frames as a table to console.
 *
 * Usage: press F2 to toggle recording for the selected unit.
 * Auto-dumps when stuck is detected.
 */

export interface MovementSnapshot {
  tick: number
  time: number      // elapsed seconds
  // Position
  px: number
  pz: number
  // Movement intent
  wpX: number       // current waypoint target
  wpZ: number
  distToWp: number  // distance to waypoint
  // Rotation
  yaw: number       // current yaw (radians)
  desiredYaw: number
  yawDelta: number  // signed angle diff
  // Speed
  maxSpeed: number
  targetSpeed: number
  currentSpeed: number
  turnSpeedFactor: number
  // Displacement this tick
  moveX: number
  moveZ: number
  actualDist: number // how far we actually moved
  // Collision
  blocked: boolean   // was full movement blocked?
  slideX: boolean    // did wall slide on X?
  slideZ: boolean    // did wall slide on Z?
  bothBlocked: boolean // both axes blocked?
  // Footprint checks
  fullOk: boolean
  xOnlyOk: boolean
  zOnlyOk: boolean
  // Stuck state
  stuckPhase: number
  stuckTimer: number
  // Separation force applied
  sepX: number
  sepZ: number
}

const BUFFER_SIZE = 180 // 3 seconds at 60fps

class TelemetryRecorder {
  enabled = false
  trackedEid = -1
  buffer: MovementSnapshot[] = []
  tick = 0
  startTime = 0

  // Current frame data (written by movement system)
  current: Partial<MovementSnapshot> = {}

  start(eid: number) {
    this.trackedEid = eid
    this.enabled = true
    this.buffer = []
    this.tick = 0
    this.startTime = performance.now() / 1000
    console.log(`%c[TELEMETRY] Recording unit #${eid}`, 'color: #4f8; font-weight: bold')
  }

  stop() {
    if (this.enabled) {
      console.log(`%c[TELEMETRY] Stopped recording unit #${this.trackedEid} (${this.buffer.length} frames)`, 'color: #888')
    }
    this.enabled = false
    this.trackedEid = -1
  }

  /** Called at start of movement processing for this entity */
  beginFrame(eid: number) {
    if (!this.enabled || eid !== this.trackedEid) return
    this.current = { tick: this.tick }
  }

  /** Record a field */
  set<K extends keyof MovementSnapshot>(key: K, value: MovementSnapshot[K]) {
    if (!this.enabled) return
    ;(this.current as any)[key] = value
  }

  /** Called at end of movement processing — commit the snapshot */
  endFrame(eid: number) {
    if (!this.enabled || eid !== this.trackedEid) return

    const snap: MovementSnapshot = {
      tick: this.tick,
      time: performance.now() / 1000 - this.startTime,
      px: 0, pz: 0,
      wpX: 0, wpZ: 0, distToWp: 0,
      yaw: 0, desiredYaw: 0, yawDelta: 0,
      maxSpeed: 0, targetSpeed: 0, currentSpeed: 0, turnSpeedFactor: 0,
      moveX: 0, moveZ: 0, actualDist: 0,
      blocked: false, slideX: false, slideZ: false, bothBlocked: false,
      fullOk: true, xOnlyOk: true, zOnlyOk: true,
      stuckPhase: 0, stuckTimer: 0,
      sepX: 0, sepZ: 0,
      ...this.current,
    }

    this.buffer.push(snap)
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift()
    this.tick++
  }

  /** Record separation force for this entity */
  recordSeparation(eid: number, sx: number, sz: number) {
    if (!this.enabled || eid !== this.trackedEid) return
    this.current.sepX = sx
    this.current.sepZ = sz
  }

  /** Dump telemetry to console — called on stuck or manually */
  dump(reason: string) {
    if (this.buffer.length === 0) {
      console.log('[TELEMETRY] No data recorded')
      return
    }

    console.log(`%c[TELEMETRY] Dump: ${reason} — ${this.buffer.length} frames, unit #${this.trackedEid}`, 'color: #f84; font-weight: bold; font-size: 14px')

    // Summary stats
    const last = this.buffer[this.buffer.length - 1]
    const first = this.buffer[0]
    const totalDist = this.buffer.reduce((sum, s) => sum + s.actualDist, 0)
    const avgSpeed = totalDist / (last.time - first.time || 1)
    const blockedFrames = this.buffer.filter(s => s.blocked).length
    const bothBlockedFrames = this.buffer.filter(s => s.bothBlocked).length
    const slideXFrames = this.buffer.filter(s => s.slideX).length
    const slideZFrames = this.buffer.filter(s => s.slideZ).length

    console.log(`  Duration: ${(last.time - first.time).toFixed(2)}s`)
    console.log(`  Total distance: ${totalDist.toFixed(2)} units`)
    console.log(`  Avg speed: ${avgSpeed.toFixed(2)} u/s (max: ${last.maxSpeed.toFixed(1)})`)
    console.log(`  Blocked frames: ${blockedFrames}/${this.buffer.length} (${(blockedFrames/this.buffer.length*100).toFixed(0)}%)`)
    console.log(`  Both-axis blocked: ${bothBlockedFrames}`)
    console.log(`  Slide X: ${slideXFrames}, Slide Z: ${slideZFrames}`)
    console.log(`  Stuck phase: ${last.stuckPhase}, timer: ${last.stuckTimer.toFixed(2)}s`)

    // Compact table of last 60 frames
    const frames = this.buffer.slice(-60)
    console.log('\n  Tick | Pos           | Speed     | Yaw→Want  | Dist→WP | Move       | Collision    | Stuck | Sep')
    console.log('  ─────┼───────────────┼───────────┼───────────┼─────────┼────────────┼──────────────┼───────┼─────')

    for (const s of frames) {
      const pos = `${s.px.toFixed(1)},${s.pz.toFixed(1)}`.padEnd(13)
      const spd = `${s.currentSpeed.toFixed(2)}/${s.maxSpeed.toFixed(1)}`.padEnd(9)
      const yaw = `${(s.yaw * 180 / Math.PI).toFixed(0)}→${(s.desiredYaw * 180 / Math.PI).toFixed(0)}`.padEnd(9)
      const dist = s.distToWp.toFixed(1).padEnd(7)
      const move = `${s.moveX.toFixed(3)},${s.moveZ.toFixed(3)}`.padEnd(10)
      const coll = (s.bothBlocked ? 'STUCK' : s.blocked ? (s.slideX ? 'slideX' : 'slideZ') : 'ok').padEnd(12)
      const stuck = `${s.stuckPhase}:${s.stuckTimer.toFixed(1)}`.padEnd(5)
      const sep = (s.sepX !== 0 || s.sepZ !== 0) ? `${s.sepX.toFixed(2)},${s.sepZ.toFixed(2)}` : ''

      console.log(`  ${String(s.tick).padStart(4)} | ${pos} | ${spd} | ${yaw} | ${dist} | ${move} | ${coll} | ${stuck} | ${sep}`)
    }

    // Identify the problem
    console.log('\n%c  === DIAGNOSIS ===', 'color: #ff0; font-weight: bold')
    if (bothBlockedFrames > frames.length * 0.5) {
      console.log('  %cBOTH AXES BLOCKED >50% of frames — unit is in a dead-end or clearance too tight', 'color: #f44')
    }
    if (blockedFrames > frames.length * 0.3 && bothBlockedFrames < frames.length * 0.1) {
      console.log('  %cFREQUENT SINGLE-AXIS BLOCKS — wall sliding is active but progress is slow', 'color: #fa0')
    }
    const avgTurnDelta = frames.reduce((sum, s) => sum + Math.abs(s.yawDelta), 0) / frames.length
    if (avgTurnDelta > 1.5) {
      console.log(`  %cLARGE YAW DELTAS (avg ${(avgTurnDelta * 180 / Math.PI).toFixed(0)}°) — unit keeps turning back and forth (oscillating)`, 'color: #fa0')
    }
    const zeroSpeedFrames = frames.filter(s => s.currentSpeed < 0.1).length
    if (zeroSpeedFrames > frames.length * 0.3) {
      console.log(`  %cZERO SPEED ${zeroSpeedFrames}/${frames.length} frames — unit not accelerating (turn too sharp?)`, 'color: #fa0')
    }
    const highSepFrames = frames.filter(s => Math.abs(s.sepX) + Math.abs(s.sepZ) > 1).length
    if (highSepFrames > frames.length * 0.2) {
      console.log(`  %cHIGH SEPARATION FORCE in ${highSepFrames} frames — other units pushing this one`, 'color: #fa0')
    }
    if (blockedFrames === 0 && avgSpeed < last.maxSpeed * 0.2) {
      console.log('  %cNO COLLISIONS but very slow — likely turn-rate bottleneck', 'color: #fa0')
    }
  }
}

export const telemetry = new TelemetryRecorder()
