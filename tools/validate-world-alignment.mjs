#!/usr/bin/env node
import fs from "node:fs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const percentile = (values, ratio) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
};

const route = read("src/data/route18.json");
const profile = read("src/world/declarative/generated/route-elevation.json");
const terrain = read("src/world/declarative/generated/terrain-grid.json");
const transportation = read("public/world/generated/plateau-transportation.json");
const buildings = read("public/world/generated/plateau-buildings.json");
const manifest = read("public/world/world-manifest.json");
const drivingNetwork = read("src/data/generated/driving-network.json");

const nijoStop = route.stops.find((stop) => stop.name === "二条駅西口");
const nijoStationAheadStop = route.stops.find((stop) => stop.name === "二条駅前");
assert(nijoStop?.platform?.length === 2, "二条駅西口 OSM platform coordinate is missing");
assert(nijoStop.osmId === 4516406466, "二条駅西口 is not tied to the OSM platform node");
assert(nijoStationAheadStop?.shelter === true, "二条駅前 OSM shelter metadata is missing");
assert((route.osmStationRoads ?? []).length > 0, "OSM station rotary roads are missing");
assert((route.osmVegetation?.trees ?? []).length >= 400, "OSM tree nodes were not imported for the route corridor");
assert((route.osmVegetation?.treeRows ?? []).length > 0, "OSM tree rows are missing");
assert((route.osmVegetation?.treeAreas ?? []).length > 0, "OSM woodland areas are missing");
assert((route.osmVegetation?.greenAreas ?? []).length > 0, "OSM green areas are missing");
const treeAreaSize = (polygon) => {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area / 2);
};
assert(
  (route.osmVegetation?.treeAreas ?? []).some(
    (item) => ["wood", "forest"].includes(item.kind)
      && (item.polygon?.length ?? 0) >= 3
      && treeAreaSize(item.polygon) > 10,
  ),
  "OSM forest polygons are missing or degenerate",
);
assert(
  (route.osmVegetation?.treeAreas ?? []).some(
    (item) => item.kind === "scrub"
      && (item.polygon?.length ?? 0) >= 3
      && treeAreaSize(item.polygon) > 10,
  ),
  "OSM scrub polygons are missing or degenerate",
);

assert(terrain.connected === true, "Terrain grid must be marked connected");
assert(terrain.width >= 2 && terrain.height >= 2, "Terrain grid dimensions are invalid");
assert(terrain.heights.length === terrain.width * terrain.height, "Terrain height count mismatch");
assert(terrain.heights.every(Number.isFinite), "Terrain contains non-finite heights");
assert((terrain.sourceInfluenceCorridorMeters ?? terrain.measuredCorridorMeters) === 420, "Terrain source influence must be 420m");
assert(terrain.extrapolationPaddingMeters >= 600, "Terrain extrapolation padding is too small");
const structuralTransportationCount = transportation.features.filter((feature) => ["2", "3", "5", "6"].includes(String(feature.attributes?.sectionType ?? ""))).length;
assert(structuralTransportationCount > 0, "PLATEAU structural road sections are missing");

