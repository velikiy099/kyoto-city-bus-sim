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
  setReverseBuzzer(false);
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

let blinkerNoiseBuffer = null;

function getBlinkerNoiseBuffer() {
  if (!ctx) return null;
  const len = Math.ceil(ctx.sampleRate * 0.02);
  if (blinkerNoiseBuffer && blinkerNoiseBuffer.length === len && blinkerNoiseBuffer.sampleRate === ctx.sampleRate) {
    return blinkerNoiseBuffer;
  }
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  blinkerNoiseBuffer = buf;
  return buf;
}

/**
 * ウインカーリレー作動音 (PDG-AA273KAN 実車録音準拠:
 * ON 約 1090 Hz 筐体共鳴 + +3.8ms 微バウンス + 6.5 kHz 接点スナップ /
 * OFF 約 960 Hz + 350 Hz リリース thud)
 */
export function blinkerClick(on) {
  if (!ctx) return;
  const t = ctx.currentTime;

  const triggerKnock = (freqStart, freqEnd, tau, peakGain, delay = 0) => {
    const t0 = t + delay;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freqStart, t0);
    if (freqEnd !== freqStart) {
      osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + Math.max(0.004, tau * 2.5));
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.0004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + tau * 6.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + tau * 6.5 + 0.005);
  };

  const triggerSnap = (centerHz, q, tau, peakGain) => {
    const buf = getBlinkerNoiseBuffer();
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = centerHz;
    bp.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peakGain, t + 0.0003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + tau * 6.0);
    src.connect(bp).connect(gain).connect(ctx.destination);
    src.start(t);
    src.stop(t + tau * 6.0 + 0.005);
  };

  if (on) {
    triggerKnock(1090, 980, 0.0022, 0.16);
    triggerKnock(360, 360, 0.0032, 0.075);
    triggerKnock(1160, 1120, 0.0014, 0.042, 0.0038);
    triggerSnap(6500, 1.4, 0.0012, 0.11);
  } else {
    triggerKnock(960, 860, 0.0018, 0.105);
    triggerKnock(350, 340, 0.0035, 0.115);
    triggerSnap(8000, 1.6, 0.0010, 0.07);
  }
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

let revBuzzerActive = false;
let revBuzzerTimer = null;
let revBuzzerNodes = null;
let revBuzzerWave = null;

function getReverseBuzzerWave() {
  if (revBuzzerWave || !ctx) return revBuzzerWave;
  const real = new Float32Array(10);
  const imag = new Float32Array([0, 1.0, 0.47, 1.15, 0.23, 0.35, 0.14, 0.14, 0.10, 0.07]);
  revBuzzerWave = ctx.createPeriodicWave(real, imag);
  return revBuzzerWave;
}

function stopActiveReverseTone() {
  if (!revBuzzerNodes || !ctx) return;
  const { osc, gain } = revBuzzerNodes;
  revBuzzerNodes = null;
  try {
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.015);
    osc.stop(t + 0.02);
  } catch {
    // ignore
  }
}

function playReverseBeepCycle() {
  if (!ctx || !revBuzzerActive) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const wave = getReverseBuzzerWave();
  if (wave) {
    osc.setPeriodicWave(wave);
  } else {
    osc.type = "sawtooth";
  }
  osc.frequency.value = 466.16; // B♭4 (466.16 Hz)
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 320;
  const peak = ctx.createBiquadFilter();
  peak.type = "peaking";
  peak.frequency.value = 1398;
  peak.Q.value = 2.0;
  peak.gain.value = 3.0;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 3800;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(0.095, t + 0.006);
  gain.gain.setValueAtTime(0.095, t + 0.246);
  gain.gain.linearRampToValueAtTime(0.0001, t + 0.260);
  osc.connect(highpass).connect(peak).connect(lowpass).connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.27);
  revBuzzerNodes = { osc, gain };
  revBuzzerTimer = setTimeout(() => {
    revBuzzerTimer = null;
    if (revBuzzerNodes?.osc === osc) revBuzzerNodes = null;
    if (revBuzzerActive) playReverseBeepCycle();
  }, 700);
}

/** 後退ブザー (B♭4 / 466.16 Hz のリードホーン系断続音: 260ms ON / 700ms 周期) */
export function setReverseBuzzer(active) {
  const next = Boolean(active);
  if (next === revBuzzerActive) return;
  revBuzzerActive = next;
  if (!next) {
    if (revBuzzerTimer) {
      clearTimeout(revBuzzerTimer);
      revBuzzerTimer = null;
    }
    stopActiveReverseTone();
    return;
  }
  playReverseBeepCycle();
}
