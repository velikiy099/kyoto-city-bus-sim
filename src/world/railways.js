import * as THREE from "three";
import RAILWAY_DEFS from "../data/definitions/railways.json" with { type: "json" };
import {
  route,
  elevationAt,
  gradeAt,
  halfWidthAt,
} from "../route/routeData.js";
import { terrainHeightAtWorld } from "./declarative/continuousTerrain.js";

const mat = (color, opts = {}) =>
  new THREE.MeshLambertMaterial({ color, ...opts });

function at(path, s) {
  const [x, z] = path.getPoint(Math.max(0, Math.min(path.length - 0.1, s)));
  return { x, z };
}

function addRailPair(group, trackOffset, railY, railLength, railGauge = 1.35) {
  const sleeper = new THREE.Mesh(
    new THREE.BoxGeometry(2.7, 0.08, railLength),
    mat(0x5b4a3c),
  );
  sleeper.position.set(trackOffset, railY - 0.06, 0);
  group.add(sleeper);
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.12, railLength),
      mat(0xcbd0d5),
    );
    rail.position.set(trackOffset + (side * railGauge) / 2, railY, 0);
    group.add(rail);
  }
}

function addDeckRails(group, width, y, length) {
  for (const side of [-1, 1]) {
    const parapet = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 1.1, length),
      mat(0xbec5c9),
    );
    parapet.position.set(side * (width / 2 - 0.3), y, 0);
    group.add(parapet);
  }
}

const OMIYA_PARAPET_HEIGHT = 1.0;
const OMIYA_PARAPET_WIDTH = 0.3;
const OMIYA_PARAPET_SEGMENT = 4;

/** 大宮跨線橋の橋面端に、画像相当の約1m高コンクリート欄干だけを置く。 */
function addOmiyaParapets(scene, path, fromS, toS, deckHalf) {
  const material = mat(0xbfc4c7);
  for (const side of [-1, 1]) {
    for (let s = fromS; s < toS; s += OMIYA_PARAPET_SEGMENT) {
      const nextS = Math.min(toS, s + OMIYA_PARAPET_SEGMENT);
      const midS = (s + nextS) / 2;
      const [x, z] = path.getPoint(midS);
      const [tx, tz] = path.getTangent(midS);
      const nx = -tz;
      const nz = tx;
      const offset = side * (deckHalf + OMIYA_PARAPET_WIDTH / 2);
      const parapet = new THREE.Mesh(
        new THREE.BoxGeometry(
          OMIYA_PARAPET_WIDTH,
          OMIYA_PARAPET_HEIGHT,
          Math.max(0.5, nextS - s + 0.08),
        ),
        material,
      );
      parapet.position.set(
        x + nx * offset,
        elevationAt(midS) + OMIYA_PARAPET_HEIGHT / 2,
        z + nz * offset,
      );
      parapet.rotation.order = "YXZ";
      parapet.rotation.y = Math.atan2(tx, tz);
      parapet.rotation.x = -Math.atan(gradeAt(midS));
      parapet.name = "omiya-overpass-parapet";
      scene.add(parapet);
    }
  }
}

function buildConventionalUnderpass(scene, path, spec) {
  const p = at(path, spec.s);
  const g = new THREE.Group();
  g.position.set(p.x, terrainHeightAtWorld(p.x, p.z), p.z);
  g.rotation.y = spec.heading;

  const length = spec.length ?? 180;
  const width = spec.width ?? 28;
  const bed = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.35, length),
    mat(0x3f464b),
  );
  bed.position.y = -0.34;
  g.add(bed);

  const wallMat = mat(0x8c9295);
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 2.0, length),
      wallMat,
    );
    wall.position.set(side * (width / 2 + 0.25), 0.35, 0);
    g.add(wall);
  }

  const trackCount = spec.trackCount ?? RAILWAY_DEFS.CONVENTIONAL_UNDERPASS.trackCountDefault;
  const spacing = RAILWAY_DEFS.CONVENTIONAL_UNDERPASS.trackSpacingM;
  const first = -((trackCount - 1) * spacing) / 2;
  for (let i = 0; i < trackCount; i++)
    addRailPair(g, first + i * spacing, -0.05, length - 8);

  scene.add(g);

  const railFrom = spec.fromS ?? spec.s - 30;
  const railTo = spec.toS ?? spec.s + 30;
  // 高架桁の範囲(bridgeFromS/bridgeToS があれば八条通の先まで延伸)
  const sFrom = spec.bridgeFromS ?? railFrom;
  const sTo = spec.bridgeToS ?? railTo;
  const aIn = spec.approachIn ?? RAILWAY_DEFS.CONVENTIONAL_UNDERPASS.approachDefaultM;
  const aOut = spec.approachOut ?? RAILWAY_DEFS.CONVENTIONAL_UNDERPASS.approachDefaultM;
  const deckHalf = spec.deckHalf ?? RAILWAY_DEFS.CONVENTIONAL_UNDERPASS.deckHalfDefaultM; // 車道の外縁(橋上に歩道は無い実際の大宮跨線橋に合わせる)
  // 大宮跨線橋では路面を覆う灰色デッキ・桁・擁壁を重ねない。
  // 橋上には、唯一の路面高さ elevationAt(s) を基準にした約1m高の欄干だけを生成する。
  addOmiyaParapets(scene, path, sFrom - aIn, sTo + aOut, deckHalf);

  // 大宮跨線橋に関する手製の道路板・側道板・高架下舗装は生成しない。
  // 可視路面はPLATEAU transportationの橋上車線部分を直接持ち上げる。
  // ここでは地上の鉄道設備と橋面端の欄干だけを担当する。
}

