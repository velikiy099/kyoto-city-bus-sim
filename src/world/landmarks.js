import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { route, rightWidthAt, leftWidthAt } from "../route/routeData.js";
import { lambertize } from "../util/lambertize.js";

const mat = (color, opts = {}) =>
  new THREE.MeshLambertMaterial({ color, ...opts });

// OSM の surface タグを、ロータリーの路面ポリゴン用の色へ変換する。
// surface 未設定の service/unclassified は、この地域の実測タグに合わせて
// asphalt 相当(舗装路)として扱う。
const OSM_SURFACE_COLORS = {
  asphalt: 0x55585a,
  concrete: 0x777a78,
  paving_stones: 0x8c887e,
  cobblestone: 0x817d74,
  sett: 0x817d74,
  fine_gravel: 0x9a907f,
  gravel: 0x918875,
  compacted: 0x8d8578,
  unpaved: 0x7e776b,
  ground: 0x7e776b,
  dirt: 0x7e776b,
  sand: 0xa99a7c,
};

function osmSurfaceMaterial(tags, materials) {
  const surface = String(tags?.surface ?? "").toLowerCase();
  const color = OSM_SURFACE_COLORS[surface] ?? OSM_SURFACE_COLORS.asphalt;
  if (!materials.has(color)) materials.set(color, mat(color));
  return materials.get(color);
}

