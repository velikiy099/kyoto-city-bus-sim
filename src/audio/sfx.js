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
  stopDoorBuzzer();
  stopMiddleDoorSensorBuzzer();
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

let doorBuzzerWave = null;
let doorBuzzerNodes = null;
let midDoorSensorWave = null;
let midDoorSensorNodes = null;

function getDoorBuzzerWave() {
  if (doorBuzzerWave || !ctx) return doorBuzzerWave;
  const real = new Float32Array(9);
  const imag = new Float32Array([0, 0.26, 1.0, 0.62, 0.18, 0.85, 0.33, 0.34, 0.12]);
  doorBuzzerWave = ctx.createPeriodicWave(real, imag);
  return doorBuzzerWave;
}

function stopDoorBuzzer() {
  if (!doorBuzzerNodes || !ctx) return;
  const { osc, gain } = doorBuzzerNodes;
  doorBuzzerNodes = null;
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

/** ドア開閉ブザー (C5 よりやや低い 498.1 Hz・第2/3/5倍音強調) */
export function doorBuzzer(durationSec = 0.85) {
  if (!ctx) return;
  stopDoorBuzzer();
  const dur = Math.max(0.1, durationSec);
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const wave = getDoorBuzzerWave();
  if (wave) osc.setPeriodicWave(wave);
  else osc.type = "sawtooth";
  osc.frequency.value = 498.1;
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 380;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 4500;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(0.11, t + 0.008);
  gain.gain.setValueAtTime(0.11, t + dur - 0.018);
  gain.gain.linearRampToValueAtTime(0.0001, t + dur);
  osc.connect(highpass).connect(lowpass).connect(gain).connect(ctx.destination);
  const nodes = { osc, gain };
  doorBuzzerNodes = nodes;
  osc.onended = () => {
    if (doorBuzzerNodes === nodes) doorBuzzerNodes = null;
  };
  osc.start(t);
  osc.stop(t + dur + 0.015);
}

function getMidDoorSensorWave() {
  if (midDoorSensorWave || !ctx) return midDoorSensorWave;
  const real = new Float32Array(13);
  const imag = new Float32Array([
    0, 0.66, 0.22, 1.0, 0.47, 0.37, 0.11, 0.15, 0.05, 0.04, 0.07, 0.21, 0.20,
  ]);
  midDoorSensorWave = ctx.createPeriodicWave(real, imag);
  return midDoorSensorWave;
}

function stopMiddleDoorSensorBuzzer() {
  if (!midDoorSensorNodes || !ctx) return;
  const { osc, gain, stopTimer } = midDoorSensorNodes;
  midDoorSensorNodes = null;
  if (stopTimer) clearTimeout(stopTimer);
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

/** 中扉ステップセンサーブザー (低い A / 225.6 Hz、乗車ごとに 1.5 秒) */
export function middleDoorSensorBuzzer(durationSec = 1.5) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const dur = Math.max(0.1, durationSec);
  if (midDoorSensorNodes) {
    const active = midDoorSensorNodes;
    if (active.stopTimer) clearTimeout(active.stopTimer);
    try {
      active.gain.gain.cancelScheduledValues(t);
      active.gain.gain.setValueAtTime(Math.max(0.0001, active.gain.gain.value), t);
      active.gain.gain.linearRampToValueAtTime(0.068, t + 0.01);
      active.gain.gain.setValueAtTime(0.068, t + dur - 0.025);
      active.gain.gain.linearRampToValueAtTime(0.0001, t + dur);
      active.stopTimer = setTimeout(() => {
        if (midDoorSensorNodes !== active) return;
        midDoorSensorNodes = null;
        try {
          active.osc.stop();
        } catch {
          // ignore
        }
      }, Math.ceil((dur + 0.05) * 1000));
      return;
    } catch {
      stopMiddleDoorSensorBuzzer();
    }
  }
  const osc = ctx.createOscillator();
  const wave = getMidDoorSensorWave();
  if (wave) osc.setPeriodicWave(wave);
  else osc.type = "sawtooth";
  osc.frequency.value = 225.6;
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 160;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 3200;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(0.068, t + 0.01);
  gain.gain.setValueAtTime(0.068, t + dur - 0.025);
  gain.gain.linearRampToValueAtTime(0.0001, t + dur);
  osc.connect(highpass).connect(lowpass).connect(gain).connect(ctx.destination);
  const nodes = { osc, gain, stopTimer: null };
  nodes.stopTimer = setTimeout(() => {
    if (midDoorSensorNodes !== nodes) return;
    midDoorSensorNodes = null;
    try {
      osc.stop();
    } catch {
      // ignore
    }
  }, Math.ceil((dur + 0.05) * 1000));
  midDoorSensorNodes = nodes;
  osc.start(t);
}

let stopChimeWaveLo = null;
let stopChimeWaveHi = null;

function getStopChimeWaves() {
  if (!ctx) return null;
  if (!stopChimeWaveLo) {
    stopChimeWaveLo = ctx.createPeriodicWave(
      new Float32Array(8),
      new Float32Array([0, 1.0, 0, 0.052, 0, 0.095, 0, 0.095]),
    );
  }
  if (!stopChimeWaveHi) {
    stopChimeWaveHi = ctx.createPeriodicWave(
      new Float32Array(6),
      new Float32Array([0, 1.0, 0, 0.13, 0, 0.235]),
    );
  }
  return [stopChimeWaveLo, stopChimeWaveHi];
}

/** 降車ボタン「ピンポーン」 (PDG-AA273KAN 24:16.28 準拠: 916.3 Hz → 684.1 Hz 2点チャイム×2回) */
export function buzzer() {
  if (!ctx) return;
  const waves = getStopChimeWaves();
  if (!waves) return;
  const [waveLo, waveHi] = waves;
  const now = ctx.currentTime;

  const playNote = (freq, wave, offsetSec, dur, tau, peak) => {
    const t0 = now + offsetSec;
    const gateT = dur - 0.035;
    const decayVal = Math.max(0.0001, peak * Math.exp(-gateT / tau));

    const envGain = ctx.createGain();
    envGain.gain.setValueAtTime(0.0001, t0);
    envGain.gain.linearRampToValueAtTime(peak, t0 + 0.004);
    envGain.gain.exponentialRampToValueAtTime(decayVal, t0 + gateT);
    envGain.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    envGain.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.value = freq;
    osc.connect(envGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  };

  // 1回目: ピン (916.3 Hz) → +0.215s で ポーン (684.1 Hz)
  playNote(916.3, waveHi, 0.0, 0.8, 0.45, 0.075);
  playNote(684.1, waveLo, 0.215, 0.75, 0.42, 0.115);
  // 2回目 (0.865s 後)
  playNote(916.3, waveHi, 0.865, 0.8, 0.42, 0.075);
  playNote(684.1, waveLo, 1.08, 0.7, 0.38, 0.115);
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

/** 車内放送冒頭電子音 (D7 / 2352.5 Hz + 第2倍音 4705 Hz) */
export function announceIntroBeep() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.linearRampToValueAtTime(0.085, t + 0.008);
  master.gain.setValueAtTime(0.085, t + 0.095);
  master.gain.exponentialRampToValueAtTime(0.0001, t + 0.21);
  master.connect(ctx.destination);

  for (const [freq, ratio] of [
    [2352.5, 1.0],
    [4705.0, 0.47],
  ]) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = ratio;
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.22);
  }
}

