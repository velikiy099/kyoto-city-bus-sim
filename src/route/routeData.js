import raw from "../data/route18.json";
import terrainProfile from "../world/declarative/generated/route-elevation.json";
import { RoutePath } from "./path.js";

/** 路線データ一式(経路・停留所・橋・速度ゾーン) */
export const route = {
  name: raw.routeName,
  operator: raw.operator,
  destination: raw.destination,
  originName: raw.origin,
  source: raw.source,
  scale: raw.scale,
  path: new RoutePath(raw.path),
  terminalStop: raw.terminalStop ?? null, // OSMの久我石原町バス停ワールド座標
  // 上鳥羽村山町は北行きのみ停車(南行きは通過)のため除外
  stops: raw.stops.filter((st) => st.name !== "上鳥羽村山町"), // [{name, s}]
  bridges: raw.bridges, // [{name, s, length}]
  rivers: raw.rivers ?? [], // [{bridgeName, river, points:[[x,z],...], headingDeg}]
  extraRoads: raw.extraRoads ?? [], // [{id, points:[[x,z],...], width, mergeS, direction}]
  speedZones: raw.speedZones, // [{from, to, limit(km/h)}]
  roadSections: raw.roadSections ?? [], // [{from, to, lanes}]
  roadSurfaceAlignments: raw.roadSurfaceAlignments ?? [], // PLATEAU道路面をelevationAt(s)へ合わせる区間
  intersections: raw.intersections ?? [], // [{s, heading, width, lanes}]
  // 右左折交差点 [{s, sIn, sOut, x, z, headingIn, headingOut, angleDeg, crossName, crossWidth, crossLanes}]
  turnIntersections: raw.turnIntersections ?? [],
  signals: raw.signals ?? [], // [{s, name}]
  buildings: raw.buildings ?? [], // [{footprint:[[x,z]], height, color}]
  osmVegetation: raw.osmVegetation ?? null, // OSM tree nodes, rows, woodland and green areas
  osmStationRoads: raw.osmStationRoads ?? [], // OSM service/unclassified roads around Nijo Station
  railStructures: raw.railStructures ?? [], // [{kind, s, heading, layer}]
  elevations: raw.elevations ?? [], // [{name, profile?, from, peak?, to, height, ...}]
  umekojiTrees: raw.umekojiTrees, // 梅小路公園の樹木データ
};

// ---- 車線構成(roadSections 由来。build-route-data.mjs の LANE_PLAN が生成) ----
// {from, to, lanesF(進行方向), lanesB(対向。0=一方通行), wL(左幅), wR(右幅), center:'line'|'none'}
const FALLBACK_SECTION = {
  from: 0,
  to: Infinity,
  lanes: 2,
  lanesF: 1,
  lanesB: 1,
  wL: 4.0,
  wR: 4.0,
  center: "line",
};
const sections = raw.roadSections?.length
  ? raw.roadSections.map((sec) => ({
      ...FALLBACK_SECTION,
      ...sec,
      // 旧形式(lanes のみ)へのフォールバック
      lanesF: sec.lanesF ?? Math.max(1, Math.floor((sec.lanes || 2) / 2)),
      lanesB: sec.lanesB ?? Math.max(1, Math.ceil((sec.lanes || 2) / 2)),
      wL: sec.wL ?? Math.max(4.0, (sec.lanes || 2) * 1.6 + 0.8),
      wR: sec.wR ?? Math.max(4.0, (sec.lanes || 2) * 1.6 + 0.8),
    }))
  : [FALLBACK_SECTION];

/** s 位置の車線区間 */
export function sectionAt(s) {
  for (const sec of sections) {
    if (s >= sec.from && s < sec.to) return sec;
  }
  return s < sections[0].from ? sections[0] : sections.at(-1);
}

/** s 位置の車線数(往復合計、最低1) */
export function lanesAt(s) {
  const sec = sectionAt(s);
  return sec.lanesF + sec.lanesB;
}

/** s 位置の進行方向(南行き)車線数 */
export function fwdLanesAt(s) {
  return sectionAt(s).lanesF;
}

/** s 位置の対向(北行き)車線数(0=一方通行) */
export function backLanesAt(s) {
  return sectionAt(s).lanesB;
}

/** s 位置の左側(進行方向)幅: センター〜左路端 [m] */
export function leftWidthAt(s) {
  return sectionAt(s).wL;
}

/** s 位置の右側(対向)幅: センター〜右路端 [m] */
export function rightWidthAt(s) {
  return sectionAt(s).wR;
}

/** s 位置の道路半幅(広い側。対称前提の互換用)[m] */
export function halfWidthAt(s) {
  const sec = sectionAt(s);
  return Math.max(sec.wL, sec.wR);
}

function sectionLaneCenter(sec) {
  if (!sec.lanesB) return 0;
  return -(((sec.wL - 0.55) * (sec.lanesF - 0.5)) / sec.lanesF);
}

