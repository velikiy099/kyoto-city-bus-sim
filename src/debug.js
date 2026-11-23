import { CFG } from "./config.js";
import { input } from "./input.js";
import { speedLimitAt } from "./route/routeData.js";

/**
 * デバッグ/自動運転。window.game に API を公開する。
 * ctx: { bus, path, route, traffic, getState } — getState() は毎回最新のゲーム状態を返す
 */
export const dbg = {
  autoDrive: false,
  timeScale: 1,
  fpsSamples: [],
};

/** 経路追従オートパイロット(pure pursuit + 速度制御)。対向車AIにも流用 */
export function autoDriveInput(
  bus,
  path,
  s,
  stopTargetS = null,
  targetLat = 0,
  vCap = Infinity,
) {
  const B = CFG.bus;
  const maxSteerRad = (B.maxSteerDeg * Math.PI) / 180;
  // --- 操舵: 目標横位置を狙う pure pursuit ---
  const kLocal = Math.max(
    Math.abs(path.curvatureAt(s)),
    Math.abs(path.curvatureAt(Math.min(s + 8, path.length - 0.1))),
  );
  const minLd = kLocal > 0.08 ? 4.2 : 6.0;
  const Ld = Math.max(minLd, Math.min(30, 3.2 + bus.v * 1.8));
  const sAhead = Math.min(s + Ld, path.length - 0.1);
  const target = laneCenterPoint(
    path,
    sAhead,
    targetLat,
  );
  const dx = target[0] - bus.x,
    dz = target[1] - bus.z;
  const distT = Math.hypot(dx, dz) || 1e-6;
  const targetH = Math.atan2(dx, dz);
  let alpha = targetH - bus.heading;
  while (alpha > Math.PI) alpha -= 2 * Math.PI;
  while (alpha < -Math.PI) alpha += 2 * Math.PI;
  const curvature = (2 * Math.sin(alpha)) / distT;
  const deltaDesired = Math.atan(curvature * B.wheelbase);
  const steer = Math.max(-1, Math.min(1, -deltaDesired / bus.maxSteer));

  // --- 速度: 制限速度・前方カーブ(横G + 舵角制限)・停止目標から目標速度を決定 ---
  let vTarget = speedLimitAt(s) * 0.92;
  for (let ahead = 0; ahead <= 90; ahead += 3) {
    const sampleS = Math.min(s + ahead, path.length - 1);
    const k = Math.max(
      Math.abs(path.curvatureAt(sampleS, 6)),
      Math.abs(path.curvatureAt(sampleS, 2)),
    );
    if (k > 1e-4) {
      // 横G 2.2m/s^2 上限と、車速に応じた最大舵角制限の両方を満たす安全速度
      const deltaReq = Math.atan(k * B.wheelbase);
      const steerCap = deltaReq >= maxSteerRad * 0.94
        ? 1.5
        : Math.max(1.5, B.steerSpeedFactor * (maxSteerRad / Math.max(1e-4, deltaReq) - 1) * 0.88);
      const latGCat = Math.max(2.5, Math.sqrt(2.4 / k));
      const apexV = Math.min(latGCat, steerCap);
      const vReach = Math.sqrt(apexV * apexV + 2 * 0.75 * Math.max(0, ahead - 6));
      vTarget = Math.min(vTarget, vReach);
    }
  }
  if (stopTargetS != null) {
    const d = stopTargetS - s;
    if (d < 0.7) vTarget = 0;
    // 微速下限 0.9m/s を維持: 停止直前まで進みながら縁石へ寄せ続ける
    else
      vTarget = Math.min(
        vTarget,
        Math.max(0.9, Math.sqrt(2 * 0.9 * (d - 0.6))),
      );
  }
  vTarget = Math.min(vTarget, vCap);

  let throttle = 0,
    brake = 0;
  const dv = vTarget - bus.v;
  if (vTarget < 0.05 && Math.abs(bus.v) < 0.15) {
    // 完全停止: ブレーキも離す(踏み続けると後退アームの誤発動につながる)
  } else if (vTarget < 0.05 && bus.v < 0.6) brake = 1;
  else if (vTarget > 0.1 && dv > 0.04) throttle = Math.min(1, 0.25 + dv * 0.85);
  else if (dv < -0.25) brake = Math.min(0.85, -dv * 0.45); // フル制動を避け急ブレーキ減点を防ぐ
  return { throttle, brake, steer };
}

function laneCenterPoint(path, s, lat = 0) {
  const [px, pz] = path.getPoint(s);
  const [tx, tz] = path.getTangent(s);
  return [px + -tz * lat, pz + tx * lat];
}

export function setupDebug(ctx) {
  const { bus, path, route } = ctx;
  window.game = {
    _ctx: ctx,
    traffic: ctx.traffic,
    input: {
      override: (o) => input.setOverride(o),
      clear: () => input.setOverride(null),
      press: (code) => input.press(code),
    },
    debug: {
      status() {
        const st = ctx.getState();
        return JSON.parse(JSON.stringify(st));
      },
      autoDrive(on = true) {
        dbg.autoDrive = on;
        return `autoDrive=${on}`;
      },
      timeScale(x = 1) {
        dbg.timeScale = Math.max(0.1, Math.min(16, x));
        return `timeScale=${dbg.timeScale}`;
      },
      teleport(stopIndex, offset = -30) {
        const stop = route.stops[stopIndex];
        if (!stop) return "no such stop";
        const s = Math.max(0, stop.s + offset);
        const p = laneCenterPoint(path, s);
        const [tx, tz] = path.getTangent(s);
        bus.x = p[0];
        bus.z = p[1];
        bus.heading = Math.atan2(tx, tz);
        bus.v = 0;
        bus.delta = 0;
        ctx.onTeleport?.(s, stopIndex);
        return `teleported to ${stop.name} ${offset}m`;
      },
      teleportS(targetS) {
        const s = Math.max(0, Math.min(path.length - 0.1, Number(targetS) || 0));
        const p = laneCenterPoint(path, s);
        const [tx, tz] = path.getTangent(s);
        bus.x = p[0];
        bus.z = p[1];
        bus.heading = Math.atan2(tx, tz);
        bus.v = 0;
        bus.delta = 0;
        ctx.onTeleport?.(s, null);
        return `teleported to s=${s.toFixed(1)}`;
      },
      fps() {
        const a = dbg.fpsSamples;
        return a.length
          ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)
          : 0;
      },
      /**
       * ゲーム内時間を同期的に一気に進める(描画なし・タブ非表示でも動く)。
       * until: 途中終了条件 (state) => bool
       */
      fastForward(seconds = 60, until = null) {
        const t0 = performance.now();
        const n = Math.floor(seconds * 60);
        for (let i = 0; i < n; i++) {
          ctx.tick?.(1 / 60, false);
          if (until && i % 30 === 0 && until(ctx.getState())) break;
        }
        return {
          simulated: `${seconds}s`,
          wallMs: +(performance.now() - t0).toFixed(0),
          state: ctx.getState(),
        };
      },
    },
  };
}

export function recordFrame(dtMs) {
  const fps = 1000 / Math.max(1, dtMs);
  dbg.fpsSamples.push(fps);
  if (dbg.fpsSamples.length > 120) dbg.fpsSamples.shift();
}