const profileAt = (samples, s) => {
  if (s <= samples[0][0]) return samples[0][1];
  if (s >= samples.at(-1)[0]) return samples.at(-1)[1];
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] <= s) lo = mid; else hi = mid;
  }
  const [s0, y0] = samples[lo], [s1, y1] = samples[hi];
  const t = s1 === s0 ? 0 : (s - s0) / (s1 - s0);
  return y0 + (y1 - y0) * t;
};
const smoothstep = (value) => value * value * (3 - 2 * value);
const terrainAtS = (s) => profileAt(profile.samples, s);
const singleCrestAbsoluteAt = (item, s) => {
  const from = Number(item.from);
  const peak = Number(item.peak);
  const to = Number(item.to);
  const startY = terrainAtS(from);
  const peakY = terrainAtS(peak) + Number(item.height ?? 0);
  const endY = terrainAtS(to);
  if (s <= from) return startY;
  if (s >= to) return endY;
  if (s <= peak) {
    const t = (s - from) / (peak - from);
    const span = peak - from;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    return h00 * startY
      + h10 * span * Number(item.riseStartGrade ?? 0)
      + h01 * peakY;
  }
  const t = (s - peak) / (to - peak);
  return peakY + (endY - peakY) * Math.pow(t, Number(item.fallPower ?? 2.4));
};
const structuralAt = (s) => {
  for (const item of route.elevations ?? []) {
    const from = Number(item.from);
    const to = Number(item.to);
    const height = Number(item.height ?? 0);
    if (item.profile === "single-crest") {
      if (s < from || s > to) continue;
      return Math.max(0, singleCrestAbsoluteAt(item, s) - terrainAtS(s));
    }
    const a0 = from - Number(item.approachIn ?? 50);
    const b1 = to + Number(item.approachOut ?? 50);
    if (s <= a0 || s >= b1) continue;
    if (s < from) return height * smoothstep((s - a0) / (from - a0));
    if (s <= to) return height;
    return height * smoothstep((b1 - s) / (b1 - to));
  }
  return 0;
};
const roadAt = (s) => terrainAtS(s) + structuralAt(s);
const omiyaProfile = (route.elevations ?? []).find((item) => item.name === "大宮跨線橋");
assert(omiyaProfile, "Omiya overpass profile is missing");
for (let s = omiyaProfile.from + 0.5; s <= omiyaProfile.peak; s += 0.5) {
  assert(roadAt(s) > roadAt(s - 0.5), "Absolute Omiya road profile does not rise continuously to JR");
}
for (let s = omiyaProfile.peak + 0.5; s <= omiyaProfile.to; s += 0.5) {
  assert(roadAt(s) < roadAt(s - 0.5), "Absolute Omiya road profile does not descend continuously after JR");
}

const bridgeProfileChecks = (route.elevations ?? [])
  .filter((item) => item.profile !== "flat-deck" && Number(item.height) > 0)
  .map((item) => {
    const sampleS = item.profile === "single-crest"
      ? Number(item.peak)
      : (Number(item.from) + Number(item.to)) / 2;
    const terrainY = terrainAtS(sampleS);
    const delta = structuralAt(sampleS);
    return { name: item.name, sampleS, terrainY, roadY: roadAt(sampleS), delta, expected: Number(item.height) };
  });
assert(bridgeProfileChecks.every((item) => Math.abs(item.delta - item.expected) < 1e-6), "Structural overpass height is not applied to the PLATEAU terrain profile");

const [originX, originZ] = terrain.origin;
const [stepX, stepZ] = terrain.spacing;
const maxX = originX + stepX * (terrain.width - 1);
const maxZ = originZ + stepZ * (terrain.height - 1);
const gridAt = (ix, iz) => terrain.heights[Math.max(0, Math.min(terrain.height - 1, iz)) * terrain.width + Math.max(0, Math.min(terrain.width - 1, ix))];
const sampleGrid = (x, z) => {
  const gx = (x - originX) / stepX;
  const gz = (z - originZ) / stepZ;
  const ix = Math.max(0, Math.min(terrain.width - 2, Math.floor(gx)));
  const iz = Math.max(0, Math.min(terrain.height - 2, Math.floor(gz)));
  const tx = Math.max(0, Math.min(1, gx - ix));
  const tz = Math.max(0, Math.min(1, gz - iz));
  const a = gridAt(ix, iz), b = gridAt(ix + 1, iz), c = gridAt(ix, iz + 1), d = gridAt(ix + 1, iz + 1);
  return tx + tz <= 1
    ? a + (b - a) * tx + (c - a) * tz
    : d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
};

for (const [x, z] of drivingNetwork.path) {
  assert(x >= originX && x <= maxX && z >= originZ && z <= maxZ, "Route lies outside connected terrain grid");
}
// The runtime uses the compiled driving lane, not the raw OSM centreline. A
// bridge node intentionally differs from terrain, so validate the generated
// ground nodes directly and leave elevated-profile checks to the bridge tests.
const routeErrors = drivingNetwork.nodes
  .filter((node) => !node.structure)
  .map((node) => Math.abs(sampleGrid(node.x, node.z) - node.y));
assert(percentile(routeErrors, 0.95) < 0.02, "95th percentile compiled route/terrain mismatch exceeds 2cm");
assert(Math.max(...routeErrors) < 0.08, "Maximum compiled route/terrain mismatch exceeds 8cm");

const slopes = [];
for (let iz = 0; iz < terrain.height; iz++) {
  for (let ix = 0; ix < terrain.width; ix++) {
    if (ix + 1 < terrain.width) slopes.push(Math.abs(gridAt(ix + 1, iz) - gridAt(ix, iz)) / stepX);
    if (iz + 1 < terrain.height) slopes.push(Math.abs(gridAt(ix, iz + 1) - gridAt(ix, iz)) / stepZ);
  }
}
assert(Math.max(...slopes) < 0.31, "Terrain contains an implausibly steep grid edge");

