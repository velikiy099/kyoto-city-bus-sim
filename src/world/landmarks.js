import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { isNearRouteCorridor } from "../route/corridor.js";
import { lambertize } from "../util/lambertize.js";
import { snapHierarchyToTerrain } from "./declarative/continuousTerrain.js";

const mat = (color, opts = {}) =>
  new THREE.MeshLambertMaterial({ color, ...opts });

const gltfLoader = new GLTFLoader();

// ===== 駐機バス(bus.glb を共有ロードし、静止状態でクローンして量産) =====
let busLib = null;
const pendingBus = [];
if (typeof window !== "undefined") {
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
}

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
 * 寺院ランドマーク(境内・五重塔・金堂・三門)。
 * 地域共通ワールド座標と境界定義から配置し、経路コリドー外では生成しない。
 */
function buildToji(scene, path, defs) {
  const pos = defs?.TOJI_POS;
  const refs = defs?.TOJI_REFS;
  if (!pos || !refs?.bounds) return [];

  const { nandaimon, todaimon, keigamon } = pos;
  const northZ = Math.min(refs.bounds.northRefZ, keigamon.z - keigamon.halfGap - 2);
  const eastX = todaimon.x;
  const southZ = nandaimon.z;
  const westX = refs.bounds.westX;
  const w = eastX - westX;
  const d = southZ - northZ;
  const cx = (eastX + westX) / 2;
  const cz = (northZ + southZ) / 2;
  if (!isNearRouteCorridor(path, cx, cz, refs.corridorRadiusM ?? 450)) {
    return [];
  }

  const g = new THREE.Group();
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
  wallSeg(true, northZ, westX, eastX);
  wallSeg(false, westX, northZ, southZ);
  wallSeg(true, southZ, westX, nandaimon.x - nandaimon.halfGap);
  wallSeg(true, southZ, nandaimon.x + nandaimon.halfGap, eastX);
  wallSeg(false, eastX, northZ, keigamon.z - keigamon.halfGap);
  wallSeg(
    false,
    eastX,
    keigamon.z + keigamon.halfGap,
    todaimon.z - todaimon.halfGap,
  );
  wallSeg(false, eastX, todaimon.z + todaimon.halfGap, southZ);

  // 五重塔・三門(実測GLB)
  loadTojiModels().then(([pagodaLib, gatesLib]) => {
    const place = (lib, name, itemPos, ry) => {
      const node = lib.getObjectByName(name).clone(true);
      node.position.set(itemPos.x - cx, 0, itemPos.z - cz);
      node.rotation.y = ry;
      g.add(node);
      node.updateWorldMatrix(true, true);
      snapHierarchyToTerrain(node);
    };
    place(pagodaLib, "TojiPagoda", pos.pagoda, 0);
    place(gatesLib, "NandaiMon", nandaimon, 0);
    place(gatesLib, "TodaiMon", todaimon, Math.PI / 2);
    place(gatesLib, "KeigaMon", keigamon, Math.PI / 2);
  });

  // 金堂
  const hall = new THREE.Group();
  hall.position.set(pos.kondo.x - cx, 0, pos.kondo.z - cz);
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
    { x: keigamon.x, z: keigamon.z, r: refs.keigamonExclusion?.radius ?? 10 },
  ];
}

/** 水族館 + 公園芝生 */
function buildAquarium(scene, path, def) {
  if (!def?.worldPos) return null;
  const { x, z, ry = 0 } = def.worldPos;
  if (!isNearRouteCorridor(path, x, z, def.corridorRadiusM ?? 450)) return null;

  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;

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
  scene.add(g);
  return { x, z, r: def.exclusionRadiusM ?? 95 };
}

