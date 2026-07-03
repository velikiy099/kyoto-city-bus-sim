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
const OVERPASS = 'https://overpass-api.de/api/interpreter';

// 距離スケール: 実距離に乗算(バス・道路幅は1:1のまま、路線距離だけ圧縮)
const SCALE = 0.4;
const RESAMPLE_STEP = 2;      // 最終ポリラインの点間隔 [m]
const FILLET_RADIUS = 15;     // 交差点コーナーの円弧半径 [m](スケール後の値)
const FILLET_MIN_ANGLE = 25;  // この角度[deg]を超える折れをフィレット化
const ROAD_TYPES = ['primary', 'secondary', 'tertiary', 'unclassified', 'residential'];

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

// ---------------------------------------------------------------- utilities

async function fetchJson(url, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'cc-sample-game-route-builder/0.1 (OpenStreetMap data refresh)',
    },
    body: body ? new URLSearchParams({ data: body }) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${url}${text ? `: ${text.slice(0, 500)}` : ''}`);
  }
  return res.json();
}

function loadCachedOrFetch(file, query) {
  const path = join(CACHE, file);
  if (existsSync(path)) {
    console.log(`  cache hit: tools/cache/${file}`);
    return Promise.resolve(JSON.parse(readFileSync(path, 'utf8')));
  }
  console.log(`  fetching from Overpass: ${file} ...`);
  return fetchJson(OVERPASS, query).then((data) => {
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
const isMajorRoad = (tags = {}) => ROAD_TYPES.includes(tags.highway ?? '') && tags.service !== 'driveway';

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

function expandedBounds(bounds, margin = 0.0025) {
  return [
    bounds.minlat - margin,
    bounds.minlon - margin,
    bounds.maxlat + margin,
    bounds.maxlon + margin,
  ];
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

// 鋭い折れを円弧フィレットに置換(スケール圧縮でコーナーが小さくなりバスが曲がれなくなる対策)
function filletCorners(pts, radius, minAngleDeg) {
  const out = [pts[0]];
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
    // 接点距離 d = R tan(|θ|/2)。セグメント長でクランプし実効半径を再計算
    let d = radius * Math.tan(Math.abs(angle) / 2);
    const dMax = 0.45 * Math.min(l1, l2);
    const r = d > dMax ? dMax / Math.tan(Math.abs(angle) / 2) : radius;
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
  }
  out.push(pts.at(-1));
  return out;
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

function routeHeadingAt(path, cumLen, s) {
  let i = 0;
  while (i < cumLen.length - 2 && cumLen[i + 1] < s) i++;
  const a = path[i], b = path[Math.min(path.length - 1, i + 1)];
  return Math.atan2(b[0] - a[0], b[1] - a[1]);
}

function roadMetadata(path, cumLen, origin, roads, signalNodes) {
  const projectedRoads = roads.map((road) => ({
    id: road.id,
    tags: road.tags ?? {},
    pts: project(road.geometry.map((p) => [p.lat, p.lon]), origin).map(([x, z]) => [x * SCALE, z * SCALE]),
  })).filter((r) => r.pts.length > 1);

  const samples = [];
  for (let s = 0; s <= cumLen.at(-1); s += 70) {
    const [px, pz] = pointAtPath(path, cumLen, s);
    const routeH = routeHeadingAt(path, cumLen, s);
    let best = null;
    for (const road of projectedRoads) {
      for (let i = 0; i < road.pts.length - 1; i++) {
        const a = road.pts[i], b = road.pts[i + 1];
        const segH = Math.atan2(b[0] - a[0], b[1] - a[1]);
        const aligned = Math.min(angleDiff(routeH, segH), angleDiff(routeH, segH + Math.PI));
        if (aligned > 0.55) continue;
        const hit = pointSegDistance([px, pz], a, b);
        if (hit.d > 10) continue;
        if (!best || hit.d < best.d) best = { d: hit.d, tags: road.tags };
      }
    }
    samples.push({ s, lanes: best ? laneCount(best.tags) : 2 });
  }
  if (samples.at(-1)?.s < cumLen.at(-1)) samples.push({ s: cumLen.at(-1), lanes: samples.at(-1)?.lanes ?? 2 });
  const roadSections = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const cur = samples[i], next = samples[i + 1];
    const last = roadSections.at(-1);
    if (last && last.lanes === cur.lanes) last.to = +next.s.toFixed(1);
    else roadSections.push({ from: +cur.s.toFixed(1), to: +next.s.toFixed(1), lanes: cur.lanes });
  }

  const intersectionCandidates = [];
  for (const road of projectedRoads) {
    const hit = closestRoadSample(path, cumLen, road.pts, 0);
    if (!hit || hit.dist > 9) continue;
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
  }).filter((sig) => sig.dist < 22)
    .sort((a, b) => a.s - b.s)
    .reduce((acc, sig) => {
      if (!acc.length || Math.abs(sig.s - acc.at(-1).s) > 35) acc.push({ s: sig.s, name: sig.name });
      return acc;
    }, []);

  return { roadSections, intersections, signals };
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
  const [minLat, minLon, maxLat, maxLon] = expandedBounds(rel.bounds);
  const roadData = await loadCachedOrFetch(
    'route18_roads.json',
    `[out:json][timeout:90];
