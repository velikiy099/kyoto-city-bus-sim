import * as THREE from 'three';
import { CFG } from '../config.js';
import { route, leftWidthAt, rightWidthAt, halfWidthAt } from '../route/routeData.js';

// ---- InstancedMesh 構築(色付き)。複数の関数から共用 ----
function makeInstanced(scene, geo, list, getMatrix) {
  if (!list.length) return null;
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), list.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  list.forEach((it, i) => {
    getMatrix(it, v, e, sc);
    q.setFromEuler(e);
    m.compose(v, q, sc);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, new THREE.Color(it.color));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  return mesh;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function footprintGeometry(footprint, height) {
  const verts2 = footprint.map(([x, z]) => new THREE.Vector2(x, z));
  const faces = THREE.ShapeUtils.triangulateShape(verts2, []);
  const positions = [];
  const indices = [];
  for (const [x, z] of footprint) positions.push(x, 0, z);
  for (const [x, z] of footprint) positions.push(x, height, z);
  const n = footprint.length;
  for (const face of faces) indices.push(face[2] + n, face[1] + n, face[0] + n);
  for (const face of faces) indices.push(face[0], face[1], face[2]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, j + n, i, j + n, i + n);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildOsmBuildings(scene, buildings, exclusions) {
  const isExcluded = (x, z) => exclusions.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r);
  const materials = new Map();
  let count = 0;
  for (const b of buildings ?? []) {
    if (!b.footprint?.length || b.footprint.length < 3) continue;
    const center = b.footprint.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]).map((v) => v / b.footprint.length);
    if (isExcluded(center[0], center[1])) continue;
    const color = b.color ?? 0xcfc8ba;
    if (!materials.has(color)) materials.set(color, new THREE.MeshLambertMaterial({ color }));
    const mesh = new THREE.Mesh(footprintGeometry(b.footprint, Math.max(2.8, b.height ?? 6)), materials.get(color));
    scene.add(mesh);
    count++;
  }
  return { count };
}

/**
 * 沿道の建物群(InstancedMesh)。
 * 京都の景観: 市街地(二条〜九条)は中低層で高密、上鳥羽以南は低層+田畑。
 * ランドマーク周辺(landmarks.js の除外域)には置かない。
 */
