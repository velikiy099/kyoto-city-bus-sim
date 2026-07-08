#!/usr/bin/env node
/**
 * 京都市バス18号系統 路線データ生成スクリプト
 *
 * OpenStreetMap の18号系統リレーション(id 13027168, 北行き: 久我石原町→二条駅西口)を
 * Overpass API から取得し、南行き(二条駅西口→久我石原町)のゲーム用経路データ
 * src/data/route18.json を生成する。
 *
 * 上鳥羽地区の一方通行区間(小枝橋〜上鳥羽塔ノ森)は南北で走る道が異なるため、
 * 南行きの実経路(千本通: 城南宮道・赤池停留所前)の way 形状で差し替える。
 *
 * 使い方:
 *   node tools/build-route-data.mjs             キャッシュ→なければOverpass取得
 *   node tools/build-route-data.mjs --fallback  ネット不通時: 内蔵実座標(停留所直結)で生成
 *
 * データ出典: © OpenStreetMap contributors (ODbL) — relation 13027168
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'tools', 'cache');
const OUT = join(ROOT, 'src', 'data', 'route18.json');
const RELATION_ID = 13027168;
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// 距離スケール: 実距離に乗算。1.0 で OSM 実距離どおり。
const SCALE = 1.0;
const RESAMPLE_STEP = 2;      // 最終ポリラインの点間隔 [m]
const FILLET_RADIUS = 18;     // 緩い折れの円弧半径 [m]
const FILLET_MIN_ANGLE = 25;  // この角度[deg]を超える折れをフィレット化
const TURN_MIN_ANGLE = 55;    // この角度[deg]以上の折れは「右左折交差点」扱い(小半径+交差描画)
const TURN_FILLET_RADIUS = 12; // 交差点内でバスが曲がる現実的な回転半径 [m]
const ROAD_AROUND_RADIUS = 90; // route node 周辺から接続道路を拾う距離 [m]
const BUILDING_AROUND_RADIUS = 95; // route node 周辺から沿道建物を拾う距離 [m]
const BUILDING_BIN_SIZE = 120;
const BUILDINGS_PER_BIN = 15;
const MAX_BUILDINGS = 1400;
const RAILWAY_BBOX = [34.982, 135.744, 34.9895, 135.752]; // 七条大宮〜東寺東門前のJR線群
const ROAD_TYPES = ['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service'];

// 南行きの公式停留所順(京都市交通局 時刻表より、城南宮道経由・全区間便)
const STOP_ORDER = [
  '二条駅西口', '二条駅前', '千本三条・朱雀立命館前', 'みぶ操車場前', '四条大宮',
  '大宮松原', '大宮五条', '島原口', '七条大宮・京都水族館前', '東寺東門前',
  '九条大宮', '東寺南門前', '羅城門', '唐戸町', '千本十条',
  '五丁橋', '上ノ町', '上鳥羽村山町', '上鳥羽小学校前', '城ケ前町',
  '岩ノ本町', '地蔵前', '奈須野', '小枝橋', '城南宮道',
  '赤池', '上鳥羽塔ノ森', '久我', '菱妻神社前', '久我石原町',
];
// OSM表記 → 公式表記のゆれ吸収
const NAME_ALIAS = { '城ヶ前町': '城ケ前町' };

// 北行きリレーションに含まれない南行き専用停留所(OSM実測座標)
const EXTRA_STOPS = {
  '城南宮道': [34.9501719, 135.7431768], // node 8955892662
  '赤池': [34.9473836, 135.7430396],     // node 8955892665
};

// 南行きと北行きで停車位置(道)が異なる停留所: 南行きプラットフォームのOSM実測座標で上書き
const SOUTHBOUND_STOP_OVERRIDES = {
  '千本十条': [34.973279, 135.7422175],       // node 8955892643(十条通 南側)
  '五丁橋': [34.9705886, 135.7426048],        // node 8955892645(旧千本通)
  '上ノ町': [34.9673125, 135.7425638],        // node 8955892647(旧千本通)
  '上鳥羽村山町': [34.96565, 135.74247],      // 北行きのみ停車。データ整合のため旧千本通上へ射影
  '上鳥羽小学校前': [34.9643776, 135.7424912], // node 8955892650
  '地蔵前': [34.9585329, 135.7430509],        // node 8955892656(一方通行南行き側)
  '奈須野': [34.9561146, 135.7425598],        // node 8955892658(一方通行南行き側)
  '小枝橋': [34.9540361, 135.7415567],        // node 8955892661
};

// 南行き専用区間1(十条新千本→十条通を東進→十条旧千本→旧千本通を南進)
// 北行きは新千本通を通るため、南行きの実経路を way 実形状で差し替える。
// way ID を南行きの通過順に列挙(向きは連結時に自動判定)
const JUJO_WAY_IDS = [
  968070106, // 十条通り: 新千本通交点 → 東
  968070105, // 十条通り: → 旧千本通交点(十条旧千本)
  27211283,  // 千本通(旧): 十条旧千本 → 南(一方通行)
  1061759843, // 千本通: → 中山稲荷線(府道201)
  968070098, // 千本通: 府道201 → 南(2車線・センターラインなし)
  63124503,  // 千本通: → 地蔵前手前交差点
  116803173, // 千本通: 一方通行区間(地蔵前手前 → 34.9554 の合流部)
];
const JUJO_FROM = [34.9736, 135.7414];  // 差し替え開始: 新千本通・十条通の手前
const JUJO_TO = [34.9554039, 135.7421815]; // 差し替え終了: 一方通行南端の合流点

// 南行き専用区間(小枝橋→上鳥羽塔ノ森): 千本通の実 way 形状
// way 621847400(逆順) + way 217638202(逆順) + 交差点接続
const DETOUR_SOUTHBOUND = [
  [34.95280, 135.74240],   // 小枝橋から城南宮道への接続部
  [34.951343, 135.742935], // 以下 way 621847400 逆順
  [34.9512693, 135.7429352],
  [34.9512193, 135.7429323],
  [34.9506648, 135.7427628],
  [34.950623, 135.7428108],
  [34.9505492, 135.7431534], // 以下 way 217638202 逆順(城南宮道・赤池停留所前)
  [34.9502205, 135.7431418],
  [34.9496474, 135.7431262],
  [34.9494315, 135.7431173],
  [34.9492009, 135.7431116],
  [34.9489446, 135.7430965],
  [34.9488022, 135.7430901],
  [34.94768, 135.7430038],
  [34.9474363, 135.7429903],
  [34.9472233, 135.7429758],
  [34.9468287, 135.7429606],
  [34.946756, 135.7429658],
  [34.9465764, 135.7429866],
  [34.9464497, 135.7430095], // 赤池交差点
  [34.94655, 135.74200],     // 西進して上鳥羽塔ノ森へ
  [34.94670, 135.73950],
];
const DETOUR_FROM = [34.9543, 135.7417]; // 差し替え開始: 小枝橋停留所付近
const DETOUR_TO = [34.94648, 135.73915]; // 差し替え終了: 塔ノ森南の合流点

// 橋(名称, 実座標アンカー, 実長[m]) — s値はスクリプトが経路射影で算出
const BRIDGES = [
  { name: '小枝橋(鴨川)', anchor: [34.9553, 135.7420], realLength: 60 },
  { name: '久我橋(桂川)', anchor: [34.9459, 135.7358], realLength: 340 },
];

// 制限速度ゾーン(停留所名アンカー、[km/h])
const SPEED_ZONES = [
  { fromStop: null, toStop: '九条大宮', limit: 40 },        // 市街地
  { fromStop: '九条大宮', toStop: '羅城門', limit: 50 },     // 九条通
  { fromStop: '羅城門', toStop: '赤池', limit: 40 },         // 千本通・鳥羽街道
  { fromStop: '赤池', toStop: '久我', limit: 50 },           // 久我橋区間
  { fromStop: '久我', toStop: null, limit: 40 },             // 久我地区
];

// ---------------- 車線プラン(実走調査による手動定義) ----------------
// 南行き=F(バス進行方向)、北行き=B。B=0 は一方通行。center:'none' はセンターラインなし。
// to: 区間終端の実座標アンカー。null は路線終端まで。区間はルート順。
const LANE_PLAN = [
  { to: '三条通', F: 2, B: 2, name: '千本通(三条以北)' },
  { to: '四条通', F: 1, B: 1, name: '千本通・後院通(三条〜四条大宮)' },
  { to: '七条通', F: 2, B: 2, name: '大宮通(四条〜七条)' },
  { to: [34.97938, 135.74931], F: 3, B: 3, name: '大宮通(七条〜九条・跨線橋)' },
  { to: [34.97880, 135.74145], F: 2, B: 2, name: '九条通' },
  { to: [34.97340, 135.74140], F: 1, B: 1, name: '新千本通' },
  { to: [34.97335, 135.74254], F: 2, B: 2, name: '十条通' },
  { to: [34.96477, 135.74247], F: 1, B: 0, name: '旧千本通(十条旧千本〜府道201・一方通行)' },
  { to: [34.95866, 135.74266], F: 1, B: 1, center: 'none', name: '旧千本通(府道201〜地蔵前手前)' },
  { to: [34.95540, 135.74218], F: 1, B: 0, name: '旧千本通(地蔵前手前〜合流・一方通行)' },
  { to: [34.95066, 135.74276], F: 1, B: 1, center: 'none', name: '鳥羽街道(〜羽束師墨染線)' },
  { to: [34.95055, 135.74315], F: 2, B: 2, name: '羽束師墨染線(ジョグ)' },
  { to: [34.94645, 135.74301], F: 1, B: 1, name: '城南宮道通り(〜赤池)' },
  { to: null, F: 1, B: 1, name: '府道202(赤池〜久我石原町)' },
];
const LANE_W = 3.2; // 1車線幅 [m]

// 右折車線ゾーン: 範囲内の信号交差点の進入方向に+1車線(千本通北部=計5、府道202=計3 等)
const APPROACH_ZONES = [
  { from: [35.01170, 135.74250], to: '三条通', len: 65, name: '千本三条以北' },
  { from: [34.97938, 135.74931], to: [34.97880, 135.74145], len: 65, name: '九条通' },
  { from: [34.94645, 135.74301], to: [34.94570, 135.73270], len: 55, name: '府道202(久我以東)' },
];

// 交差道路の実勢オーバーライド(交差点スタブの幅・車線数を交通量調査どおりに)
const INTERSECTION_OVERRIDES = [
  { name: '四条通', lanes: 5, width: 17.6 },                                // 片道2+右折で計5
  { name: '五条大宮', label: '五条通', lanes: 9, width: 30.8, median: 1 },   // 片道4+中央分離帯、交差点付近計9
  { name: '七条通', lanes: 4, width: 14.4 },                                // 片道2
  { name: '壬生通', label: '京阪国道口(国道1号)', lanes: 5, width: 17.6 },  // 北行1+南行2+右折で計5
];

// 右左折交差点の脚オーバーライド(vertex 近傍の実座標でマッチ)
const TURN_OVERRIDES = [
  { anchor: [34.97938, 135.74931], stubInHw: 4.0, crossWidth: 8.0, crossLanes: 2 }, // 九条大宮: 大宮通(九条以南)は片道1
  { anchor: [34.95066, 135.74276], crossWidth: 17.6, crossLanes: 5 }, // 羽束師墨染線(西側)片道2+右折
  { anchor: [34.95055, 135.74315], crossWidth: 17.6, crossLanes: 5 }, // 羽束師墨染線(南側)
];

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Overpass はレート制限(429)が頻発するためミラー横断+バックオフで再試行する
async function fetchJson(_url, body) {
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'cc-sample-game-route-builder/0.1 (OpenStreetMap data refresh)',
        },
        body: body ? new URLSearchParams({ data: body }) : undefined,
      });
      if (res.ok) return res.json();
      const text = await res.text().catch(() => '');
      lastErr = new Error(`HTTP ${res.status} for ${url}${text ? `: ${text.slice(0, 300)}` : ''}`);
      if (res.status !== 429 && res.status !== 504) throw lastErr;
    } catch (e) {
      lastErr = e;
    }
    const wait = 8000 * (attempt + 1);
    console.log(`  retry in ${wait / 1000}s (${lastErr.message.slice(0, 80)})`);
    await sleep(wait);
  }
  throw lastErr;
}

function loadCachedOrFetch(file, query) {
  const path = join(CACHE, file);
  if (existsSync(path)) {
    console.log(`  cache hit: tools/cache/${file}`);
    return Promise.resolve(JSON.parse(readFileSync(path, 'utf8')));
  }
  console.log(`  fetching from Overpass: ${file} ...`);
  return fetchJson(null, query).then((data) => {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(path, JSON.stringify(data));
    return data;
  });
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const parsePositive = (v) => {
  const n = Number(String(v ?? '').match(/\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const laneCount = (tags = {}) => {
  const lanes = parsePositive(tags.lanes);
  if (lanes) return lanes;
  const forward = parsePositive(tags['lanes:forward']);
  const backward = parsePositive(tags['lanes:backward']);
  if (forward || backward) return (forward ?? 1) + (backward ?? 1);
  if (tags.oneway === 'yes') return 1;
  return 2;
};
const roadWidth = (tags = {}) => parsePositive(tags.width) ?? laneCount(tags) * 3.2 + 1.6;
const isMajorRoad = (tags = {}) => {
  if (!ROAD_TYPES.includes(tags.highway ?? '')) return false;
  return !['driveway', 'parking_aisle', 'drive-through', 'alley'].includes(tags.service ?? '');
};
const rand01 = (seed) => {
  let x = Math.imul((Number(seed) || 1) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

// way群(端点共有)を1本のポリラインに連結する
function connectWays(ways) {
  const segs = ways.map((w) => w.geometry.map((p) => [p.lat, p.lon]));
  let line = [...segs[0]];
  const used = new Set([0]);
  const EPS = 1e-13; // 座標一致判定(同一ノード共有なのでほぼ厳密一致)
  let progress = true;
  while (used.size < segs.length && progress) {
    progress = false;
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue;
      const s = segs[i];
      if (dist2(line.at(-1), s[0]) < EPS) line = line.concat(s.slice(1));
      else if (dist2(line.at(-1), s.at(-1)) < EPS) line = line.concat([...s].reverse().slice(1));
      else if (dist2(line[0], s.at(-1)) < EPS) line = s.slice(0, -1).concat(line);
      else if (dist2(line[0], s[0]) < EPS) line = [...s].reverse().slice(0, -1).concat(line);
      else continue;
      used.add(i);
      progress = true;
      break;
    }
  }
  if (used.size !== segs.length) {
    throw new Error(`way連結失敗: ${used.size}/${segs.length} 本のみ連結`);
  }
  return line;
}

/** way を指定順に連結(各 way の向きは前の終端との距離で自動判定) */
function chainOrderedWays(ways, entry) {
  let line = [];
  let cursor = entry;
  for (const w of ways) {
    let seg = w.geometry.map((p) => [p.lat, p.lon]);
    if (dist2(seg.at(-1), cursor) < dist2(seg[0], cursor)) seg = [...seg].reverse();
    line = line.concat(line.length ? seg.slice(1) : seg);
    cursor = line.at(-1);
  }
  return line;
}