rel(${RELATION_ID})->.routeRel;
way(r.routeRel)->.routeWays;
node(w.routeWays)->.routeNodes;
(
  .routeWays;
  ${ROAD_TYPES.map((type) => `way(around.routeNodes:35)["highway"="${type}"];`).join('\n  ')}
  node(around.routeNodes:35)["highway"="traffic_signals"];
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

  const iFrom = nearestIndex(line, DETOUR_FROM);
  const iTo = nearestIndex(line, DETOUR_TO);
  if (!(iFrom < iTo)) throw new Error(`差し替え区間の探索失敗 iFrom=${iFrom} iTo=${iTo}`);
  line = [...line.slice(0, iFrom + 1), ...DETOUR_SOUTHBOUND, ...line.slice(iTo)];

  console.log('[3/5] 停留所を南行き順に整列');
  // 北行きの platform 順(久我石原町→二条駅西口)を逆転し、南行き専用停を挿入
  const osmStops = platformRefs
    .map((ref) => nodeById.get(ref))
    .filter(Boolean)
    .map((n) => ({ name: NAME_ALIAS[n.tags?.name] ?? n.tags?.name, latlon: [n.lat, n.lon] }))
    .reverse();
  for (const [name, latlon] of Object.entries(EXTRA_STOPS)) osmStops.push({ name, latlon });
  const stopsLL = STOP_ORDER.map((name) => {
    const hit = osmStops.find((s) => s.name === name);
    if (!hit) throw new Error(`停留所がOSMデータに見つからない: ${name}`);
    return { name, latlon: hit.latlon };
  });

  const roads = roadData.elements.filter((e) => e.type === 'way' && isMajorRoad(e.tags) && e.geometry?.length > 1);
  const signalNodes = roadData.elements.filter((e) => e.type === 'node' && e.tags?.highway === 'traffic_signals');

  return { line, stopsLL, roads, signalNodes, source: `OpenStreetMap relation ${RELATION_ID} © OpenStreetMap contributors (ODbL)` };
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
    '千本十条': [34.972717, 135.7411332], '五丁橋': [34.9702057, 135.7410436],
    '上ノ町': [34.9684134, 135.7409965], '上鳥羽村山町': [34.9663379, 135.740911],
    '上鳥羽小学校前': [34.9640204, 135.7424117], '城ケ前町': [34.9626138, 135.7424736],
    '岩ノ本町': [34.9607101, 135.7425161], '地蔵前': [34.9580168, 135.7424495],
    '奈須野': [34.9563035, 135.7419988], '小枝橋': [34.9541881, 135.741534],
    '城南宮道': EXTRA_STOPS['城南宮道'], '赤池': EXTRA_STOPS['赤池'],
    '上鳥羽塔ノ森': [34.9467722, 135.7391107], '久我': [34.945528, 135.7342175],
    '菱妻神社前': [34.94775, 135.7293566], '久我石原町': [34.9476875, 135.7248118],
  };
  const line = STOP_ORDER.map((n) => coords[n]);
  const stopsLL = STOP_ORDER.map((n) => ({ name: n, latlon: coords[n] }));
  return { line, stopsLL, roads: [], signalNodes: [], source: 'fallback: OSM実測停留所座標の直結近似' };
}

async function main() {
  const fallback = process.argv.includes('--fallback');
  const { line, stopsLL, roads, signalNodes, source } = fallback ? buildFallback() : await buildFromOSM();

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
  path = filletCorners(path, FILLET_RADIUS, FILLET_MIN_ANGLE);
  path = chaikin(path);
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
  const { roadSections, intersections, signals } = roadMetadata(path, cumLen, origin, roads, signalNodes);

  const out = {
    routeName: '18号系統',
    operator: '京都市交通局(横大路営業所)',
    destination: '横大路 久我石原町',
    origin: '二条駅西口',
    source,
    generatedAt: new Date().toISOString(),
    scale: SCALE,
    totalLength: +totalLength.toFixed(1),
    path,
    stops: stops.map(({ name, s }) => ({ name, s })),
    bridges,
    speedZones,
    roadSections,
    intersections: intersections.map(({ dist, ...ix }) => ix),
    signals,
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
  console.log(`道路区間: ${roadSections.length}  交差点: ${intersections.length}  OSM信号: ${signals.length}`);
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
