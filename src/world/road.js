import * as THREE from 'three';
import { CFG } from '../config.js';
import { elevationAt, halfWidthAt } from '../route/routeData.js';

/**
 * 経路に沿った帯(リボン)ジオメトリを生成
 * latFrom/latTo: 横偏差(左が負) / sStep: サンプリング間隔
 */
export function makeRibbon(path, latFrom, latTo, y, sFrom = 0, sTo = null, sStep = 4) {
  sTo = sTo ?? path.length;
  const positions = [];
  const indices = [];
  let row = 0;
  for (let s = sFrom; s <= sTo + 0.001; s += sStep) {
    const ss = Math.min(s, sTo);
    const [px, pz] = path.getPoint(ss);
    const [tx, tz] = path.getTangent(ss);
    // 左法線 = (tz, -tx) が lateral 負方向(path.closestS の符号系と整合)
    const nx = -tz, nz = tx; // lateral 正(右)方向
    const ye = y + elevationAt(ss); // 跨線橋区間は路面ごと持ち上げる
    positions.push(px + nx * latFrom, ye, pz + nz * latFrom);
    positions.push(px + nx * latTo, ye, pz + nz * latTo);
    if (row > 0) {
      const b = row * 2;
      indices.push(b - 2, b - 1, b, b - 1, b + 1, b);
    }
    row++;
    if (ss >= sTo) break;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function roadSectionsFor(path, route) {
  if (route?.roadSections?.length) return route.roadSections;
  return [{ from: 0, to: path.length, lanes: 2 }];
}

function roadHalfWidth(lanes = 2) {
  return Math.max(CFG.road.halfWidth, lanes * 1.6 + 0.8);
}

function addLine(g, path, lat, y, color, sFrom, sTo, width = 0.06) {
  const mat = new THREE.MeshLambertMaterial({ color });
  g.add(new THREE.Mesh(makeRibbon(path, lat - width, lat + width, y, sFrom, sTo, 3), mat));
}

/** [from,to] から gaps([[g0,g1],…])を抜いた小区間のリストを返す */
function splitRanges(from, to, gaps) {
  let ranges = [[from, to]];
  for (const [g0, g1] of gaps) {
    const next = [];
    for (const [a, b] of ranges) {
      if (g1 <= a || g0 >= b) { next.push([a, b]); continue; }
      if (g0 > a) next.push([a, g0]);
      if (g1 < b) next.push([g1, b]);
    }
    ranges = next;
  }
  return ranges.filter(([a, b]) => b - a > 0.5);
}

function addIntersections(g, path, intersections, turns = []) {
  const roadMat = new THREE.MeshLambertMaterial({ color: CFG.colors.road });
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.52 });
  for (const ix of intersections ?? []) {
    // 右左折交差点の近傍は addTurnIntersections が本物の交差を描くのでスキップ
    if (turns.some((t) => ix.s > t.sIn - 28 && ix.s < t.sOut + 28)) continue;
    const s = Math.max(0, Math.min(path.length - 0.1, ix.s));
    const [px, pz] = path.getPoint(s);
    const width = Math.max(5.5, ix.width ?? 7);
    const length = Math.max(28, ix.length ?? 54);
    const elev = elevationAt(s);
    const stub = new THREE.Mesh(new THREE.PlaneGeometry(length, width), roadMat);
    stub.rotation.x = -Math.PI / 2;
    stub.rotation.z = -(ix.heading ?? 0);
    stub.position.set(px, 0.006 + elev, pz);
    g.add(stub);

    const [tx, tz] = path.getTangent(s);
    const cw = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(9, roadHalfWidth(ix.lanes ?? 2) * 2), 2.8), lineMat);
    cw.rotation.x = -Math.PI / 2;
    cw.rotation.z = -Math.atan2(tx, tz);
    cw.position.set(px, 0.034 + elev, pz);
    g.add(cw);
  }
}