// ===== 駐機バス(bus.glb を共有ロードし、静止状態でクローンして量産) =====
const busLoader = new GLTFLoader();
let busLib = null;
const pendingBus = [];
busLoader.load("models/bus.glb", (gltf) => {
  lambertize(gltf.scene);
  busLib = gltf.scene;
  for (const fill of pendingBus.splice(0)) fill();
});
/** 駐機中のバス(前方=+z)。走行させないので update() は呼ばない */
function makeParkedBus() {
  const holder = new THREE.Group();
  const fill = () => {
    const node = busLib.clone(true);
    node.position.set(0, 0, -3.15); // bus.glb は原点=後軸中心なので車体中心を holder 原点へ
    holder.add(node);
  };
  if (busLib) fill();
  else pendingBus.push(fill);
  return holder;
}

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
  const tojiDo = findIx("東寺道");
  const keihan = findIx("京阪国道口(国道1号)");
  const turn = route.turnIntersections.find((t) => t.crossName === "大宮通");
  if (!tojiDo || !keihan || !turn) {
    scene.add(g);
    return { x: 0, z: 0, r: 0 };
  }

  const [, northZ] = path.getPoint(tojiDo.s); // 北端: 東寺道交差点の緯度
  // 東端: 大宮通(九条大宮進入直前)の西側路端(東寺は大宮通の西側にある。センターラインではなく
  // 実際の舗装外側+歩道分。西側=positive lateral=rightWidthAt が管轄)
  const eastX = turn.x - rightWidthAt((tojiDo.s + turn.s) / 2) - 2.5;
  // 南端: 九条通(九条大宮交差点)の進入側路端。turn.z(交差点中心)をそのまま使うと
  // 九条通の舗装に食い込むため、進入側道路半幅(turn.hwIn)+余白ぶん北へ後退させる。
  const southZ = turn.z - turn.hwIn - 2.5;
  const [westX] = path.getPoint(keihan.s); // 西端: 京阪国道口交差点の経度
  const w = eastX - westX;
  const d = southZ - northZ;
  const cx = (eastX + westX) / 2,
    cz = (northZ + southZ) / 2;
  g.position.set(cx, 0, cz);

  // 境内(砂利色) と 塀
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(0xcabfa5));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.08;
  g.add(ground);
  for (const [ww, dd, x, z] of [
    [w, 2, 0, -d / 2],
    [w, 2, 0, d / 2],
    [2, d, -w / 2, 0],
    [2, d, w / 2, 0],
  ]) {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(ww, 3.2, dd),
      mat(0xe8e0d0),
    );
    wall.position.set(x, 1.6, z);
    g.add(wall);
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(ww + 0.6, 0.5, dd + 0.6),
      mat(0x4a4f55),
    );
    cap.position.set(x, 3.4, z);
    g.add(cap);
  }

  // 五重塔(境内の南東寄り = 九条大宮交差点の北西方向。実際の伽藍配置と同じ)
  // 元々の相対位置(南壁修正前の southZ=turn.z 基準)から、九条大宮交差点(turn)に向けて10m近づける。
  const pagoda = new THREE.Group();
  const pagodaVecX = eastX - 65 - turn.x;
  const pagodaVecZ = -55;
  const pagodaDist = Math.hypot(pagodaVecX, pagodaVecZ);
  const pagodaScale = Math.max(0, (pagodaDist - 10) / pagodaDist);
  const pagodaWorldX = turn.x + pagodaVecX * pagodaScale;
  const pagodaWorldZ = turn.z + pagodaVecZ * pagodaScale;
  pagoda.position.set(pagodaWorldX - cx, 0, pagodaWorldZ - cz);
  let y = 0;
  for (let i = 0; i < 5; i++) {
    const bw = 12.5 - i * 1.7;
    const bh = 7.2 - i * 0.55;
    const bodyM = new THREE.Mesh(
      new THREE.BoxGeometry(bw, bh, bw),
      mat(0x8a4b32),
    );
    bodyM.position.y = y + bh / 2;
    pagoda.add(bodyM);
    y += bh;
    const roofW = bw + 5.2;
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(roofW / 1.32, 2.6, 4),
      mat(0x3d4750),
    );
    roof.rotation.y = Math.PI / 4;
    roof.position.y = y + 1.3;
    pagoda.add(roof);
    y += 1.9;
  }
  const finial = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.5, 9.5, 8),
    mat(0xb8933e),
  );
  finial.position.y = y + 4.7;
  pagoda.add(finial);
  g.add(pagoda);

  // 金堂(大きな寄棟屋根の堂・境内中央よりやや北)
  const hall = new THREE.Group();
  hall.position.set(0, 0, -d * 0.12);
  const hallBody = new THREE.Mesh(
    new THREE.BoxGeometry(38, 10, 26),
    mat(0xa08464),
  );
  hallBody.position.y = 5;
  hall.add(hallBody);
  const hallRoof = new THREE.Mesh(
    new THREE.ConeGeometry(30, 7, 4),
    mat(0x3d4750),
  );
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
  const s = stopS("二条駅西口");
  const a = anchor(path, s + 40, -68); // 発車直後の左(北東)側
  const g = new THREE.Group();
  g.position.set(a.x, 0, a.z);
  g.rotation.y = a.ry + Math.PI / 2; // 駅は南北に長い

  const roof = new THREE.Mesh(
    new THREE.CylinderGeometry(13, 13, 92, 24, 1, false, 0, Math.PI),
    mat(0x9fb8c8, { side: THREE.DoubleSide }),
  );
  roof.rotation.z = Math.PI / 2;
  roof.rotation.y = Math.PI / 2;
  roof.position.y = 9;
  g.add(roof);
  const base = new THREE.Mesh(new THREE.BoxGeometry(26, 9, 90), mat(0xd8dcd8));
  base.position.y = 4.5;
  g.add(base);
  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(22, 2.0, 0.4),
    mat(0x2b4a66),
  );
  sign.position.set(0, 7.5, 45.5);
  g.add(sign);

  // 駅前ロータリーの細いサービス路はPLATEAUの大きな道路面だけでは
  // つぶれやすいため、OSMのservice/unclassified wayを駅前範囲だけ重ねる。
  // 座標はroute18.json生成時にOSMから投影済みで、駅本体と同じ原点・向きへ戻す。
  const roadMaterials = new Map();
  const worldToLocal = ([x, z]) => {
    const dx = x - a.x;
    const dz = z - a.z;
    return [
      Math.cos(g.rotation.y) * dx + Math.sin(g.rotation.y) * dz,
      -Math.sin(g.rotation.y) * dx + Math.cos(g.rotation.y) * dz,
    ];
  };
  for (const road of route.osmStationRoads ?? []) {
    const points = road.points ?? [];
    const tags = road.tags ?? {};
    const lanes = Number(tags.lanes) || 1;
    const width = Number.parseFloat(tags.width) || (tags.highway === "service" ? 4.8 : lanes * 3.2 + 1.0);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = worldToLocal(points[i]);
      const p1 = worldToLocal(points[i + 1]);
      const dx = p1[0] - p0[0];
      const dz = p1[1] - p0[1];
      const length = Math.hypot(dx, dz);
      if (length < 1) continue;
      const roadMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width, length),
        osmSurfaceMaterial(tags, roadMaterials),
      );
      roadMesh.rotation.x = -Math.PI / 2;
      roadMesh.rotation.z = -Math.atan2(dx, dz);
      roadMesh.position.set((p0[0] + p1[0]) / 2, 0.04, (p0[1] + p1[1]) / 2);
      g.add(roadMesh);
    }
  }
  scene.add(g);
  return { x: a.x, z: a.z, r: 72 };
}

