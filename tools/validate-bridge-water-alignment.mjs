#!/usr/bin/env node
import fs from "node:fs";
import * as THREE from "three";
import { RoutePath } from "../src/route/path.js";
import {
  structuralRoadZones,
  terrainGridMesh,
  transportationSurfaceMesh,
} from "../src/world/declarative/PlateauWorldRenderer.js";
import {
  buildRiverDips,
  clippedRiverPoints,
  distToPolyline,
  riverDipDepthAt,
} from "../src/world/riverGeometry.js";
import { archedDeckElevation, RIVER_BRIDGE_ARCH_HEIGHT } from "../src/route/structureProfiles.js";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const route = read("src/data/route18.json");
const routeProfile = read("src/world/declarative/generated/route-elevation.json");
const terrainGrid = read("src/world/declarative/generated/terrain-grid.json");
const transportation = read("public/world/generated/plateau-transportation.json");
const drivingNetworkPatches = read("data/definitions/driving-network-patches.json");
const path = new RoutePath(route.path);

function profileValue(profile, s, fallback = 0) {
  const samples = profile?.samples ?? [];
  if (!samples.length) return fallback;
  if (s <= samples[0][0]) return samples[0][1];
  if (s >= samples.at(-1)[0]) return samples.at(-1)[1];
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] <= s) lo = mid;
    else hi = mid;
  }
  const [s0, y0] = samples[lo];
  const [s1, y1] = samples[hi];
  const t = s1 === s0 ? 0 : (s - s0) / (s1 - s0);
  return y0 + (y1 - y0) * t;
}

const terrainAtS = (s) => profileValue(routeProfile, s, 0);
const smoothstep = (value) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

const verticalProfiles = (route.elevations ?? []).map((item) => {
  if (item.profile === "flat-deck") {
    const a1 = Number(item.from);
    const b0 = Number(item.to);
    // 天神橋は両端の地形差を傾斜デッキ(アーチ高0)で吸収する
    const archHeight = item.name === drivingNetworkPatches.TENJIN_FLAT_DECK_STRUCTURE_NAME
      ? Number(drivingNetworkPatches.TENJIN_ARCH_HEIGHT ?? 0)
      : RIVER_BRIDGE_ARCH_HEIGHT;
    return {
      kind: "arched-deck",
      item,
      a1,
      b0,
      archHeight,
    };
  }
  if (item.profile === "single-crest") {
    return {
      kind: "single-crest",
      item,
      startY: terrainAtS(item.from),
      peakY: terrainAtS(item.peak) + Number(item.height ?? 0),
      endY: terrainAtS(item.to),
    };
  }
  return {
    kind: "deck",
    item,
    a0: Number(item.from) - Number(item.approachIn ?? 50),
    a1: Number(item.from),
    b0: Number(item.to),
    b1: Number(item.to) + Number(item.approachOut ?? 50),
  };
});

function singleCrestRoadY(profile, s) {
  const item = profile.item;
  if (s <= item.from) return profile.startY;
  if (s >= item.to) return profile.endY;
  if (s <= item.peak) {
    const span = item.peak - item.from;
    const t = (s - item.from) / span;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    return h00 * profile.startY
      + h10 * span * Number(item.riseStartGrade ?? 0)
      + h01 * profile.peakY;
  }
  const t = (s - item.peak) / (item.to - item.peak);
  return profile.peakY
    + (profile.endY - profile.peakY) * Math.pow(t, Number(item.fallPower ?? 2.4));
}

function structuralAt(s) {
  for (const profile of verticalProfiles) {
    if (profile.kind === "flat-deck") {
      if (s < profile.a1 || s > profile.b0) continue;
      return Math.max(0, profile.deckY - terrainAtS(s));
    }
    if (profile.kind === "arched-deck") {
      if (s < profile.a1 || s > profile.b0) continue;
      const roadY = archedDeckElevation(terrainAtS, profile.a1, profile.b0, s, profile.archHeight);
      return Math.max(0, roadY - terrainAtS(s));
    }
    if (profile.kind === "single-crest") {
      const item = profile.item;
      if (s < item.from || s > item.to) continue;
      return Math.max(0, singleCrestRoadY(profile, s) - terrainAtS(s));
    }
    if (s <= profile.a0 || s >= profile.b1) continue;
    const h = Number(profile.item.height ?? 0);
    if (s < profile.a1) return h * smoothstep((s - profile.a0) / (profile.a1 - profile.a0));
    if (s <= profile.b0) return h;
    return h * smoothstep((profile.b1 - s) / (profile.b1 - profile.b0));
  }
  return 0;
}
const roadAt = (s) => terrainAtS(s) + structuralAt(s);