export function buildBuildings(scene, path, exclusions = [], osmBuildings = []) {
  if (osmBuildings.length) {
    const { count } = buildOsmBuildings(scene, osmBuildings, exclusions);
    // OSM建物データが疎い区間(南行き専用の迂回路沿い)は密な住宅を手動で補う
    const denseCount = buildDenseResidential(scene, path, exclusions, osmBuildings);
    // 交差点で交差する道路(自車が通らない側)沿いにも建物を並べる
    const crossCount = buildCrossStreetResidential(scene, path, exclusions, osmBuildings);
    return { count: count + denseCount + crossCount };
  }

  const rand = mulberry32(20260703);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  boxGeo.translate(0, 0.5, 0); // 底面基準

  const palettes = [0xd9d2c4, 0xcfc8ba, 0xbfb7a8, 0xa89f90, 0x8f8a80, 0xe2ddd2, 0x9aa0a8, 0x7f8891];
  const roofPalettes = [0x4a4f55, 0x5d5348, 0x39424d, 0x6b625a];

  const items = []; // {x, z, ry, w, h, d, color}
  const roofItems = [];
  const L = path.length;

  const isExcluded = (x, z) => exclusions.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r);

  for (let s = 95; s < L - 10; s += 13 + rand() * 10) { // 二条駅西口の駅前広場(s<95)は空ける
    // 市街地係数: 路線北部(市街地)1.0 → 南部(郊外)へ緩やかに低下
    const t = s / L;
    const urban = t < 0.45 ? 1 : t < 0.62 ? 0.75 : 0.4;
    const [px, pz] = path.getPoint(s);
    const [tx, tz] = path.getTangent(s);
    const nx = -tz, nz = tx;
    for (const side of [-1, 1]) {
      if (rand() > (side === -1 ? 0.92 : 0.9) * urban + 0.18) continue; // 郊外は歯抜け
      const setback = 8.2 + rand() * 7;
      const w = 6 + rand() * (urban > 0.7 ? 9 : 5);
      const d = 6 + rand() * 8;
      let h;
      const r = rand();
      if (urban > 0.9) h = r < 0.5 ? 6 + rand() * 6 : r < 0.85 ? 12 + rand() * 10 : 24 + rand() * 14;
      else if (urban > 0.6) h = r < 0.6 ? 5 + rand() * 5 : 9 + rand() * 8;
      else h = r < 0.75 ? 4 + rand() * 3 : 7 + rand() * 4;
      const lat = side * ((side < 0 ? leftWidthAt(s) : rightWidthAt(s)) + setback + w / 2);
      const x = px + nx * lat + tx * (rand() - 0.5) * 4;
      const z = pz + nz * lat + tz * (rand() - 0.5) * 4;
      if (isExcluded(x, z)) continue;
      const ry = Math.atan2(tx, tz) + (rand() - 0.5) * 0.08;
      items.push({ x, z, ry, w, h, d, color: palettes[(rand() * palettes.length) | 0] });
      // 低層は瓦屋根風の薄い箱を載せる(京町家の雰囲気)
      if (h < 9 && rand() < 0.8) {
        roofItems.push({ x, z, ry, w: w + 1.0, h: 0.5, d: d + 1.0, y: h, color: roofPalettes[(rand() * roofPalettes.length) | 0] });
      }
    }
  }

  // 田畑(郊外の緑パッチ)
  const fieldGeo = new THREE.PlaneGeometry(1, 1);
  const fieldColors = [0x7da05e, 0x8fae6a, 0x6d9455, 0xa3b578];
  const fields = [];
  for (let s = L * 0.6; s < L - 20; s += 26 + rand() * 30) {
    const [px, pz] = path.getPoint(s);
    const [tx, tz] = path.getTangent(s);
    const nx = -tz, nz = tx;
    for (const side of [-1, 1]) {
      if (rand() < 0.45) continue;
      const lat = side * ((side < 0 ? leftWidthAt(s) : rightWidthAt(s)) + 14 + rand() * 26);
      const x = px + nx * lat, z = pz + nz * lat;
      if (isExcluded(x, z)) continue;
      fields.push({ x, z, w: 18 + rand() * 22, d: 14 + rand() * 16, ry: Math.atan2(tx, tz), color: fieldColors[(rand() * 4) | 0] });
    }
  }

  // ---- InstancedMesh 構築(色付き) ----
  makeInstanced(scene, boxGeo, items, (it, v, e, sc) => {
    v.set(it.x, 0, it.z);
    e.set(0, it.ry, 0);
    sc.set(it.w, it.h, it.d);
  });
  makeInstanced(scene, boxGeo, roofItems, (it, v, e, sc) => {
    v.set(it.x, it.y, it.z);
    e.set(0, it.ry, 0);
    sc.set(it.w, it.h, it.d);
  });
  makeInstanced(scene, fieldGeo, fields, (it, v, e, sc) => {
    v.set(it.x, 0.06, it.z);
    e.set(-Math.PI / 2, 0, it.ry);
    sc.set(it.w, it.d, 1);
  });

  return { count: items.length };
}

// 実際の道路(OSMデータで沿道建物が疎な区間)に手動で密な2階建て住宅を補う区間。
// 九条新千本〜小枝橋手前、鳥羽離宮の木の帯を過ぎた先(赤池付近、s値は小枝橋detourの
// 実ジオメトリ化に伴い前区間より約164m後ろへシフト済み)、桂川(久我橋)以西〜菱妻神社工場群の手前。
const DENSE_RESIDENTIAL_ZONES = [
  { from: 4933, to: 7773 },
  { from: 7773, to: 8710.9 }, // 小枝橋(鴨川)以南〜赤池。橋・鳥羽離宮跡公園の除外円は isExcluded で自動的に空く
  { from: 8710.9, to: 8880, sides: [-1] }, // 川(鴨川)と反対の東側のみ
  { from: 9533, to: 10233 },
];
const zoneAt = (s) => DENSE_RESIDENTIAL_ZONES.find((z) => s >= z.from && s < z.to);

