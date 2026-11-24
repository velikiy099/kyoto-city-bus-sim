import * as THREE from "three";
import { terrainHeightAtWorld } from "./declarative/continuousTerrain.js";
import { makeCar, makeTruck } from "./traffic/vehicleModels.js";

const DEFAULT_RAILWAY_DEFS = {
  CONVENTIONAL_UNDERPASS: { trackCountDefault: 6, trackSpacingM: 3.2, approachDefaultM: 52, deckHalfDefaultM: 7.2 },
  SHINKANSEN_VIADUCT: { deckY: 8.2, pierRowsM: [-70, -35, 0, 35, 70] },
  EXPRESSWAY_VIADUCT: { deckY: 7.0, pierRowsDefaultM: [-75, 75], variantRules: [] },
};

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

const OVERPASS_PARAPET_HEIGHT = 1.0;
const OVERPASS_PARAPET_WIDTH = 0.3;
const OVERPASS_PARAPET_SEGMENT = 4;

/** 跨線橋の橋面端に、約1m高コンクリート欄干だけを置く。 */
function addOverpassParapets(scene, path, fromS, toS, deckHalf, elevationAt, gradeAt) {
  const material = mat(0xbfc4c7);
  for (const side of [-1, 1]) {
    for (let s = fromS; s < toS; s += OVERPASS_PARAPET_SEGMENT) {
      const nextS = Math.min(toS, s + OVERPASS_PARAPET_SEGMENT);
      const midS = (s + nextS) / 2;
      const [x, z] = path.getPoint(midS);
      const [tx, tz] = path.getTangent(midS);
      const nx = -tz;
      const nz = tx;
      const offset = side * (deckHalf + OVERPASS_PARAPET_WIDTH / 2);
      const parapet = new THREE.Mesh(
        new THREE.BoxGeometry(
          OVERPASS_PARAPET_WIDTH,
          OVERPASS_PARAPET_HEIGHT,
          Math.max(0.5, nextS - s + 0.08),
        ),
        material,
      );
      parapet.position.set(
        x + nx * offset,
        elevationAt(midS) + OVERPASS_PARAPET_HEIGHT / 2,
        z + nz * offset,
      );
      parapet.rotation.order = "YXZ";
      parapet.rotation.y = Math.atan2(tx, tz);
      parapet.rotation.x = -Math.atan(gradeAt(midS));
      parapet.name = "overpass-parapet";
      scene.add(parapet);
    }
  }
}

function buildConventionalUnderpass(scene, path, spec, ctx) {
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

  const defs = ctx.defs.CONVENTIONAL_UNDERPASS;
  const trackCount = spec.trackCount ?? defs.trackCountDefault;
  const spacing = defs.trackSpacingM;
  const first = -((trackCount - 1) * spacing) / 2;
  for (let i = 0; i < trackCount; i++)
    addRailPair(g, first + i * spacing, -0.05, length - 8);

  scene.add(g);

  const railFrom = spec.fromS ?? spec.s - 30;
  const railTo = spec.toS ?? spec.s + 30;
  const sFrom = spec.bridgeFromS ?? railFrom;
  const sTo = spec.bridgeToS ?? railTo;
  const aIn = spec.approachIn ?? defs.approachDefaultM;
  const aOut = spec.approachOut ?? defs.approachDefaultM;
  const deckHalf = spec.deckHalf ?? defs.deckHalfDefaultM;
  addOverpassParapets(scene, path, sFrom - aIn, sTo + aOut, deckHalf, ctx.elevationAt, ctx.gradeAt);
}

