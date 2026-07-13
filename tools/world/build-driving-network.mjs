#!/usr/bin/env node
/**
 * Compile the OSM route semantics onto authoritative PLATEAU transportation
 * surfaces.  Nothing in the simulator is allowed to re-snap this route: a
 * missing or ambiguous surface is a map-build error.
 */
import fs from "node:fs";
import path from "node:path";
import { config, resolveRoot, valueAfter, writeJson } from "./lib.mjs";
import { archedDeckElevation, flatDeckElevation } from "../../src/route/structureProfiles.js";

const cfg = config();
const routeFile = path.resolve(valueAfter("--route") ?? resolveRoot(cfg.osm.routeFile));
const transportFile = path.resolve(valueAfter("--transportation") ?? resolveRoot(cfg.output.plateauTransportation));
const terrainFile = path.resolve(valueAfter("--terrain") ?? resolveRoot(cfg.output.plateauTerrain));
const outputFile = path.resolve(valueAfter("--output") ?? resolveRoot(cfg.output.drivingNetwork));
const osmSourceFile = path.resolve(valueAfter("--osm-source") ?? resolveRoot(cfg.output.osmVisualSource));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const route = read(routeFile);
const transport = read(transportFile);
const terrain = read(terrainFile).grid;
const osmSource = read(osmSourceFile);
const TRAFFIC_BRANCH_METERS = Number(cfg.osm.trafficBranchMeters ?? 250);

const CELL = 40;
const SNAP_LIMIT = 12;
const BUS_HALF_WIDTH = 1.28;
const key = (x, z) => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function area(points) {
  let value = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++)
    value += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return value / 2;
}

function contains(points, x, z) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i];
    const [xj, zj] = points[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function nearestOnSegment(x, z, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  const q = [a[0] + dx * t, a[1] + dz * t];
  return { point: q, distance: Math.hypot(x - q[0], z - q[1]), t };
}

function nearestBoundary(feature, x, z) {
  let best = { point: null, distance: Infinity };
  for (let i = 0, j = feature.points.length - 1; i < feature.points.length; j = i++) {
    const hit = nearestOnSegment(x, z, feature.points[j], feature.points[i]);
    if (hit.distance < best.distance) best = hit;
  }
  return best;
}

function inwardPoint(feature, boundary) {
  const dx = feature.center[0] - boundary[0];
  const dz = feature.center[1] - boundary[1];
  const length = Math.hypot(dx, dz) || 1;
  for (let d = 0.08; d <= 8; d += 0.08) {
    const point = [boundary[0] + (dx / length) * d, boundary[1] + (dz / length) * d];
    if (contains(feature.points, point[0], point[1])) return point;
  }
  // Concave carriageway polygons can have a vertex-average outside the local
  // strip (for example at a tapered slip-road end). Search a small radial fan
  // around the nearest boundary point before treating the surface as invalid.
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 12) {
    for (let d = 0.08; d <= 8; d += 0.08) {
      const point = [boundary[0] + Math.cos(angle) * d, boundary[1] + Math.sin(angle) * d];
      if (contains(feature.points, point[0], point[1])) return point;
    }
  }
  return null;
}

const features = (transport.features ?? [])
  .filter((f) => ["road", "lane", "intersection", "sidewalk"].includes(f.kind) && (f.polygon?.length ?? 0) >= 3)
  .map((f) => {
    const points = f.polygon.map(([x, , z]) => [x, z]);
    const xs = points.map((p) => p[0]);
    const zs = points.map((p) => p[1]);
    return {
      id: f.id,
      gmlId: f.source?.gmlId ?? f.id,
      kind: f.kind,
      points,
      center: [xs.reduce((a, b) => a + b, 0) / xs.length, zs.reduce((a, b) => a + b, 0) / zs.length],
      bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) },
      area: Math.abs(area(points)),
    };
  });
