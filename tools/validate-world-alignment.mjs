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
const roadProfile = read("src/world/declarative/generated/road-elevation.json");
const terrain = read("src/world/declarative/generated/terrain-grid.json");
const transportation = read("public/world/generated/plateau-transportation.json");
const buildings = read("public/world/generated/plateau-buildings.json");
const manifest = read("public/world/world-manifest.json");

assert(terrain.connected === true, "Terrain grid must be marked connected");
assert(terrain.width >= 2 && terrain.height >= 2, "Terrain grid dimensions are invalid");
assert(terrain.heights.length === terrain.width * terrain.height, "Terrain height count mismatch");
assert(terrain.heights.every(Number.isFinite), "Terrain contains non-finite heights");
assert((terrain.sourceInfluenceCorridorMeters ?? terrain.measuredCorridorMeters) === 420, "Terrain source influence must be 420m");
assert(terrain.extrapolationPaddingMeters >= 600, "Terrain extrapolation padding is too small");
assert(Array.isArray(roadProfile.samples) && roadProfile.samples.length === profile.samples.length, "Road elevation profile is missing or misaligned");
assert(String(roadProfile.source ?? "").includes("PLATEAU transportation"), "Road elevation profile is not PLATEAU-derived");
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
const bridgeProfileChecks = (route.elevations ?? []).filter((item) => Number(item.height) > 0).map((item) => {
  const center = (Number(item.from) + Number(item.to)) / 2;
  const delta = profileAt(roadProfile.samples, center) - profileAt(profile.samples, center);
  return { name: item.name, delta, expected: Number(item.height) };
});
assert(bridgeProfileChecks.every((item) => item.delta > Math.max(0.5, item.expected * 0.25)), "Structural bridge elevation is not reflected in the road profile");

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
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
};

const points = route.path;
const cumulative = [0];
for (let i = 1; i < points.length; i++) {
  cumulative.push(cumulative.at(-1) + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
}
const pointAt = (s) => {
  let lo = 0, hi = cumulative.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= s) lo = mid; else hi = mid;
  }
  const span = cumulative[lo + 1] - cumulative[lo] || 1;
  const t = Math.max(0, Math.min(1, (s - cumulative[lo]) / span));
  return [
    points[lo][0] + (points[lo + 1][0] - points[lo][0]) * t,
    points[lo][1] + (points[lo + 1][1] - points[lo][1]) * t,
  ];
};

for (const [x, z] of points) {
  assert(x >= originX && x <= maxX && z >= originZ && z <= maxZ, "Route lies outside connected terrain grid");
}
const routeErrors = profile.samples.map(([s, y]) => {
  const [x, z] = pointAt(s);
  return Math.abs(sampleGrid(x, z) - y);
});
assert(percentile(routeErrors, 0.95) < 0.55, "95th percentile route/terrain mismatch exceeds 0.55m");
assert(Math.max(...routeErrors) < 1.6, "Maximum route/terrain mismatch exceeds 1.6m");

const slopes = [];
for (let iz = 0; iz < terrain.height; iz++) {
  for (let ix = 0; ix < terrain.width; ix++) {
    if (ix + 1 < terrain.width) slopes.push(Math.abs(gridAt(ix + 1, iz) - gridAt(ix, iz)) / stepX);
    if (iz + 1 < terrain.height) slopes.push(Math.abs(gridAt(ix, iz + 1) - gridAt(ix, iz)) / stepZ);
  }
}
assert(Math.max(...slopes) < 0.28, "Terrain contains an implausibly steep grid edge");

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
const traffic = fs.readFileSync("src/world/traffic.js", "utf8");
const railways = fs.readFileSync("src/world/railways.js", "utf8");
assert(!main.includes("buildGround("), "Legacy flat ground is still wired into main.js");
assert(!scenery.includes("builders.buildBuildings"), "OSM building fallback is still active");
assert(config.includes("fallbackToLegacy: false"), "Legacy visual fallback must be disabled");
assert(config.includes("transportation: true"), "PLATEAU transportation surfaces must be enabled");
assert(config.includes("osmRouteSurface: false"), "OSM route surface rendering must be disabled");
assert(config.includes("osmExtraRoadSurfaces: false"), "OSM feeder road surface rendering must be disabled");
for (const marker of ["idmAcceleration", "canMergeIntoLane", "reserveIntersection", "assignExitPlan", "orientedBoxesOverlap"]) {
  assert(traffic.includes(marker), `Traffic safety feature missing: ${marker}`);
}
assert(railways.includes("terrainHeightAtWorld"), "Railway/viaduct supports are not PLATEAU-ground-aware");
assert(manifest.policies?.fallbackToLegacy === false, "Manifest still advertises legacy fallback");

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
    safeMerging: true,
    intersectionReservations: true,
    dynamicNetworkExits: true,
    threeDimensionalCollisionSeparation: true,
  },
  structuralRoads: {
    plateauStructuralFeatureCount: structuralTransportationCount,
    bridgeProfiles: bridgeProfileChecks.map((item) => ({
      name: item.name,
      roadAboveTerrainMeters: Number(item.delta.toFixed(3)),
    })),
  },
}, null, 2));
