/** 車内アナウンス(Web Speech API・チャイム/英語/男声対応シーケンサ) */
import {
  announceIntroBeep,
  announceChimeA,
  announceChimeB,
} from "./sfx.js";

const MALE_VOICE_PRIORITY = [
  /otoya/i,
  /keita/i,
  /ichiro/i,
  /hattori/i,
  /takumi/i,
  /daichi/i,
  /naoki/i,
  /shinji/i,
  /show/i,
  /eddy|reed|rocko/i,
  /\bmale\b/i,
];

const EN_VOICE_PRIORITY = [
  /samantha|victoria|allison|ava|karen|zira|aria|jenny|google us english/i,
];

const CHIME_DURATIONS_MS = {
  intro: 280,
  chimeA: 1050,
  chimeB: 1550,
};

// Chrome では cancel() の処理が非同期で、直後(同一タスク内)に speak() すると
// その発話ごと破棄される。cancel 後はこの時間だけ speak を遅延させる。
const CANCEL_SETTLE_MS = 80;

const isMaleVoiceName = (voice) =>
  MALE_VOICE_PRIORITY.some((re) => re.test(voice?.name ?? ""));

function triggerChime(kind) {
  if (kind === "intro") announceIntroBeep();
  else if (kind === "chimeA") announceChimeA();
  else if (kind === "chimeB") announceChimeB();
}

