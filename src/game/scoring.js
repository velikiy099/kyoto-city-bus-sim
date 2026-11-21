import { CFG } from "../config.js";
import { showToast } from "../ui/hud.js";

/** スコア管理: イベント加点/減点+継続減点+内訳記録(単一台帳) */
export function createScoring(state) {
  const S = CFG.score;
  const breakdown = new Map(); // label -> {count, total}
  let harshBrakeCooldown = 0;
  let harshBrakeHeld = 0; // 強ブレーキの継続時間(瞬間パルスは許容)
  let harshTurnCooldown = 0;
  let overspeedActive = false;
  let centerlineActive = false;

  function syncScore() {
    let total = 0;
    for (const entry of breakdown.values()) total += entry.total;
    state.score = total;
  }

  function add(pts, label, kind = null, toast = true) {
    const e = breakdown.get(label) ?? { count: 0, total: 0 };
    e.count++;
    e.total += pts;
    breakdown.set(label, e);
    syncScore();
    if (toast)
      showToast(
        `${label} ${pts > 0 ? "+" : ""}${pts}`,
        kind ?? (pts >= 0 ? "good" : "bad"),
      );
  }

  function addContinuous(deltaPts, label, isNewEvent) {
    const e = breakdown.get(label) ?? { count: 0, total: 0 };
    if (isNewEvent) e.count++;
    e.total += deltaPts;
    breakdown.set(label, e);
    syncScore();
  }

  function rankFor(score) {
    if (score >= 4600) return "S";
    if (score >= 3600) return "A";
    if (score >= 2400) return "B";
    if (score >= 1200) return "C";
    return "D";
  }

  /** リザルト表示用: 丸め後の内訳合計と最終スコア・ランクを完全一致させる */
  function resultSummary() {
    const entries = [];
    let score = 0;
    for (const [label, e] of breakdown.entries()) {
      const rounded = Math.round(e.total);
      if (rounded === 0) continue;
      entries.push([label, { count: e.count, total: rounded }]);
      score += rounded;
    }
    return {
      score,
      rank: rankFor(score),
      breakdown: entries,
    };
  }

  function reset() {
    breakdown.clear();
    harshBrakeCooldown = 0;
    harshBrakeHeld = 0;
    harshTurnCooldown = 0;
    overspeedActive = false;
    centerlineActive = false;
    state.score = 0;
  }

  return {
    add,
    breakdown,
    resultSummary,
    reset,
    /**
     * 毎ステップの継続判定(走行中のみ呼ぶ)
     * centerline: { hasCenterline: boolean, centerLateral: number }
     */
    tick(dt, bus, limitMs, centerline = null) {
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

      // 速度超過(継続・浮動小数点で正確に蓄積し内訳へ計上)
      const over = bus.v > limitMs + S.overspeedMargin;
      if (over) {
        const started = !overspeedActive;
        addContinuous(S.overspeedPerSec * dt, "速度超過", started);
        if (started) showToast("速度超過!", "bad");
      }
      overspeedActive = over;

      // センターラインはみ出し(対向車線・中央線あり区間のみ、描画中央線基準で判定)
      const hasCenterline = Boolean(centerline?.hasCenterline);
      const centerLateral = Number.isFinite(centerline?.centerLateral)
        ? centerline.centerLateral
        : -Infinity;
      const crossing =
        hasCenterline &&
        !state.offRoute &&
        centerLateral + CFG.bus.width / 2 > 0.15;
      if (crossing) {
        const started = !centerlineActive;
        addContinuous(S.centerlinePerSec * dt, "センターラインはみ出し", started);
        if (started) showToast("センターラインはみ出し!", "bad");
      }
      centerlineActive = crossing;

      return { overspeed: over, centerline: crossing };
    },
    rank() {
      return rankFor(Math.round(state.score));
    },
  };
}
