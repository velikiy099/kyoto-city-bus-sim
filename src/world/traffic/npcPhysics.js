/** 前輪操舵の自転車モデル(NPC用)。BusPhysicsと同式・前進専用。 */
export class NpcPhysics {
  constructor(params, x = 0, z = 0, heading = 0) {
    this.p = params;
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.v = 0;
    this.delta = 0;
    this.throttleState = 0;
  }

  get maxSteer() {
    return (this.p.maxSteerDeg * Math.PI) / 180
      / (1 + Math.abs(this.v) / this.p.steerSpeedFactor);
  }

  step(dt, { throttle = 0, brake = 0, steer = 0 } = {}) {
    const p = this.p;

    // --- 操舵: 目標舵角へレート制限付き追従 ---
    const target = -steer * this.maxSteer;
    const rate = (steer !== 0 ? p.steerRateDeg : p.centerRateDeg) * Math.PI / 180;
    const dDelta = target - this.delta;
    this.delta += Math.sign(dDelta) * Math.min(Math.abs(dDelta), rate * dt);

    // --- 縦方向(前進専用) ---
    this.throttleState += ((throttle - this.throttleState) / p.throttleTau) * dt;
    const a = this.throttleState * p.maxAccel
      - brake * p.maxBrake
      - p.rollingDrag * (this.v > 0 ? 1 : 0)
      - p.speedDrag * this.v;
    this.v = Math.max(0, Math.min(p.maxSpeed, this.v + a * dt));
    if (this.v < 0.02 && throttle < 0.05) this.v = 0;

    // --- 旋回 ---
    const yawRate = (this.v / p.wheelbase) * Math.tan(this.delta);
    this.heading += yawRate * dt;

    // --- 位置 ---
    this.x += Math.sin(this.heading) * this.v * dt;
    this.z += Math.cos(this.heading) * this.v * dt;
  }
}
