/** WebAudio 生成 SFX(外部音源なし + 左折音声クリップ) */
let ctx = null;
let engine = null;
let turnLeftBuffer = null;
let turnLeftLoading = false;
let leftVoiceActive = false;
let leftVoiceSource = null;
let leftVoiceTimer = null;

function loadTurnLeftAudio() {
  if (!ctx || turnLeftBuffer || turnLeftLoading) return;
  turnLeftLoading = true;
  fetch("audio/turn-left.wav")
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((buf) => (buf && ctx ? ctx.decodeAudioData(buf) : null))
    .then((decoded) => {
      turnLeftBuffer = decoded;
      turnLeftLoading = false;
      if (leftVoiceActive && !leftVoiceSource && !leftVoiceTimer) {
        scheduleLeftTurnClip();
      }
    })
    .catch(() => {
      turnLeftLoading = false;
    });
}

function scheduleLeftTurnClip() {
  if (!ctx || !turnLeftBuffer || !leftVoiceActive || leftVoiceSource) return;
  const src = ctx.createBufferSource();
  src.buffer = turnLeftBuffer;
  const g = ctx.createGain();
  g.gain.value = 0.65;
  src.connect(g).connect(ctx.destination);
  leftVoiceSource = src;
  src.onended = () => {
    if (leftVoiceSource !== src) return;
    leftVoiceSource = null;
    if (!leftVoiceActive) return;
    leftVoiceTimer = setTimeout(() => {
      leftVoiceTimer = null;
      scheduleLeftTurnClip();
    }, 950);
  };
  src.start();
}

/** ユーザー操作後に呼ぶ(スタートボタン) */
export function initAudio() {
  if (ctx) {
    loadTurnLeftAudio();
    return;
  }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    console.info("[sfx] AudioContext unavailable — silent mode");
    return;
  }
  loadTurnLeftAudio();

  // エンジン音: ローパスノイズ + 低音のこぎり波
  const bufLen = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = "lowpass";
  noiseFilter.frequency.value = 120;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  noise.connect(noiseFilter).connect(noiseGain).connect(ctx.destination);
  noise.start();

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 42;
  const oscGain = ctx.createGain();
  oscGain.gain.value = 0;
  const oscFilter = ctx.createBiquadFilter();
  oscFilter.type = "lowpass";
  oscFilter.frequency.value = 220;
  osc.connect(oscFilter).connect(oscGain).connect(ctx.destination);
  osc.start();

  engine = { osc, oscGain, noiseGain, noiseFilter };
}

/** 毎フレーム: 速度・アクセルに応じたエンジン音 */
export function updateEngine(vKmh, throttle) {
  if (!engine) return;
  const speed = Number.isFinite(vKmh) ? vKmh : 0;
  const load = Math.min(1, Math.abs(speed) / 50);
  const throttleLevel = Number.isFinite(throttle) ? throttle : 0;
  engine.osc.frequency.value = 40 + load * 65 + throttleLevel * 14;
  engine.oscGain.gain.value = 0.035 + load * 0.045 + throttleLevel * 0.02;
  engine.noiseGain.gain.value = 0.015 + load * 0.05;
  engine.noiseFilter.frequency.value = 100 + load * 420;
}

/** タイトル画面・結果画面ではエンジン音と警戒放送を止める */
export function stopEngine() {
  if (engine) {
    engine.oscGain.gain.value = 0;
    engine.noiseGain.gain.value = 0;
  }
  setLeftTurnVoice(false);
}

function blip(freq, dur, type = "sine", gain = 0.12, when = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** ドア開閉「プシュー」 */
export function doorAir() {
  if (!ctx) return;
  const dur = 0.7;
  const src = ctx.createBufferSource();
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++)
    d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = 1800;
  const g = ctx.createGain();
  g.gain.value = 0.16;
  src.connect(f).connect(g).connect(ctx.destination);
  src.start();
}

/** 降車ボタン「ピンポーン」 */
export function buzzer() {
  blip(988, 0.28, "sine", 0.14);
  blip(784, 0.5, "sine", 0.14, 0.22);
}

/** 運賃箱「チャリン」 */
export function coin() {
  blip(2600, 0.09, "square", 0.05);
  blip(3400, 0.16, "sine", 0.07, 0.05);
}

/** ウインカーリレー作動音「カチッ/カッ」 */
export function blinkerClick(on) {
  if (!ctx) return;
  blip(on ? 1250 : 920, 0.018, "triangle", on ? 0.09 : 0.065);
  blip(on ? 420 : 320, 0.014, "square", 0.03);
}

/** 左ウインカー音声「左に寄ります、ご注意ください」を次停放送とは独立して繰り返す */
export function setLeftTurnVoice(active) {
  const next = Boolean(active);
  if (next === leftVoiceActive) return;
  leftVoiceActive = next;
  if (!next) {
    if (leftVoiceTimer) {
      clearTimeout(leftVoiceTimer);
      leftVoiceTimer = null;
    }
    if (leftVoiceSource) {
      const src = leftVoiceSource;
      leftVoiceSource = null;
      try {
        src.stop();
      } catch {
        // ignore
      }
    }
    return;
  }
  loadTurnLeftAudio();
  if (turnLeftBuffer && !leftVoiceSource && !leftVoiceTimer) {
    scheduleLeftTurnClip();
  }
}
