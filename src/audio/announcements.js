/** 車内アナウンス(Web Speech API・ja-JP がなければ既定音声で読み上げ) */
let jaVoice = null;
let available = false;
let currentUtterance = null;

export function initAnnouncements() {
  if (!('speechSynthesis' in window)) {
    console.info('[announce] speechSynthesis unavailable — silent mode');
    return;
  }
  available = true;
  speechSynthesis.resume?.();
  speechSynthesis.cancel();
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

function speak(text) {
  if (!available) return;
  try {
    speechSynthesis.resume?.();
    const u = new SpeechSynthesisUtterance(text);
    if (jaVoice) u.voice = jaVoice;
    u.lang = 'ja-JP';
    u.rate = 1.02;
    u.pitch = 1.05;
    u.volume = 0.9;
    u.onend = () => { currentUtterance = null; };
    u.onerror = () => { currentUtterance = null; };
    currentUtterance = u;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
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