/** 沿道の密な2階建て住宅(OSM建物の疎な区間を補う。実在建物とは重ねない) */
function buildDenseResidential(scene, path, exclusions, osmBuildings) {
  const rand = mulberry32(0x51ea3 ^ 20260703);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  boxGeo.translate(0, 0.5, 0);
  const palettes = [0xd9d2c4, 0xcfc8ba, 0xbfb7a8, 0xa89f90, 0xe2ddd2, 0xc7b8a0];
  const roofPalettes = [0x4a4f55, 0x5d5348, 0x39424d, 0x6b625a];
  const items = [];
  const roofItems = [];

  const obCenters = osmBuildings.map((b) => {
    const c = b.footprint.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [c[0] / b.footprint.length, c[1] / b.footprint.length];
  });
  const isExcluded = (x, z) =>
    exclusions.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r) ||
    obCenters.some((c) => (x - c[0]) ** 2 + (z - c[1]) ** 2 < 121);

  const sMax = DENSE_RESIDENTIAL_ZONES.at(-1).to;
  for (let s = DENSE_RESIDENTIAL_ZONES[0].from; s < sMax; s += 9 + rand() * 5) {
    const zone = zoneAt(s);
    if (!zone) continue;
    const [px, pz] = path.getPoint(s);
    const [tx, tz] = path.getTangent(s);
    const nx = -tz, nz = tx;
    for (const side of [-1, 1]) {
      if (zone.sides && !zone.sides.includes(side)) continue; // 川側など片側のみ許可するゾーン
      if (rand() > 0.88) continue; // ほぼ隙間なく密集
      const setback = 5 + rand() * 3;
      const w = 6 + rand() * 4, d = 6 + rand() * 5, h = 5.6 + rand() * 1.6; // 2階建て程度
      const lat = side * ((side < 0 ? leftWidthAt(s) : rightWidthAt(s)) + setback + w / 2);
      const x = px + nx * lat + tx * (rand() - 0.5) * 3;
      const z = pz + nz * lat + tz * (rand() - 0.5) * 3;
      if (isExcluded(x, z)) continue;
      const ry = Math.atan2(tx, tz) + (rand() - 0.5) * 0.1;
      items.push({ x, z, ry, w, h, d, color: palettes[(rand() * palettes.length) | 0] });
      if (rand() < 0.85) {
        roofItems.push({ x, z, ry, w: w + 1, h: 0.5, d: d + 1, y: h, color: roofPalettes[(rand() * roofPalettes.length) | 0] });
      }
    }
  }

  makeInstanced(scene, boxGeo, items, (it, v, e, sc) => {
    v.set(it.x, 0, it.z);
    e.set(0, it.ry, 0);
    sc.set(it.w, it.h, it.d);
  });
  makeInstanced(scene, boxGeo, roofItems, (it, v, e, sc) => {
    v.set(it.x, it.y, it.z);
    e.set(0, it.ry, 0);
    sc.set(it.w, it.h, it.d);
  });
  return items.length;
}

/**
 * 交差点で本線と交わる道路(自車が通らない側も含む)沿いに、密な2階建て住宅を並べる。
 * route.intersections[].arms(実在する腕のみ)と route.turnIntersections(右左折交差点の
 * 交差道路)の両方を対象に、舗装済みの範囲(スタブ長)より先〜100m地点まで補う。
 */