export function createAnnouncements(copy = {}) {
  const announcementCopy = copy ?? {};
  let jaVoice = null;
  let jaMaleVoice = null;
  let enVoice = null;
  let available = false;
  let currentUtterance = null;
  let currentTag = null;
  let activeSequence = false;
  let seqToken = 0;
  let pendingTimer = null;
  let stepTimer = null;
  let retryTimer = null;
  let lastCancelAt = -Infinity;
  let queuedSequence = null; // 発話中に来た「割り込まず後で流す」シーケンス(最新1件のみ保持)

  function init() {
    if (!("speechSynthesis" in window)) {
      console.info("[announce] speechSynthesis unavailable — silent mode");
      return;
    }
    available = true;
    speechSynthesis.resume?.();
    speechSynthesis.cancel();
    lastCancelAt = performance.now();
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      const jaVoices = voices.filter((v) => v.lang?.startsWith("ja"));
      jaVoice =
        jaVoices.find((v) => !isMaleVoiceName(v)) ?? jaVoices[0] ?? null;
      jaMaleVoice = null;
      for (const re of MALE_VOICE_PRIORITY) {
        const hit = jaVoices.find((v) => re.test(v.name ?? ""));
        if (hit) {
          jaMaleVoice = hit;
          break;
        }
      }
      const enVoices = voices.filter((v) => v.lang?.startsWith("en"));
      enVoice = null;
      for (const re of EN_VOICE_PRIORITY) {
        const hit = enVoices.find((v) => re.test(v.name ?? ""));
        if (hit) {
          enVoice = hit;
          break;
        }
      }
      if (!enVoice) {
        enVoice =
          enVoices.find((v) => v.lang?.startsWith("en-US")) ??
          enVoices[0] ??
          null;
      }
      if (!jaVoice) console.info("[announce] no ja voice — using default");
    };
    pick();
    speechSynthesis.onvoiceschanged = pick;
    setTimeout(pick, 250);
    setTimeout(pick, 1000);
  }

  function runSequenceStep(steps, idx, token, retried = false) {
    if (token !== seqToken) return;
    if (idx >= steps.length) {
      activeSequence = false;
      currentTag = null;
      currentUtterance = null;
      if (queuedSequence != null) {
        const next = queuedSequence;
        queuedSequence = null;
        playSequence(next.steps, { tag: next.tag });
      }
      return;
    }

    const step = steps[idx];
    if (step.type === "chime") {
      triggerChime(step.kind);
      const waitMs = CHIME_DURATIONS_MS[step.kind] ?? 300;
      stepTimer = setTimeout(() => {
        stepTimer = null;
        runSequenceStep(steps, idx + 1, token);
      }, waitMs);
      return;
    }

    if (!available) {
      runSequenceStep(steps, idx + 1, token);
      return;
    }

    try {
      speechSynthesis.resume?.();
      const u = new SpeechSynthesisUtterance(step.text);
      if (step.lang === "en") {
        u.lang = "en-US";
        if (enVoice) u.voice = enVoice;
        u.rate = step.rate ?? 0.96;
        u.pitch = step.pitch ?? 1.02;
        u.volume = step.volume ?? 0.9;
      } else if (step.male) {
        u.lang = "ja-JP";
        const chosen = jaMaleVoice ?? jaVoice;
        if (chosen) u.voice = chosen;
        u.rate = step.rate ?? 1.02;
        u.pitch = jaMaleVoice ? (step.pitch ?? 0.95) : 0.72;
        u.volume = step.volume ?? 0.92;
      } else {
        u.lang = "ja-JP";
        if (jaVoice) u.voice = jaVoice;
        u.rate = step.rate ?? 1.02;
        u.pitch = step.pitch ?? 1.05;
        u.volume = step.volume ?? 0.9;
      }

      const onDone = () => {
        if (token !== seqToken || currentUtterance !== u) return;
        currentUtterance = null;
        clearTimeout(retryTimer);
        retryTimer = null;
        const nextStep = steps[idx + 1];
        if (nextStep?.type === "speak") {
          stepTimer = setTimeout(() => {
            stepTimer = null;
            runSequenceStep(steps, idx + 1, token);
          }, 180);
        } else {
          runSequenceStep(steps, idx + 1, token);
        }
      };
      u.onend = onDone;
      u.onerror = onDone;
      currentUtterance = u; // GC で発話が途切れないよう参照を保持
      speechSynthesis.speak(u);

      if (!retried) {
        // それでも発話が始まらなかった場合の保険(一度だけ再試行)
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (token !== seqToken || currentUtterance !== u) return;
          if (!speechSynthesis.speaking && !speechSynthesis.pending) {
            currentUtterance = null;
            runSequenceStep(steps, idx, token, true);
          }
        }, 600);
      }
    } catch {
      currentUtterance = null;
      runSequenceStep(steps, idx + 1, token);
    }
  }

  function playSequence(
    steps,
    { tag = null, queueIfBusy = false, queueIfDoorClose = false } = {},
  ) {
    if (!steps?.length) return;
    if (!available && !steps.some((s) => s.type === "chime")) return;
    try {
      const busy = Boolean(
        activeSequence ||
          currentUtterance ||
          (available && (speechSynthesis.speaking || speechSynthesis.pending)),
      );
      if (
        busy &&
        (queueIfBusy || (queueIfDoorClose && currentTag === "doorClose"))
      ) {
        queuedSequence = { steps, tag };
        return;
      }
      seqToken++;
      const token = seqToken;
      queuedSequence = null;
      currentUtterance = null;
      clearTimeout(pendingTimer);
      pendingTimer = null;
      clearTimeout(stepTimer);
      stepTimer = null;
      clearTimeout(retryTimer);
      retryTimer = null;

      if (available && (speechSynthesis.speaking || speechSynthesis.pending)) {
        speechSynthesis.cancel(); // 新しい案内を優先(読み上げ中のものは打ち切り)
        lastCancelAt = performance.now();
      }

      activeSequence = true;
      currentTag = tag;
      const hasSpeak = steps.some((s) => s.type === "speak");
      const wait =
        available && hasSpeak
          ? CANCEL_SETTLE_MS - (performance.now() - lastCancelAt)
          : 0;
      if (wait > 0) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          runSequenceStep(steps, 0, token);
        }, wait);
      } else {
        runSequenceStep(steps, 0, token);
      }
    } catch {
      activeSequence = false;
      currentTag = null;
      currentUtterance = null;
    }
  }

  return {
    init,
    announceNext(stopName) {
      const normalized = stopName?.replaceAll("ヶ", "ケ");
      const script =
        announcementCopy.stops?.[stopName] ??
        announcementCopy.stops?.[normalized] ??
        (announcementCopy.next
          ? [
              {
                type: "speak",
                text: announcementCopy.next.replaceAll("{stop}", stopName),
              },
            ]
          : []);
      playSequence([{ type: "chime", kind: "intro" }, ...script], {
        tag: "next",
        queueIfDoorClose: true,
      });
    },
    /** 降車ボタン押下相当(次停に降車客がいて接近した)時のアナウンス。
     * 「次は、〇〇です」発話中に鳴った場合は、その発話が終わるまで割り込まず待つ。 */
    announceStopping() {
      if (!announcementCopy.stopping) return;
      playSequence([{ type: "speak", text: announcementCopy.stopping }], {
        tag: "stopping",
        queueIfBusy: true,
      });
    },
    announceTerminal() {
      if (!announcementCopy.terminal) return;
      playSequence(
        [
          { type: "chime", kind: "intro" },
          { type: "speak", text: announcementCopy.terminal },
        ],
        { tag: "terminal" },
      );
    },
    announceStart() {
      if (!announcementCopy.start) return;
      playSequence(
        [
          { type: "chime", kind: "intro" },
          { type: "speak", text: announcementCopy.start },
        ],
        { tag: "start" },
      );
    },
    /** 閉扉時の自動アナウンス(男声ボイス優先・1.5倍速、未導入環境では低ピッチで代用) */
    announceDoorClose() {
      if (!announcementCopy.doorClose) return;
      playSequence(
        [
          {
            type: "speak",
            text: announcementCopy.doorClose,
            male: true,
            rate: 1.5,
            volume: 0.95,
          },
        ],
        { tag: "doorClose" },
      );
    },
  };
}