function buildShinkansenViaduct(scene, path, spec, ctx) {
  const p = at(path, spec.s);
  const g = new THREE.Group();
  g.position.set(p.x, terrainHeightAtWorld(p.x, p.z), p.z);
  g.rotation.y = spec.heading;

  const length = spec.length ?? 190;
  const width = spec.width ?? 16;
  const defs = ctx.defs.SHINKANSEN_VIADUCT;
  const deckY = defs.deckY;
  const girder = new THREE.Mesh(
    new THREE.BoxGeometry(width, 1.05, length),
    mat(0xd7d9d6),
  );
  girder.position.y = deckY;
  g.add(girder);
  addDeckRails(g, width, deckY + 0.85, length);

  // 橋脚(道路上には立てない — 高架は線路が道路と直交して跨ぐ)
  const clearHalf = ctx.halfWidthAt(spec.s) + 4;
  for (const z of defs.pierRowsM) {
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

/** 高速道路の高架(片道3車線・中央分離帯)。経路と斜めに交差する一般的な立体交差。 */
function buildExpresswayViaduct(scene, path, spec, ctx) {
  const p = at(path, spec.s);
  const g = new THREE.Group();
  g.position.set(p.x, terrainHeightAtWorld(p.x, p.z), p.z);
  g.rotation.y = spec.heading;

  const length = spec.length ?? 210;
  const width = spec.width ?? 27;
  const expDefs = ctx.defs.EXPRESSWAY_VIADUCT;
  const deckY = expDefs.deckY;
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

  const matchedRule = (expDefs.variantRules ?? []).find(
    (rule) => rule.nameIncludes && spec.name?.includes(rule.nameIncludes),
  );

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

  if (matchedRule?.roadsideFences) {
    const routeClear = ctx.halfWidthAt(spec.s) + 1.2;
    const fenceZ = routeClear + 1.0;
    addFenceLine(-fenceZ, width - 2.0, 2.4);
    addFenceLine(fenceZ, width - 2.0, 2.4);
  }

  if (matchedRule?.riverWall) {
    const riverSide = spec.riverSide ?? -1;
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 1.8, length - 12),
      mat(0x9da39f),
    );
    wall.position.set(riverSide * (width / 2 - 0.7), 0.9, 0);
    g.add(wall);
  }

  // 橋脚は横長の板ではなく、道路・水面を避けた細い柱として配置する。
  const clearHalf = ctx.halfWidthAt(spec.s) + 5;
  const riverZones = ctx.bridges.map((br) => {
    const b = at(path, br.s);
    return { x: b.x, z: b.z, r: Math.max(18, br.length * 0.85) / 2 + 24 };
  });
  const pierRows = spec.pierRows ?? matchedRule?.pierRowsM ?? expDefs.pierRowsDefaultM;
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

/** Render an OSM motorway way as a 3D box-girder viaduct with sound barriers,
 * cleared portal piers, and overhead traffic (matching Meishin Expressway).
 */
function resample2d(points, maxStep = 6) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(dist / maxStep));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function addRibbonMesh(scene, rows, material, name) {
  if (rows.length < 2) return null;
  const positions = [];
  const indices = [];
  for (const [l, r] of rows) positions.push(l[0], l[1], l[2], r[0], r[1], r[2]);
  for (let i = 0; i < rows.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  scene.add(mesh);
  return mesh;
}

function buildOsmExpressway(scene, spec, routePath, halfWidthAt) {
  const rawPts = spec.points ?? [];
  if (rawPts.length < 2) return null;
  const points = resample2d(rawPts, 6);
  const halfWidth = Math.max(4, Number(spec.width) || 15) / 2;
  const elevated = spec.bridge === true || Number(spec.layer) > 0;
  const soffitOffset = 7.0;
  const deckTopOffset = 8.3;

  const frames = points.map((pt, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next[0] - prev[0], dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    const tx = dx / len, tz = dz / len;
    const nx = -tz, nz = tx;
    const gy = terrainHeightAtWorld(pt[0], pt[1]);
    return { x: pt[0], z: pt[1], tx, tz, nx, nz, gy };
  });

  if (elevated) {
    // 3D box girder (deck top, concrete soffit, and left/right concrete fascia webs)
    const topRows = frames.map((f) => [
      [f.x + f.nx * (halfWidth - 0.35), f.gy + deckTopOffset + 0.02, f.z + f.nz * (halfWidth - 0.35)],
      [f.x - f.nx * (halfWidth - 0.35), f.gy + deckTopOffset + 0.02, f.z - f.nz * (halfWidth - 0.35)],
    ]);
    const botRows = frames.map((f) => [
      [f.x - f.nx * (halfWidth - 0.4), f.gy + soffitOffset, f.z - f.nz * (halfWidth - 0.4)],
      [f.x + f.nx * (halfWidth - 0.4), f.gy + soffitOffset, f.z + f.nz * (halfWidth - 0.4)],
    ]);
    addRibbonMesh(scene, topRows, mat(0x454a50, { side: THREE.DoubleSide }), `osm-expressway:${spec.id}:top`);
    addRibbonMesh(scene, botRows, mat(0xb5b9b6, { side: THREE.DoubleSide }), `osm-expressway:${spec.id}:soffit`);

    const concreteMat = mat(0xc2c6c2, { side: THREE.DoubleSide });
    const blueStripeMat = mat(0x3c6b9c, { side: THREE.DoubleSide });
    const creamPanelMat = mat(0xdcd9d0, { side: THREE.DoubleSide });
    const copingMat = mat(0x6d7275, { side: THREE.DoubleSide });

    for (const side of [-1, 1]) {
      const fasciaRows = frames.map((f) => [
        [f.x + f.nx * side * halfWidth, f.gy + deckTopOffset, f.z + f.nz * side * halfWidth],
        [f.x + f.nx * side * (halfWidth - 0.4), f.gy + soffitOffset, f.z + f.nz * side * (halfWidth - 0.4)],
      ]);
      addRibbonMesh(scene, fasciaRows, concreteMat, `osm-expressway:${spec.id}:fascia:${side}`);

      // Plinth + blue lower stripe + cream acoustic sound barrier + coping
      const wx = (f) => f.x + f.nx * side * (halfWidth - 0.15);
      const wz = (f) => f.z + f.nz * side * (halfWidth - 0.15);
      addRibbonMesh(
        scene,
        frames.map((f) => [[wx(f), f.gy + deckTopOffset, wz(f)], [wx(f), f.gy + deckTopOffset + 0.65, wz(f)]]),
        concreteMat,
        `osm-expressway:${spec.id}:plinth:${side}`,
      );
      addRibbonMesh(
        scene,
        frames.map((f) => [[wx(f), f.gy + deckTopOffset + 0.65, wz(f)], [wx(f), f.gy + deckTopOffset + 1.1, wz(f)]]),
        blueStripeMat,
        `osm-expressway:${spec.id}:stripe:${side}`,
      );
      addRibbonMesh(
        scene,
        frames.map((f) => [[wx(f), f.gy + deckTopOffset + 1.1, wz(f)], [wx(f), f.gy + deckTopOffset + 2.65, wz(f)]]),
        creamPanelMat,
        `osm-expressway:${spec.id}:barrier:${side}`,
      );
      addRibbonMesh(
        scene,
        frames.map((f) => [[wx(f), f.gy + deckTopOffset + 2.65, wz(f)], [wx(f), f.gy + deckTopOffset + 2.8, wz(f)]]),
        copingMat,
        `osm-expressway:${spec.id}:coping:${side}`,
      );
    }

    // Spaced portal piers that strictly avoid intersecting the route carriageway
    const pierMat = mat(0x9a9f9c);
    let distSincePier = 12;
    for (let i = 0; i < frames.length; i++) {
      if (i > 0) distSincePier += Math.hypot(frames[i].x - frames[i - 1].x, frames[i].z - frames[i - 1].z);
      if (distSincePier < 26 && i !== 0 && i !== frames.length - 1) continue;
      const f = frames[i];
      const latStep = Math.max(3.5, halfWidth - 1.6);
      let placed = false;
      for (const lat of [-latStep, latStep]) {
        const px = f.x + f.nx * lat;
        const pz = f.z + f.nz * lat;
        const pr = routePath?.closestS?.([px, pz]);
        const minClear = pr ? halfWidthAt(pr.s) + 3.2 : 10;
        if (pr && pr.dist < minClear) continue;
        const localGy = terrainHeightAtWorld(px, pz);
        const pierTop = f.gy + soffitOffset + 0.1;
        const pierH = Math.max(1.2, pierTop - localGy);
        const pier = new THREE.Mesh(new THREE.BoxGeometry(1.6, pierH, 2.2), pierMat);
        pier.position.set(px, localGy + pierH / 2, pz);
        pier.rotation.y = Math.atan2(f.tx, f.tz);
        pier.name = `osm-expressway-pier:${spec.id}`;
        scene.add(pier);
        placed = true;
      }
      if (placed) distSincePier = 0;
    }

    // Dashed highway lane markings on top
    const lineMat = mat(0xebeae4);
    for (const laneOff of [-2.4, 2.4]) {
      for (let i = 0; i < frames.length - 1; i += 2) {
        const a = frames[i], b = frames[i + 1];
        const segLen = Math.hypot(b.x - a.x, b.z - a.z);
        if (segLen < 1) continue;
        const dash = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, segLen * 0.65), lineMat);
        dash.position.set(
          ((a.x + b.x) / 2) + a.nx * laneOff,
          ((a.gy + b.gy) / 2) + deckTopOffset + 0.04,
          ((a.z + b.z) / 2) + a.nz * laneOff,
        );
        dash.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
        scene.add(dash);
      }
    }

    return frames.map((f) => [f.x, f.gy + deckTopOffset + 0.04, f.z, f.nx, f.nz]);
  }

  // Non-elevated approach embankment strip
  addRibbonMesh(
    scene,
    frames.map((f) => [
      [f.x + f.nx * halfWidth, f.gy + 0.16, f.z + f.nz * halfWidth],
      [f.x - f.nx * halfWidth, f.gy + 0.16, f.z - f.nz * halfWidth],
    ]),
    mat(0x55595c, { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }),
    `osm-expressway:${spec.id}`,
  );
  return null;
}

