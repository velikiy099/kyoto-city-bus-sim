/** 車内アナウンス(Web Speech API・ja-JP がなければ既定音声で読み上げ) */
let jaVoice = null;
let available = false;
let currentUtterance = null;
let pendingTimer = null;
let lastCancelAt = -Infinity;
let queued = null; // 発話中に来た「割り込まず後で流す」アナウンス(最新の1件のみ保持)

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
    const onDone = () => {
      if (currentUtterance !== u) return;
      currentUtterance = null;
      if (queued != null) {
        const next = queued;
        queued = null;
        utter(next);
      }
    };
    u.onend = onDone;
    u.onerror = onDone;
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

function speak(text, { queueIfBusy = false } = {}) {
  if (!available) return;
  try {
    // 発話中/待機中で、割り込ませたくない場合はキューに積んで終了を待つ(最新の1件のみ保持)
    if (queueIfBusy && (currentUtterance || speechSynthesis.speaking || speechSynthesis.pending)) {
      queued = text;
      return;
    }
    queued = null;
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

/** 降車ボタン押下相当(次停に降車客がいて接近した)時のアナウンス。
 * 「次は、〇〇です」発話中に鳴った場合は、その発話が終わるまで割り込まず待つ。 */
export function announceStopping() {
  speak('次止まります。危険ですのでバスが停車してから席をお立ちください。', { queueIfBusy: true });
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
