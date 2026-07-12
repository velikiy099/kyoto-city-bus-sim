import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { route, rightWidthAt, leftWidthAt } from "../route/routeData.js";
import { lambertize } from "../util/lambertize.js";
import { snapHierarchyToTerrain } from "./declarative/continuousTerrain.js";

const mat = (color, opts = {}) =>
  new THREE.MeshLambertMaterial({ color, ...opts });

const gltfLoader = new GLTFLoader();

// ===== 駐機バス(bus.glb を共有ロードし、静止状態でクローンして量産) =====
let busLib = null;
const pendingBus = [];
gltfLoader.load("models/bus.glb", (gltf) => {
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

// ===== 東寺の実測アンカー(ゲーム座標) =====
// OSM(ODbL)実測の門位置と PLATEAU 実測の建物中心を、route18.json と同じ
// projOrigin [34.9746902, 135.7422893] の equirectangular で投影した値。
// halfGap は塀に空ける開口の半幅(門の屋根全長の半分+余白)。
const TOJI_POS = {
  pagoda: { x: 590.22, z: -578.63 }, // PLATEAU measuredHeight=55.0 の建物中心
  kondo: { x: 496.62, z: -632.03 }, // PLATEAU 金堂(高さ24.9m)の建物中心
  nandaimon: { x: 495.37, z: -540.99, halfGap: 13.3 }, // 南大門(屋根全長23.6m)
  todaimon: { x: 618.51, z: -667.9, halfGap: 9.3 }, // 東大門・不開門(同15.4m)
  keigamon: { x: 618.51, z: -799.26, halfGap: 9.4 }, // 慶賀門(同15.65m)
};

// 五重塔・三門の実測GLB(Blender製)。一度だけロードして共有する。
let tojiModelsPromise = null;
function loadTojiModels() {
  tojiModelsPromise ??= Promise.all(
    ["models/toji-pagoda.glb", "models/toji-gates.glb"].map(
      (url) =>
        new Promise((resolve, reject) => {
          gltfLoader.load(
            url,
            (gltf) => {
              lambertize(gltf.scene);
              resolve(gltf.scene);
            },
            undefined,
            reject,
          );
        }),
    ),
  );
  return tojiModelsPromise;
}

/**
 * 東寺(境内・五重塔・金堂・三門)。
 * 境内は実際の道路配置に接するよう矩形で囲む: 北端=東寺道交差点、西端=京阪国道口(国道1号)。
 * 東端の塀は東大門・慶賀門、南端の塀は南大門の実測中心線を通し、門の位置に開口を空ける。
 * 五重塔(GLB)は PLATEAU の該当建物(実測中心)を置き換える形で配置する。
 */
function buildToji(scene, path) {
  const g = new THREE.Group();
  const findIx = (name) => route.intersections.find((ix) => ix.name === name);
  const tojiDo = findIx("東寺道");
  const keihan = findIx("京阪国道口(国道1号)");
  const turn = route.turnIntersections.find((t) => t.crossName === "大宮通");
  if (!tojiDo || !keihan || !turn) {
    scene.add(g);
    return [];
  }

  // 北端: 東寺道交差点の緯度。ただし慶賀門(実測)は東寺道T字路の正面にあり
  // 交差点中心よりわずかに北なので、門の開口が塀に収まるところまで北へ広げる。
  const [, tojiDoZ] = path.getPoint(tojiDo.s);
  const { nandaimon, todaimon, keigamon } = TOJI_POS;
  const northZ = Math.min(tojiDoZ, keigamon.z - keigamon.halfGap - 2);
  const eastX = TOJI_POS.todaimon.x; // 東端: 東大門・慶賀門の中心線
  const southZ = TOJI_POS.nandaimon.z; // 南端: 南大門の中心線
  const [westX] = path.getPoint(keihan.s); // 西端: 京阪国道口交差点の経度
  const w = eastX - westX;
  const d = southZ - northZ;
  const cx = (eastX + westX) / 2,
    cz = (northZ + southZ) / 2;
  g.position.set(cx, 0, cz);

  // 境内(砂利色)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(0xcabfa5));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.08;
  g.add(ground);
  // 塀(門の開口部を除いて敷設)。horizontal=trueはX方向(南北の塀)。
  const wallSeg = (horizontal, fixed, from, to) => {
    const len = to - from;
    if (len < 1) return;
    const [ww, dd] = horizontal ? [len, 2] : [2, len];
    const x = (horizontal ? (from + to) / 2 : fixed) - cx;
    const z = (horizontal ? fixed : (from + to) / 2) - cz;
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
  };
  wallSeg(true, northZ, westX, eastX); // 北塀
  wallSeg(false, westX, northZ, southZ); // 西塀
  wallSeg(true, southZ, westX, nandaimon.x - nandaimon.halfGap); // 南塀(南大門の西)
  wallSeg(true, southZ, nandaimon.x + nandaimon.halfGap, eastX); // 南塀(南大門の東)
  wallSeg(false, eastX, northZ, keigamon.z - keigamon.halfGap); // 東塀(慶賀門の北)
  wallSeg(
    false,
    eastX,
    keigamon.z + keigamon.halfGap,
    todaimon.z - todaimon.halfGap,
  ); // 東塀(門間)
  wallSeg(false, eastX, todaimon.z + todaimon.halfGap, southZ); // 東塀(東大門の南)

  // 五重塔(実測GLB・PLATEAU建物中心)と三門(実測GLB・OSM実測位置)
  // 門の正面(ローカル+Z)は面する通りへ、開いた扉(ローカル-Z)は境内側へ向ける。
  loadTojiModels().then(([pagodaLib, gatesLib]) => {
    const place = (lib, name, pos, ry) => {
      const node = lib.getObjectByName(name).clone(true);
      node.position.set(pos.x - cx, 0, pos.z - cz);
      node.rotation.y = ry;
      g.add(node);
      node.updateWorldMatrix(true, true);
      snapHierarchyToTerrain(node);
    };
    place(pagodaLib, "TojiPagoda", TOJI_POS.pagoda, 0);
    place(gatesLib, "NandaiMon", nandaimon, 0); // 正面=九条通(南)
    place(gatesLib, "TodaiMon", todaimon, Math.PI / 2); // 正面=大宮通(東)
    place(gatesLib, "KeigaMon", keigamon, Math.PI / 2); // 正面=大宮通(東)
  });

  // 金堂(大きな寄棟屋根の堂・PLATEAU実測中心 = 南大門の伽藍軸上)
  const hall = new THREE.Group();
  hall.position.set(TOJI_POS.kondo.x - cx, 0, TOJI_POS.kondo.z - cz);
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
  return [
    { x: cx, z: cz, r: Math.max(w, d) / 2 + 15 },
    // 慶賀門は境内北東角にあり上の円から外れるため、PLATEAU側の門建物
    // (bldg_b170a8f2, 高さ8.3m)を個別に除外して GLB と重ならないようにする。
    { x: keigamon.x, z: keigamon.z, r: 10 },
  ];
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

  // The terminal pole, shelter and north-facing stopping frame are generated
  // together with every other stop in game/stops.js.

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
    ...buildToji(scene, path),
    buildAquarium(scene, path),
    buildKyotoTower(scene, path),
    ...buildRiverIndustries(scene, path),
    ...buildKugaIndustries(scene, path),
    buildTerminus(scene, path),
    buildMibuDepot(scene, path),
  ];
}
