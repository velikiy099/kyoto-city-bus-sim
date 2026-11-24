import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import LANDMARK_DEFS from "../data/definitions/landmarks.json" with { type: "json" };
import { route, rightWidthAt } from "../route/routeData.js";
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
  const blankSignMat = new THREE.MeshLambertMaterial({ color: 0x0e1217 });
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const blank = (m) => (m.name === "BusSignDisplay" ? blankSignMat : m);
    o.material = Array.isArray(o.material)
      ? o.material.map(blank)
      : blank(o.material);
  });
  busLib = gltf.scene;
  for (const fill of pendingBus.splice(0)) fill();
});
/** 駐機中のバス(前方=+z)。走行させないので update() は呼ばない */
function makeParkedBus() {
  const holder = new THREE.Group();
  const fill = () => {
    const node = busLib.clone(true);
    node.position.set(0, 0, -1.765); // bus.glb は原点=後軸中心(Z=-3.48..+7.01, 中点+1.765)なので車体中心を holder 原点へ
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
const TOJI_POS = LANDMARK_DEFS.TOJI_POS;

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
  const tojiDo = findIx(LANDMARK_DEFS.TOJI_REFS.northIntersection);
  const keihan = findIx(LANDMARK_DEFS.TOJI_REFS.westIntersection);
  const turn = route.turnIntersections.find((t) => t.crossName === LANDMARK_DEFS.TOJI_REFS.turnCrossName);
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
    { x: keigamon.x, z: keigamon.z, r: LANDMARK_DEFS.TOJI_REFS.keigamonExclusion.radius },
  ];
}

/** 京都水族館+梅小路公園 */
function buildAquarium(scene, path) {
  const s = stopS(LANDMARK_DEFS.AQUARIUM.stopName);
  const PARK_HALF_W = LANDMARK_DEFS.AQUARIUM.parkHalfWidthM; // PlaneGeometry(150,120) の半幅(道路と垂直な方向)
  const lat = rightWidthAt(s + LANDMARK_DEFS.AQUARIUM.sOffsetM) + 3.2 + 8 + PARK_HALF_W; // 車道+歩道+余白の外側に芝生の内縁を置く
  const a = anchor(path, s + LANDMARK_DEFS.AQUARIUM.sOffsetM, lat); // 右(西)側
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
  return { x: a.x, z: a.z, r: LANDMARK_DEFS.AQUARIUM.exclusionRadiusM };
}

/** 京都タワー(遠景・東方向) */
function buildKyotoTower(scene, path) {
  const s = stopS(LANDMARK_DEFS.KYOTO_TOWER.stopName);
  const a = anchor(path, s, LANDMARK_DEFS.KYOTO_TOWER.lateralM); // 左(東)遠方
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
  return { x: a.x, z: a.z, r: LANDMARK_DEFS.KYOTO_TOWER.exclusionRadiusM };
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
 * 久我石原町バス終点(京セラ京都伏見事業所の西隣の敷地内)。実際の操車場と同じく、
 * 敷地は道路(経路)の向きに関係なく世界座標の南北・東西軸に揃えて置く(北側を出入口として
 * 開放した形)。府道202は敷地の北側を通り、敷地内に南へ伸びる公道は置かない。南東の角に
 * バス駐車区画を2つ(いずれも北向き)設け、1台だけを駐機させる。
 *
 * 終点構内の南北 parking_aisle は公道ではないため経路から除外し、府道202の南側にある
 * OSMの転回場・停留所座標を基準に敷地を置く(位置決めのみ経路を使い、向きは使わない)。
 */
// 久我石原町敷地(操車場)の寸法。OSM landuse=garages の実測範囲に合わせる。
const TERMINUS_LOT = LANDMARK_DEFS.TERMINUS.LOT;
const TERMINUS_STOP_INSET = LANDMARK_DEFS.TERMINUS.STOP_INSET; // 西端・北端からポールまで

/**
 * 久我石原町敷地のアンカー(位置)を計算。buildTerminus と stops.js(バス停を
 * 道路上ではなく敷地内に置くため)の両方から参照する共通ロジック。
 * 実際の引き込み路(府道202号線→終点)はごく短い(約15m)ため、敷地もそれに合わせて
 * ターン頂点(≒府道202号線)のすぐ先にコンパクトに収める。
 * 敷地自体は世界座標軸に揃えるため、返り値の ry は常に 0(北=-Z, 東=+X)。
 * OSMのバス停座標を基準に、西端・北寄りへ敷地を復元する。南北の構内道路は経路に含めない。
 */
export function terminusLotAnchor(path) {
  const stop = route.stops.find((st) => st.name === LANDMARK_DEFS.TERMINUS.stopName);
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
  const s = Math.max(0, Math.min(path.length, stop.s - LANDMARK_DEFS.TERMINUS.legacyFallback.sBackM));
  const { x, z } = anchor(path, s, LANDMARK_DEFS.TERMINUS.legacyFallback.lateralM);
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
    mat(0x55585a),
  );
  pavement.rotation.x = -Math.PI / 2;
  pavement.position.y = 0.035;
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
    line.position.set(x, 0.048, bayZ);
    g.add(line);
  }
  const backLine = new THREE.Mesh(
    new THREE.PlaneGeometry(bayRightX - bayLeftX, 0.15),
    lineMat,
  );
  backLine.rotation.x = -Math.PI / 2;
  backLine.position.set((bayLeftX + bayRightX) / 2, 0.048, bayBackZ);
  g.add(backLine);

  // The terminal pole, shelter and north-facing stopping frame are generated
  // together with every other stop in game/stops.js.

  // 駐機バス(北向き=-Z 向き)。敷地は世界軸に揃っているため、そのまま π で北を向く。
  // 駐車区画は2つ設けるが、実際に配置するバスは1台のみ(南東の角=bay2)。
  const bus = makeParkedBus();
  bus.position.set(bay2X, 0, bayZ);
  bus.rotation.y = Math.PI;
  g.add(bus);

  // 南西隅の乗務員休憩所(白いプレハブ小屋)
  const shed = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 2.5, 4.0),
    mat(0xe8eae6),
  );
  shed.position.set(-lotW / 2 + 1.6, 1.25, lotD / 2 - 2.4);
  g.add(shed);

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
 * みぶ操車場前バス停の反対側(進行方向右・後院通南西側)にある京都市交通局・壬生操車場。
 * Google Map / ストリートビューの実配置に合わせ、北西道路際に2階建事務所、
 * 南東塀(中京警察署側)沿いに北西向き直角駐車6区画(道路側1区画空き＋バス5台)、
 * 北西側(事務所奥)に南東向き直角駐車3区画(バス3台)、北東半分を転回用エプロンとして配置する。
 */