/**
 * 右左折交差点: 経路が折れる地点を「道路同士の交差」として描く。
 * 離脱する道路(headingIn)は交差点の先へ直進し、曲がった先の道路(headingOut)は
 * 交差点の向こう(後方)へも続く。交差点ボックス内は無地舗装、各脚に横断歩道。
 */
function addTurnIntersections(g, path, turns) {
  const C = CFG.colors;
  const roadMat = new THREE.MeshLambertMaterial({ color: C.road });
  const lineMat = (color) => new THREE.MeshBasicMaterial({ color });
  const cwMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.52 });
  const STUB_LEN = 42;

  const flat = (grp, w, l, y, z, material) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), material);
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, y, z);
    grp.add(m);
    return m;
  };

  for (const t of turns ?? []) {
    const elev = elevationAt(t.s);
    const hwIn = t.hwIn ?? halfWidthAt(Math.max(0, t.sIn - 1));
    const hwOut = t.hwOut ?? halfWidthAt(t.sOut + 1);
    const dIn = t.d ?? Math.hypot(t.x - path.getPoint(Math.max(0, t.sIn))[0], t.z - path.getPoint(Math.max(0, t.sIn))[1]);
    const dOut = dIn; // フィレットの接点距離は進入側・退出側で同一

    // 各「腕」= 交差点を貫く1本の道路。zSpan: 舗装矩形の範囲(ローカルz、+z=heading方向)
    // gap: 交差点ボックス縁(頂点からの距離)。ここから外側にのみ区画線・縁石・歩道を引く
    const arms = [
      { heading: t.headingIn, hw: hwIn, crossHw: hwOut, zSpan: [-(dIn + 2), STUB_LEN], furniture: [[hwOut + 2, STUB_LEN - 1]] },
      { heading: t.headingOut, hw: hwOut, crossHw: hwIn, zSpan: [-STUB_LEN, dOut + 2], furniture: [[-(STUB_LEN - 1), -(hwIn + 2)]] },
    ];

    for (const arm of arms) {
      const grp = new THREE.Group();
      grp.position.set(t.x, elev, t.z);
      grp.rotation.y = arm.heading;
      g.add(grp);

      // 舗装(路面 y=0 と区画線 y=0.02+ の間)
      const [z0, z1] = arm.zSpan;
      flat(grp, arm.hw * 2, z1 - z0, 0.005, (z0 + z1) / 2, roadMat);

      // 交差点ボックスの外側: センターライン・路側線・縁石・歩道(extraRoads と同パターン)
      for (const [f0, f1] of arm.furniture) {
        const len = f1 - f0;
        if (len < 2) continue;
        const mid = (f0 + f1) / 2;
        flat(grp, 0.16, len, 0.02, mid, lineMat(0xd8a017));
        for (const side of [-1, 1]) {
          const off = (w) => {
            const m = flat(grp, w.w, len, w.y, mid, w.m);
            m.position.x = side * w.x;
            return m;
          };
          off({ w: 0.14, x: arm.hw - 0.45, y: 0.02, m: lineMat(C.roadLine) });
          off({ w: 0.5, x: arm.hw + 0.25, y: 0.13, m: new THREE.MeshLambertMaterial({ color: C.curb }) });
          off({ w: 2.7, x: arm.hw + 1.85, y: 0.1, m: new THREE.MeshLambertMaterial({ color: 0xcfd2cc }) });
        }
      }

      // 横断歩道(ボックスの前後の縁)
      const cw = arm.crossHw + 3.6;
      flat(grp, arm.hw * 2, 2.8, 0.034, cw, cwMat);
      flat(grp, arm.hw * 2, 2.8, 0.034, -cw, cwMat);
    }

    // 四隅の歩道パッチ: 両道路の歩道帯(路端 +1.85m)が交わる点に正方形を置く
    const nA = [Math.cos(t.headingIn), -Math.sin(t.headingIn)];   // 道路Aの横方向単位ベクトル
    const nB = [Math.cos(t.headingOut), -Math.sin(t.headingOut)];
    const det = nA[0] * nB[1] - nA[1] * nB[0]; // = sin(headingIn - headingOut)
    if (Math.abs(det) > 0.3) {
      const walkMat = new THREE.MeshLambertMaterial({ color: 0xcfd2cc });
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const a = sa * (hwIn + 1.85), b = sb * (hwOut + 1.85);
          const px = (a * nB[1] - b * nA[1]) / det;
          const pz = (b * nA[0] - a * nB[0]) / det;
          const patch = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 3.8), walkMat);
          patch.rotation.x = -Math.PI / 2;
          patch.rotation.z = -t.headingIn;
          patch.position.set(t.x + px, elev + 0.1, t.z + pz);
          g.add(patch);
        }
      }
    }
  }
}