/** line の from〜to 区間を detour で差し替える */
function spliceDetour(line, detour, from, to, label) {
  const iFrom = nearestIndex(line, from);
  const iTo = nearestIndex(line, to);
  if (!(iFrom < iTo)) throw new Error(`差し替え区間の探索失敗(${label}) iFrom=${iFrom} iTo=${iTo}`);
  return [...line.slice(0, iFrom + 1), ...detour, ...line.slice(iTo)];
}

const nearestIndex = (line, pt) => {
  let best = 0, bd = Infinity;
  for (let i = 0; i < line.length; i++) {
    const d = dist2(line[i], pt);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};

// ------------------------------------------------------------ geometry pipeline

// 緯度経度 → メートル平面(equirectangular)。Three.js: 北=-z, 東=+x
function project(latlon, origin) {
  const [lat0, lon0] = origin;
  const kLat = 111320;
  const kLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return latlon.map(([lat, lon]) => [(lon - lon0) * kLon, -(lat - lat0) * kLat]);
}

// Ramer-Douglas-Peucker 簡略化
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts.at(-1)];
  let maxD = 0, idx = 0;
  const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dx, dz) || 1e-12;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dx * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * dz) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
}

// 鋭い折れを円弧フィレットに置換。TURN_MIN_ANGLE 以上の折れ(右左折交差点)は
// 小半径 turnRadius で曲げ、交差点情報(頂点・接点・進入/退出方位)を corners に記録する。
function filletCorners(pts, radius, minAngleDeg, turnMinAngleDeg = Infinity, turnRadius = radius) {
  const out = [pts[0]];
  const corners = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const v1 = [p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]];
    const v2 = [pts[i + 1][0] - p[0], pts[i + 1][1] - p[1]];
    const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const u1 = [v1[0] / l1, v1[1] / l1], u2 = [v2[0] / l2, v2[1] / l2];
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const dot = u1[0] * u2[0] + u1[1] * u2[1];
    const angle = Math.atan2(cross, dot); // 転回角(符号付き)
    if (Math.abs(angle) < (minAngleDeg * Math.PI) / 180) { out.push(p); continue; }
    const isTurn = Math.abs(angle) >= (turnMinAngleDeg * Math.PI) / 180;
    const baseR = isTurn ? turnRadius : radius;
    // 接点距離 d = R tan(|θ|/2)。セグメント長でクランプし実効半径を再計算
    let d = baseR * Math.tan(Math.abs(angle) / 2);
    const dMax = 0.45 * Math.min(l1, l2);
    const r = d > dMax ? dMax / Math.tan(Math.abs(angle) / 2) : baseR;
    d = Math.min(d, dMax);
    const t1 = [p[0] - u1[0] * d, p[1] - u1[1] * d];
    // 円弧中心: t1 から進入方向の法線(曲がる側)へ r
    const sign = Math.sign(angle);
    const n1 = [-u1[1] * sign, u1[0] * sign];
    const c = [t1[0] + n1[0] * r, t1[1] + n1[1] * r];
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    const steps = Math.max(2, Math.ceil(Math.abs(angle) / ((5 * Math.PI) / 180)));
    for (let k = 0; k <= steps; k++) {
      const a = a0 + (angle * k) / steps;
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
    if (isTurn) {
      corners.push({
        vertex: p,
        t1,
        t2: [p[0] + u2[0] * d, p[1] + u2[1] * d],
        u1,
        u2,
        angle,
        r,
        d,
      });
    }
  }
  out.push(pts.at(-1));
  return { pts: out, corners };
}