/** 京都水族館+梅小路公園 */
function buildAquarium(scene, path) {
  const s = stopS("七条大宮・京都水族館前");
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
  const aqRoof = new THREE.Mesh(
    new THREE.BoxGeometry(56, 1.6, 34),
    mat(0xe8ecef),
  );
  aqRoof.position.set(-20, 12.8, -20);
  g.add(aqRoof);
  // 公園の木は OSM 実測の木に置き換わるため削除(nature.js で生成)
  scene.add(g);
  return { x: a.x, z: a.z, r: 95 };
}

/** 京都タワー(遠景・東方向) */
function buildKyotoTower(scene, path) {
  const s = stopS("七条大宮・京都水族館前");
  const a = anchor(path, s, -620); // 左(東)遠方
  const g = new THREE.Group();
  g.position.set(a.x, 0, a.z);
  const base = new THREE.Mesh(new THREE.BoxGeometry(40, 30, 40), mat(0xcfd4d8));
  base.position.y = 15;
  g.add(base);
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(3.2, 8, 70, 12),
    mat(0xeceff1),
  );
  shaft.position.y = 65;
  g.add(shaft);
  const obs = new THREE.Mesh(
    new THREE.CylinderGeometry(7.5, 7.5, 8, 12),
    mat(0xdadfe3),
  );
  obs.position.y = 103;
  g.add(obs);
  const tip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 1.6, 14, 8),
    mat(0xe57339),
  );
  tip.position.y = 114;
  g.add(tip);
  scene.add(g);
  return { x: a.x, z: a.z, r: 60 };
}

function makeLabelTexture(text) {
  const cv = document.createElement("canvas");
  cv.width = 512;
  cv.height = 128;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#1e2a33";
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 46px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
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
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(f.w, f.h, f.d),
    mat(f.color),
  );
  body.position.y = f.h / 2;
  g.add(body);
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(f.w + 1.2, 0.6, f.d + 1.2),
    mat(0x5d6268),
  );
  roof.position.y = f.h + 0.3;
  g.add(roof);
  scene.add(g);
  return { x: a.x, z: a.z, r: Math.max(f.w, f.d) / 2 + 8 };
}

/** 太陽の家・有本機業は手動箱を置かず、OSM建物フットプリントだけを表示する。 */
function buildRiverIndustries() {
  return [];
}

/**
 * 菱妻神社前〜久我石原町間の工場・倉庫群(玉村運輸・松下精機・原田工業・山幸製作所・
 * 京セラ京都伏見事業所)。京セラは終点(久我石原町バス停)の東隣の大規模な敷地として、
 * 終点直前に配置する。
 */
