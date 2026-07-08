import * as THREE from 'three';
import { route, rightWidthAt, leftWidthAt } from '../route/routeData.js';

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
  // 東端: 大宮通(九条大宮進入直前)の西側路端(東寺は大宮通の西側にある。センターラインではなく
  // 実際の舗装外側+歩道分。西側=positive lateral=rightWidthAt が管轄)
  const eastX = turn.x - rightWidthAt((tojiDo.s + turn.s) / 2) - 2.5;
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

function makeLabelTexture(text) {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1e2a33';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 46px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 箱型工場・倉庫を1棟配置(共通ヘルパー)。社名等の表示はしない。
 * lat は「道路端(実際の舗装+セットバック)から建物中心までの距離」として、道路半幅
 * (leftWidthAt/rightWidthAt)+ setback + 建物自身の半幅(f.w/2)から算出する
 * (単純な固定オフセットだと大きな建物ほど道路側へ食い込むため、必ず建物半幅を足す)。
 */
function buildLabeledFactory(scene, path, f) {
  const roadHW = f.side < 0 ? leftWidthAt(f.s) : rightWidthAt(f.s);
  const lat = f.side * (roadHW + (f.setback ?? 8) + f.w / 2);
  const a = anchor(path, f.s, lat);
  const g = new THREE.Group();
  g.position.set(a.x, 0, a.z);
  g.rotation.y = a.ry;
  const body = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h, f.d), mat(f.color));
  body.position.y = f.h / 2;
  g.add(body);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(f.w + 1.2, 0.6, f.d + 1.2), mat(0x5d6268));
  roof.position.y = f.h + 0.3;
  g.add(roof);
  scene.add(g);
  return { x: a.x, z: a.z, r: Math.max(f.w, f.d) / 2 + 8 };
}

/** 西高瀬川(天神橋)〜桂川(久我橋)間の沿道工場(オムロン京都太陽・有本機業) */
function buildRiverIndustries(scene, path) {
  const bridgeS = (prefix) => route.bridges.find((b) => b.name.startsWith(prefix))?.s;
  const s0 = bridgeS('天神橋');
  const s1 = bridgeS('久我橋');
  if (s0 == null || s1 == null) return [];
  const mid = (s0 + s1) / 2;
  const specs = [
    { name: 'オムロン京都太陽', s: mid - 60, side: 1, setback: 10, w: 46, d: 30, h: 9, color: 0xd9d4c6 },
    { name: '有本機業', s: mid + 55, side: -1, setback: 10, w: 34, d: 24, h: 7, color: 0xb7bcc0 },
  ];
  return specs.map((f) => buildLabeledFactory(scene, path, f));
}

/**
 * 菱妻神社前〜久我石原町間の工場・倉庫群(玉村運輸・松下精機・原田工業・山幸製作所・
 * 京セラ京都伏見事業所)。京セラは終点(久我石原町バス停)の東隣の大規模な敷地として、
 * 終点直前に配置する。
 */
function buildKugaIndustries(scene, path) {
  const stopSByName = (name) => route.stops.find((st) => st.name === name)?.s;
  const s0 = stopSByName('菱妻神社前');
  const s1 = stopSByName('久我石原町');
  if (s0 == null || s1 == null) return [];
  const specs = [
    { name: '玉村運輸', s: s0 + 55, side: 1, setback: 6, w: 30, d: 20, h: 6.5, color: 0xc9c2b0 },
    { name: '松下精機', s: s0 + 130, side: -1, setback: 6, w: 26, d: 22, h: 7.5, color: 0xb9bdb9 },
    { name: '原田工業', s: s0 + 215, side: 1, setback: 6, w: 32, d: 22, h: 7, color: 0xaeb4a8 },
    { name: '山幸製作所', s: s0 + 290, side: -1, setback: 6, w: 24, d: 20, h: 6.5, color: 0xc4bca6 },
    { name: '京セラ 京都伏見事業所', s: s1 - 85, side: -1, setback: 8, w: 70, d: 46, h: 11, color: 0xd8dbd8 },
  ];
  return specs.map((f) => buildLabeledFactory(scene, path, f));
}

