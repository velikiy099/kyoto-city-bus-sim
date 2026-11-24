import { fmtTime } from "../game/timetable.js";

/** タイトル画面 */
export function showTitle({
  route,
  semantics = {},
  schedule = [],
  availableRoutes = [],
  currentRouteId = null,
  onSelectRoute = null,
  onStart,
}) {
  const routeNumber = semantics.routeNumber ?? "";
  const titleHeadsign = semantics.titleHeadsign ?? `${semantics.origin ?? ""} → ${semantics.terminal ?? ""}`;
  const routeTitle = semantics.routeTitle ?? route.name ?? "バス運転シミュレーター";
  const origin = semantics.origin ?? route.stops?.[0]?.name ?? "";
  const terminal = semantics.terminal ?? route.stops?.at(-1)?.name ?? "";
  const lineSuffix = semantics.lineName ? `・${semantics.lineName}` : "";
  const fareSummary = semantics.fareSummary ?? "";
  const firstTime = schedule?.[0]?.time != null ? fmtTime(schedule[0].time) : "--:--:--";

  const routeSelectorHtml = availableRoutes.length > 1
    ? `<div style="margin:6px 0"><label for="route-select" style="font-size:12px;color:#9db4d8;margin-right:8px">路線選択:</label><select id="route-select">${availableRoutes
        .map(
          (item) =>
            `<option value="${item.id}"${item.id === currentRouteId ? " selected" : ""}>${item.label}</option>`,
        )
        .join("")}</select></div>`
    : "";

  const div = document.createElement("div");
  div.className = "screen";
  div.innerHTML = `
    <div class="card">
      <div class="headsign"><span class="num">${routeNumber}</span><span class="dest">${titleHeadsign}</span></div>
      <h1>${routeTitle}</h1>
      <h2>${origin} → ${terminal}(全${route.stops.length}停留所${lineSuffix})</h2>
      ${routeSelectorHtml}
      <div class="controls">
        <div><b>W / ↑</b> アクセル</div>
        <div><b>S / ↓</b> ブレーキ(停止中は長押しで後退)</div>
        <div><b>A・D / ←・→</b> ハンドル</div>
        <div><b>Q / E / T</b> ウインカー(左 / 右) / ハザード</div>
        <div><b>F</b> ドア開閉(停留所で停車中)</div>
        <div><b>C</b> カメラ切替(追従 / 運転席)</div>
        <div><b>M</b> ミニマップ表示切替</div>
        <div><b>R</b> 路上に復帰(コース外では -500点)</div>
        <div><b>Shift+R</b> タイトルに戻る</div>
        <div><b>P</b> ポーズ / 再開</div>
        <div><b>.(ピリオド) 長押し</b> 停留所停車中のみ 4倍速</div>
      </div>
      <div style="font-size:13px;color:#9db4d8;line-height:1.8">
        ${fareSummary}停止線に合わせて左に寄せて停車し、<br>
        乗降を終えたら各停留所の定刻を守って発車しましょう。<br>
        始発 ${firstTime} 発 ── 早発は大幅減点です。
      </div>
      <div style="display:flex;gap:12px;justify-content:center;margin-top:4px">
        <button id="start-btn">乗務開始</button>
        <button id="demo-btn" style="background:#1a4a6e">O : デモ走行</button>
      </div>
      <div class="src">経路・停留所データ: ${route.source}<br>ダイヤ・スコアはゲーム用に簡略化しています(距離スケール ${route.scale}x)</div>
    </div>
  `;
  document.body.appendChild(div);

  const routeSelect = div.querySelector("#route-select");
  if (routeSelect && onSelectRoute) {
    routeSelect.addEventListener("change", (e) => onSelectRoute(e.target.value));
  }

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
export function showResult(stats, semantics = {}) {
  const terminal = semantics.terminal ?? "終点";
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
      <h1>乗務終了 ── ${terminal} 到着</h1>
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
