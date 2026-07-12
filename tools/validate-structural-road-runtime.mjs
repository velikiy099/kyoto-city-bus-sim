#!/usr/bin/env node
import fs from "node:fs";
import * as THREE from "three";
import { RoutePath } from "../src/route/path.js";
import {
  structuralRoadZones,
  transportationSurfaceMesh,
} from "../src/world/declarative/PlateauWorldRenderer.js";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const route = read("src/data/route18.json");
const routeTerrain = read("src/world/declarative/generated/route-elevation.json");
const path = new RoutePath(route.path);
const profileValue = (profile, s, fallback = 0) => {
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
};
const terrainAtS = (s) => profileValue(routeTerrain, s, 0);
const omiya = route.elevations.find((item) => item.name === "大宮跨線橋");
const omiyaKizuyabashi = route.intersections.find((item) => item.name === "木津屋橋通");
assert(omiya?.profile === "single-crest", "Omiya overpass is not a single-crest profile");
assert(omiyaKizuyabashi, "Omiya-Kizuyabashi intersection is missing");
assert(Math.abs(omiya.from - 3304.1) < 0.01, "North Omiya ramp does not start about 30m south of Omiya-Kizuyabashi");
assert(Math.abs(omiya.from - omiyaKizuyabashi.s - 30) < 0.01, "North Omiya ramp is not 30m south of Omiya-Kizuyabashi");
assert(Math.abs(omiya.peak - 3543.8) < 0.01, "Omiya crest is not at the JR conventional-line crossing");
assert(Math.abs(omiya.to - 3848.1) < 0.01, "Omiya south landing point changed unexpectedly");
assert(Math.abs(omiya.autoEntryFrom - 3274.1) < 0.01, "Automatic-driving merge does not begin at Omiya-Kizuyabashi");
assert(Math.abs(omiya.riseStartGrade - 0.035) < 1e-9, "North Omiya ramp start grade changed unexpectedly");
const sectionAt = (s) => route.roadSections.find((section) => s >= section.from && s < section.to);
const laneCenterForSection = (section) => section.lanesB
  ? -(((section.wL - 0.55) * (section.lanesF - 0.5)) / section.lanesF)
  : 0;
const beforeBridgeSection = sectionAt(omiya.from - 0.1);
const bridgeSection = sectionAt(omiya.from + 0.1);
assert(beforeBridgeSection?.lanesF === 3, "North approach no longer has the outer service-road lane");
assert(bridgeSection?.bridge === 1 && bridgeSection.lanesF === 2, "Bridge carriageway does not start at the service-road branch");
const entryFromLat = laneCenterForSection(beforeBridgeSection);
const bridgeLat = laneCenterForSection(bridgeSection);
assert(omiya.autoEntryFrom < omiya.from, "Automatic-driving bridge merge has no lead-in distance");
assert(bridgeLat > entryFromLat + 2, "Automatic-driving target does not move from the outer lane into the bridge carriageway");

const smoothstep = (t) => t * t * (3 - 2 * t);
const singleCrestAbsoluteAt = (item, s) => {
  const startY = terrainAtS(item.from);
  const peakY = terrainAtS(item.peak) + Number(item.height ?? 0);
  const endY = terrainAtS(item.to);
  if (s <= item.from) return startY;
  if (s >= item.to) return endY;
  if (s <= item.peak) {
    const t = (s - item.from) / (item.peak - item.from);
    const span = item.peak - item.from;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    return h00 * startY
      + h10 * span * Number(item.riseStartGrade ?? 0)
      + h01 * peakY;
  }
  const t = (s - item.peak) / (item.to - item.peak);
  return peakY + (endY - peakY) * Math.pow(t, Number(item.fallPower ?? 2.4));
};
const structuralAt = (s) => {
  for (const item of route.elevations ?? []) {
    const height = Number(item.height ?? 0);
    if (item.profile === "single-crest") {
      if (s < item.from || s > item.to) continue;
      return Math.max(0, singleCrestAbsoluteAt(item, s) - terrainAtS(s));
    }
    const start = item.from - (item.approachIn ?? 50);
    const end = item.to + (item.approachOut ?? 50);
    if (s <= start || s >= end) continue;
    if (s < item.from) return height * smoothstep((s - start) / (item.from - start));
    if (s <= item.to) return height;
    return height * smoothstep((end - s) / (end - item.to));
  }
  return 0;
};
const roadAt = (s) => terrainAtS(s) + structuralAt(s);

