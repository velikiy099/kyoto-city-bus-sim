/** 車内アナウンス(Web Speech API・ja-JP がなければ既定音声で読み上げ) */
let jaVoice = null;
let available = false;
let speaking = false;
let currentUtterance = null;
let fallbackCtx = null;
const queue = [];

export function initAnnouncements() {
  try {
    fallbackCtx = fallbackCtx ?? new (window.AudioContext || window.webkitAudioContext)();
    fallbackCtx.resume?.();
  } catch {
    fallbackCtx = null;
  }
  if (!('speechSynthesis' in window)) {
    console.info('[announce] speechSynthesis unavailable — chime fallback');
    return;
  }
  available = true;
  speechSynthesis.resume?.();
  speechSynthesis.cancel();
  const pick = () => {
    const voices = speechSynthesis.getVoices();
    jaVoice = voices.find((v) => v.lang?.startsWith('ja')) ?? null;
    if (!jaVoice) console.info('[announce] no ja voice — using default');
    pump();
  };
  pick();
  speechSynthesis.onvoiceschanged = pick;
  setTimeout(pick, 250);
  setTimeout(pick, 1000);
}

function fallbackChime() {
  if (!fallbackCtx) return;
  const blip = (freq, start, dur, gainValue) => {
    const t = fallbackCtx.currentTime + start;
    const osc = fallbackCtx.createOscillator();
    const gain = fallbackCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(gainValue, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(fallbackCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.04);
  };
  blip(880, 0, 0.18, 0.09);
  blip(1175, 0.2, 0.28, 0.08);
}

function pump() {
  if (!available || speaking || queue.length === 0) return;
  try {
    speechSynthesis.resume?.();
    const text = queue.shift();
    const u = new SpeechSynthesisUtterance(text);
    if (jaVoice) u.voice = jaVoice;
    u.lang = 'ja-JP';
    u.rate = 1.02;
    u.pitch = 1.05;
    u.volume = 0.9;
    speaking = true;
    u.onerror = () => {
      speaking = false;
      currentUtterance = null;
      fallbackChime();
      pump();
    };
    u.onend = () => {
      speaking = false;
      currentUtterance = null;
      pump();
    };
    currentUtterance = u;
    speechSynthesis.speak(u);
    setTimeout(() => {
      if (!speaking || currentUtterance !== u) return;
      if (!speechSynthesis.speaking && !speechSynthesis.pending) {
        speaking = false;
        currentUtterance = null;
        fallbackChime();
        pump();
      }
    }, 900);
  } catch {
    speaking = false;
    currentUtterance = null;
    fallbackChime();
  }
}

function speak(text) {
  fallbackCtx?.resume?.();
  if (!available) {
    fallbackChime();
    return;
  }
  if (queue.at(-1) !== text) queue.push(text);
  if (queue.length > 3) queue.splice(0, queue.length - 3);
  pump();
}

export function announceNext(stopName) {
  speak(`次は、${stopName}、${stopName}です。`);
}

export function announceApproach(stopName) {
  speak(`まもなく、${stopName}です。お降りの方は、お近くの降車ボタンを押してください。`);
}

export function announceTerminal() {
  speak('久我石原町、終点です。本日は京都市バスをご利用いただき、ありがとうございました。');
}

export function announceStart() {
  speak('乗務を開始します。');
}

export function announceDepart() {
  speak('発車します。ご注意ください。');
}