/** 車内放送チャイムA (F#5 チューブラーベル / 732.0 Hz) */
export function announceChimeA() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const f0 = 732.0;
  const partials = [
    [f0, 0.13, 0.003, 2.4],
    [f0 * 2.0, 0.006, 0.003, 1.2],
    [f0 * 3.02, 0.026, 0.002, 0.35],
    [f0 * 5.76, 0.019, 0.002, 0.22],
  ];
  for (const [freq, peak, attack, decayEnd] of partials) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decayEnd);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + decayEnd + 0.03);
  }
}

/** 車内放送チャイムB (E5 → C#5 ビブラフォン 11.2 Hz トレモロ) */
export function announceChimeB() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const tremGain = ctx.createGain();
  tremGain.gain.value = 0.72;
  tremGain.connect(ctx.destination);

  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 11.2;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.28;
  lfo.connect(lfoDepth).connect(tremGain.gain);
  lfo.start(t);
  lfo.stop(t + 2.6);

  const playBar = (f0, offsetSec, peak, decay1Sec, decay4Sec) => {
    const t0 = t + offsetSec;
    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.value = f0;
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.0001, t0);
    g1.gain.linearRampToValueAtTime(peak, t0 + 0.004);
    g1.gain.exponentialRampToValueAtTime(0.0001, t0 + decay1Sec);
    osc1.connect(g1).connect(tremGain);
    osc1.start(t0);
    osc1.stop(t0 + decay1Sec + 0.03);

    const osc4 = ctx.createOscillator();
    osc4.type = "sine";
    osc4.frequency.value = f0 * 4.0;
    const g4 = ctx.createGain();
    g4.gain.setValueAtTime(0.0001, t0);
    g4.gain.linearRampToValueAtTime(peak * 0.18, t0 + 0.003);
    g4.gain.exponentialRampToValueAtTime(0.0001, t0 + decay4Sec);
    osc4.connect(g4).connect(tremGain);
    osc4.start(t0);
    osc4.stop(t0 + decay4Sec + 0.03);
  };

  playBar(659.25, 0, 0.14, 1.5, 0.85);
  playBar(554.37, 0.77, 0.14, 1.75, 0.95);
}
