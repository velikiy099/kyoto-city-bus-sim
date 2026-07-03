/** WebAudio 生成 SFX(外部音源なし) */
let ctx = null;
let engine = null;

/** ユーザー操作後に呼ぶ(スタートボタン) */
export function initAudio() {
  if (ctx) return;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    console.info('[sfx] AudioContext unavailable — silent mode');
    return;
  }

  // エンジン音: ローパスノイズ + 低音のこぎり波
  const bufLen = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 120;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  noise.connect(noiseFilter).connect(noiseGain).connect(ctx.destination);
  noise.start();

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 42;
  const oscGain = ctx.createGain();
  oscGain.gain.value = 0;
  const oscFilter = ctx.createBiquadFilter();
  oscFilter.type = 'lowpass';
  oscFilter.frequency.value = 220;
  osc.connect(oscFilter).connect(oscGain).connect(ctx.destination);
  osc.start();

  engine = { osc, oscGain, noiseGain, noiseFilter };
}

/** 毎フレーム: 速度・アクセルに応じたエンジン音 */
export function updateEngine(vKmh, throttle) {
  if (!engine) return;
  const load = Math.min(1, Math.abs(vKmh) / 50);
  engine.osc.frequency.value = 40 + load * 65 + throttle * 14;
  engine.oscGain.gain.value = 0.035 + load * 0.045 + throttle * 0.02;
  engine.noiseGain.gain.value = 0.015 + load * 0.05;
  engine.noiseFilter.frequency.value = 100 + load * 420;
}

function blip(freq, dur, type = 'sine', gain = 0.12, when = 0) {
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
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = 1800;
  const g = ctx.createGain();
  g.gain.value = 0.16;
  src.connect(f).connect(g).connect(ctx.destination);
  src.start();
}

/** 降車ボタン「ピンポーン」 */
export function buzzer() {
  blip(988, 0.28, 'sine', 0.14);
  blip(784, 0.5, 'sine', 0.14, 0.22);
}

/** 運賃箱「チャリン」 */
export function coin() {
  blip(2600, 0.09, 'square', 0.05);
  blip(3400, 0.16, 'sine', 0.07, 0.05);
}

/** 正着チャイム */
export function ding() {
  blip(1319, 0.16, 'sine', 0.1);
  blip(1760, 0.4, 'sine', 0.1, 0.13);
}