const archReports = [];
const flatReports = [];
for (const profile of verticalProfiles.filter((item) => ["arched-deck", "flat-deck"].includes(item.kind))) {
  if (profile.kind === "flat-deck") {
    flatReports.push({
      name: profile.item.name,
      from: profile.a1,
      to: profile.b0,
      deckY: +profile.deckY.toFixed(3),
      deckVariationMeters: 0,
    });
    continue;
  }
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let s = profile.a1; s <= profile.b0 + 1e-9; s += 0.25) {
    const y = archedDeckElevation(terrainAtS, profile.a1, profile.b0, Math.min(s, profile.b0), profile.archHeight);
    minimum = Math.min(minimum, y);
    maximum = Math.max(maximum, y);
  }
  const startY = archedDeckElevation(terrainAtS, profile.a1, profile.b0, profile.a1, profile.archHeight);
  const endY = archedDeckElevation(terrainAtS, profile.a1, profile.b0, profile.b0, profile.archHeight);
  const centerY = archedDeckElevation(terrainAtS, profile.a1, profile.b0, (profile.a1 + profile.b0) / 2, profile.archHeight);
  assert(Math.abs(startY - terrainAtS(profile.a1)) < 1e-8, `${profile.item.name}: bridge start does not meet PLATEAU ground`);
  assert(Math.abs(endY - terrainAtS(profile.b0)) < 1e-8, `${profile.item.name}: bridge end does not meet PLATEAU ground`);
  // 設定アーチ高にキャップを適用した盛り上がりと一致すること(傾斜デッキの天神橋は0)
  const expectedCrest = Math.min(Number(profile.archHeight), Math.max(0.2, (profile.b0 - profile.a1) * 0.015));
  assert(centerY > ((startY + endY) / 2) + expectedCrest - 0.02, `${profile.item.name}: bridge arch is missing`);
  archReports.push({
    name: profile.item.name,
    from: profile.a1,
    to: profile.b0,
    startY: +startY.toFixed(3),
    endY: +endY.toFixed(3),
    centerY: +centerY.toFixed(3),
    archHeight: +(centerY - ((startY + endY) / 2)).toFixed(3),
    deckVariationMeters: +(maximum - minimum).toFixed(3),
  });
}
assert(archReports.length === 4 && flatReports.length === 0, "Expected four arched river bridges");

const [gridOriginX, gridOriginZ] = terrainGrid.origin;
const [gridStepX, gridStepZ] = terrainGrid.spacing;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const gridValue = (ix, iz) => Number(terrainGrid.heights[
  clamp(iz, 0, terrainGrid.height - 1) * terrainGrid.width
  + clamp(ix, 0, terrainGrid.width - 1)
] ?? 0);
function terrainAtWorld(x, z) {
  const gx = clamp((x - gridOriginX) / gridStepX, 0, terrainGrid.width - 1);
  const gz = clamp((z - gridOriginZ) / gridStepZ, 0, terrainGrid.height - 1);
  const ix = Math.min(terrainGrid.width - 2, Math.max(0, Math.floor(gx)));
  const iz = Math.min(terrainGrid.height - 2, Math.max(0, Math.floor(gz)));
  const tx = gx - ix;
  const tz = gz - iz;
  const a = gridValue(ix, iz);
  const b = gridValue(ix + 1, iz);
  const c = gridValue(ix, iz + 1);
  const d = gridValue(ix + 1, iz + 1);
  return tx + tz <= 1
    ? a + (b - a) * tx + (c - a) * tz
    : d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
}