function buildMibuDepot(scene, path) {
  const def = LANDMARK_DEFS.MIBU_DEPOT;
  const stop = route.stops.find((st) => st.name === def.stopName);
  if (!stop) return { x: 0, z: 0, r: 0 };
  const s = stop.s;
  const sCenter = s + (def.sOffsetM ?? 0);
  const HW = rightWidthAt(sCenter);
  const lotW = def.lotW,
    lotD = def.lotD; // lotW: 道路からの奥行き(+X=後院通側, -X=南西奥), lotD: 道路沿い(+Z=南東/警察署側, -Z=北西/事務所側)
  const a = anchor(path, sCenter, HW + def.roadSetbackM + lotW / 2);
  const g = new THREE.Group();
  g.position.set(a.x, 0, a.z);
  g.rotation.y = a.ry;

  const pavement = new THREE.Mesh(
    new THREE.PlaneGeometry(lotW, lotD),
    mat(0x55585a),
  );
  pavement.rotation.x = -Math.PI / 2;
  pavement.position.y = 0.035;
  g.add(pavement);

  // 1. 2階建てクリーム色の操車場事務所 (北西道路際: x=-0.5..+19.5, z=-17.7..-7.1)
  const officeW = 20.0,
    officeH = 6.2,
    officeD = 10.6;
  const officeX = 9.5,
    officeZ = -12.4;
  const office = new THREE.Mesh(
    new THREE.BoxGeometry(officeW, officeH, officeD),
    mat(0xdcd7c6),
  );
  office.position.set(officeX, officeH / 2, officeZ);
  g.add(office);
  const officeRoof = new THREE.Mesh(
    new THREE.BoxGeometry(officeW + 0.5, 0.35, officeD + 0.5),
    mat(0xeceee8),
  );
  officeRoof.position.set(officeX, officeH + 0.17, officeZ);
  g.add(officeRoof);
  const officeRoofTrim = new THREE.Mesh(
    new THREE.BoxGeometry(officeW + 0.6, 0.16, officeD + 0.6),
    mat(0x4a4f55),
  );
  officeRoofTrim.position.set(officeX, officeH + 0.05, officeZ);
  g.add(officeRoofTrim);

  // 事務所の1F・2F窓帯(南東向き正面＋北東向き道路面)と1F庇
  const winMat = mat(0x28323c);
  for (const wy of [1.8, 4.5]) {
    const winSE = new THREE.Mesh(new THREE.PlaneGeometry(16.5, 1.3), winMat);
    winSE.position.set(officeX, wy, officeZ + officeD / 2 + 0.03);
    g.add(winSE);
    const winNE = new THREE.Mesh(new THREE.PlaneGeometry(8.2, 1.3), winMat);
    winNE.rotation.y = Math.PI / 2;
    winNE.position.set(officeX + officeW / 2 + 0.03, wy, officeZ);
    g.add(winNE);
  }
  const canopy = new THREE.Mesh(
    new THREE.BoxGeometry(17.5, 0.18, 1.1),
    mat(0x3a3e42),
  );
  canopy.position.set(officeX, 2.95, officeZ + officeD / 2 + 0.55);
  g.add(canopy);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(7.2, 1.4),
    new THREE.MeshBasicMaterial({
      map: makeLabelTexture("京都市交通局 壬生操車場"),
      side: THREE.DoubleSide,
    }),
  );
  sign.position.set(officeX, officeH + 1.0, officeZ + officeD / 2 + 0.05);
  g.add(sign);

  // 白線区画ヘルパー (1区画 3.8m幅 × 11.5m長)
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8 });
  const addBayGroup = (bx, bz, bry) => {
    const grp = new THREE.Group();
    grp.position.set(bx, 0, bz);
    grp.rotation.y = bry;
    for (const side of [-1, 1]) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 11.5), lineMat);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(side * 1.9, 0.045, 0);
      grp.add(stripe);
    }
    const backLine = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 0.14), lineMat);
    backLine.rotation.x = -Math.PI / 2;
    backLine.position.set(0, 0.045, -5.75);
    grp.add(backLine);
    g.add(grp);
  };

  // 2. 南東塀沿い(中京警察署側)の直角駐車6区画: 前面は北西(-Z, 向き Math.PI)
  // 道路側(x=+9.5)の1区画は空きとし、残り5区画(x=+5.7..-9.5)にバスを駐機
  const seXs = [9.5, 5.7, 1.9, -1.9, -5.7, -9.5];
  for (let i = 0; i < seXs.length; i++) {
    const bx = seXs[i];
    addBayGroup(bx, 12.25, Math.PI);
    if (i >= 1) {
      const bus = makeParkedBus();
      bus.position.set(bx, 0, 12.25);
      bus.rotation.y = Math.PI;
      g.add(bus);
    }
  }

  // 道路際・南東隅の黄色ゼブラ帯(ストリートビュー相当)
  const yellowMat = new THREE.MeshBasicMaterial({ color: 0xeab308 });
  for (let k = 0; k < 5; k++) {
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 0.25), yellowMat);
    bar.rotation.x = -Math.PI / 2;
    bar.rotation.z = Math.PI / 6;
    bar.position.set(15.5, 0.044, 11.0 + k * 1.45);
    g.add(bar);
  }

  // 3. 北西側(事務所南西隣)の直角駐車3区画: 前面は南東(+Z, 向き 0)
  for (const bx of [-3.8, -7.6, -11.4]) {
    addBayGroup(bx, -12.25, 0);
    const bus = makeParkedBus();
    bus.position.set(bx, 0, -12.25);
    bus.rotation.y = 0;
    g.add(bus);
  }

  // 4. 敷地南東・南西の低い境界ブロック塀＋フェンス(北東・後院通側は出入口として開放)
  const wallBaseMat = mat(0xb8b8b0);
  const fenceTopMat = mat(0x2d2420);
  for (const [fw, fd, fx, fz] of [
    [39.3, 0.35, -0.15, 18.35], // 南東塀(中京警察署境界)
    [0.35, 36.7, -19.8, 0.0], // 南西奥フェンス
  ]) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.7, fd), wallBaseMat);
    base.position.set(fx, 0.35, fz);
    g.add(base);
    const top = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.9, fd * 0.7), fenceTopMat);
    top.position.set(fx, 1.15, fz);
    g.add(top);
  }

  scene.add(g);
  // PLATEAU側は事務所建物(bldg_3e50bbcd)のみを除外し、隣接する中京警察署や後背建物は残す
  const officeWorld = anchor(path, s - 30.8, 19.5);
  return { x: officeWorld.x, z: officeWorld.z, r: 10 };
}

/** すべてのランドマークを配置し、建物生成の除外域リストを返す */
export function buildLandmarks(scene, path) {
  return [
    ...buildToji(scene, path),
    buildAquarium(scene, path),
    buildKyotoTower(scene, path),
    // 桂川西岸の手動建物は置かない。久我石原町の終点転回場だけは残す。
    buildTerminus(scene, path),
    buildMibuDepot(scene, path),
  ];
}