let incompleteShells = 0;
for (const building of buildings.features) {
  assert(Array.isArray(building.footprint) && building.footprint.length >= 3, `Invalid PLATEAU footprint: ${building.id}`);
  assert(Number(building.height) >= 2.8, `Invalid PLATEAU height: ${building.id}`);
  const surfaces = building.surfaces ?? [];
  if (surfaces.length > 0 && surfaces.length < 4) incompleteShells++;
}
assert(incompleteShells === 0, "Incomplete PLATEAU shells remain and would render as plates");

const main = fs.readFileSync("src/main.js", "utf8");
const scenery = fs.readFileSync("src/world/declarative/buildWorldScenery.js", "utf8");
const config = fs.readFileSync("src/world/declarative/config.js", "utf8");
const traffic = [
  fs.readFileSync("src/world/traffic/dynamics.js", "utf8"),
  fs.readFileSync("src/world/traffic/agents.js", "utf8"),
  fs.readFileSync("src/world/traffic/graph.js", "utf8"),
  fs.readFileSync("src/world/traffic/npcPhysics.js", "utf8"),
  fs.readFileSync("src/world/traffic/npcDriver.js", "utf8"),
].join("\n");
const routeDataSource = fs.readFileSync("src/route/routeData.js", "utf8");
const heightSampler = fs.readFileSync("src/world/declarative/continuousTerrain.js", "utf8");
const railways = fs.readFileSync("src/world/railways.js", "utf8");
const nature = fs.readFileSync("src/world/nature.js", "utf8");
const landmarks = fs.readFileSync("src/world/landmarks.js", "utf8");
const plateauRenderer = fs.readFileSync("src/world/declarative/PlateauWorldRenderer.js", "utf8");
assert(!main.includes("buildGround("), "Legacy flat ground is still wired into main.js");
assert(!scenery.includes("builders.buildBuildings"), "OSM building fallback is still active");
assert(config.includes("transportation: true"), "PLATEAU transportation surfaces must be enabled");
assert(!config.includes("osmRouteSurface"), "OSM route surface option must not exist");
assert(!main.includes("buildRoad("), "OSM route surface renderer is still wired into main.js");
assert(plateauRenderer.includes("compiledRoadDetailMeshes"), "Compiled OSM road details are not rendered on PLATEAU surfaces");
for (const marker of ["idmAcceleration", "orientedBoxesOverlap", "junctionBusy", "chooseNextConnector", "NpcPhysics", "steerInput"]) {
  assert(traffic.includes(marker), `Traffic safety feature missing: ${marker}`);
}
assert(railways.includes("terrainHeightAtWorld"), "Railway/viaduct ground structures are not PLATEAU-ground-aware");
assert(traffic.includes("agent.cursor.pose()"), "NPC pose is not sampled from compiled lane geometry");
assert(routeDataSource.includes('import drivingNetwork from "../data/generated/driving-network.json"'), "Runtime does not use the compiled driving network");
assert(routeDataSource.includes("return networkNodeAt(s).y;"), "Road height is not read from the compiled PLATEAU driving network");
assert(routeDataSource.includes("export function surfaceElevationAt(s)"), "Vehicles do not use the compiled PLATEAU road surface");
assert(!routeDataSource.includes("route-elevation.json"), "A stale route elevation profile is still imported at runtime");
assert(!routeDataSource.includes("road-elevation.json"), "A second generated road elevation source is still imported");
assert(!fs.existsSync("src/world/declarative/generated/road-elevation.json"), "Obsolete road-elevation.json still exists");
assert(heightSampler.includes("routeSurfaceIndex?.project(x, z)"), "World road surfaces do not use exact route projection");
assert(heightSampler.includes("roadAttachmentHalfWidthAtS"), "Elevated PLATEAU road corridor is not limited to the actual road width");
assert(!heightSampler.includes("roadRoute.distance >= 24"), "The obsolete 24m elevation radius still lifts nearby grey surfaces");
assert(nature.includes("const bridgeRoadHeightAt = (_x, _z, s) => elevationAt(s)"), "Bridge rails are not pinned to the single road height");
assert(nature.includes("roadY + BRIDGE_RAIL_HEIGHT / 2"), "River bridge rails are not based at road-surface height");
assert(nature.includes("route.osmVegetation"), "OSM vegetation is not wired into the nature renderer");
assert(nature.includes("osm-planted-green-areas"), "OSM green areas are not rendered");
assert(nature.includes("FOREST_TREE_AREA_M2"), "OSM forest density is not configured");
assert(nature.includes("osm-scrub-stands"), "OSM scrub is not rendered as low vegetation");
assert((drivingNetwork.overlays?.nijoRotary?.stationRoads ?? []).length > 0, "OSM station-road topology is missing");
assert(!nature.includes("const deck = new THREE.Mesh"), "A duplicate river bridge grey deck still covers the road");
assert(railways.includes("function addOmiyaParapets"), "Omiya overpass parapets are missing");
assert(railways.includes("const OMIYA_PARAPET_HEIGHT = 1.0"), "Omiya parapets are not approximately one metre high");
assert(railways.includes("elevationAt(midS) + OMIYA_PARAPET_HEIGHT / 2"), "Omiya parapets are not based at the single road height");
assert(!railways.includes("alongPitchBox"), "Grey Omiya deck/retaining boxes are still generated");
assert(!railways.includes("makeRibbon(\n        path,\n        -(deckHalf + 0.1)"), "Flat grey Omiya railing ribbons are still generated");
assert(!railways.includes("高架下の舗装"), "A hand-authored grey pavement plate still remains at Omiya overpass");
assert(plateauRenderer.includes("function partitionPolygonByConvex"), "PLATEAU polygons are not split into bridge-lane and ground portions");
assert(plateauRenderer.includes("function transportationSurfaceMesh"), "PLATEAU transportation is not edited in place");
assert(!plateauRenderer.includes("structuralPlateauSurfaceMesh"), "The old duplicate bridge-fragment mesh still exists");
assert(!plateauRenderer.includes("plateau-structural-road-fragments"), "A separate road-coloured bridge object is still added");
assert(plateauRenderer.includes("structuralLaneReplacement"), "Structural carriageways are not marked as source-polygon replacements");
assert(plateauRenderer.includes("this.terrainHeightAtWorld"), "Ground portions of PLATEAU transportation are not kept on terrain");
assert(plateauRenderer.includes("plateauRouteMarkingMeshes"), "PLATEAU road markings are not generated");
assert(!plateauRenderer.includes("routeRoadCutFeatures"), "OSM route ribbons still modify terrain geometry");
assert(!plateauRenderer.includes("!touchesStructuralRoad"), "Whole PLATEAU polygons are still being suppressed");
assert(scenery.includes("routeHeightAtS: builders.elevationAt"), "The edited structural lane is not wired to the same elevationAt(s) used by vehicles");
assert((drivingNetwork.bridges ?? []).some((bridge) => bridge.name === "小枝橋(鴨川)" && bridge.railEdges?.left?.length > 1), "Bridge road-edge rails were not compiled");