const cells = new Map();
for (const feature of features) {
  for (let x = Math.floor(feature.bounds.minX / CELL); x <= Math.floor(feature.bounds.maxX / CELL); x++) {
    for (let z = Math.floor(feature.bounds.minZ / CELL); z <= Math.floor(feature.bounds.maxZ / CELL); z++) {
      const k = `${x}:${z}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(feature);
    }
  }
}

function candidates(x, z) {
  const all = new Map();
  for (let radius = 0; radius <= 1; radius++) {
    for (let ix = Math.floor(x / CELL) - radius; ix <= Math.floor(x / CELL) + radius; ix++) {
      for (let iz = Math.floor(z / CELL) - radius; iz <= Math.floor(z / CELL) + radius; iz++) {
        for (const feature of cells.get(`${ix}:${iz}`) ?? []) all.set(feature.id, feature);
      }
    }
    if (all.size) break;
  }
  return [...all.values()];
}

function snapToSurface(x, z, previousId = null) {
  const nearby = candidates(x, z);
  const inside = nearby.filter((f) => f.kind !== "sidewalk" && contains(f.points, x, z));
  if (inside.length) {
    const selected = inside.find((f) => f.id === previousId)
      ?? inside.sort((a, b) => (a.kind === "intersection") - (b.kind === "intersection") || a.area - b.area)[0];
    return { point: [x, z], feature: selected };
  }
  const ranked = nearby.filter((feature) => feature.kind !== "sidewalk")
    .map((feature) => ({ feature, ...nearestBoundary(feature, x, z) }))
    .sort((a, b) => a.distance - b.distance || (a.feature.id === previousId ? -1 : 1));
  const best = ranked[0];
  if (!best || best.distance > SNAP_LIMIT) {
    throw new Error(`PLATEAU road coverage missing at ${x.toFixed(2)},${z.toFixed(2)} (nearest=${best?.distance?.toFixed(2) ?? "none"}m)`);
  }
  const point = inwardPoint(best.feature, best.point);
  if (!point) throw new Error(`PLATEAU road polygon cannot accept route point: ${best.feature.id} @ ${x.toFixed(3)},${z.toFixed(3)} nearest=${best.distance.toFixed(3)}`);
  return { point, feature: best.feature };
}

function gridHeight(x, z) {
  const [ox, oz] = terrain.origin;
  const [sx, sz] = terrain.spacing;
  const gx = clamp((x - ox) / sx, 0, terrain.width - 1);
  const gz = clamp((z - oz) / sz, 0, terrain.height - 1);
  const ix = Math.min(terrain.width - 2, Math.floor(gx));
  const iz = Math.min(terrain.height - 2, Math.floor(gz));
  const tx = gx - ix;
  const tz = gz - iz;
  const at = (a, b) => Number(terrain.heights[b * terrain.width + a] ?? 0);
  const a = at(ix, iz), b = at(ix + 1, iz), c = at(ix, iz + 1), d = at(ix + 1, iz + 1);
  return tx + tz <= 1 ? a + (b - a) * tx + (c - a) * tz : d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
}

function sectionAt(s) {
  return route.roadSections.find((section) => s >= section.from && s < section.to) ?? route.roadSections.at(-1);
}
// Generate the route road centre first. Physical lanes are derived together
// from one cross-section of that selected PLATEAU surface; no lane is snapped
// independently to whichever nearby polygon happens to contain it.
const rawRoute = route.path;
const firstPlatform = route.stops?.[0]?.platform;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const nearestPointIndex = (points, point) => points.reduce((best, candidate, index) => {
  const d = distance(candidate, point);
  return d < best.distance ? { index, distance: d } : best;
}, { index: 0, distance: Infinity });
function resample(points, spacing = 2) {
  const sampled = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = distance(a, b);
    const count = Math.max(1, Math.ceil(length / spacing));
    for (let step = 1; step <= count; step++) {
      const t = step / count;
      sampled.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return sampled;
}

// The route relation omits the one-way station loop.  Recover it from the two
// OSM oneway service ways connected to the first platform: the inbound branch
// ends at the berth, and the outbound branch leaves it and rejoins the route.
function nijoRotarySource() {
  if (!Array.isArray(firstPlatform)) return null;
  const oneWayRoads = (route.osmStationRoads ?? []).filter((road) => road.tags?.oneway === "yes" && road.points?.length >= 2);
  const inbound = oneWayRoads
    .map((road) => ({ road, distance: distance(road.points.at(-1), firstPlatform) }))
    .filter((item) => item.distance <= SNAP_LIMIT)
    .sort((a, b) => a.distance - b.distance)[0]?.road;
  const outbound = oneWayRoads
    .map((road) => ({ road, distance: distance(road.points[0], firstPlatform) }))
    .filter((item) => item.distance <= SNAP_LIMIT)
    .sort((a, b) => a.distance - b.distance)[0]?.road;
  if (!inbound || !outbound || inbound.id === outbound.id) return null;
  const rejoin = nearestPointIndex(rawRoute, outbound.points.at(-1));
  if (rejoin.distance > SNAP_LIMIT) {
    throw new Error(`Nijo rotary cannot rejoin route (${rejoin.distance.toFixed(1)}m from OSM exit)`);
  }
  const centerline = resample([...inbound.points, ...outbound.points.slice(1)]);
  const rejoinRawS = rejoin.index * 2;
  const prefix = centerline.map((point, index) => ({
    point,
    rawS: rejoinRawS * (index / Math.max(1, centerline.length - 1)),
    overlay: "nijo-rotary",
  }));
  const source = [
    ...prefix,
    ...rawRoute.slice(rejoin.index + 1).map((point, index) => ({ point, rawS: (rejoin.index + 1 + index) * 2 })),
  ];
  const tail = inbound.points.at(-2);
  const end = inbound.points.at(-1);
  const tx = end[0] - tail[0], tz = end[1] - tail[1];
  const length = Math.hypot(tx, tz) || 1;
  const nx = -tz / length, nz = tx / length;
  const platformLateral = (firstPlatform[0] - end[0]) * nx + (firstPlatform[1] - end[1]) * nz;
  const busLateral = platformLateral - Math.sign(platformLateral || -1) * (BUS_HALF_WIDTH + 0.9);
  return { source, inbound, outbound, rejoin, centerline, busLateral };
}

const nijoRotary = nijoRotarySource();
const raw = (nijoRotary?.source ?? rawRoute.map((point, index) => ({ point, rawS: index * 2 })));
const center = [];
let previousFeature = null;
for (let i = 0; i < raw.length; i++) {
  const sample = raw[i];
  if (sample.overlay === "nijo-rotary") {
    center.push({ rawS: sample.rawS, x: sample.point[0], z: sample.point[1], feature: { id: "osm-nijo-rotary" }, overlay: sample.overlay });
    continue;
  }
  const hit = snapToSurface(sample.point[0], sample.point[1], previousFeature?.id);
  previousFeature = hit.feature;
  center.push({ rawS: sample.rawS, x: hit.point[0], z: hit.point[1], feature: hit.feature });
}
// PLATEAU surfaces are split into many polygons.  Snapping every 2 m sample
// independently preserves tiny seams as violent kinks in the route.  Smooth
// only the PLATEAU correction vector relative to the original OSM axis; the
// OSM turns themselves therefore remain intact.
const rawCorrections = center.map((point, index) => ({
  x: point.x - raw[index].point[0],
  z: point.z - raw[index].point[1],
}));
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
for (let index = 0; index < center.length; index++) {
  if (center[index].overlay) continue;
  const nearby = [];
  for (let offset = -10; offset <= 10; offset++) {
    const sample = center[index + offset];
    if (sample && !sample.overlay) nearby.push(rawCorrections[index + offset]);
  }
  center[index].x = raw[index].point[0] + median(nearby.map((item) => item.x));
  center[index].z = raw[index].point[1] + median(nearby.map((item) => item.z));
}
const maxForwardLaneCount = Math.max(...(route.roadSections ?? []).map((section) => Number(section.lanesF) || 1));
const maxBackwardLaneCount = Math.max(...(route.roadSections ?? []).map((section) => Number(section.lanesB) || 0));
const CROSS_SECTION_STEP = 0.1;
const CROSS_SECTION_LIMIT = 24;
function corridorSurfaceExtent(point, nx, nz, side) {
  if (point.overlay) return 0;
  let extent = 0;
  for (let d = CROSS_SECTION_STEP; d <= CROSS_SECTION_LIMIT; d += CROSS_SECTION_STEP) {
    const x = point.x + nx * side * d, z = point.z + nz * side * d;
    const covered = candidates(x, z).some((feature) => feature.kind !== "sidewalk" && contains(feature.points, x, z));
    if (!covered) break;
    extent = d;
  }
  return extent;
}
function selectedSurfaceExtent(point, nx, nz, side) {
  if (point.overlay) return 0;
  let extent = 0;
  for (let d = CROSS_SECTION_STEP; d <= CROSS_SECTION_LIMIT; d += CROSS_SECTION_STEP) {
    if (!contains(point.feature.points, point.x + nx * side * d, point.z + nz * side * d)) break;
    extent = d;
  }
  return extent;
}
const physicalLaneRows = center.map((point, index) => {
  const previous = center[Math.max(0, index - 1)], next = center[Math.min(center.length - 1, index + 1)];
  const dx = next.x - previous.x, dz = next.z - previous.z;
  const length = Math.hypot(dx, dz) || 1;
  const nx = -dz / length, nz = dx / length;
  const section = sectionAt(point.rawS);
  const forwardCount = Math.max(1, Number(section?.lanesF) || 1);
  const backwardCount = Math.max(0, Number(section?.lanesB) || 0);
  const offsets = {
    forward: Array(maxForwardLaneCount).fill(0),
    reverse: Array(maxBackwardLaneCount).fill(0),
  };
  const active = {
    forward: Array(maxForwardLaneCount).fill(false),
    reverse: Array(maxBackwardLaneCount).fill(false),
  };
  if (point.overlay) {
    const outerSide = Math.sign(nijoRotary.busLateral || -1);
    for (let lane = 0; lane < forwardCount; lane++) {
      active.forward[lane] = true;
      offsets.forward[lane] = nijoRotary.busLateral - outerSide * 3.2 * lane;
    }
    const outer = nijoRotary.busLateral + outerSide * 1.6;
    const inner = nijoRotary.busLateral - outerSide * 4.8;
    return { rawS: point.rawS, nx, nz, min: Math.min(outer, inner), max: Math.max(outer, inner), centerShift: 0, offsets, active, overlay: true, forwardCount, backwardCount };
  }
  // A two-way road may be split into adjacent PLATEAU polygons, so its full
  // contiguous section is measured. A one-way OSM way is already a distinct
  // carriageway and must stay on its selected polygon rather than absorbing
  // the parallel opposite carriageway.
  // A grade-separated urban overpass must use only its selected deck polygon:
  // unioning nearby polygons mixes ground-level crossing roads into its width.
  // Flat river bridges have no at-grade crossing road and may legitimately be
  // split into adjacent PLATEAU deck polygons, so they retain the contiguous
  // two-way-road measurement used at ground level.
  const onGradeSeparatedDeck = (route.elevations ?? []).some((structure) =>
    Number(structure.height) > 0
    && structure.profile === "single-crest"
    && point.rawS >= Number(structure.from)
    && point.rawS <= Number(structure.to),
  );
  const extentAt = backwardCount > 0 && !onGradeSeparatedDeck
    ? corridorSurfaceExtent
    : selectedSurfaceExtent;
  const measuredNegative = extentAt(point, nx, nz, -1);
  const measuredPositive = extentAt(point, nx, nz, 1);
  const measuredMin = -Math.max(0.35, measuredNegative - 0.2);
  const measuredMax = Math.max(0.35, measuredPositive - 0.2);
  const nominalNegative = Number(section?.wL) || 4;
  const nominalPositive = Number(section?.wR) || 4;
  const scale = Math.min(1, (measuredMax - measuredMin) / Math.max(0.1, nominalNegative + nominalPositive));
  const negativeWidth = backwardCount > 0 ? nominalNegative * scale : Math.min(nominalNegative, -measuredMin);
  const positiveWidth = backwardCount > 0 ? nominalPositive * scale : Math.min(nominalPositive, measuredMax);
  const measuredCenter = (measuredMin + measuredMax) / 2;
  // Two-way OSM ways describe the road axis and are re-centred from the full
  // physical section. A one-way OSM way already describes one carriageway,
  // so its own axis stays fixed and cannot drift toward a crossing polygon.
  const centerShift = backwardCount > 0 ? measuredCenter + (negativeWidth - positiveWidth) / 2 : 0;
  for (let lane = 0; lane < forwardCount; lane++) active.forward[lane] = true;
  for (let lane = 0; lane < backwardCount; lane++) active.reverse[lane] = true;
  return {
    rawS: point.rawS, nx, nz, measuredMin, measuredMax,
    negativeWidth, positiveWidth, centerShift,
    min: centerShift - negativeWidth, max: centerShift + positiveWidth,
    offsets, active, overlay: false, forwardCount, backwardCount,
  };
});

// Re-centre the route on a longitudinally stable physical cross-section.  All
// width terms are filtered together; clamping the result back to each raw
// 2 m slice would reintroduce the very polygon-seam spikes being rejected.
const rawCentreShifts = physicalLaneRows.map((row) => row.centerShift);
const rawNegativeWidths = physicalLaneRows.map((row) => row.negativeWidth);
const rawPositiveWidths = physicalLaneRows.map((row) => row.positiveWidth);
for (let index = 0; index < physicalLaneRows.length; index++) {
  const row = physicalLaneRows[index];
  if (row.overlay) continue;
  const nearbyIndices = [];
  for (let offset = -12; offset <= 12; offset++) {
    const sample = physicalLaneRows[index + offset];
    if (sample && !sample.overlay
      && sample.forwardCount === row.forwardCount
      && sample.backwardCount === row.backwardCount) nearbyIndices.push(index + offset);
  }
  row.centerShift = median(nearbyIndices.map((sampleIndex) => rawCentreShifts[sampleIndex]));
  row.negativeWidth = Math.max(BUS_HALF_WIDTH + 0.25, median(nearbyIndices.map((sampleIndex) => rawNegativeWidths[sampleIndex])));
  row.positiveWidth = row.backwardCount > 0
    ? Math.max(BUS_HALF_WIDTH + 0.25, median(nearbyIndices.map((sampleIndex) => rawPositiveWidths[sampleIndex])))
    : Math.max(0.35, median(nearbyIndices.map((sampleIndex) => rawPositiveWidths[sampleIndex])));
  row.min = row.centerShift - row.negativeWidth;
  row.max = row.centerShift + row.positiveWidth;
  if (row.backwardCount > 0) {
    const forwardWidth = row.negativeWidth / row.forwardCount;
    const reverseWidth = row.positiveWidth / row.backwardCount;
    for (let lane = 0; lane < row.forwardCount; lane++) {
      row.offsets.forward[lane] = row.min + forwardWidth * (lane + 0.5);
    }
    for (let lane = 0; lane < row.backwardCount; lane++) {
      row.offsets.reverse[lane] = row.centerShift + reverseWidth * (lane + 0.5);
    }
  } else {
    const laneWidth = (row.negativeWidth + row.positiveWidth) / row.forwardCount;
    const centers = Array.from({ length: row.forwardCount }, (_, lane) => row.min + laneWidth * (lane + 0.5));
    const busIndex = centers.reduce((best, value, lane) => Math.abs(value - row.centerShift) < Math.abs(centers[best] - row.centerShift) ? lane : best, 0);
    const ordered = [centers[busIndex], ...centers.filter((_, lane) => lane !== busIndex).sort((a, b) => Math.abs(a - row.centerShift) - Math.abs(b - row.centerShift))];
    for (let lane = 0; lane < row.forwardCount; lane++) row.offsets.forward[lane] = ordered[lane];
  }
}

// Lane-count and carriageway-width changes must be merges, not lateral steps.
// Filter each lane's scalar offset along the route before converting it to XZ.
// This also carries the bus lane smoothly through 90-degree intersections
// where the inbound road edge becomes the outbound road centre.
const rawLaneOffsets = physicalLaneRows.map((row) => ({
  forward: [...row.offsets.forward],
  reverse: [...row.offsets.reverse],
}));
for (let index = 0; index < physicalLaneRows.length; index++) {
  const row = physicalLaneRows[index];
  if (row.overlay) continue;
  for (const key of ["forward", "reverse"]) {
    for (let laneIndex = 0; laneIndex < row.offsets[key].length; laneIndex++) {
      if (!row.active[key][laneIndex]) continue;
      let weighted = 0, weightSum = 0;
      for (let offset = -15; offset <= 15; offset++) {
        const sample = physicalLaneRows[index + offset];
        if (!sample || sample.overlay || !sample.active[key][laneIndex]) continue;
        const weight = 16 - Math.abs(offset);
        weighted += rawLaneOffsets[index + offset][key][laneIndex] * weight;
        weightSum += weight;
      }
      if (weightSum) row.offsets[key][laneIndex] = weighted / weightSum;
    }
  }
}

function smoothPointPairs(points, active = null, passes = 4) {
  let current = points.map(([x, z]) => [x, z]);
  for (let pass = 0; pass < passes; pass++) {
    const next = current.map((point) => [...point]);
    for (let index = 1; index < current.length - 1; index++) {
      if (active && (!active[index - 1] || !active[index] || !active[index + 1])) continue;
      if (physicalLaneRows[index]?.overlay !== physicalLaneRows[index - 1]?.overlay
        || physicalLaneRows[index]?.overlay !== physicalLaneRows[index + 1]?.overlay) continue;
      next[index][0] = current[index - 1][0] * 0.25 + current[index][0] * 0.5 + current[index + 1][0] * 0.25;
      next[index][1] = current[index - 1][1] * 0.25 + current[index][1] * 0.5 + current[index + 1][1] * 0.25;
    }
    current = next;
  }
  return current;
}

const roadCenter = center.map((point, index) => {
  const row = physicalLaneRows[index];
  return {
    x: point.x + row.nx * row.centerShift,
    z: point.z + row.nz * row.centerShift,
  };
});
const smoothedRoadCenter = smoothPointPairs(roadCenter.map((point) => [point.x, point.z]));
for (let index = 0; index < roadCenter.length; index++) {
  roadCenter[index].x = smoothedRoadCenter[index][0];
  roadCenter[index].z = smoothedRoadCenter[index][1];
}

const lane = center.map((point, index) => {
  const row = physicalLaneRows[index];
  const offset = row.offsets.forward[0];
  return {
    rawS: point.rawS,
    x: point.x + row.nx * offset,
    z: point.z + row.nz * offset,
    feature: point.feature,
    overlay: point.overlay,
  };
});
const smoothedBusLane = smoothPointPairs(lane.map((point) => [point.x, point.z]));
for (let index = 0; index < lane.length; index++) {
  lane[index].x = smoothedBusLane[index][0];
  lane[index].z = smoothedBusLane[index][1];
}

let s = 0;
const nodes = lane.map((point, i) => {
  if (i) s += Math.hypot(point.x - lane[i - 1].x, point.z - lane[i - 1].z);
  const prev = lane[Math.max(0, i - 1)], next = lane[Math.min(lane.length - 1, i + 1)];
  const heading = Math.atan2(next.x - prev.x, next.z - prev.z);
  return { s: +s.toFixed(3), rawS: point.rawS, x: +point.x.toFixed(3), z: +point.z.toFixed(3), y: +gridHeight(point.x, point.z).toFixed(3), heading: +heading.toFixed(6), surfaceId: point.feature.id };
});

const smoothstep = (t) => {
  const q = clamp(t, 0, 1);
  return q * q * (3 - 2 * q);
};
const baseTerrainY = nodes.map((node) => node.y);
function baseTerrainAtRaw(rawS) {
  let index = 0;
  while (index < nodes.length - 2 && nodes[index + 1].rawS < rawS) index++;
  const a = nodes[index], b = nodes[index + 1];
  const t = clamp((rawS - a.rawS) / Math.max(1e-6, b.rawS - a.rawS), 0, 1);
  return baseTerrainY[index] + (baseTerrainY[index + 1] - baseTerrainY[index]) * t;
}

const KOGA_BRIDGE_WAY_ID = 27829715;
const kogaBridgeRoad = (osmSource.roads ?? []).find((road) =>
  Number(road.id) === KOGA_BRIDGE_WAY_ID
  || (road.tags?.bridge === "yes" && road.tags?.name === "伏見向日線")
);

function rawSAtPoint(point) {
  let best = { distance2: Infinity, rawS: null };
  for (let index = 1; index < nodes.length; index++) {
    const a = nodes[index - 1], b = nodes[index];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length2 = dx * dx + dz * dz || 1;
    const t = clamp(((point[0] - a.x) * dx + (point[1] - a.z) * dz) / length2, 0, 1);
    const x = a.x + dx * t, z = a.z + dz * t;
    const distance2 = (point[0] - x) ** 2 + (point[1] - z) ** 2;
    if (distance2 < best.distance2) best = { distance2, rawS: a.rawS + (b.rawS - a.rawS) * t };
  }
  return best.rawS;
}

const kogaBridgeRawRange = kogaBridgeRoad?.points?.length >= 2
  ? [rawSAtPoint(kogaBridgeRoad.points[0]), rawSAtPoint(kogaBridgeRoad.points.at(-1))].sort((a, b) => a - b)
  : null;

function resolvedStructure(structure) {
  const range = structure.name === "久我橋(桂川)(flat deck)" && kogaBridgeRawRange
    ? kogaBridgeRawRange
    : [Number(structure.from), Number(structure.to)];
  const isKogaFlatDeck = structure.name === "久我橋(桂川)(flat deck)"
    && structure.profile === "flat-deck"
    && Boolean(kogaBridgeRawRange);
  return {
    ...structure,
    from: range[0],
    to: range[1],
    ...(isKogaFlatDeck ? { approachIn: 0, approachOut: 0 } : {}),
  };
}

const effectiveStructureApproaches = new Map();
for (const structure of route.elevations ?? []) {
  const resolved = resolvedStructure(structure);
  const from = Number(resolved.from), to = Number(resolved.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
  if (structure.profile === "flat-deck") {
    const isTenjinFlatDeck = resolved.name === "天神橋(西高瀬川)(flat deck)";
    // Keep the roadway on PLATEAU at both bridge ends. The elevation change
    // is absorbed inside the bridge by a shallow parabolic arch; no approach
    // terrain is modified before or after the bridge.
    const startIndex = Math.max(0, nodes.findIndex((node) => node.rawS >= from));
    const firstAfter = nodes.findIndex((node) => node.rawS > to);
    const endIndex = firstAfter < 0 ? nodes.length - 1 : firstAfter - 1;
    if (endIndex < startIndex) continue;
    effectiveStructureApproaches.set(structure.name, {
      approachIn: 0,
      approachOut: 0,
    });
    for (let nodeIndex = startIndex; nodeIndex <= endIndex; nodeIndex++) {
      const node = nodes[nodeIndex];
      const deckY = isTenjinFlatDeck
        ? flatDeckElevation(baseTerrainAtRaw, from, to)
        : archedDeckElevation(baseTerrainAtRaw, from, to, node.rawS);
      node.y = +deckY.toFixed(3);
      node.structure = structure.name;
    }
  } else if (structure.profile === "single-crest" && Number.isFinite(Number(structure.peak))) {
    const peak = Number(structure.peak), peakY = baseTerrainAtRaw(peak) + Number(structure.height ?? 4);
    for (const node of nodes) {
      if (node.rawS < from || node.rawS > to) continue;
      const t = node.rawS <= peak ? (node.rawS - from) / Math.max(1e-6, peak - from) : (node.rawS - peak) / Math.max(1e-6, to - peak);
      const edgeY = node.rawS <= peak ? baseTerrainAtRaw(from) : baseTerrainAtRaw(to);
      node.y = +(node.rawS <= peak
        ? baseTerrainAtRaw(from) + (peakY - baseTerrainAtRaw(from)) * smoothstep(t)
        : peakY + (edgeY - peakY) * smoothstep(t)).toFixed(3);
      node.structure = structure.name;
    }
  }
}

const footprintMissing = nodes.map((node) => {
  const tx = Math.sin(node.heading), tz = Math.cos(node.heading);
  const nx = -tz, nz = tx;
  return [-BUS_HALF_WIDTH, 0, BUS_HALF_WIDTH].some((lateral) => {
    const x = node.x + nx * lateral, z = node.z + nz * lateral;
    return !candidates(x, z).some((feature) => contains(feature.points, x, z));
  });
});

// Bounds are the same route-corridor cross-section that generated the lanes.
// Nearby cross streets therefore cannot expand the drivable envelope.
const driveBounds = nodes.map((node, index) => {
  const row = physicalLaneRows[index];
  const busOffset = row.offsets.forward[0];
  return {
    s: node.s,
    left: +Math.max(BUS_HALF_WIDTH, busOffset - row.min).toFixed(2),
    right: +Math.max(BUS_HALF_WIDTH, row.max - busOffset).toFixed(2),
  };
});
const surfacePatches = [];
for (let start = 0; start < footprintMissing.length;) {
  if (!footprintMissing[start]) { start++; continue; }
  let end = start;
  while (end + 1 < footprintMissing.length && footprintMissing[end + 1]) end++;
  const from = Math.max(0, start - 1), to = Math.min(nodes.length - 1, end + 1);
  surfacePatches.push({
    from: nodes[from].s,
    to: nodes[to].s,
    rows: nodes.slice(from, to + 1).map((node) => {
      const tx = Math.sin(node.heading), tz = Math.cos(node.heading);
      const nx = -tz, nz = tx;
      return [
        [+(node.x - nx * (BUS_HALF_WIDTH + 0.35)).toFixed(3), node.y, +(node.z - nz * (BUS_HALF_WIDTH + 0.35)).toFixed(3)],
        [+(node.x + nx * (BUS_HALF_WIDTH + 0.35)).toFixed(3), node.y, +(node.z + nz * (BUS_HALF_WIDTH + 0.35)).toFixed(3)],
      ];
    }),
  });
  start = end + 1;
}

// PLATEAU transportation polygons can meet with sub-metre gaps outside the
// bus footprint. Patch only a narrow strip at a selected-surface transition,
// using the measured road extents on both sides; this never fills a median or
// a separate carriageway because it does not extend beyond either edge.
for (let index = 1; index < nodes.length - 1; index++) {
  if (nodes[index - 1].surfaceId === nodes[index].surfaceId) continue;
  const rows = [];
  for (const rowIndex of [index - 1, index, index + 1]) {
    const node = nodes[rowIndex];
    const previous = nodes[Math.max(0, rowIndex - 1)], next = nodes[Math.min(nodes.length - 1, rowIndex + 1)];
    const dx = next.x - previous.x, dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length, nz = dx / length;
    const bounds = driveBounds[rowIndex];
    rows.push([
      [+(node.x - nx * bounds.left).toFixed(3), node.y, +(node.z - nz * bounds.left).toFixed(3)],
      [+(node.x + nx * bounds.right).toFixed(3), node.y, +(node.z + nz * bounds.right).toFixed(3)],
    ]);
  }
  surfacePatches.push({ from: nodes[index - 1].s, to: nodes[index + 1].s, rows, kind: "surface-seam" });
}

function compiledS(rawS) {
  const clamped = clamp(Number(rawS) || 0, nodes[0].rawS, nodes.at(-1).rawS);
  let index = 0;
  while (index < nodes.length - 2 && nodes[index + 1].rawS < clamped) index++;
  const a = nodes[index], b = nodes[index + 1];
  const t = clamp((clamped - a.rawS) / Math.max(1e-6, b.rawS - a.rawS), 0, 1);
  return +(a.s + (b.s - a.s) * t).toFixed(3);
}
function compiledRouteObject(item) {
  const result = { ...item };
  for (const field of ["s", "sIn", "sOut", "from", "to", "peak", "fromS", "toS", "bridgeFromS", "bridgeToS", "autoEntryFrom", "autoExitFrom", "autoExitTo"]) {
    if (Number.isFinite(Number(item[field]))) result[field] = compiledS(item[field]);
  }
  return result;
}
function compiledMainTrafficPaths() {
  const buildLane = (direction, lane) => {
    const active = physicalLaneRows.map((row) => row.active[direction > 0 ? "forward" : "reverse"][lane]);
    let points = nodes.map((node, index) => {
      const row = physicalLaneRows[index];
      const key = direction > 0 ? "forward" : "reverse";
      if (!row.active[key][lane]) return [node.x, node.z];
      if (direction > 0 && lane === 0) return [node.x, node.z];
      const point = center[index];
      const offset = row.offsets[key][lane];
      return [
        +(point.x + row.nx * offset).toFixed(3),
        +(point.z + row.nz * offset).toFixed(3),
      ];
    });
    // The bus and same-direction NPC lane zero are intentionally identical.
    // The bus path was already smoothed before node compilation.
    if (!(direction > 0 && lane === 0)) points = smoothPointPairs(points, active);
    const laterals = points.map(([x, z], index) => {
      const node = nodes[index];
      const heading = node.heading;
      return +((x - node.x) * -Math.cos(heading) + (z - node.z) * Math.sin(heading)).toFixed(3);
    });
    return {
      id: `main-${direction > 0 ? "forward" : "reverse"}-lane-${lane}`,
      role: "main",
      direction,
      lane,
      points,
      distances: nodes.map((node) => node.s),
      laterals,
      active,
    };
  };
  const paths = [
    ...Array.from({ length: maxForwardLaneCount }, (_, lane) => buildLane(1, lane)),
    ...Array.from({ length: maxBackwardLaneCount }, (_, lane) => buildLane(-1, lane)),
  ];
  // At a lane-count transition a newly created lane starts as a merge.  Keep
  // it inactive until its centre has physically separated from the continuing
  // lane, preventing two NPC streams from spawning on the same trajectory.
  for (const direction of [1, -1]) {
    const directional = paths.filter((path) => path.direction === direction).sort((a, b) => a.lane - b.lane);
    for (let index = 0; index < nodes.length; index++) {
      for (let laneIndex = 1; laneIndex < directional.length; laneIndex++) {
        const path = directional[laneIndex];
        if (!path.active[index]) continue;
        const overlapsEarlierLane = directional.slice(0, laneIndex).some((other) => other.active[index]
          && Math.hypot(
            path.points[index][0] - other.points[index][0],
            path.points[index][1] - other.points[index][1],
          ) < 1.9);
        if (overlapsEarlierLane) path.active[index] = false;
      }
    }
  }
  const forward = paths.filter((path) => path.direction > 0);
  const reverse = paths.filter((path) => path.direction < 0);
  for (let index = 0; index < nodes.length; index++) {
    for (const forwardPath of forward) for (const reversePath of reverse) {
      if (!forwardPath.active[index] || !reversePath.active[index]) continue;
      const separation = Math.hypot(
        forwardPath.points[index][0] - reversePath.points[index][0],
        forwardPath.points[index][1] - reversePath.points[index][1],
      );
      if (separation >= 1.9) continue;
      // Preserve the canonical inner lane in each direction.  Optional outer
      // lanes become active only after their split is physically complete.
      if (forwardPath.lane > reversePath.lane && forwardPath.lane > 0) forwardPath.active[index] = false;
      else if (reversePath.lane > 0) reversePath.active[index] = false;
    }
  }
  return paths;
}
function compiledTrafficPaths() {
  return [
    ...compiledMainTrafficPaths(),
    ...(route.extraRoads ?? [])
      .filter((road) => road.points?.length >= 2)
      .map((road) => ({
        id: `road-${road.id}`,
        role: road.direction === "northbound" ? "merge" : "local",
        direction: 1,
        name: road.name,
        points: road.points.map(([x, z]) => [+x.toFixed(3), +z.toFixed(3)]),
        mergeS: Number.isFinite(Number(road.mergeS)) ? compiledS(road.mergeS) : null,
        mergeDir: road.mergeDir ?? -1,
        lanes: road.lanes ?? 1,
        oneway: Boolean(road.oneway),
      })),
  ];
}
function compiledSections() {
  if (!nijoRotary) return (route.roadSections ?? []).map(compiledRouteObject);
  const rejoinRawS = nijoRotary.rejoin.index * 2;
  const stationSection = {
    from: 0,
    to: rejoinRawS,
    lanes: 2,
    lanesF: 2,
    lanesB: 0,
    wL: 7.2,
    wR: 0,
    center: "none",
    oneWay: true,
    source: "OSM Nijo Station West Exit rotary",
  };
  const remainder = (route.roadSections ?? []).flatMap((section) => {
    if (section.to <= rejoinRawS) return [];
    return [{ ...section, from: Math.max(section.from, rejoinRawS) }];
  });
  return [stationSection, ...remainder].map(compiledRouteObject);
}

function nijoVegetation() {
  if (!nijoRotary) return [];
  const xs = nijoRotary.centerline.map(([x]) => x);
  const zs = nijoRotary.centerline.map(([, z]) => z);
  const bounds = { minX: Math.min(...xs) - 20, maxX: Math.max(...xs) + 20, minZ: Math.min(...zs) - 20, maxZ: Math.max(...zs) + 20 };
  return (route.osmVegetation?.greenAreas ?? []).filter((area) => (area.polygon ?? []).some(([x, z]) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ));
}

function nijoRoadOverlay() {
  if (!nijoRotary) return null;
  const laneWidth = 3.2;
  const outerSide = Math.sign(nijoRotary.busLateral || -1);
  const outer = nijoRotary.busLateral + outerSide * laneWidth / 2;
  const divider = nijoRotary.busLateral - outerSide * laneWidth / 2;
  const inner = nijoRotary.busLateral - outerSide * laneWidth * 1.5;
  const rowsAt = (from, to) => nijoRotary.centerline.map((point, index, points) => {
    const previous = points[Math.max(0, index - 1)], next = points[Math.min(points.length - 1, index + 1)];
    const dx = next[0] - previous[0], dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length, nz = dx / length;
    const a = [point[0] + nx * from, point[1] + nz * from];
    const b = [point[0] + nx * to, point[1] + nz * to];
    return [[+a[0].toFixed(3), +gridHeight(...a).toFixed(3), +a[1].toFixed(3)], [+b[0].toFixed(3), +gridHeight(...b).toFixed(3), +b[1].toFixed(3)]];
  });
  return {
    lanes: 2,
    oneWay: true,
    rows: rowsAt(outer, inner),
    laneDividerRows: rowsAt(divider - 0.06, divider + 0.06),
  };
}

// ---------------------------------------------------------------- traffic graph + OSM-derived road details

const GRAPH_ROAD_TYPES = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
  "residential", "living_street", "service",
]);
// 大宮跨線橋の左右に並行する側道。橋上の大宮通は交通グラフへ残し、
// この8 wayだけを除外してNPCが側道へ流入・側道上を走行しないようにする。
// OSMのwayは南北2本の一方通行側道を分割して記録している。
const OMIYA_OVERPASS_SIDE_ROAD_WAY_IDS = new Set([
  27574722, 27574729, 27574731,
  27904454,
  290407940, 290407941, 290407942, 290407943,
]);
const OMIYA_BRIDGE = route.elevations?.find((item) => item.name === "大宮跨線橋") ?? null;
// `route18.json` stores these values in the precompiled route distance. Map
// them onto the current lane-centred distance before applying the bridge
// exclusion, otherwise a lane/path rebuild can move the exclusion window.
const OMIYA_BRIDGE_NETWORK_RANGE = OMIYA_BRIDGE
  ? { from: compiledS(OMIYA_BRIDGE.from), to: compiledS(OMIYA_BRIDGE.to) }
  : null;
const numberTag = (value, fallback = null) => {
  const hit = String(value ?? "").match(/\d+(?:\.\d+)?/);
  return hit ? Number(hit[0]) : fallback;
};
const graphPointKey = ([x, z]) => `${Math.round(x * 5)}:${Math.round(z * 5)}`;
const graphDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function graphRouteProjection(point) {
  let best = { s: 0, distance: Infinity, tangent: [0, 1] };
  for (let index = 1; index < nodes.length; index++) {
    const a = nodes[index - 1], b = nodes[index];
    const segment = [b.x - a.x, b.z - a.z];
    const length = Math.hypot(...segment) || 1;
    const hit = nearestOnSegment(point[0], point[1], [a.x, a.z], [b.x, b.z]);
    if (hit.distance < best.distance) {
      best = {
        s: a.s + (b.s - a.s) * hit.t,
        distance: hit.distance,
        tangent: [segment[0] / length, segment[1] / length],
      };
    }
  }
  return best;
}
function graphRoadCrossesOmiyaBridge(road) {
  if (!OMIYA_BRIDGE_NETWORK_RANGE) return false;
  const points = (road.points ?? []).map(([x, z]) => [Number(x), Number(z)]);
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    const samples = [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b];
    const roadVector = [b[0] - a[0], b[1] - a[1]];
    const roadLength = Math.hypot(...roadVector) || 1;
    const alignment = (projection) => Math.abs(
      (roadVector[0] * projection.tangent[0] + roadVector[1] * projection.tangent[1]) / roadLength,
    );
    for (const sample of samples) {
      const projection = graphRouteProjection(sample);
      if (
        projection.s >= OMIYA_BRIDGE_NETWORK_RANGE.from
        && projection.s <= OMIYA_BRIDGE_NETWORK_RANGE.to
        && projection.distance < 18
        && alignment(projection) < 0.82
      ) return true;
    }
  }
  return false;
}
function graphNodeOnOmiyaBridge(point) {
  if (!OMIYA_BRIDGE_NETWORK_RANGE) return false;
  const projection = graphRouteProjection(point);
  return projection.distance < 18
    && projection.s >= OMIYA_BRIDGE_NETWORK_RANGE.from
    && projection.s <= OMIYA_BRIDGE_NETWORK_RANGE.to;
}
function graphCum(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out.at(-1) + graphDistance(points[i - 1], points[i]));
  return out;
}
function graphPointAt(points, cumulative, distance) {
  const target = clamp(distance, 0, cumulative.at(-1));
  let i = 0;
  while (i < cumulative.length - 2 && cumulative[i + 1] < target) i++;
  const span = cumulative[i + 1] - cumulative[i] || 1;
  const t = (target - cumulative[i]) / span;
  const a = points[i], b = points[i + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
function graphHeading(points, atStart) {
  const a = atStart ? points[0] : points.at(-2);
  const b = atStart ? points[1] : points.at(-1);
  return Math.atan2(b[0] - a[0], b[1] - a[1]);
}
function graphMaxHeadingJump(points) {
  const headings = [];
  for (let index = 1; index < points.length; index++) {
    const dx = points[index][0] - points[index - 1][0];
    const dz = points[index][2] - points[index - 1][2];
    if (Math.hypot(dx, dz) > 1e-6) headings.push(Math.atan2(dx, dz));
  }
  let maximum = 0;
  for (let index = 1; index < headings.length; index++) {
    let delta = headings[index] - headings[index - 1];
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    maximum = Math.max(maximum, Math.abs(delta));
  }
  return maximum;
}
function graphRoadAllowed(road) {
  const tags = road.tags ?? {};
  if (OMIYA_OVERPASS_SIDE_ROAD_WAY_IDS.has(Number(road.id))) return false;
  // Roads crossing the bridge corridor are ground-level roads below the
  // elevated Omiya carriageway. They must not become graph edges or junction
  // openings for the bridge route.
  if (graphRoadCrossesOmiyaBridge(road)) return false;
  if (!GRAPH_ROAD_TYPES.has(tags.highway) || tags.area === "yes") return false;
  if (["no", "private"].includes(tags.access) || ["no", "private"].includes(tags.motor_vehicle)) return false;
  if (["no", "private"].includes(tags.vehicle)) return false;
  if (["driveway", "parking_aisle", "drive-through", "alley"].includes(tags.service)) return false;
  return (road.points?.length ?? 0) >= 2;
}
function graphLaneCounts(tags, direction) {
  const oneway = ["yes", "1", "true", "-1"].includes(String(tags.oneway));
  if (oneway) return Math.max(1, Math.round(numberTag(tags.lanes, 1)));
  const forward = numberTag(tags["lanes:forward"]);
  const backward = numberTag(tags["lanes:backward"]);
  if (forward || backward) return Math.max(1, Math.round(direction > 0 ? forward ?? 1 : backward ?? 1));
  const total = Math.max(2, Math.round(numberTag(tags.lanes, 2)));
  return Math.max(1, direction > 0 ? Math.ceil(total / 2) : Math.floor(total / 2));
}
function graphLaneOffset(tags, direction, laneIndex, laneCount) {
  const oneway = ["yes", "1", "true", "-1"].includes(String(tags.oneway));
  // graphLanePoints computes its normal from the oriented travel direction.
  // Two-way lane zero is the inner lane; one-way lanes are centred on the way.
  return oneway
    ? 3.2 * (laneIndex - (laneCount - 1) / 2)
    : 3.2 * (laneIndex + 0.5);
}
function graphLanePoints(points, offset) {
  let previousFeature = null;
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const length = Math.hypot(dx, dz) || 1;
    // x=east, z=south.  [dz, -dx] is the left-hand normal for the
    // oriented travel direction, matching Japan's left-side traffic.
    const candidate = [points[i][0] + (dz / length) * offset, points[i][1] + (-dx / length) * offset];
    const hit = snapToSurface(candidate[0], candidate[1], previousFeature?.id);
    previousFeature = hit.feature;
    result.push([+hit.point[0].toFixed(3), +gridHeight(...hit.point).toFixed(3), +hit.point[1].toFixed(3)]);
  }
  return result;
}
function surfaceYAt(x, z) {
  let best = null;
  for (const node of nodes) {
    const d2 = (node.x - x) ** 2 + (node.z - z) ** 2;
    if (d2 < (best?.d2 ?? Infinity)) best = { d2, y: node.y };
  }
  return best && best.d2 < 16 * 16 ? best.y : gridHeight(x, z);
}
const BRIDGE_SIDEWALK_WAY_IDS = new Set([
  621846876, 621846878, 621846879, 621846882, 621846892, 621846894,
]);
// This short footway on the east side of Koeda Bridge duplicates the OSM
// zebra crossing with the same source way and should not be rendered as an
// elevated pedestrian bridge.
const REMOVED_OVERLAPPING_FOOTBRIDGE_WAY_IDS = new Set([621846895]);
function sidewalkRows(points, width, yAt) {
  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next[0] - previous[0], dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length, nz = dx / length;
    const y = yAt(point[0], point[1]);
    return [
      [+(point[0] - nx * width / 2).toFixed(3), +y.toFixed(3), +(point[1] - nz * width / 2).toFixed(3)],
      [+(point[0] + nx * width / 2).toFixed(3), +y.toFixed(3), +(point[1] + nz * width / 2).toFixed(3)],
    ];
  });
}
function pointInPolygon2d(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if ((zi > point[1]) !== (zj > point[1]) && point[0] < ((xj - xi) * (point[1] - zi)) / (zj - zi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}
function nearestLineDistance(point, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, nearestOnSegment(point[0], point[1], points[i - 1], points[i]).distance);
  return best;
}
function tessellateGraphConnector(points, divisions = 24) {
  if (!Array.isArray(points) || points.length !== 4) return points ?? [];
  const [a, ctrlA, ctrlB, b] = points;
  const result = [];
  for (let index = 0; index <= divisions; index++) {
    const t = index / divisions;
    const inv = 1 - t;
    const w0 = inv ** 3;
    const w1 = 3 * inv ** 2 * t;
    const w2 = 3 * inv * t ** 2;
    const w3 = t ** 3;
    result.push([
      w0 * a[0] + w1 * ctrlA[0] + w2 * ctrlB[0] + w3 * b[0],
      w0 * a[1] + w1 * ctrlA[1] + w2 * ctrlB[1] + w3 * b[1],
      w0 * a[2] + w1 * ctrlA[2] + w2 * ctrlB[2] + w3 * b[2],
    ]);
  }
  return result;
}
function graphConnectorGeometryValid(points, inVector, outVector) {
  const segments = [];
  const samples = tessellateGraphConnector(points);
  for (let index = 1; index < samples.length; index++) {
    const dx = samples[index][0] - samples[index - 1][0];
    const dz = samples[index][2] - samples[index - 1][2];
    const length = Math.hypot(dx, dz);
    if (length > 1e-6) segments.push([dx / length, dz / length]);
  }
  if (!segments.length) return false;
  if (segments[0][0] * inVector[0] + segments[0][1] * inVector[1] <= 0) return false;
  if (segments.at(-1)[0] * outVector[0] + segments.at(-1)[1] * outVector[1] <= 0) return false;
  for (let index = 1; index < segments.length; index++) {
    if (segments[index - 1][0] * segments[index][0] + segments[index - 1][1] * segments[index][1] <= 0) return false;
  }
  return true;
}
function buildTrafficGraph() {
  const sourceRoads = (osmSource.roads ?? []).filter(graphRoadAllowed);
  const nodesByKey = new Map();
  let edges = [];
  const nodeUse = new Map();
  const pointUse = new Map();
  for (const road of sourceRoads) {
    const nodeIds = road.nodeIds ?? [];
    for (let index = 0; index < road.points.length; index++) {
      const nodeId = nodeIds[index];
      if (nodeId != null) nodeUse.set(String(nodeId), (nodeUse.get(String(nodeId)) ?? 0) + 1);
      const pointKey = graphPointKey(road.points[index]);
      pointUse.set(pointKey, (pointUse.get(pointKey) ?? 0) + 1);
    }
  }
  const addNode = (point, id, sourceNodeId = null) => {
    if (!nodesByKey.has(id)) nodesByKey.set(id, {
      id,
      sourceNodeId,
      point: [+point[0].toFixed(3), +point[1].toFixed(3)],
      incoming: [],
      outgoing: [],
    });
    return id;
  };
  for (const road of sourceRoads) {
    const tags = road.tags ?? {};
    const sourcePoints = road.points.map(([x, z]) => [Number(x), Number(z)]);
    const nodeIds = road.nodeIds ?? [];
    const splitIndices = [0];
    for (let index = 1; index < sourcePoints.length - 1; index++) {
      const nodeId = nodeIds[index];
      const sharedNode = nodeId != null && (nodeUse.get(String(nodeId)) ?? 0) > 1;
      const sharedPoint = (pointUse.get(graphPointKey(sourcePoints[index])) ?? 0) > 1;
      if (sharedNode || sharedPoint) splitIndices.push(index);
    }
    splitIndices.push(sourcePoints.length - 1);
    const directions = tags.oneway === "-1" ? [-1] : ["yes", "1", "true"].includes(String(tags.oneway)) ? [1] : [1, -1];
    for (let segmentIndex = 0; segmentIndex < splitIndices.length - 1; segmentIndex++) {
      const start = splitIndices[segmentIndex];
      const end = splitIndices[segmentIndex + 1];
      if (end <= start) continue;
      const segmentPoints = sourcePoints.slice(start, end + 1);
      const startNodeId = nodeIds[start] ?? null;
      const endNodeId = nodeIds[end] ?? null;
      const fromKey = startNodeId != null
        ? `osm:${startNodeId}`
        : `point:${graphPointKey(segmentPoints[0])}`;
      const toKey = endNodeId != null
        ? `osm:${endNodeId}`
        : `point:${graphPointKey(segmentPoints.at(-1))}`;
      const from = addNode(segmentPoints[0], fromKey, startNodeId);
      const to = addNode(segmentPoints.at(-1), toKey, endNodeId);
      for (const direction of directions) {
        const laneCount = graphLaneCounts(tags, direction);
        const oriented = direction > 0 ? segmentPoints : [...segmentPoints].reverse();
        for (let lane = 0; lane < laneCount; lane++) {
          let samples;
          try {
            samples = graphLanePoints(oriented, graphLaneOffset(tags, direction, lane, laneCount));
          } catch {
            continue;
          }
          const length = graphCum(samples.map(([x, , z]) => [x, z])).at(-1);
          if (!(length > 2)) continue;
          const id = `way-${road.id}-${segmentIndex}-${direction > 0 ? "f" : "r"}-lane-${lane}`;
          const edge = {
            id,
            wayId: road.id,
            name: tags.name ?? "",
            highway: tags.highway,
            direction,
            lane,
            laneCount,
            oneway: directions.length === 1,
            from: direction > 0 ? from : to,
            to: direction > 0 ? to : from,
            sourceFromNode: direction > 0 ? startNodeId : endNodeId,
            sourceToNode: direction > 0 ? endNodeId : startNodeId,
            segmentIndex,
            points: samples,
            length: +length.toFixed(3),
            physicsSafe: graphMaxHeadingJump(samples) < Math.PI / 4,
            speed: Math.max(15, numberTag(tags.maxspeed, tags.highway === "service" ? 20 : 40)) / 3.6,
          };
          edges.push(edge);
          nodesByKey.get(edge.from).outgoing.push(id);
          nodesByKey.get(edge.to).incoming.push(id);
        }
      }
    }
  }
  // PLATEAU surface snapping can collapse both directions of a narrow OSM
  // road onto the same polygon boundary.  Such a segment cannot represent
  // safe two-way traffic, so exclude the complete segment instead of keeping
  // overlapping opposing lanes.
  const edgeByLaneKey = new Map(edges.map((edge) => [
    `${edge.wayId}:${edge.segmentIndex}:${edge.direction}:${edge.lane}`,
    edge,
  ]));
  const unsafeTwoWaySegments = new Set();
  for (const forward of edges) {
    if (forward.oneway || forward.direction !== 1 || forward.lane !== 0) continue;
    const reverse = edgeByLaneKey.get(`${forward.wayId}:${forward.segmentIndex}:-1:0`);
    if (!reverse || forward.points.length !== reverse.points.length) continue;
    for (let index = 0; index < forward.points.length; index++) {
      const a = forward.points[Math.max(0, index - 1)];
      const b = forward.points[Math.min(forward.points.length - 1, index + 1)];
      const dx = b[0] - a[0], dz = b[2] - a[2];
      const length = Math.hypot(dx, dz) || 1;
      const opposing = reverse.points[reverse.points.length - 1 - index];
      const signedSeparation = (forward.points[index][0] - opposing[0]) * (dz / length)
        + (forward.points[index][2] - opposing[2]) * (-dx / length);
      if (signedSeparation < 0.5) {
        unsafeTwoWaySegments.add(`${forward.wayId}:${forward.segmentIndex}`);
        break;
      }
    }
  }
  if (unsafeTwoWaySegments.size) {
    edges = edges.filter((edge) => !unsafeTwoWaySegments.has(`${edge.wayId}:${edge.segmentIndex}`));
    for (const node of nodesByKey.values()) {
      node.incoming = [];
      node.outgoing = [];
    }
    for (const edge of edges) {
      nodesByKey.get(edge.from).outgoing.push(edge.id);
      nodesByKey.get(edge.to).incoming.push(edge.id);
    }
  }
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const sourceSignals = osmSource.trafficSignals ?? [];
  const signalAt = (point) => sourceSignals.some((signal) => graphDistance(point, signal.point) < 14);
  const connectors = [];
  for (const node of nodesByKey.values()) {
    node.signal = signalAt(node.point);
    for (const incomingId of node.incoming) for (const outgoingId of node.outgoing) {
      const incoming = edgeById.get(incomingId), outgoing = edgeById.get(outgoingId);
      if (!incoming || !outgoing || incoming.id === outgoing.id) continue;
      if (incoming.wayId === outgoing.wayId && incoming.direction !== outgoing.direction) continue;
      // The elevated Omiya carriageway may continue through its own split
      // nodes, but a road from another way must never be connected there.
      if (graphNodeOnOmiyaBridge(node.point) && incoming.wayId !== outgoing.wayId) continue;
      const inHeading = graphHeading(incoming.points.map(([x, , z]) => [x, z]), false);
      const outHeading = graphHeading(outgoing.points.map(([x, , z]) => [x, z]), true);
      let delta = outHeading - inHeading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      // A U-turn is not a legal lane connector for this traffic model. It
      // was previously falling through as a "straight" connector and could
      // send an NPC back along its incoming lane.
      if (Math.abs(delta) >= Math.PI * 0.8) continue;
      // With heading=atan2(dx,dz), positive rotation is left and negative is
      // right in the x=east, z=south world coordinate system.
      const isLeft = delta > Math.PI / 5 && delta < Math.PI * 0.8;
      const isRight = delta < -Math.PI / 5 && delta > -Math.PI * 0.8;
      const isTurn = isRight || isLeft;
      // Keep one deterministic target lane per road movement.  Source lanes
      // remain unrestricted because this model has no pre-junction lane
      // changing; restricting them would strand agents at intersections.
      const targetLane = isLeft
        ? outgoing.laneCount - 1
        : isRight
          ? 0
          : Math.min(incoming.lane, outgoing.laneCount - 1);
      if (outgoing.lane !== targetLane) continue;
      const a = incoming.points.at(-1), b = outgoing.points[0];
      const inVector = [Math.sin(inHeading), Math.cos(inHeading)];
      const outVector = [Math.sin(outHeading), Math.cos(outHeading)];
      const chord = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (isTurn && chord < 0.5) continue;
      const zeroLength = !isTurn && chord < 1e-3;
      const handle = Math.min(3.5, chord / 3);
      const ctrlA = zeroLength
        ? [...a]
        : [a[0] + inVector[0] * handle, surfaceYAt(a[0], a[2]), a[2] + inVector[1] * handle];
      const ctrlB = zeroLength
        ? [...b]
        : [b[0] - outVector[0] * handle, surfaceYAt(b[0], b[2]), b[2] - outVector[1] * handle];
      const points = [a, ctrlA, ctrlB, b];
      if (!zeroLength && !graphConnectorGeometryValid(points, inVector, outVector)) continue;
      connectors.push({
        id: `turn-${incoming.id}-${outgoing.id}`,
        node: node.id,
        from: incoming.id,
        to: outgoing.id,
        right: isRight,
        turn: isTurn,
        turnDirection: isRight ? "right" : isLeft ? "left" : "straight",
        zeroLength,
        points,
      });
    }
  }
  return { version: 3, branchMeters: TRAFFIC_BRANCH_METERS, nodes: [...nodesByKey.values()], edges, connectors };
}

function buildRoadOverlays(graph, bridgeRanges = []) {
  const roads = (osmSource.roads ?? []).filter(graphRoadAllowed);
  const vegetation = osmSource.vegetation?.greenAreas ?? [];
  const hedges = osmSource.hedges ?? [];
  const junctionPoints = (graph?.nodes ?? [])
    .filter((node) => (node.incoming?.length ?? 0) + (node.outgoing?.length ?? 0) >= 4)
    .map((node) => node.point);
  const medians = [];
  const paired = new Set();
  const usable = (road) => ["trunk", "primary", "secondary", "tertiary"].includes(road.tags?.highway) && road.tags?.oneway && road.tags?.name;
  for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
    const a = roads[i], b = roads[j];
    if (!usable(a) || !usable(b) || a.tags.name !== b.tags.name) continue;
    const key = `${a.id}:${b.id}`;
    if (paired.has(key)) continue;
    const ca = graphCum(a.points), cb = graphCum(b.points);
    const steps = Math.min(80, Math.max(4, Math.ceil(Math.min(ca.at(-1), cb.at(-1)) / 8)));
    const ah = graphHeading(a.points, true), bh = graphHeading(b.points, true);
    const reverseB = Math.cos(ah - bh) < 0;
    const rows = [];
    for (let k = 0; k <= steps; k++) {
      const pa = graphPointAt(a.points, ca, (ca.at(-1) * k) / steps);
      const pb = graphPointAt(b.points, cb, (cb.at(-1) * (reverseB ? steps - k : k)) / steps);
      const dx = pb[0] - pa[0], dz = pb[1] - pa[1];
      const distance = Math.hypot(dx, dz);
      if (distance < 5 || distance > 24) continue;
      const wa = numberTag(a.tags.width, Math.max(1, numberTag(a.tags.lanes, 2)) * 3.2) / 2;
      const wb = numberTag(b.tags.width, Math.max(1, numberTag(b.tags.lanes, 2)) * 3.2) / 2;
      if (distance <= wa + wb + 0.7) continue;
      rows.push([
        [pa[0] + (dx / distance) * wa, surfaceYAt(pa[0], pa[1]), pa[1] + (dz / distance) * wa],
        [pb[0] - (dx / distance) * wb, surfaceYAt(pb[0], pb[1]), pb[1] - (dz / distance) * wb],
      ]);
    }
    if (rows.length < 3) continue;
    const midpoint = rows[Math.floor(rows.length / 2)];
    const center = [(midpoint[0][0] + midpoint[1][0]) / 2, (midpoint[0][2] + midpoint[1][2]) / 2];
    const planted = vegetation.some((area) => pointInPolygon2d(center, area.polygon ?? []))
      || hedges.some((hedge) => nearestLineDistance(center, hedge.points ?? []) < 2.5);
    let run = [];
    let segment = 0;
    const commit = () => {
      if (run.length >= 3) medians.push({ id: `median-${a.id}-${b.id}-${segment++}`, name: a.tags.name, rows: run, planted });
      run = [];
    };
    for (const row of rows) {
      const center = [(row[0][0] + row[1][0]) / 2, (row[0][2] + row[1][2]) / 2];
      const opening = junctionPoints.some((point) => graphDistance(point, center) < 11);
      if (opening) commit();
      else run.push(row);
    }
    commit();
  }
  const crosswalks = [];
  const nearestRoutePoint = (x, z) => {
    let best = { s: 0, distance: Infinity };
    for (let segment = 1; segment < nodes.length; segment++) {
      const a = nodes[segment - 1], b = nodes[segment];
      const hit = nearestOnSegment(x, z, [a.x, a.z], [b.x, b.z]);
      if (hit.distance < best.distance) {
        const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const along = Math.hypot(hit.point[0] - a.x, hit.point[1] - a.z);
        best = { s: a.s + (b.s - a.s) * Math.min(1, along / length), distance: hit.distance };
      }
    }
    return best;
  };
  const isBridgeCrosswalk = (routeHit) => bridgeRanges.some((range) =>
    routeHit.distance < 30 && routeHit.s >= range.from && routeHit.s <= range.to,
  );
  const addCrosswalk = (id, a, b, crosswalkWidth, metadata = {}, checkRoadDirection = true) => {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    if (length < 2) return false;
    const ux = dx / length, uz = dz / length, vx = -uz, vz = ux;
    const midpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const routeHit = nearestRoutePoint(midpoint[0], midpoint[1]);
    if (isBridgeCrosswalk(routeHit)) return false;
    if (checkRoadDirection) {
      let nearestRoad = null;
      for (const road of roads) {
        for (let segment = 1; segment < road.points.length; segment++) {
          const ra = road.points[segment - 1], rb = road.points[segment];
          const hit = nearestOnSegment(midpoint[0], midpoint[1], ra, rb);
          if (!nearestRoad || hit.distance < nearestRoad.distance) {
            const rdx = rb[0] - ra[0], rdz = rb[1] - ra[1], rlength = Math.hypot(rdx, rdz) || 1;
            nearestRoad = { distance: hit.distance, tangent: [rdx / rlength, rdz / rlength] };
          }
        }
      }
      // Some OSM footways are tagged as crossings for their entire
      // longitudinal sidewalk run.  A zebra must cross the carriageway, so
      // discard segments that are effectively parallel to their nearest road.
      if (nearestRoad && Math.abs(ux * nearestRoad.tangent[0] + uz * nearestRoad.tangent[1]) > 0.85) return false;
    }
    // The crossing line is the repeat axis. Each white bar is perpendicular
    // to it, with a 45 cm stripe and a 50 cm gap.
    const stripeWidth = 0.45;
    const stripeHalfWidth = stripeWidth / 2;
    const stripeGap = 0.50;
    const stripePitch = stripeWidth + stripeGap;
    const stripeCount = Math.floor((length + stripeGap) / stripePitch);
    if (stripeCount <= 0) return false;
    const totalStripeSpan = stripeCount * stripeWidth + (stripeCount - 1) * stripeGap;
    const halfLong = Math.max(4.0, Number(crosswalkWidth) || 4.0) / 2;
    const strips = [];
    for (let stripe = 0; stripe < stripeCount; stripe++) {
      const offset = -totalStripeSpan / 2 + stripeHalfWidth + stripe * stripePitch;
      const center = [midpoint[0] + ux * offset, midpoint[1] + uz * offset];
      const polygon = [
        [center[0] - vx * halfLong - ux * stripeHalfWidth, center[1] - vz * halfLong - uz * stripeHalfWidth],
        [center[0] + vx * halfLong - ux * stripeHalfWidth, center[1] + vz * halfLong - uz * stripeHalfWidth],
        [center[0] + vx * halfLong + ux * stripeHalfWidth, center[1] + vz * halfLong + uz * stripeHalfWidth],
        [center[0] - vx * halfLong + ux * stripeHalfWidth, center[1] - vz * halfLong + uz * stripeHalfWidth],
      ];
      strips.push(polygon.map(([x, z]) => [x, surfaceYAt(x, z), z]));
    }
    crosswalks.push({
      id,
      ...metadata,
      routeS: +routeHit.s.toFixed(3),
      routeDistance: +routeHit.distance.toFixed(3),
      stripes: strips,
    });
    return true;
  };
  for (const crossing of osmSource.crossings ?? []) {
    const points = crossing.points ?? [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      addCrosswalk(
        `crosswalk-${crossing.id}-${i}`,
        a,
        b,
        numberTag(crossing.tags?.width, 4.0),
        { source: "osm", sourceId: crossing.id },
      );
    }
  }
  const routePointAt = (s) => {
    let index = 0;
    while (index < nodes.length - 2 && nodes[index + 1].s < s) index++;
    const a = nodes[index], b = nodes[index + 1];
    const t = clamp((s - a.s) / Math.max(1e-6, b.s - a.s), 0, 1);
    const heading = a.heading + (b.heading - a.heading) * t;
    const left = driveBounds[index].left + (driveBounds[index + 1].left - driveBounds[index].left) * t;
    const right = driveBounds[index].right + (driveBounds[index + 1].right - driveBounds[index].right) * t;
    return {
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      tx: Math.sin(heading),
      tz: Math.cos(heading),
      nx: -Math.cos(heading),
      nz: Math.sin(heading),
      left,
      right,
    };
  };
  const namedIntersections = [
    { name: "五条通", label: "五条大宮" },
    { name: "東寺道", label: "東寺道" },
  ];
  for (const target of namedIntersections) {
    const intersection = (route.intersections ?? []).find((item) => item.name === target.name);
    if (!intersection) continue;
    const s = compiledS(intersection.s);
    const frame = routePointAt(s);
    const section = sectionAt(intersection.s);
    const leftWidth = Number(section?.wL) || 7.2;
    const rightWidth = Number(section?.wR) || 7.2;
    const routeWidth = leftWidth + rightWidth;
    const crossroadWidth = Math.max(8, Number(intersection.width) || 8);
    const crossroadHalf = crossroadWidth / 2;
    const crossTx = Math.sin(intersection.heading ?? 0);
    const crossTz = Math.cos(intersection.heading ?? 0);
    let index = 0;
    // Crosswalks across the main road, on both edges of the cross street.
    for (const side of [-1, 1]) {
      const cx = frame.x + frame.tx * side * (crossroadHalf + 1.8);
      const cz = frame.z + frame.tz * side * (crossroadHalf + 1.8);
      addCrosswalk(
        `crosswalk-${target.label}-${index++}`,
        [cx - crossTx * routeWidth / 2, cz - crossTz * routeWidth / 2],
        [cx + crossTx * routeWidth / 2, cz + crossTz * routeWidth / 2],
        4,
        { source: "intersection", intersection: target.label },
        false,
      );
    }
    // Crosswalks across the cross street. A T-junction only gets the arm
    // that actually exists in the compiled intersection topology.
    const sides = (intersection.arms ?? []).filter((arm) => arm.exists).map((arm) => arm.side);
    for (const side of sides.length ? sides : [-1, 1]) {
      const lateral = side > 0 ? rightWidth + 1.0 : -(leftWidth + 1.0);
      const cx = frame.x + frame.nx * lateral;
      const cz = frame.z + frame.nz * lateral;
      addCrosswalk(
        `crosswalk-${target.label}-${index++}`,
        [cx - frame.tx * crossroadHalf, cz - frame.tz * crossroadHalf],
        [cx + frame.tx * crossroadHalf, cz + frame.tz * crossroadHalf],
        4,
        { source: "intersection", intersection: target.label },
        false,
      );
    }
  }
  const pedestrianWays = osmSource.pedestrianWays ?? [];
  const bridgeSidewalks = pedestrianWays
    .filter((way) => BRIDGE_SIDEWALK_WAY_IDS.has(Number(way.id)))
    .map((way) => {
      const points = way.points ?? [];
      return {
        id: `sidewalk-${way.id}`,
        wayId: Number(way.id),
        width: numberTag(way.tags?.width, 2.0),
        rows: sidewalkRows(points, numberTag(way.tags?.width, 2.0), surfaceYAt),
      };
    })
    .filter((item) => item.rows.length >= 2);
  const deckEnds = new Set(pedestrianWays.filter((way) => way.tags?.highway !== "steps").flatMap((way) => [graphPointKey(way.points[0]), graphPointKey(way.points.at(-1))]));
  const footbridges = pedestrianWays
    .filter((way) =>
      !BRIDGE_SIDEWALK_WAY_IDS.has(Number(way.id))
      && !REMOVED_OVERLAPPING_FOOTBRIDGE_WAY_IDS.has(Number(way.id)),
    )
    .map((way) => {
      const points = way.points ?? [];
      // Sidewalks beside a river bridge are part of the same deck.  Use the
      // compiled PLATEAU road surface directly instead of floating them above
      // it with an independent pedestrian-bridge clearance.
      const isKogaSidewalk = kogaBridgeRawRange
        && ["621846879", "621846882"].includes(String(way.id));
      const deckY = isKogaSidewalk ? null : Math.max(...points.map(([x, z]) => surfaceYAt(x, z))) + 5.2;
      const steps = way.tags?.highway === "steps";
      const aHigh = deckEnds.has(graphPointKey(points[0]));
      const bHigh = deckEnds.has(graphPointKey(points.at(-1)));
      return {
        id: `pedestrian-${way.id}`,
        kind: steps ? "stairs" : "deck",
        width: numberTag(way.tags?.width, steps ? 1.8 : 2.0),
        points: points.map(([x, z], index) => {
          const ground = surfaceYAt(x, z);
          const t = points.length <= 1 ? 0 : index / (points.length - 1);
          const pointDeckY = isKogaSidewalk ? ground : deckY;
          const y = steps ? ((aHigh ? pointDeckY : ground) * (1 - t) + (bHigh ? pointDeckY : ground) * t) : pointDeckY;
          return [x, y, z];
        }),
      };
    }).filter((item) => item.points.length >= 2);
  return { medians, crosswalks, footbridges, bridgeSidewalks };
}

function nearestNode(x, z, start = 0) {
  let best = start, bestD2 = Infinity;
  for (let i = start; i < nodes.length; i++) {
    const d2 = (nodes[i].x - x) ** 2 + (nodes[i].z - z) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return { index: best, distance: Math.sqrt(bestD2) };
}
let stopCursor = 0;
const stops = (route.stops ?? []).map((stop) => {
  const [px, pz] = stop.platform ?? [0, 0];
  const hit = nearestNode(px, pz, stopCursor);
  stopCursor = hit.index;
  if (hit.distance > 28) throw new Error(`OSM stop ${stop.name} is ${hit.distance.toFixed(1)}m from generated driving path`);
  const node = nodes[hit.index];
  const tx = Math.sin(node.heading), tz = Math.cos(node.heading);
  const nx = -tz, nz = tx;
  const platformLateral = (px - node.x) * nx + (pz - node.z) * nz;
  const platformSide = Math.sign(platformLateral || -1);
  const bounds = driveBounds[hit.index] ?? { left: BUS_HALF_WIDTH + 0.5, right: BUS_HALF_WIDTH + 0.5 };
  const dockMin = -Math.max(0, bounds.left - BUS_HALF_WIDTH - 0.25);
  const dockMax = Math.max(0, bounds.right - BUS_HALF_WIDTH - 0.25);
  const dockLateral = clamp(
    platformLateral - platformSide * (BUS_HALF_WIDTH + 0.35),
    dockMin,
    dockMax,
  );
  const dockX = node.x + nx * dockLateral;
  const dockZ = node.z + nz * dockLateral;
  const halfWidth = 1.3;
  const length = 6;
  const corners = [[-halfWidth, -length], [halfWidth, -length], [halfWidth, length], [-halfWidth, length]]
    .map(([l, a]) => [+(dockX + nx * l + tx * a).toFixed(3), +(dockZ + nz * l + tz * a).toFixed(3)]);
  return {
    ...stop,
    s: node.s,
    pose: { x: +dockX.toFixed(3), z: +dockZ.toFixed(3), y: node.y, heading: node.heading },
    dockLateral: +dockLateral.toFixed(3),
    // The OSM platform remains source metadata, but the visible pole and
    // waiting area must be attached to the compiled stopping pose.  This
    // avoids rendering a second, detached stop when a platform node is set
    // back from the carriageway.
    anchor: {
      x: +(dockX + nx * platformSide * (halfWidth + 1.1)).toFixed(3),
      z: +(dockZ + nz * platformSide * (halfWidth + 1.1)).toFixed(3),
      side: platformSide,
    },
    frame: corners,
    platform: stop.platform,
    platformDistance: +hit.distance.toFixed(3),
  };
});

const trafficGraph = buildTrafficGraph();
const crosswalkExclusions = (route.elevations ?? [])
  .filter((structure) => structure.name === "大宮跨線橋")
  .map((structure) => ({ from: compiledS(structure.from), to: compiledS(structure.to) }));
const roadOverlays = buildRoadOverlays(trafficGraph, crosswalkExclusions);

function compiledBridge(bridge) {
  const result = { ...compiledRouteObject(bridge) };
  // Keep the visible bridge rails on the same OSM span as the road deck.
  // The generated bridge table is intentionally approximate, while the OSM
  // bridge way gives us the authoritative endpoints for 久我橋.
  if (bridge.name === "久我橋(桂川)" && kogaBridgeRawRange) {
    const from = compiledS(kogaBridgeRawRange[0]);
    const to = compiledS(kogaBridgeRawRange[1]);
    result.s = +((from + to) / 2).toFixed(3);
    result.length = +(to - from).toFixed(3);
  }
  return result;
}

function railEdgesForBridge(bridge) {
  const center = compiledBridge(bridge);
  const from = Math.max(0, center.s - Number(center.length ?? 0) / 2);
  const to = Math.min(nodes.at(-1).s, center.s + Number(center.length ?? 0) / 2);
  const at = (s) => {
    let i = 0;
    while (i < nodes.length - 2 && nodes[i + 1].s < s) i++;
    const a = nodes[i], b = nodes[i + 1];
    const t = clamp((s - a.s) / Math.max(1e-6, b.s - a.s), 0, 1);
    const boundsA = driveBounds[i], boundsB = driveBounds[i + 1];
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const y = a.y + (b.y - a.y) * t, heading = a.heading + (b.heading - a.heading) * t;
    const nx = -Math.cos(heading), nz = Math.sin(heading);
    const left = boundsA.left + (boundsB.left - boundsA.left) * t;
    const right = boundsA.right + (boundsB.right - boundsA.right) * t;
    return {
      left: [+(x - nx * left).toFixed(3), +y.toFixed(3), +(z - nz * left).toFixed(3)],
      right: [+(x + nx * right).toFixed(3), +y.toFixed(3), +(z + nz * right).toFixed(3)],
    };
  };
  const left = [], right = [];
  for (let s = from; ; s += 2.5) {
    const sample = at(Math.min(s, to));
    left.push(sample.left); right.push(sample.right);
    if (s >= to) break;
  }
  return { ...center, railEdges: { left, right } };
}

const withinOmiyaBridge = (s) => OMIYA_BRIDGE_NETWORK_RANGE
  && Number.isFinite(Number(s))
  && Number(s) >= OMIYA_BRIDGE_NETWORK_RANGE.from - 1e-6
  && Number(s) <= OMIYA_BRIDGE_NETWORK_RANGE.to + 1e-6;
const crossesOmiyaBridge = (item) => withinOmiyaBridge(item.s)
  || withinOmiyaBridge(item.sIn)
  || withinOmiyaBridge(item.sOut)
  || (Number(item.sIn) < OMIYA_BRIDGE_NETWORK_RANGE?.to
    && Number(item.sOut) > OMIYA_BRIDGE_NETWORK_RANGE?.from);
const compiledIntersections = (route.intersections ?? [])
  .map(compiledRouteObject)
  .filter((item) => !withinOmiyaBridge(item.s));
const compiledTurnIntersections = (route.turnIntersections ?? [])
  .map(compiledRouteObject)
  .filter((item) => !crossesOmiyaBridge(item));
const compiledSignals = (route.signals ?? [])
  .map(compiledRouteObject)
  .filter((item) => !withinOmiyaBridge(item.s));

const trafficPaths = compiledTrafficPaths();
const onPlateauRoad = (x, z) => candidates(x, z)
  .some((feature) => feature.kind !== "sidewalk" && contains(feature.points, x, z));
// A PLATEAU seam may cut across a compiled NPC lane even when the adjacent
// polygons describe one physical carriageway.  Emit the same narrow visible
// asphalt patch used for the bus footprint; never collapse two lane centres
// onto one polygon boundary just to satisfy the seam.
for (const trafficPath of trafficPaths.filter((item) => item.role === "main" && item.id !== "main-forward-lane-0")) {
  for (let start = 0; start < trafficPath.points.length;) {
    if (!trafficPath.active[start] || onPlateauRoad(...trafficPath.points[start])) { start++; continue; }
    let end = start;
    while (end + 1 < trafficPath.points.length
      && trafficPath.active[end + 1]
      && !onPlateauRoad(...trafficPath.points[end + 1])) end++;
    const from = Math.max(0, start - 1), to = Math.min(nodes.length - 1, end + 1);
    const rows = [];
    for (let index = from; index <= to; index++) {
      if (!trafficPath.active[index]) continue;
      const previous = trafficPath.points[Math.max(from, index - 1)];
      const next = trafficPath.points[Math.min(to, index + 1)];
      const dx = next[0] - previous[0], dz = next[1] - previous[1];
      const length = Math.hypot(dx, dz) || 1;
      const nx = -dz / length, nz = dx / length;
      const [x, z] = trafficPath.points[index], y = nodes[index].y;
      rows.push([
        [+(x - nx * 1.15).toFixed(3), y, +(z - nz * 1.15).toFixed(3)],
        [+(x + nx * 1.15).toFixed(3), y, +(z + nz * 1.15).toFixed(3)],
      ]);
    }
    if (rows.length >= 2) surfacePatches.push({
      from: nodes[from].s,
      to: nodes[to].s,
      rows,
      kind: "traffic-lane-seam",
      laneId: trafficPath.id,
    });
    start = end + 1;
  }
}

function compiledStructure(structure) {
  const result = {
    ...compiledRouteObject(resolvedStructure(structure)),
    ...(effectiveStructureApproaches.get(structure.name) ?? {}),
  };
  // Flat river decks use PLATEAU terrain only; structural clearance is not
  // carried into the runtime route metadata.
  if (structure.profile === "flat-deck") delete result.height;
  return result;
}

const network = {
  version: 2,
  generatedAt: new Date().toISOString(),
  source: { route: "OSM semantics", roadSurface: "PLATEAU transportation", terrain: "PLATEAU DEM" },
  path: nodes.map((n) => [n.x, n.z]),
  surfacePath: roadCenter.map((point) => [+(point.x).toFixed(3), +(point.z).toFixed(3)]),
  routeReferencePath: center.map((point) => [+(point.x).toFixed(3), +(point.z).toFixed(3)]),
  // `surfacePath` and the lane path intentionally have different geometry.
  // Preserve the lane path's distance parameter so all visual road features
  // line up with the compiled sections and structure intervals.
  surfaceS: nodes.map((n) => n.s),
  nodes,
  driveBounds,
  sections: compiledSections(),
  speedZones: (route.speedZones ?? []).map(compiledRouteObject),
  signals: compiledSignals,
  intersections: compiledIntersections,
  turnIntersections: compiledTurnIntersections,
  stops,
  structures: (route.elevations ?? []).map(compiledStructure),
  bridges: (route.bridges ?? []).map(railEdgesForBridge),
  railStructures: (route.railStructures ?? []).map(compiledRouteObject),
  selectedSurfaceIds: [...new Set(nodes.map((n) => n.surfaceId))],
  // Every vehicle lane path is compiled with the map. Runtime self-driving,
  // same-direction traffic and lane markings consume these canonical paths;
  // the unified OSM graph supplies the off-route NPC branches.
  trafficPaths,
  trafficGraph,
  surfacePatches,
  overlays: {
    nijoRotary: {
      stationRoads: route.osmStationRoads ?? [],
      centerline: nijoRotary?.centerline ?? [],
      laneCount: nijoRotary ? 2 : 0,
      oneWay: Boolean(nijoRotary),
      road: nijoRoadOverlay(),
      vegetation: nijoVegetation(),
    },
    roads: roadOverlays,
  },
};

// The bus path and both lateral corners must be covered by selected PLATEAU
// traffic surfaces.  This is intentionally a build failure, never a runtime fallback.
writeJson(outputFile, network);
console.log(JSON.stringify({ status: "driving-network-ok", output: outputFile, nodes: nodes.length, stops: stops.length, surfaces: network.selectedSurfaceIds.length, surfacePatches: surfacePatches.length }, null, 2));
