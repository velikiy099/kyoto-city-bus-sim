import { CFG } from "../../config.js";

/** pure pursuit操舵。cursor.poseAt(Ld)の点を狙う。返り値-1..1。 */
export function steerInput(phys, cursor) {
  const D = CFG.traffic.driver;
  const Ld = Math.max(D.lookAheadMin, Math.min(D.lookAheadMax, 4 + phys.v * 1.5));
  const target = cursor.poseAt(Ld);
  if (!target) return 0;
  const dx = target.x - phys.x;
  const dz = target.z - phys.z;
  const dist = Math.hypot(dx, dz) || 1e-6;
  let alpha = Math.atan2(dx, dz) - phys.heading;
  while (alpha > Math.PI) alpha -= 2 * Math.PI;
  while (alpha < -Math.PI) alpha += 2 * Math.PI;
  const curvature = (2 * Math.sin(alpha)) / dist;
  const deltaDesired = Math.atan(curvature * phys.p.wheelbase);
  return Math.max(-1, Math.min(1, -deltaDesired / phys.maxSteer));
}

/** IDMの目標加速度[m/s²]をthrottle/brakeペダルに変換。 */
export function pedalsForAccel(phys, accel) {
  const p = phys.p;
  if (accel >= 0) {
    const drag = p.rollingDrag + p.speedDrag * phys.v;
    return {
      throttle: Math.max(0, Math.min(1, (accel + drag) / p.maxAccel)),
      brake: 0,
    };
  }
  return {
    throttle: 0,
    brake: Math.max(0, Math.min(0.9, -accel / p.maxBrake)),
  };
}

/** 前方カーブによる速度上限。cursorの先読み経路の曲率から算出。 */
export function curveSpeedLimit(cursor, v) {
  const D = CFG.traffic.driver;
  let limit = Infinity;
  for (let ahead = 4; ahead <= 40; ahead += 6) {
    const a = cursor.poseAt(Math.max(0, ahead - 2));
    const b = cursor.poseAt(ahead + 2);
    if (!a || !b) break;
    let dh = b.heading - a.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const k = Math.abs(dh) / 4;
    if (k > 1e-4) {
      // 遠いカーブほど今は速くてよい(減速余地がある)。
      const vCurve = Math.sqrt(D.maxLatAccel / k) + Math.max(0, ahead - 10) * 0.15;
      limit = Math.min(limit, Math.max(2.0, vCurve));
    }
  }
  return limit;
}