function createExpresswayTraffic(scene, trackPolylines) {
  const tracks = [];
  for (const pts of trackPolylines) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum.at(-1) + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
    }
    const total = cum.at(-1);
    if (total >= 35) tracks.push({ pts, cum, total });
  }
  if (!tracks.length) return () => {};

  const runners = [];
  const palette = [0xdedfe3, 0x3a4856, 0xc94238, 0xd8a832, 0x5c6873];
  for (let ti = 0; ti < tracks.length; ti++) {
    const tr = tracks[ti];
    const count = Math.max(1, Math.min(3, Math.floor(tr.total / 42)));
    for (let k = 0; k < count; k++) {
      const isTruck = (ti + k) % 3 === 0;
      const color = palette[(ti + k) % palette.length];
      const mesh = isTruck ? makeTruck(color) : makeCar(color);
      mesh.name = `expressway-npc:${ti}:${k}`;
      scene.add(mesh);
      runners.push({
        track: tr,
        mesh,
        s: (tr.total * (k + 0.25)) / count,
        speed: isTruck ? 19 + (k % 3) : 23 + (k % 4) * 1.2,
        laneOffset: k % 2 === 0 ? -3.4 : 3.4,
      });
    }
  }

  return (dt) => {
    for (const r of runners) {
      r.s = (r.s + r.speed * dt) % r.track.total;
      const { pts, cum } = r.track;
      let i = 0;
      while (i < cum.length - 2 && cum[i + 1] < r.s) i++;
      const span = cum[i + 1] - cum[i] || 1;
      const t = (r.s - cum[i]) / span;
      const a = pts[i], b = pts[i + 1];
      const nx = a[3] + (b[3] - a[3]) * t;
      const nz = a[4] + (b[4] - a[4]) * t;
      r.mesh.position.set(
        a[0] + (b[0] - a[0]) * t + nx * r.laneOffset,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t + nz * r.laneOffset,
      );
      r.mesh.rotation.y = Math.atan2(b[0] - a[0], b[2] - a[2]);
    }
  };
}

