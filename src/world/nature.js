import * as THREE from "three";
import {
  route,
  leftWidthAt,
  rightWidthAt,
  turnExclusions,
  elevationAt,
} from "../route/routeData.js";
import { loadProps } from "../util/propsLib.js";
import { clippedRiverPoints } from "./road.js";

const mat = (color, opts = {}) =>
  new THREE.MeshLambertMaterial({ color, ...opts });

// 川底を地表(y=0)より低く見せる深さ[m]。橋は road.js のデッキ(elevationAt)がそのまま
// 川の上を跨ぐので、川岸ぶんだけ相対的に「道路が高く・川が低く」見える。
const RIVER_DEPTH = 3.2;
const BANK_TIERS = [
  { h: 1.2, w: 6, color: 0x7ba15e }, // 上段: 芝の土手
  { h: RIVER_DEPTH - 1.2, w: 4.5, color: 0x9c9178 }, // 下段: 護岸(土)
];
const BRIDGE_RAIL_CLEARANCE = 1.1; // 車道端から欄干中心まで [m]
const RAIL_SEGMENT_LENGTH = 8; // 曲線区間でも道路から外れないよう分割描画 [m]

/**
 * 川(鴨川・桂川・西高瀬川)・橋・遠景の山・街路樹
 * 川は bridges の s 位置で経路と直交する帯として描く。川底は RIVER_DEPTH ぶん低く、
 * 土手は段状(芝→護岸)に地表から水面まで下る。
 */