const laneCenterAt = (s) => {
  if (s >= omiya.autoEntryFrom && s < omiya.from) {
    const t = (s - omiya.autoEntryFrom) / (omiya.from - omiya.autoEntryFrom);
    const eased = smoothstep(t);
    return entryFromLat + (bridgeLat - entryFromLat) * eased;
  }
  return laneCenterForSection(sectionAt(s));
};
assert(Math.abs(laneCenterAt(omiya.from) - bridgeLat) < 1e-9, "Automatic-driving path does not enter the bridge lane at the bridge start");
assert(Math.abs(laneCenterAt(omiya.autoEntryFrom) - entryFromLat) < 1e-9, "Automatic-driving merge no longer starts from the outer approach lane");

const startRoadY = roadAt(omiya.from);
const peakRoadY = roadAt(omiya.peak);
const endRoadY = roadAt(omiya.to);
assert(Math.abs(startRoadY - terrainAtS(omiya.from)) < 1e-9, "Omiya road is raised before the north bridge start");
assert(Math.abs(peakRoadY - (terrainAtS(omiya.peak) + omiya.height)) < 1e-9, "Omiya road does not have the required clearance at the JR crossing");
assert(Math.abs(endRoadY - terrainAtS(omiya.to)) < 1e-9, "Omiya road does not land on PLATEAU ground at the south end");
assert(roadAt(omiya.from + 1) > terrainAtS(omiya.from + 1), "The north ramp does not begin rising immediately after the bridge start");
for (let s = omiya.from + 0.5; s <= omiya.peak; s += 0.5) {
  assert(roadAt(s) > roadAt(s - 0.5), `Absolute Omiya road height is not rising before JR at s=${s.toFixed(1)}`);
}
for (let s = omiya.peak + 0.5; s <= omiya.to; s += 0.5) {
  assert(roadAt(s) < roadAt(s - 0.5), `Absolute Omiya road height is not descending after JR at s=${s.toFixed(1)}`);
  assert(roadAt(s) >= terrainAtS(s) - 1e-7, `Omiya road falls below PLATEAU terrain at s=${s.toFixed(1)}`);
}
let sampledMaximum = { s: omiya.from, y: roadAt(omiya.from) };
for (let s = omiya.from; s <= omiya.to; s += 0.1) {
  const y = roadAt(s);
  if (y > sampledMaximum.y) sampledMaximum = { s, y };
}
assert(Math.abs(sampledMaximum.s - omiya.peak) < 0.11, `Absolute Omiya crest moved away from JR to s=${sampledMaximum.s.toFixed(1)}`);
assert(roadAt(3700) < peakRoadY - 0.5, "The PLATEAU terrain rise south of JR still appears higher than the railway crest");

// Synthetic PLATEAU polygon: 24m wide, 8m long around the JR crossing. The
// central 14.4m carriageway must be raised in the same mesh, while both outer
// service-road strips remain at ground level.
const s0 = omiya.peak - 4;
const s1 = omiya.peak + 4;
const [aX, aZ] = path.getPoint(s0);
const [bX, bZ] = path.getPoint(s1);
const [taX, taZ] = path.getTangent(s0);
const [tbX, tbZ] = path.getTangent(s1);
const aN = [-taZ, taX];
const bN = [-tbZ, tbX];
const half = 12;
const feature = {
  kind: "road",
  polygon: [
    [aX - aN[0] * half, 0, aZ - aN[1] * half],
    [bX - bN[0] * half, 0, bZ - bN[1] * half],
    [bX + bN[0] * half, 0, bZ + bN[1] * half],
    [aX + aN[0] * half, 0, aZ + aN[1] * half],
  ],
};
const routeData = { elevations: route.elevations, roadSections: route.roadSections };
const mesh = transportationSurfaceMesh(
  [feature],
  new THREE.MeshBasicMaterial(),
  () => 0,
  path,
  routeData,
  structuralAt,
  structuralRoadZones(path, routeData),
);
assert(mesh?.isMesh, "Edited PLATEAU transportation mesh was not generated");
assert(mesh.name !== "plateau-structural-road-fragments", "A separate elevated road object is still generated");
assert(mesh.userData.structuralLaneReplacement === true, "Mesh is not marked as an in-place structural-lane replacement");

