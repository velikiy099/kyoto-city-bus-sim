import raw from '../data/route18.json';
import { RoutePath } from './path.js';

/** 路線データ一式(経路・停留所・橋・速度ゾーン) */
export const route = {
  name: raw.routeName,
  operator: raw.operator,
  destination: raw.destination,
  originName: raw.origin,
  source: raw.source,
  scale: raw.scale,
  path: new RoutePath(raw.path),
  // 上鳥羽村山町は北行きのみ停車(南行きは通過)のため除外
  stops: raw.stops.filter((st) => st.name !== '上鳥羽村山町'), // [{name, s}]
  bridges: raw.bridges, // [{name, s, length}]
  speedZones: raw.speedZones, // [{from, to, limit(km/h)}]
  roadSections: raw.roadSections ?? [], // [{from, to, lanes}]
  intersections: raw.intersections ?? [], // [{s, heading, width, lanes}]
  // 右左折交差点 [{s, sIn, sOut, x, z, headingIn, headingOut, angleDeg, crossName, crossWidth, crossLanes}]
  turnIntersections: raw.turnIntersections ?? [],
  signals: raw.signals ?? [], // [{s, name}]
  buildings: raw.buildings ?? [], // [{footprint:[[x,z]], height, color}]
  railStructures: raw.railStructures ?? [], // [{kind, s, heading, layer}]
};

// ---- 車線数に応じた実効道路幅(roadSections 由来。road.js の描画と同式) ----
const sections = raw.roadSections?.length ? raw.roadSections : [{ from: 0, to: Infinity, lanes: 2 }];

/** s 位置の車線数(往復合計、最低2) */
export function lanesAt(s) {
  for (const sec of sections) {
    if (s >= sec.from && s < sec.to) return Math.max(2, Number(sec.lanes) || 2);
  }
  return 2;
}

/** s 位置の道路半幅(センター〜縁石)[m] */
export function halfWidthAt(s) {
  return Math.max(4.0, lanesAt(s) * 1.6 + 0.8);
}

/** s 位置の標準走行位置(左端車線の中心)の横偏差(左=負) */
export function laneCenterAt(s) {
  const lanes = lanesAt(s);
  const HW = halfWidthAt(s);
  const leftLanes = Math.max(1, Math.floor(lanes / 2));
  const usable = HW - 0.55;
  return -((usable * (leftLanes - 0.5)) / leftLanes);
}

/** 停留所への寄せ目標(縁石ギャップ約0.45m) */
export function curbStopLat(s) {
  return -(halfWidthAt(s) - 1.7);
}

/** 右左折交差点付近の追加コース外マージン(交差点ボックス内は舗装が広がるため広く許容) */
export function turnAllowanceAt(s) {
  for (const t of route.turnIntersections) {
    if (s > t.sIn - 5 && s < t.sOut + 30) return (t.crossWidth ?? 8) / 2 + 5;
  }
  return 0;
}

/** 右左折交差点のスタブ道路を覆う除外円 [{x,z,r}](街路樹・建物の配置回避用) */
export function turnExclusions() {
  const out = [];
  for (const t of route.turnIntersections) {
    const hwIn = halfWidthAt(t.sIn);
    const hwOut = halfWidthAt(t.sOut);
    out.push({ x: t.x, z: t.z, r: Math.max(hwIn, hwOut) + (t.crossWidth ?? 8) / 2 + 3 });
    // 直進スタブ(headingIn 前方)と退出道路の後方延長に沿って円を並べる
    const arms = [
      [Math.sin(t.headingIn), Math.cos(t.headingIn), hwIn],
      [-Math.sin(t.headingOut), -Math.cos(t.headingOut), hwOut],
    ];
    for (const [dx, dz, hw] of arms) {
      for (const d of [14, 27, 40]) out.push({ x: t.x + dx * d, z: t.z + dz * d, r: hw + 3.5 });
    }
  }
  return out;
}

// ---- 跨線橋の標高プロファイル ----
// roadLayer>0 の在来線アンダーパス(=道路が線路を橋で越える)区間で道路を持ち上げる。
// デッキ区間は一定高、前後 APPROACH_LEN のアプローチを smoothstep で擦り付ける。
const APPROACH_LEN = 50;
const DECK_HEIGHT = 4.0;
const elevRamps = (raw.railStructures ?? [])
  .filter((r) => r.kind === 'conventional-underpass' && (r.roadLayer ?? 0) > 0)
  .map((r) => ({ a0: r.fromS - APPROACH_LEN, a1: r.fromS, b0: r.toS, b1: r.toS + APPROACH_LEN }));
const smoothstep = (t) => t * t * (3 - 2 * t);

/** s 位置の路面標高 [m](跨線橋以外は 0) */
export function elevationAt(s) {
  for (const r of elevRamps) {
    if (s <= r.a0 || s >= r.b1) continue;
    if (s < r.a1) return DECK_HEIGHT * smoothstep((s - r.a0) / (r.a1 - r.a0));
    if (s <= r.b0) return DECK_HEIGHT;
    return DECK_HEIGHT * smoothstep((r.b1 - s) / (r.b1 - r.b0));
  }
  return 0;
}

/** s 増加方向の路面勾配(dy/ds) */
export function gradeAt(s) {
  return (elevationAt(s + 3) - elevationAt(s - 3)) / 6;
}

/** s 位置の制限速度 [m/s] */
export function speedLimitAt(s) {
  for (const z of route.speedZones) {
    if (s >= z.from && s < z.to) return z.limit / 3.6;
  }
  return 40 / 3.6;
}

/** s 位置の制限速度 [km/h](HUD表示用) */
export function speedLimitKmhAt(s) {
  for (const z of route.speedZones) {
    if (s >= z.from && s < z.to) return z.limit;
  }
  return 40;
}
