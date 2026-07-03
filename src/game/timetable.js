import { CFG } from '../config.js';
import { route } from '../route/routeData.js';

/** 時刻表(早発チェック対象の主要停留所) */
const CHECKPOINT_NAMES = new Set([
  '二条駅西口', '四条大宮', '七条大宮・京都水族館前', '東寺南門前', '千本十条', '城南宮道', '久我',
]);

const START_DEPART = CFG.ops.startClock; // 始発 10:00:00 発
const S0 = route.stops[0].s; // 始発停留所の弧長(ここを 10:00:00 とする)

/** 各停留所の定刻(発車時刻) */
export const schedule = route.stops.map((stop, i) => ({
  name: stop.name,
  s: stop.s,
  time: Math.round(START_DEPART + (stop.s - S0) / CFG.ops.schedSpeed + i * CFG.ops.dwellPerStop),
  checkpoint: CHECKPOINT_NAMES.has(stop.name),
}));

/** 現在位置 s のダイヤ上の予定時刻(通過ベース) */
export function scheduledClockAt(s) {
  let dwell = 0;
  for (const st of schedule) {
    if (st.s < s) dwell += CFG.ops.dwellPerStop;
    else break;
  }
  return START_DEPART + Math.max(0, s - S0) / CFG.ops.schedSpeed + dwell;
}

/** 遅延 [s](正=遅れ) と HUD 表示 */
export function delayInfo(clock, s) {
  const d = Math.round(clock - scheduledClockAt(s));
  const abs = Math.abs(d);
  const mm = Math.floor(abs / 60);
  const ss = abs % 60;
  const t = `${mm}:${String(ss).padStart(2, '0')}`;
  if (d > 20) return { delay: d, text: `+${t} 遅れ`, kind: 'late' };
  if (d < -20) return { delay: d, text: `-${t} 早い`, kind: 'early' };
  return { delay: d, text: '定時', kind: 'ontime' };
}

export function fmtTime(sec) {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
