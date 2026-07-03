/** HUD: DOM オーバーレイ */
let els = {};

export function initHud() {
  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.innerHTML = `
    <div id="next-stop" class="hud-panel">
      <div class="label">つぎは NEXT STOP</div>
      <div class="name">--</div>
      <div class="sub"></div>
    </div>
    <div id="ops" class="hud-panel">
      <div class="clock">--:--:--</div>
      <div class="delay">--</div>
      <div class="pax">乗客 0人</div>
      <div class="fare">運賃箱 ¥0</div>
    </div>
    <div id="score-panel" class="hud-panel">
      <div class="score">0</div>
      <div style="font-size:11px;color:#aab">SCORE</div>
      <div class="cam" style="font-size:12px;color:#9db4d8;margin-top:4px">C: カメラ切替</div>
    </div>
    <div id="speedo" class="hud-panel">
      <div><span class="kmh">0</span> <span class="unit">km/h</span></div>
      <div class="limit">40</div>
    </div>
    <div id="prompt" class="hud-panel"></div>
    <div id="door-status" class="hud-panel"></div>
    <div id="toasts"></div>
  `;
  document.body.appendChild(hud);
  els = {
    nextName: hud.querySelector('#next-stop .name'),
    nextSub: hud.querySelector('#next-stop .sub'),
    clock: hud.querySelector('#ops .clock'),
    delay: hud.querySelector('#ops .delay'),
    pax: hud.querySelector('#ops .pax'),
    fare: hud.querySelector('#ops .fare'),
    score: hud.querySelector('#score-panel .score'),
    kmh: hud.querySelector('#speedo .kmh'),
    limit: hud.querySelector('#speedo .limit'),
    prompt: hud.querySelector('#prompt'),
    doorStatus: hud.querySelector('#door-status'),
    toasts: hud.querySelector('#toasts'),
  };
}

export function fmtClock(sec) {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function updateHud(st) {
  els.kmh.textContent = Math.round(Math.abs(st.speedKmh));
  els.kmh.classList.toggle('over', st.speedKmh > st.limitKmh + 5);
  els.limit.textContent = st.limitKmh;
  els.clock.textContent = fmtClock(st.clock);
  els.score.textContent = st.score;
  els.pax.textContent = `乗客 ${st.passengers}人`;
  els.fare.textContent = `運賃箱 ¥${st.fareTotal.toLocaleString()}`;
  els.nextName.textContent = st.nextStopName ?? '--';
  els.nextSub.textContent = st.nextStopSub ?? '';
  if (st.delayText == null) {
    els.delay.textContent = '';
  } else {
    els.delay.textContent = st.delayText;
    els.delay.className = `delay delay-${st.delayKind}`;
  }
}

export function setPrompt(text, warn = false) {
  if (!text) {
    els.prompt.style.display = 'none';
    return;
  }
  els.prompt.textContent = text;
  els.prompt.className = `hud-panel${warn ? ' warn' : ''}`;
  els.prompt.style.display = 'block';
}

export function setDoorStatus(text) {
  els.doorStatus.style.display = text ? 'block' : 'none';
  if (text) els.doorStatus.innerHTML = text;
}

export function showToast(text, kind = '') {
  const div = document.createElement('div');
  div.className = `toast ${kind}`;
  div.textContent = text;
  els.toasts.appendChild(div);
  setTimeout(() => div.remove(), 2700);
  return div;
}
