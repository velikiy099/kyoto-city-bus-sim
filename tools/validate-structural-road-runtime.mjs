#!/usr/bin/env node
import fs from "node:fs";
import * as THREE from "three";
import { RoutePath } from "../src/route/path.js";
import {
  structuralRoadZones,
  terrainGridMesh,
  transportationSurfaceMesh,
} from "../src/world/declarative/PlateauWorldRenderer.js";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const route = read("src/data/route18.json");
const runtimeRoute = {
  ...route,
  elevations: route.elevations.map((item) =>
    item.name.startsWith("小枝橋")
      ? {
          ...item,
          sourceFeatureIds: ["tran_74d5fa1f-0f3a-4b7b-bc3a-72225aa50258"],
          autoExitFrom: 8327,
          autoExitTo: 8342,
        }
      : item,
  ),
  roadSections: route.roadSections.flatMap((section) =>
    section.from === 8174 && section.to === 8319.6
      ? [
          { ...section, to: 8341.7, lanes: 4, lanesF: 2, lanesB: 2, center: "line", wL: 7.2, wR: 7.2 },
          { from: 8341.7, to: 8431.9, lanes: 2, lanesF: 1, lanesB: 1, center: "none", wL: 4, wR: 4 },
        ]
      : [section],
  ),
  terrainCutRefinements: [{ from: 7276.7, to: 8319.6, maxEdge: 1.5 }],
};
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
  // Same diagonal split as the rendered terrain mesh and runtime sampler.
  // Bilinear interpolation here would hide a vehicle/road height mismatch.
  return tx + tz <= 1
    ? a + (b - a) * tx + (c - a) * tz
    : d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
};
const correctedTerrain = terrainGridMesh(
  terrainGrid,
  transportation.features,
  path,
  runtimeRoute.bridges,
  runtimeRoute.rivers,
);
correctedTerrain.updateMatrixWorld(true);
const terrainRay = new THREE.Raycaster();
let terrainOnRoad = 0;
for (let s = 7276.7; s <= 8319.6; s += 2) {
  const [x, z] = path.getPoint(s);
  terrainRay.set(new THREE.Vector3(x, 300, z), new THREE.Vector3(0, -1, 0));
  terrainOnRoad += terrainRay.intersectObject(correctedTerrain, false).length;
}
assert(terrainOnRoad === 0, `Terrain remains over the Senbonjujo–Koeda road (${terrainOnRoad} hits)`);
const routeHeightAtS = (s) => roadAt(s);
const actualMesh = transportationSurfaceMesh(
  transportation.features,
  new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  terrainAtWorld,
  path,
  runtimeRoute,
  routeHeightAtS,
  structuralRoadZones(path, runtimeRoute),
);
assert(actualMesh?.isMesh, "Actual PLATEAU transportation replacement mesh was not generated");
actualMesh.updateMatrixWorld(true);
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

const koedaEastRoadRay = new THREE.Raycaster();
let koedaEastRoadGaps = 0;
for (let s = 8319.6; s <= 8431.9; s += 2) {
  const [x, z] = path.getPoint(s);
  koedaEastRoadRay.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
  if (!koedaEastRoadRay.intersectObject(actualMesh, false).length) koedaEastRoadGaps++;
}
assert(koedaEastRoadGaps === 0, `PLATEAU road is missing below the Koeda east-end route (${koedaEastRoadGaps} gaps)`);

// The bus does not travel on the path centre: in this section automatic
// driving uses the left-hand lane centre.  Check that location and both sides
// of a bus-width footprint, then measure the error introduced by using the
// path-centre elevation for a laterally displaced vehicle.
const runtimeSectionAt = (s) => runtimeRoute.roadSections.find((section) => s >= section.from && s < section.to);
const runtimeLaneCenterAt = (s) => {
  const from = 8327;
  const to = 8342;
  if (s <= from || s >= to) return laneCenterForSection(runtimeSectionAt(s));
  const fromLat = laneCenterForSection(runtimeSectionAt(from - 0.1));
  const toLat = laneCenterForSection(runtimeSectionAt(to + 0.1));
  const t = (s - from) / (to - from);
  const eased = t * t * (3 - 2 * t);
  return fromLat + (toLat - fromLat) * eased;
};
const koedaDriveRay = new THREE.Raycaster();
let koedaAutodriveRoadGaps = 0;
const koedaAutodriveGapSamples = [];
let maxPathCenterHeightError = 0;
let maxLateralHeightError = 0;
let maxLateralHeightSample = null;
// Stop before the 城南宮道 intersection box itself; there multiple PLATEAU
// traffic polygons overlap vertically and are tested by the intersection
// validator.  This check is specifically the east-end approach lane.
for (let s = 8319.6; s <= 8429; s += 1) {
  const [px, pz] = path.getPoint(s);
  const [tx, tz] = path.getTangent(s);
  const nx = -tz;
  const nz = tx;
  const lane = runtimeLaneCenterAt(s);
  for (const busHalfWidth of [-1.2, 0, 1.2]) {
    const x = px + nx * (lane + busHalfWidth);
    const z = pz + nz * (lane + busHalfWidth);
    koedaDriveRay.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
    const hit = koedaDriveRay.intersectObject(actualMesh, false)[0];
    if (!hit) {
      koedaAutodriveRoadGaps++;
      if (koedaAutodriveGapSamples.length < 12) {
        koedaAutodriveGapSamples.push({ s: Number(s.toFixed(1)), lateral: Number((lane + busHalfWidth).toFixed(2)) });
      }
      continue;
    }
    maxPathCenterHeightError = Math.max(
      maxPathCenterHeightError,
      Math.abs(hit.point.y - terrainAtWorld(px, pz)),
    );
    const lateralError = Math.abs(hit.point.y - terrainAtWorld(x, z));
    if (lateralError > maxLateralHeightError) {
      maxLateralHeightError = lateralError;
      maxLateralHeightSample = { s, lateral: lane + busHalfWidth, hitY: hit.point.y, terrainY: terrainAtWorld(x, z) };
    }
  }
}
const koedaRoadWidths = [8328, 8332, 8336, 8340, 8342].map((s) => {
  const [px, pz] = path.getPoint(s);
  const [tx, tz] = path.getTangent(s);
  const hitLaterals = [];
  for (let lateral = -9; lateral <= 9; lateral += 0.1) {
    const x = px - tz * lateral;
    const z = pz + tx * lateral;
    koedaDriveRay.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
    if (koedaDriveRay.intersectObject(actualMesh, false).length) hitLaterals.push(lateral);
  }
  return {
    s,
    left: Number(Math.min(...hitLaterals).toFixed(1)),
    right: Number(Math.max(...hitLaterals).toFixed(1)),
  };
});
assert(koedaAutodriveRoadGaps === 0, `PLATEAU road is missing under the automatic-driving footprint (${koedaAutodriveRoadGaps} gaps: ${JSON.stringify(koedaAutodriveGapSamples)})`);
// The rendered terrain is triangulated from a 30m DEM grid while the raycast
// samples a displaced lane vertex.  Keep this below a visually seamless 14cm;
// true deck/ground gaps are caught by the footprint and seam-patch checks.
assert(maxLateralHeightError < 0.14, `PLATEAU road no longer matches lateral terrain (${maxLateralHeightError}m at ${JSON.stringify(maxLateralHeightSample)})`);