function buildKugaIndustries(scene, path) {
  const stopSByName = (name) => route.stops.find((st) => st.name === name)?.s;
  const s0 = stopSByName("菱妻神社前");
  const s1 = stopSByName("久我石原町");
  if (s0 == null || s1 == null) return [];
  const specs = [
    {
      name: "玉村運輸",
      s: s0 + 55,
      side: 1,
      setback: 6,
      w: 30,
      d: 20,
      h: 6.5,
      color: 0xc9c2b0,
    },
    {
      name: "松下精機",
      s: s0 + 130,
      side: -1,
      setback: 6,
      w: 26,
      d: 22,
      h: 7.5,
      color: 0xb9bdb9,
    },
    {
      name: "原田工業",
      s: s0 + 215,
      side: 1,
      setback: 6,
      w: 32,
      d: 22,
      h: 7,
      color: 0xaeb4a8,
    },
    {
      name: "山幸製作所",
      s: s0 + 290,
      side: -1,
      setback: 6,
      w: 24,
      d: 20,
      h: 6.5,
      color: 0xc4bca6,
    },
    // 終点(久我石原町)敷地の道路反対側(西側)の倉庫群。実地図では PISORICO久我(手前)と
    // クレアジオーネ伏見(奥)が連なる大型倉庫として並ぶ。
    {
      name: "PISORICO久我",
      s: s1 - 95,
      side: 1,
      setback: 6,
      w: 60,
      d: 34,
      h: 8,
      color: 0xa9adae,
    },
    {
      name: "クレアジオーネ伏見",
      s: s1 - 45,
      side: 1,
      setback: 6,
      w: 26,
      d: 20,
      h: 7,
      color: 0xb8b2a0,
    },
  ];
  return specs.map((f) => buildLabeledFactory(scene, path, f));
}

/**
 * 久我石原町バス終点(京セラ京都伏見事業所の西隣の敷地内)。実際の操車場と同じく、
 * 敷地は道路(経路)の向きに関係なく世界座標の南北・東西軸に揃えて置く(北側を出入口として
 * 開放した形)。府道202は敷地の北側を通り、敷地内に南へ伸びる公道は置かない。南東の角に
 * バス駐車区画を2つ(いずれも北向き)設け、1台だけを駐機させる。
 *
 * 終点構内の南北 parking_aisle は公道ではないため経路から除外し、府道202の南側にある
 * OSMの転回場・停留所座標を基準に敷地を置く(位置決めのみ経路を使い、向きは使わない)。
 */
// 久我石原町敷地(操車場)の寸法。OSM landuse=garages の実測範囲に合わせる。
const TERMINUS_LOT = { w: 22.5, d: 24.7 };
const TERMINUS_STOP_INSET = { x: 1.8, z: 2.0 }; // 西端・北端からポールまで

/**
 * 久我石原町敷地のアンカー(位置)を計算。buildTerminus と stops.js(バス停を
 * 道路上ではなく敷地内に置くため)の両方から参照する共通ロジック。
 * 実際の引き込み路(府道202号線→終点)はごく短い(約15m)ため、敷地もそれに合わせて
 * ターン頂点(≒府道202号線)のすぐ先にコンパクトに収める。
 * 敷地自体は世界座標軸に揃えるため、返り値の ry は常に 0(北=-Z, 東=+X)。
 * OSMのバス停座標を基準に、西端・北寄りへ敷地を復元する。南北の構内道路は経路に含めない。
 */
export function terminusLotAnchor(path) {
  const stop = route.stops.find((st) => st.name === "久我石原町");
  if (!stop) return null;
  if (route.terminalStop) {
    const { x: stopX, z: stopZ } = route.terminalStop;
    return {
      s: stop.s,
      x: stopX + TERMINUS_LOT.w / 2 - TERMINUS_STOP_INSET.x,
      z: stopZ + TERMINUS_LOT.d / 2 - TERMINUS_STOP_INSET.z,
      stopX,
      stopZ,
      ry: 0,
      lotW: TERMINUS_LOT.w,
      lotD: TERMINUS_LOT.d,
    };
  }

  // 旧データ互換: OSM停留所メタデータがない場合も、終端手前の道路南側へ置く。
  const s = Math.max(0, Math.min(path.length, stop.s - 9.5));
  const { x, z } = anchor(path, s, -16.6);
  return {
    s,
    x,
    z,
    stopX: x - TERMINUS_LOT.w / 2 + TERMINUS_STOP_INSET.x,
    stopZ: z - TERMINUS_LOT.d / 2 + TERMINUS_STOP_INSET.z,
    ry: 0,
    lotW: TERMINUS_LOT.w,
    lotD: TERMINUS_LOT.d,
  };
}