const laneEntryTransitions = (raw.elevations ?? [])
  .filter((item) => item.laneOverride && Number.isFinite(Number(item.autoEntryFrom)))
  .map((item) => ({
    from: Number(item.autoEntryFrom),
    to: Number(item.from),
  }));

/**
 * s 位置の標準走行位置の横偏差(左=負)。
 *
 * 大宮跨線橋では外側の地上側道へ入らないよう、大宮木津屋橋交差点から
 * 中央側の橋上車線へ滑らかに移り、30m南の橋開始点で合流を完了する。
 */
export function laneCenterAt(s) {
  for (const transition of laneEntryTransitions) {
    if (s < transition.from || s >= transition.to || transition.to <= transition.from) continue;
    const fromLat = sectionLaneCenter(sectionAt(transition.from - 0.1));
    const toLat = sectionLaneCenter(sectionAt(transition.to + 0.1));
    const t = (s - transition.from) / (transition.to - transition.from);
    const eased = t * t * (3 - 2 * t);
    return fromLat + (toLat - fromLat) * eased;
  }
  return sectionLaneCenter(sectionAt(s));
}

/** 停留所への寄せ目標(縁石ギャップ約0.45m) */
export function curbStopLat(s) {
  return -(leftWidthAt(s) - 1.7);
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
    out.push({
      x: t.x,
      z: t.z,
      r: Math.max(hwIn, hwOut) + (t.crossWidth ?? 8) / 2 + 3,
    });
    // 直進スタブ(headingIn 前方)と退出道路の後方延長に沿って円を並べる。
    // headingIn 側は stubInLen(road.js の addTurnIntersections と同じ既定 42m)
    // まで届くよう間隔を保って円を並べる — 既定より長いスタブ(小枝橋東詰など)でも
    // 先端まで街路樹・建物の除外が効くようにする。
    const headingIn =
      t.stubInHeadingDeg != null
        ? (t.stubInHeadingDeg * Math.PI) / 180
        : t.headingIn;
    const stubBackLen = t.stubBackLen ?? 42;
    const armsWithLen = [
      [Math.sin(headingIn), Math.cos(headingIn), hwIn, t.stubInLen ?? 42],
      [-Math.sin(t.headingOut), -Math.cos(t.headingOut), hwOut, stubBackLen],
    ];
    for (const [dx, dz, hw, len] of armsWithLen) {
      for (let d = 14; d < len; d += 13)
        out.push({ x: t.x + dx * d, z: t.z + dz * d, r: hw + 3.5 });
    }
  }
  return out;
}

// ---- 橋・跨線橋の構造物高さプロファイル ----
// 通常の橋は一定高デッキ+前後アプローチ、大宮跨線橋はJR在来線との
// 交点を唯一の最高点とする single-crest プロファイルを使用する。
// 旧形式フォールバック: roadLayer>0 の在来線アンダーパス区間。
const APPROACH_LEN = 50;
const elevSrc = raw.elevations?.length
  ? raw.elevations
  : (raw.railStructures ?? [])
      .filter(
        (r) => r.kind === "conventional-underpass" && (r.roadLayer ?? 0) > 0,
      )
      .map((r) => ({ from: r.fromS, to: r.toS, height: 4.0 }));
const elevationProfiles = elevSrc.map((r) => {
  if (r.profile === "flat-deck") {
    const start = Number(r.from);
    const end = Number(r.to);
    const approachIn = Number(r.approachIn ?? APPROACH_LEN);
    const approachOut = Number(r.approachOut ?? APPROACH_LEN);
    const a0 = start - approachIn;
    const b1 = end + approachOut;
    const h = Number(r.height ?? 1.8);
    let terrainMax = -Infinity;
    for (let sampleS = start; sampleS <= end + 1e-6; sampleS += 2) {
      terrainMax = Math.max(terrainMax, terrainElevationAt(sampleS));
    }
    terrainMax = Math.max(
      terrainMax,
      terrainElevationAt(start),
      terrainElevationAt(end),
    );
    return {
      kind: "flat-deck",
      a0,
      a1: start,
      b0: end,
      b1,
      deckY: terrainMax + h,
      startY: terrainElevationAt(a0),
      endY: terrainElevationAt(b1),
    };
  }
  if (r.profile === "single-crest" || Number.isFinite(Number(r.peak))) {
    const start = Number(r.from);
    const peak = Number(r.peak);
    const end = Number(r.to);
    const h = Number(r.height ?? 4.0);
    return {
      kind: "single-crest",
      start,
      peak,
      end,
      h,
      riseStartGrade: Number(r.riseStartGrade ?? 0),
      // The road alignment is an absolute vertical curve anchored to PLATEAU
      // ground at both ends. Merely adding a symmetric offset to the raw
      // terrain made a second terrain rise south of the railway become the
      // apparent highest point. A delayed power descent keeps the carriageway
      // above that terrain while retaining the JR crossing as the sole crest.
      fallPower: Number(r.fallPower ?? 2.4),
      startY: terrainElevationAt(start),
      peakY: terrainElevationAt(peak) + h,
      endY: terrainElevationAt(end),
    };
  }
  return {
    kind: "deck",
    a0: r.from - (r.approachIn ?? APPROACH_LEN),
    a1: r.from,
    b0: r.to,
    b1: r.to + (r.approachOut ?? APPROACH_LEN),
    h: r.height ?? 4.0,
  };
});
const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * s 位置の構造物による持ち上げ量 [m]。
 *
 * OSM/経路データは橋・高架の判定と構造物高さにだけ使う。
 * 地表標高は混ぜず、常に terrainElevationAt() の PLATEAU 地表を基準にする。
 */
