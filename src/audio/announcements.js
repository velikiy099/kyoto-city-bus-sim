/** 車内アナウンス(Web Speech API・ja-JP がなければ既定音声で読み上げ) */
let jaVoice = null;
let available = false;
let currentUtterance = null;
let pendingTimer = null;
let lastCancelAt = -Infinity;

// Chrome では cancel() の処理が非同期で、直後(同一タスク内)に speak() すると
// その発話ごと破棄される。cancel 後はこの時間だけ speak を遅延させる。
const CANCEL_SETTLE_MS = 80;

export function initAnnouncements() {
  if (!('speechSynthesis' in window)) {
    console.info('[announce] speechSynthesis unavailable — silent mode');
    return;
  }
  available = true;
  speechSynthesis.resume?.();
  speechSynthesis.cancel();
  lastCancelAt = performance.now();
  const pick = () => {
    const voices = speechSynthesis.getVoices();
    jaVoice = voices.find((v) => v.lang?.startsWith('ja')) ?? null;
    if (!jaVoice) console.info('[announce] no ja voice — using default');
  };
  pick();
  speechSynthesis.onvoiceschanged = pick;
  setTimeout(pick, 250);
  setTimeout(pick, 1000);
}

function utter(text, retried = false) {
  try {
    speechSynthesis.resume?.();
    const u = new SpeechSynthesisUtterance(text);
    if (jaVoice) u.voice = jaVoice;
    u.lang = 'ja-JP';
    u.rate = 1.02;
    u.pitch = 1.05;
    u.volume = 0.9;
    u.onend = () => { if (currentUtterance === u) currentUtterance = null; };
    u.onerror = () => { if (currentUtterance === u) currentUtterance = null; };
    currentUtterance = u; // GC で発話が途切れないよう参照を保持
    speechSynthesis.speak(u);
    if (!retried) {
      // それでも発話が始まらなかった場合の保険(一度だけ再試行)
      setTimeout(() => {
        if (currentUtterance !== u) return;
        if (!speechSynthesis.speaking && !speechSynthesis.pending) utter(text, true);
      }, 600);
    }
  } catch {
    currentUtterance = null;
  }
}

function speak(text) {
  if (!available) return;
  try {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel(); // 新しい案内を優先(読み上げ中のものは打ち切り)
      lastCancelAt = performance.now();
    }
    const wait = CANCEL_SETTLE_MS - (performance.now() - lastCancelAt);
    if (wait > 0) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        utter(text);
      }, wait);
    } else {
      utter(text);
    }
  } catch {
    currentUtterance = null;
  }
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