function buildShinkansenViaduct(scene, path, spec) {
  const p = at(path, spec.s);
  const g = new THREE.Group();
  g.position.set(p.x, terrainHeightAtWorld(p.x, p.z), p.z);
  g.rotation.y = spec.heading;

  const length = spec.length ?? 190;
  const width = spec.width ?? 16;
  const deckY = RAILWAY_DEFS.SHINKANSEN_VIADUCT.deckY;
  const girder = new THREE.Mesh(
    new THREE.BoxGeometry(width, 1.05, length),
    mat(0xd7d9d6),
  );
  girder.position.y = deckY;
  g.add(girder);
  addDeckRails(g, width, deckY + 0.85, length);

  // 橋脚(道路上には立てない — 高架は線路が道路と直交して跨ぐ)
  const clearHalf = halfWidthAt(spec.s) + 4;
  for (const z of RAILWAY_DEFS.SHINKANSEN_VIADUCT.pierRowsM) {
    if (Math.abs(z) < clearHalf) continue;
    const wx = p.x + Math.sin(spec.heading) * z;
    const wz = p.z + Math.cos(spec.heading) * z;
    const localGround = terrainHeightAtWorld(wx, wz) - g.position.y;
    const pierTop = deckY - 0.55;
    const pierHeight = Math.max(0.8, pierTop - localGround);
    const pier = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.55, pierHeight, 1.15),
      mat(0xb8b8b1),
    );
    pier.position.set(0, localGround + pierHeight / 2, z);
    g.add(pier);
  }

  for (const offset of [-2.7, 2.7])
    addRailPair(g, offset, deckY + 0.72, length - 10, 1.45);
  scene.add(g);
}

