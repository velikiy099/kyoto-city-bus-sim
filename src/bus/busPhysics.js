import { CFG } from "../config.js";

/**
 * 前輪操舵の自転車(kinematic bicycle)モデル。後軸中心が基準点。
 * 座標系: x-z 平面、forward = [sin(heading), cos(heading)]
 *   heading=0 → +z(南) / heading=π/2 → +x(東) / 舵角正 = 左旋回
 */
export class BusPhysics {
  constructor(x = 0, z = 0, heading = 0) {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.v = 0; // 前進正 [m/s]
    this.delta = 0; // 実舵角 [rad]
    this.throttleState = 0; // アクセル一次遅れ状態
    this.accel = 0; // 直近の加速度(スコア判定用)
    this.latAccel = 0; // 横加速度
    this.throttleLocked = false; // ドア開放中インターロック
    this.reverseHold = 0; // 停止中のブレーキ長押し時間(後退開始の判定)
  }

  get maxSteer() {
    const B = CFG.bus;
    return (
      (B.maxSteerDeg * Math.PI) /
      180 /
      (1 + Math.abs(this.v) / B.steerSpeedFactor)
    );
  }

  get forward() {
    return [Math.sin(this.heading), Math.cos(this.heading)];
  }

  /** 前軸(前扉付近)のワールド位置 */
  frontPos() {
    const [fx, fz] = this.forward;
    return [this.x + fx * CFG.bus.wheelbase, this.z + fz * CFG.bus.wheelbase];
  }

  step(dt, { throttle = 0, brake = 0, steer = 0 }) {
    const B = CFG.bus;
    if (this.throttleLocked) throttle = 0;

    // --- 操舵: 目標舵角へレート制限付き追従 ---
    const target = -steer * this.maxSteer; // 入力 steer: 左=-1 → 舵角正(左旋回)
    const rate = steer !== 0 ? B.steerRate : B.centerRate;
    const dDelta = target - this.delta;
    this.delta += Math.sign(dDelta) * Math.min(Math.abs(dDelta), rate * dt);

    // --- 縦方向 ---
    this.throttleState +=
      ((throttle - this.throttleState) / B.throttleTau) * dt;
    let a = 0;
    if (this.v > 0.05) {
      // 前進中
      a = this.throttleState * B.maxAccel - brake * B.maxBrake;
      a -= B.rollingDrag * Math.sign(this.v) + B.speedDrag * this.v;
    } else if (this.v < -0.05) {
      // 後退中(Wで制動)
      a = -brake * 0 + throttle * B.maxBrake; // W=制動
      a += brake * -B.reverseAccel;
      a += B.rollingDrag; // 抵抗は前進方向へ
    } else {
      // ほぼ停止。後退は「停止後に S を押し直して 0.35s ホールド」で発動
      // (制動の押しっぱなしや autoDrive の停止維持ブレーキでは後退しない)
      if (throttle > 0.1) {
        a = this.throttleState * B.maxAccel;
        this.reverseArmed = false;
        this.reverseHold = 0;
      } else if (brake > 0.1) {
        if (!this.brakeWasDown) this.reverseArmed = true;
        if (this.reverseArmed) {
          this.reverseHold += dt;
          if (this.reverseHold > 0.35) a = -B.reverseAccel;
          else this.v = 0;
        } else {
          this.v = 0;
        }
      } else {
        this.v = 0;
        this.throttleState = Math.min(this.throttleState, 0.2);
        this.reverseArmed = false;
        this.reverseHold = 0;
      }
    }
    const vPrev = this.v;
    this.v = Math.max(-B.maxReverse, Math.min(B.maxSpeed, this.v + a * dt));
    // 制動での符号反転を止める(ブレーキで後退し始めない)
    if (vPrev > 0 && this.v < 0 && brake > 0 && throttle === 0) this.v = 0;
    if (vPrev < 0 && this.v > 0 && throttle > 0 && brake === 0) this.v = 0;
    this.accel = (this.v - vPrev) / dt;

    // --- 旋回 ---
    const yawRate = (this.v / B.wheelbase) * Math.tan(this.delta);
    this.heading += yawRate * dt;
    this.latAccel = yawRate * this.v;

    // --- 位置 ---
    const [fx, fz] = this.forward;
    this.x += fx * this.v * dt;
    this.z += fz * this.v * dt;
    this.brakeWasDown = brake > 0.1;
  }

  get speedKmh() {
    return this.v * 3.6;
  }
}
