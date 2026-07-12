import * as THREE from "three";
import {
  route,
  leftWidthAt,
  rightWidthAt,
  driveBoundsAt,
  turnExclusions,
  elevationAt,
} from "../route/routeData.js";
import { loadProps } from "../util/propsLib.js";
import { clippedRiverPoints, riverWidthMeters } from "./riverGeometry.js";
import { terrainHeightAtWorld } from "./declarative/continuousTerrain.js";

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
const BRIDGE_RAIL_HEIGHT = 1.0;
const BRIDGE_RAIL_WIDTH = 0.32;
const RAIL_SEGMENT_LENGTH = 6; // 曲線・勾配へ追従するため短く分割 [m]
// 梅小路公園・鳥羽離宮跡で使ってきた樹林配置(area/60)を基準に、
// OSMの森林は約4倍、低木林は森林の半分の密度にする。
const FOREST_TREE_AREA_M2 = 15;
const SCRUB_AREA_M2 = 30;

/**
 * 川(鴨川・桂川・西高瀬川)・橋・遠景の山・街路樹
 * 川は bridges の s 位置で経路と直交する帯として描く。川底は RIVER_DEPTH ぶん低く、
 * 土手は段状(芝→護岸)に地表から水面まで下る。
 */
export function buildNature(scene, path) {
  const g = new THREE.Group();
  scene.add(g);
  const exclusions = [];

  // 河川橋の欄干・桁・橋脚上端は、道路本体と同じ経路標高を直接使う。
  // 横端のワールド座標から道路を再検索すると、橋の下の地表や近接道路を
  // 拾う場合があるため、橋上構造物では roadHeightAtWorld() に依存しない。
  const bridgeRoadHeightAt = (_x, _z, s) => elevationAt(s);

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
      const x0 = p[0] + nx * offFrom;
      const z0 = p[1] + nz * offFrom;
      const x1 = p[0] + nx * offTo;
      const z1 = p[1] + nz * offTo;
      positions.push(x0, terrainHeightAtWorld(x0, z0) + y, z0);
      positions.push(x1, terrainHeightAtWorld(x1, z1) + y, z1);
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

  function waterPolygonGeometry(polygon) {
    const shape = polygon.map(([x, z]) => new THREE.Vector2(x, z));
    const triangles = THREE.ShapeUtils.triangulateShape(shape, []);
    const positions = polygon.flatMap(([x, z]) => [x, terrainHeightAtWorld(x, z) - RIVER_DEPTH + 0.05, z]);
    const indices = triangles.flatMap((triangle) => triangle);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  /** 道路の曲線に追従する欄干を短い箱の連続として描く */
  function addBridgeRail(side, fromS, toS, deckHalfWidth = null, edgePoints = null) {
    if (edgePoints?.length >= 2) {
      for (let i = 1; i < edgePoints.length; i++) {
        const a = edgePoints[i - 1], b = edgePoints[i];
        const dx = b[0] - a[0], dz = b[2] - a[2];
        const length = Math.hypot(dx, dz);
        if (length < 0.05) continue;
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(BRIDGE_RAIL_WIDTH, BRIDGE_RAIL_HEIGHT, length + 0.04),
          mat(0xdfe3e6),
        );
        rail.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + BRIDGE_RAIL_HEIGHT / 2, (a[2] + b[2]) / 2);
        rail.rotation.order = "YXZ";
        rail.rotation.y = Math.atan2(dx, dz);
        rail.rotation.x = -Math.atan2(b[1] - a[1], length);
        g.add(rail);
      }
      return;
    }
    for (let s = fromS; s < toS; s += RAIL_SEGMENT_LENGTH) {
      const nextS = Math.min(toS, s + RAIL_SEGMENT_LENGTH);
      const midS = (s + nextS) / 2;
      const [rx, rz] = path.getPoint(midS);
      const [tx, tz] = path.getTangent(midS);
      const nx = -tz,
        nz = tx;
      const roadEdge = deckHalfWidth ?? (
        side < 0 ? leftWidthAt(midS) : rightWidthAt(midS)
      );
      const railOffset = roadEdge + BRIDGE_RAIL_CLEARANCE;
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(
          BRIDGE_RAIL_WIDTH,
          BRIDGE_RAIL_HEIGHT,
          Math.max(0.5, nextS - s + 0.15),
        ),
        mat(0xdfe3e6),
      );
      const roadY = bridgeRoadHeightAt(
        rx + nx * side * railOffset,
        rz + nz * side * railOffset,
        midS,
      );
      rail.position.set(
        rx + nx * side * railOffset,
        roadY + BRIDGE_RAIL_HEIGHT / 2,
        rz + nz * side * railOffset,
      );
      rail.rotation.y = Math.atan2(tx, tz);
      g.add(rail);
    }
  }

  const waterPolygonsByName = new Set(
    (route.waterPolygons ?? []).map((polygon) => polygon.name).filter(Boolean),
  );
  for (const polygon of route.waterPolygons ?? []) {
    if (polygon.polygon?.length < 3) continue;
    g.add(new THREE.Mesh(
      waterPolygonGeometry(polygon.polygon),
      mat(0x4fa8d8, { transparent: true, opacity: 0.82, side: THREE.DoubleSide }),
    ));
  }

  for (const br of route.bridges) {
    const riverLine = (route.rivers ?? []).find((river) => river.bridgeName === br.name);
    const w = riverWidthMeters(br, riverLine);
    const halfW = w / 2;
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

    const hasSourceWaterPolygon = waterPolygonsByName.has(br.river);
    // A riverbank/natural=water polygon is the authoritative water surface.
    // The centreline ribbon is only a fallback for OSM waterway=river data.
    if (!hasSourceWaterPolygon) g.add(
      new THREE.Mesh(
        ribbonGeometry(points, -halfW, halfW, -RIVER_DEPTH + 0.05),
        mat(0x4fa8d8),
      ),
    );
    // 土手(地表→水面の段状斜面)。両岸・両段(BANK_TIERS)で計4本のリボン。
    if (!hasSourceWaterPolygon) for (const bankSide of [-1, 1]) {
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

    // 可視路面は elevationAt(s) を使う道路レイヤーだけが描く。
    // 別の灰色デッキを重ねると道路勾配との差で路面を覆うため生成しない。
    const railFrom = Math.max(0, br.s - bridgeSpan / 2);
    const railTo = Math.min(path.length, br.s + bridgeSpan / 2);
    // Width is compiled from the selected PLATEAU/OSM road surface with the
    // driving network; bridge names never alter geometry at runtime.
    const deckHalfWidth = br.railHalfWidth ?? null;
    for (const side of [-1, 1])
      addBridgeRail(
        side,
        railFrom,
        railTo,
        deckHalfWidth,
        side < 0 ? br.railEdges?.left : br.railEdges?.right,
      );

    // 長い河川橋は、河床から桁下までを結ぶ橋脚を実際の路面標高に合わせて配置する。
    // 地形メッシュ側で河川谷を掘り下げているため、橋脚下端も同じ深さを使う。
    const supportCount = Math.max(0, Math.ceil(bridgeSpan / 55) - 1);
    for (let i = 1; i <= supportCount; i++) {
      const sPier = railFrom + ((railTo - railFrom) * i) / (supportCount + 1);
      const [sx, sz] = path.getPoint(sPier);
      const topY = bridgeRoadHeightAt(sx, sz, sPier) - 0.9;
      const bedY = terrainHeightAtWorld(sx, sz) - RIVER_DEPTH + 0.15;
      const height = Math.max(0.8, topY - bedY);
      const pier = new THREE.Mesh(
        new THREE.CylinderGeometry(0.75, 0.95, height, 10),
        mat(0x8f9699),
      );
      pier.position.set(sx, bedY + height / 2, sz);
      g.add(pier);
    }
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
    m.position.set(x, terrainHeightAtWorld(x, z), z);
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
  const scrubItems = [];
  const treeKeys = new Set();
  const scrubKeys = new Set();
  const addTree = (x, z) => {
    const key = `${x.toFixed(2)}:${z.toFixed(2)}`;
    if (treeKeys.has(key)) return false;
    treeKeys.add(key);
    items.push([x, z]);
    return true;
  };
  const addScrub = (x, z) => {
    const key = `${x.toFixed(2)}:${z.toFixed(2)}`;
    if (treeKeys.has(key) || scrubKeys.has(key)) return false;
    scrubKeys.add(key);
    scrubItems.push([x, z]);
    return true;
  };
  const isValidTreePos = (x, z) => {
    if (turnZones.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r))
      return false;
    const { s: ts, lateral: tlat } = path.closestS([x, z]);
    const bounds = driveBoundsAt(ts);
    return tlat < -bounds.left - 1.5 || tlat > bounds.right + 1.5;
  };
  const cleanPolygon = (polygon) => {
    const points = (polygon ?? []).filter(
      (point) => Array.isArray(point) && point.length >= 2,
    ).map(([x, z]) => [Number(x), Number(z)]);
    if (points.length > 1) {
      const first = points[0];
      const last = points.at(-1);
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.2)
        points.pop();
    }
    return points.length >= 3 ? points : null;
  };
  const polygonArea = (pts) => {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(area / 2);
  };
  const pointInPolygon = (x, z, pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, zi] = pts[i];
      const [xj, zj] = pts[j];
      const intersects = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-9) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  };

  // OSM green areas remain visible even when the selected PLATEAU vegetation
  // layer is empty. In particular, these polygons form the islands and
  // planted edges of the Nijo Station rotary.
  const greenPositions = [];
  const greenIndices = [];
  for (const area of route.osmVegetation?.greenAreas ?? []) {
    const polygon = cleanPolygon(area.polygon);
    if (!polygon) continue;
    const faces = THREE.ShapeUtils.triangulateShape(
      polygon.map(([x, z]) => new THREE.Vector2(x, z)),
      [],
    );
    const base = greenPositions.length / 3;
    for (const [x, z] of polygon)
      greenPositions.push(x, terrainHeightAtWorld(x, z) + 0.08, z);
    for (const face of faces)
      greenIndices.push(base + face[0], base + face[1], base + face[2]);
  }
  if (greenIndices.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(greenPositions, 3));
    geometry.setIndex(greenIndices);
    geometry.computeVertexNormals();
    const green = new THREE.Mesh(
      geometry,
      mat(0x739660, { side: THREE.DoubleSide }),
    );
    green.name = "osm-planted-green-areas";
    g.add(green);
  }

  // Exact OSM tree nodes, tree rows, woodland polygons, and scrub polygons.
  // Point trees are placed at their mapped coordinates; areas are sampled only
  // inside the mapped polygon so they do not become generic roadside scatter.
  if (route.osmVegetation) {
    for (const tree of route.osmVegetation.trees ?? []) {
      if (tree.point?.length >= 2 && isValidTreePos(tree.point[0], tree.point[1]))
        addTree(tree.point[0], tree.point[1]);
    }
    let areaSeed = 24001;
    for (const areaData of route.osmVegetation.treeAreas ?? []) {
      const polygon = cleanPolygon(areaData.polygon);
      if (!polygon) continue;
      const bounds = polygon.reduce(
        (acc, [x, z]) => ({
          minX: Math.min(acc.minX, x),
          maxX: Math.max(acc.maxX, x),
          minZ: Math.min(acc.minZ, z),
          maxZ: Math.max(acc.maxZ, z),
        }),
        { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
      );
      const isScrub = areaData.kind === "scrub";
      const count = Math.min(
        4000,
        Math.floor(polygonArea(polygon) / (isScrub ? SCRUB_AREA_M2 : FOREST_TREE_AREA_M2)),
      );
      if (count < 1) continue;
      let seed = areaSeed++;
      const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      let placed = 0;
      for (let attempt = 0; attempt < count * 12 && placed < count; attempt++) {
        const x = bounds.minX + random() * (bounds.maxX - bounds.minX);
        const z = bounds.minZ + random() * (bounds.maxZ - bounds.minZ);
        if (pointInPolygon(x, z, polygon) && isValidTreePos(x, z)) {
          if ((isScrub ? addScrub : addTree)(x, z)) placed++;
        }
      }
    }
    for (const row of route.osmVegetation.treeRows ?? []) {
      const points = row.points ?? row;
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const count = Math.max(1, Math.floor(len / 7));
        for (let j = 0; j <= count; j++) {
          const t = j / count;
          const x = a[0] + (b[0] - a[0]) * t;
          const z = a[1] + (b[1] - a[1]) * t;
          if (isValidTreePos(x, z)) addTree(x, z);
        }
      }
    }
  }

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
      if (isValidTreePos(x, z)) addTree(x, z);
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
      if (!isValidTreePos(x, z)) continue;
      addTree(x, z);
    }
  }

  // ---- 梅小路公園 (OSM実測) ----
  if (!route.osmVegetation && route.umekojiTrees) {
    // 単木(trees)
    for (const [x, z] of route.umekojiTrees.trees || []) {
      if (isValidTreePos(x, z)) addTree(x, z);
    }

    // 樹林(forests)
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
          addTree(tx, tz);
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
          if (isValidTreePos(tx, tz)) addTree(tx, tz);
        }
        if (i === row.length - 2) {
          if (isValidTreePos(b[0], b[1])) addTree(b[0], b[1]);
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
          dummy.position.set(x, terrainHeightAtWorld(x, z), z);
          dummy.rotation.set(0, rnd(x, z, 1) * Math.PI * 2, 0);
          dummy.scale.setScalar(0.85 + rnd(x, z, 2) * 0.35);
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
        });
        inst.instanceMatrix.needsUpdate = true;
        g.add(inst);
      });
    });

    // OSM natural=scrub は樹木ではなく、地表近くの低木群として描く。
    // 既存のTreeA/TreeBを縮小して代用せず、低く横に広がる簡易メッシュを
    // InstancedMeshでまとめて生成する。
    if (scrubItems.length) {
      const shrubGeometry = new THREE.IcosahedronGeometry(1, 1);
      const shrubMaterial = mat(0x58743b);
      const shrubs = new THREE.InstancedMesh(
        shrubGeometry,
        shrubMaterial,
        scrubItems.length,
      );
      scrubItems.forEach(([x, z], i) => {
        dummy.position.set(x, terrainHeightAtWorld(x, z) + 0.8, z);
        dummy.rotation.set(
          (rnd(x, z, 3) - 0.5) * 0.12,
          rnd(x, z, 4) * Math.PI * 2,
          (rnd(x, z, 5) - 0.5) * 0.12,
        );
        const size = 1.4 + rnd(x, z, 6) * 1.0;
        dummy.scale.set(size, 0.8 + rnd(x, z, 7) * 0.45, size);
        dummy.updateMatrix();
        shrubs.setMatrixAt(i, dummy.matrix);
      });
      shrubs.instanceMatrix.needsUpdate = true;
      shrubs.name = "osm-scrub-stands";
      g.add(shrubs);
    }
  });

  return exclusions;
}
