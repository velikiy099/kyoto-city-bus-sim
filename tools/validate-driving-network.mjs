#!/usr/bin/env node
import fs from "node:fs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const assert = (value, message) => { if (!value) throw new Error(message); };
const network = read("src/data/generated/driving-network.json");
const transport = read("public/world/generated/plateau-transportation.json");
const omiyaOverpassSideRoadWayIds = new Set([
  27574722, 27574729, 27574731,
  27904454,
  290407940, 290407941, 290407942, 290407943,
]);

const roadPolygons = (transport.features ?? [])
  .filter((feature) => ["road", "lane", "intersection"].includes(feature.kind))
  .map((feature) => feature.polygon.map(([x, , z]) => [x, z]));
const generatedPatchPolygons = (network.surfacePatches ?? [])
  .filter((patch) => (patch.rows?.length ?? 0) >= 2)
  .map((patch) => [
    ...patch.rows.map((row) => [row[0][0], row[0][2]]),
    ...patch.rows.slice().reverse().map((row) => [row[1][0], row[1][2]]),
  ]);
const driveSurfacePolygons = [...roadPolygons, ...generatedPatchPolygons];
const contains = (polygon, x, z) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
const covered = (x, z) => driveSurfacePolygons.some((polygon) => contains(polygon, x, z));
const boundarySegmentDistance = (x, z, a, b) => {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
};
const coveredOrBoundary = (x, z) => covered(x, z) || driveSurfacePolygons.some((polygon) =>
  polygon.some((point, index) => boundarySegmentDistance(x, z, point, polygon[(index + 1) % polygon.length]) < 0.05),
);

