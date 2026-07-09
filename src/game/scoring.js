import { CFG } from "../config.js";
import { showToast } from "../ui/hud.js";

/** スコア管理: イベント加点/減点+継続減点+内訳記録 */
export function createScoring(state) {
  const S = CFG.score;
  const breakdown = new Map(); // label -> {count, total}
  let harshBrakeCooldown = 0;
  let harshBrakeHeld = 0; // 強ブレーキの継続時間(瞬間パルスは許容)
  let harshTurnCooldown = 0;
  let overspeedActive = false;
  let centerlineActive = false;

  function add(pts, label, kind = null, toast = true) {
    state.score += pts;
    const e = breakdown.get(label) ?? { count: 0, total: 0 };
    e.count++;
    e.total += pts;
    breakdown.set(label, e);
    if (toast)
      showToast(
        `${label} ${pts > 0 ? "+" : ""}${pts}`,
        kind ?? (pts >= 0 ? "good" : "bad"),
      );
  }

  return {
    add,
    breakdown,
    /** 毎ステップの継続判定(走行中のみ呼ぶ) */
    tick(dt, bus, limitMs) {
      harshBrakeCooldown = Math.max(0, harshBrakeCooldown - dt);
      harshTurnCooldown = Math.max(0, harshTurnCooldown - dt);

      // 急ブレーキ(0.45s 以上の継続で発火。瞬間的な強い踏み込みは許容)
      if (bus.accel < -S.harshBrakeThreshold && bus.v > 3) harshBrakeHeld += dt;
      else harshBrakeHeld = 0;
      if (harshBrakeHeld > 0.45 && harshBrakeCooldown === 0) {
        add(S.harshBrake, "急ブレーキ!");
        showToast("乗客が転倒しそうになった!", "bad");
        harshBrakeCooldown = 3;
        harshBrakeHeld = 0;
      }
      if (
        Math.abs(bus.latAccel) > S.harshLatThreshold &&
        harshTurnCooldown === 0
      ) {
        add(S.harshTurn, "急ハンドル!");
        harshTurnCooldown = 3;
      }

      // 速度超過(継続)
      const over = bus.v > limitMs + S.overspeedMargin;
      if (over) state.score += Math.round(S.overspeedPerSec * dt * 10) / 10;
      if (over && !overspeedActive) showToast("速度超過!", "bad");
      overspeedActive = over;

      // センターラインはみ出し(車体右端が中央線を越える)
      const crossing =
        state.lateral + CFG.bus.width / 2 > 0.15 && !state.offRoute;
      if (crossing)
        state.score += Math.round(S.centerlinePerSec * dt * 10) / 10;
      if (crossing && !centerlineActive)
        showToast("センターラインはみ出し!", "bad");
      centerlineActive = crossing;

      state.score = Math.round(state.score * 10) / 10;
      return { overspeed: over, centerline: crossing };
    },
    rank() {
      const sc = state.score;
      if (sc >= 4600) return "S";
      if (sc >= 3600) return "A";
      if (sc >= 2400) return "B";
      if (sc >= 1200) return "C";
      return "D";
    },
  };
}
