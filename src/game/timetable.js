const parseTime = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 3600 + m * 60;
};

/**
 * 停留所一覧と時刻表定義 JSON からダイヤランタイムを生成する。
 */
export function createTimetable(stops = [], timetableDef = {}) {
  const TIMES = timetableDef?.TIMES ?? {};

  /** 各停留所の定刻(発車時刻。終点は到着時刻)。全停留所で早発をチェックする */
  const schedule = stops.map((stop) => {
    const t = TIMES[stop.name];
    if (!t) console.warn(`[timetable] 時刻表に停留所がありません: ${stop.name}`);
    return {
      name: stop.name,
      s: stop.s,
      time: parseTime(t ?? "10:00"),
      checkpoint: true,
    };
  });

  const firstDepartTime = schedule[0]?.time ?? parseTime("10:00");

  /** 現在位置 s のダイヤ上の予定時刻(停留所間は s で線形補間) */
  function scheduledClockAt(s) {
    if (!schedule.length) return firstDepartTime;
    if (s <= schedule[0].s) return schedule[0].time;
    for (let i = 0; i < schedule.length - 1; i++) {
      const a = schedule[i];
      const b = schedule[i + 1];
      if (s <= b.s) return a.time + ((s - a.s) / Math.max(1e-6, b.s - a.s)) * (b.time - a.time);
    }
    return schedule[schedule.length - 1].time;
  }

  /** 遅延 [s](正=遅れ) と HUD 表示 */
  function delayInfo(clock, s) {
    const d = Math.round(clock - scheduledClockAt(s));
    const abs = Math.abs(d);
    const mm = Math.floor(abs / 60);
    const ss = abs % 60;
    const t = `${mm}:${String(ss).padStart(2, "0")}`;
    if (d > 20) return { delay: d, text: `+${t} 遅れ`, kind: "late" };
    if (d < -20) return { delay: d, text: `-${t} 早い`, kind: "early" };
    return { delay: d, text: "定時", kind: "ontime" };
  }

  return {
    schedule,
    firstDepartTime,
    scheduledClockAt,
    delayInfo,
  };
}

export function fmtTime(sec) {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
