import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { lambertize } from '../util/lambertize.js';
import { route, elevationAt, gradeAt, lanesAt, halfWidthAt, laneCenterAt, speedLimitAt, fwdLanesAt, backLanesAt, leftWidthAt, rightWidthAt } from '../route/routeData.js';

const mat = (color) => new THREE.MeshLambertMaterial({ color });
const signalMat = (color) => new THREE.MeshBasicMaterial({ color });

function makeCylinderBetween(a, b, radius, color) {
  const start = new THREE.Vector3(...a);
  const end = new THREE.Vector3(...b);
  const delta = end.clone().sub(start);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), 8), mat(color));
  mesh.position.copy(start.add(end).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  return mesh;
}

// ===== 交通車両(Blender製 glb)を共有ロードし、クローンで量産 =====
const loader = new GLTFLoader();
let vehicleLib = null; // vehicles.glb: 'Sedan' / 'Truck'
let busLib = null; // bus.glb: 対向バス(自車と同型)
const pendingVehicle = [];
const pendingBus = [];
loader.load('models/vehicles.glb', (gltf) => {
  lambertize(gltf.scene);
  vehicleLib = gltf.scene;
  for (const fill of pendingVehicle.splice(0)) fill();
});
loader.load('models/bus.glb', (gltf) => {
  lambertize(gltf.scene);
  busLib = gltf.scene;
  for (const fill of pendingBus.splice(0)) fill();
});

/** glbノードをクローンし、塗装マテリアル(paintName)だけ色替えして返す(非同期充填) */
function makeVehicle(nodeName, paintName, color) {
  const holder = new THREE.Group();
  const fill = () => {
    const node = vehicleLib.getObjectByName(nodeName).clone(true);
    node.position.set(0, 0, 0);
    const paint = new THREE.MeshLambertMaterial({ color });
    node.traverse((o) => {
      if (o.isMesh && o.material.name === paintName) o.material = paint;
    });
    holder.add(node);
  };
  if (vehicleLib) fill();
  else pendingVehicle.push(fill);
  return holder;
}

/** 対向車のモデル(セダン、前方=+z) */
const makeCar = (color) => makeVehicle('Sedan', 'CarPaint', color);

/** トラック(キャブオーバー+箱荷台、前方=+z) */
const makeTruck = (cabColor) => makeVehicle('Truck', 'TruckCab', cabColor);

/** 対向の路線バス(京都市バス18号系統の北行き便の想定、前方=+z) */
function makeOncomingBus() {
  const holder = new THREE.Group();
  const fill = () => {
    const node = busLib.clone(true);
    // bus.glb は原点=後軸中心(車体 z -2.6..8.9)なので車体中心を holder 原点へ
    node.position.set(0, 0, -3.15);
    holder.add(node);
    // 方向幕: 北行き「二条駅西口 | 18」。系統番号は右端の水色矩形に白字。
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 128;
    const c2 = cv.getContext('2d');
    c2.fillStyle = '#0d1116';
    c2.fillRect(0, 0, 512, 128);
    const numBoxX = 392;
    c2.fillStyle = '#3fa9dc';
    c2.fillRect(numBoxX, 0, 512 - numBoxX, 128);
    c2.fillStyle = '#ffffff';
    c2.textBaseline = 'middle';
    c2.textAlign = 'center';
    c2.font = 'bold 78px sans-serif';
    c2.fillText('18', numBoxX + (512 - numBoxX) / 2, 68);
    c2.fillStyle = '#ffb43c';
    c2.font = 'bold 52px sans-serif';
    c2.fillText('二条駅西口', 196, 64);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.36),
      new THREE.MeshBasicMaterial({ map: tex })
    );
    sign.position.set(0, 2.79, 8.94);
    node.add(sign);
  };
  if (busLib) fill();
  else pendingBus.push(fill);
  return holder;
}

// ===== 旋回(2次ベジェ)ユーティリティ: T字路合流・対向車の左折で共有 =====
// スナップせず弧長ベースで position/heading を連続的に算出することで、旋回時のカクつきを防ぐ。
function buildTurnArc(start, ctrl, end, steps = 16) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push([
      mt * mt * start[0] + 2 * mt * t * ctrl[0] + t * t * end[0],
      mt * mt * start[1] + 2 * mt * t * ctrl[1] + t * t * end[1],
    ]);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { pts, cum, length: cum.at(-1) || 1e-6 };
}
/** u: 0..1(走行済み弧長の割合)→ {x, z, heading} */
function sampleTurnArc(arc, u) {
  const target = Math.max(0, Math.min(1, u)) * arc.length;
  let i = 0;
  while (i < arc.cum.length - 2 && arc.cum[i + 1] < target) i++;
  const segLen = arc.cum[i + 1] - arc.cum[i] || 1e-6;
  const t = (target - arc.cum[i]) / segLen;
  const [ax, az] = arc.pts[i], [bx, bz] = arc.pts[i + 1];
  const dx = bx - ax, dz = bz - az;
  return { x: ax + dx * t, z: az + dz * t, heading: Math.atan2(dx, dz) };
}

