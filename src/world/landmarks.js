import * as THREE from 'three';
import { route, rightWidthAt } from '../route/routeData.js';

const mat = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, ...opts });

/** 停留所名 → s 値 */
const stopS = (name) => route.stops.find((st) => st.name === name)?.s ?? 0;

/** 経路上の (s, lateral) → ワールド座標と接線方位 */
function anchor(path, s, lat) {
  const [px, pz] = path.getPoint(s);
  const [tx, tz] = path.getTangent(s);
  return { x: px + -tz * lat, z: pz + tx * lat, ry: Math.atan2(tx, tz) };
}

/**
 * 東寺(境内・五重塔・金堂)。
 * 境内は実際の道路配置に接するよう矩形で囲む: 北端=東寺道交差点、東端=大宮通(七条〜九条間)、
 * 南端=九条通(九条大宮の交差点)、西端=京阪国道口(国道1号)交差点。
 * 五重塔は史実どおり境内南東寄り(九条大宮交差点の北西方向)に配置する。
 */
function buildToji(scene, path) {
  const g = new THREE.Group();
  const findIx = (name) => route.intersections.find((ix) => ix.name === name);
  const tojiDo = findIx('東寺道');
  const keihan = findIx('京阪国道口(国道1号)');
  const turn = route.turnIntersections.find((t) => t.crossName === '大宮通');
  if (!tojiDo || !keihan || !turn) {
    scene.add(g);
    return { x: 0, z: 0, r: 0 };
  }

  const [, northZ] = path.getPoint(tojiDo.s); // 北端: 東寺道交差点の緯度
  const eastX = turn.x;                        // 東端: 大宮通(九条大宮進入直前)の経度
  const southZ = turn.z;                       // 南端: 九条通(九条大宮)の緯度
  const [westX] = path.getPoint(keihan.s);      // 西端: 京阪国道口交差点の経度
  const w = eastX - westX;
  const d = southZ - northZ;
  const cx = (eastX + westX) / 2, cz = (northZ + southZ) / 2;
  g.position.set(cx, 0, cz);

  // 境内(砂利色) と 塀
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(0xcabfa5));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.08;
  g.add(ground);
  for (const [ww, dd, x, z] of [[w, 2, 0, -d / 2], [w, 2, 0, d / 2], [2, d, -w / 2, 0], [2, d, w / 2, 0]]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(ww, 3.2, dd), mat(0xe8e0d0));
    wall.position.set(x, 1.6, z);
    g.add(wall);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.6, 0.5, dd + 0.6), mat(0x4a4f55));
    cap.position.set(x, 3.4, z);
    g.add(cap);
  }

  // 五重塔(境内の南東寄り = 九条大宮交差点の北西方向。実際の伽藍配置と同じ)
  const pagoda = new THREE.Group();
  pagoda.position.set(eastX - cx - 65, 0, southZ - cz - 55);
  let y = 0;
  for (let i = 0; i < 5; i++) {
    const bw = 12.5 - i * 1.7;
    const bh = 7.2 - i * 0.55;
    const bodyM = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bw), mat(0x8a4b32));
    bodyM.position.y = y + bh / 2;
    pagoda.add(bodyM);
    y += bh;
    const roofW = bw + 5.2;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(roofW / 1.32, 2.6, 4), mat(0x3d4750));
    roof.rotation.y = Math.PI / 4;
    roof.position.y = y + 1.3;
    pagoda.add(roof);
    y += 1.9;
  }
  const finial = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 9.5, 8), mat(0xb8933e));
  finial.position.y = y + 4.7;
  pagoda.add(finial);
  g.add(pagoda);

  // 金堂(大きな寄棟屋根の堂・境内中央よりやや北)
  const hall = new THREE.Group();
  hall.position.set(0, 0, -d * 0.12);
  const hallBody = new THREE.Mesh(new THREE.BoxGeometry(38, 10, 26), mat(0xa08464));
  hallBody.position.y = 5;
  hall.add(hallBody);
  const hallRoof = new THREE.Mesh(new THREE.ConeGeometry(30, 7, 4), mat(0x3d4750));
  hallRoof.rotation.y = Math.PI / 4;
  hallRoof.scale.set(1.35, 1, 0.95);
  hallRoof.position.y = 13.5;
  hall.add(hallRoof);
  g.add(hall);

  scene.add(g);
  return { x: cx, z: cz, r: Math.max(w, d) / 2 + 15 };
}