/** 道路一式(路面・センターライン・路側線・縁石・歩道)を返す */
export function buildRoad(path, route = null) {
  const g = new THREE.Group();
  const C = CFG.colors;
  const mat = (color) => new THREE.MeshLambertMaterial({ color });
  const sections = roadSectionsFor(path, route);
  const turns = route?.turnIntersections ?? [];
  // 右左折交差点の円弧区間では線・縁石・歩道を途切れさせる(路面は連続)
  const gaps = turns.map((t) => [t.sIn - 2, t.sOut + 2]);

  for (const section of sections) {
    const from = Math.max(0, section.from ?? 0);
    const to = Math.min(path.length, section.to ?? path.length);
    if (to <= from) continue;
    const lanes = Math.max(2, Number(section.lanes) || 2);
    const HW = roadHalfWidth(lanes);

    // 路面(交差点円弧の下も含め連続 — バスの走行面)
    g.add(new THREE.Mesh(makeRibbon(path, -HW, HW, 0.0, from, to), mat(C.road)));

    for (const [f, tt] of splitRanges(from, to, gaps)) {
      // センターライン(黄色実線)
      g.add(new THREE.Mesh(makeRibbon(path, -0.08, 0.08, 0.024, f, tt, 3), mat(0xd8a017)));

      // 車線境界(方向別に1車線を超える場合のみ白線)
      const leftLanes = Math.max(1, Math.floor(lanes / 2));
      const rightLanes = Math.max(1, lanes - leftLanes);
      const usableLeft = HW - 0.55;
      const usableRight = HW - 0.55;
      for (let i = 1; i < leftLanes; i++) addLine(g, path, -(usableLeft * i) / leftLanes, 0.026, C.roadLine, f, tt, 0.035);
      for (let i = 1; i < rightLanes; i++) addLine(g, path, (usableRight * i) / rightLanes, 0.026, C.roadLine, f, tt, 0.035);

      // 路側線(白実線)
      g.add(new THREE.Mesh(makeRibbon(path, -HW + 0.35, -HW + 0.5, 0.025, f, tt, 3), mat(C.roadLine)));
      g.add(new THREE.Mesh(makeRibbon(path, HW - 0.5, HW - 0.35, 0.025, f, tt, 3), mat(C.roadLine)));

      // 縁石
      g.add(new THREE.Mesh(makeRibbon(path, -HW - 0.5, -HW, 0.13, f, tt), mat(C.curb)));
      g.add(new THREE.Mesh(makeRibbon(path, HW, HW + 0.5, 0.13, f, tt), mat(C.curb)));

      // 歩道
      g.add(new THREE.Mesh(makeRibbon(path, -HW - 3.2, -HW - 0.5, 0.1, f, tt), mat(0xcfd2cc)));
      g.add(new THREE.Mesh(makeRibbon(path, HW + 0.5, HW + 3.2, 0.1, f, tt), mat(0xcfd2cc)));
    }
  }

  addIntersections(g, path, route?.intersections ?? [], turns);
  addTurnIntersections(g, path, turns);

  return g;
}

/** 地面(経路バウンディングボックス+マージンの1枚板) */
export function buildGround(path) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of path.points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const m = 600;
  const w = maxX - minX + m * 2, h = maxZ - minZ + m * 2;
  const geo = new THREE.PlaneGeometry(w, h);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: CFG.colors.ground }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((minX + maxX) / 2, -0.05, (minZ + maxZ) / 2);
  return mesh;
}