function buildCrossStreetResidential(scene, path, exclusions, osmBuildings) {
  const rand = mulberry32(0x9c2b1 ^ 20260703);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  boxGeo.translate(0, 0.5, 0);
  const palettes = [0xd9d2c4, 0xcfc8ba, 0xbfb7a8, 0xa89f90, 0xe2ddd2, 0xc7b8a0];
  const roofPalettes = [0x4a4f55, 0x5d5348, 0x39424d, 0x6b625a];
  const items = [];
  const roofItems = [];

  const obCenters = osmBuildings.map((b) => {
    const c = b.footprint.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [c[0] / b.footprint.length, c[1] / b.footprint.length];
  });
  const isExcluded = (x, z) =>
    exclusions.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r) ||
    obCenters.some((c) => (x - c[0]) ** 2 + (z - c[1]) ** 2 < 121);

  // cx,cz を起点に heading*side 方向へ dMin〜armLen の範囲で建物を並べる。
  // d/lat の単純な軸分解だけでは(交差角が90°ちょうどでない、経路が近くでカーブしている等)
  // 本線の実舗装との距離を正しく見積もれないことがあるため、path.closestS で実距離を
  // 直接測って本線に食い込む候補は必ず除外する(sHint は探索を軽くするための目安)。
  const scatterArm = (cx, cz, heading, side, armLen, halfW, dMin, sHint) => {
    const dx = Math.sin(heading) * side, dz = Math.cos(heading) * side;
    const nx = Math.cos(heading), nz = -Math.sin(heading);
    const ry = heading + (side > 0 ? 0 : Math.PI);
    for (let d = dMin; d < armLen; d += 9 + rand() * 6) {
      for (const lSide of [-1, 1]) {
        if (rand() > 0.82) continue;
        const setback = halfW + 4 + rand() * 3;
        const w = 6 + rand() * 4, dep = 6 + rand() * 5, h = 5.6 + rand() * 4.5;
        const lat = lSide * (setback + w / 2);
        const x = cx + dx * d + nx * lat;
        const z = cz + dz * d + nz * lat;
        if (isExcluded(x, z)) continue;
        const hit = path.closestS([x, z], sHint, 220);
        if (hit.dist < halfWidthAt(hit.s) + 3) continue; // 本線の実舗装に近すぎる候補は除外
        items.push({ x, z, ry: ry + (rand() - 0.5) * 0.08, w, h, d: dep, color: palettes[(rand() * palettes.length) | 0] });
        if (rand() < 0.8) {
          roofItems.push({ x, z, ry, w: w + 1, h: 0.5, d: dep + 1, y: h, color: roofPalettes[(rand() * roofPalettes.length) | 0] });
        }
      }
    }
  };

  for (const ix of route.intersections ?? []) {
    if (!ix.arms?.length) continue;
    const s = Math.max(0, Math.min(path.length - 0.1, ix.s));
    const [cx, cz] = path.getPoint(s);
    const halfW = (ix.width ?? 8) / 2;
    for (const arm of ix.arms) {
      if (!arm.exists || arm.length <= 0) continue;
      scatterArm(cx, cz, ix.heading, arm.side, arm.length, halfW, Math.max(14, halfW + 6), s);
    }
  }
  const TURN_STUB_LEN = 42, TURN_ARM_LEN = 100;
  for (const t of route.turnIntersections ?? []) {
    if (!t.crossName) continue; // 交差道路名が無い(=経路自身の折れのみ)場合は対象外
    scatterArm(t.x, t.z, t.headingIn, 1, TURN_ARM_LEN, t.hwIn ?? 6, TURN_STUB_LEN + 3, t.sIn);
    scatterArm(t.x, t.z, t.headingOut, -1, TURN_ARM_LEN, t.hwOut ?? 6, TURN_STUB_LEN + 3, t.sOut);
  }

  makeInstanced(scene, boxGeo, items, (it, v, e, sc) => {
    v.set(it.x, 0, it.z);
    e.set(0, it.ry, 0);
    sc.set(it.w, it.h, it.d);
  });
  makeInstanced(scene, boxGeo, roofItems, (it, v, e, sc) => {
    v.set(it.x, it.y, it.z);
    e.set(0, it.ry, 0);
    sc.set(it.w, it.h, it.d);
  });
  return items.length;
}