// Chaikin 平滑化(開曲線・端点保持)
function chaikin(pts) {
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  out.push(pts.at(-1));
  return out;
}

// 等間隔リサンプル
function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= segLen) {
      out.push([a[0] + ((b[0] - a[0]) * t) / segLen, a[1] + ((b[1] - a[1]) * t) / segLen]);
      t += step;
    }
    carry = segLen - (t - step);
  }
  out.push(pts.at(-1));
  return out;
}

// 点をポリラインに射影して弧長 s を返す(fromS 以降を探索: 停留所順の単調性を保証)
function projectToPath(path, cumLen, pt, fromS = 0) {
  let bestS = fromS, bd = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    if (cumLen[i + 1] < fromS) continue;
    const [a, b] = [path[i], path[i + 1]];
    const [abx, abz] = [b[0] - a[0], b[1] - a[1]];
    const ab2 = abx * abx + abz * abz || 1e-12;
    let t = ((pt[0] - a[0]) * abx + (pt[1] - a[1]) * abz) / ab2;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + abx * t, a[1] + abz * t];
    const s = cumLen[i] + Math.hypot(abx, abz) * t;
    if (s < fromS) continue;
    const d = dist2(q, pt);
    if (d < bd) { bd = d; bestS = s; }
  }
  return { s: bestS, dist: Math.sqrt(bd) };
}

function pointSegDistance(pt, a, b) {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const ab2 = abx * abx + abz * abz || 1e-12;
  const t = clamp(((pt[0] - a[0]) * abx + (pt[1] - a[1]) * abz) / ab2, 0, 1);
  const q = [a[0] + abx * t, a[1] + abz * t];
  return { d: Math.hypot(pt[0] - q[0], pt[1] - q[1]), q, t };
}

function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function polygonCentroid(poly) {
  let x = 0, z = 0;
  for (const p of poly) { x += p[0]; z += p[1]; }
  return [x / poly.length, z / poly.length];
}