/** JR二条駅(かまぼこ型の大屋根) */
function buildNijoStation(scene, path) {
  const s = stopS('二条駅西口');
  const a = anchor(path, s + 40, -68); // 発車直後の左(北東)側
  const g = new THREE.Group();
  g.position.set(a.x, 0, a.z);
  g.rotation.y = a.ry + Math.PI / 2; // 駅は南北に長い

  const roof = new THREE.Mesh(
    new THREE.CylinderGeometry(13, 13, 92, 24, 1, false, 0, Math.PI),
    mat(0x9fb8c8, { side: THREE.DoubleSide })
  );
  roof.rotation.z = Math.PI / 2;
  roof.rotation.y = Math.PI / 2;
  roof.position.y = 9;
  g.add(roof);
  const base = new THREE.Mesh(new THREE.BoxGeometry(26, 9, 90), mat(0xd8dcd8));
  base.position.y = 4.5;
  g.add(base);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(22, 2.0, 0.4), mat(0x2b4a66));
  sign.position.set(0, 7.5, 45.5);
  g.add(sign);
  scene.add(g);
  return { x: a.x, z: a.z, r: 72 };
}

/** 京都水族館+梅小路公園 */
function buildAquarium(scene, path) {
  const s = stopS('七条大宮・京都水族館前');
  const PARK_HALF_W = 75; // PlaneGeometry(150,120) の半幅(道路と垂直な方向)
  const lat = rightWidthAt(s + 20) + 3.2 + 8 + PARK_HALF_W; // 車道+歩道+余白の外側に芝生の内縁を置く
  const a = anchor(path, s + 20, lat); // 右(西)側
  const g = new THREE.Group();
  g.position.set(a.x, 0, a.z);
  g.rotation.y = a.ry;

  const park = new THREE.Mesh(new THREE.PlaneGeometry(150, 120), mat(0x86a86b));
  park.rotation.x = -Math.PI / 2;
  park.position.y = 0.07;
  g.add(park);
  const aq = new THREE.Mesh(new THREE.BoxGeometry(52, 12, 30), mat(0x3a7ca5));
  aq.position.set(-20, 6, -20);
  g.add(aq);
  const aqRoof = new THREE.Mesh(new THREE.BoxGeometry(56, 1.6, 34), mat(0xe8ecef));
  aqRoof.position.set(-20, 12.8, -20);
  g.add(aqRoof);
  // 公園の木
  for (let i = 0; i < 14; i++) {
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 3, 6), mat(0x6b4f3a));
    trunk.position.y = 1.5;
    const crown = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 6), mat(0x4e7a3d));
    crown.position.y = 4.6;
    t.add(trunk, crown);
    t.position.set(30 - (i % 5) * 14, 0, 40 - Math.floor(i / 5) * 30);
    g.add(t);
  }
  scene.add(g);
  return { x: a.x, z: a.z, r: 95 };
}

/** 羅城門跡(児童公園の石碑) */
function buildRajomon(scene, path) {
  const s = stopS('羅城門');
  const a = anchor(path, s - 8, -9);
  const g = new THREE.Group();
  g.position.set(a.x, 0, a.z);
  g.rotation.y = a.ry;
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(16, 12), mat(0xb9b29b));
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.09;
  g.add(pad);
  const stone = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.6, 0.7), mat(0x777d80));
  stone.position.y = 1.5;
  g.add(stone);
  const basePlate = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.4, 1.6), mat(0x8d9296));
  basePlate.position.y = 0.2;
  g.add(basePlate);
  scene.add(g);
  return { x: a.x, z: a.z, r: 14 };
}

/** 京都タワー(遠景・東方向) */
function buildKyotoTower(scene, path) {
  const s = stopS('七条大宮・京都水族館前');
  const a = anchor(path, s, -620); // 左(東)遠方
  const g = new THREE.Group();
  g.position.set(a.x, 0, a.z);
  const base = new THREE.Mesh(new THREE.BoxGeometry(40, 30, 40), mat(0xcfd4d8));
  base.position.y = 15;
  g.add(base);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 8, 70, 12), mat(0xeceff1));
  shaft.position.y = 65;
  g.add(shaft);
  const obs = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 7.5, 8, 12), mat(0xdadfe3));
  obs.position.y = 103;
  g.add(obs);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.6, 14, 8), mat(0xe57339));
  tip.position.y = 114;
  g.add(tip);
  scene.add(g);
  return { x: a.x, z: a.z, r: 60 };
}

/** すべてのランドマークを配置し、建物生成の除外域リストを返す */
export function buildLandmarks(scene, path) {
  return [
    buildToji(scene, path),
    buildNijoStation(scene, path),
    buildAquarium(scene, path),
    buildRajomon(scene, path),
    buildKyotoTower(scene, path),
  ];
}