export function buildNature(scene, path) {
  const g = new THREE.Group();
  scene.add(g);
  const exclusions = [];

  // ---- 川と橋 ----
  // 実測ポリライン(route.rivers。tools/build-route-data.mjs が OSM waterway から切り出し
  // ゲーム座標へ投影済み)があればそれに沿ったリボンとして川を描く。
  // 経路との交差角は橋によって様々で、4橋とも実際にはほぼ並走に近い浅い角度(-6°〜21°)
  // でしか交差しない。旧実装は「橋の直交方向(across)に2枚を177mずつ離して置く」前提
  // だったため、浅い角度の橋では水面が経路から100m以上離れた場所へ飛んでしまい、
  // (1) 運転中は川が全く見えず、(2) その飛んだ水面・土手の巨大な板(340m×高々数m)が
  // 遠景に不自然に突き刺さって見える、という2つの不具合が同時に起きていた。
  // 経路直近に水面を1枚センターで置くリボン方式に置き換えることで両方を解消する。

  /** points に沿った帯ジオメトリ(offFrom/offTo は各頂点の進行方向に対する左法線オフセット) */
  function ribbonGeometry(points, offFrom, offTo, y) {
    const positions = [];
    const indices = [];
    for (let i = 0; i < points.length; i++) {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const dx = next[0] - prev[0],
        dz = next[1] - prev[1];
      const l = Math.hypot(dx, dz) || 1e-9;
      const nx = -dz / l,
        nz = dx / l;
      const p = points[i];
      positions.push(p[0] + nx * offFrom, y, p[1] + nz * offFrom);
      positions.push(p[0] + nx * offTo, y, p[1] + nz * offTo);
      if (i > 0) {
        const b = i * 2;
        indices.push(b - 2, b - 1, b, b - 1, b + 1, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  /** 道路の曲線に追従する欄干を短い箱の連続として描く */
  function addBridgeRail(side, fromS, toS) {
    for (let s = fromS; s < toS; s += RAIL_SEGMENT_LENGTH) {
      const nextS = Math.min(toS, s + RAIL_SEGMENT_LENGTH);
      const midS = (s + nextS) / 2;
      const [rx, rz] = path.getPoint(midS);
      const [tx, tz] = path.getTangent(midS);
      const nx = -tz,
        nz = tx;
      const roadEdge =
        side < 0 ? leftWidthAt(midS) : rightWidthAt(midS);
      const railOffset = roadEdge + BRIDGE_RAIL_CLEARANCE;
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(
          0.35,
          1.15,
          Math.max(0.5, nextS - s + 0.2),
        ),
        mat(0xdfe3e6),
      );
      rail.position.set(
        rx + nx * side * railOffset,
        elevationAt(midS) + 0.85,
        rz + nz * side * railOffset,
      );
      rail.rotation.y = Math.atan2(tx, tz);
      g.add(rail);
    }
  }

  for (const br of route.bridges) {
    const [px, pz] = path.getPoint(br.s);
    const [tx, tz] = path.getTangent(br.s);
    const roadHeading = Math.atan2(tx, tz); // 経路方位(橋桁・欄干は道路に沿わせる)
    const w = Math.max(18, br.length * 0.85); // 川幅
    const halfW = w / 2;
    const deckElev = elevationAt(br.s); // 跨線橋等と重なる場合は路面高さに追従
    // 久我橋・天神橋は従来の「川幅+10m」を橋桁にも流用していたため、
    // 端部の欄干が接続道路まで伸びていた。橋桁と欄干は実際の川幅相当の
    // スパンに揃え、その他の橋の見た目は従来値を維持する。
    const bridgeSpan =
      br.name === "久我橋(桂川)" || br.name === "天神橋(西高瀬川)"
        ? w
        : w + 10;

    // 実測ポリライン(同一河川の隣接橋まで届く分は road.js の clippedRiverPoints で
    // 橋の直近だけに切り詰め済み)。buildGround(road.js)の地面沈み込みと必ず
    // 同じ範囲を使うことで、水面・土手の見た目と地面の沈み込みを一致させる
    // (切り詰めを両者で別々に行うと、一方だけ範囲が違って橋が実際より短く/
    // 浮いて見える不整合が出ていた)。
    const points = clippedRiverPoints(path, br, route.rivers);

    // 水面(地表より RIVER_DEPTH 低い)
    g.add(
      new THREE.Mesh(
        ribbonGeometry(points, -halfW, halfW, -RIVER_DEPTH + 0.05),
        mat(0x4fa8d8),
      ),
    );
    // 土手(地表→水面の段状斜面)。両岸・両段(BANK_TIERS)で計4本のリボン。
    for (const bankSide of [-1, 1]) {
      let yTop = 0,
        distFromWater = halfW;
      for (const tier of BANK_TIERS) {
        const yMid = yTop - tier.h / 2;
        const from = bankSide * distFromWater;
        const to = bankSide * (distFromWater + tier.w);
        g.add(
          new THREE.Mesh(
            ribbonGeometry(
              points,
              Math.min(from, to),
              Math.max(from, to),
              yMid,
            ),
            mat(tier.color),
          ),
        );
        yTop -= tier.h;
        distFromWater += tier.w;
      }
    }
    // 川沿いには建物を置かない(ポリライン各点に沿って除外円を並べる)
    for (const [rx, rz] of points)
      exclusions.push({ x: rx, z: rz, r: halfW + 24 });

    // 小枝橋の路面は road.js の高架区間が正しい幅・標高で描いているため、
    // ここで別のBoxGeometryを重ねない。重複した橋桁が視点によって板状に見える原因になる。
    // その他の河川橋だけ薄い下部桁を残す。
    if (br.name !== "小枝橋(鴨川)") {
      const leftEdge = leftWidthAt(br.s) + BRIDGE_RAIL_CLEARANCE;
      const rightEdge = rightWidthAt(br.s) + BRIDGE_RAIL_CLEARANCE;
      const deck = new THREE.Mesh(
        new THREE.BoxGeometry(leftEdge + rightEdge, 0.8, bridgeSpan),
        mat(0x8f9499),
      );
      const deckCenterLat = (rightEdge - leftEdge) / 2;
      deck.position.set(px, deckElev - 0.48, pz);
      deck.position.x += -tz * deckCenterLat;
      deck.position.z += tx * deckCenterLat;
      deck.rotation.y = roadHeading;
      g.add(deck);
    }
    const railFrom = Math.max(0, br.s - bridgeSpan / 2);
    const railTo = Math.min(path.length, br.s + bridgeSpan / 2);
    for (const side of [-1, 1])
      addBridgeRail(side, railFrom, railTo);
  }

  // ---- 遠景の山(北・東・西 — 京都盆地) ----
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const [x, z] of path.points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const cx = (minX + maxX) / 2;
  const mountainMat = mat(0x6d8577);
  const mk = (x, z, r, h) => {
    const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mountainMat);
    m.position.set(x, 0, z);
    g.add(m);
  };
  // 北山(二条駅の北)
  for (let i = 0; i < 6; i++)
    mk(
      cx - 900 + i * 420,
      minZ - 750 - (i % 2) * 160,
      520 + (i % 3) * 130,
      260 + (i % 2) * 110,
    );
  // 東山(左手)
  for (let i = 0; i < 7; i++)
    mk(
      maxX + 950 + (i % 2) * 200,
      minZ + 300 + i * 640,
      480 + (i % 3) * 120,
      230 + (i % 3) * 80,
    );
  // 西山(右手)
  for (let i = 0; i < 6; i++)
    mk(
      minX - 980 - (i % 2) * 240,
      minZ + 500 + i * 700,
      560 + (i % 3) * 140,
      280 + (i % 2) * 100,
    );

  // ---- 街路樹(Blender製2種を InstancedMesh で量産) ----
  const turnZones = turnExclusions(); // 右左折交差点のスタブ道路上には植えない
  // 線路の下(JR在来線・新幹線の桁が路側を大きく覆う区間)には植えない
  const railZones = (route.railStructures ?? []).map((r) => ({
    from: r.s - (r.width ?? 20) / 2 - 6,
    to: r.s + (r.width ?? 20) / 2 + 6,
  }));
  // 歩道が無い区間(旧千本通など)には街路樹を植えない
  const noSidewalkZones = (route.roadSections ?? [])
    .filter((sec) => sec.sidewalk === "none")
    .map((sec) => ({ from: sec.from, to: sec.to }));
  const items = [];
  for (let s = 40; s < path.length * 0.62; s += 42) {
    if (railZones.some((z) => s > z.from && s < z.to)) continue;
    if (noSidewalkZones.some((z) => s > z.from && s < z.to)) continue;
    for (const side of [-1, 1]) {
      if (((s / 42) | 0) % 2 === (side === -1 ? 0 : 1)) continue; // 互い違い
      const [px, pz] = path.getPoint(s);
      const [tx, tz] = path.getTangent(s);
      const lat = side * ((side < 0 ? leftWidthAt(s) : rightWidthAt(s)) + 2.4); // 道路幅に合わせて外側へ
      const x = px + -tz * lat,
        z = pz + tx * lat;
      if (turnZones.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r))
        continue;
      items.push([x, z]);
    }
  }
  // ---- 鳥羽離宮跡公園(OSM実測: way 341709499「鳥羽離宮跡公園」の敷地形状に合わせて木を配置) ----
  // 実測ポリゴン(約130m×154mの矩形)の重心を経路へ投影した結果: 城南宮道停留所の67m先・
  // 進行方向左へ71mの位置。以前は停留所+90m・半径190mの粗い円で過大に除外していたため、
  // 実際の公園より外側の区画にも建物が置けないままになっていた。
  const tobaStop = route.stops.find((st) => st.name === "城南宮道");
  if (tobaStop) {
    const anchorS = Math.min(path.length, tobaStop.s + 67);
    const [apx, apz] = path.getPoint(anchorS);
    const [atx, atz] = path.getTangent(anchorS);
    const anx = -atz,
      anz = atx;
    const [cx, cz] = [apx + anx * -71, apz + anz * -71];
    const halfW = 68,
      halfD = 80; // 実測バウンディングボックス(約130m×154m)+若干の余白
    exclusions.push({ x: cx, z: cz, r: Math.hypot(halfW, halfD) + 5 });
    let seed = 9001;
    const rndSeeded = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 150; i++) {
      const x = cx + (rndSeeded() - 0.5) * 2 * halfW;
      const z = cz + (rndSeeded() - 0.5) * 2 * halfD;
      if (turnZones.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r))
        continue;
      // 公園の矩形スキャッター範囲(anchorS±71m基準)が実際の道路帯にかかる区間があり
      // (城南宮道停留所付近)、車道の真上に木が生えて見えていた。経路に近すぎる候補は除外する。
      const { s: ts, lateral: tlat } = path.closestS([x, z]);
      const roadHw = tlat < 0 ? leftWidthAt(ts) : rightWidthAt(ts);
      if (Math.abs(tlat) < roadHw + 1.5) continue;
      items.push([x, z]);
    }
  }

  // ---- 梅小路公園 (OSM実測) ----
  if (route.umekojiTrees) {
    // 道路・交差点・建物との衝突判定用ヘルパー
    const isValidTreePos = (x, z) => {
      if (turnZones.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r))
        return false;
      const { s: ts, lateral: tlat } = path.closestS([x, z]);
      const roadHw = tlat < 0 ? leftWidthAt(ts) : rightWidthAt(ts);
      if (Math.abs(tlat) < roadHw + 1.5) return false;
      return true;
    };

    // 単木(trees)
    for (const [x, z] of route.umekojiTrees.trees || []) {
      if (isValidTreePos(x, z)) items.push([x, z]);
    }

    // 樹林(forests)
    const polygonArea = (pts) => {
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return Math.abs(a / 2);
    };
    const pointInPolygon = (x, z, pts) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i][0],
          zi = pts[i][1];
        const xj = pts[j][0],
          zj = pts[j][1];
        const intersect =
          zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
        if (intersect) inside = !inside;
      }
      return inside;
    };

    let forestSeed = 10001;
    for (const forest of route.umekojiTrees.forests || []) {
      if (forest.length < 3) continue;
      let minX = Infinity,
        maxX = -Infinity,
        minZ = Infinity,
        maxZ = -Infinity;
      for (const p of forest) {
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[1]);
        maxZ = Math.max(maxZ, p[1]);
      }

      const area = polygonArea(forest);
      const count = Math.min(400, Math.floor(area / 55));
      const maxTries = count * 10;
      let placed = 0;

      let seed = forestSeed++;
      const rndSeeded = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };

      for (let i = 0; i < maxTries && placed < count; i++) {
        const tx = minX + rndSeeded() * (maxX - minX);
        const tz = minZ + rndSeeded() * (maxZ - minZ);
        if (pointInPolygon(tx, tz, forest) && isValidTreePos(tx, tz)) {
          items.push([tx, tz]);
          placed++;
        }
      }
    }

    // 並木列(treeRows)
    for (const row of route.umekojiTrees.treeRows || []) {
      for (let i = 0; i < row.length - 1; i++) {
        const a = row[i];
        const b = row[i + 1];
        const dx = b[0] - a[0],
          dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        const count = Math.max(1, Math.floor(len / 7));
        const stepX = dx / count;
        const stepZ = dz / count;
        for (let j = 0; j < count; j++) {
          const tx = a[0] + stepX * j;
          const tz = a[1] + stepZ * j;
          if (isValidTreePos(tx, tz)) items.push([tx, tz]);
        }
        if (i === row.length - 2) {
          if (isValidTreePos(b[0], b[1])) items.push([b[0], b[1]]);
        }
      }
    }
  }

  // 座標由来の決定的な擬似乱数(向き・大きさのばらつき)
  const rnd = (x, z, k) => {
    const v = Math.sin(x * 127.1 + z * 311.7 + k * 74.7) * 43758.5453;
    return v - Math.floor(v);
  };
  loadProps().then((lib) => {
    const dummy = new THREE.Object3D();
    ["TreeA", "TreeB"].forEach((name, vi) => {
      const own = items.filter((_, i) => i % 2 === vi); // 2種を交互に
      if (!own.length) return;
      lib.getObjectByName(name).traverse((part) => {
        if (!part.isMesh) return;
        const inst = new THREE.InstancedMesh(
          part.geometry,
          part.material,
          own.length,
        );
        own.forEach(([x, z], i) => {
          dummy.position.set(x, 0, z);
          dummy.rotation.set(0, rnd(x, z, 1) * Math.PI * 2, 0);
          dummy.scale.setScalar(0.85 + rnd(x, z, 2) * 0.35);
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
        });
        inst.instanceMatrix.needsUpdate = true;
        g.add(inst);
      });
    });
  });

  return exclusions;
}