const koeda = runtimeRoute.elevations.find((item) => item.name.startsWith("小枝橋"));
const koedaSection = runtimeRoute.roadSections.find((section) => 8248.5 >= section.from && 8248.5 < section.to);
assert(koeda?.sourceFeatureIds?.includes("tran_74d5fa1f-0f3a-4b7b-bc3a-72225aa50258"), "Koeda bridge does not identify its complete PLATEAU deck polygon");
assert(koedaSection?.lanesF === 2 && koedaSection?.lanesB === 0, "Koeda bridge is not the OSM southbound two-lane one-way section");
const koedaFeature = transportation.features.find((feature) => feature.source?.gmlId === koeda.sourceFeatureIds[0]);
assert(koedaFeature, "Koeda PLATEAU deck polygon is absent");
const koedaMesh = transportationSurfaceMesh(
  [koedaFeature],
  new THREE.MeshBasicMaterial(),
  terrainAtWorld,
  path,
  runtimeRoute,
  routeHeightAtS,
  structuralRoadZones(path, runtimeRoute),
);
const koedaPositions = koedaMesh.geometry.attributes.position;
for (let i = 0; i < koedaPositions.count; i++) {
  const x = koedaPositions.getX(i);
  const z = koedaPositions.getZ(i);
  const projection = path.closestS([x, z], koeda.s, 150);
  if (projection.s >= koeda.bridgeFromS && projection.s <= koeda.bridgeToS)
    assert(Math.abs(koedaPositions.getY(i) - roadAt(projection.s)) < 0.08, "Koeda PLATEAU deck polygon was not entirely elevated in place");
}
const nature = fs.readFileSync("src/world/nature.js", "utf8");
assert(nature.includes("br.railEdges?.left"), "Koeda bridge rails are not attached to compiled road edges");

const renderer = fs.readFileSync("src/world/declarative/PlateauWorldRenderer.js", "utf8");
assert(!renderer.includes("structuralPlateauSurfaceMesh"), "Old duplicate elevated-fragment builder still exists");
assert(!renderer.includes("plateau-structural-road-fragments"), "Old duplicate elevated road object is still added");
assert(renderer.includes("partitionPolygonByConvex"), "PLATEAU source polygons are not partitioned for replacement");
assert(renderer.includes("transportationSurfaceMesh"), "Edited PLATEAU transportation mesh is not used");

const routeDataSource = fs.readFileSync("src/route/routeData.js", "utf8");
assert(routeDataSource.includes("drivingNetwork"), "Runtime does not use the compiled bridge profile");

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
  terrainCorrection: {
    zone: "千本十条〜小枝橋",
    sampledPoints: Math.floor((8319.6 - 7276.7) / 2) + 1,
    terrainHitsOnRoad: terrainOnRoad,
  },
  koedaBridge: {
    plateauDeckSource: koeda.sourceFeatureIds[0],
    lanesForward: koedaSection.lanesF,
    lanesBackward: koedaSection.lanesB,
    deckVertices: koedaPositions.count,
    railHalfWidth: 7.2,
    eastEndRoadGaps: koedaEastRoadGaps,
    autodriveFootprintGaps: koedaAutodriveRoadGaps,
    maxPathCenterHeightError: Number(maxPathCenterHeightError.toFixed(3)),
    maxLateralHeightError: Number(maxLateralHeightError.toFixed(3)),
    eastEndRoadWidths: koedaRoadWidths,
  },
}, null, 2));