assert(network.version >= 2, "Compiled driving-network is missing");
assert(network.nodes.length > 5000, "Driving-network has insufficient route samples");
const mainTrafficPaths = network.trafficPaths?.filter((item) => item.role === "main") ?? [];
assert(mainTrafficPaths.some((item) => item.direction === 1) && mainTrafficPaths.some((item) => item.direction === -1), "Both directions of main traffic paths were not compiled");
assert(mainTrafficPaths.every((item) => item.points.length === network.nodes.length && item.distances?.length === network.nodes.length && item.laterals?.length === network.nodes.length), "Main traffic lane samples are incomplete");
assert(mainTrafficPaths.every((item) => item.active?.length === network.nodes.length), "Main traffic lane activity masks are incomplete");
const canonicalForward = mainTrafficPaths.find((item) => item.id === "main-forward-lane-0");
assert(canonicalForward, "Canonical bus/shared forward lane is missing");
assert(canonicalForward.points.every(([x, z], index) => x === network.nodes[index].x && z === network.nodes[index].z), "Self-driving path and shared NPC lane diverged");
const sectionAt = (s) => network.sections.find((section) => s >= section.from - 1e-6 && s < section.to - 1e-6) ?? network.sections.at(-1);
let activeLaneMisses = 0;
for (const item of mainTrafficPaths) {
  for (let index = 0; index < network.nodes.length; index++) {
    if (!item.active[index]) continue;
    if (!coveredOrBoundary(...item.points[index])) activeLaneMisses++;
    const section = sectionAt(network.nodes[index].s);
    const expected = item.direction > 0 ? section.lanesF : section.lanesB;
    assert(item.lane < expected, `Inactive lane was marked active: ${item.id} @ ${network.nodes[index].s}`);
  }
}
assert(activeLaneMisses === 0, `Active traffic lanes leave the compiled driving surface (${activeLaneMisses} samples)`);
let minimumSameDirectionSeparation = Infinity;
let minimumOpposingSeparation = Infinity;
for (let index = 0; index < network.nodes.length; index++) {
  const active = mainTrafficPaths.filter((item) => item.active[index]);
  for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
    const separation = Math.hypot(
      active[a].points[index][0] - active[b].points[index][0],
      active[a].points[index][1] - active[b].points[index][1],
    );
    if (active[a].direction === active[b].direction) minimumSameDirectionSeparation = Math.min(minimumSameDirectionSeparation, separation);
    else minimumOpposingSeparation = Math.min(minimumOpposingSeparation, separation);
  }
}
assert(minimumSameDirectionSeparation > 1.75, `Same-direction lane centres overlap (${minimumSameDirectionSeparation.toFixed(3)}m)`);
assert(minimumOpposingSeparation > 1.85, `Opposing lane centres overlap (${minimumOpposingSeparation.toFixed(3)}m)`);
assert(mainTrafficPaths.some((item) => item.laterals?.some((lateral) => Math.abs(lateral) > 2)), "Main traffic lanes still coincide with the bus path");
assert(network.trafficPaths?.some((item) => item.role === "merge"), "Connecting-road traffic paths were not compiled");
assert(network.trafficGraph?.edges?.length > 500, "Unified OSM traffic graph was not compiled");
assert(network.trafficGraph?.connectors?.length > 100, "Traffic graph junction connectors are missing");
assert(network.trafficGraph.branchMeters === 250, "Traffic graph branch extent is not 250m");
assert(
  network.trafficGraph.edges.every((edge) => !omiyaOverpassSideRoadWayIds.has(Number(edge.wayId))),
  "NPC traffic graph still includes Omiya overpass side-road edges",
);
assert(
  network.trafficGraph.connectors.every((connector) => typeof connector.turn === "boolean"),
  "Traffic graph connectors are missing explicit turn classification",
);
assert(
  network.trafficGraph.connectors.every((connector) => connector.turnDirection !== "uturn"),
  "U-turn connectors remain in the NPC traffic graph",
);
const kujoEdges = network.trafficGraph.edges.filter((edge) => String(edge.name).includes("九条"));
assert(kujoEdges.length >= 2 && kujoEdges.every((edge) => edge.oneway), "Kujo dual one-way carriageways are not preserved");
const kujoStart = network.stops.find((stop) => stop.name === "九条大宮")?.s;
const kujoEnd = network.stops.find((stop) => stop.name === "羅城門")?.s;
const kujoWestboundEdges = network.trafficGraph.edges.filter((edge) =>
  edge.direction === 1 && [968070112, 968070111].includes(edge.wayId),
);
const pointSegmentDistance = (x, z, a, b) => {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - (a[0] + dx * t), z - (a[2] + dz * t));
};
const polylineDistance = (x, z, points) => Math.min(
  ...points.slice(1).map((point, index) => pointSegmentDistance(x, z, points[index], point)),
);
for (const name of ["御池通", "四条通", "五条通", "七条通"]) {
  const intersection = network.intersections.find((item) => item.name === name);
  assert(intersection, `${name} intersection is missing from the compiled route`);
  const routeNode = network.nodes.reduce((best, node) => Math.abs(node.s - intersection.s) < Math.abs(best.s - intersection.s) ? node : best, network.nodes[0]);
  const nearbyNodes = network.trafficGraph.nodes.filter((node) => Math.hypot(node.point[0] - routeNode.x, node.point[1] - routeNode.z) < 20);
  const connector = network.trafficGraph.connectors.find((item) => nearbyNodes.some((node) => node.id === item.node)
    && [item.from, item.to].some((edgeId) => String(network.trafficGraph.edges.find((edge) => edge.id === edgeId)?.name) === name));
  assert(connector, `${name} has no OSM shared-node traffic connector`);
}
const kujoRouteSamples = network.nodes.filter((node) => node.s > kujoStart + 120 && node.s < kujoEnd - 50);
const kujoWestboundDistances = kujoRouteSamples.map((node) => Math.min(
  ...kujoWestboundEdges.map((edge) => polylineDistance(node.x, node.z, edge.points)),
));
assert(kujoWestboundEdges.length >= 4 && new Set(kujoWestboundEdges.map((edge) => edge.lane)).has(0) && new Set(kujoWestboundEdges.map((edge) => edge.lane)).has(1), "Kujo westbound OSM carriageway lane edges are missing");
assert(kujoRouteSamples.length > 100 && Math.max(...kujoWestboundDistances) < 3.5, "Bus route is not on the Kujo westbound carriageway");
const kujoStop = network.stops.find((stop) => stop.name === "九条大宮");
const kujoCrossRoadEdges = network.trafficGraph.edges.filter((edge) => String(edge.name).includes("九条通"));
assert(kujoStop && kujoCrossRoadEdges.length > 0 && Math.min(...kujoCrossRoadEdges.map((edge) => polylineDistance(kujoStop.pose.x, kujoStop.pose.z, edge.points))) < 90, "Kujo-Omiya cross-road branch is missing");
const kujoSections = network.sections.filter((section) => section.to > kujoStart + 80 && section.from < kujoEnd - 30);
assert(kujoSections.length > 0 && kujoSections.every((section) => section.lanesF === 2 && section.lanesB === 0), "Kujo route is not compiled as a two-lane westbound one-way");
// Right turns are not suppressed by road-name exceptions. Their legality is
// decided by the OSM shared-node topology and signal/turn metadata; only
// explicit U-turn connectors are prohibited for this NPC model.
assert(network.trafficGraph.connectors.every((connector) => connector.turnDirection !== "uturn"), "Forbidden U-turn connectors remain in the traffic graph");
assert((network.overlays?.roads?.medians ?? []).length > 0, "OSM central medians were not compiled");
assert((network.overlays?.roads?.crosswalks ?? []).length > 0, "Explicit OSM zebra crossings were not compiled");
const crosswalks = network.overlays?.roads?.crosswalks ?? [];
const omiyaOverpass = network.structures?.find((item) => item.name === "大宮跨線橋");
assert(omiyaOverpass, "Omiya overpass structure is missing for crosswalk exclusion");
const omiyaBridgeIntersections = network.intersections.filter((item) =>
  item.s >= omiyaOverpass.from && item.s <= omiyaOverpass.to,
);
assert(omiyaBridgeIntersections.length === 0, "Ground-road intersections remain inside the elevated Omiya bridge span");
const omiyaPeakIndex = network.nodes.reduce((best, node, index) =>
  Math.abs(node.s - omiyaOverpass.peak) < Math.abs(network.nodes[best].s - omiyaOverpass.peak) ? index : best, 0);
