import * as THREE from 'three';
import { route } from '../route/routeData.js';

const mat = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, ...opts });

/** 停留所名 → s 値 */
const stopS = (name) => route.stops.find((st) => st.name === name)?.s ?? 0;

/** 経路上の (s, lateral) → ワールド座標と接線方位 */
function anchor(path, s, lat) {
  const [px, pz] = path.getPoint(s);
  const [tx, tz] = path.getTangent(s);
  return { x: px + -tz * lat, z: pz + tx * lat, ry: Math.atan2(tx, tz) };
}

/** 東寺五重塔(高さ約55m・日本一の木造塔)+ 金堂・境内 */
function buildToji(scene, path) {
  const g = new THREE.Group();
  const s = stopS('東寺南門前');
  const a = anchor(path, s - 15, 78); // 進行方向右(北)側の境内
  g.position.set(a.x, 0, a.z);
  g.rotation.y = a.ry;

  // 境内(砂利色) と 塀
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(130, 120), mat(0xcabfa5));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.08;
  g.add(ground);
  for (const [w, d, x, z] of [[130, 2, 0, -59], [130, 2, 0, 59], [2, 120, -64, 0], [2, 120, 64, 0]]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 3.2, d), mat(0xe8e0d0));
    wall.position.set(x, 1.6, z);
    g.add(wall);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.5, d + 0.6), mat(0x4a4f55));
    cap.position.set(x, 3.4, z);
    g.add(cap);
  }

  // 五重塔(境内の道路寄り・南東角 — 実際の伽藍配置と同じ)
  // ローカル軸: +x=ワールド南, +z=ワールド西(anchor 接線が西向きのため)
  const pagoda = new THREE.Group();
  pagoda.position.set(45, 0, -55);
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

  // 金堂(大きな寄棟屋根の堂・境内中央の北寄り)
  const hall = new THREE.Group();
  hall.position.set(-20, 0, 0);
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
  return { x: a.x, z: a.z, r: 115 };
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
  const a = anchor(path, s + 20, 60); // 右(西)側
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