const pos = mesh.geometry.attributes.position;
const ys = Array.from({ length: pos.count }, (_, index) => pos.getY(index));
assert(ys.some((y) => y < 0.1), "Outer service-road parts were incorrectly raised");
assert(ys.some((y) => y > 3.9), "Bridge carriageway part was not raised to the crest");

let projectedArea = 0;
const index = mesh.geometry.index;
for (let i = 0; i < index.count; i += 3) {
  const ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2);
  const ax = pos.getX(ia), az = pos.getZ(ia);
  const bx = pos.getX(ib), bz = pos.getZ(ib);
  const cx = pos.getX(ic), cz = pos.getZ(ic);
  projectedArea += Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
}
const originalArea = Math.abs(
  (feature.polygon[1][0] - feature.polygon[0][0]) * (feature.polygon[3][2] - feature.polygon[0][2])
  - (feature.polygon[1][2] - feature.polygon[0][2]) * (feature.polygon[3][0] - feature.polygon[0][0]),
);
assert(Math.abs(projectedArea - originalArea) < 0.25, `PLATEAU polygon area was duplicated or deleted (${projectedArea} vs ${originalArea})`);


// Check the generated PLATEAU data itself on the north approach, where the
// elevated central carriageway and the outer ground-level service road coexist.
const transportation = read("public/world/generated/plateau-transportation.json");
const terrainGrid = read("src/world/declarative/generated/terrain-grid.json");
const [gridOriginX, gridOriginZ] = terrainGrid.origin;
const [gridStepX, gridStepZ] = terrainGrid.spacing;
const gridValue = (ix, iz) => terrainGrid.heights[
  Math.max(0, Math.min(terrainGrid.height - 1, iz)) * terrainGrid.width
  + Math.max(0, Math.min(terrainGrid.width - 1, ix))
];
const terrainAtWorld = (x, z) => {
  const gx = (x - gridOriginX) / gridStepX;
  const gz = (z - gridOriginZ) / gridStepZ;
  const ix = Math.max(0, Math.min(terrainGrid.width - 2, Math.floor(gx)));
  const iz = Math.max(0, Math.min(terrainGrid.height - 2, Math.floor(gz)));
  const tx = Math.max(0, Math.min(1, gx - ix));
  const tz = Math.max(0, Math.min(1, gz - iz));
  const a = gridValue(ix, iz);
  const b = gridValue(ix + 1, iz);
  const c = gridValue(ix, iz + 1);
  const d = gridValue(ix + 1, iz + 1);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
};
const routeHeightAtS = (s) => roadAt(s);
const actualMesh = transportationSurfaceMesh(
  transportation.features,
  new THREE.MeshBasicMaterial(),
  terrainAtWorld,
  path,
  routeData,
  routeHeightAtS,
  structuralRoadZones(path, routeData),
);
assert(actualMesh?.isMesh, "Actual PLATEAU transportation replacement mesh was not generated");
const actualPos = actualMesh.geometry.attributes.position;
const actualIndex = actualMesh.geometry.index;
// Verify the real PLATEAU surface immediately after the northern split, not
// only near the railway. The central carriageway must already be rising while
// the outer service road remains on terrain.
const approachS = 3330;
const centralDeltas = [];
const centralRoadErrors = [];
const serviceRoadDeltas = [];
for (let i = 0; i < actualIndex.count; i += 3) {
  const ids = [actualIndex.getX(i), actualIndex.getX(i + 1), actualIndex.getX(i + 2)];
  const x = ids.reduce((sum, id) => sum + actualPos.getX(id), 0) / 3;
  const y = ids.reduce((sum, id) => sum + actualPos.getY(id), 0) / 3;
  const z = ids.reduce((sum, id) => sum + actualPos.getZ(id), 0) / 3;
  const projection = path.closestS([x, z], approachS, 45);
  if (Math.abs(projection.s - approachS) >= 3) continue;
  const delta = y - terrainAtWorld(x, z);
  if (Math.abs(projection.lateral) < 6.8) {
    centralDeltas.push(delta);
    centralRoadErrors.push(y - roadAt(projection.s));
  }
  if (Math.abs(projection.lateral) > 7.6 && Math.abs(projection.lateral) < 15) {
    serviceRoadDeltas.push(delta);
  }
}
assert(centralDeltas.length > 5, "No actual PLATEAU central-carriageway triangles found on Omiya north approach");
assert(serviceRoadDeltas.length > 0, "No actual PLATEAU service-road triangles found on Omiya north approach");
const centralAverage = centralDeltas.reduce((sum, value) => sum + value, 0) / centralDeltas.length;
const centralRoadErrorAverage = centralRoadErrors.reduce((sum, value) => sum + value, 0) / centralRoadErrors.length;
assert(Math.abs(centralRoadErrorAverage) < 0.08, `Actual central carriageway does not follow the absolute Omiya road alignment: avg error=${centralRoadErrorAverage}`);
assert(Math.max(...serviceRoadDeltas.map(Math.abs)) < 0.1, "Actual outer service-road triangles were raised above PLATEAU ground");