function singleCrestRoadElevation(profile, s) {
  if (s <= profile.start) return profile.startY;
  if (s >= profile.end) return profile.endY;
  if (s <= profile.peak) {
    const span = Math.max(1e-6, profile.peak - profile.start);
    const t = (s - profile.start) / span;
    // Cubic Hermite vertical curve. The explicit north-end grade lets the
    // carriageway leave PLATEAU ground immediately at the real service-road
    // split while reaching zero grade at the JR crest. A zero value retains
    // the former smoothstep behaviour for any future generic profiles.
    const h00 = 2 * t * t * t - 3 * t * t + 1;
    const h10 = t * t * t - 2 * t * t + t;
    const h01 = -2 * t * t * t + 3 * t * t;
    return h00 * profile.startY
      + h10 * span * profile.riseStartGrade
      + h01 * profile.peakY;
  }
  const span = Math.max(1e-6, profile.end - profile.peak);
  const t = (s - profile.peak) / span;
  return profile.peakY +
    (profile.endY - profile.peakY) * Math.pow(t, profile.fallPower);
}

export function structuralElevationAt(s) {
  for (const profile of elevationProfiles) {
    if (profile.kind === "flat-deck") {
      if (s <= profile.a0 || s >= profile.b1) continue;
      let roadY;
      if (s < profile.a1) {
        const t = smoothstep((s - profile.a0) / Math.max(1e-6, profile.a1 - profile.a0));
        roadY = profile.startY + (profile.deckY - profile.startY) * t;
      } else if (s <= profile.b0) {
        roadY = profile.deckY;
      } else {
        const t = smoothstep((s - profile.b0) / Math.max(1e-6, profile.b1 - profile.b0));
        roadY = profile.deckY + (profile.endY - profile.deckY) * t;
      }
      return Math.max(0, roadY - terrainElevationAt(s));
    }
    if (profile.kind === "single-crest") {
      if (s < profile.start || s > profile.end) continue;
      const roadY = singleCrestRoadElevation(profile, s);
      // PLATEAU is the only ground source. The structure amount is derived
      // from the absolute road alignment, never from an OSM elevation value.
      return Math.max(0, roadY - terrainElevationAt(s));
    }
    if (s <= profile.a0 || s >= profile.b1) continue;
    if (s < profile.a1) {
      return profile.h * smoothstep((s - profile.a0) / (profile.a1 - profile.a0));
    }
    if (s <= profile.b0) return profile.h;
    return profile.h * smoothstep((profile.b1 - s) / (profile.b1 - profile.b0));
  }
  return 0;
}

function profileValue(profile, s, fallback = 0) {
  const samples = profile?.samples;
  if (!Array.isArray(samples) || samples.length === 0) return fallback;
  if (s <= samples[0][0]) return samples[0][1] ?? 0;
  if (s >= samples.at(-1)[0]) return samples.at(-1)[1] ?? 0;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] <= s) lo = mid;
    else hi = mid;
  }
  const [s0, y0] = samples[lo];
  const [s1, y1] = samples[hi];
  const t = s1 === s0 ? 0 : (s - s0) / (s1 - s0);
  return y0 + (y1 - y0) * t;
}

export function terrainElevationAt(s) {
  return profileValue(terrainProfile, s, 0);
}

/**
 * 本線道路の唯一の高さ。
 *
 *   路面高さ = PLATEAU 地表標高 + 構造物高さ
 *
 * 道路、バス、一般車両、欄干、停留所、信号など、本線道路に付随する
 * すべての要素はこの値を基準にする。PLATEAU transportation や OSM の
 * 個別標高値を第二の路面高さとして採用しない。
 */
export function elevationAt(s) {
  return terrainElevationAt(s) + structuralElevationAt(s);
}

/** PLATEAU道路面を本線高さへ追従させる横方向の範囲。 */
export function roadAttachmentHalfWidthAt(s) {
  const sec = sectionAt(s);
  const roadHalf = Math.max(sec.wL, sec.wR);
  // 橋区間は中央車道の外に地上側道が隣接するため、橋車線の端を越えて
  // 構造物高さを適用しない。通常区間だけ縁石・歩道分の余白を含める。
  if (sec.bridge) return roadHalf + 0.05;
  return roadHalf + (sec.sidewalk === "none" ? 0.75 : 3.4);
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