function simplifyClosed(poly, eps = 0.6) {
  if (poly.length <= 8) return poly;
  const simplified = rdp([...poly, poly[0]], eps).slice(0, -1);
  if (simplified.length >= 3 && simplified.length <= 20) return simplified;
  if (simplified.length >= 3) return simplified.slice(0, 20);
  return poly.slice(0, 20);
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

function closestRoadSample(path, cumLen, roadPts, fromS = 0) {
  let best = null;
  for (let i = 0; i < roadPts.length - 1; i++) {
    const a = roadPts[i], b = roadPts[i + 1];
    const segHeading = Math.atan2(b[0] - a[0], b[1] - a[1]);
    for (let k = 0; k <= 2; k++) {
      const t = k / 2;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const hit = projectToPath(path, cumLen, p, fromS);
      if (!best || hit.dist < best.dist) best = { ...hit, heading: segHeading };
    }
  }
  return best;
}

function closestRoadNearS(path, cumLen, road, s) {
  const [px, pz] = pointAtPath(path, cumLen, s);
  let best = null;
  for (let i = 0; i < road.pts.length - 1; i++) {
    const a = road.pts[i], b = road.pts[i + 1];
    const segH = Math.atan2(b[0] - a[0], b[1] - a[1]);
    const hit = pointSegDistance([px, pz], a, b);
    const qHit = projectToPath(path, cumLen, hit.q, Math.max(0, s - 140));
    const ds = Math.abs(qHit.s - s);
    const score = hit.d + ds * 0.45;
    if (!best || score < best.score) best = { ...qHit, heading: segH, distToRoad: hit.d, ds, score };
  }
  return best;
}

function routeHeadingAt(path, cumLen, s) {
  let i = 0;
  while (i < cumLen.length - 2 && cumLen[i + 1] < s) i++;
  const a = path[i], b = path[Math.min(path.length - 1, i + 1)];
  return Math.atan2(b[0] - a[0], b[1] - a[1]);
}

// 区間の左右幅(センター〜路端)。一方通行は経路=道路中心なので左右等分
function sectionWidths(sec) {
  if (!sec.lanesB) {
    const w = (sec.lanesF * LANE_W + 2.8) / 2;
    return { wL: +w.toFixed(2), wR: +w.toFixed(2) };
  }
  return {
    wL: +(sec.lanesF * LANE_W + 0.8).toFixed(2),
    wR: +(sec.lanesB * LANE_W + 0.8).toFixed(2),
  };
}

/** sections の [from,to] 部分だけ mut を適用(必要に応じて区間分割) */
function overlayLanes(sections, from, to, mut) {
  if (to - from < 4) return sections;
  const out = [];
  for (const sec of sections) {
    const a = Math.max(sec.from, from), b = Math.min(sec.to, to);
    if (b - a < 0.5) { out.push(sec); continue; }
    if (sec.from < a - 0.01) out.push({ ...sec, to: a });
    out.push(mut({ ...sec, from: a, to: b }));
    if (b < sec.to - 0.01) out.push({ ...sec, from: b, to: sec.to });
  }
  return out;
}

/** LANE_PLAN と右折車線ゾーンから roadSections を生成 */
function buildLaneSections(path, cumLen, origin, signals, turnSpans, intersections, elevations = []) {
  const toS = (anchor, fromS = 0) => {
    if (typeof anchor === 'string') {
      const ix = intersections.find((i) => i.name === anchor && i.s >= fromS - 5);
      if (!ix) throw new Error(`車線プラン境界の交差点が見つからない: ${anchor}`);
      return ix.s;
    }
    const pt = project([anchor], origin)[0].map((v) => v * SCALE);
    const hit = projectToPath(path, cumLen, pt, fromS);
    if (hit.dist > 60) console.warn(`  警告: 車線プラン境界の射影誤差 ${hit.dist.toFixed(0)}m @ [${anchor}]`);
    return hit.s;
  };
  let sections = [];
  let from = 0, cursor = 0;
  for (const seg of LANE_PLAN) {
    const end = seg.to ? toS(seg.to, cursor) : cumLen.at(-1);
    sections.push({ from, to: end, lanesF: seg.F, lanesB: seg.B, center: seg.center ?? (seg.B ? 'line' : 'none') });
    cursor = end;
    from = end;
  }
  // 右折車線: 信号交差点の進入方向に+1車線(右左折交差点の円弧内はクランプ)
  for (const zone of APPROACH_ZONES) {
    const z0 = toS(zone.from), z1 = toS(zone.to, z0);
    for (const sig of signals) {
      if (sig.s < z0 - 2 || sig.s > z1 + 2) continue;
      const t = turnSpans.find((tt) => sig.s > tt.sIn - 30 && sig.s < tt.sOut + 30);
      const f0 = Math.max(sig.s - zone.len, z0);
      const f1 = Math.min(sig.s, t ? t.sIn - 2 : Infinity, z1);
      if (f1 > f0) sections = overlayLanes(sections, f0, f1, (sec) => ({ ...sec, lanesF: sec.lanesF + 1 }));
      const b0 = Math.max(sig.s, t ? t.sOut + 2 : -Infinity, z0);
      const b1 = Math.min(sig.s + zone.len, z1);
      if (b1 > b0) sections = overlayLanes(sections, b0, b1, (sec) => ({ ...sec, lanesB: sec.lanesB + 1 }));
    }
  }
  // 跨線橋区間: 高架デッキは中央の片道2車線のみ(両脇の地上1車線は railways.js が側道として描く)
  for (const e of elevations) {
    sections = overlayLanes(
      sections,
      e.from - (e.approachIn ?? 50),
      e.to + (e.approachOut ?? 50),
      (sec) => ({ ...sec, lanesF: 2, lanesB: 2, bridge: 1 })
    );
  }
  return sections
    .filter((sec) => sec.to - sec.from > 0.5)
    .map((sec) => ({
      from: +sec.from.toFixed(1),
      to: +sec.to.toFixed(1),
      lanes: sec.lanesF + sec.lanesB,
      lanesF: sec.lanesF,
      lanesB: sec.lanesB,
      center: sec.center,
      ...(sec.bridge ? { bridge: 1 } : {}),
      ...sectionWidths(sec),
    }));
}

function roadMetadata(path, cumLen, origin, roads, signalNodes) {
  const projectedRoads = roads.map((road) => ({
    id: road.id,
    tags: road.tags ?? {},
    pts: project(road.geometry.map((p) => [p.lat, p.lon]), origin).map(([x, z]) => [x * SCALE, z * SCALE]),
  })).filter((r) => r.pts.length > 1);

  const intersectionCandidates = [];
  for (const road of projectedRoads) {
    const hit = closestRoadSample(path, cumLen, road.pts, 0);
    if (!hit || hit.dist > 14) continue;
    const routeH = routeHeadingAt(path, cumLen, hit.s);
    const crossing = Math.min(angleDiff(routeH, hit.heading), angleDiff(routeH, hit.heading + Math.PI));
    if (crossing < 0.42) continue;
    intersectionCandidates.push({
      s: +hit.s.toFixed(1),
      heading: +hit.heading.toFixed(4),
      width: +roadWidth(road.tags).toFixed(1),
      length: +Math.max(34, roadWidth(road.tags) * 7).toFixed(1),
      lanes: laneCount(road.tags),
      highway: road.tags.highway,
      name: road.tags.name ?? '',
      dist: hit.dist,
    });
  }
  intersectionCandidates.sort((a, b) => a.s - b.s || a.dist - b.dist);
  const intersections = [];
  for (const ix of intersectionCandidates) {
    const prev = intersections.at(-1);
    if (prev && Math.abs(ix.s - prev.s) < 24) {
      if (ix.width > prev.width) Object.assign(prev, ix);
    } else {
      intersections.push(ix);
    }
  }

  const signals = signalNodes.map((node) => {
    const pt = project([[node.lat, node.lon]], origin)[0].map((v) => v * SCALE);
    const { s, dist } = projectToPath(path, cumLen, pt, 0);
    return { s: +s.toFixed(1), name: node.tags?.name ?? 'traffic_signal', dist };
  }).filter((sig) => sig.dist < 35)
    .sort((a, b) => a.s - b.s)
    .reduce((acc, sig) => {
      if (!acc.length || Math.abs(sig.s - acc.at(-1).s) > 42) acc.push({ s: sig.s, name: sig.name });
      return acc;
    }, []);

  for (const sig of signals) {
    if (intersections.some((ix) => Math.abs(ix.s - sig.s) < 28)) continue;
    const routeH = routeHeadingAt(path, cumLen, sig.s);
    let best = null;
    for (const road of projectedRoads) {
      const hit = closestRoadNearS(path, cumLen, road, sig.s);
      if (!hit || hit.dist > 45 || hit.ds > 55) continue;
      const crossing = Math.min(angleDiff(routeH, hit.heading), angleDiff(routeH, hit.heading + Math.PI));
      if (crossing < 0.35) continue;
      if (!best || hit.score < best.hit.score) best = { road, hit };
    }
    if (best) {
      const tags = best.road.tags;
      intersections.push({
        s: sig.s,
        heading: +best.hit.heading.toFixed(4),
        width: +roadWidth(tags).toFixed(1),
        length: +Math.max(38, roadWidth(tags) * 7).toFixed(1),
        lanes: laneCount(tags),
        highway: tags.highway,
        name: tags.name ?? sig.name,
        dist: best.hit.dist,
      });
    }
  }
  intersections.sort((a, b) => a.s - b.s || a.dist - b.dist);

  // 交差道路の実勢オーバーライド(五条通=計9・四条通=計5 等)
  for (const ov of INTERSECTION_OVERRIDES) {
    for (const ix of intersections) {
      if (ix.name !== ov.name) continue;
      ix.width = ov.width;
      ix.lanes = ov.lanes;
      ix.length = +Math.max(34, ov.width * 7).toFixed(1);
      if (ov.median) ix.median = 1;
      if (ov.label) ix.name = ov.label;
    }
  }

  return { intersections, signals };
}

function buildingHeight(tags = {}, s, routeLength, id) {
  const taggedHeight = parsePositive(tags.height);
  if (taggedHeight) return clamp(taggedHeight, 2.8, 42);
  const levels = parsePositive(tags['building:levels']);
  if (levels) return clamp(levels * 3.1, 2.8, 42);
  const t = s / routeLength;
  const r = rand01(id);
  if (t < 0.45) return +(6 + r * 16).toFixed(1);
  if (t < 0.65) return +(5 + r * 10).toFixed(1);
  return +(3.8 + r * 6.5).toFixed(1);
}

function buildingColor(tags = {}, id) {
  if (tags.amenity === 'parking') return 0xaab1b7;
  const palette = [0xd9d2c4, 0xcfc8ba, 0xbfb7a8, 0xa89f90, 0x8f8a80, 0xe2ddd2, 0xaeb4b8, 0x9aa0a8];
  return palette[Math.floor(rand01(id) * palette.length)];
}

function buildingMetadata(path, cumLen, origin, buildingWays) {
  const candidates = [];
  for (const way of buildingWays) {
    if (!way.geometry?.length || !way.tags?.building) continue;
    let footprint = project(way.geometry.map((p) => [p.lat, p.lon]), origin)
      .map(([x, z]) => [+((x * SCALE).toFixed(2)), +((z * SCALE).toFixed(2))]);
    if (footprint.length > 2 && dist2(footprint[0], footprint.at(-1)) < 0.05) footprint = footprint.slice(0, -1);
    if (footprint.length < 3) continue;
    const area = Math.abs(polygonArea(footprint));
    if (area < 12 || area > 6500) continue;
    const center = polygonCentroid(footprint);
    const hit = projectToPath(path, cumLen, center, 0);
    if (hit.dist > BUILDING_AROUND_RADIUS || hit.dist < 6) continue;
    footprint = simplifyClosed(footprint);
    if (polygonArea(footprint) < 0) footprint.reverse();
    candidates.push({
      id: way.id,
      s: +hit.s.toFixed(1),
      dist: +hit.dist.toFixed(1),
      height: +buildingHeight(way.tags, hit.s, cumLen.at(-1), way.id).toFixed(1),
      color: buildingColor(way.tags, way.id),
      footprint,
    });
  }
  const buckets = new Map();
  for (const item of candidates) {
    const key = Math.floor(item.s / BUILDING_BIN_SIZE);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const selected = [];
  for (const [key, bucket] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bucket.sort((a, b) => a.dist - b.dist);
    selected.push(...bucket.slice(0, BUILDINGS_PER_BIN));
  }
  selected.sort((a, b) => a.s - b.s || a.dist - b.dist);
  return selected.slice(0, MAX_BUILDINGS).map(({ id, dist, ...b }) => b);
}

function railwayMetadata(path, cumLen, origin, railWays, sFrom, sTo) {
  const groups = { conventional: [], shinkansen: [] };
  for (const way of railWays) {
    const tags = way.tags ?? {};
    if (tags.railway !== 'rail' || tags.railway === 'platform') continue;
    if (tags.railway === 'platform' || tags.usage === 'tourism' || tags['railway:preserved']) continue;
    const pts = project(way.geometry.map((p) => [p.lat, p.lon]), origin).map(([x, z]) => [x * SCALE, z * SCALE]);
    if (pts.length < 2) continue;
    const hit = closestRoadSample(path, cumLen, pts, Math.max(0, sFrom - 80));
    if (!hit || hit.dist > 45 || hit.s < sFrom || hit.s > sTo) continue;
    const routeH = routeHeadingAt(path, cumLen, hit.s);
    const crossing = Math.min(angleDiff(routeH, hit.heading), angleDiff(routeH, hit.heading + Math.PI));
    if (crossing < 0.75) continue;
    const name = tags['name:ja'] ?? tags.name ?? '';
    const isShinkansen = tags.highspeed === 'yes' || tags.gauge === '1435' || name.includes('新幹線');
    const isConventional = tags.gauge === '1067' || name.includes('東海道本線') || name.includes('山陰本線');
    if (!isShinkansen && !isConventional) continue;
    groups[isShinkansen ? 'shinkansen' : 'conventional'].push({
      s: hit.s,
      heading: hit.heading,
      service: tags.service ?? '',
      name,
    });
  }

  const buildGroup = (kind, list) => {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a.s - b.s);
    const sMin = sorted[0].s;
    const sMax = sorted.at(-1).s;
    const main = sorted.filter((r) => !['crossover', 'siding', 'yard', 'spur'].includes(r.service));
    const src = main.length ? main : sorted;
    const mainTracks = main.length;
    const s = src.reduce((a, r) => a + r.s, 0) / src.length;
    // 方位は mod-π の円周平均(倍角トリック)。OSM の way は東向き/西向きが混在し
    // (θ と θ+π)、単純平均では打ち消し合って道路と平行な向きに潰れてしまう。
    const heading = 0.5 * Math.atan2(
      src.reduce((a, r) => a + Math.sin(2 * r.heading), 0),
      src.reduce((a, r) => a + Math.cos(2 * r.heading), 0)
    );
    if (kind === 'shinkansen') {
      return {
        kind: 'shinkansen-viaduct',
        name: '東海道新幹線',
        s: +s.toFixed(1),
        heading: +heading.toFixed(4),
        length: 190,
        width: 16,
        trackCount: 2,
        layer: 3,
      };
    }
    const trackCount = clamp(Math.round(mainTracks || sorted.length), 4, 8);
    return {
      kind: 'conventional-underpass',
      name: 'JR在来線(東海道本線・山陰本線)',
      s: +s.toFixed(1),
      fromS: +Math.max(sFrom, sMin - 18).toFixed(1),
      toS: +Math.min(sTo, sMax + 18).toFixed(1),
      heading: +heading.toFixed(4),
      length: 185,
      width: +(trackCount * 3.2 + 8).toFixed(1),
      trackCount,
      layer: 0,
      roadLayer: 1,
    };
  };

  return [
    buildGroup('conventional', groups.conventional),
    buildGroup('shinkansen', groups.shinkansen),
  ].filter(Boolean).sort((a, b) => a.s - b.s);
}

/**
 * 信号の柱・灯器のワールド座標を計算して heads 配列を返す(JSONに埋め込み、描画側は置くだけ)。
 * 右左折交差点では四隅の歩道角(両道路の路端+1.85m の交点)に柱を立てる。
 * 通常交差点ではルート接線基準・従道柱は交差道路の幅の外側。
 * head: {kind:'main'|'cross', face, pole:[x,z], head:[x,z], arm?, hoods?}
 */
function placeSignalHeads(sig, turns, intersections, path, cumLen, widths) {
  const { hwAt, wLAt, wRAt, laneCenterAt, oppLaneCenterAt } = widths;
  const round = (p) => [+p[0].toFixed(2), +p[1].toFixed(2)];
  // 柱の退避対象となる舗装矩形: 近傍の交差道路スタブ + 右左折交差点の腕
  const rects = [
    ...intersections.filter((i) => Math.abs(i.s - sig.s) < 70).map((i) => {
      const [cx, cz] = pointAtPath(path, cumLen, i.s);
      return { cx, cz, heading: i.heading, from: -i.length / 2, to: i.length / 2, hw: i.width / 2 };
    }),
    ...turns.filter((t) => Math.abs(t.s - sig.s) < 90).flatMap((t) => [
      { cx: t.x, cz: t.z, heading: t.headingIn, from: -(t.d + 2), to: 42, hw: t.hwIn },
      { cx: t.x, cz: t.z, heading: t.headingOut, from: -42, to: t.d + 2, hw: t.hwOut },
    ]),
  ];
  // 柱が路面(本線・スタブ)に乗っていたら外へ押し出す(最終保険・反復)
  const clearPole = (p0) => {
    let p = p0;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const { s, dist } = projectToPath(path, cumLen, p, 0);
      const [qx, qz] = pointAtPath(path, cumLen, s);
      const h = routeHeadingAt(path, cumLen, s);
      // 進行右方向の法線 (-cos h, sin h) との内積で左右を判定し、その側の幅で退避
      const latSign = (p[0] - qx) * -Math.cos(h) + (p[1] - qz) * Math.sin(h);
      const need = (latSign < 0 ? wLAt(s) : wRAt(s)) + 1.2;
      if (dist < need) {
        let ux = p[0] - qx, uz = p[1] - qz;
        const len = Math.hypot(ux, uz);
        if (len < 0.5) {
          ux = -Math.cos(h); // ほぼ路面中心に居る場合は経路の右法線方向へ
          uz = Math.sin(h);
        } else {
          ux /= len;
          uz /= len;
        }
        p = [qx + ux * (need + 0.5), qz + uz * (need + 0.5)];
        moved = true;
      }
      for (const r of rects) {
        const dx = p[0] - r.cx, dz = p[1] - r.cz;
        const dir = [Math.sin(r.heading), Math.cos(r.heading)];
        const along = dx * dir[0] + dz * dir[1];
        const lat = dx * dir[1] - dz * dir[0];
        if (along > r.from - 0.5 && along < r.to + 0.5 && Math.abs(lat) < r.hw + 0.7) {
          const target = (lat >= 0 ? 1 : -1) * (r.hw + 0.9); // 矩形の短手方向へ退避
          p = [p[0] + dir[1] * (target - lat), p[1] - dir[0] * (target - lat)];
          moved = true;
        }
      }
      if (!moved) break;
    }
    return p;
  };
  const heads = [];
  const push = (kind, face, pole, head, opts = {}) => {
    heads.push({ kind, face: +face.toFixed(4), pole: round(clearPole(pole)), head: round(head), ...opts });
  };

  const t = turns.find((tt) => Math.abs(tt.s - sig.s) <= 30);
  if (t) {
    // 右左折交差点: 円弧(バスの実走路)を避け、交差点ボックスの外側に軸沿いで配置する。
    // pt(基準軸, along, latRight): 軸方向 along + 進行右方向 latRight のワールド座標
    const dirA = [Math.sin(t.headingIn), Math.cos(t.headingIn)];
    const rightA = [-Math.cos(t.headingIn), Math.sin(t.headingIn)];
    const dirB = [Math.sin(t.headingOut), Math.cos(t.headingOut)];
    const rightB = [-Math.cos(t.headingOut), Math.sin(t.headingOut)];
    const ptA = (along, lat) => [t.x + dirA[0] * along + rightA[0] * lat, t.z + dirA[1] * along + rightA[1] * lat];
    const ptB = (along, lat) => [t.x + dirB[0] * along + rightB[0] * lat, t.z + dirB[1] * along + rightB[1] * lat];
    const boxA = Math.max(t.d, t.hwOut) + 2.6; // 進入側ボックス端(円弧開始より手前)
    const boxB = Math.max(t.d, t.hwIn) + 2.6;  // 退出側ボックス端(円弧終了より先)

    // 進入路(バス)向き: ボックス手前・左路端の柱からアームで自車線上へ
    push('main', t.headingIn, ptA(-boxA, -(wLAt(Math.max(0, t.sIn - 1)) + 1.85)), ptA(-boxA, laneCenterAt(t.sIn) - 0.2), { arm: 1, hoods: 1 });
    // 退出路の対向車向き: ボックスの先・ルート右側の柱、対向車線上へ(一方通行なら省略)
    const oppOut = oppLaneCenterAt(t.sOut + 1);
    if (oppOut != null) {
      push('main', t.headingOut + Math.PI, ptB(boxB, wRAt(t.sOut + 1) + 1.85), ptB(boxB, oppOut + 0.2), { arm: 1 });
    }
    // 従道向き(交差点内連動): 両道路の路端が交わる歩道角に柱を置く(柱直付け)
    // p·nA = a, p·nB = b の連立解(nA/nB は各道路軸の左法線)
    const nA = [Math.cos(t.headingIn), -Math.sin(t.headingIn)];
    const nB = [Math.cos(t.headingOut), -Math.sin(t.headingOut)];
    const det = nA[0] * nB[1] - nA[1] * nB[0];
    if (Math.abs(det) > 0.3) {
      const cornerPole = (a, b) => [t.x + (a * nB[1] - b * nA[1]) / det, t.z + (-a * nB[0] + b * nA[0]) / det];
      // 直進スタブの先から来る車向き: A軸の先(alongA>0)側の角
      for (const sb of [1, -1]) {
        const p = cornerPole(-(t.hwIn + 1.85), sb * (t.hwOut + 1.85));
        const alongA = (p[0] - t.x) * dirA[0] + (p[1] - t.z) * dirA[1];
        if (alongA > 0) {
          push('cross', t.headingIn + Math.PI, p, [p[0] + nA[0] * 0.6, p[1] + nA[1] * 0.6]);
          break;
        }
      }
      // 退出路の後方から来る車向き: B軸の後方(alongB<0)側の角
      for (const sa of [1, -1]) {
        const p = cornerPole(sa * (t.hwIn + 1.85), t.hwOut + 1.85);
        const alongB = (p[0] - t.x) * dirB[0] + (p[1] - t.z) * dirB[1];
        if (alongB < 0) {
          push('cross', t.headingOut, p, [p[0] - nB[0] * 0.6, p[1] - nB[1] * 0.6]);
          break;
        }
      }
    }
    return heads;
  }

  // 通常交差点: ルート接線基準(従来 traffic.js にあった配置式を移植)。
  // 柱の前後オフセットは交差道路の幅の外側まで取る(交差道路の路上に立てない)
  const [px, pz] = pointAtPath(path, cumLen, sig.s);
  const theta = routeHeadingAt(path, cumLen, sig.s);
  const [tx, tz] = [Math.sin(theta), Math.cos(theta)];
  const nx = -tz, nz = tx; // lateral 正(右)方向
  const HW = hwAt(sig.s);
  const ix = intersections.find((i) => Math.abs(i.s - sig.s) < 28);
  const ch = ix ? ix.heading : theta + Math.PI / 2;
  const crossHalf = (ix?.width ?? 8) / 2;
  // 主道柱の前後オフセット: 交差道路の路端の外まで。斜め交差では路端が主道方向に伸びる分を割り増す
  const crossAngle = Math.min(angleDiff(theta, ch), angleDiff(theta, ch + Math.PI));
  const ahead = Math.min(16, Math.max(5.2, (crossHalf + 2.2) / Math.max(0.45, Math.sin(crossAngle))));
  const at = (lat, d) => [px + nx * lat + tx * d, pz + nz * lat + tz * d];
  push('main', theta, at(-(wLAt(sig.s) + 1.7), -ahead), at(laneCenterAt(sig.s) - 0.2, -ahead), { arm: 1, hoods: 1 });
  const opp = oppLaneCenterAt(sig.s);
  if (opp != null) {
    push('main', theta + Math.PI, at(wRAt(sig.s) + 1.7, ahead), at(opp + 0.2, ahead), { arm: 1 });
  }
  const cd = [Math.sin(ch), Math.cos(ch)];
  for (const dir of [1, -1]) {
    // 柱は主道の路端(HW+2.2)より先・交差道路の路端(crossHalf+1.6)の外側
    const pole = [
      px - cd[0] * dir * (HW + 2.2) + cd[1] * dir * (crossHalf + 1.6),
      pz - cd[1] * dir * (HW + 2.2) - cd[0] * dir * (crossHalf + 1.6),
    ];
    push('cross', dir === 1 ? ch : ch + Math.PI, pole, [pole[0] + cd[0] * dir * 0.6, pole[1] + cd[1] * dir * 0.6]);
  }
  return heads;
}