const renderer = fs.readFileSync("src/world/declarative/PlateauWorldRenderer.js", "utf8");
assert(!renderer.includes("structuralPlateauSurfaceMesh"), "Old duplicate elevated-fragment builder still exists");
assert(!renderer.includes("plateau-structural-road-fragments"), "Old duplicate elevated road object is still added");
assert(renderer.includes("partitionPolygonByConvex"), "PLATEAU source polygons are not partitioned for replacement");
assert(renderer.includes("transportationSurfaceMesh"), "Edited PLATEAU transportation mesh is not used");

const routeDataSource = fs.readFileSync("src/route/routeData.js", "utf8");
assert(routeDataSource.includes('profile.kind === "single-crest"'), "Runtime does not evaluate the Omiya single-crest profile");
assert(routeDataSource.includes("laneEntryTransitions"), "Automatic-driving bridge entry transition is missing");

console.log(JSON.stringify({
  status: "structural-road-runtime-ok",
  omiya: {
    startS: omiya.from,
    crestS: omiya.peak,
    endS: omiya.to,
    height: omiya.height,
    fallPower: omiya.fallPower,
    absoluteStartY: Number(startRoadY.toFixed(3)),
    absoluteCrestY: Number(peakRoadY.toFixed(3)),
    absoluteEndY: Number(endRoadY.toFixed(3)),
    sampledMaximumS: Number(sampledMaximum.s.toFixed(1)),
    autoEntryFrom: omiya.autoEntryFrom,
    autoEntryLaneOffset: Number(entryFromLat.toFixed(3)),
    bridgeLaneOffset: Number(bridgeLat.toFixed(3)),
  },
  replacementMesh: {
    vertices: pos.count,
    triangles: index.count / 3,
    projectedArea: Number(projectedArea.toFixed(3)),
    originalArea: Number(originalArea.toFixed(3)),
    hasGroundServiceRoadVertices: ys.some((y) => y < 0.1),
    hasElevatedCarriagewayVertices: ys.some((y) => y > 3.9),
  },
  actualOmiyaNorthApproach: {
    s: approachS,
    expectedStructuralHeight: Number(structuralAt(approachS).toFixed(3)),
    centralTriangleCount: centralDeltas.length,
    centralAverageHeightAboveTerrain: Number(centralAverage.toFixed(3)),
    centralAverageRoadAlignmentError: Number(centralRoadErrorAverage.toFixed(3)),
    serviceRoadTriangleCount: serviceRoadDeltas.length,
    serviceRoadMaximumHeightAboveTerrain: Number(Math.max(...serviceRoadDeltas.map(Math.abs)).toFixed(3)),
  },
}, null, 2));
