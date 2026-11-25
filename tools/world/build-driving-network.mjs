#!/usr/bin/env node
/**
 * Compile the OSM route semantics onto authoritative PLATEAU transportation
 * surfaces.  Nothing in the simulator is allowed to re-snap this route: a
 * missing or ambiguous surface is a map-build error.
 */
import fs from "node:fs";
import path from "node:path";
import { valueAfter, writeJson } from "./lib.mjs";
import { loadPipelineContext, routeIdFromArgv } from "../lib/pipeline-context.mjs";
import { filterExtraCrosswalksForRoute } from "../lib/corridor-filter.mjs";
import { archedDeckElevation } from "../../src/route/structureProfiles.js";

const ctx = loadPipelineContext(routeIdFromArgv());
const cfg = ctx.worldConfig;
const PATCHES_ROADS = ctx.patches.roads;
const PATCHES_STRUCTURES = ctx.patches.structures;
const PATCHES_TURNAROUNDS = ctx.patches.terminusTurnarounds;
const routeFile = path.resolve(valueAfter("--route") ?? ctx.resolveRoot(cfg.osm.routeFile));
const transportFile = path.resolve(valueAfter("--transportation") ?? ctx.resolveRoot(cfg.output.plateauTransportation));
const terrainFile = path.resolve(valueAfter("--terrain") ?? ctx.resolveRoot(cfg.output.plateauTerrain));
const outputFile = path.resolve(valueAfter("--output") ?? ctx.resolveRoot(cfg.output.drivingNetwork));
const osmSourceFile = path.resolve(valueAfter("--osm-source") ?? ctx.resolveRoot(cfg.output.osmVisualSource));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const route = read(routeFile);
const transport = read(transportFile);
const terrain = read(terrainFile).grid;
const osmSource = read(osmSourceFile);
const TRAFFIC_BRANCH_METERS = Number(cfg.osm.trafficBranchMeters ?? 250);

const DN_DEFAULTS = PATCHES_STRUCTURES.DRIVING_NETWORK_DEFAULTS ?? {};
const CELL = DN_DEFAULTS.CELL ?? 40;
const SNAP_LIMIT = DN_DEFAULTS.SNAP_LIMIT ?? 12;
const BUS_HALF_WIDTH = DN_DEFAULTS.BUS_HALF_WIDTH ?? 1.28;
const LANE_WIDTH = DN_DEFAULTS.LANE_WIDTH ?? 3.2;
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

function effectiveLaneOverride(wayId) {
  return PATCHES_ROADS.WAY_LANE_OVERRIDES?.[String(wayId)] ?? null;
}
function filletCorner(prev, corner, next, radius = 6, steps = 4) {
  const dx1 = prev[0] - corner[0], dz1 = prev[1] - corner[1];
  const dx2 = next[0] - corner[0], dz2 = next[1] - corner[1];
  const len1 = Math.hypot(dx1, dz1), len2 = Math.hypot(dx2, dz2);
  if (len1 < 1 || len2 < 1) return [corner];
  const trim = Math.min(radius, len1 * 0.4, len2 * 0.4);
  const p0 = [corner[0] + (dx1 / len1) * trim, corner[1] + (dz1 / len1) * trim];
  const p2 = [corner[0] + (dx2 / len2) * trim, corner[1] + (dz2 / len2) * trim];
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    pts.push([
      u * u * p0[0] + 2 * u * t * corner[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * corner[1] + t * t * p2[1],
    ]);
  }
  return pts;
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

  let afterRotary = rawRoute.slice(rejoin.index + 1).map((point, index) => ({
    point,
    rawS: (rejoin.index + 1 + index) * 2,
  }));
  const onewayPatches = PATCHES_ROADS.ONEWAY_CORRIDOR_PATCHES ?? [];
  let onewayMatch = null;
  for (const patch of onewayPatches) {
    const candidateRoad = (osmSource.roads ?? []).find((road) => Number(road.id) === Number(patch.eastboundWayId));
    if (candidateRoad?.points?.length >= 2 && distance(candidateRoad.points[0], outbound.points.at(-1)) <= 60) {
      onewayMatch = { patch, eastbound: candidateRoad };
      break;
    }
  }
  if (onewayMatch) {
    const oikePatch = onewayMatch.patch;
    const eastbound = onewayMatch.eastbound;
    if (eastbound?.points?.length >= 2) {
      const ebPts = eastbound.points;
      const junctionEnd = ebPts.at(-1);
      const nearestToJunction = nearestPointIndex(rawRoute, junctionEnd);
      // Join Senbon-dori cleanly past the corner rounding (~20 m south of junction)
      const senbonJoinIndex = Math.min(rawRoute.length - 2, nearestToJunction.index + 15);
      const senbonTarget = rawRoute[senbonJoinIndex];
      const entryCorner = ebPts[0];
      const exitPrev = ebPts.length >= 4 ? ebPts.at(-3) : ebPts.at(-2);
      const exitCorner = ebPts.at(-1);
      // Replace the sharp hairpin at the rotary-exit / Oike corner (ebPts[0]) with
      // a smooth ~14m fillet anchored well back on the outbound leg and onto Oike EB.
      const rotaryOutEnd = outbound.points.at(-1);
      const rotaryAnchorIdx = Math.max(0, centerline.length - 8);
      const trimStart = centerline[rotaryAnchorIdx];
      const oDx = ebPts[1][0] - entryCorner[0], oDz = ebPts[1][1] - entryCorner[1];
      const oLen = Math.hypot(oDx, oDz) || 1;
      const oTargetDist = Math.min(16, oLen * 0.85);
      const trimEnd = [
        entryCorner[0] + (oDx / oLen) * oTargetDist,
        entryCorner[1] + (oDz / oLen) * oTargetDist,
      ];
      // Use quadratic Bezier around the intersection corner rather than kissing the acute tip
      const ctrl = [
        (rotaryOutEnd[0] + entryCorner[0]) * 0.5,
        (rotaryOutEnd[1] + entryCorner[1]) * 0.5,
      ];
      const cornerCurve = [];
      for (let step = 0; step <= 10; step++) {
        const t = step / 10, u = 1 - t;
        cornerCurve.push([
          u * u * trimStart[0] + 2 * u * t * ctrl[0] + t * t * trimEnd[0],
          u * u * trimStart[1] + 2 * u * t * ctrl[1] + t * t * trimEnd[1],
        ]);
      }
      const prefixKeep = centerline.slice(0, rotaryAnchorIdx);
      const rDx1 = exitPrev[0] - exitCorner[0], rDz1 = exitPrev[1] - exitCorner[1];
      const rDx2 = senbonTarget[0] - exitCorner[0], rDz2 = senbonTarget[1] - exitCorner[1];
      const rLen1 = Math.hypot(rDx1, rDz1) || 1, rLen2 = Math.hypot(rDx2, rDz2) || 1;
      const rightTrim = Math.min(16, rLen1 * 0.85, rLen2 * 0.65);
      const rp0 = [exitCorner[0] + (rDx1 / rLen1) * rightTrim, exitCorner[1] + (rDz1 / rLen1) * rightTrim];
      const rp2 = [exitCorner[0] + (rDx2 / rLen2) * rightTrim, exitCorner[1] + (rDz2 / rLen2) * rightTrim];
      const senbonRightFillet = [];
      for (let step = 0; step <= 12; step++) {
        const t = step / 12, u = 1 - t;
        senbonRightFillet.push([
          u * u * rp0[0] + 2 * u * t * exitCorner[0] + t * t * rp2[0],
          u * u * rp0[1] + 2 * u * t * exitCorner[1] + t * t * rp2[1],
        ]);
      }
      const middlePts = ebPts.length >= 4 ? ebPts.slice(1, -2) : ebPts.slice(1, -1);
      const oikeRawPoly = [
        ...cornerCurve,
        ...middlePts,
        ...senbonRightFillet,
      ];
      const oikeSamples = resample(oikeRawPoly, 2);
      const totalPrefixPts = prefixKeep.length;
      prefix.length = 0;
      for (let index = 0; index < prefixKeep.length; index++) {
        prefix.push({
          point: prefixKeep[index],
          rawS: rejoinRawS * (index / Math.max(1, centerline.length - 1)),
          overlay: "nijo-rotary",
        });
      }
      const oikeStartRawS = rejoinRawS * (totalPrefixPts / Math.max(1, centerline.length - 1));
      const joinRawS = senbonJoinIndex * 2;
      const oikeOverride = effectiveLaneOverride(oikePatch.eastboundWayId);
      const senbonSection = sectionAt(joinRawS);
      const oikeCum = [0];
      for (let k = 1; k < oikeSamples.length; k++) {
        oikeCum.push(oikeCum[k - 1] + distance(oikeSamples[k - 1], oikeSamples[k]));
      }
      const oikeTotal = oikeCum.at(-1) || 1;
      const oikeTail = oikeSamples.map((pt, idx) => {
        const frac = oikeCum[idx] / oikeTotal;
        const rawS = oikeStartRawS + (joinRawS - oikeStartRawS) * frac;
        const stillInRotary = idx < 8;
        // Once south of exitCorner heading into Senbon-dori, hand off to Senbon section
        const pastCorner = distance(pt, exitCorner) < distance(senbonTarget, exitCorner) && Math.abs(pt[0] - senbonTarget[0]) < 6 && pt[1] > exitCorner[1] + 5;
        return {
          point: pt,
          rawS,
          ...(stillInRotary ? { overlay: "nijo-rotary" } : {}),
          ...(!stillInRotary && oikeOverride && !pastCorner ? { sectionOverride: oikeOverride, sourceWayId: Number(oikePatch.eastboundWayId) } : (!stillInRotary ? { sectionOverride: senbonSection } : {})),
        };
      });
      afterRotary = [
        ...oikeTail,
        ...rawRoute.slice(senbonJoinIndex).map((point, index) => ({ point, rawS: (senbonJoinIndex + index) * 2 })),
      ];
    }
  }

  const source = [...prefix, ...afterRotary];
  const tail = inbound.points.at(-2);
  const end = inbound.points.at(-1);
  const tx = end[0] - tail[0], tz = end[1] - tail[1];
  const length = Math.hypot(tx, tz) || 1;
  const nx = -tz / length, nz = tx / length;
  const platformLateral = (firstPlatform[0] - end[0]) * nx + (firstPlatform[1] - end[1]) * nz;
  const busLateral = platformLateral - Math.sign(platformLateral || -1) * (BUS_HALF_WIDTH + 0.9);
  return { source, inbound, outbound, rejoin, centerline, busLateral };
}

function applyTerminusTurnaround(baseSource) {
  const turnarounds = PATCHES_TURNAROUNDS.TERMINUS_TURNAROUNDS ?? [];
  const ts = route.terminalStop;
  const stopX = Array.isArray(ts) ? Number(ts[0]) : Number(ts?.x);
  const stopZ = Array.isArray(ts) ? Number(ts[1]) : Number(ts?.z);
  if (!Number.isFinite(stopX) || !Number.isFinite(stopZ)) return baseSource;
  const terminalStopName = route.stops?.at(-1)?.name ?? null;
  const tailPt = baseSource.at(-1)?.point;
  const cfgTurn = turnarounds.find((item) => {
    if (item.stopName && terminalStopName && item.stopName !== terminalStopName) return false;
    const radius = Number(item.corridorRadiusM ?? 250);
    return !tailPt || Math.hypot(tailPt[0] - stopX, tailPt[1] - stopZ) <= radius;
  }) ?? null;
  if (!cfgTurn) return baseSource;

  const entryX = stopX + Number(cfgTurn.entryXOffsetM ?? 22.5);
  const approachZ = stopZ + Number(cfgTurn.approachZOffsetM ?? -4.5);
  const r1 = Number(cfgTurn.entryRadiusM ?? 7.0);
  const southTurnZ = stopZ + Number(cfgTurn.southTurnZOffsetM ?? 9.0);
  const r2 = Number(cfgTurn.loopRadiusM ?? 6.6);
  const stopLaneX = stopX + Number(cfgTurn.stopXOffsetM ?? 2.3);
  const stopEndZ = stopZ + Number(cfgTurn.stopEndZOffsetM ?? -1.5);

  const tailSearchStart = Math.max(0, baseSource.length - 120);
  let cutIndex = baseSource.length - 1;
  let bestDist = Infinity;
  for (let i = tailSearchStart; i < baseSource.length; i++) {
    const pt = baseSource[i].point;
    if (pt[0] < entryX - 0.5) continue;
    const d = Math.hypot(pt[0] - entryX, pt[1] - (approachZ - 2.0));
    if (d < bestDist) {
      bestDist = d;
      cutIndex = i;
    }
  }
  const trimmed = baseSource.slice(0, cutIndex + 1);
  const baseRawS = trimmed.at(-1)?.rawS ?? 0;

  const arcPoints = (cx, cz, radius, a0, a1, steps = 16) => {
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (a1 - a0) * (i / steps);
      out.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
    }
    return out;
  };
  const bayPolyline = [
    [entryX, approachZ],
    ...arcPoints(entryX, approachZ + r1, r1, -Math.PI / 2, -Math.PI, 16).slice(1),
    [stopLaneX + 2 * r2, southTurnZ],
    ...arcPoints(stopLaneX + r2, southTurnZ, r2, 0, Math.PI, 24).slice(1),
    [stopLaneX, stopEndZ],
  ];
  const baySamples = resample(bayPolyline, 2);
  const terminusSection = {
    lanes: 1,
    lanesF: 1,
    lanesB: 0,
    wL: 2.3,
    wR: 2.3,
    center: "none",
    oneWay: true,
    sidewalk: "none",
    overlay: "terminus-bay",
    source: "OSM terminus turnaround bay",
  };
  const cum = [0];
  for (let k = 1; k < baySamples.length; k++) {
    cum.push(cum[k - 1] + distance(baySamples[k - 1], baySamples[k]));
  }
  const bayTail = baySamples.map((pt, idx) => ({
    point: pt,
    rawS: +(baseRawS + cum[idx] + 2).toFixed(3),
    overlay: "terminus-bay",
    sectionOverride: terminusSection,
  }));
  return [...trimmed, ...bayTail];
}