/**
 * 久我石原町バス終点(京セラ京都伏見事業所の西隣の敷地内)。
 * バス駐車スペース(区画線入り舗装)と屋根付きバス停(乗降場)を表現。
 * バスは進行方向左側(negative lateral)の縁石に着けて停まる規約に合わせ、
 * 敷地は経路の負側(curbStopLat と同じ側)に置く。
 *
 * 終点直前(s≈10505)に府道202→南への支線への右左折交差点(実データ由来の急カーブ)が
 * あるため、円弧のど真ん中に敷地を置くと接線が急回転して歪む。円弧を抜けた先の
 * 短い直線区間(sOut〜経路終端)に敷地を収める。
 */
function buildTerminus(scene, path) {
  const stop = route.stops.find((st) => st.name === '久我石原町');
  if (!stop) return { x: 0, z: 0, r: 0 };

  // 敷地の舗装(バス駐車スペース)。local X=道路と直交(奥行き)・local Z=道路沿い(長さ)
  const lotW = 26, lotD = 28; // lotW: 道路からの奥行き, lotD: 道路沿いの長さ

  const turn = route.turnIntersections.find((t) => Math.abs(t.s - stop.s) < 60);
  const availFrom = turn ? turn.sOut + 2 : Math.max(0, stop.s - lotD / 2);
  const availTo = path.length - 3;
  let s = availFrom + lotD / 2;
  if (s + lotD / 2 > availTo) s = availTo - lotD / 2;

  const HW = leftWidthAt(s);
  const a = anchor(path, s, -(HW + 14)); // 縁石の外側、敷地中央
  const g = new THREE.Group();
  g.position.set(a.x, 0, a.z);
  g.rotation.y = a.ry;
  const pavement = new THREE.Mesh(new THREE.PlaneGeometry(lotW, lotD), mat(0x6a6e70));
  pavement.rotation.x = -Math.PI / 2;
  pavement.position.y = 0.02;
  g.add(pavement);

  // 駐車区画の白線(道路沿いに2台分・各区画は道路と直交する線で仕切る)
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8 });
  for (const zBay of [-9, 0, 9]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(lotW - 4, 0.18), lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(2, 0.03, zBay);
    g.add(line);
  }

  // 屋根付きバス停(乗降場)。道路(縁石)寄りの敷地端に設置。
  const shelter = new THREE.Group();
  shelter.position.set(lotW / 2 - 4, 0, 0);
  shelter.rotation.y = Math.PI / 2;
  const postMat = mat(0x8a8f94);
  for (const [px, pz] of [[-4.2, -3.5], [4.2, -3.5], [-4.2, 3.5], [4.2, 3.5]]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.6, 8), postMat);
    post.position.set(px, 1.3, pz);
    shelter.add(post);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(9.4, 0.25, 8.2), mat(0x2f5c46));
  roof.position.y = 2.7;
  shelter.add(roof);
  const bench = new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, 1.2), mat(0x8f8577));
  bench.position.set(0, 0.5, 2.6);
  shelter.add(bench);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 0.9),
    new THREE.MeshBasicMaterial({ map: makeLabelTexture('久我石原町'), side: THREE.DoubleSide })
  );
  sign.position.set(0, 3.4, 0);
  shelter.add(sign);
  g.add(shelter);

  // 敷地境界のフェンス(京セラ側・奥側の3辺のみ。道路側は出入口として開放)
  const fenceMat = mat(0xb4b8b4);
  for (const [w, d, x, z] of [[lotW, 0.3, 0, -lotD / 2], [lotW, 0.3, 0, lotD / 2], [0.3, lotD, -lotW / 2, 0]]) {
    const fence = new THREE.Mesh(new THREE.BoxGeometry(w, 1.4, d), fenceMat);
    fence.position.set(x, 0.7, z);
    g.add(fence);
  }

  scene.add(g);
  return { x: a.x, z: a.z, r: Math.max(lotW, lotD) / 2 + 6 };
}

/** すべてのランドマークを配置し、建物生成の除外域リストを返す */
export function buildLandmarks(scene, path) {
  return [
    buildToji(scene, path),
    buildNijoStation(scene, path),
    buildAquarium(scene, path),
    buildRajomon(scene, path),
    buildKyotoTower(scene, path),
    ...buildRiverIndustries(scene, path),
    ...buildKugaIndustries(scene, path),
    buildTerminus(scene, path),
  ];
}