/** 名神高速道路の高架(片道3車線・中央分離帯)。経路と斜めに交差する一般的な立体交差。 */
function buildExpresswayViaduct(scene, path, spec) {
  const p = at(path, spec.s);
  const g = new THREE.Group();
  g.position.set(p.x, terrainHeightAtWorld(p.x, p.z), p.z);
  g.rotation.y = spec.heading;

  const length = spec.length ?? 210;
  const width = spec.width ?? 27;
  const deckY = RAILWAY_DEFS.EXPRESSWAY_VIADUCT.deckY;
  const girder = new THREE.Mesh(
    new THREE.BoxGeometry(width, 1.2, length),
    mat(0xaeb2ae),
  );
  girder.position.y = deckY;
  g.add(girder);
  const deckTop = deckY + 0.62;
  const surf = new THREE.Mesh(
    new THREE.BoxGeometry(width - 1.2, 0.14, length),
    mat(0x4a4f55),
  );
  surf.position.y = deckTop;
  g.add(surf);

  const lanesEachWay = spec.lanesEachWay ?? 3;
  const laneW = (width - 4) / (lanesEachWay * 2);
  for (let side of [-1, 1]) {
    for (let i = 1; i < lanesEachWay; i++) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, 0.02, length - 6),
        mat(0xe8e8e8),
      );
      line.position.set(
        side * (laneW * i + (side < 0 ? 1 : 0.5)),
        deckTop + 0.08,
        0,
      );
      g.add(line);
    }
  }
  const median = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.5, length),
    mat(0x8a9080),
  );
  median.position.y = deckTop + 0.25;
  g.add(median);
  for (const side of [-1, 1]) {
    const parapet = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 1.05, length),
      mat(0xc4c8c4),
    );
    parapet.position.set(side * (width / 2 - 0.2), deckTop + 0.5, 0);
    g.add(parapet);
  }

  const isKoeda = spec.name?.includes(RAILWAY_DEFS.EXPRESSWAY_VIADUCT.nameMatchKoeda);
  const isHishizuma = spec.name?.includes(RAILWAY_DEFS.EXPRESSWAY_VIADUCT.nameMatchHishizuma);

  const addFenceLine = (z, span, height = 2.2) => {
    const fenceMat = mat(0xb9bfbd, { transparent: true, opacity: 0.78 });
    const postMat = mat(0x737a78);
    const postStep = 5;
    for (let x = -span / 2; x <= span / 2 + 0.1; x += postStep) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, height, 0.12),
        postMat,
      );
      post.position.set(x, height / 2, z);
      g.add(post);
    }
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(span, height - 0.2, 0.06),
      fenceMat,
    );
    panel.position.set(0, height / 2, z);
    g.add(panel);
    for (const y of [0.75, height - 0.35]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(span, 0.08, 0.08),
        postMat,
      );
      rail.position.set(0, y, z);
      g.add(rail);
    }
  };

  // 菱妻神社側は高架下の道路両側をフェンスで覆う。道路中央は空ける。
  if (isHishizuma) {
    const routeClear = halfWidthAt(spec.s) + 1.2;
    const fenceZ = routeClear + 1.0;
    addFenceLine(-fenceZ, width - 2.0, 2.4);
    addFenceLine(fenceZ, width - 2.0, 2.4);
  }

  // 小枝橋側は鴨川側に高架下の塀を置く。道路と河川の視界を塞ぎすぎない高さにする。
  if (isKoeda) {
    const riverSide = spec.riverSide ?? -1;
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 1.8, length - 12),
      mat(0x9da39f),
    );
    wall.position.set(riverSide * (width / 2 - 0.7), 0.9, 0);
    g.add(wall);
  }

  // 橋脚は横長の板ではなく、道路・水面を避けた細い柱として配置する。
  const clearHalf = halfWidthAt(spec.s) + 5;
  const riverZones = (route.bridges ?? []).map((br) => {
    const b = at(path, br.s);
    return { x: b.x, z: b.z, r: Math.max(18, br.length * 0.85) / 2 + 24 };
  });
  const pierRows = spec.pierRows ?? (isKoeda ? RAILWAY_DEFS.EXPRESSWAY_VIADUCT.pierRowsKoedaM : RAILWAY_DEFS.EXPRESSWAY_VIADUCT.pierRowsDefaultM);
  const pierX = Math.min(
    width / 2 - 1.5,
    Math.max(clearHalf + 1, width * 0.38),
  );
  const pierXs = spec.pierXs ?? [-pierX, pierX];
  for (const z of pierRows) {
    for (const x of pierXs) {
      if (Math.abs(x) < clearHalf) continue;
      const wx = p.x + Math.cos(spec.heading) * x + Math.sin(spec.heading) * z;
      const wz = p.z - Math.sin(spec.heading) * x + Math.cos(spec.heading) * z;
      if (
        riverZones.some(
          (rz) => (wx - rz.x) ** 2 + (wz - rz.z) ** 2 < rz.r * rz.r,
        )
      )
        continue;
      const localGround = terrainHeightAtWorld(wx, wz) - g.position.y;
      const pierTop = deckY - 0.6;
      const pierHeight = Math.max(0.8, pierTop - localGround);
      const pier = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, pierHeight, 1.8),
        mat(0x9c9f9c),
      );
      pier.position.set(x, localGround + pierHeight / 2, z);
      g.add(pier);
    }
  }
  scene.add(g);
}

/** Render an OSM motorway way as a continuous carriageway strip.
 * Mainline geometry is kept segment-by-segment so OSM bridge/layer tags remain
 * authoritative; motorway_link ramps are filtered during route-data build.
 */
function buildOsmExpressway(scene, spec) {
  const points = spec.points ?? [];
  if (points.length < 2) return;
  const halfWidth = Math.max(4, Number(spec.width) || 15) / 2;
  const elevated = spec.bridge === true || Number(spec.layer) > 0;
  const vertices = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const y = terrainHeightAtWorld(points[i][0], points[i][1]) + (elevated ? 7.0 : 0.16);
    vertices.push(
      [points[i][0] + nx * halfWidth, y, points[i][1] + nz * halfWidth],
      [points[i][0] - nx * halfWidth, y, points[i][1] - nz * halfWidth],
    );
  }
  const positions = [];
  const indices = [];
  for (const vertex of vertices) positions.push(...vertex);
  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    mat(elevated ? 0x454a50 : 0x55595c, { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }),
  );
  mesh.name = `osm-meishin:${spec.id}`;
  scene.add(mesh);

  if (elevated) {
    const mid = points[Math.floor(points.length / 2)];
    const support = new THREE.Mesh(
      new THREE.BoxGeometry(Math.min(2.5, halfWidth), 6.3, 1.2),
      mat(0x969b9b),
    );
    support.position.set(mid[0], terrainHeightAtWorld(mid[0], mid[1]) + 3.2, mid[1]);
    support.name = `osm-meishin-pier:${spec.id}`;
    scene.add(support);
  }
}

export function buildRailways(scene, path, structures = [], osmExpressways = []) {
  for (const spec of structures) {
    if (spec.kind === "conventional-underpass")
      buildConventionalUnderpass(scene, path, spec);
    else if (spec.kind === "shinkansen-viaduct")
      buildShinkansenViaduct(scene, path, spec);
    else if (spec.kind === "expressway-viaduct" && !osmExpressways.length)
      buildExpresswayViaduct(scene, path, spec);
  }
  for (const spec of osmExpressways) buildOsmExpressway(scene, spec);
  return { count: structures.length + osmExpressways.length };
}