const nijoRotary = nijoRotarySource();
const raw = applyTerminusTurnaround(
  nijoRotary?.source ?? rawRoute.map((point, index) => ({ point, rawS: index * 2 })),
);
const center = [];
let previousFeature = null;
for (let i = 0; i < raw.length; i++) {
  const sample = raw[i];
  if (sample.overlay === "nijo-rotary" || sample.overlay === "terminus-bay") {
    center.push({ rawS: sample.rawS, x: sample.point[0], z: sample.point[1], feature: { id: `osm-${sample.overlay}` }, overlay: sample.overlay });
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

// Precompute matched OSM way + section per sample, applying WAY_LANE_OVERRIDES cleanly
const osmWayIndex = (osmSource.roads ?? [])
  .filter((road) => road.points?.length >= 2 && PATCHES_ROADS.WAY_LANE_OVERRIDES?.[String(road.id)])
  .map((road) => {
    const xs = road.points.map((p) => p[0]);
    const zs = road.points.map((p) => p[1]);
    return {
      road,
      override: PATCHES_ROADS.WAY_LANE_OVERRIDES[String(road.id)],
      minX: Math.min(...xs) - 20,
      maxX: Math.max(...xs) + 20,
      minZ: Math.min(...zs) - 20,
      maxZ: Math.max(...zs) + 20,
    };
  });
function matchedOverrideAt(x, z, tx, tz) {
  let best = null;
  let bestScore = Infinity;
  for (const item of osmWayIndex) {
    if (x < item.minX || x > item.maxX || z < item.minZ || z > item.maxZ) continue;
    const pts = item.road.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const hit = nearestOnSegment(x, z, a, b);
      if (hit.distance > 16) continue;
      const rdx = b[0] - a[0], rdz = b[1] - a[1];
      const rlen = Math.hypot(rdx, rdz) || 1;
      const dot = Math.abs((rdx / rlen) * tx + (rdz / rlen) * tz);
      if (dot < 0.78) continue;
      const score = hit.distance + (1 - dot) * 10;
      if (score < bestScore) {
        bestScore = score;
        best = { wayId: Number(item.road.id), override: item.override };
      }
    }
  }
  return best;
}
const resolvedSectionRanges = (PATCHES_ROADS.SECTION_RANGE_OVERRIDES ?? []).map((ov) => {
  const afterStruct = (route.elevations ?? []).find((st) => st.name === ov.afterStructure);
  const untilWay = (osmSource.roads ?? []).find((r) => Number(r.id) === Number(ov.untilWayId));
  const afterRawS = afterStruct ? Number(afterStruct.to) : Number(ov.fromRawS ?? 0);
  let untilRawS = Number(ov.toRawS ?? Infinity);
  if (untilWay?.points?.length) {
    untilRawS = nearestPointIndex(rawRoute, untilWay.points[0]).index * 2;
  }
  return { ...ov, afterRawS, untilRawS };
}).filter((ov) => Number.isFinite(ov.afterRawS) && ov.untilRawS > ov.afterRawS);

const sampleSections = center.map((point, index) => {
  const sample = raw[index];
  if (sample.overlay === "nijo-rotary") {
    return {
      lanes: 2,
      lanesF: 2,
      lanesB: 0,
      wL: 7.2,
      wR: 0,
      center: "none",
      oneWay: true,
      source: "OSM Nijo Station West Exit rotary",
    };
  }
  const base = sectionAt(point.rawS);
  const onGradeSeparatedDeck = (route.elevations ?? []).some((structure) =>
    Number(structure.height) > 0
    && structure.profile === "single-crest"
    && point.rawS >= Number(structure.from)
    && point.rawS <= Number(structure.to),
  );
  if (sample.sectionOverride) {
    const ov = sample.sectionOverride;
    return {
      ...base,
      ...ov,
      lanes: (Number(ov.lanesF) || 1) + (Number(ov.lanesB) || 0),
    };
  }
  if (!onGradeSeparatedDeck) {
    const rangeOv = resolvedSectionRanges.find((ov) => point.rawS > ov.afterRawS && point.rawS < ov.untilRawS);
    if (rangeOv) {
      return {
        ...base,
        ...rangeOv,
        lanes: (Number(rangeOv.lanesF) || 1) + (Number(rangeOv.lanesB) || 0),
      };
    }
    const previous = center[Math.max(0, index - 1)], next = center[Math.min(center.length - 1, index + 1)];
    const dx = next.x - previous.x, dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    const match = matchedOverrideAt(point.x, point.z, dx / length, dz / length);
    if (match) {
      const ov = match.override;
      return {
        ...base,
        ...ov,
        lanes: (Number(ov.lanesF) || 1) + (Number(ov.lanesB) || 0),
      };
    }
  }
  return base;
});
const maxForwardLaneCount = Math.max(
  ...(route.roadSections ?? []).map((section) => Number(section.lanesF) || 1),
  ...Object.values(PATCHES_ROADS.WAY_LANE_OVERRIDES ?? {}).map((ov) => Number(ov.lanesF) || 1),
);
const maxBackwardLaneCount = Math.max(
  ...(route.roadSections ?? []).map((section) => Number(section.lanesB) || 0),
  ...Object.values(PATCHES_ROADS.WAY_LANE_OVERRIDES ?? {}).map((ov) => Number(ov.lanesB) || 0),
);
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
  const section = sampleSections[index];
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
  if (point.overlay === "terminus-bay") {
    active.forward[0] = true;
    offsets.forward[0] = 0;
    const halfW = Number(section?.wL) || 2.3;
    return { rawS: point.rawS, nx, nz, negativeWidth: halfW, positiveWidth: halfW, min: -halfW, max: halfW, centerShift: 0, isFlare: false, offsets, active, overlay: true, forwardCount, backwardCount };
  }
  if (point.overlay) {
    const outerSide = Math.sign(nijoRotary.busLateral || -1);
    for (let lane = 0; lane < forwardCount; lane++) {
      active.forward[lane] = true;
      offsets.forward[lane] = nijoRotary.busLateral - outerSide * LANE_WIDTH * lane;
    }
    const outer = nijoRotary.busLateral + outerSide * 1.6;
    const inner = nijoRotary.busLateral - outerSide * 4.8;
    return { rawS: point.rawS, nx, nz, min: Math.min(outer, inner), max: Math.max(outer, inner), centerShift: 0, isFlare: false, offsets, active, overlay: true, forwardCount, backwardCount };
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
  const isFlare = backwardCount > 0 && (
    (measuredMax - measuredMin) > (nominalNegative + nominalPositive + 10)
    || measuredNegative > nominalNegative + 8
    || measuredPositive > nominalPositive + 8
  );
  for (let lane = 0; lane < forwardCount; lane++) active.forward[lane] = true;
  for (let lane = 0; lane < backwardCount; lane++) active.reverse[lane] = true;
  return {
    rawS: point.rawS, nx, nz, measuredMin, measuredMax,
    negativeWidth, positiveWidth, centerShift, isFlare,
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
  const nonFlareIndices = nearbyIndices.filter((sampleIndex) => !physicalLaneRows[sampleIndex].isFlare);
  const centerIndices = nonFlareIndices.length ? nonFlareIndices : nearbyIndices;
  row.centerShift = clamp(median(centerIndices.map((sampleIndex) => rawCentreShifts[sampleIndex])), -3.5, 3.5);
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

// Smooth any station-overlay exit offset jump into the continuing road lane
// over a ~24 m taper so no sharp lateral kink occurs at the rotary exit.
const overlayEnd = physicalLaneRows.findIndex((row, index) => index > 0 && physicalLaneRows[index - 1].overlay && !row.overlay);
if (overlayEnd > 0) {
  const taperCount = Math.min(12, overlayEnd);
  const targetRow = physicalLaneRows[overlayEnd];
  const smoothstep01 = (t) => t * t * (3 - 2 * t);
  for (let k = 0; k < taperCount; k++) {
    const idx = overlayEnd - taperCount + k;
    const row = physicalLaneRows[idx];
    if (!row.overlay) continue;
    const w = smoothstep01((k + 1) / (taperCount + 1));
    for (let lane = 0; lane < row.forwardCount; lane++) {
      if (!row.active.forward[lane]) continue;
      const targetOff = targetRow.active.forward[lane]
        ? targetRow.offsets.forward[lane]
        : targetRow.offsets.forward[0];
      row.offsets.forward[lane] = row.offsets.forward[lane] * (1 - w) + targetOff * w;
    }
    const minOff = Math.min(...row.offsets.forward.filter((_, l) => row.active.forward[l]));
    const maxOff = Math.max(...row.offsets.forward.filter((_, l) => row.active.forward[l]));
    row.min = Math.min(row.min * (1 - w) + targetRow.min * w, minOff - (BUS_HALF_WIDTH + 0.35));
    row.max = Math.max(row.max * (1 - w) + targetRow.max * w, maxOff + (BUS_HALF_WIDTH + 0.35));
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

const BRIDGE_CONFIGS = PATCHES_STRUCTURES.BRIDGES ?? [];
const bridgeConfigByName = new Map();
for (const bridgeCfg of BRIDGE_CONFIGS) {
  if (bridgeCfg.name) bridgeConfigByName.set(bridgeCfg.name, bridgeCfg);
  if (bridgeCfg.flatDeckStructureName) bridgeConfigByName.set(bridgeCfg.flatDeckStructureName, bridgeCfg);
}
function bridgeExplicitRoad(bridgeCfg) {
  if (!bridgeCfg) return null;
  return (osmSource.roads ?? []).find((road) =>
    (bridgeCfg.wayId != null && Number(road.id) === Number(bridgeCfg.wayId))
    || (bridgeCfg.nameFallback && road.tags?.bridge === "yes" && road.tags?.name === bridgeCfg.nameFallback),
  ) ?? null;
}

function rawHitAtPoint(point) {
  let best = { distance2: Infinity, rawS: null, tangent: [0, 1] };
  for (let index = 1; index < nodes.length; index++) {
    const a = nodes[index - 1], b = nodes[index];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length2 = dx * dx + dz * dz || 1;
    const length = Math.sqrt(length2);
    const t = clamp(((point[0] - a.x) * dx + (point[1] - a.z) * dz) / length2, 0, 1);
    const x = a.x + dx * t, z = a.z + dz * t;
    const distance2 = (point[0] - x) ** 2 + (point[1] - z) ** 2;
    if (distance2 < best.distance2) best = { distance2, rawS: a.rawS + (b.rawS - a.rawS) * t, tangent: [dx / length, dz / length] };
  }
  return best;
}

const rawSAtPoint = (point) => rawHitAtPoint(point).rawS;

const explicitBridgeRanges = new Map();
const activeExplicitBridgeSidewalkIds = new Set();
for (const bridgeCfg of BRIDGE_CONFIGS) {
  const road = bridgeExplicitRoad(bridgeCfg);
  if (road?.points?.length >= 2) {
    const range = [rawSAtPoint(road.points[0]), rawSAtPoint(road.points.at(-1))].sort((a, b) => a - b);
    if (bridgeCfg.name) explicitBridgeRanges.set(bridgeCfg.name, range);
    if (bridgeCfg.flatDeckStructureName) explicitBridgeRanges.set(bridgeCfg.flatDeckStructureName, range);
    for (const id of bridgeCfg.sidewalkWayIds ?? []) activeExplicitBridgeSidewalkIds.add(String(id));
  }
}

function osmBridgeRawRangeFor(rawFrom, rawTo) {
  const from = Number(rawFrom), to = Number(rawTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const center = (from + to) / 2;
  const halfSpan = Math.max(15, (to - from) / 2) + 30;
  let best = null;
  for (const road of osmSource.roads ?? []) {
    if (road.tags?.bridge !== "yes") continue;
    if (["motorway", "motorway_link"].includes(road.tags?.highway)) continue;
    const pts = road.points ?? [];
    if (pts.length < 2) continue;
    const mid = pts[Math.floor(pts.length / 2)];
    const hit = rawHitAtPoint(mid);
    if (Math.sqrt(hit.distance2) > 10) continue;
    const dx = pts.at(-1)[0] - pts[0][0], dz = pts.at(-1)[1] - pts[0][1];
    const len = Math.hypot(dx, dz) || 1;
    const dot = Math.abs((dx / len) * hit.tangent[0] + (dz / len) * hit.tangent[1]);
    if (dot < 0.7) continue;
    if (Math.abs(hit.rawS - center) > halfSpan) continue;
    const [a, b] = [rawSAtPoint(pts[0]), rawSAtPoint(pts.at(-1))].sort((u, v) => u - v);
    if (b < from - 30 || a > to + 30) continue;
    const score = Math.sqrt(hit.distance2) + Math.abs((a + b) / 2 - center) * 0.25;
    if (!best || score < best.score) best = { score, range: [Math.min(from, a), Math.max(to, b)] };
  }
  return best?.range ?? null;
}

function resolvedStructure(structure) {
  const isFlatDeck = structure.profile === "flat-deck";
  const explicitRange = explicitBridgeRanges.get(structure.name) ?? null;
  const osmRange = isFlatDeck ? osmBridgeRawRangeFor(structure.from, structure.to) : null;
  const range = explicitRange ?? osmRange ?? [Number(structure.from), Number(structure.to)];
  const hasOsmSpan = isFlatDeck && Boolean(explicitRange || osmRange);
  return {
    ...structure,
    from: range[0],
    to: range[1],
    ...(hasOsmSpan ? { approachIn: 0, approachOut: 0 } : {}),
  };
}

const effectiveStructureApproaches = new Map();
for (const structure of route.elevations ?? []) {
  const resolved = resolvedStructure(structure);
  const from = Number(resolved.from), to = Number(resolved.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
  if (structure.profile === "flat-deck") {
    const bridgeCfg = bridgeConfigByName.get(resolved.name) ?? bridgeConfigByName.get(structure.name);
    const archHeight = bridgeCfg?.archHeight;
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
      const deckY = archHeight != null
        ? archedDeckElevation(baseTerrainAtRaw, from, to, node.rawS, Number(archHeight))
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
function sectionKey(sec) {
  return [
    Number(sec.lanesF) || 1,
    Number(sec.lanesB) || 0,
    sec.center ?? "line",
    sec.sidewalk ?? "",
    sec.bridge ?? 0,
    Boolean(sec.oneWay),
    sec.source ?? "",
    Number(sec.wL) || 4,
    Number(sec.wR) || 4,
  ].join("|");
}
function compiledSections() {
  if (!nodes.length) return [];
  const merged = [];
  let startIndex = 0;
  let current = sampleSections[0];
  let currentKey = sectionKey(current);
  for (let i = 1; i < nodes.length; i++) {
    const next = sampleSections[i];
    const nextKey = sectionKey(next);
    if (nextKey === currentKey) continue;
    merged.push({
      from: nodes[startIndex].s,
      to: nodes[i].s,
      lanes: (Number(current.lanesF) || 1) + (Number(current.lanesB) || 0),
      lanesF: Number(current.lanesF) || 1,
      lanesB: Number(current.lanesB) || 0,
      wL: Number(current.wL) || 4,
      wR: Number(current.wR) || 4,
      center: current.center ?? "line",
      ...(current.oneWay ? { oneWay: true } : {}),
      ...(current.sidewalk === "none" ? { sidewalk: "none" } : {}),
      ...(current.bridge ? { bridge: 1 } : {}),
      ...(current.source ? { source: current.source } : {}),
    });
    startIndex = i;
    current = next;
    currentKey = nextKey;
  }
  merged.push({
    from: nodes[startIndex].s,
    to: nodes.at(-1).s,
    lanes: (Number(current.lanesF) || 1) + (Number(current.lanesB) || 0),
    lanesF: Number(current.lanesF) || 1,
    lanesB: Number(current.lanesB) || 0,
    wL: Number(current.wL) || 4,
    wR: Number(current.wR) || 4,
    center: current.center ?? "line",
    ...(current.oneWay ? { oneWay: true } : {}),
    ...(current.sidewalk === "none" ? { sidewalk: "none" } : {}),
    ...(current.bridge ? { bridge: 1 } : {}),
    ...(current.source ? { source: current.source } : {}),
  });
  return merged;
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
  const laneWidth = LANE_WIDTH;
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
  const dividerEnd = Math.max(2, nijoRotary.centerline.length - 7);
  return {
    lanes: 2,
    oneWay: true,
    rows: rowsAt(outer, inner),
    laneDividerRows: rowsAt(divider - 0.06, divider + 0.06).slice(0, dividerEnd),
  };
}

// ---------------------------------------------------------------- traffic graph + OSM-derived road details

const GRAPH_ROAD_TYPES = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
  "residential", "living_street", "service",
]);
// 跨線橋の左右に並行する側道と高架コリドー交差道路を除外するための設定。
// 対象路線に該当跨線橋の elevation が含まれる場合のみ適用される。
const OVERPASS_CONFIGS = PATCHES_STRUCTURES.OVERPASSES ?? [];
const ACTIVE_OVERPASSES = OVERPASS_CONFIGS.map((ov) => {
  const elevation = (route.elevations ?? []).find((item) => item.name === ov.name) ?? null;
  return {
    ...ov,
    elevation,
    sideRoadWayIds: new Set((ov.sideRoadWayIds ?? []).map(Number)),
    maxDistance: Number(ov.corridor?.maxDistanceM ?? 18),
    minAlignment: Number(ov.corridor?.minAlignment ?? 0.82),
    networkRange: elevation ? { from: compiledS(elevation.from), to: compiledS(elevation.to) } : null,
  };
}).filter((ov) => ov.networkRange !== null);
const ACTIVE_OVERPASS_SIDE_ROAD_WAY_IDS = new Set(
  ACTIVE_OVERPASSES.flatMap((ov) => [...ov.sideRoadWayIds]),
);
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
function graphRoadCrossesOverpass(road) {
  if (!ACTIVE_OVERPASSES.length) return false;
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
      for (const ov of ACTIVE_OVERPASSES) {
        if (
          projection.s >= ov.networkRange.from
          && projection.s <= ov.networkRange.to
          && projection.distance < ov.maxDistance
          && alignment(projection) < ov.minAlignment
        ) return true;
      }
    }
  }
  return false;
}
function graphNodeOnOverpass(point) {
  if (!ACTIVE_OVERPASSES.length) return false;
  const projection = graphRouteProjection(point);
  return ACTIVE_OVERPASSES.some((ov) =>
    projection.distance < ov.maxDistance
    && projection.s >= ov.networkRange.from
    && projection.s <= ov.networkRange.to,
  );
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
  if (ACTIVE_OVERPASS_SIDE_ROAD_WAY_IDS.has(Number(road.id))) return false;
  // Expressways are grade-separated from the city street network.
  if (["motorway", "motorway_link"].includes(tags.highway)) return false;
  // Roads crossing the bridge corridor are ground-level roads below the
  // elevated overpass carriageway. They must not become graph edges or junction
  // openings for the bridge route.
  if (graphRoadCrossesOverpass(road)) return false;
  if (!GRAPH_ROAD_TYPES.has(tags.highway) || tags.area === "yes") return false;
  if (["no", "private"].includes(tags.access) || ["no", "private"].includes(tags.motor_vehicle)) return false;
  if (["no", "private"].includes(tags.vehicle)) return false;
  if (["driveway", "parking_aisle", "drive-through", "alley"].includes(tags.service)) return false;
  return (road.points?.length ?? 0) >= 2;
}
function graphLaneCounts(tags, direction, wayId = null, midPoint = null) {
  const override = wayId != null ? effectiveLaneOverride(wayId) : null;
  if (override) {
    if (override.oneWay) return Math.max(1, Number(override.lanesF) || 1);
    return Math.max(1, Number(direction > 0 ? override.lanesF : override.lanesB) || 1);
  }
  if (midPoint && resolvedSectionRanges.length) {
    const hit = rawHitAtPoint(midPoint);
    if (hit.distance2 < 18 * 18) {
      const rangeOv = resolvedSectionRanges.find((ov) => hit.rawS > ov.afterRawS && hit.rawS < ov.untilRawS);
      if (rangeOv) {
        if (rangeOv.oneWay) return Math.max(1, Number(rangeOv.lanesF) || 1);
        return Math.max(1, Number(direction > 0 ? rangeOv.lanesF : rangeOv.lanesB) || 1);
      }
    }
  }
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
    ? LANE_WIDTH * (laneIndex - (laneCount - 1) / 2)
    : LANE_WIDTH * (laneIndex + 0.5);
}
function graphSurfaceYAt(x, z, dirX = 0, dirZ = 0, proj = null) {
  const gy = gridHeight(x, z);
  const p = proj ?? projectToRouteCenter(x, z);
  if (!p) return gy;
  const dirLen = Math.hypot(dirX, dirZ);
  const align = dirLen > 1e-6 ? Math.abs((dirX / dirLen) * p.tx + (dirZ / dirLen) * p.tz) : 0;
  if (p.dist < 18 && align > 0.72) return p.y;
  if (p.dist < 16 && Math.abs(p.y - gy) < 0.6) return p.y;
  return gy;
}
function projectToRouteCenter(x, z) {
  let bestD2 = Infinity;
  let bestIdx = 0;
  let bestT = 0;
  let bestCx = 0;
  let bestCz = 0;
  for (let i = 0; i < roadCenter.length - 1; i++) {
    const a = roadCenter[i], b = roadCenter[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
    const cx = a.x + dx * t, cz = a.z + dz * t;
    const d2 = (x - cx) ** 2 + (z - cz) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIdx = i;
      bestT = t;
      bestCx = cx;
      bestCz = cz;
    }
  }
  const nA = nodes[bestIdx], nB = nodes[Math.min(nodes.length - 1, bestIdx + 1)];
  const pA = roadCenter[bestIdx], pB = roadCenter[Math.min(roadCenter.length - 1, bestIdx + 1)];
  const sdx = pB.x - pA.x, sdz = pB.z - pA.z;
  const slen = Math.hypot(sdx, sdz);
  const tx = slen > 1e-5 ? sdx / slen : Math.sin(nA.heading);
  const tz = slen > 1e-5 ? sdz / slen : Math.cos(nA.heading);
  const rx = -tz, rz = tx;
  const s = nA.s + (nB.s - nA.s) * bestT;
  const y = nA.y + (nB.y - nA.y) * bestT;
  const hA = nodes[Math.max(0, bestIdx - 4)].heading;
  const hB = nodes[Math.min(nodes.length - 1, bestIdx + 4)].heading;
  const isSharpTurn = Math.cos(hB - hA) < 0.92;
  const isTerminusBay = lane[bestIdx]?.overlay === "terminus-bay" || lane[Math.min(lane.length - 1, bestIdx + 1)]?.overlay === "terminus-bay";
  const section = sampleSections[bestIdx] ?? { lanesF: 1, lanesB: 1, wL: 4, wR: 4, oneWay: false };
  return {
    idx: bestIdx,
    t: bestT,
    dist: Math.sqrt(bestD2),
    s,
    cx: bestCx,
    cz: bestCz,
    y,
    tx,
    tz,
    rx,
    rz,
    isSharpTurn,
    isTerminusBay,
    section,
  };
}
function interpMainPath(tp, idx, t) {
  if (!tp?.points?.length || !tp.active?.length) return null;
  const i0 = clamp(idx, 0, tp.points.length - 1);
  const i1 = clamp(idx + 1, 0, tp.points.length - 1);
  if (tp.active[i0] && tp.active[i1]) {
    const a = tp.points[i0], b = tp.points[i1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  if (tp.active[i0] && t <= 0.5) return [...tp.points[i0]];
  if (tp.active[i1] && t > 0.5) return [...tp.points[i1]];
  return null;
}
function subdivideNearRoute(points, maxStep = 6.0, corridorDist = 22.0) {
  if (!Array.isArray(points) || points.length < 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (segLen > maxStep) {
      const mid = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
      const nearRoute = projectToRouteCenter(a[0], a[1]).dist < corridorDist
        || projectToRouteCenter(mid[0], mid[1]).dist < corridorDist
        || projectToRouteCenter(b[0], b[1]).dist < corridorDist;
      if (nearRoute) {
        const steps = Math.ceil(segLen / maxStep);
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
        continue;
      }
    }
    out.push(b);
  }
  return out;
}
function graphLanePoints(points, offset, alignContext = null) {
  let previousFeature = null;
  const rawTargets = [];
  const alignedShifts = [];
  const sharpTurnFlags = [];
  const tangents = [];
  const canAlignHighway = alignContext && !["service", "living_street"].includes(alignContext.highway);
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const length = Math.hypot(dx, dz) || 1;
    const tx = dx / length, tz = dz / length;
    tangents.push([tx, tz]);
    // x=east, z=south.  [dz, -dx] is the left-hand normal for the
    // oriented travel direction, matching Japan's left-side traffic.
    const rawCand = [points[i][0] + tz * offset, points[i][1] + (-dx / length) * offset];
    let alignedPt = null;
    let isSharpTurn = false;
    if (canAlignHighway) {
      const proj = projectToRouteCenter(points[i][0], points[i][1]);
      isSharpTurn = proj.isSharpTurn;
      const dot = tx * proj.tx + tz * proj.tz;
      const travelDir = dot >= 0 ? 1 : -1;
      const maxRouteCorridor = Math.min(5.8, Math.max(Number(proj.section.wL) || 4, Number(proj.section.wR) || 4) + 1.2);
      const secAllows = alignContext.oneway
        ? (travelDir === 1 && (Number(proj.section.lanesF) || 0) > 0)
        : (!proj.section.oneWay && (Number(proj.section.lanesB) || 0) > 0);
      const allowReverseSCurve = !alignContext.oneway && travelDir === -1 && Math.abs(dot) > 0.72 && proj.dist < 5.0;
      const straightOrReverseSCurve = (!proj.isSharpTurn && Math.abs(dot) > 0.88 && proj.dist < maxRouteCorridor) || allowReverseSCurve;
      if (!proj.isTerminusBay && straightOrReverseSCurve && secAllows) {
        if (travelDir === 1) {
          const mLane = (alignContext.laneCount - 1) - alignContext.lane;
          let targetPath = alignContext.mainForwardPaths[mLane];
          if (alignContext.oneway) {
            const activeSorted = alignContext.mainForwardPaths
              .filter((tp) => tp.active?.[proj.idx])
              .sort((a, b) => (a.laterals?.[proj.idx] ?? 0) - (b.laterals?.[proj.idx] ?? 0));
            if (activeSorted.length >= alignContext.laneCount) {
              targetPath = activeSorted[mLane];
            }
          }
          const mainPt = interpMainPath(targetPath, proj.idx, proj.t);
          if (mainPt) {
            alignedPt = mainPt;
          } else {
            const centerOff = alignContext.oneway
              ? LANE_WIDTH * ((alignContext.laneCount - 1) / 2 - alignContext.lane)
              : -LANE_WIDTH * (alignContext.lane + 0.5);
            alignedPt = [proj.cx + proj.rx * centerOff, proj.cz + proj.rz * centerOff];
          }
        } else {
          const mLane = alignContext.lane;
          const mainPt = interpMainPath(alignContext.mainReversePaths[mLane], proj.idx, proj.t);
          if (mainPt) {
            alignedPt = mainPt;
          } else if (mLane > 0) {
            const rev0 = interpMainPath(alignContext.mainReversePaths[0], proj.idx, proj.t);
            if (rev0) {
              alignedPt = [rev0[0] + proj.rx * (LANE_WIDTH * mLane), rev0[1] + proj.rz * (LANE_WIDTH * mLane)];
            } else {
              const centerOff = LANE_WIDTH * (alignContext.lane + 0.5);
              alignedPt = [proj.cx + proj.rx * centerOff, proj.cz + proj.rz * centerOff];
            }
          } else {
            const centerOff = LANE_WIDTH * (alignContext.lane + 0.5);
            alignedPt = [proj.cx + proj.rx * centerOff, proj.cz + proj.rz * centerOff];
          }
        }
      }
    }
    rawTargets.push({ rawCand, alignedPt });
    sharpTurnFlags.push(isSharpTurn);
    if (alignedPt) {
      const sx = alignedPt[0] - rawCand[0], sz = alignedPt[1] - rawCand[1];
      const smag = Math.hypot(sx, sz);
      if (smag <= 4.5) {
        alignedShifts.push([sx, sz]);
      } else {
        rawTargets[i].alignedPt = null;
        alignedShifts.push(null);
      }
    } else {
      alignedShifts.push(null);
    }
  }

  // Smooth corner-approach & S-curve carry-over: if an edge is predominantly aligned
  // with the compiled route, carry the nearest aligned lateral shift onto any remaining
  // unaligned end or S-curve gap vertices so approaches stay parallel into intersections
  // without hooking back into the bus path.
  const alignedCount = alignedShifts.filter(Boolean).length;
  if (alignedCount >= 1 && (alignedCount >= 2 || points.length <= 3) && alignedCount >= Math.floor(points.length * 0.35)) {
    for (let i = 0; i < points.length; i++) {
      if (rawTargets[i].alignedPt) continue;
      let nearestIdx = -1, nearestStep = Infinity;
      for (let j = 0; j < points.length; j++) {
        if (!alignedShifts[j]) continue;
        const step = Math.abs(j - i);
        if (step < nearestStep) { nearestStep = step; nearestIdx = j; }
      }
      if (nearestIdx >= 0 && nearestStep <= 6) {
        const [sx, sz] = alignedShifts[nearestIdx];
        const smag = Math.hypot(sx, sz);
        const scale = smag > 4.2 ? 4.2 / smag : 1;
        rawTargets[i].alignedPt = [
          rawTargets[i].rawCand[0] + sx * scale,
          rawTargets[i].rawCand[1] + sz * scale,
        ];
      }
    }
  }

  const result = [];
  let alignedUsed = 0;
  for (let i = 0; i < points.length; i++) {
    const { rawCand, alignedPt } = rawTargets[i];
    const [tx, tz] = tangents[i];
    let pt2d;
    if (alignedPt) {
      pt2d = alignedPt;
      alignedUsed++;
    } else {
      const hit = snapToSurface(rawCand[0], rawCand[1], previousFeature?.id);
      previousFeature = hit.feature;
      pt2d = hit.point;
    }
    const y = graphSurfaceYAt(pt2d[0], pt2d[1], tx, tz);
    result.push([+pt2d[0].toFixed(3), +y.toFixed(3), +pt2d[1].toFixed(3)]);
  }
  return { samples: result, aligned: alignedUsed > 0 };
}
function surfaceYAt(x, z) {
  let best = null;
  for (const node of nodes) {
    const d2 = (node.x - x) ** 2 + (node.z - z) ** 2;
    if (d2 < (best?.d2 ?? Infinity)) best = { d2, y: node.y };
  }
  return best && best.d2 < 16 * 16 ? best.y : gridHeight(x, z);
}
const BRIDGE_SIDEWALK_WAY_IDS = new Set(PATCHES_ROADS.BRIDGE_SIDEWALK_WAY_IDS ?? []);
// This short footway on the east side of Koeda Bridge duplicates the OSM
// zebra crossing with the same source way and should not be rendered as an
// elevated pedestrian bridge.
const REMOVED_OVERLAPPING_FOOTBRIDGE_WAY_IDS = new Set(PATCHES_ROADS.REMOVED_OVERLAPPING_FOOTBRIDGE_WAY_IDS ?? []);
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
function wrapGraphAngle(angle) {
  let result = angle;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
}
function trimPolyline2d(points, startTrim, endTrim) {
  if (!Array.isArray(points) || points.length < 2) return points;
  if (!(startTrim > 0) && !(endTrim > 0)) return points;
  const cum = graphCum(points);
  const total = cum.at(-1);
  if (!(total > 2.2)) return points;
  let s0 = Math.max(0, startTrim);
  let s1 = Math.max(0, endTrim);
  const maxTrimTotal = Math.max(0, total - Math.max(2.2, total * 0.45));
  if (s0 + s1 > maxTrimTotal) {
    if (maxTrimTotal <= 1e-6) return points;
    const scale = maxTrimTotal / (s0 + s1);
    s0 *= scale;
    s1 *= scale;
  }
  const endDist = total - s1;
  const out = [graphPointAt(points, cum, s0)];
  for (let i = 1; i < points.length - 1; i++) {
    if (cum[i] > s0 + 0.05 && cum[i] < endDist - 0.05) {
      out.push(points[i]);
    }
  }
  out.push(graphPointAt(points, cum, endDist));
  const deduped = [out[0]];
  for (let i = 1; i < out.length; i++) {
    if (graphDistance(deduped.at(-1), out[i]) > 1e-4) deduped.push(out[i]);
  }
  return deduped.length >= 2 ? deduped : points;
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
function graphConnectorGeometryValid(points, inVector, outVector, isTurn = false) {
  const segments = [];
  const segLengths = [];
  const samples = tessellateGraphConnector(points);
  for (let index = 1; index < samples.length; index++) {
    const dx = samples[index][0] - samples[index - 1][0];
    const dz = samples[index][2] - samples[index - 1][2];
    const length = Math.hypot(dx, dz);
    if (length > 1e-6) {
      segments.push([dx / length, dz / length]);
      segLengths.push(length);
    }
  }
  if (!segments.length) return false;
  if (segments[0][0] * inVector[0] + segments[0][1] * inVector[1] <= 0) return false;
  if (segments.at(-1)[0] * outVector[0] + segments.at(-1)[1] * outVector[1] <= 0) return false;
  let totalAbsTurn = 0;
  let maxSegBend = 0;
  let minRadius = Infinity;
  let prevH = Math.atan2(segments[0][0], segments[0][1]);
  for (let index = 1; index < segments.length; index++) {
    if (segments[index - 1][0] * segments[index][0] + segments[index - 1][1] * segments[index][1] <= 0) return false;
    const h = Math.atan2(segments[index][0], segments[index][1]);
    const dh = Math.abs(wrapGraphAngle(h - prevH));
    totalAbsTurn += dh;
    if (dh > maxSegBend) maxSegBend = dh;
    if (dh > 0.02) {
      const avgSeg = (segLengths[index - 1] + segLengths[index]) * 0.5;
      const r = avgSeg / dh;
      if (r < minRadius) minRadius = r;
    }
    prevH = h;
  }
  const inHeading = Math.atan2(inVector[0], inVector[1]);
  const outHeading = Math.atan2(outVector[0], outVector[1]);
  const netTurn = Math.abs(wrapGraphAngle(outHeading - inHeading));
  if (totalAbsTurn - netTurn > (30 * Math.PI) / 180) return false;
  if (totalAbsTurn > (155 * Math.PI) / 180) return false;
  if (maxSegBend > (30 * Math.PI) / 180) return false;
  if (minRadius < (isTurn ? 0.95 : 1.1)) return false;
  return true;
}
function buildTrafficGraph() {
  const mainForwardPaths = trafficPaths
    .filter((item) => item.role === "main" && item.direction === 1)
    .sort((a, b) => a.lane - b.lane);
  const mainReversePaths = trafficPaths
    .filter((item) => item.role === "main" && item.direction === -1)
    .sort((a, b) => a.lane - b.lane);
  const nearestBusSeg = (x, z) => {
    let bestD2 = Infinity;
    let bestHeading = 0;
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i], b = nodes[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
      const cx = a.x + dx * t, cz = a.z + dz * t;
      const d2 = (x - cx) ** 2 + (z - cz) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestHeading = Math.atan2(dx, dz);
      }
    }
    return { heading: bestHeading, dist: Math.sqrt(bestD2) };
  };
  const clearNonAlignedEndFromBus = (points, isStart) => {
    if (points.length < 2) return points;
    const ordered = isStart ? points : [...points].reverse();
    const cum = graphCum(ordered.map(([x, , z]) => [x, z]));
    const total = cum.at(-1);
    if (!(total > 2.3)) return points;
    const p0 = ordered[0];
    const p1 = ordered[Math.min(1, ordered.length - 1)];
    const edx = p1[0] - p0[0], edz = p1[2] - p0[2];
    const elen = Math.hypot(edx, edz) || 1;
    const hit0 = nearestBusSeg(p0[0], p0[2]);
    const btx = Math.sin(hit0.heading), btz = Math.cos(hit0.heading);
    const travelDirSign = isStart ? 1 : -1;
    const signedDot = travelDirSign * ((edx / elen) * btx + (edz / elen) * btz);
    const isIncomingCross = !isStart && Math.abs(signedDot) < 0.78;
    const minClear = isIncomingCross ? 4.6 : 2.65;
    const targetClear = isIncomingCross ? 4.9 : 2.8;
    if (hit0.dist >= minClear || signedDot >= 0.78) return points;
    const maxTrim = Math.min(isIncomingCross ? 7.5 : 5.0, total - 2.05);
    if (!(maxTrim > 0.2)) return points;
    let chosenDist = maxTrim;
    const sampleAtCum = (dist) => {
      let segIdx = 0;
      while (segIdx < cum.length - 2 && cum[segIdx + 1] < dist) segIdx++;
      const span = cum[segIdx + 1] - cum[segIdx] || 1;
      const t = clamp((dist - cum[segIdx]) / span, 0, 1);
      const a = ordered[segIdx], b = ordered[segIdx + 1];
      return [
        +(a[0] + (b[0] - a[0]) * t).toFixed(3),
        +(a[1] + (b[1] - a[1]) * t).toFixed(3),
        +(a[2] + (b[2] - a[2]) * t).toFixed(3),
      ];
    };
    for (let d = 0.25; d <= maxTrim + 1e-6; d += 0.25) {
      const dd = Math.min(d, maxTrim);
      const pt = sampleAtCum(dd);
      if (nearestBusSeg(pt[0], pt[2]).dist >= targetClear) {
        chosenDist = dd;
        break;
      }
    }
    const newStart = sampleAtCum(chosenDist);
    // Replace vertices strictly before chosenDist while preserving vertex count.
    let keepIdx = 1;
    while (keepIdx < cum.length - 1 && cum[keepIdx] <= chosenDist + 0.05) keepIdx++;
    const anchor = ordered[keepIdx];
    const out = ordered.map((pt, idx) => {
      if (idx === 0) return newStart;
      if (idx < keepIdx) {
        const frac = idx / keepIdx;
        return [
          +(newStart[0] + (anchor[0] - newStart[0]) * frac).toFixed(3),
          +(newStart[1] + (anchor[1] - newStart[1]) * frac).toFixed(3),
          +(newStart[2] + (anchor[2] - newStart[2]) * frac).toFixed(3),
        ];
      }
      return pt;
    });
    return isStart ? out : out.reverse();
  };
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
  const nodeTopology = new Map();
  const recordNodeTouch = (nodeKey, wayId, dirVec, totalLanes) => {
    let entry = nodeTopology.get(nodeKey);
    if (!entry) {
      entry = { wayIds: new Set(), dirs: [], maxLanes: 1 };
      nodeTopology.set(nodeKey, entry);
    }
    entry.wayIds.add(wayId);
    entry.dirs.push(dirVec);
    if (totalLanes > entry.maxLanes) entry.maxLanes = totalLanes;
  };
  const splitSegments = [];
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
      const midPt = segmentPoints[Math.floor(segmentPoints.length / 2)];
      const totalLanes = directions.length === 1
        ? graphLaneCounts(tags, directions[0], road.id, midPt)
        : graphLaneCounts(tags, 1, road.id, midPt) + graphLaneCounts(tags, -1, road.id, midPt);
      const startNodeId = nodeIds[start] ?? null;
      const endNodeId = nodeIds[end] ?? null;
      const fromKey = startNodeId != null
        ? `osm:${startNodeId}`
        : `point:${graphPointKey(segmentPoints[0])}`;
      const toKey = endNodeId != null
        ? `osm:${endNodeId}`
        : `point:${graphPointKey(segmentPoints.at(-1))}`;
      const startLen = Math.hypot(segmentPoints[1][0] - segmentPoints[0][0], segmentPoints[1][1] - segmentPoints[0][1]) || 1;
      const endLen = Math.hypot(segmentPoints.at(-2)[0] - segmentPoints.at(-1)[0], segmentPoints.at(-2)[1] - segmentPoints.at(-1)[1]) || 1;
      recordNodeTouch(fromKey, road.id, [(segmentPoints[1][0] - segmentPoints[0][0]) / startLen, (segmentPoints[1][1] - segmentPoints[0][1]) / startLen], totalLanes);
      recordNodeTouch(toKey, road.id, [(segmentPoints.at(-2)[0] - segmentPoints.at(-1)[0]) / endLen, (segmentPoints.at(-2)[1] - segmentPoints.at(-1)[1]) / endLen], totalLanes);
      splitSegments.push({ road, tags, segmentIndex, segmentPoints, startNodeId, endNodeId, fromKey, toKey, directions });
    }
  }
  const nodeTrimAmount = (nodeKey, point) => {
    const info = nodeTopology.get(nodeKey);
    if (!info) return 0;
    if (info.dirs.length >= 3) {
      if (graphNodeOnOverpass(point) && info.wayIds.size === 1) return 0;
      const baseTrim = clamp(info.maxLanes * 2.2, 4.0, 7.5);
      return projectToRouteCenter(point[0], point[1]).isSharpTurn ? clamp(baseTrim + 2.5, 6.5, 9.5) : baseTrim;
    }
    if (info.dirs.length === 2) {
      const dot = clamp(-(info.dirs[0][0] * info.dirs[1][0] + info.dirs[0][1] * info.dirs[1][1]), -1, 1);
      const bendAngle = Math.acos(dot);
      if (bendAngle > Math.PI / 15) return clamp(info.maxLanes * 1.5, 2.5, 4.5);
    }
    return 0;
  };
  const pointSnapsToPlateau = (x, z) => {
    const nearby = candidates(x, z).filter((f) => f.kind !== "sidewalk");
    if (nearby.some((f) => contains(f.points, x, z))) return true;
    return nearby.some((f) => nearestBoundary(f, x, z).distance <= SNAP_LIMIT);
  };
  const clipSegmentToPlateau = (points2d) => {
    if (points2d.length < 2) return null;
    if (points2d.every(([x, z]) => pointSnapsToPlateau(x, z))) {
      return { points: points2d, clippedStart: false, clippedEnd: false };
    }
    // Find contiguous runs of vertices inside PLATEAU coverage (interpolating edge crossings
    // at boundaries when adjacent vertices span inside <-> outside), keeping the run closest
    // to the route with length >= 8m.
    const runs = [];
    let cur = [];
    for (let i = 0; i < points2d.length; i++) {
      const pt = points2d[i];
      if (pointSnapsToPlateau(pt[0], pt[1])) {
        if (cur.length === 0 && i > 0) {
          // Binary search entry point along previous segment
          const prev = points2d[i - 1];
          let lo = 0, hi = 1;
          for (let iter = 0; iter < 6; iter++) {
            const m = (lo + hi) * 0.5;
            if (pointSnapsToPlateau(prev[0] + (pt[0] - prev[0]) * m, prev[1] + (pt[1] - prev[1]) * m)) hi = m;
            else lo = m;
          }
          cur.push([+(prev[0] + (pt[0] - prev[0]) * hi).toFixed(3), +(prev[1] + (pt[1] - prev[1]) * hi).toFixed(3)]);
        }
        cur.push(pt);
      } else if (cur.length > 0) {
        const prev = points2d[i - 1];
        let lo = 0, hi = 1;
        for (let iter = 0; iter < 6; iter++) {
          const m = (lo + hi) * 0.5;
          if (pointSnapsToPlateau(prev[0] + (pt[0] - prev[0]) * m, prev[1] + (pt[1] - prev[1]) * m)) lo = m;
          else hi = m;
        }
        const exitPt = [+(prev[0] + (pt[0] - prev[0]) * lo).toFixed(3), +(prev[1] + (pt[1] - prev[1]) * lo).toFixed(3)];
        if (graphDistance(cur.at(-1), exitPt) > 0.2) cur.push(exitPt);
        runs.push(cur);
        cur = [];
      }
    }
    if (cur.length > 0) runs.push(cur);
    const validRuns = runs
      .map((pts) => ({
        pts,
        len: graphCum(pts).at(-1),
        minRouteDist: Math.min(...pts.map(([x, z]) => projectToRouteCenter(x, z).dist)),
      }))
      .filter((r) => r.pts.length >= 2 && r.len >= 8)
      .sort((a, b) => a.minRouteDist - b.minRouteDist || b.len - a.len);
    if (!validRuns.length) return null;
    const chosen = validRuns[0].pts;
    return {
      points: chosen,
      clippedStart: !pointSnapsToPlateau(points2d[0][0], points2d[0][1]),
      clippedEnd: !pointSnapsToPlateau(points2d.at(-1)[0], points2d.at(-1)[1]),
    };
  };
  for (const seg of splitSegments) {
    const { road, tags, segmentIndex, segmentPoints, startNodeId, endNodeId, fromKey, toKey, directions } = seg;
    const clipped = clipSegmentToPlateau(segmentPoints);
    if (!clipped) continue;
    const effPoints = clipped.points;
    const effFromKey = clipped.clippedStart ? `point:${graphPointKey(effPoints[0])}` : fromKey;
    const effToKey = clipped.clippedEnd ? `point:${graphPointKey(effPoints.at(-1))}` : toKey;
    const effStartNodeId = clipped.clippedStart ? null : startNodeId;
    const effEndNodeId = clipped.clippedEnd ? null : endNodeId;
    const from = addNode(effPoints[0], effFromKey, effStartNodeId);
    const to = addNode(effPoints.at(-1), effToKey, effEndNodeId);
    const trimmedSegmentPoints = subdivideNearRoute(
      trimPolyline2d(
        effPoints,
        clipped.clippedStart ? 0 : nodeTrimAmount(effFromKey, effPoints[0]),
        clipped.clippedEnd ? 0 : nodeTrimAmount(effToKey, effPoints.at(-1)),
      ),
    );
    const midEffPt = trimmedSegmentPoints[Math.floor(trimmedSegmentPoints.length / 2)];
    for (const direction of directions) {
      const laneCount = graphLaneCounts(tags, direction, road.id, midEffPt);
      const oriented = direction > 0 ? trimmedSegmentPoints : [...trimmedSegmentPoints].reverse();
      for (let lane = 0; lane < laneCount; lane++) {
        let laneResult;
        try {
          laneResult = graphLanePoints(oriented, graphLaneOffset(tags, direction, lane, laneCount), {
            highway: tags.highway,
            oneway: directions.length === 1,
            lane,
            laneCount,
            mainForwardPaths,
            mainReversePaths,
          });
        } catch {
          continue;
        }
        let samples = laneResult.samples;
        if (!laneResult.aligned) {
          samples = clearNonAlignedEndFromBus(samples, true);
          samples = clearNonAlignedEndFromBus(samples, false);
        }
        const length = graphCum(samples.map(([x, , z]) => [x, z])).at(-1);
        if (!(length > 2)) continue;
        const maxJump = graphMaxHeadingJump(samples);
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
          sourceFromNode: direction > 0 ? effStartNodeId : effEndNodeId,
          sourceToNode: direction > 0 ? effEndNodeId : effStartNodeId,
          segmentIndex,
          routeAligned: laneResult.aligned,
          points: samples,
          length: +length.toFixed(3),
          physicsSafe: maxJump < Math.PI / 4,
          extremeFold: maxJump >= (135 * Math.PI) / 180,
          speed: Math.max(15, numberTag(tags.maxspeed, tags.highway === "service" ? 20 : 40)) / 3.6,
        };
        edges.push(edge);
        nodesByKey.get(edge.from).outgoing.push(id);
        nodesByKey.get(edge.to).incoming.push(id);
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
  for (const edge of edges) {
    if (edge.extremeFold) unsafeTwoWaySegments.add(`${edge.wayId}:${edge.segmentIndex}`);
    delete edge.extremeFold;
  }
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
  // Smoothly ramp elevation Y of off-route side-street/ramp edges where they meet
  // a node shared with higher route-level edges (e.g. embankment/levee side ramps).
  const nodeRefY = new Map();
  for (const edge of edges) {
    const checkEnd = (nid, pt) => {
      if (projectToRouteCenter(pt[0], pt[2]).dist > 15) return;
      const prev = nodeRefY.get(nid);
      if (prev == null || pt[1] > prev) nodeRefY.set(nid, pt[1]);
    };
    checkEnd(edge.from, edge.points[0]);
    checkEnd(edge.to, edge.points.at(-1));
  }
  for (const edge of edges) {
    const cum = graphCum(edge.points.map(([x, , z]) => [x, z]));
    const total = cum.at(-1);
    const fromTarget = nodeRefY.get(edge.from);
    if (fromTarget != null) {
      const dy = fromTarget - edge.points[0][1];
      if (dy > 0.25 && dy <= 3.5) {
        const rampDist = Math.min(28, total);
        for (let k = 0; k < edge.points.length; k++) {
          const d = cum[k];
          if (d <= rampDist) {
            const w = smoothstep(1 - d / Math.max(1e-6, rampDist));
            edge.points[k] = [edge.points[k][0], +(edge.points[k][1] + dy * w).toFixed(3), edge.points[k][2]];
          }
        }
      }
    }
    const toTarget = nodeRefY.get(edge.to);
    if (toTarget != null) {
      const dy = toTarget - edge.points.at(-1)[1];
      if (dy > 0.25 && dy <= 3.5) {
        const rampDist = Math.min(28, total);
        for (let k = 0; k < edge.points.length; k++) {
          const dFromEnd = total - cum[k];
          if (dFromEnd <= rampDist) {
            const w = smoothstep(1 - dFromEnd / Math.max(1e-6, rampDist));
            edge.points[k] = [edge.points[k][0], +(edge.points[k][1] + dy * w).toFixed(3), edge.points[k][2]];
          }
        }
      }
    }
    delete edge.routeAligned;
  }

  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const sourceSignals = osmSource.trafficSignals ?? [];
  const signalAt = (point) => sourceSignals.some((signal) => graphDistance(point, signal.point) < 14);
  // Pre-pass: stitch micro-gaps/lateral offsets at straight way/segment transitions
  // (up to 1.5m lateral/chord offset for collinear segments, <0.35m up to 30deg) so they
  // form clean zero-length connectors without creating backward loops.
  const stitchedEnds = new Set();
  const touchedEdges = new Set();
  for (const node of nodesByKey.values()) {
    node.signal = signalAt(node.point);
    for (const incomingId of node.incoming) for (const outgoingId of node.outgoing) {
      const incoming = edgeById.get(incomingId), outgoing = edgeById.get(outgoingId);
      if (!incoming || !outgoing || incoming.id === outgoing.id) continue;
      if (incoming.wayId === outgoing.wayId && incoming.direction !== outgoing.direction) continue;
      const inH = graphHeading(incoming.points.map(([x, , z]) => [x, z]), false);
      const outH = graphHeading(outgoing.points.map(([x, , z]) => [x, z]), true);
      let delta = outH - inH;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      if (Math.abs(delta) > Math.PI / 6) continue;
      if (outgoing.lane !== Math.min(incoming.lane, outgoing.laneCount - 1)) continue;
      const a = incoming.points.at(-1), b = outgoing.points[0];
      const chord = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const maxChord = Math.abs(delta) <= Math.PI / 10 ? 2.4 : 0.35;
      if (!(chord >= 1e-3 && chord < maxChord)) continue;
      const dx = b[0] - a[0], dz = b[2] - a[2];
      const alongGap = dx * Math.sin(inH) + dz * Math.cos(inH);
      if (chord >= 0.35 && Math.abs(alongGap) > 1.2) continue;
      if (stitchedEnds.has(`${incoming.id}:end`) || stitchedEnds.has(`${outgoing.id}:start`)) continue;
      const mid = [
        +((a[0] + b[0]) / 2).toFixed(3),
        +((a[1] + b[1]) / 2).toFixed(3),
        +((a[2] + b[2]) / 2).toFixed(3),
      ];
      incoming.points[incoming.points.length - 1] = [...mid];
      outgoing.points[0] = [...mid];
      stitchedEnds.add(`${incoming.id}:end`);
      stitchedEnds.add(`${outgoing.id}:start`);
      touchedEdges.add(incoming);
      touchedEdges.add(outgoing);
    }
  }
  for (const edge of touchedEdges) {
    edge.length = +graphCum(edge.points.map(([x, , z]) => [x, z])).at(-1).toFixed(3);
    edge.physicsSafe = graphMaxHeadingJump(edge.points) < Math.PI / 4;
  }

  const connectors = [];
  for (const node of nodesByKey.values()) {
    node.signal = signalAt(node.point);
    for (const incomingId of node.incoming) for (const outgoingId of node.outgoing) {
      const incoming = edgeById.get(incomingId), outgoing = edgeById.get(outgoingId);
      if (!incoming || !outgoing || incoming.id === outgoing.id) continue;
      if (incoming.wayId === outgoing.wayId && incoming.direction !== outgoing.direction) continue;
      const inHeading = graphHeading(incoming.points.map(([x, , z]) => [x, z]), false);
      const outHeading = graphHeading(outgoing.points.map(([x, , z]) => [x, z]), true);
      let delta = outHeading - inHeading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      // The elevated overpass carriageway may continue collinearly through its split
      // way nodes, but turns onto/from other ways on the overpass span are forbidden.
      if (graphNodeOnOverpass(node.point) && incoming.wayId !== outgoing.wayId && Math.abs(delta) > Math.PI / 6) continue;
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
      const dx = b[0] - a[0], dz = b[2] - a[2];
      if (!zeroLength && !isTurn) {
        if (dx * inVector[0] + dz * inVector[1] <= 0 || dx * outVector[0] + dz * outVector[1] <= 0) {
          continue;
        }
      }
      const makeBezier = (hA, hB) => {
        const cA = zeroLength
          ? [...a]
          : [a[0] + inVector[0] * hA, +(a[1] + (b[1] - a[1]) * 0.33).toFixed(3), a[2] + inVector[1] * hA];
        const cB = zeroLength
          ? [...b]
          : [b[0] - outVector[0] * hB, +(a[1] + (b[1] - a[1]) * 0.67).toFixed(3), b[2] - outVector[1] * hB];
        return [a, cA, cB, b];
      };
      let points = null;
      if (zeroLength) {
        points = makeBezier(0, 0);
      } else if (isTurn) {
        const candidatesHandles = [];
        const det = inVector[0] * outVector[1] - inVector[1] * outVector[0];
        if (Math.abs(det) > 1e-4) {
          const tA = (dx * outVector[1] - dz * outVector[0]) / det;
          const tB = (inVector[0] * dz - inVector[1] * dx) / det;
          if (tA > 0.3 && tB > 0.3 && tA < chord * 1.6 && tB < chord * 1.6) {
            candidatesHandles.push([
              clamp(tA * 0.5523, 0.4, chord * 0.75),
              clamp(tB * 0.5523, 0.4, chord * 0.75),
            ]);
          }
        }
        const dotIn = dx * inVector[0] + dz * inVector[1];
        const dotOut = dx * outVector[0] + dz * outVector[1];
        candidatesHandles.push(
          [clamp(chord * 0.35, 0.4, 3.5), clamp(chord * 0.35, 0.4, 3.5)],
          [clamp(chord * 0.25, 0.35, 3.0), clamp(chord * 0.25, 0.35, 3.0)],
          [clamp(dotIn * 0.45, 0.35, 4.5), clamp(dotOut * 0.45, 0.35, 4.5)],
          [clamp(chord * 0.45, 0.4, 4.5), clamp(chord * 0.2, 0.3, 2.5)],
          [clamp(chord * 0.2, 0.3, 2.5), clamp(chord * 0.45, 0.4, 4.5)],
          [clamp(chord * 0.18, 0.3, 2.0), clamp(chord * 0.18, 0.3, 2.0)],
        );
        for (const [hA, hB] of candidatesHandles) {
          const cand = makeBezier(hA, hB);
          if (graphConnectorGeometryValid(cand, inVector, outVector, true)) {
            points = cand;
            break;
          }
        }
      } else {
        const straightHandle = Math.min(chord * 0.35, 4.0);
        const cand = makeBezier(straightHandle, straightHandle);
        if (graphConnectorGeometryValid(cand, inVector, outVector, false)) points = cand;
      }
      if (!points) continue;
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
  const nearestPointAndTangent = (pt, points) => {
    let best = { point: points[0], tangent: [1, 0], distance: Infinity };
    for (let sIdx = 1; sIdx < points.length; sIdx++) {
      const p0 = points[sIdx - 1], p1 = points[sIdx];
      const hit = nearestOnSegment(pt[0], pt[1], p0, p1);
      if (hit.distance < best.distance) {
        const sdx = p1[0] - p0[0], sdz = p1[1] - p0[1];
        const slen = Math.hypot(sdx, sdz) || 1;
        best = { point: hit.point, tangent: [sdx / slen, sdz / slen], distance: hit.distance };
      }
    }
    return best;
  };
  for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
    const a = roads[i], b = roads[j];
    if (!usable(a) || !usable(b) || a.tags.name !== b.tags.name) continue;
    const key = `${a.id}:${b.id}`;
    if (paired.has(key)) continue;
    const ca = graphCum(a.points);
    const steps = Math.min(80, Math.max(4, Math.ceil(ca.at(-1) / 8)));
    const rows = [];
    for (let k = 0; k <= steps; k++) {
      const targetS = (ca.at(-1) * k) / steps;
      const pa = graphPointAt(a.points, ca, targetS);
      const paNext = graphPointAt(a.points, ca, Math.min(ca.at(-1), targetS + 0.5));
      const paPrev = graphPointAt(a.points, ca, Math.max(0, targetS - 0.5));
      const adx = paNext[0] - paPrev[0], adz = paNext[1] - paPrev[1];
      const alen = Math.hypot(adx, adz) || 1;
      const ta = [adx / alen, adz / alen];
      const near = nearestPointAndTangent(pa, b.points);
      const pb = near.point;
      const dx = pb[0] - pa[0], dz = pb[1] - pa[1];
      const distance = Math.hypot(dx, dz);
      if (distance < 5 || distance > 24) continue;
      // Pair points perpendicularly across the opposing carriageways rather than
      // linearly along the way, so unmatched intersection extensions do not skew
      // medians diagonally into a travel lane.
      if (ta[0] * near.tangent[0] + ta[1] * near.tangent[1] > -0.7) continue;
      if (Math.abs((dx * ta[0] + dz * ta[1]) / distance) > 0.35) continue;
      const wa = numberTag(a.tags.width, Math.max(1, numberTag(a.tags.lanes, 2)) * LANE_WIDTH) / 2;
      const wb = numberTag(b.tags.width, Math.max(1, numberTag(b.tags.lanes, 2)) * LANE_WIDTH) / 2;
      if (distance <= wa + wb + 0.7) continue;
      rows.push([
        [pa[0] + (dx / distance) * (wa + 0.2), surfaceYAt(pa[0], pa[1]), pa[1] + (dz / distance) * (wa + 0.2)],
        [pb[0] - (dx / distance) * (wb + 0.2), surfaceYAt(pb[0], pb[1]), pb[1] - (dz / distance) * (wb + 0.2)],
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
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const center = [(row[0][0] + row[1][0]) / 2, (row[0][2] + row[1][2]) / 2];
      const r0 = [row[0][0], row[0][2]];
      const r1 = [row[1][0], row[1][2]];
      const prevRow = rows[Math.max(0, ri - 1)];
      const nextRow = rows[Math.min(rows.length - 1, ri + 1)];
      const mDx = (nextRow[0][0] + nextRow[1][0] - prevRow[0][0] - prevRow[1][0]) * 0.5;
      const mDz = (nextRow[0][2] + nextRow[1][2] - prevRow[0][2] - prevRow[1][2]) * 0.5;
      const mLen = Math.hypot(mDx, mDz) || 1;
      const medTan = [mDx / mLen, mDz / mLen];
      const juncOpen = [center, r0, r1].some((pt) => junctionPoints.some((point) => graphDistance(point, pt) < 14));
      const routeOpen = [center, r0, r1].some((pt) => {
        const proj = projectToRouteCenter(pt[0], pt[1]);
        const crossDot = Math.abs(medTan[0] * proj.tx + medTan[1] * proj.tz);
        const roadHalf = Math.max(Number(proj.section?.wL) || 4, Number(proj.section?.wR) || 4);
        return crossDot < 0.7 && proj.dist < roadHalf + 3.5;
      });
      if (juncOpen || routeOpen) commit();
      else run.push(row);
    }
    commit();
  }
  const crosswalks = [];
  const crosswalkCenters = [];
  const crosswalkSegments = [];
  const segmentToSegmentDistance2d = (a, b, c, d) => {
    const ccw = (p1, p2, p3) => (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
    if (ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d)) return 0;
    return Math.min(
      nearestOnSegment(a[0], a[1], c, d).distance,
      nearestOnSegment(b[0], b[1], c, d).distance,
      nearestOnSegment(c[0], c[1], a, b).distance,
      nearestOnSegment(d[0], d[1], a, b).distance,
    );
  };
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
      let nearestNonServiceDist = Infinity;
      for (const road of roads) {
        const isService = road.tags?.highway === "service";
        for (let segment = 1; segment < road.points.length; segment++) {
          const ra = road.points[segment - 1], rb = road.points[segment];
          const hit = nearestOnSegment(midpoint[0], midpoint[1], ra, rb);
          if (!isService && hit.distance < nearestNonServiceDist) nearestNonServiceDist = hit.distance;
          if (!nearestRoad || hit.distance < nearestRoad.distance) {
            const rdx = rb[0] - ra[0], rdz = rb[1] - ra[1], rlength = Math.hypot(rdx, rdz) || 1;
            nearestRoad = { distance: hit.distance, tangent: [rdx / rlength, rdz / rlength] };
          }
        }
      }
      // Some OSM footways are tagged as crossings for their entire
      // longitudinal sidewalk run.  A zebra must cross the carriageway, so
      // discard segments that are effectively parallel to their nearest road,
      // or short sidewalk stubs far from any non-service road centerline.
      if (nearestRoad && Math.abs(ux * nearestRoad.tangent[0] + uz * nearestRoad.tangent[1]) > 0.85) return false;
      if (length < 5.0 && nearestNonServiceDist > 2.5) return false;
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
    crosswalkCenters.push(midpoint);
    crosswalkSegments.push({ a, b, midpoint, ux, uz, halfWidth: halfLong, source: metadata.source });
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
  const segmentsIntersect2d = (a, b, c, d) => {
    const ccw = (p1, p2, p3) => (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  };
  const nonServiceRoads = roads.filter((road) => road.tags?.highway !== "service");
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
    const baseS = compiledS(intersection.s);
    let frame = routePointAt(baseS);
    const section = sectionAt(intersection.s);
    const leftWidth = Number(section?.wL) || 7.2;
    const rightWidth = Number(section?.wR) || 7.2;
    const routeWidth = leftWidth + rightWidth;
    let crossroadWidth = Math.max(8, Number(intersection.width) || 8);
    let crossroadHalf = crossroadWidth / 2;
    // Detect divided (dual-carriageway) cross streets and span the full box across all carriageways.
    const carriageways = [];
    for (const road of nonServiceRoads) {
      if (road.tags?.name !== intersection.name) continue;
      const rpts = road.points ?? [];
      const halfW = Math.max(4, Math.min(14, numberTag(road.tags?.lanes, 2) * 1.75));
      for (let j = 1; j < rpts.length; j++) {
        const ra = rpts[j - 1], rb = rpts[j];
        const rdx = rb[0] - ra[0], rdz = rb[1] - ra[1];
        const rlen = Math.hypot(rdx, rdz);
        if (rlen < 0.5) continue;
        const dot = Math.abs(frame.tx * (rdx / rlen) + frame.tz * (rdz / rlen));
        if (dot >= 0.5) continue;
        const mx = (ra[0] + rb[0]) / 2 - frame.x;
        const mz = (ra[1] + rb[1]) / 2 - frame.z;
        const along = mx * frame.tx + mz * frame.tz;
        const lateral = mx * frame.nx + mz * frame.nz;
        if (Math.abs(along) <= 40 && Math.abs(lateral) <= 25) {
          carriageways.push({ along, halfW });
        }
      }
    }
    if (carriageways.length > 0) {
      const centerMin = Math.min(...carriageways.map((c) => c.along));
      const centerMax = Math.max(...carriageways.map((c) => c.along));
      if (centerMax - centerMin >= 8) {
        const minOff = Math.min(...carriageways.map((c) => c.along - c.halfW));
        const maxOff = Math.max(...carriageways.map((c) => c.along + c.halfW));
        frame = routePointAt(baseS + (minOff + maxOff) / 2);
        crossroadHalf = Math.max(crossroadHalf, (maxOff - minOff) / 2);
      }
    }
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
  for (const sidewalk of osmSource.sidewalks ?? []) {
    const points = sidewalk.points ?? [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const length = Math.hypot(dx, dz);
      if (length < 2.5 || length > 25) continue;
      const ux = dx / length, uz = dz / length;
      const midpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let crossesRoad = false;
      for (const road of nonServiceRoads) {
        const rpts = road.points ?? [];
        for (let j = 1; j < rpts.length; j++) {
          const c = rpts[j - 1], d = rpts[j];
          const rdx = d[0] - c[0], rdz = d[1] - c[1];
          const rlen = Math.hypot(rdx, rdz);
          if (rlen < 0.5) continue;
          const dot = Math.abs(ux * (rdx / rlen) + uz * (rdz / rlen));
          if (dot >= 0.55) continue;
          if (segmentsIntersect2d(a, b, c, d) || nearestOnSegment(midpoint[0], midpoint[1], c, d).distance <= 1.5) {
            crossesRoad = true;
            break;
          }
        }
        if (crossesRoad) break;
      }
      if (!crossesRoad) continue;
      if (crosswalkCenters.some((centerPt) => Math.hypot(centerPt[0] - midpoint[0], centerPt[1] - midpoint[1]) < 5.0)) continue;
      if (crosswalkSegments.some((seg) => segmentToSegmentDistance2d(a, b, seg.a, seg.b) <= seg.halfWidth + 0.8)) continue;
      if (crosswalkSegments.some((seg) => {
        if (seg.source !== "intersection") return false;
        const dist = Math.hypot(seg.midpoint[0] - midpoint[0], seg.midpoint[1] - midpoint[1]);
        const dot = Math.abs(ux * seg.ux + uz * seg.uz);
        return dist <= 14.0 && dot >= 0.8;
      })) continue;
      addCrosswalk(
        `crosswalk-sidewalk-${sidewalk.id}-${i}`,
        a,
        b,
        Math.max(3.0, numberTag(sidewalk.tags?.width, 4.0)),
        { source: "osm-sidewalk-crossing", sourceId: sidewalk.id },
        true,
      );
    }
  }
  const activeExtraCrosswalks = filterExtraCrosswalksForRoute(
    PATCHES_ROADS.EXTRA_CROSSWALKS ?? [],
    nodes.map((n) => [n.x, n.z]),
  );
  for (const patch of activeExtraCrosswalks) {
    addCrosswalk(
      patch.id,
      patch.a,
      patch.b,
      Number(patch.width) || 4.0,
      { source: "patch", intersection: patch.label },
      false,
    );
  }
  const pedestrianWays = osmSource.pedestrianWays ?? [];
  const nearCrosswalkMargin = (x, z, margin = 0.4) => {
    for (const cw of crosswalks) {
      for (const stripe of cw.stripes ?? []) {
        const poly = stripe.map((pt) => [pt[0], pt[2]]);
        if (poly.length >= 3 && contains(poly, x, z)) return true;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          if (nearestOnSegment(x, z, poly[j], poly[i]).distance <= margin) return true;
        }
      }
    }
    return false;
  };
  const trimRowsAtCrosswalks = (rows) => {
    let start = 0, end = rows.length - 1;
    const rowTouches = (row) => {
      const mx = (row[0][0] + row[1][0]) / 2, mz = (row[0][2] + row[1][2]) / 2;
      return nearCrosswalkMargin(mx, mz, 0.35)
        || nearCrosswalkMargin(row[0][0], row[0][2], 0.2)
        || nearCrosswalkMargin(row[1][0], row[1][2], 0.2);
    };
    while (start < end - 1 && rowTouches(rows[start])) start++;
    while (end > start + 1 && rowTouches(rows[end])) end--;
    return rows.slice(start, end + 1);
  };
  const resamplePoints2d = (points, maxStep = 3.0) => {
    if (!Array.isArray(points) || points.length < 2) return points ?? [];
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
  };
  const bridgeSidewalks = pedestrianWays
    .filter((way) => BRIDGE_SIDEWALK_WAY_IDS.has(Number(way.id)))
    .map((way) => {
      const points = resamplePoints2d(way.points ?? [], 3.0);
      const rawRows = sidewalkRows(points, numberTag(way.tags?.width, 2.0), surfaceYAt);
      const rows = trimRowsAtCrosswalks(rawRows);
      return {
        id: `sidewalk-${way.id}`,
        wayId: Number(way.id),
        width: numberTag(way.tags?.width, 2.0),
        rows,
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
      const isBridgeDeckSidewalk = activeExplicitBridgeSidewalkIds.has(String(way.id));
      const deckY = isBridgeDeckSidewalk ? null : Math.max(...points.map(([x, z]) => surfaceYAt(x, z))) + Number(PATCHES_ROADS.PEDESTRIAN_BRIDGE_CLEARANCE_M ?? 5.2);
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
          const pointDeckY = isBridgeDeckSidewalk ? ground : deckY;
          const y = steps ? ((aHigh ? pointDeckY : ground) * (1 - t) + (bHigh ? pointDeckY : ground) * t) : pointDeckY;
          return [x, y, z];
        }),
      };
    }).filter((item) => item.points.length >= 2);
  return { medians, crosswalks, footbridges, bridgeSidewalks };
}

function nearestNode(x, z, start = 0, filterFn = null) {
  let best = start, bestD2 = Infinity;
  for (let i = start; i < nodes.length; i++) {
    if (filterFn && !filterFn(i)) continue;
    const d2 = (nodes[i].x - x) ** 2 + (nodes[i].z - z) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return { index: best, distance: Math.sqrt(bestD2) };
}
let stopCursor = 0;
const hasTerminusBayNodes = lane.some((item) => item.overlay === "terminus-bay");
const routeSignalZones = (route.signals ?? [])
  .map(compiledRouteObject)
  .map((sig) => {
    const intMatch = (route.intersections ?? [])
      .map(compiledRouteObject)
      .filter((item) => Math.abs(item.s - sig.s) <= 18)
      .sort((a, b) => Math.abs(a.s - sig.s) - Math.abs(b.s - sig.s))[0];
    const halfCross = Math.max(4.0, Math.min(18.0, Number(intMatch?.width ?? 8) / 2));
    return { s: sig.s, halfCross };
  });
const stops = (route.stops ?? []).map((stop, stopIdx, stopArr) => {
  const [px, pz] = stop.platform ?? [0, 0];
  const isTerminal = stopIdx === stopArr.length - 1;
  let hit = isTerminal && hasTerminusBayNodes
    ? nearestNode(px, pz, stopCursor, (i) => lane[i]?.overlay === "terminus-bay")
    : nearestNode(px, pz, stopCursor);
  if (stopIdx > 0 && !isTerminal) {
    const node0 = nodes[hit.index];
    const overlapSig = routeSignalZones.find((sig) =>
      node0.s - 9.5 < sig.s + sig.halfCross + 1.5
      && node0.s + 1.5 > sig.s - sig.halfCross - 1.5
      && node0.s >= sig.s - sig.halfCross,
    );
    if (overlapSig) {
      const minClearS = overlapSig.s + overlapSig.halfCross + 11.5;
      const maxPlatS = node0.s + 18;
      let clearIdx = hit.index;
      while (clearIdx < nodes.length - 1 && nodes[clearIdx].s < minClearS) clearIdx++;
      if (nodes[clearIdx].s <= maxPlatS) {
        hit = {
          index: clearIdx,
          distance: Math.hypot(nodes[clearIdx].x - px, nodes[clearIdx].z - pz),
        };
      }
    }
  }
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

const sectionsList = compiledSections();
const trafficPaths = compiledTrafficPaths();
const trafficGraph = buildTrafficGraph();
const overpassNames = new Set(OVERPASS_CONFIGS.map((ov) => ov.name));
const crosswalkExclusions = (route.elevations ?? [])
  .filter((structure) => overpassNames.has(structure.name))
  .map((structure) => ({ from: compiledS(structure.from), to: compiledS(structure.to) }));
const roadOverlays = buildRoadOverlays(trafficGraph, crosswalkExclusions);

function compiledBridge(bridge) {
  const result = { ...compiledRouteObject(bridge) };
  const rawFrom = Number(bridge.s) - Number(bridge.length ?? 0) / 2;
  const rawTo = Number(bridge.s) + Number(bridge.length ?? 0) / 2;
  const explicitRange = explicitBridgeRanges.get(bridge.name) ?? null;
  const osmRange = explicitRange ?? osmBridgeRawRangeFor(rawFrom, rawTo);
  if (osmRange) {
    const from = compiledS(osmRange[0]);
    const to = compiledS(osmRange[1]);
    result.s = +((from + to) / 2).toFixed(3);
    result.length = +(to - from).toFixed(3);
  }
  return result;
}

function railEdgesForBridge(bridge) {
  const center = compiledBridge(bridge);
  const span = Number(center.length ?? 0);
  const from = Math.max(0, center.s - span / 2);
  const to = Math.min(nodes.at(-1).s, center.s + span / 2);
  const bridgeSec = sectionsList.find((item) => center.s >= item.from && center.s <= item.to) ?? sectionsList.at(-1);
  const samplePose = (s) => {
    let i = 0;
    while (i < nodes.length - 2 && nodes[i + 1].s < s) i++;
    const a = nodes[i], b = nodes[i + 1];
    const t = clamp((s - a.s) / Math.max(1e-6, b.s - a.s), 0, 1);
    const boundsA = driveBounds[i], boundsB = driveBounds[i + 1];
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const y = a.y + (b.y - a.y) * t;
    let dh = b.heading - a.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const heading = a.heading + dh * t;
    const nx = -Math.cos(heading), nz = Math.sin(heading);
    const left = boundsA.left + (boundsB.left - boundsA.left) * t;
    const right = boundsA.right + (boundsB.right - boundsA.right) * t;
    return { x, y, z, nx, nz, left, right };
  };
  let dividedLeft = null, dividedRight = null;
  if (bridgeSec?.oneWay || Number(bridgeSec?.lanesB) === 0) {
    const lExt = [], rExt = [];
    const innerFrom = from + span * 0.15, innerTo = to - span * 0.15;
    const step = Math.max(4, (innerTo - innerFrom) / 14);
    for (let s = innerFrom; s <= innerTo + 1e-6; s += step) {
      const sp = samplePose(Math.min(s, innerTo));
      lExt.push(corridorSurfaceExtent({ x: sp.x, z: sp.z, overlay: false }, sp.nx, sp.nz, -1));
      rExt.push(corridorSurfaceExtent({ x: sp.x, z: sp.z, overlay: false }, sp.nx, sp.nz, 1));
    }
    if (lExt.length && rExt.length) {
      dividedLeft = Math.max(2.0, median(lExt) - 0.2);
      dividedRight = Math.max(2.0, median(rExt) - 0.2);
    }
  }
  const at = (s) => {
    const sp = samplePose(s);
    const left = dividedLeft != null ? Math.max(sp.left, dividedLeft) : sp.left;
    const right = dividedRight != null ? Math.max(sp.right, dividedRight) : sp.right;
    return {
      left: [+(sp.x - sp.nx * left).toFixed(3), +sp.y.toFixed(3), +(sp.z - sp.nz * left).toFixed(3)],
      right: [+(sp.x + sp.nx * right).toFixed(3), +sp.y.toFixed(3), +(sp.z + sp.nz * right).toFixed(3)],
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

const withinAnyOverpass = (s) => Number.isFinite(Number(s)) && ACTIVE_OVERPASSES.some((ov) =>
  Number(s) >= ov.networkRange.from - 1e-6
  && Number(s) <= ov.networkRange.to + 1e-6,
);
const crossesAnyOverpass = (item) => withinAnyOverpass(item.s)
  || withinAnyOverpass(item.sIn)
  || withinAnyOverpass(item.sOut)
  || ACTIVE_OVERPASSES.some((ov) =>
    Number(item.sIn) < ov.networkRange.to
    && Number(item.sOut) > ov.networkRange.from,
  );
const compiledIntersections = (route.intersections ?? [])
  .map(compiledRouteObject)
  .filter((item) => !withinAnyOverpass(item.s));
const compiledTurnIntersections = (route.turnIntersections ?? [])
  .map(compiledRouteObject)
  .filter((item) => !crossesAnyOverpass(item));

function routeStateAt(s) {
  const maxS = nodes.at(-1)?.s ?? 0;
  const clamped = clamp(s, 0, maxS);
  let i = 0;
  while (i < nodes.length - 2 && nodes[i + 1].s < clamped) i++;
  const a = nodes[i], b = nodes[i + 1] ?? a;
  const seg = Math.max(1e-6, b.s - a.s);
  const t = clamp((clamped - a.s) / seg, 0, 1);
  let dh = b.heading - a.heading;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  const heading = a.heading + dh * t;
  const tx = Math.sin(heading), tz = Math.cos(heading);
  const rx = -tz, rz = tx;
  const ba = driveBounds[i] ?? { left: 2, right: 4 };
  const bb = driveBounds[i + 1] ?? ba;
  const sec = sectionsList.find((item) => clamped >= item.from && clamped <= item.to) ?? sectionsList.at(-1);
  return {
    index: i,
    s: clamped,
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    heading,
    tx,
    tz,
    rx,
    rz,
    left: ba.left + (bb.left - ba.left) * t,
    right: ba.right + (bb.right - ba.right) * t,
    section: sec,
  };
}

function isInsideCarriageway(x, z, centerS) {
  const minS = centerS - 45, maxS = centerS + 45;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.s < minS || n.s > maxS) continue;
    const tx = Math.sin(n.heading), tz = Math.cos(n.heading);
    const rx = -tz, rz = tx;
    const dx = x - n.x, dz = z - n.z;
    const along = dx * tx + dz * tz;
    if (Math.abs(along) > 2.6) continue;
    const lat = dx * rx + dz * rz;
    const bounds = driveBounds[i] ?? { left: 2, right: 4 };
    if (lat >= -(bounds.left + 0.75) && lat <= bounds.right + 0.75) return true;
  }
  for (const tp of trafficPaths) {
    if (tp.role !== "main" || !tp.points?.length) continue;
    for (let i = 0; i < tp.points.length; i++) {
      if (tp.active && !tp.active[i]) continue;
      if (Math.abs((nodes[i]?.s ?? 0) - centerS) > 45) continue;
      const pt = tp.points[i];
      if (Math.hypot(x - pt[0], z - pt[1]) < 2.4) return true;
    }
  }
  for (const edge of trafficGraph?.edges ?? []) {
    const pts = edge.points ?? [];
    for (let i = 1; i < pts.length; i++) {
      const a = [pts[i - 1][0], pts[i - 1][2]], b = [pts[i][0], pts[i][2]];
      if (Math.max(a[0], b[0]) < x - 4 || Math.min(a[0], b[0]) > x + 4) continue;
      if (Math.max(a[1], b[1]) < z - 4 || Math.min(a[1], b[1]) > z + 4) continue;
      if (nearestOnSegment(x, z, a, b).distance < 2.8) return true;
    }
  }
  for (const cw of roadOverlays?.crosswalks ?? []) {
    if (Math.abs((cw.routeS ?? 0) - centerS) > 55) continue;
    for (const stripe of cw.stripes ?? []) {
      const poly = stripe.map((pt) => [pt[0], pt[2]]);
      if (poly.length >= 3 && contains(poly, x, z)) return true;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        if (nearestOnSegment(x, z, poly[j], poly[i]).distance < 0.9) return true;
      }
    }
  }
  return false;
}

const longitudinalSidewalkIndex = (() => {
  const nonServiceRoads = (osmSource.roads ?? []).filter((r) => r.points?.length >= 2 && r.tags?.highway !== "service");
  const segmentsIntersect2d = (a, b, c, d) => {
    const ccw = (p1, p2, p3) => (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  };
  const items = [];
  for (const sw of osmSource.sidewalks ?? []) {
    const pts = sw.points ?? [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.5) continue;
      if (len >= 2.5 && len <= 25) {
        const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const crosses = nonServiceRoads.some((rd) => {
          for (let j = 1; j < rd.points.length; j++) {
            const c = rd.points[j - 1], d = rd.points[j];
            const rlen = Math.hypot(d[0] - c[0], d[1] - c[1]);
            if (rlen < 0.5) continue;
            if (Math.abs(ux * ((d[0] - c[0]) / rlen) + uz * ((d[1] - c[1]) / rlen)) >= 0.55) continue;
            if (segmentsIntersect2d(a, b, c, d) || nearestOnSegment(mid[0], mid[1], c, d).distance <= 1.5) return true;
          }
          return false;
        });
        if (crosses) continue;
      }
      const halfW = Math.max(1.0, numberTag(sw.tags?.width, 2.5) / 2);
      items.push({
        a, b, halfW,
        minX: Math.min(a[0], b[0]) - halfW - 1,
        maxX: Math.max(a[0], b[0]) + halfW + 1,
        minZ: Math.min(a[1], b[1]) - halfW - 1,
        maxZ: Math.max(a[1], b[1]) + halfW + 1,
      });
    }
  }
  return items;
})();

const onPlateauRoad = (x, z) => candidates(x, z)
  .some((feature) => feature.kind !== "sidewalk" && contains(feature.points, x, z));

function isRoadsideVergeOrSidewalk(x, z) {
  if (!onPlateauRoad(x, z)) return true;
  for (const seg of longitudinalSidewalkIndex) {
    if (x < seg.minX || x > seg.maxX || z < seg.minZ || z > seg.maxZ) continue;
    if (nearestOnSegment(x, z, seg.a, seg.b).distance <= seg.halfW) return true;
  }
  return false;
}

function clearPolePosition(px, pz, outDx, outDz, centerS, options = {}) {
  const { maxAngle = Math.PI * 0.55, maxRadius = 22, requireSidewalk = false } = options;
  const len = Math.hypot(outDx, outDz) || 1;
  const ux = outDx / len, uz = outDz / len;
  // Pass 1: step straight outward looking for a non-carriageway sidewalk / off-road spot
  for (let step = 0; step <= 18; step += 0.5) {
    const cx = px + ux * step;
    const cz = pz + uz * step;
    if (!isInsideCarriageway(cx, cz, centerS) && isRoadsideVergeOrSidewalk(cx, cz)) {
      return [+cx.toFixed(2), +cz.toFixed(2)];
    }
  }
  // Pass 2: local outward sector search within angle limit
  let best = null;
  for (let r = 1; r <= maxRadius; r += 1.5) {
    for (let angle = -maxAngle; angle <= maxAngle + 1e-6; angle += Math.PI / 12) {
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const vx = ux * cos - uz * sin, vz = ux * sin + uz * cos;
      const cx = px + vx * r, cz = pz + vz * r;
      if (!isInsideCarriageway(cx, cz, centerS) && isRoadsideVergeOrSidewalk(cx, cz)) {
        const d2 = (cx - px) ** 2 + (cz - pz) ** 2;
        if (!best || d2 < best.d2) best = { d2, pt: [+cx.toFixed(2), +cz.toFixed(2)] };
      }
    }
    if (best) return best.pt;
  }
  if (requireSidewalk) return null;
  // Pass 3: fallback to non-carriageway clearance only
  for (let step = 0; step <= 24; step += 0.5) {
    const cx = px + ux * step;
    const cz = pz + uz * step;
    if (!isInsideCarriageway(cx, cz, centerS)) {
      return [+cx.toFixed(2), +cz.toFixed(2)];
    }
  }
  return null;
}

function opposingLaneOffsetAt(s, fallbackRight) {
  const rev = trafficPaths.find((item) => item.id === "main-reverse-lane-0");
  if (!rev?.points?.length) return Math.max(2.2, fallbackRight * 0.5);
  let i = 0;
  while (i < nodes.length - 2 && nodes[i + 1].s < s) i++;
  if (rev.active && !rev.active[i]) return Math.max(2.2, fallbackRight * 0.5);
  const n = nodes[i];
  const rx = -Math.cos(n.heading), rz = Math.sin(n.heading);
  const pt = rev.points[i];
  const lat = (pt[0] - n.x) * rx + (pt[1] - n.z) * rz;
  return lat > 1.0 ? lat : Math.max(2.2, fallbackRight * 0.5);
}

function compileSignalHeads(sig) {
  let s = sig.s;
  const approxCenter = routeStateAt(s);
  // If an OSM traffic_signals node lies within 28 m along the compiled route,
  // refine s so the signal and stop line track the real intersection center.
  let bestOsmSig = null;
  for (const os of osmSource.trafficSignals ?? []) {
    const pt = os.point ?? [os.x, os.z];
    if (!Number.isFinite(pt?.[0]) || !Number.isFinite(pt?.[1])) continue;
    const d = Math.hypot(pt[0] - approxCenter.x, pt[1] - approxCenter.z);
    if (d <= 28 && (!bestOsmSig || d < bestOsmSig.d)) bestOsmSig = { pt, d };
  }
  if (bestOsmSig) {
    let bestIdx = approxCenter.index;
    let bestD2 = Infinity;
    for (let i = Math.max(0, approxCenter.index - 22); i <= Math.min(nodes.length - 1, approxCenter.index + 22); i++) {
      const d2 = (nodes[i].x - bestOsmSig.pt[0]) ** 2 + (nodes[i].z - bestOsmSig.pt[1]) ** 2;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestD2 < 12 * 12) s = nodes[bestIdx].s;
  }

  const matchedTurn = compiledTurnIntersections
    .filter((item) => Math.abs(item.s - s) <= 22)
    .sort((a, b) => Math.abs(a.s - s) - Math.abs(b.s - s))[0] ?? null;
  const matchedInt = compiledIntersections
    .filter((item) => Math.abs(item.s - s) <= 18)
    .sort((a, b) => Math.abs(a.s - s) - Math.abs(b.s - s))[0] ?? null;
  const halfCross = Math.max(4.0, Math.min(18.0, Number(matchedInt?.width ?? matchedTurn?.crossWidth ?? 8) / 2));

  // Sample approach orientation strictly before any turn apex, while placing the
  // signal gantry on the far side of the intersection so drivers waiting at the
  // stop line (s - 9 m) see the lights directly ahead over their lane.
  const entryS = matchedTurn
    ? Math.min(s - 6.0, matchedTurn.sIn)
    : s - Math.min(15.0, halfCross + 1.5);
  const entry = routeStateAt(entryS);
  const centerFrame = routeStateAt(s);
  const farOffset = halfCross + 1.5;
  const mainHead = [
    +(centerFrame.x + entry.tx * farOffset).toFixed(2),
    +(centerFrame.z + entry.tz * farOffset).toFixed(2),
  ];

  const exitS = matchedTurn
    ? Math.max(s + 6.0, matchedTurn.sOut)
    : s + Math.min(15.0, halfCross + 1.5);
  const exit = routeStateAt(exitS);
  const heads = [];
  const mainPole = clearPolePosition(
    mainHead[0] - entry.rx * (centerFrame.left + 1.4),
    mainHead[1] - entry.rz * (centerFrame.left + 1.4),
    -entry.rx,
    -entry.rz,
    s,
    { maxAngle: Math.PI / 6, maxRadius: 15 },
  ) ?? clearPolePosition(
    mainHead[0] - entry.rx * (centerFrame.left + 1.4),
    mainHead[1] - entry.rz * (centerFrame.left + 1.4),
    entry.tx - entry.rx,
    entry.tz - entry.rz,
    s,
    { maxAngle: Math.PI / 4, maxRadius: 18 },
  ) ?? clearPolePosition(
    mainHead[0] + entry.rx * (centerFrame.right + 1.4),
    mainHead[1] + entry.rz * (centerFrame.right + 1.4),
    entry.rx,
    entry.rz,
    s,
    { maxAngle: Math.PI / 4, maxRadius: 15 },
  ) ?? [+(mainHead[0] - entry.rx * (centerFrame.left + 1.4)).toFixed(2), +(mainHead[1] - entry.rz * (centerFrame.left + 1.4)).toFixed(2)];
  heads.push({
    kind: "main",
    face: +entry.heading.toFixed(4),
    pole: mainPole,
    head: mainHead,
    arm: 1,
    hoods: 1,
  });

  // Opposing main head on two-way roads, also mounted on its far side
  if ((exit.section?.lanesB ?? 0) > 0) {
    const revLat = opposingLaneOffsetAt(exit.s, exit.right);
    const oppHead = [
      +(centerFrame.x - exit.tx * farOffset + exit.rx * revLat).toFixed(2),
      +(centerFrame.z - exit.tz * farOffset + exit.rz * revLat).toFixed(2),
    ];
    const oppPole = clearPolePosition(
      centerFrame.x - exit.tx * farOffset + exit.rx * (exit.right + 1.4),
      centerFrame.z - exit.tz * farOffset + exit.rz * (exit.right + 1.4),
      exit.rx,
      exit.rz,
      s,
      { maxAngle: Math.PI / 6, maxRadius: 15 },
    );
    if (oppPole) {
      let oppFace = exit.heading + Math.PI;
      while (oppFace > Math.PI) oppFace -= 2 * Math.PI;
      heads.push({
        kind: "main",
        face: +oppFace.toFixed(4),
        pole: oppPole,
        head: oppHead,
        arm: 1,
      });
    }
  }

  // Cross-road corner signal heads cleared outside the carriageway
  const crossHeading = Number.isFinite(Number(matchedInt?.heading))
    ? Number(matchedInt.heading)
    : entry.heading + Math.PI / 2;
  const arms = matchedInt?.arms?.length
    ? matchedInt.arms.filter((arm) => arm.exists).map((arm) => arm.side)
    : [1, -1];
  for (const side of arms) {
    const baseLat = side < 0 ? -(centerFrame.left + 1.8) : centerFrame.right + 1.8;
    const rawCornerX = centerFrame.x + centerFrame.rx * baseLat - side * entry.tx * (halfCross + 1.5);
    const rawCornerZ = centerFrame.z + centerFrame.rz * baseLat - side * entry.tz * (halfCross + 1.5);
    const outDx = rawCornerX - centerFrame.x;
    const outDz = rawCornerZ - centerFrame.z;
    const crossPole = clearPolePosition(rawCornerX, rawCornerZ, outDx, outDz, s, {
      maxAngle: Math.PI * 0.65,
      maxRadius: 24,
      requireSidewalk: true,
    });
    if (!crossPole) continue;
    let crossFace = crossHeading + (side > 0 ? Math.PI : 0);
    while (crossFace > Math.PI) crossFace -= 2 * Math.PI;
    while (crossFace < -Math.PI) crossFace += 2 * Math.PI;
    const fx = Math.sin(crossFace), fz = Math.cos(crossFace);
    heads.push({
      kind: "cross",
      face: +crossFace.toFixed(4),
      pole: crossPole,
      head: [+(crossPole[0] + fx * 0.6).toFixed(2), +(crossPole[1] + fz * 0.6).toFixed(2)],
    });
  }

  return {
    s,
    name: sig.name,
    heads,
  };
}

const compiledSignals = (route.signals ?? [])
  .map(compiledRouteObject)
  .filter((item) => !withinAnyOverpass(item.s))
  .map(compileSignalHeads);

// Build generic painted white stop lines (main route, opposing lanes, and
// signalized graph approaches) and multi-lane divider polylines for opposite or
// cross-street graph carriageways not covered by main trafficPaths.
function buildStopLinesAndDividers() {
  const stopLines = [];
  const mainStopLines = [];
  const routeCws = (roadOverlays.crosswalks ?? []).filter((cw) => cw.routeDistance < 12);
  const stopBarHalfThick = 0.225;
  const surfaceCenterAt = (s) => {
    const clamped = clamp(s, 0, nodes.at(-1)?.s ?? 0);
    let i = 0;
    while (i < nodes.length - 2 && nodes[i + 1].s < clamped) i++;
    const a = nodes[i], b = nodes[i + 1] ?? a;
    const t = clamp((clamped - a.s) / Math.max(1e-6, b.s - a.s), 0, 1);
    const spA = roadCenter[i], spB = roadCenter[i + 1] ?? spA;
    let dh = b.heading - a.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const heading = a.heading + dh * t;
    const tx = Math.sin(heading), tz = Math.cos(heading);
    const nx = -tz, nz = tx;
    const nodeFrame = routeStateAt(clamped);
    // Lateral bounds expressed relative to surfacePath (sp)
    const busLatFromSp = (nodeFrame.x - (spA.x + (spB.x - spA.x) * t)) * nx
      + (nodeFrame.z - (spA.z + (spB.z - spA.z) * t)) * nz;
    return {
      cx: spA.x + (spB.x - spA.x) * t,
      cz: spA.z + (spB.z - spA.z) * t,
      y: a.y + (b.y - a.y) * t,
      tx,
      tz,
      nx,
      nz,
      minLatSp: busLatFromSp - nodeFrame.left,
      maxLatSp: busLatFromSp + nodeFrame.right,
      section: nodeFrame.section,
    };
  };
  const makeBarQuad = (cx, cz, tx, tz, nx, nz, latA, latB) => {
    const [la, lb] = latA < latB ? [latA, latB] : [latB, latA];
    if (lb - la < 1.2) return null;
    const pts = [
      [cx + nx * la - tx * stopBarHalfThick, cz + nz * la - tz * stopBarHalfThick],
      [cx + nx * lb - tx * stopBarHalfThick, cz + nz * lb - tz * stopBarHalfThick],
      [cx + nx * lb + tx * stopBarHalfThick, cz + nz * lb + tz * stopBarHalfThick],
      [cx + nx * la + tx * stopBarHalfThick, cz + nz * la + tz * stopBarHalfThick],
    ];
    return pts.map(([x, z]) => [+x.toFixed(3), +surfaceYAt(x, z).toFixed(3), +z.toFixed(3)]);
  };

  for (let i = 0; i < compiledSignals.length; i++) {
    const sig = compiledSignals[i];
    const matchedInt = compiledIntersections
      .filter((item) => Math.abs(item.s - sig.s) <= 18)
      .sort((a, b) => Math.abs(a.s - sig.s) - Math.abs(b.s - sig.s))[0] ?? null;
    const matchedTurn = compiledTurnIntersections
      .filter((item) => Math.abs(item.s - sig.s) <= 22)
      .sort((a, b) => Math.abs(a.s - sig.s) - Math.abs(b.s - sig.s))[0] ?? null;
    const halfCross = Math.max(4.0, Math.min(18.0, Number(matchedInt?.width ?? matchedTurn?.crossWidth ?? 8) / 2));
    const approachCws = routeCws
      .filter((cw) => cw.routeS < sig.s - 1.5 && cw.routeS >= sig.s - 28)
      .sort((a, b) => b.routeS - a.routeS);
    let stopS = sig.s - 9.0;
    if (approachCws.length) {
      stopS = Math.min(stopS, approachCws[0].routeS - 3.6);
    } else if (halfCross > 5.5) {
      stopS = Math.min(stopS, sig.s - (halfCross + 3.5));
    }
    stopS = clamp(stopS, Math.max(2, sig.s - 26), Math.max(2, sig.s - 5.5));
    sig.stopLineS = +stopS.toFixed(3);

    const frame = surfaceCenterAt(stopS);
    const twoWay = !frame.section?.oneWay && (frame.section?.lanesB ?? 0) > 0;
    const fwdLeft = Math.max(frame.minLatSp + 0.25, -Math.max(Number(frame.section?.wL) || 4, frame.minLatSp * -1) + 0.25);
    const fwdRight = twoWay ? -0.18 : frame.maxLatSp - 0.25;
    const fwdQuad = makeBarQuad(frame.cx, frame.cz, frame.tx, frame.tz, frame.nx, frame.nz, fwdLeft, fwdRight);
    if (fwdQuad) {
      const barCenter = [
        (fwdQuad[0][0] + fwdQuad[2][0]) / 2,
        (fwdQuad[0][2] + fwdQuad[2][2]) / 2,
      ];
      stopLines.push({ id: `stop-line-route-${i}`, kind: "route", routeS: +stopS.toFixed(3), quad: fwdQuad });
      mainStopLines.push({ pt: barCenter, dir: [frame.tx, frame.tz] });
    }

    if (twoWay) {
      const farCws = routeCws
        .filter((cw) => cw.routeS > sig.s + 1.5 && cw.routeS <= sig.s + 28)
        .sort((a, b) => a.routeS - b.routeS);
      let oppS = sig.s + 9.0;
      if (farCws.length) oppS = Math.max(oppS, farCws[0].routeS + 3.6);
      else if (halfCross > 5.5) oppS = Math.max(oppS, sig.s + (halfCross + 3.5));
      oppS = clamp(oppS, sig.s + 5.5, Math.min(nodes.at(-1).s - 2, sig.s + 26));
      const oppFrame = surfaceCenterAt(oppS);
      if (!oppFrame.section?.oneWay && (oppFrame.section?.lanesB ?? 0) > 0) {
        const oppQuad = makeBarQuad(oppFrame.cx, oppFrame.cz, oppFrame.tx, oppFrame.tz, oppFrame.nx, oppFrame.nz, 0.18, oppFrame.maxLatSp - 0.25);
        if (oppQuad) {
          const oppCenter = [
            (oppQuad[0][0] + oppQuad[2][0]) / 2,
            (oppQuad[0][2] + oppQuad[2][2]) / 2,
          ];
          stopLines.push({ id: `stop-line-opp-${i}`, kind: "route-opposing", routeS: +oppS.toFixed(3), quad: oppQuad });
          mainStopLines.push({ pt: oppCenter, dir: [-oppFrame.tx, -oppFrame.tz] });
        }
      }
    }
  }

  // Signalized graph edge stop lines (cross streets & separated carriageways)
  const graphNodeById = new Map((trafficGraph.nodes ?? []).map((n) => [n.id, n]));
  const sigEdgeGroups = new Map();
  for (const edge of trafficGraph.edges ?? []) {
    const toNode = graphNodeById.get(edge.to);
    if (!toNode?.signal || edge.length < 8 || edge.highway === "service") continue;
    const gk = `${edge.wayId}:${edge.segmentIndex}:${edge.direction}:${edge.to}`;
    if (!sigEdgeGroups.has(gk)) sigEdgeGroups.set(gk, []);
    sigEdgeGroups.get(gk).push(edge);
  }
  let gIdx = 0;
  for (const groupEdges of sigEdgeGroups.values()) {
    groupEdges.sort((a, b) => a.lane - b.lane);
    const refEdge = groupEdges[Math.floor(groupEdges.length / 2)];
    const pts = refEdge.points ?? [];
    if (pts.length < 2) continue;
    const pPrev = pts.at(-2), pEnd = pts.at(-1);
    const edx = pEnd[0] - pPrev[0], edz = pEnd[2] - pPrev[2];
    const elen = Math.hypot(edx, edz) || 1;
    const tx = edx / elen, tz = edz / elen;
    const nx = -tz, nz = tx;
    const cx = pEnd[0] - tx * 1.2, cz = pEnd[2] - tz * 1.2;
    if (mainStopLines.some((m) =>
      Math.hypot(m.pt[0] - cx, m.pt[1] - cz) < 12
      && m.dir[0] * tx + m.dir[1] * tz > 0.7
    )) continue;
    const lats = groupEdges.map((e) => {
      const ep = e.points.at(-1);
      return (ep[0] - cx) * nx + (ep[2] - cz) * nz;
    });
    const latA = Math.min(...lats) - LANE_WIDTH * 0.44;
    const latB = Math.max(...lats) + LANE_WIDTH * 0.44;
    const quad = makeBarQuad(cx, cz, tx, tz, nx, nz, latA, latB);
    if (quad) {
      stopLines.push({ id: `stop-line-graph-${gIdx++}`, kind: "graph", quad });
    }
  }

  // Multi-lane divider polylines for opposite separated carriageways (e.g. Kujo-dori EB)
  // and major cross streets not already covered by main trafficPaths.
  const mainTpSections = compiledSections();
  const sectionHasMainDivider = (s, dirSign) => {
    const sec = mainTpSections.find((item) => s >= item.from && s < item.to) ?? mainTpSections.at(-1);
    return dirSign > 0 ? (sec?.lanesF ?? 1) > 1 : (sec?.lanesB ?? 0) > 1;
  };
  const multiLaneGroups = new Map();
  for (const edge of trafficGraph.edges ?? []) {
    if ((edge.laneCount ?? 1) < 2 || edge.length < 12) continue;
    const gk = `${edge.wayId}:${edge.segmentIndex}:${edge.direction}`;
    if (!multiLaneGroups.has(gk)) multiLaneGroups.set(gk, []);
    multiLaneGroups.get(gk).push(edge);
  }
  const graphLaneDividers = [];
  for (const [gk, groupEdges] of multiLaneGroups) {
    groupEdges.sort((a, b) => a.lane - b.lane);
    if (groupEdges.length < 2) continue;
    const refMid = groupEdges[0].points[Math.floor(groupEdges[0].points.length / 2)];
    const refPrev = groupEdges[0].points[0], refLast = groupEdges[0].points.at(-1);
    const rdx = refLast[0] - refPrev[0], rdz = refLast[2] - refPrev[2];
    const rlen = Math.hypot(rdx, rdz) || 1;
    // Check if this group overlaps the bus carriageway where main trafficPaths already draw its divider
    let nearMain = false;
    let bestD = Infinity, bestS = 0, bestDot = 0;
    for (let i = 0; i < roadCenter.length; i += 2) {
      const d = Math.hypot(roadCenter[i].x - refMid[0], roadCenter[i].z - refMid[2]);
      if (d < bestD) {
        bestD = d;
        bestS = nodes[i].s;
        bestDot = (rdx / rlen) * Math.sin(nodes[i].heading) + (rdz / rlen) * Math.cos(nodes[i].heading);
      }
    }
    if (bestD < 7.5 && Math.abs(bestDot) > 0.75 && sectionHasMainDivider(bestS, bestDot > 0 ? 1 : -1)) {
      nearMain = true;
    }
    if (nearMain) continue;
    for (let l = 0; l < groupEdges.length - 1; l++) {
      const ea = groupEdges[l], eb = groupEdges[l + 1];
      if (eb.lane !== ea.lane + 1) continue;
      const ca = graphCum(ea.points.map(([x, , z]) => [x, z]));
      const cb = graphCum(eb.points.map(([x, , z]) => [x, z]));
      const total = Math.min(ca.at(-1), cb.at(-1));
      if (total < 10) continue;
      const divPts = [];
      for (let d = 0; ; d += 2) {
        const dd = Math.min(d, total);
        const pa = graphPointAt(ea.points.map(([x, , z]) => [x, z]), ca, dd);
        const pb = graphPointAt(eb.points.map(([x, , z]) => [x, z]), cb, dd);
        const mx = (pa[0] + pb[0]) / 2, mz = (pa[1] + pb[1]) / 2;
        divPts.push([+mx.toFixed(3), +surfaceYAt(mx, mz).toFixed(3), +mz.toFixed(3)]);
        if (dd >= total) break;
      }
      if (divPts.length >= 2) {
        graphLaneDividers.push({ id: `div-${gk}-${l}`, points: divPts });
      }
    }
  }
  return { stopLines, graphLaneDividers };
}
const extraMarkings = buildStopLinesAndDividers();
roadOverlays.stopLines = extraMarkings.stopLines;
roadOverlays.graphLaneDividers = extraMarkings.graphLaneDividers;
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
  if (structure.profile === "flat-deck") {
    delete result.height;
    const ids = [...new Set(
      nodes
        .filter((n) => n.surfaceId && n.s >= result.from && n.s <= result.to)
        .map((n) => String(n.surfaceId).replace(/#.*$/, "")),
    )];
    if (ids.length) result.sourceFeatureIds = ids;
  }
  return result;
}

function compiledAutoLaneGuides() {
  const mainForward = trafficPaths
    .filter((item) => item.role === "main" && item.direction === 1)
    .sort((a, b) => a.lane - b.lane);
  const guides = [];
  for (const cfgGuide of route.autoLaneGuides ?? ctx.route.autoLaneGuides ?? []) {
    const anchorStop = cfgGuide.fromStop ? stops.find((st) => st.name === cfgGuide.fromStop) : null;
    if (cfgGuide.fromStop && !anchorStop) continue;
    const baseS = anchorStop ? anchorStop.s : 0;
    const fromS = +(baseS + Number(cfgGuide.fromOffsetM ?? 0)).toFixed(3);
    const holdFromS = +(baseS + Number(cfgGuide.holdFromOffsetM ?? 0)).toFixed(3);
    const holdToS = +(baseS + Number(cfgGuide.holdToOffsetM ?? 0)).toFixed(3);
    const toS = +(baseS + Number(cfgGuide.toOffsetM ?? 0)).toFixed(3);
    if (!(toS > holdToS && holdToS >= holdFromS && holdFromS >= fromS)) continue;
    const samples = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.s < holdFromS - 2 || n.s > holdToS + 2) continue;
      // Sort active forward lanes strictly left-to-right by their physical lateral coordinate
      // (one-way roads in physicalLaneRows may order lane indices around centerShift).
      const activeLats = mainForward
        .filter((tp) => tp.active?.[i] && Number.isFinite(tp.laterals?.[i]))
        .map((tp) => tp.laterals[i])
        .sort((a, b) => a - b);
      let lat = 0;
      if (activeLats.length) {
        lat = cfgGuide.target === "rightmost"
          ? activeLats.at(-1)
          : activeLats[Math.min(Math.max(0, Number(cfgGuide.laneIndex) || 0), activeLats.length - 1)];
      }
      samples.push([+n.s.toFixed(3), +lat.toFixed(3)]);
    }
    if (!samples.length) continue;
    guides.push({
      label: cfgGuide.label ?? "guide",
      fromS,
      holdFromS,
      holdToS,
      toS,
      samples,
    });
  }
  return guides;
}
const autoLaneGuides = compiledAutoLaneGuides();

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
  autoLaneGuides,
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
writeJson(outputFile, network, { compact: true });
console.log(JSON.stringify({ status: "driving-network-ok", output: outputFile, nodes: nodes.length, stops: stops.length, surfaces: network.selectedSurfaceIds.length, surfacePatches: surfacePatches.length }, null, 2));