const omiyaSection = sectionAt(network.nodes[omiyaPeakIndex].s);
const omiyaForwardInner = mainTrafficPaths.find((item) => item.direction === 1 && item.lane === omiyaSection.lanesF - 1);
const omiyaReverseInner = mainTrafficPaths.find((item) => item.direction === -1 && item.lane === 0);
const omiyaCenter = network.surfacePath[omiyaPeakIndex];
const omiyaLaneMidpoint = [
  (omiyaForwardInner.points[omiyaPeakIndex][0] + omiyaReverseInner.points[omiyaPeakIndex][0]) / 2,
  (omiyaForwardInner.points[omiyaPeakIndex][1] + omiyaReverseInner.points[omiyaPeakIndex][1]) / 2,
];
assert(Math.hypot(omiyaCenter[0] - omiyaLaneMidpoint[0], omiyaCenter[1] - omiyaLaneMidpoint[1]) < 0.15, "Omiya centre line is not between the opposing physical lanes");
const routeProjection = (x, z) => {
  let best = { s: 0, distance: Infinity, tangent: [0, 1] };
  for (let index = 1; index < network.nodes.length; index++) {
    const a = network.nodes[index - 1], b = network.nodes[index];
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz) || 1;
    const hit = pointSegmentDistance(x, z, [a.x, a.y, a.z], [b.x, b.y, b.z]);
    if (hit < best.distance) {
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      best = { s: a.s + (b.s - a.s) * t, distance: hit, tangent: [dx / length, dz / length] };
    }
  }
  return best;
};
const graphBridgeCrossings = network.trafficGraph.edges.filter((edge) => {
  for (let index = 1; index < edge.points.length; index++) {
    const a = edge.points[index - 1], b = edge.points[index];
    const dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz) || 1;
    for (const [x, z] of [[a[0], a[2]], [(a[0] + b[0]) / 2, (a[2] + b[2]) / 2], [b[0], b[2]]]) {
      const projection = routeProjection(x, z);
      const alignment = Math.abs((dx * projection.tangent[0] + dz * projection.tangent[1]) / length);
      if (projection.s >= omiyaOverpass.from && projection.s <= omiyaOverpass.to && projection.distance < 18 && alignment < 0.82) return true;
    }
  }
  return false;
});
assert(graphBridgeCrossings.length === 0, "Transverse graph roads remain inside the elevated Omiya bridge span");
assert(!crosswalks.some((item) => item.routeDistance < 30 && item.routeS >= omiyaOverpass.from && item.routeS <= omiyaOverpass.to), "Crosswalks remain in the Omiya overpass span");
assert(crosswalks.filter((item) => item.intersection === "五条大宮").length === 4, "Gojo-Omiya intersection crosswalks were not compiled");
assert(crosswalks.filter((item) => item.intersection === "東寺道").length === 3, "Toji-michi intersection crosswalks were not compiled");
assert((network.overlays?.roads?.footbridges ?? []).some((item) => item.id.includes("284620455")), "Keihan-kokudoguchi footbridge is missing");
const omiyaRail = network.railStructures?.find((item) => item.kind === "conventional-underpass");
assert(omiyaRail?.bridgeFromS < omiyaRail?.bridgeToS, "Omiya parapet bridge limits were not compiled to driving-network distance");
assert(network.stops.length === 30, "OSM stop set was not compiled");
assert(network.overlays?.nijoRotary?.stationRoads?.length > 0, "Nijo rotary OSM overlay is missing");
assert(network.overlays?.nijoRotary?.oneWay === true && network.overlays?.nijoRotary?.laneCount === 2, "Nijo rotary must be a two-lane one-way road");
assert((network.overlays?.nijoRotary?.centerline?.length ?? 0) > 100, "Nijo rotary loop geometry was not compiled");
assert((network.overlays?.nijoRotary?.vegetation ?? []).filter((area) => area.polygon?.length >= 3).length >= 4, "Nijo rotary planted islands are missing");
let footprintMisses = 0;
for (const node of network.nodes) {
  const tx = Math.sin(node.heading), tz = Math.cos(node.heading);
  const nx = -tz, nz = tx;
  for (const lateral of [-1.28, 0, 1.28]) {
    const patched = (network.surfacePatches ?? []).some((patch) => node.s >= patch.from && node.s <= patch.to);
    if (!patched && !covered(node.x + nx * lateral, node.z + nz * lateral)) footprintMisses++;
  }
}
assert(footprintMisses === 0, `Compiled bus footprint leaves PLATEAU transportation (${footprintMisses} samples)`);
for (const stop of network.stops) {
  assert(stop.pose && stop.frame?.length === 4 && Array.isArray(stop.platform), `Stop pose/frame missing: ${stop.name}`);
  assert(stop.platformDistance <= 28, `OSM stop is not associated with the driving path: ${stop.name}`);
  assert(Number.isFinite(stop.dockLateral) && covered(stop.pose.x, stop.pose.z), `Stop docking pose leaves PLATEAU transportation: ${stop.name}`);
}
const nijoWestExit = network.stops.find((stop) => stop.name === "二条駅西口");
assert(nijoWestExit, "Nijo Station West Exit start stop is missing");
assert(nijoWestExit.s >= 8, "Nijo Station West Exit cannot place the front door at its generated stop pose");
assert(nijoWestExit.platformDistance <= 3, "Nijo Station West Exit start lane is not beside the OSM platform");
const nijoSection = network.sections.find((section) => section.source === "OSM Nijo Station West Exit rotary");
assert(nijoSection?.lanesF === 2 && nijoSection?.lanesB === 0, "Nijo rotary lane topology is not compiled as one-way two lanes");
const routeData = fs.readFileSync("src/route/routeData.js", "utf8");
const debug = fs.readFileSync("src/debug.js", "utf8");
const scenery = fs.readFileSync("src/world/declarative/buildWorldScenery.js", "utf8");
const landmarks = fs.readFileSync("src/world/landmarks.js", "utf8");
const traffic = [
  fs.readFileSync("src/world/traffic/index.js", "utf8"),
  fs.readFileSync("src/world/traffic/agents.js", "utf8"),
  fs.readFileSync("src/world/traffic/graph.js", "utf8"),
].join("\n");
const plateauRenderer = fs.readFileSync("src/world/declarative/PlateauWorldRenderer.js", "utf8");
assert(routeData.includes('import drivingNetwork from "../data/generated/driving-network.json"'), "Runtime does not load the compiled network");
assert(!routeData.includes("KOEDA_"), "Bridge-specific runtime coordinates remain");
assert(routeData.includes("export function laneCenterAt() { return 0; }"), "Runtime still computes the auto-driving lane offset");
assert(!debug.includes("laneCenterAt"), "Autopilot still imports a runtime lane model");
assert(scenery.includes('throw new Error("PLATEAU building layer is empty; OSM building fallback is intentionally disabled.")'), "Station buildings may fall back to non-PLATEAU geometry");
assert(!landmarks.includes("buildNijoStation"), "Hand-authored Nijo Station still masks the PLATEAU building");
assert(!fs.existsSync(["src", "world", "traffic.js"].join("/")) && !traffic.includes("allowSyntheticIntersectionTraffic"), "Legacy synthetic traffic implementation should be removed");
assert(plateauRenderer.includes("insideMarkingGap"), "Lane markings are still drawn through intersection boxes");
console.log(JSON.stringify({
  status: "driving-network-ok",
  nodes: network.nodes.length,
  stops: network.stops.length,
  selectedSurfaces: network.selectedSurfaceIds.length,
  footprintMisses,
  activeLaneMisses,
  minimumSameDirectionSeparation: Number(minimumSameDirectionSeparation.toFixed(3)),
  minimumOpposingSeparation: Number(minimumOpposingSeparation.toFixed(3)),
  omiyaBridgeIntersections: omiyaBridgeIntersections.length,
  graphBridgeCrossings: graphBridgeCrossings.length,
  nijoRotaryRoads: network.overlays.nijoRotary.stationRoads.length,
  trafficGraphEdges: network.trafficGraph.edges.length,
  medians: network.overlays.roads.medians.length,
  kujoWestboundMaxDistance: Number(Math.max(...kujoWestboundDistances).toFixed(3)),
}, null, 2));
