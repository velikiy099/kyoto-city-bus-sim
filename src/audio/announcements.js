/** 車内アナウンス(Web Speech API・ja-JP がなければ既定音声で読み上げ) */
let jaVoice = null;
let available = false;
let speaking = false;
const queue = [];

export function initAnnouncements() {
  if (!('speechSynthesis' in window)) {
    console.info('[announce] speechSynthesis unavailable — silent mode');
    return;
  }
  available = true;
  speechSynthesis.resume?.();
  const pick = () => {
    const voices = speechSynthesis.getVoices();
    jaVoice = voices.find((v) => v.lang?.startsWith('ja')) ?? null;
    if (!jaVoice) console.info('[announce] no ja voice — using default');
    pump();
  };
  pick();
  speechSynthesis.onvoiceschanged = pick;
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
    u.onend = () => {
      speaking = false;
      pump();
    };
    u.onerror = () => {
      speaking = false;
      pump();
    };
    speechSynthesis.speak(u);
  } catch {
    speaking = false;
  }
}

function speak(text) {
  if (!available) return;
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

export function announceDepart() {
  speak('発車します。ご注意ください。');
}
