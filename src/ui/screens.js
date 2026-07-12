import { route } from "../route/routeData.js";
import { fmtTime, schedule } from "../game/timetable.js";

/** タイトル画面 */
export function showTitle(onStart) {
  const div = document.createElement("div");
  div.className = "screen";
  div.innerHTML = `
    <div class="card">
      <div class="headsign"><span class="num">18</span><span class="dest">大宮通 久我石原町</span></div>
      <h1>京都市バス 18号系統 運転シミュレーター</h1>
      <h2>二条駅西口 → 久我石原町(全${route.stops.length}停留所・上鳥羽線)</h2>
      <div class="controls">
        <div><b>W / ↑</b> アクセル</div>
        <div><b>S / ↓</b> ブレーキ(停止中は長押しで後退)</div>
        <div><b>A・D / ←・→</b> ハンドル</div>
        <div><b>E</b> ドア開閉(停留所で停車中)</div>
        <div><b>C</b> カメラ切替(追従 / 運転席) <b>M</b> ミニマップ</div>
        <div><b>R</b> 路上に復帰(コース外では -500点) <b>Shift+R</b> タイトルに戻る</div>
        <div><b>P</b> ポーズ / 再開</div>
        <div><b>.(ピリオド) 長押し</b> 停留所停車中のみ 4倍速</div>
      </div>
      <div style="font-size:13px;color:#9db4d8;line-height:1.8">
        後乗り・前降り・運賃230円均一。停止線に合わせて左に寄せて停車し、<br>
        乗降を終えたら各停留所の定刻を守って発車しましょう。<br>
        始発 ${fmtTime(schedule[0].time)} 発 ── 早発は大幅減点です。
      </div>
      <div style="display:flex;gap:12px;justify-content:center;margin-top:4px">
        <button id="start-btn">乗務開始</button>
        <button id="demo-btn" style="background:#1a4a6e">O : デモ走行</button>
      </div>
      <div class="src">経路・停留所データ: ${route.source}<br>ダイヤ・スコアはゲーム用に簡略化しています(距離スケール ${route.scale}x)</div>
    </div>
  `;
  document.body.appendChild(div);

  let started = false;
  function startGame(demoMode) {
    if (started) return;
    started = true;
    document.removeEventListener("keydown", onKeyDown);
    div.remove();
    onStart(demoMode);
  }

  div.querySelector("#start-btn").addEventListener("click", () => startGame(false));
  div.querySelector("#demo-btn").addEventListener("click", () => startGame(true));

  // O キーでデモ走行
  function onKeyDown(e) {
    if (e.code === "KeyO" && !e.repeat) {
      document.removeEventListener("keydown", onKeyDown);
      startGame(true);
    }
    // Enter / Space でも乗務開始
    if ((e.code === "Enter" || e.code === "Space") && !e.repeat) {
      document.removeEventListener("keydown", onKeyDown);
      startGame(false);
    }
  }
  document.addEventListener("keydown", onKeyDown);
}

/** リザルト画面 */
export function showResult(stats) {
  const div = document.createElement("div");
  div.className = "screen";
  const rows = [
    ["最終スコア", `${Math.round(stats.score)} 点`],
    ["輸送人数", `${stats.carried} 人`],
    ["収受運賃", `¥${stats.fare.toLocaleString()}`],
    [
      "終点到着時刻",
      `${fmtTime(stats.clock)}(定刻 ${fmtTime(stats.schedArrival)})`,
    ],
    ["最終遅延", stats.delayText],
  ];
  const detail = stats.breakdown
    .map(
      ([label, e]) =>
        `<tr><td>${label} ×${e.count}</td><td>${e.total > 0 ? "+" : ""}${Math.round(e.total)}</td></tr>`,
    )
    .join("");
  div.innerHTML = `
    <div class="card">
      <h1>乗務終了 ── 久我石原町 到着</h1>
      <div class="rank" style="color:${{ S: "#ffd700", A: "#7fe0a0", B: "#7fb8e0", C: "#d8c890", D: "#c08878" }[stats.rank]}">${stats.rank}</div>
      <table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("")}</table>
      <details style="font-size:13px;color:#9db4d8;margin-top:6px"><summary style="cursor:pointer">スコア内訳</summary>
        <table style="margin-top:6px">${detail}</table>
      </details>
      <button id="retry-btn">もう一度乗務する</button>
    </div>
  `;
  document.body.appendChild(div);
  div
    .querySelector("#retry-btn")
    .addEventListener("click", () => location.reload());
}