/** 遠景タワー */
function buildKyotoTower(scene, path, def) {
  if (!def?.worldPos) return null;
  const { x, z } = def.worldPos;
  if (!isNearRouteCorridor(path, x, z, def.corridorRadiusM ?? 1200)) return null;

  const g = new THREE.Group();
  g.position.set(x, 0, z);
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
  return { x, z, r: def.exclusionRadiusM ?? 60 };
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
 * 終点転回場敷地のアンカー(位置)を地域共通定義から計算する。
 */
export function terminusLotAnchor(lotDef) {
  if (!lotDef?.stopWorldPos || !lotDef?.LOT || !lotDef?.STOP_INSET) return null;
  const { x: stopX, z: stopZ } = lotDef.stopWorldPos;
  const { w: lotW, d: lotD } = lotDef.LOT;
  const inset = lotDef.STOP_INSET;
  return {
    x: stopX + lotW / 2 - inset.x,
    z: stopZ + lotD / 2 - inset.z,
    stopX,
    stopZ,
    ry: 0,
    lotW,
    lotD,
  };
}

/** 終点転回場内のバス停位置。 */
export function terminusStopAnchor(lot, lotDef = {}) {
  if (!lot) return null;
  const inset = lotDef.STOP_INSET ?? { x: 1.8, z: 2.0 };
  return {
    x: lot.stopX ?? lot.x - (lot.lotW / 2 - inset.x),
    z: lot.stopZ ?? lot.z - (lot.lotD / 2 - inset.z),
    heading: lotDef.heading ?? Math.PI,
  };
}

/**
 * 停留所に対する地域共通の転回場ポール位置オーバーライドを解決する。
 * 路線コリドーから外れた転回場には適用しない。
 */
export function resolveTerminusStopOverride(path, stop, defs) {
  if (!stop || !defs?.TERMINUS_LOTS?.length) return null;
  for (const lotDef of defs.TERMINUS_LOTS) {
    if (lotDef.stopName !== stop.name || !lotDef.stopWorldPos) continue;
    if (!isNearRouteCorridor(path, lotDef.stopWorldPos.x, lotDef.stopWorldPos.z, lotDef.corridorRadiusM ?? 250)) {
      continue;
    }
    return terminusStopAnchor(terminusLotAnchor(lotDef), lotDef);
  }
  return null;
}

function buildTerminusLot(scene, path, lotDef) {
  const lot = terminusLotAnchor(lotDef);
  if (!lot) return null;
  if (!isNearRouteCorridor(path, lot.x, lot.z, lotDef.corridorRadiusM ?? 250)) return null;

  const { lotW, lotD } = lot;
  const g = new THREE.Group();
  g.position.set(lot.x, 0, lot.z);
  const pavement = new THREE.Mesh(
    new THREE.PlaneGeometry(lotW, lotD),
    mat(0x55585a),
  );
  pavement.rotation.x = -Math.PI / 2;
  pavement.position.y = 0.035;
  g.add(pavement);

  // 南東の角にバス駐車区画を2つ(いずれも北向き=バスの前面が-Z)。
  const BAY_W = 3.6;
  const BAY_L = 11.5;
  const MARGIN = 1;
  const bayRightX = lotW / 2 - MARGIN;
  const bayMidX = bayRightX - BAY_W;
  const bayLeftX = bayMidX - BAY_W;
  const bayFrontZ = lotD / 2 - MARGIN - BAY_L;
  const bayBackZ = lotD / 2 - MARGIN;
  const bay2X = (bayMidX + bayRightX) / 2;
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

  const bus = makeParkedBus();
  bus.position.set(bay2X, 0, bayZ);
  bus.rotation.y = Math.PI;
  g.add(bus);

  // 乗務員休憩所(白いプレハブ小屋)
  const shed = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 2.5, 4.0),
    mat(0xe8eae6),
  );
  shed.position.set(-lotW / 2 + 1.6, 1.25, lotD / 2 - 2.4);
  g.add(shed);

  // 敷地境界のフェンス(南・東・西の3辺)
  const fenceMat = mat(0xb4b8b4);
  for (const [w, d, x, z] of [
    [lotW, 0.3, 0, lotD / 2],
    [0.3, lotD, lotW / 2, 0],
    [0.3, lotD, -lotW / 2, 0],
  ]) {
    const fence = new THREE.Mesh(new THREE.BoxGeometry(w, 1.4, d), fenceMat);
    fence.position.set(x, 0.7, z);
    g.add(fence);
  }

  scene.add(g);
  return { x: lot.x, z: lot.z, r: Math.max(lotW, lotD) / 2 + 6 };
}

