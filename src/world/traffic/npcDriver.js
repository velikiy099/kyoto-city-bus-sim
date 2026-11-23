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

/** 前方カーブによる速度上限。cursorの先読み経路を2m刻みで走査し、減速距離も考慮して算出。 */
export function curveSpeedLimit(cursor, v) {
  const D = CFG.traffic.driver;
  let limit = Infinity;
  for (let ahead = 0; ahead <= 38; ahead += 2) {
    const a = cursor.poseAt(ahead);
    const b = cursor.poseAt(ahead + 2);
    if (!a || !b) break;
    let dh = b.heading - a.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const k = Math.abs(dh) / 2;
    if (k > 1e-4) {
      const vCurve = Math.max(2.2, Math.sqrt(D.maxLatAccel / k));
      const vAllowed = Math.sqrt(vCurve * vCurve + 2 * 2.2 * ahead);
      limit = Math.min(limit, vAllowed);
    }
  }
  return limit;
}