export function buildRailways(scene, path, structures = [], osmExpressways = [], options = {}) {
  const world = options?.world ?? {};
  const defs = {
    CONVENTIONAL_UNDERPASS: { ...DEFAULT_RAILWAY_DEFS.CONVENTIONAL_UNDERPASS, ...(options?.defs?.CONVENTIONAL_UNDERPASS ?? {}) },
    SHINKANSEN_VIADUCT: { ...DEFAULT_RAILWAY_DEFS.SHINKANSEN_VIADUCT, ...(options?.defs?.SHINKANSEN_VIADUCT ?? {}) },
    EXPRESSWAY_VIADUCT: { ...DEFAULT_RAILWAY_DEFS.EXPRESSWAY_VIADUCT, ...(options?.defs?.EXPRESSWAY_VIADUCT ?? {}) },
  };
  const ctx = {
    defs,
    elevationAt: world.elevationAt ?? (() => 0),
    gradeAt: world.gradeAt ?? (() => 0),
    halfWidthAt: world.halfWidthAt ?? (() => 4),
    bridges: world.bridges ?? [],
  };
  for (const spec of structures) {
    if (spec.kind === "conventional-underpass")
      buildConventionalUnderpass(scene, path, spec, ctx);
    else if (spec.kind === "shinkansen-viaduct")
      buildShinkansenViaduct(scene, path, spec, ctx);
    else if (spec.kind === "expressway-viaduct" && !osmExpressways.length)
      buildExpresswayViaduct(scene, path, spec, ctx);
  }
  const elevatedTracks = [];
  for (const spec of osmExpressways) {
    const track = buildOsmExpressway(scene, spec, path, ctx.halfWidthAt);
    if (track?.length >= 2) elevatedTracks.push(track);
  }
  const update = createExpresswayTraffic(scene, elevatedTracks);
  return { count: structures.length + osmExpressways.length, update };
}