/** 久我石原町のバス停位置。敷地西端で、バスは真北(-Z)を向く。 */
export function terminusStopAnchor(lot) {
  if (!lot) return null;
  return {
    x: lot.stopX ?? lot.x - (lot.lotW / 2 - TERMINUS_STOP_INSET.x),
    z: lot.stopZ ?? lot.z - (lot.lotD / 2 - TERMINUS_STOP_INSET.z),
    heading: Math.PI,
  };
}

function buildTerminus(scene, path) {
  const lot = terminusLotAnchor(path);
  if (!lot) return { x: 0, z: 0, r: 0 };
  const { lotW, lotD } = lot;
  const g = new THREE.Group();
  g.position.set(lot.x, 0, lot.z); // 向きは世界軸のまま(rotation.y=0): +X=東, +Z=南
  const pavement = new THREE.Mesh(
    new THREE.PlaneGeometry(lotW, lotD),
    mat(0x6a6e70),
  );
  pavement.rotation.x = -Math.PI / 2;
  pavement.position.y = 0.02;
  g.add(pavement);

  // 南東の角にバス駐車区画を2つ(いずれも北向き=バスの前面が-Z)。
  const BAY_W = 3.6,
    BAY_L = 11.5,
    MARGIN = 1;
  const bayRightX = lotW / 2 - MARGIN; // 東の縁からの余白
  const bayMidX = bayRightX - BAY_W;
  const bayLeftX = bayMidX - BAY_W;
  const bayFrontZ = lotD / 2 - MARGIN - BAY_L; // 区画の北端(開放側)
  const bayBackZ = lotD / 2 - MARGIN; // 区画の南端(フェンス側)
  const bay2X = (bayMidX + bayRightX) / 2; // 東側の区画(南東の角。駐機バスはここに置く)
  const bayZ = (bayFrontZ + bayBackZ) / 2;

  const lineMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8 });
  for (const x of [bayLeftX, bayMidX, bayRightX]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.15, BAY_L), lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(x, 0.03, bayZ);
    g.add(line);
  }
  const backLine = new THREE.Mesh(
    new THREE.PlaneGeometry(bayRightX - bayLeftX, 0.15),
    lineMat,
  );
  backLine.rotation.x = -Math.PI / 2;
  backLine.position.set((bayLeftX + bayRightX) / 2, 0.03, bayBackZ);
  g.add(backLine);

  // バス停(乗降場)。ガソリンスタンド風の大屋根は使わず、簡素なポール・上屋なしの
  // ベンチ+サインのみにする。敷地西端の北寄りに置き、バスは真北を向く。西側に道路は置かない。
  const stop = terminusStopAnchor(lot);
  const shelter = new THREE.Group();
  shelter.position.set(stop.x - lot.x, 0, stop.z - lot.z);
  shelter.rotation.y = stop.heading;
  const postMat = mat(0x9a9d9a);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 2.4, 8),
    postMat,
  );
  pole.position.set(0, 1.2, 0);
  shelter.add(pole);
  const bench = new THREE.Mesh(
    new THREE.BoxGeometry(3.6, 0.5, 1.0),
    mat(0x8f8577),
  );
  // shelter は北向きに回しているため、ベンチは回転後に敷地内(東側)へ来る側へ置く。
  bench.position.set(-1.8, 0.5, -0.9);
  shelter.add(bench);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 0.9),
    new THREE.MeshBasicMaterial({
      map: makeLabelTexture("久我石原町"),
      side: THREE.DoubleSide,
    }),
  );
  sign.position.set(0, 3.0, 0);
  shelter.add(sign);
  g.add(shelter);

  // 駐機バス(北向き=-Z 向き)。敷地は世界軸に揃っているため、そのまま π で北を向く。
  // 駐車区画は2つ設けるが、実際に配置するバスは1台のみ(南東の角=bay2)。
  const bus = makeParkedBus();
  bus.position.set(bay2X, 0, bayZ);
  bus.rotation.y = Math.PI;
  g.add(bus);

  // 敷地境界のフェンス(南・東・西の3辺。北側は出入口として開放)
  const fenceMat = mat(0xb4b8b4);
  for (const [w, d, x, z] of [
    [lotW, 0.3, 0, lotD / 2], // 南辺
    [0.3, lotD, lotW / 2, 0], // 東辺
    [0.3, lotD, -lotW / 2, 0], // 西辺
  ]) {
    const fence = new THREE.Mesh(new THREE.BoxGeometry(w, 1.4, d), fenceMat);
    fence.position.set(x, 0.7, z);
    g.add(fence);
  }

  scene.add(g);
  return { x: lot.x, z: lot.z, r: Math.max(lotW, lotD) / 2 + 6 };
}