function pointAtPath(path, cumLen, s) {
  const ss = clamp(s, 0, cumLen.at(-1));
  let i = 0;
  while (i < cumLen.length - 2 && cumLen[i + 1] < ss) i++;
  const a = path[i], b = path[Math.min(path.length - 1, i + 1)];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-12;
  const t = (ss - cumLen[i]) / len;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// ---------------------------------------------------------------- main

async function buildFromOSM() {
  console.log('[1/5] OSMデータ取得');
  const relData = await loadCachedOrFetch(
    'route18_osm.json',
    `[out:json][timeout:90];relation(${RELATION_ID});out body geom;`
  );
  const nodeData = await loadCachedOrFetch(
    'route18_nodes.json',
    `[out:json][timeout:90];rel(${RELATION_ID});node(r);out body;`
  );

  const rel = relData.elements.find((e) => e.type === 'relation');
  // 経路ノード = 北行きリレーションの way + 南行き専用区間(十条〜旧千本通)の way
  const routeNodesQuery = `rel(${RELATION_ID})->.routeRel;
way(r.routeRel)->.relWays;
way(id:${JUJO_WAY_IDS.join(',')})->.jujoWays;
(.relWays; .jujoWays;)->.routeWays;
node(w.routeWays)->.routeNodes;`;
  const roadData = await loadCachedOrFetch(
    'route18_roads_wide2.json',
    `[out:json][timeout:90];
${routeNodesQuery}
(
  .routeWays;
  ${ROAD_TYPES.map((type) => `way(around.routeNodes:${ROAD_AROUND_RADIUS})["highway"="${type}"];`).join('\n  ')}
  node(around.routeNodes:${ROAD_AROUND_RADIUS})["highway"="traffic_signals"];
);
out body geom;`
  );
  const buildingData = await loadCachedOrFetch(
    'route18_buildings2.json',
    `[out:json][timeout:120];
${routeNodesQuery}
(
  way(around.routeNodes:${BUILDING_AROUND_RADIUS})["building"];
);
out body geom;`
  );
  const jujoData = await loadCachedOrFetch(
    'route18_jujo_southbound.json',
    `[out:json][timeout:60];way(id:${JUJO_WAY_IDS.join(',')});out body geom;`
  );
  const [railSouth, railWest, railNorth, railEast] = RAILWAY_BBOX;
  const railwayData = await loadCachedOrFetch(
    'route18_railways_sevenjo_toji.json',
    `[out:json][timeout:90];
(
  way[railway](${railSouth},${railWest},${railNorth},${railEast});
);
out body geom;`
  );
  const ways = rel.members.filter((m) => m.type === 'way' && m.role === '');
  const platformRefs = rel.members
    .filter((m) => m.role.startsWith('platform') || m.role.startsWith('stop'))
    .map((m) => m.ref);
  const nodeById = new Map(nodeData.elements.map((n) => [n.id, n]));

  console.log('[2/5] 北行き経路を連結 → 南行きへ反転・一方通行区間を差し替え');
  let line = connectWays(ways); // 北行き: 久我石原町 → 二条駅西口
  // 始点側が久我石原町(南)であることを確認してから反転
  if (line[0][0] > line.at(-1)[0]) line.reverse(); // 念のため: 先頭を北(二条駅)側に
  line.reverse(); // → いま先頭=二条駅西口(北) … reverse2回で意味が消えるためチェックし直す
  if (line[0][0] < line.at(-1)[0]) line.reverse(); // 先頭の緯度が小さい(南)なら反転して北始まりに
  // ここで line = 南行き(二条駅西口 → 久我石原町)

  // 南行き専用区間1: 十条新千本→十条通→十条旧千本→旧千本通(北行きは新千本通経由のため)
  const jujoWays = JUJO_WAY_IDS.map((id) => {
    const w = jujoData.elements.find((e) => e.type === 'way' && e.id === id);
    if (!w?.geometry?.length) throw new Error(`十条南行き way が見つからない: ${id}`);
    return w;
  });
  line = spliceDetour(line, chainOrderedWays(jujoWays, JUJO_FROM), JUJO_FROM, JUJO_TO, '十条南行き');
  // 南行き専用区間2: 小枝橋→城南宮道→赤池→上鳥羽塔ノ森
  line = spliceDetour(line, DETOUR_SOUTHBOUND, DETOUR_FROM, DETOUR_TO, '城南宮道');

  console.log('[3/5] 停留所を南行き順に整列');
  // 北行きの platform 順(久我石原町→二条駅西口)を逆転し、南行き専用停を挿入
  const osmStops = platformRefs
    .map((ref) => nodeById.get(ref))
    .filter(Boolean)
    .map((n) => ({ name: NAME_ALIAS[n.tags?.name] ?? n.tags?.name, latlon: [n.lat, n.lon] }))
    .reverse();
  for (const [name, latlon] of Object.entries(EXTRA_STOPS)) osmStops.push({ name, latlon });
  for (const st of osmStops) {
    if (SOUTHBOUND_STOP_OVERRIDES[st.name]) st.latlon = SOUTHBOUND_STOP_OVERRIDES[st.name];
  }
  const stopsLL = STOP_ORDER.map((name) => {
    const hit = osmStops.find((s) => s.name === name);
    if (!hit) throw new Error(`停留所がOSMデータに見つからない: ${name}`);
    return { name, latlon: hit.latlon };
  });

  const roads = roadData.elements.filter((e) => e.type === 'way' && isMajorRoad(e.tags) && e.geometry?.length > 1);
  const signalNodes = roadData.elements.filter((e) => e.type === 'node' && e.tags?.highway === 'traffic_signals');
  const buildings = buildingData.elements.filter((e) => e.type === 'way' && e.tags?.building && e.geometry?.length > 2);
  const railways = railwayData.elements.filter((e) => e.type === 'way' && e.tags?.railway && e.geometry?.length > 1);

  return { line, stopsLL, roads, signalNodes, buildings, railways, source: `OpenStreetMap relation ${RELATION_ID} © OpenStreetMap contributors (ODbL)` };
}

function buildFallback() {
  console.log('[fallback] 内蔵の実測停留所座標(OSM由来)を直結して経路を生成');
  // OSMから取得済みの実座標を埋め込み(南行き順)
  const coords = {
    '二条駅西口': [35.011273, 135.74124], '二条駅前': [35.0115206, 135.7424701],
    '千本三条・朱雀立命館前': [35.0089865, 135.7425339], 'みぶ操車場前': [35.0061817, 135.7456743],
    '四条大宮': [35.0040538, 135.7484709], '大宮松原': [34.9992554, 135.7490947],
    '大宮五条': [34.9970686, 135.7491156], '島原口': [34.9933278, 135.7490955],
    '七条大宮・京都水族館前': [34.9884228, 135.7490843], '東寺東門前': [34.9823598, 135.7491945],
    '九条大宮': [34.9801091, 135.7491864], '東寺南門前': [34.9793729, 135.7469272],
    '羅城門': [34.97912, 135.7429916], '唐戸町': [34.9760434, 135.7413693],
    '千本十条': SOUTHBOUND_STOP_OVERRIDES['千本十条'], '五丁橋': SOUTHBOUND_STOP_OVERRIDES['五丁橋'],
    '上ノ町': SOUTHBOUND_STOP_OVERRIDES['上ノ町'], '上鳥羽村山町': SOUTHBOUND_STOP_OVERRIDES['上鳥羽村山町'],
    '上鳥羽小学校前': SOUTHBOUND_STOP_OVERRIDES['上鳥羽小学校前'], '城ケ前町': [34.9626138, 135.7424736],
    '岩ノ本町': [34.9607101, 135.7425161], '地蔵前': SOUTHBOUND_STOP_OVERRIDES['地蔵前'],
    '奈須野': SOUTHBOUND_STOP_OVERRIDES['奈須野'], '小枝橋': SOUTHBOUND_STOP_OVERRIDES['小枝橋'],
    '城南宮道': EXTRA_STOPS['城南宮道'], '赤池': EXTRA_STOPS['赤池'],
    '上鳥羽塔ノ森': [34.9467722, 135.7391107], '久我': [34.945528, 135.7342175],
    '菱妻神社前': [34.94775, 135.7293566], '久我石原町': [34.9476875, 135.7248118],
  };
  const line = STOP_ORDER.map((n) => coords[n]);
  const stopsLL = STOP_ORDER.map((n) => ({ name: n, latlon: coords[n] }));
  return { line, stopsLL, roads: [], signalNodes: [], buildings: [], railways: [], source: 'fallback: OSM実測停留所座標の直結近似' };
}

async function main() {
  const fallback = process.argv.includes('--fallback');
  const { line, stopsLL, roads, signalNodes, buildings: buildingWays, railways, source } = fallback ? buildFallback() : await buildFromOSM();

  console.log('[4/5] 座標変換: 投影 → スケール → フィレット → 平滑化 → リサンプル');
  const origin = [
    line.reduce((a, p) => a + p[0], 0) / line.length,
    line.reduce((a, p) => a + p[1], 0) / line.length,
  ];
  let path = project(line, origin).map(([x, z]) => [x * SCALE, z * SCALE]);
  path = rdp(path, 1.2);
  // 始端に助走 18m・終端に 30m を直線延長(始発でバスを停留所手前に置く / 終点で停まり切る)
  const ext = (a, b, d) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
    return [a[0] + ((a[0] - b[0]) / l) * d, a[1] + ((a[1] - b[1]) / l) * d];
  };
  path.unshift(ext(path[0], path[1], 18));
  path.push(ext(path.at(-1), path.at(-2), 30));
  const filleted = filletCorners(path, FILLET_RADIUS, FILLET_MIN_ANGLE, TURN_MIN_ANGLE, TURN_FILLET_RADIUS);
  const turnCorners = filleted.corners;
  path = chaikin(filleted.pts);
  path = resample(path, RESAMPLE_STEP);
  path = path.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]);

  const cumLen = [0];
  for (let i = 1; i < path.length; i++) {
    cumLen.push(cumLen[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }
  const totalLength = cumLen.at(-1);

  console.log('[5/5] 停留所・橋・速度ゾーンを弧長に射影');
  let cursor = 0;
  const stops = stopsLL.map(({ name, latlon }) => {
    const pt = project([latlon], origin)[0].map((v) => v * SCALE);
    const { s, dist } = projectToPath(path, cumLen, pt, cursor);
    cursor = s + 10; // 次の停留所はこの先(単調性)
    return { name, s: +s.toFixed(1), projDist: +dist.toFixed(1) };
  });

  const bridges = BRIDGES.map(({ name, anchor, realLength }) => {
    const pt = project([anchor], origin)[0].map((v) => v * SCALE);
    const { s } = projectToPath(path, cumLen, pt, 0);
    return { name, s: +s.toFixed(1), length: +(realLength * SCALE).toFixed(1) };
  });

  const stopS = (name) => stops.find((st) => st.name === name).s;
  const speedZones = SPEED_ZONES.map((z) => ({
    from: z.fromStop ? stopS(z.fromStop) : 0,
    to: z.toStop ? stopS(z.toStop) : +totalLength.toFixed(1),
    limit: z.limit,
  }));
  const { intersections, signals: signalsRaw } = roadMetadata(path, cumLen, origin, roads, signalNodes);

  const railStructures = railwayMetadata(
    path,
    cumLen,
    origin,
    railways,
    stopS('七条大宮・京都水族館前'),
    stopS('東寺東門前')
  );

  // 大宮跨線橋: JR在来線を跨ぎ、八条通も高架のまま跨いで東寺道交差点の手前約100mで着地。
  // 高架は中央の片道2車線のみ(roadSections を橋区間だけ F2/B2 に上書き)。両脇の1車線は
  // 地上の側道として railways.js が描画する。
  const elevations = [];
  const railJR = railStructures.find((r) => r.kind === 'conventional-underpass');
  if (railJR) {
    // 東寺前交差点(東寺道)の手前約100mで完全に地上(高さ0)に降りる。八条通はデッキの下をくぐる。
    // elevationAt() の "to" は下り勾配の開始点(まだ全高)なので、接地点(groundS)から
    // approachOut を差し引いた点を渡す。
    const APPROACH_IN = 50, APPROACH_OUT = 90;
    const tojimae = intersections.find((ix) => ix.name === '東寺道' && ix.s > railJR.s);
    const from = railJR.fromS;
    const groundS = tojimae ? +(tojimae.s - 100).toFixed(1) : railJR.toS + 90;
    const to = +(groundS - APPROACH_OUT).toFixed(1);
    Object.assign(railJR, { bridgeFromS: from, bridgeToS: to, approachIn: APPROACH_IN, approachOut: APPROACH_OUT, deckHalf: 7.2 });
    elevations.push({ name: '大宮跨線橋', from, to, height: 4, approachIn: APPROACH_IN, approachOut: APPROACH_OUT });
    for (const ix of intersections) {
      if (ix.s > from - 20 && ix.s < groundS + 20) ix.under = 1; // 八条通など高架下の交差道路は地上のまま
    }
  }
  // 高架上の信号は存在しない(高架下の信号は自車に無関係)ので除外
  const signals = signalsRaw.filter(
    (sig) => !elevations.some((e) => sig.s > e.from - e.approachIn + 5 && sig.s < e.to + e.approachOut - 5)
  );

  // 右左折交差点の弧長スパン(右折車線を円弧内に食い込ませないためのクランプ)
  const turnSpans = turnCorners.map((c) => {
    const sIn = projectToPath(path, cumLen, c.t1, 0).s;
    return { sIn, sOut: projectToPath(path, cumLen, c.t2, sIn).s, corner: c };
  });
  const roadSections = buildLaneSections(path, cumLen, origin, signals, turnSpans, intersections, elevations);

  // ゲーム内道路幅・車線中心(routeData.js と同式)
  const secAt = (s) => roadSections.find((x) => s >= x.from && s < x.to) ?? roadSections.at(-1);
  const wLAtS = (s) => secAt(s).wL;
  const wRAtS = (s) => secAt(s).wR;
  const hwAtS = (s) => Math.max(secAt(s).wL, secAt(s).wR);
  const laneCenterAtS = (s) => {
    const sec = secAt(s);
    if (!sec.lanesB) return 0; // 一方通行: 道路中央を走る
    return -(((sec.wL - 0.55) * (sec.lanesF - 0.5)) / sec.lanesF);
  };
  const oppLaneCenterAtS = (s) => {
    const sec = secAt(s);
    if (!sec.lanesB) return null; // 対向車線なし
    return ((sec.wR - 0.55) * (sec.lanesB - 0.5)) / sec.lanesB;
  };
  const widths = { hwAt: hwAtS, wLAt: wLAtS, wRAt: wRAtS, laneCenterAt: laneCenterAtS, oppLaneCenterAt: oppLaneCenterAtS };

  // 右左折交差点: フィレット記録を弧長に射影し、交差道路名を intersections からマッチ
  // (マッチしたエントリは削除 — 旧スタブとの二重描画防止)
  const turnIntersections = turnSpans.map(({ sIn, sOut, corner: c }) => {
    const sMid = projectToPath(path, cumLen, c.vertex, sIn).s;
    let cross = null;
    for (const ix of intersections) {
      if (Math.abs(ix.s - sMid) < 30 && (!cross || Math.abs(ix.s - sMid) < Math.abs(cross.s - sMid))) cross = ix;
    }
    if (cross) intersections.splice(intersections.indexOf(cross), 1);
    return {
      s: +sMid.toFixed(1),
      sIn: +sIn.toFixed(1),
      sOut: +sOut.toFixed(1),
      x: +c.vertex[0].toFixed(2),
      z: +c.vertex[1].toFixed(2),
      headingIn: +Math.atan2(c.u1[0], c.u1[1]).toFixed(4),
      headingOut: +Math.atan2(c.u2[0], c.u2[1]).toFixed(4),
      angleDeg: +((c.angle * 180) / Math.PI).toFixed(1),
      d: +c.d.toFixed(1), // 頂点→円弧接点の距離(交差点ボックス描画用)
      hwIn: +hwAtS(Math.max(0, sIn - 1)).toFixed(1),
      hwOut: +hwAtS(sOut + 1).toFixed(1),
      crossName: cross?.name ?? '',
      crossWidth: cross?.width ?? 8,
      crossLanes: cross?.lanes ?? 2,
    };
  });

  // 右左折交差点の脚オーバーライド(九条大宮の大宮通=片道1、羽束師墨染線=計5 等)
  for (const ov of TURN_OVERRIDES) {
    const pt = project([ov.anchor], origin)[0].map((v) => v * SCALE);
    let best = null;
    for (const t of turnIntersections) {
      const d = Math.hypot(t.x - pt[0], t.z - pt[1]);
      if (d < 45 && (!best || d < best.d)) best = { t, d };
    }
    if (!best) {
      console.warn(`  警告: TURN_OVERRIDES のアンカーに一致する右左折交差点がない: [${ov.anchor}]`);
      continue;
    }
    if (ov.stubInHw != null) best.t.stubInHw = ov.stubInHw;
    if (ov.crossWidth != null) best.t.crossWidth = ov.crossWidth;
    if (ov.crossLanes != null) best.t.crossLanes = ov.crossLanes;
  }

  // 信号の柱・灯器の設置座標を計算して埋め込む(交差点内の路上に立てない)
  const signalsOut = signals.map((sig) => ({
    ...sig,
    heads: placeSignalHeads(sig, turnIntersections, intersections, path, cumLen, widths),
  }));

  const buildings = buildingMetadata(path, cumLen, origin, buildingWays);

  const out = {
    routeName: '18号系統',
    operator: '京都市交通局(横大路営業所)',
    destination: '横大路 久我石原町',
    origin: '二条駅西口',
    source,
    generatedAt: new Date().toISOString(),
    scale: SCALE,
    projOrigin: [+origin[0].toFixed(7), +origin[1].toFixed(7)], // 投影原点 [lat, lon](座標変換用)
    totalLength: +totalLength.toFixed(1),
    path,
    stops: stops.map(({ name, s }) => ({ name, s })),
    bridges,
    speedZones,
    roadSections,
    intersections: intersections.map(({ dist, ...ix }) => ix),
    turnIntersections,
    signals: signalsOut,
    buildings,
    railStructures,
    elevations,
  };
  writeFileSync(OUT, JSON.stringify(out));

  // ---- 検証ログ ----
  console.log('\n=== 生成結果 ===');
  console.log(`経路点数: ${path.length}  全長: ${totalLength.toFixed(0)}m (実距離 約${(totalLength / SCALE / 1000).toFixed(2)}km)`);
  console.log(`データ源: ${source}`);
  console.log('停留所30(s値 / 射影誤差m):');
  for (const st of stops) console.log(`  ${String(st.s).padStart(7)}  ${st.name}  (±${st.projDist}m)`);
  console.log('橋:', bridges.map((b) => `${b.name}@${b.s}`).join('  '));
  console.log('速度ゾーン:', speedZones.map((z) => `${z.from}-${z.to}:${z.limit}km/h`).join('  '));
  console.log(`道路区間: ${roadSections.length}  交差点: ${intersections.length}  OSM信号: ${signals.length}  OSM建物: ${buildings.length}  鉄道構造: ${railStructures.length}`);
  console.log(`右左折交差点: ${turnIntersections.length}`);
  for (const t of turnIntersections) {
    console.log(`  s=${String(t.s).padStart(7)}  ${String(t.angleDeg).padStart(6)}°  ${t.crossName || '(交差道路名なし)'}`);
  }
  for (const r of railStructures) {
    console.log(`鉄道: ${r.name}  s=${r.s}  heading=${r.heading.toFixed(4)}rad`);
  }
  const bad = stops.filter((st, i) => i > 0 && st.s <= stops[i - 1].s);
  if (bad.length) throw new Error(`s値が単調増加でない停留所: ${bad.map((b) => b.name).join(',')}`);
  if (stops.length !== 30) throw new Error(`停留所数が30でない: ${stops.length}`);
  console.log(`\nOK → ${OUT}`);
}

main().catch((e) => {
  console.error('生成失敗:', e.message);
  console.error('ネットワーク不通の場合は --fallback を試してください');
  process.exit(1);
});
