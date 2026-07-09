import { route } from "../route/routeData.js";

/** 時刻表(早発チェック対象の主要停留所) */
const CHECKPOINT_NAMES = new Set([
  "二条駅西口",
  "四条大宮",
  "七条大宮・京都水族館前",
  "東寺南門前",
  "千本十条",
  "城南宮道",
  "久我",
]);

/** 固定時刻表(9:56 二条駅西口発 → 10:44 久我石原町着)。上鳥羽村山町は南行き通過のため対象外 */
const TIMES = {
  二条駅西口: "9:56",
  二条駅前: "9:59",
  "千本三条・朱雀立命館前": "10:00",
  みぶ操車場前: "10:02",
  四条大宮: "10:04",
  大宮松原: "10:06",
  大宮五条: "10:08",
  島原口: "10:10",
  "七条大宮・京都水族館前": "10:12",
  東寺東門前: "10:15",
  九条大宮: "10:17",
  東寺南門前: "10:20",
  羅城門: "10:21",
  唐戸町: "10:22",
  千本十条: "10:24",
  五丁橋: "10:25",
  上ノ町: "10:27",
  上鳥羽小学校前: "10:28",
  城ケ前町: "10:29",
  岩ノ本町: "10:30",
  地蔵前: "10:31",
  奈須野: "10:32",
  小枝橋: "10:33",
  城南宮道: "10:35",
  赤池: "10:37",
  上鳥羽塔ノ森: "10:39",
  久我: "10:41",
  菱妻神社前: "10:42",
  久我石原町: "10:44",
};

const parseTime = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 3600 + m * 60;
};

/** 各停留所の定刻(発車時刻。終点は到着時刻) */
export const schedule = route.stops.map((stop) => {
  const t = TIMES[stop.name];
  if (!t) console.warn(`[timetable] 時刻表に停留所がありません: ${stop.name}`);
  return {
    name: stop.name,
    s: stop.s,
    time: parseTime(t ?? "10:00"),
    checkpoint: CHECKPOINT_NAMES.has(stop.name),
  };
});

/** 始発の発車時刻(9:56:00) */
export const firstDepartTime = schedule[0].time;

/** 現在位置 s のダイヤ上の予定時刻(停留所間は s で線形補間) */
export function scheduledClockAt(s) {
  if (s <= schedule[0].s) return schedule[0].time;
  for (let i = 0; i < schedule.length - 1; i++) {
    const a = schedule[i];
    const b = schedule[i + 1];
    if (s <= b.s) return a.time + ((s - a.s) / (b.s - a.s)) * (b.time - a.time);
  }
  return schedule[schedule.length - 1].time;
}

/** 遅延 [s](正=遅れ) と HUD 表示 */
export function delayInfo(clock, s) {
  const d = Math.round(clock - scheduledClockAt(s));
  const abs = Math.abs(d);
  const mm = Math.floor(abs / 60);
  const ss = abs % 60;
  const t = `${mm}:${String(ss).padStart(2, "0")}`;
  if (d > 20) return { delay: d, text: `+${t} 遅れ`, kind: "late" };
  if (d < -20) return { delay: d, text: `-${t} 早い`, kind: "early" };
  return { delay: d, text: "定時", kind: "ontime" };
}

export function fmtTime(sec) {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