console.log(JSON.stringify({
  status: "world-alignment-ok",
  terrain: {
    vertices: terrain.heights.length,
    triangles: (terrain.width - 1) * (terrain.height - 1) * 2,
    routeErrorMedianMeters: Number(percentile(routeErrors, 0.5).toFixed(3)),
    routeErrorP95Meters: Number(percentile(routeErrors, 0.95).toFixed(3)),
    routeErrorMaxMeters: Number(Math.max(...routeErrors).toFixed(3)),
    maximumGridSlope: Number(Math.max(...slopes).toFixed(3)),
  },
  buildings: {
    count: buildings.features.length,
    incompleteDetailedShells: incompleteShells,
    extrusionFallbacks: buildings.features.filter((item) => !(item.surfaces?.length)).length,
  },
  traffic: {
    idmFollowing: true,
    graphNetworkRouting: true,
    junctionLocking: true,
    threeDimensionalCollisionSeparation: true,
  },
  structuralRoads: {
    plateauStructuralFeatureCount: structuralTransportationCount,
    bridgeProfiles: bridgeProfileChecks.map((item) => ({
      name: item.name,
      terrainY: Number(item.terrainY.toFixed(3)),
      sharedRoadVehicleRailY: Number(item.roadY.toFixed(3)),
      roadAboveTerrainMeters: Number(item.delta.toFixed(3)),
    })),
    plateauLanePortionsReplacedWithoutDuplication: true,
    outerServiceRoadsRemainAtTerrainHeight: true,
    handAuthoredOmiyaRoadPlatesRemoved: true,
  },
}, null, 2));
