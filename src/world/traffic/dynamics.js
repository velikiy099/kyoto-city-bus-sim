import { CFG } from "../../config.js";

// ===== 共通走行ダイナミクス =====
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 信号の基準点は交差点中心。NPCはそこから9m手前を停止線とし、
// 車体前端が停止線の3.2m手前に来るように停止する。自車のsは後軸中心なので、
// 同じ前端位置になるよう、バスでは後軸から前端までの長さも差し引く。
export const SIGNAL_STOP_LINE_OFFSET = 9;
export const SIGNAL_STOP_GAP = 3.2;
export const BUS_FRONT_OFFSET = CFG.bus.length - CFG.bus.rearOverhang;
export const signalStopLineS = (signalS, dir = 1) => signalS - SIGNAL_STOP_LINE_OFFSET * dir;
export const busSignalStopTargetS = (signalS, dir = 1) =>
  signalStopLineS(signalS, dir) - dir * (BUS_FRONT_OFFSET + SIGNAL_STOP_GAP);

/** IDM(知的運転者モデル)に近い追従加速度。前車との速度差を考慮し、
 * 単純な距離比例制御で起きていた急制動・速度振動を抑える。 */
export function idmAcceleration(speed, desiredSpeed, gap = Infinity, leadSpeed = desiredSpeed, options = {}) {
  const acceleration = options.acceleration ?? 1.25;
  const comfortableBrake = options.comfortableBrake ?? 2.0;
  const minimumGap = options.minimumGap ?? 3.2;
  const timeHeadway = options.timeHeadway ?? 1.35;
  const target = Math.max(0.5, desiredSpeed);
  const freeRoad = 1 - Math.pow(speed / target, 4);
  if (!Number.isFinite(gap)) return acceleration * freeRoad;
  const closingSpeed = speed - Math.max(0, leadSpeed);
  const dynamicGap = minimumGap + Math.max(
    0,
    speed * timeHeadway + (speed * closingSpeed) / (2 * Math.sqrt(acceleration * comfortableBrake)),
  );
  const interaction = Math.pow(dynamicGap / Math.max(0.5, gap), 2);
  return clamp(acceleration * (freeRoad - interaction), -5.0, acceleration);
}

export function orientedBoxesOverlap(a, b) {
  // Use the actual vertical overlap. The previous extra 0.35m tolerance made
  // vehicles on a nearby bridge/underpass count as collisions even when their
  // visible bodies were separated.
  if (Math.abs((a.y ?? 0) - (b.y ?? 0)) >= ((a.height ?? 2) + (b.height ?? 2)) * 0.5) return false;
  const axes = [
    [Math.sin(a.heading), Math.cos(a.heading)],
    [Math.cos(a.heading), -Math.sin(a.heading)],
    [Math.sin(b.heading), Math.cos(b.heading)],
    [Math.cos(b.heading), -Math.sin(b.heading)],
  ];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const cornersRadius = (box, axis) => {
    const f = [Math.sin(box.heading), Math.cos(box.heading)];
    const r = [Math.cos(box.heading), -Math.sin(box.heading)];
    return Math.abs(axis[0] * f[0] + axis[1] * f[1]) * box.halfLength
      + Math.abs(axis[0] * r[0] + axis[1] * r[1]) * box.halfWidth;
  };
  for (const axis of axes) {
    const centerDistance = Math.abs(dx * axis[0] + dz * axis[1]);
    if (centerDistance > cornersRadius(a, axis) + cornersRadius(b, axis)) return false;
  }
  return true;
}