/**
 * バス操車場(事務所・駐車区画・駐機バス・フェンス)を構築する。
 */
function buildMibuDepot(scene, path, def) {
  if (!def?.worldPos) return null;
  const { x, z, ry = 0 } = def.worldPos;
  if (!isNearRouteCorridor(path, x, z, def.corridorRadiusM ?? 350)) return null;

  const lotW = def.lotW ?? 40;
  const lotD = def.lotD ?? 37;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;

  const pavement = new THREE.Mesh(
    new THREE.PlaneGeometry(lotW, lotD),
    mat(0x55585a),
  );
  pavement.rotation.x = -Math.PI / 2;
  pavement.position.y = 0.035;
  g.add(pavement);

  // 1. 2階建て操車場事務所
  const officeW = 20.0;
  const officeH = 6.2;
  const officeD = 10.6;
  const officeX = 9.5;
  const officeZ = -12.4;
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
      map: makeLabelTexture(def.label ?? "バス操車場"),
      side: THREE.DoubleSide,
    }),
  );
  sign.position.set(officeX, officeH + 1.0, officeZ + officeD / 2 + 0.05);
  g.add(sign);

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

  const yellowMat = new THREE.MeshBasicMaterial({ color: 0xeab308 });
  for (let k = 0; k < 5; k++) {
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 0.25), yellowMat);
    bar.rotation.x = -Math.PI / 2;
    bar.rotation.z = Math.PI / 6;
    bar.position.set(15.5, 0.044, 11.0 + k * 1.45);
    g.add(bar);
  }

  for (const bx of [-3.8, -7.6, -11.4]) {
    addBayGroup(bx, -12.25, 0);
    const bus = makeParkedBus();
    bus.position.set(bx, 0, -12.25);
    bus.rotation.y = 0;
    g.add(bus);
  }

  const wallBaseMat = mat(0xb8b8b0);
  const fenceTopMat = mat(0x2d2420);
  for (const [fw, fd, fx, fz] of [
    [39.3, 0.35, -0.15, 18.35],
    [0.35, 36.7, -19.8, 0.0],
  ]) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.7, fd), wallBaseMat);
    base.position.set(fx, 0.35, fz);
    g.add(base);
    const top = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.9, fd * 0.7), fenceTopMat);
    top.position.set(fx, 1.15, fz);
    g.add(top);
  }

  scene.add(g);
  return def.officeExclusion ?? { x, z, r: 10 };
}

/** 路線コリドー周辺の地域ランドマークのみを配置し、建物生成の除外域リストを返す */
export function buildLandmarks(scene, path, options = {}) {
  const defs = options?.defs ?? {};
  const exclusions = [];
  if (defs.TOJI_POS && defs.TOJI_REFS) {
    exclusions.push(...buildToji(scene, path, defs));
  }
  const aq = buildAquarium(scene, path, defs.AQUARIUM);
  if (aq) exclusions.push(aq);
  const tower = buildKyotoTower(scene, path, defs.KYOTO_TOWER);
  if (tower) exclusions.push(tower);
  for (const lotDef of defs.TERMINUS_LOTS ?? []) {
    const lotExcl = buildTerminusLot(scene, path, lotDef);
    if (lotExcl) exclusions.push(lotExcl);
  }
  const depot = buildMibuDepot(scene, path, defs.MIBU_DEPOT);
  if (depot) exclusions.push(depot);
  return exclusions;
}