const routeData = {
  elevations: route.elevations,
  roadSections: route.roadSections,
};
const zones = structuralRoadZones(path, routeData);
assert(!zones.some((zone) => zone.reason === "surface-alignment"), "Ground-level route surface alignment must not be generated");
const roadMesh = transportationSurfaceMesh(
  transportation.features,
  new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  terrainAtWorld,
  path,
  routeData,
  roadAt,
  zones,
);
assert(roadMesh?.isMesh, "PLATEAU transportation mesh was not generated");

const dips = buildRiverDips(path, route.bridges, route.rivers);
const riverReports = [];
for (const bridge of route.bridges) {
  const points = clippedRiverPoints(path, bridge, route.rivers);
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  const minimumExpected = bridge.name.includes("久我橋")
    ? 1500
    : bridge.name.includes("天神橋") ? 350 : 400;
  assert(length > minimumExpected, `${bridge.name}: river line is truncated (${length.toFixed(1)}m)`);
  const midpoint = points[Math.floor(points.length / 2)];
  const dip = riverDipDepthAt(midpoint[0], midpoint[1], dips);
  assert(dip > 3.3, `${bridge.name}: terrain is not carved under the river centerline`);
  riverReports.push({ name: bridge.name, points: points.length, lineLengthMeters: +length.toFixed(1), centerDipMeters: +dip.toFixed(2) });
}
const kamoLines = route.bridges
  .filter((bridge) => bridge.river === "鴨川")
  .map((bridge) => clippedRiverPoints(path, bridge, route.rivers));
assert(kamoLines.length === 2, "Expected two Kamo River bridge lines");
let kamoGap = Infinity;
for (const point of kamoLines[0]) {
  kamoGap = Math.min(kamoGap, distToPolyline(point[0], point[1], kamoLines[1]));
}
assert(kamoGap < 20, `Kamo River ribbons do not overlap (${kamoGap.toFixed(1)}m gap)`);

const carvedTerrain = terrainGridMesh(
  terrainGrid,
  [],
  path,
  route.bridges,
  route.rivers,
);
assert(carvedTerrain?.isMesh, "Carved PLATEAU terrain mesh was not generated");
carvedTerrain.updateMatrixWorld(true);
const terrainRay = new THREE.Raycaster();
const terrainCarveSamples = [];
for (const bridge of route.bridges) {
  const points = clippedRiverPoints(path, bridge, route.rivers);
  const point = points[Math.floor(points.length / 2)];
  terrainRay.set(new THREE.Vector3(point[0], 100, point[1]), new THREE.Vector3(0, -1, 0));
  const hits = terrainRay.intersectObject(carvedTerrain, false);
  assert(hits.length, `${bridge.name}: carved PLATEAU terrain could not be sampled`);
  const uncarved = terrainAtWorld(point[0], point[1]) - 0.035;
  const cut = uncarved - hits[0].point.y;
  assert(cut > 1.5, `${bridge.name}: PLATEAU terrain still covers the river (${cut.toFixed(2)}m cut)`);
  terrainCarveSamples.push({ name: bridge.name, terrainCutMeters: +cut.toFixed(2) });
}

const mainSource = fs.readFileSync("src/main.js", "utf8");
assert(mainSource.includes("busModel.update(") && mainSource.includes("surfaceElevationAt(state.s, bus.x, bus.z)"), "Own bus is not based on the PLATEAU road surface");
const rendererSource = fs.readFileSync("src/world/declarative/PlateauWorldRenderer.js", "utf8");
assert(rendererSource.includes("riverDipDepthAt(x, z, riverDips)"), "PLATEAU terrain renderer does not apply the river cut");

console.log(JSON.stringify({
  status: "bridge-water-road-alignment-ok",
  archedBridges: archReports,
  flatBridges: flatReports,
  rivers: riverReports,
  kamoRibbonOverlapGapMeters: +kamoGap.toFixed(2),
  plateauTerrainCuts: terrainCarveSamples,
  koedaToJonangu: {
    heightSource: "PLATEAU terrain grid",
    groundLevelAlignmentZones: 0,
  },
}, null, 2));