const stopS = (name) => route.stops.find((st) => st.name === name)?.s ?? null;

function fallbackSignalPositions(path) {
  const SIG_STOPS = ['四条大宮', '大宮五条', '七条大宮・京都水族館前', '九条大宮', '千本十条', '城南宮道'];
  return SIG_STOPS.map((name) => {
    const s0 = stopS(name);
    return s0 == null ? null : { s: s0 + 32, name };
  }).filter((sig) => sig && sig.s <= path.length - 30);
}

/**
 * 交通(対向車・同方向の同行車)と交差点信号(各方向の灯器+連動)。
 * update(dt, busS, busPos, busV) を毎ステップ呼ぶ。
 * events: { onCollision(), onRedLight() }
 */
export function buildTraffic(scene, path, events = {}) {
  const g = new THREE.Group();
  scene.add(g);

  // ================= 信号 =================
  // 位相: 自道 青22→黄3→赤17 / 交差道は自道が赤の間に 全赤1→青14→黄2(交差点内で連動)
  const CYCLE = 42, GREEN = 22, YELLOW = 3;
  const mainStateOf = (ph) => (ph < GREEN ? 'green' : ph < GREEN + YELLOW ? 'yellow' : 'red');
  const crossStateOf = (ph) => (ph >= GREEN + YELLOW + 1 && ph < CYCLE - 2 ? 'green' : ph >= CYCLE - 2 ? 'yellow' : 'red');

  const OFF = { green: 0x1c3a24, yellow: 0x4a3d14, red: 0x451818 };
  const ON = { green: 0x2ee86a, yellow: 0xffd23c, red: 0xff4433 };

  const lampGeo = new THREE.SphereGeometry(0.28, 12, 8);
  const housingGeo = new THREE.BoxGeometry(2.25, 0.75, 0.38);
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.09, 5.4, 6);

  /** 横型3灯の灯器。faceHeading 方向に進む車から見える(-z面)。左=青・右=赤(日本式) */
  function makeHead(x, y, z, faceHeading, withHoods = false) {
    const housing = new THREE.Mesh(housingGeo, signalMat(0x23282d));
    housing.position.set(x, y, z);
    housing.rotation.y = faceHeading;
    g.add(housing);
    const lamps = {};
    for (const [key, lx] of [['green', 0.72], ['yellow', 0], ['red', -0.72]]) {
      const lamp = new THREE.Mesh(lampGeo, signalMat(OFF[key]));
      lamp.position.set(lx, 0, -0.24);
      housing.add(lamp);
      lamps[key] = lamp;
      if (withHoods) {
        const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.12, 16, 1, true), signalMat(0x11161a));
        hood.rotation.x = Math.PI / 2;
        hood.position.set(lx, 0, -0.2);
        housing.add(hood);
      }
    }
    return lamps;
  }

  function paintHead(lamps, st) {
    lamps.green.material.color.setHex(st === 'green' ? ON.green : OFF.green);
    lamps.yellow.material.color.setHex(st === 'yellow' ? ON.yellow : OFF.yellow);
    lamps.red.material.color.setHex(st === 'red' ? ON.red : OFF.red);
  }

  const signals = [];
  const signalDefs = route.signals?.length ? route.signals : fallbackSignalPositions(path);
  /** 柱を立て、必要ならアームを渡し、灯器を付ける */
  function buildHead(h) {
    const pole = new THREE.Mesh(poleGeo, mat(0x8a8f94));
    pole.position.set(h.pole[0], 2.7, h.pole[1]);
    g.add(pole);
    if (h.arm) g.add(makeCylinderBetween([h.pole[0], 5.1, h.pole[1]], [h.head[0], 5.1, h.head[1]], 0.06, 0x8a8f94));
    return makeHead(h.head[0], 4.85, h.head[1], h.face, !!h.hoods);
  }

  for (const def of signalDefs) {
    const s = def.s;
    if (s > path.length - 30) continue;
    const mainHeads = [];
    const crossHeads = [];

    if (def.heads?.length) {
      // 設置座標はビルド時に計算済み(route18.json)。ここでは置くだけ
      for (const h of def.heads) (h.kind === 'cross' ? crossHeads : mainHeads).push(buildHead(h));
    } else {
      // フォールバック(--fallback データ等で heads がない場合): ルート接線基準の簡易配置
      const [px, pz] = path.getPoint(s);
      const [tx, tz] = path.getTangent(s);
      const nx = -tz, nz = tx; // lateral 正(右)方向
      const HW = halfWidthAt(s);
      const theta = Math.atan2(tx, tz);
      const at = (lat, ahead) => [px + nx * lat + tx * ahead, pz + nz * lat + tz * ahead];
      mainHeads.push(buildHead({ pole: at(-(HW + 1.7), -5.2), head: at(laneCenterAt(s) - 0.2, -5.2), face: theta, arm: 1, hoods: 1 }));
      mainHeads.push(buildHead({ pole: at(HW + 1.7, 5.2), head: at(-laneCenterAt(s) + 0.2, 5.2), face: theta + Math.PI, arm: 1 }));
      const ch = theta + Math.PI / 2;
      const cd = [Math.sin(ch), Math.cos(ch)];
      for (const dir of [1, -1]) {
        const ax = px - cd[0] * dir * (HW + 2.2) + cd[1] * dir * 4.0;
        const az = pz - cd[1] * dir * (HW + 2.2) - cd[0] * dir * 4.0;
        crossHeads.push(buildHead({ pole: [ax, az], head: [ax + cd[0] * dir * 0.6, az + cd[1] * dir * 0.6], face: dir === 1 ? ch : ch + Math.PI }));
      }
    }

    signals.push({ s, phase: Math.random() * CYCLE, mainHeads, crossHeads, state: null, crossState: null });
  }

  /** 進行方向 dir(+1/-1)の車が s 位置・速度 v で従うべき停止線までの距離(なければ null) */
  function redDistAhead(s, dir, v) {
    let best = null;
    for (const sig of signals) {
      const line = sig.s - 9 * dir;
      const d = (line - s) * dir;
      if (d < -2 || d > 90) continue;
      if (sig.state === 'green') continue;
      const brakeDist = (v * v) / (2 * 2.6);
      if (d < brakeDist - 4) continue;
      if (best == null || d < best) best = d;
    }
    return best;
  }

  /** 交差点(自ルート外)を横切る他車が、交差方向の信号に従って停止すべき残距離(なければ null) */
  function crossRedDist(cc) {
    if (cc.sig.crossState === 'green') return null;
    const distToLine = -cc.off * cc.dir; // 交差点中心までの残距離(正=未到達)
    if (distToLine < -2) return null; // 既に交差点を通過済み
    const brakeDist = (cc.v * cc.v) / (2 * 2.6);
    if (distToLine > Math.max(brakeDist + 4, 20)) return null; // まだ反応する距離ではない
    return distToLine;
  }

  // ================= 車両 =================
  /** dir: +1=同方向(道路左側) / -1=対向(右側)。laneIdx: 0=センター寄り, 1=外側 */
  function laneLat(s, dir, laneIdx = 0) {
    if (dir === 1) {
      const n = fwdLanesAt(s);
      const li = Math.min(laneIdx, n - 1);
      if (backLanesAt(s) === 0) {
        // 一方通行: 道路全幅を n 車線で使う(1車線なら中央)
        const wL = leftWidthAt(s), wR = rightWidthAt(s);
        return -wL + 0.55 + ((wL + wR - 1.1) * (li + 0.5)) / n;
      }
      return -(((leftWidthAt(s) - 0.55) * (li + 0.5)) / n);
    }
    const nB = backLanesAt(s);
    if (nB === 0) return null; // 一方通行区間に対向車は入れない
    const li = Math.min(laneIdx, nB - 1);
    const mag = ((rightWidthAt(s) - 0.55) * (li + 0.5)) / nB;
    // 対向車はやや外側に寄せる(狭い2車線での自車とのすれ違い余裕)。急カーブではさらに外へ
    const curveOut = Math.min(0.9, Math.abs(path.curvatureAt(s)) * 22);
    return mag + 0.4 + curveOut;
  }

  // 区間境界(車線数・幅員の変化点)をまたぐ際、laneLat の目標横位置が瞬時に切り替わって
  // 車が横揺れして見えるのを防ぐため、境界前後 LANE_BLEND [m] で前後区間の値を線形補間する
  // (千本三条 s≈726.2 の3→1車線への合流など、短距離に複数の境界が連続する箇所で特に有効)。
  const LANE_BLEND = 20;
  const SECTION_BOUNDARIES = (route.roadSections ?? [])
    .map((sec) => sec.to)
    .filter((b) => b > 0 && b < path.length);
  function smoothLaneLat(s, dir, laneIdx) {
    for (const b of SECTION_BOUNDARIES) {
      if (s <= b - LANE_BLEND || s >= b + LANE_BLEND) continue;
      const before = laneLat(b - LANE_BLEND - 0.1, dir, laneIdx);
      const after = laneLat(b + LANE_BLEND + 0.1, dir, laneIdx);
      if (before == null || after == null) break; // 一方通行境界等は従来ロジックへ委譲
      const t = Math.min(1, Math.max(0, (s - (b - LANE_BLEND)) / (2 * LANE_BLEND)));
      return before + (after - before) * t;
    }
    return laneLat(s, dir, laneIdx);
  }

  // 二条駅前ロータリー(急カーブ・狭隘)には一般車を入れない
  const TRAFFIC_MIN_S = 360;

  // 対向車(北行き)はこの2交差点(府道201号線・(34.9554,135.7422)地点)を越えて北上せず、
  // 西へ左折して側道へ抜ける(旋回アニメーションの後に消える。heading は交差点を実際に
  // 西へ抜ける道路の実測方位)
  const TURNOFF_POINTS = [
    { s: 6598.7, heading: -1.5931 }, // 府道201号線(西行き一方通行)
    { s: 7672.5, heading: -1.596 },  // (34.955406,135.742175)付近の交差点
  ];

  // 右左折交差点の交錯ゾーン(近接ターンは連結: 狭隘路のS字ジョグ等)
  const turnZones = [];
  for (const t of route.turnIntersections ?? []) {
    const last = turnZones.at(-1);
    if (last && t.sIn - last.to < 45) last.to = Math.max(last.to, t.sOut);
    else turnZones.push({ from: t.sIn, to: t.sOut });
  }

  const ONCOMING_BASE = [
    { make: () => makeCar(0xd8dde2), hitR: 2.0, vMax: 11 },
    { make: () => makeCar(0x7a1f24), hitR: 2.0, vMax: 11.5 },
    { make: () => makeTruck(0x2e5e8c), hitR: 2.35, vMax: 10 },
    { make: () => makeCar(0x30343a), hitR: 2.0, vMax: 11 },
    { make: () => makeOncomingBus(), hitR: 2.8, vMax: 9.5 },
    { make: () => makeCar(0x274a72), hitR: 2.0, vMax: 12 },
    { make: () => makeTruck(0x8c8f6a), hitR: 2.35, vMax: 9.5 },
    { make: () => makeCar(0x9aa3ab), hitR: 2.0, vMax: 11 },
    { make: () => makeCar(0xc8c0a8), hitR: 2.0, vMax: 10.5 },
    { make: () => makeCar(0x5b2231), hitR: 2.0, vMax: 11.5 },
    { make: () => makeTruck(0xd8d8d2), hitR: 2.35, vMax: 10 },
    { make: () => makeCar(0x6f8091), hitR: 2.0, vMax: 12 },
  ];
  const SAME_BASE = [
    { make: () => makeCar(0xe2e4e6), hitR: 2.0, vMax: 11 },
    { make: () => makeCar(0x3f5e48), hitR: 2.0, vMax: 10.5 },
    { make: () => makeTruck(0x7d8288), hitR: 2.35, vMax: 9.5 },
    { make: () => makeCar(0x243a5e), hitR: 2.0, vMax: 11.5 },
    { make: () => makeCar(0xcfc4a2), hitR: 2.0, vMax: 10.5 },
    { make: () => makeTruck(0x8c3a2e), hitR: 2.35, vMax: 9.5 },
  ];
  // 片側2車線以上の区間では対向車・同行車を5倍の体感密度にするため、車種バリエーションを
  // 使い回しつつプールを拡張する(リスポーン位置は多車線区間へ寄せる。1車線区間は従来並み)。
  const DENSITY_FACTOR = 5;
  const expandDefs = (base) => Array.from({ length: base.length * DENSITY_FACTOR }, (_, i) => base[i % base.length]);
  const ONCOMING_DEFS = expandDefs(ONCOMING_BASE);
  const SAME_DEFS = expandDefs(SAME_BASE);

  // sBase 付近(±searchRange)で片側2車線以上の区間があればそこへ寄せたsを返す
  function nearMultiLane(sBase, searchRange = 500, step = 25) {
    const qualifies = (s) => s >= 0 && s <= path.length && fwdLanesAt(s) >= 2 && backLanesAt(s) >= 2;
    if (qualifies(sBase)) return sBase;
    for (let d = step; d <= searchRange; d += step) {
      if (qualifies(sBase + d)) return sBase + d;
      if (qualifies(sBase - d)) return sBase - d;
    }
    return sBase; // 近傍に多車線区間が無ければそのまま(1車線区間は疎らな密度を維持)
  }

  const cars = [];
  ONCOMING_DEFS.forEach((def, i) => {
    const sBase = ((i + 1) / (ONCOMING_DEFS.length + 1)) * path.length;
    cars.push(spawnCar(def, -1, nearMultiLane(sBase), i % 2));
  });
  SAME_DEFS.forEach((def, i) => {
    // 自車(始発)の前方に並べる。走行中はリスポーンで前後に維持される
    cars.push(spawnCar(def, 1, nearMultiLane(400 + i * 180), i % 2));
  });

  function spawnCar(def, dir, s, laneIdx) {
    const inner = def.make();
    const outer = new THREE.Group();
    outer.add(inner);
    g.add(outer);
    return {
      outer, inner, dir, laneIdx,
      hitR: def.hitR, vMax: def.vMax,
      s: Math.max(360, Math.min(path.length - 15, s)),
      v: 6,
      latCur: null,
    };
  }

  // ================= 交差点(自ルート外の交差道路)を横切る他車 =================
  // route.intersections(信号との対応)を利用し、交差する道路上にも信号に従う他車を走らせる。
  // 交差道路自体の実ジオメトリは持たないため、交差点中心(path.getPoint(ix.s))を基準に
  // ix.heading 方向の直線上を走らせる簡易表現(スタブ道路の長さの範囲内)。
  // ix.arms(実在・車線・歩行者専用)を見て、四差路は従来どおり直進往復(mode:'through')、
  // 片側しか実在しないT字路はその腕から本線へ左右どちらかへ旋回合流させる(mode:'tstub')。
  // 実在しない腕・歩行者専用の腕には他車を生成しない。
  const CROSS_DEFS = [
    { make: () => makeCar(0xb9bec4), hitR: 2.0 },
    { make: () => makeCar(0x5b3a3a), hitR: 2.0 },
    { make: () => makeTruck(0x7d8288), hitR: 2.35 },
    { make: () => makeCar(0x33465e), hitR: 2.0 },
    { make: () => makeCar(0xc8c0a8), hitR: 2.0 },
  ];
  const crossCars = [];
  function spawnCrossCar(ix, sig, dir, mode, arm) {
    const def = CROSS_DEFS[crossCars.length % CROSS_DEFS.length];
    const inner = def.make();
    const outer = new THREE.Group();
    outer.add(inner);
    g.add(outer);
    const vMax = 7 + Math.random() * 3;
    if (mode === 'tstub') {
      // 腕(side)の外側寄りに出現し、中心(本線)へ向かって進む(進行方向は常に中心向き)
      const armLen = Math.max(24, arm.length ?? 60);
      const off = arm.side * (Math.max(20, armLen * 0.35) + Math.random() * (armLen * 0.5));
      return {
        ix, sig, dir: -arm.side, mode, arm, off,
        v: 6, vMax, hitR: def.hitR,
        phase: 'approach', turnT: 0, turnArc: null,
        outer, inner,
      };
    }
    const range = Math.max(16, Math.min(60, (ix.length ?? 40) / 2 - 4));
    return {
      ix, sig, dir, mode: 'through', range,
      off: (Math.random() * 1.6 - 0.8) * range,
      v: 6, vMax, hitR: def.hitR,
      outer, inner,
    };
  }
  for (const sig of signals) {
    let nearestIx = null, bestD = 28;
    for (const ix of route.intersections ?? []) {
      const d = Math.abs(ix.s - sig.s);
      if (d < bestD) { bestD = d; nearestIx = ix; }
    }
    if (!nearestIx) continue;
    const armPos = nearestIx.arms?.find((a) => a.side === 1);
    const armNeg = nearestIx.arms?.find((a) => a.side === -1);
    const bothThrough = armPos?.exists && !armPos.pedestrian && armNeg?.exists && !armNeg.pedestrian;
    if (!nearestIx.arms?.length || bothThrough) {
      // 従来どおり(四差路、または腕情報がない旧データへのフォールバック): 直進往復
      crossCars.push(spawnCrossCar(nearestIx, sig, 1, 'through'));
      crossCars.push(spawnCrossCar(nearestIx, sig, -1, 'through'));
    } else {
      // T字路: 実在し、かつ車道(非歩行者専用)の腕だけに他車を生成し、本線へ旋回合流させる
      for (const arm of [armPos, armNeg]) {
        if (!arm?.exists || arm.pedestrian) continue;
        crossCars.push(spawnCrossCar(nearestIx, sig, arm.side, 'tstub', arm));
      }
    }
  }

  let collisionCooldown = 0;
  let lastBusS = 0;

  return {
    signals,
    update(dt, busS, busPos, busV) {
      // ---- 信号の位相更新(交差点内で main/cross 連動) ----
      for (const sig of signals) {
        sig.phase = (sig.phase + dt) % CYCLE;
        const st = mainStateOf(sig.phase);
        const cst = crossStateOf(sig.phase);
        if (st !== sig.state) {
          sig.state = st;
          for (const h of sig.mainHeads) paintHead(h, st);
        }
        if (cst !== sig.crossState) {
          sig.crossState = cst;
          for (const h of sig.crossHeads) paintHead(h, cst);
        }
        // 赤信号無視(自車): 停止線(交差点 9m 手前)を v>1.5 で通過
        const lineS = sig.s - 9;
        if (sig.state === 'red' && lastBusS < lineS && busS >= lineS && busV > 1.5) {
          events.onRedLight?.();
        }
      }
      lastBusS = busS;

      // 自車が赤信号停止線の直前か(同行車の追い越し抑制に使う)
      const busRedD = redDistAhead(busS, 1, busV);
      const busHeldAtSignal = busRedD != null && busRedD < 22;

      // ---- 車両 ----
      for (let ci = cars.length - 1; ci >= 0; ci--) {
        const c = cars[ci];
        // 左折旋回中(府道201号線などへの離脱): 弧長ベースでなめらかに進め、完了で消える
        if (c.turnArc) {
          c.v += (Math.min(c.vMax, 8) - c.v) * Math.min(1, dt * 1.6);
          c.turnT += (c.v * dt) / c.turnArc.length;
          if (c.turnT >= 1) {
            g.remove(c.outer);
            cars.splice(ci, 1);
            continue;
          }
          const samp = sampleTurnArc(c.turnArc, c.turnT);
          c.outer.position.set(samp.x, elevationAt(c.s), samp.z);
          c.outer.rotation.y = samp.heading;
          if (collisionCooldown <= 0) {
            const ddx = c.outer.position.x - busPos[0];
            const ddz = c.outer.position.z - busPos[1];
            if (ddx * ddx + ddz * ddz < c.hitR * c.hitR) {
              collisionCooldown = 4;
              events.onCollision?.();
            }
          }
          continue;
        }
        // 目標速度
        let vT = Math.min(c.vMax, speedLimitAt(c.s) * 1.05);
        const k = Math.abs(path.curvatureAt(c.s));
        if (k > 1e-4) vT = Math.min(vT, Math.max(3.5, Math.sqrt(2.4 / k)));

        // 信号停止
        const dRed = redDistAhead(c.s, c.dir, c.v);
        if (dRed != null) vT = Math.min(vT, dRed < 1 ? 0 : Math.sqrt(2 * 1.8 * Math.max(0, dRed - 1.5)));

        // 前方車追従(同方向・同レーン近傍)
        for (const o of cars) {
          if (o === c || o.dir !== c.dir) continue;
          const gap = (o.s - c.s) * c.dir;
          if (gap > 0 && gap < 55 && Math.abs((o.latCur ?? 0) - (c.latCur ?? 0)) < 1.6) {
            vT = Math.min(vT, Math.max(0, (gap - 9) * 0.6));
          }
        }

        // 同行車: 自車(プレイヤーのバス)との車間・追い越し
        let latT = smoothLaneLat(c.s, c.dir, c.laneIdx);
        const inOneway = latT == null; // 対向車が一方通行区間に入った → 実在しないのでリスポーン
        if (inOneway) latT = c.latCur ?? 2.5;
        // 対向車: 府道201号線・(34.9554,...)地点で西へ左折させる(その交差点通過時のみ)。
        // s以下すべてで真にすると北側の対向車が全滅するので、交差点手前55m以内の帯域に限定する。
        // 一度だけ旋回アーク(現在位置→交差道路の実方位)を作り、以降は上のブロックが処理する。
        const turnPoint = c.dir === -1 ? TURNOFF_POINTS.find((p) => c.s <= p.s && c.s > p.s - 55) : null;
        if (turnPoint) {
          const sx = c.outer.position.x, sz = c.outer.position.z;
          const startHeading = c.outer.rotation.y;
          const [cx, cz] = path.getPoint(turnPoint.s);
          const hx = Math.sin(turnPoint.heading), hz = Math.cos(turnPoint.heading);
          const end = [cx + hx * 26, cz + hz * 26];
          const ctrl = [sx + Math.sin(startHeading) * 12, sz + Math.cos(startHeading) * 12];
          c.turnArc = buildTurnArc([sx, sz], ctrl, end);
          c.turnT = 0;
          continue;
        }
        // 対向車: 狭い2車線でバスと接近したら減速して外側に待避(狭隘路の譲り合い)
        if (c.dir === -1 && lanesAt(c.s) <= 2) {
          const ahead = c.s - busS; // すれ違い前は正
          if (ahead > -14 && ahead < 45) {
            vT = Math.min(vT, 5.5);
            latT += 0.5;
          }
        }
        // 対向車: バスが右左折交差点を通過する間はゾーン手前で待つ(交差点内での交錯防止)。
        // 停止線は出口の膨らみゾーンの外(to+26)に置き、バスの膨らみが収まるまで解除しない
        if (c.dir === -1) {
          for (const z of turnZones) {
            if (busS > z.from - 35 && busS < z.to + 25 && c.s > z.to) {
              const d = c.s - (z.to + 26);
              if (d < 55) vT = Math.min(vT, d < 1 ? 0 : Math.sqrt(2 * 1.8 * Math.max(0, d - 1.5)));
              break;
            }
          }
        }
        if (c.dir === 1) {
          const gapBus = busS - c.s;
          const sameLane = Math.abs((c.latCur ?? latT) - laneLat(c.s, 1, 1)) < 2.2 || lanesAt(c.s) <= 2;
          // 1車線(片道1車線)の道ではバスが停車中でも追い越さず、そのまま後ろで待つ
          if (gapBus > -16 && gapBus < 55 && sameLane && gapBus > 0) {
            vT = Math.min(vT, Math.max(0, (gapBus - 11) * 0.55)); // 車間維持
          }
        }

        // 速度・位置更新
        const rate = vT < c.v ? 2.6 : 0.9;
        c.v += (vT - c.v) * Math.min(1, dt * rate);
        c.s += c.v * dt * c.dir;

        // リスポーン: 経路端・駅前ロータリー・自車から離れすぎ・一方通行進入 → 自車の周辺へ
        // (左折地点通過は上で旋回アークへ切り替え済みのためここでは扱わない)
        const rel = (c.s - busS) * 1;
        if (c.s < TRAFFIC_MIN_S || c.s > path.length - 15 || Math.abs(rel) > 1800 || inOneway) {
          if (c.dir === 1) {
            const behind = Math.random() < 0.4;
            const off = behind ? -(160 + Math.random() * 380) : 250 + Math.random() * 900;
            const s1 = Math.max(TRAFFIC_MIN_S, Math.min(path.length - 15, busS + off));
            c.s = nearMultiLane(s1, 300); // 片側2車線以上の区間があれば近傍で密度を上げる
          } else {
            // 対向車は一方通行(対向車線なし)の区間を避け、片側2車線以上の区間に寄せて配置
            let s2 = nearMultiLane(Math.max(TRAFFIC_MIN_S, Math.min(path.length - 15, busS + 400 + Math.random() * 1200)), 300);
            for (let k = 0; k < 40 && backLanesAt(s2) === 0; k++) s2 = Math.min(path.length - 15, s2 + 60);
            if (backLanesAt(s2) === 0) s2 = Math.max(TRAFFIC_MIN_S, busS - 300); // 前方に空きがなければ後方
            c.s = s2;
          }
          c.v = 6;
          c.latCur = null;
          latT = laneLat(c.s, c.dir, c.laneIdx) ?? 0;
        }

        // 横位置(レーンチェンジは滑らかに)
        if (c.latCur == null) c.latCur = latT;
        c.latCur += (latT - c.latCur) * Math.min(1, dt * 1.7);

        const [px, pz] = path.getPoint(c.s);
        const [tx, tz] = path.getTangent(c.s);
        c.outer.position.set(px + -tz * c.latCur, elevationAt(c.s), pz + tx * c.latCur);
        c.outer.rotation.y = Math.atan2(tx * c.dir, tz * c.dir);
        c.inner.rotation.x = Math.atan(gradeAt(c.s)) * -c.dir; // 勾配ピッチ(向きに応じて符号)

        // 自車との衝突判定
        if (collisionCooldown <= 0) {
          const dx = c.outer.position.x - busPos[0];
          const dz = c.outer.position.z - busPos[1];
          if (dx * dx + dz * dz < c.hitR * c.hitR) {
            collisionCooldown = 4;
            events.onCollision?.();
          }
        }
      }
      collisionCooldown = Math.max(0, collisionCooldown - dt);

      // ---- 交差点(自ルート外)の他車: 信号(交差方向)に従って走行 ----
      for (let ci = crossCars.length - 1; ci >= 0; ci--) {
        const cc = crossCars[ci];

        // T字路: 本線の縁まで到達し、旋回合流アークを走行中 → 完了したら cars[] へ正式合流
        if (cc.phase === 'turn') {
          cc.v += (Math.min(cc.vMax, 8) - cc.v) * Math.min(1, dt * 1.8);
          cc.turnT += (cc.v * dt) / cc.turnArc.length;
          if (cc.turnT >= 1) {
            cars.push({
              outer: cc.outer, inner: cc.inner, dir: cc.mergeDir, laneIdx: 0,
              hitR: cc.hitR, vMax: cc.vMax, s: cc.mergeS, v: cc.v, latCur: cc.mergeLat,
            });
            crossCars.splice(ci, 1);
            continue;
          }
          const samp = sampleTurnArc(cc.turnArc, cc.turnT);
          cc.outer.position.set(samp.x, elevationAt(cc.ix.s), samp.z);
          cc.outer.rotation.y = samp.heading;
          if (collisionCooldown <= 0) {
            const ddx = cc.outer.position.x - busPos[0];
            const ddz = cc.outer.position.z - busPos[1];
            if (ddx * ddx + ddz * ddz < cc.hitR * cc.hitR) {
              collisionCooldown = 4;
              events.onCollision?.();
            }
          }
          continue;
        }

        let vT = cc.vMax;
        // 同行車と同じ「速度依存のブレーキ距離ゲート」を使い、赤信号では停止線通過直前・
        // 直後で解除せず、青になるまで確実に止まり続ける(交差点内での立ち往生バグの修正)
        const dRed = crossRedDist(cc);
        if (dRed != null) vT = Math.min(vT, dRed < 1 ? 0 : Math.sqrt(2 * 1.8 * Math.max(0, dRed - 1.5)));
        cc.v += (vT - cc.v) * Math.min(1, dt * 2.2);
        cc.off += cc.v * dt * cc.dir;

        if (cc.mode === 'tstub') {
          // 本線の縁に到達したら直進させず、左右どちらかへ旋回して本線へ合流させる
          const edge = (cc.ix.width ?? 8) / 2 + 3;
          if (Math.abs(cc.off) < edge) {
            const s0 = Math.max(0, Math.min(path.length, cc.ix.s));
            const [px, pz] = path.getPoint(s0);
            const hx = Math.sin(cc.ix.heading), hz = Math.cos(cc.ix.heading);
            const laneOff = 2.6 * (cc.dir > 0 ? 1 : -1);
            const start = [px + hx * cc.off + hz * laneOff, pz + hz * cc.off - hx * laneOff];
            const startHeading = cc.dir > 0 ? cc.ix.heading : cc.ix.heading + Math.PI;
            const mergeDir = Math.random() < 0.5 ? 1 : -1;
            const mergeS = Math.max(30, Math.min(path.length - 30, s0 + mergeDir * 16));
            const mergeLat = laneLat(mergeS, mergeDir, 0) ?? 0;
            const [mpx, mpz] = path.getPoint(mergeS);
            const [mtx, mtz] = path.getTangent(mergeS);
            const end = [mpx + -mtz * mergeLat, mpz + mtx * mergeLat];
            const ctrl = [start[0] + Math.sin(startHeading) * 12, start[1] + Math.cos(startHeading) * 12];
            cc.turnArc = buildTurnArc(start, ctrl, end);
            cc.turnT = 0;
            cc.phase = 'turn';
            cc.mergeDir = mergeDir;
            cc.mergeS = mergeS;
            cc.mergeLat = mergeLat;
            continue;
          }
        } else if (cc.off > cc.range || cc.off < -cc.range) {
          cc.off = -Math.sign(cc.dir) * cc.range;
          cc.v = 6;
        }

        const s = Math.max(0, Math.min(path.length, cc.ix.s));
        const [px, pz] = path.getPoint(s);
        const hx = Math.sin(cc.ix.heading), hz = Math.cos(cc.ix.heading);
        const laneOff = 2.6 * (cc.dir > 0 ? 1 : -1); // 左側通行(進行方向の左に寄せる)
        cc.outer.position.set(px + hx * cc.off + hz * laneOff, elevationAt(s), pz + hz * cc.off - hx * laneOff);
        cc.outer.rotation.y = cc.dir > 0 ? cc.ix.heading : cc.ix.heading + Math.PI;

        // 自車との衝突判定(交差する道路を走る他車にも当たり判定をつける)
        if (collisionCooldown <= 0) {
          const ddx = cc.outer.position.x - busPos[0];
          const ddz = cc.outer.position.z - busPos[1];
          if (ddx * ddx + ddz * ddz < cc.hitR * cc.hitR) {
            collisionCooldown = 4;
            events.onCollision?.();
          }
        }
      }
    },
    /** autoDrive 用: 前方の同方向車(同一レーン近傍)までの車間 [m](なければ null) */
    leadGapAhead(busS, busLat, maxDist = 60) {
      let best = null;
      for (const c of cars) {
        if (c.dir !== 1) continue;
        const gap = c.s - busS;
        if (gap > 2 && gap < maxDist && Math.abs((c.latCur ?? 0) - busLat) < 1.8) {
          if (best == null || gap < best) best = gap;
        }
      }
      return best;
    },
    /** 直近の信号情報(HUD 用) */
    nextSignal(busS) {
      let best = null;
      for (const sig of signals) {
        const d = sig.s - busS;
        if (d > -5 && (best == null || d < best.d)) best = { d, state: sig.state };
      }
      return best;
    },
    /**
     * autoDrive 用: 前方の止まるべき信号の停止線 s(なければ null)。
     * 黄は停止可能距離があるときのみ止まる。青は残り時間を読まず進む。
     */
    redStopTarget(busS, busV) {
      const d = redDistAhead(busS, 1, busV);
      return d == null ? null : busS + d;
    },
  };
}