/**
 * みぶ操車場前バス停の反対側(進行方向右)にある京都市交通局・壬生操車場。
 * 斜め駐車ベイ2列×4区画+事務所小屋を敷地内に置き、うち数区画にバスを駐機させる。
 */
function buildMibuDepot(scene, path) {
  const stop = route.stops.find((st) => st.name === "みぶ操車場前");
  if (!stop) return { x: 0, z: 0, r: 0 };
  const s = stop.s;
  const HW = rightWidthAt(s);
  const lotW = 50,
    lotD = 56; // lotW: 道路からの奥行き, lotD: 道路沿いの長さ
  const a = anchor(path, s, HW + 8 + lotW / 2);
  const g = new THREE.Group();
  g.position.set(a.x, 0, a.z);
  g.rotation.y = a.ry;

  const pavement = new THREE.Mesh(
    new THREE.PlaneGeometry(lotW, lotD),
    mat(0x6a6e70),
  );
  pavement.rotation.x = -Math.PI / 2;
  pavement.position.y = 0.02;
  g.add(pavement);

  // 事務所・車庫(道路から一番遠い奥側)
  const office = new THREE.Mesh(
    new THREE.BoxGeometry(16, 5.5, 9),
    mat(0xd7d2c4),
  );
  office.position.set(-lotW / 2 + 9, 2.75, -lotD / 2 + 5.5);
  g.add(office);
  const officeRoof = new THREE.Mesh(
    new THREE.BoxGeometry(17, 0.5, 10),
    mat(0x4a4f55),
  );
  officeRoof.position.set(-lotW / 2 + 9, 5.75, -lotD / 2 + 5.5);
  g.add(officeRoof);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(7, 1.5),
    new THREE.MeshBasicMaterial({
      map: makeLabelTexture("京都市交通局 壬生操車場"),
      side: THREE.DoubleSide,
    }),
  );
  sign.position.set(-lotW / 2 + 9, 6.8, -lotD / 2 + 5.5 + 5.05);
  g.add(sign);

  // 斜め駐車ベイ(2列×4区画。列ごとに逆向きの角度をつけて向かい合わせに配置)
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8 });
  const SKEW = (24 * Math.PI) / 180;
  const bays = [];
  for (const row of [-1, 1]) {
    const rowX = row * (lotW / 4 + 2);
    for (let i = 0; i < 4; i++) {
      bays.push({ x: rowX, z: -lotD / 2 + 12 + i * 11.2, ry: row * SKEW });
    }
  }
  for (const bay of bays) {
    const grp = new THREE.Group();
    grp.position.set(bay.x, 0, bay.z);
    grp.rotation.y = bay.ry;
    for (const side of [-1, 1]) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 12), lineMat);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(side * 1.7, 0.03, 0);
      grp.add(stripe);
    }
    g.add(grp);
  }

  // 駐機バス(各列2台ずつ、計4台)
  for (const bay of [bays[0], bays[1], bays[4], bays[5]]) {
    const bus = makeParkedBus();
    bus.position.set(bay.x, 0, bay.z);
    bus.rotation.y = bay.ry;
    g.add(bus);
  }

  scene.add(g);
  return { x: a.x, z: a.z, r: Math.hypot(lotW, lotD) / 2 + 6 };
}

/** すべてのランドマークを配置し、建物生成の除外域リストを返す */
export function buildLandmarks(scene, path) {
  return [
    buildToji(scene, path),
    buildNijoStation(scene, path),
    buildAquarium(scene, path),
    buildKyotoTower(scene, path),
    ...buildRiverIndustries(scene, path),
    ...buildKugaIndustries(scene, path),
    buildTerminus(scene, path),
    buildMibuDepot(scene, path),
  ];
}
