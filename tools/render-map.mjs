#!/usr/bin/env node
/**
 * Runtime-complete top-view SVG for driving geometry QA.
 *
 * Unlike the legacy renderer, this reads the same compiled driving network and
 * PLATEAU transportation polygons as the simulator.  It intentionally draws
 * diagnostic overlays (lane paths, source centre, patches and steep grades)
 * on top of the final road footprint.
 *
 *   npm run map
 *   node tools/render-map.mjs --from 3400 --to 4250 --out tools/map-omiya.svg
 *   node tools/render-map.mjs --from 9300 --to 10150 --out tools/map-koga.svg
 *   npm run map-check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
const raw = readJson("src/data/route18.json");
const network = readJson("src/data/generated/driving-network.json");
const transportation = readJson("public/world/generated/plateau-transportation.json");
const roadOverlays = readJson("public/world/generated/osm-road-overlays.json");
const osmCorridor = readJson("data/osm/route18-corridor.json");
const buildings = readJson("public/world/generated/plateau-buildings.json");
const water = readJson("public/world/generated/plateau-water.json");
const terrain = readJson("src/world/declarative/generated/terrain-grid.json");

const args = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const nodes = network.nodes ?? [];
const totalLength = nodes.at(-1)?.s ?? 0;
const S_FROM = Math.max(0, Number(argValue("--from", 0)) || 0);
const requestedTo = Number(argValue("--to", totalLength));
const S_TO = Math.min(totalLength, Number.isFinite(requestedTo) ? requestedTo : totalLength);
const MARGIN = Math.max(20, Number(argValue("--margin", 90)) || 90);
const TERRAIN_STEP = Math.max(1, Math.round(Number(argValue("--terrain-step", 2)) || 2));
const OUT = resolve(ROOT, argValue("--out", "tools/map.svg"));
const CHECK = args.includes("--check");
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const xml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

if (nodes.length < 2) throw new Error("driving-network nodes are missing; run npm run world:build first");
if (!transportation.features?.length) throw new Error("PLATEAU transportation is missing; run npm run world:build first");
if (S_TO <= S_FROM) throw new Error(`invalid range: ${S_FROM}..${S_TO}`);

function locateS(s) {
  const target = clamp(Number(s) || 0, 0, totalLength);
  let lo = 0, hi = nodes.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].s <= target) lo = mid;
    else hi = mid;
  }
  const a = nodes[lo], b = nodes[Math.min(nodes.length - 1, lo + 1)];
  const t = clamp((target - a.s) / Math.max(1e-6, b.s - a.s), 0, 1);
  return { index: lo, t, a, b };
}

function pointAt(s, points = network.path) {
  const { index, t } = locateS(s);
  const a = points[index], b = points[Math.min(points.length - 1, index + 1)];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function headingAt(s, points = network.path) {
  const a = pointAt(s - 2, points), b = pointAt(s + 2, points);
  return Math.atan2(b[0] - a[0], b[1] - a[1]);
}

function sectionAt(s) {
  return (network.sections ?? []).find((section) => s >= section.from && s < section.to)
    ?? network.sections?.at(-1)
    ?? { wL: 4, wR: 4, lanesF: 1, lanesB: 1, center: "line" };
}

function boundsOfXZ(points) {
  const xs = points.map((point) => point[0]);
  const zs = points.map((point) => point.at(-1));
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

function overlaps(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

function rowsPolygon(rows) {
  return [
    ...rows.map((row) => [row[0][0], row[0].at(-1)]),
    ...rows.slice().reverse().map((row) => [row[1][0], row[1].at(-1)]),
  ];
}

function rectPoints(cx, cz, heading, from, to, halfWidth) {
  const dx = Math.sin(heading), dz = Math.cos(heading), nx = Math.cos(heading), nz = -Math.sin(heading);
  return [
    [cx + dx * from + nx * halfWidth, cz + dz * from + nz * halfWidth],
    [cx + dx * to + nx * halfWidth, cz + dz * to + nz * halfWidth],
    [cx + dx * to - nx * halfWidth, cz + dz * to - nz * halfWidth],
    [cx + dx * from - nx * halfWidth, cz + dz * from - nz * halfWidth],
  ];
}

function activeSegments(path) {
  const result = [];
  let segment = [];
  for (let index = 0; index < path.points.length; index++) {
    const s = path.distances?.[index] ?? nodes[index]?.s ?? 0;
    const active = path.active?.[index] !== false && s >= S_FROM && s <= S_TO;
    if (active) segment.push(path.points[index]);
    if ((!active || index === path.points.length - 1) && segment.length) {
      if (segment.length >= 2) result.push(segment);
      segment = [];
    }
  }
  return result;
}

function pointInPolygon(points, x, z) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i], [xj, zj] = points[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function mapChecks() {
  const failures = [], warnings = [];
  const fail = (message) => failures.push(message);
  const warn = (message) => warnings.push(message);
  if (network.path?.length !== nodes.length) fail("network.path and nodes are not aligned");
  if (network.surfacePath?.length !== nodes.length) fail("network.surfacePath and nodes are not aligned");
  if (network.driveBounds?.length !== nodes.length) fail("driveBounds and nodes are not aligned");
  for (const path of (network.trafficPaths ?? []).filter((item) => item.role === "main")) {
    if (path.points?.length !== nodes.length || path.active?.length !== nodes.length) fail(`${path.id} is not aligned with nodes`);
  }

  let maxGrade = { value: 0, s: 0 };
  let maxTurn = { value: 0, s: 0 };
  for (let index = 1; index < nodes.length; index++) {
    const a = nodes[index - 1], b = nodes[index];
    const ds = Math.max(1e-6, b.s - a.s);
    const grade = Math.abs((b.y - a.y) / ds);
    if (grade > maxGrade.value) maxGrade = { value: grade, s: b.s };
    let turn = Math.abs(b.heading - a.heading);
    while (turn > Math.PI) turn = Math.abs(turn - Math.PI * 2);
    const turnDeg = turn * 180 / Math.PI;
    // The hand-authored station rotary intentionally contains a tight initial
    // turn.  Past it, a large per-sample heading jump means generated lanes
    // are visibly zig-zagging and is always a map-build defect.
    if (b.s > 350 && turnDeg > maxTurn.value) maxTurn = { value: turnDeg, s: b.s };
  }
  if (maxGrade.value > 0.12) fail(`road grade jumps to ${(maxGrade.value * 100).toFixed(1)}% at s=${maxGrade.s.toFixed(1)}`);
  else if (maxGrade.value > 0.08) warn(`road grade reaches ${(maxGrade.value * 100).toFixed(1)}% at s=${maxGrade.s.toFixed(1)}`);
  if (maxTurn.value > 20) fail(`lane heading jumps ${maxTurn.value.toFixed(1)}° in one sample at s=${maxTurn.s.toFixed(1)}`);

  const driveSurfacePolygons = [
    ...transportation.features
      .filter((feature) => feature.kind !== "sidewalk")
      .map((feature) => feature.polygon?.map(([x, , z]) => [x, z]) ?? [])
      .filter((polygon) => polygon.length >= 3),
    ...(network.surfacePatches ?? [])
      .filter((patch) => (patch.rows?.length ?? 0) >= 2)
      .map((patch) => rowsPolygon(patch.rows)),
  ];
  let missing = 0;
  for (const node of nodes) {
    if (node.surfaceId === "osm-nijo-rotary") continue;
    if (!driveSurfacePolygons.some((polygon) => pointInPolygon(polygon, node.x, node.z))) missing++;
  }
  if (missing) fail(`${missing} bus-path samples leave the compiled driving surface`);

  const omiya = (network.structures ?? []).find((item) => item.name === "大宮跨線橋");
  if (omiya) {
    const bridgeIntersections = (network.intersections ?? []).filter((item) => item.s >= omiya.from && item.s <= omiya.to);
    if (bridgeIntersections.length) fail(`大宮跨線橋内に交差点が${bridgeIntersections.length}件残っています`);
  }
  return { failures, warnings, maxGrade, maxTurn };
}

if (CHECK) {
  const result = mapChecks();
  for (const message of result.failures) console.error(`FAIL  ${message}`);
  for (const message of result.warnings) console.warn(`WARN  ${message}`);
  console.log(`\n=== MAP check: FAIL ${result.failures.length} / WARN ${result.warnings.length} ===`);
  process.exit(result.failures.length ? 1 : 0);
}

const rangeNodes = nodes.filter((node) => node.s >= S_FROM && node.s <= S_TO);
if (!rangeNodes.length) throw new Error("selected range has no driving nodes");
const routeBounds = boundsOfXZ(rangeNodes.map((node) => [node.x, node.z]));
const viewBounds = {
  minX: routeBounds.minX - MARGIN,
  maxX: routeBounds.maxX + MARGIN,
  minZ: routeBounds.minZ - MARGIN,
  maxZ: routeBounds.maxZ + MARGIN,
};
const width = viewBounds.maxX - viewBounds.minX;
const height = viewBounds.maxZ - viewBounds.minZ;
const selectedIds = new Set(network.selectedSurfaceIds ?? []);
const layers = {
  terrain: [], water: [], osmRoads: [], vegetation: [], roads: [], sidewalks: [],
  footbridges: [], crosswalks: [], buildings: [], custom: [],
  structures: [], patches: [], graph: [], bounds: [], lanes: [], grades: [], labels: [],
};
const number = (value) => Number(value).toFixed(2);
const polygonSvg = (points, attributes) => `<polygon points="${points.map(([x, z]) => `${number(x)},${number(z)}`).join(" ")}" ${attributes}/>`;
const polylineSvg = (points, attributes) => `<polyline points="${points.map(([x, z]) => `${number(x)},${number(z)}`).join(" ")}" fill="none" ${attributes}/>`;
const circleSvg = ([x, z], radius, attributes) => `<circle cx="${number(x)}" cy="${number(z)}" r="${radius}" ${attributes}/>`;
const textSvg = ([x, z], label, attributes = "") => `<text x="${number(x)}" y="${number(z)}" ${attributes}>${xml(label)}</text>`;

function ribbonPoints(points, halfWidth) {
  const left = [], right = [];
  for (let index = 0; index < points.length; index++) {
    const previous = points[Math.max(0, index - 1)], next = points[Math.min(points.length - 1, index + 1)];
    const dx = next[0] - previous[0], dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length, nz = dx / length;
    left.push([points[index][0] + nx * halfWidth, points[index][1] + nz * halfWidth]);
    right.push([points[index][0] - nx * halfWidth, points[index][1] - nz * halfWidth]);
  }
  return [...left, ...right.reverse()];
}
const waterLineWidth = (river, bridge) => {
  const tagged = Number(river?.widthMeters ?? bridge?.riverWidth);
  if (Number.isFinite(tagged) && tagged > 0) return tagged;
  return ({ "桂川": 48, "鴨川": 22, "西高瀬川": 8 })[river?.river] ?? 12;
};

// The simulator's connected terrain grid, rendered as a subdued elevation
// heatmap.  A 2x2 default stride keeps the full-route SVG manageable while
// preserving slopes and embankments; pass --terrain-step 1 for close QA.
const [terrainOriginX, terrainOriginZ] = terrain.origin ?? [0, 0];
const [terrainStepX, terrainStepZ] = Array.isArray(terrain.spacing) ? terrain.spacing : [terrain.spacing, terrain.spacing];
const terrainWidth = Number(terrain.width) || 0, terrainHeight = Number(terrain.height) || 0;
const terrainHeights = terrain.heights ?? [];
const terrainMin = Math.min(...terrainHeights), terrainMax = Math.max(...terrainHeights);
const terrainColor = (heightValue) => {
  const t = clamp((heightValue - terrainMin) / Math.max(1e-6, terrainMax - terrainMin), 0, 1);
  return `hsl(${92 - t * 18} 17% ${74 - t * 30}%)`;
};
for (let iz = 0; iz < terrainHeight - 1; iz += TERRAIN_STEP) {
  const z = terrainOriginZ + iz * terrainStepZ;
  const cellHeight = terrainStepZ * Math.min(TERRAIN_STEP, terrainHeight - 1 - iz);
  if (z + cellHeight < viewBounds.minZ || z > viewBounds.maxZ) continue;
  for (let ix = 0; ix < terrainWidth - 1; ix += TERRAIN_STEP) {
    const x = terrainOriginX + ix * terrainStepX;
    const cellWidth = terrainStepX * Math.min(TERRAIN_STEP, terrainWidth - 1 - ix);
    if (x + cellWidth < viewBounds.minX || x > viewBounds.maxX) continue;
    const samples = [];
    for (let dz = 0; dz <= TERRAIN_STEP && iz + dz < terrainHeight; dz += TERRAIN_STEP) {
      for (let dx = 0; dx <= TERRAIN_STEP && ix + dx < terrainWidth; dx += TERRAIN_STEP) {
        samples.push(Number(terrainHeights[(iz + dz) * terrainWidth + ix + dx]) || 0);
      }
    }
    const y = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
    layers.terrain.push(`<rect x="${number(x)}" y="${number(z)}" width="${number(cellWidth + 0.08)}" height="${number(cellHeight + 0.08)}" fill="${terrainColor(y)}"/>`);
  }
}

// PLATEAU water bodies when available, plus OSM riverbank polygons when the
// refreshed route data contains them.  A waterway line is only a centreline;
// its fallback corridor is deliberately narrow and never based on bridge span.
for (const feature of water.features ?? []) {
  const source = feature.polygon ?? feature.footprint ?? [];
  const points = source.map((point) => [point[0], point.at(-1)]);
  if (points.length >= 3 && overlaps(boundsOfXZ(points), viewBounds)) layers.water.push(polygonSvg(points, 'fill="#4fa8d8" fill-opacity="0.78" stroke="#286f9b" stroke-width="0.25"'));
}
for (const feature of raw.waterPolygons ?? []) {
  const points = feature.polygon ?? [];
  if (points.length >= 3 && overlaps(boundsOfXZ(points), viewBounds)) layers.water.push(polygonSvg(points, 'fill="#4fa8d8" fill-opacity="0.8" stroke="#286f9b" stroke-width="0.3"'));
}
for (const river of raw.rivers ?? []) {
  const bridge = (network.bridges ?? []).find((item) => item.name === river.bridgeName);
  if (!bridge || river.points?.length < 2) continue;
  const halfWidth = waterLineWidth(river, bridge) / 2;
  const polygon = ribbonPoints(river.points, halfWidth);
  if (!overlaps(boundsOfXZ(polygon), viewBounds)) continue;
  layers.water.push(polygonSvg(polygon, 'fill="#4fa8d8" fill-opacity="0.8" stroke="#286f9b" stroke-width="0.35"'));
  const nearest = river.points.reduce((best, point) => {
    const distance = Math.hypot(point[0] - pointAt(bridge.s)[0], point[1] - pointAt(bridge.s)[1]);
    return distance < best.distance ? { point, distance } : best;
  }, { point: river.points[0], distance: Infinity }).point;
  layers.labels.push(textSvg([nearest[0] + 5, nearest[1] - 5], river.river, 'font-size="7" fill="#14577e" stroke="#dff5ff" stroke-width="1.3" paint-order="stroke"'));
}

// OSM corridor reference layers. These are intentionally kept separate from
// the PLATEAU road polygons so mismatches remain visible in the QA map.
for (const road of osmCorridor.roads ?? []) {
  const points = road.points ?? [];
  if (points.length < 2 || !overlaps(boundsOfXZ(points), viewBounds)) continue;
  const highway = road.tags?.highway ?? "";
  const color = highway === "motorway" ? "#6f5960"
    : highway === "primary" || highway === "secondary" ? "#756b62"
      : "#8b918e";
  const widthValue = highway === "motorway" ? 0.9 : highway === "primary" ? 0.55 : 0.32;
  layers.osmRoads.push(polylineSvg(points, `stroke="${color}" stroke-width="${widthValue}" stroke-opacity="0.62"`));
}
for (const expressway of raw.osmExpressways ?? []) {
  const points = expressway.points ?? [];
  if (points.length < 2 || !overlaps(boundsOfXZ(points), viewBounds)) continue;
  layers.osmRoads.push(polylineSvg(points, `stroke="${expressway.bridge ? "#3f4850" : "#62686b"}" stroke-width="${Math.max(1.2, (expressway.width ?? 15) / 7)}" stroke-opacity="0.9"`));
}

// All OSM vegetation sources used by the runtime: woodland/forest, scrub,
// parks/grass, tree rows and individually mapped trees.
const osmVegetation = raw.osmVegetation ?? {};
for (const area of [...(osmVegetation.greenAreas ?? []), ...(osmVegetation.treeAreas ?? [])]) {
  const points = area.polygon ?? [];
  if (points.length < 3 || !overlaps(boundsOfXZ(points), viewBounds)) continue;
  const fill = area.kind === "scrub" ? "#9eae66"
    : ["wood", "forest"].includes(area.kind) ? "#5d8552"
      : "#8eb477";
  layers.vegetation.push(polygonSvg(points, `fill="${fill}" fill-opacity="0.52" stroke="#527747" stroke-width="0.2"`));
}
for (const row of osmVegetation.treeRows ?? []) {
  if (row.points?.length >= 2 && overlaps(boundsOfXZ(row.points), viewBounds))
    layers.vegetation.push(polylineSvg(row.points, 'stroke="#5d7d3b" stroke-width="1.1" stroke-dasharray="1.2 0.8"'));
}
for (const tree of osmVegetation.trees ?? []) {
  if (tree.point && tree.point[0] >= viewBounds.minX && tree.point[0] <= viewBounds.maxX && tree.point[1] >= viewBounds.minZ && tree.point[1] <= viewBounds.maxZ)
    layers.vegetation.push(circleSvg(tree.point, 1.15, 'fill="#3f713b" fill-opacity="0.78" stroke="#2d552b" stroke-width="0.18"'));
}
for (const hedge of osmCorridor.hedges ?? []) {
  if (hedge.points?.length >= 2 && overlaps(boundsOfXZ(hedge.points), viewBounds))
    layers.vegetation.push(polylineSvg(hedge.points, 'stroke="#496b37" stroke-width="1.0" stroke-dasharray="1.8 0.8"'));
}

for (const feature of transportation.features) {
  if (!feature.polygon?.length) continue;
  const points = feature.polygon.map(([x, , z]) => [x, z]);
  if (!overlaps(boundsOfXZ(points), viewBounds)) continue;
  if (feature.kind === "sidewalk") {
    layers.sidewalks.push(polygonSvg(points, 'fill="#cfc5b4" stroke="#968c7d" stroke-width="0.14"'));
    continue;
  }
  const selected = selectedIds.has(feature.id);
  layers.roads.push(polygonSvg(points, selected
    ? 'fill="#55585a" stroke="#272b2e" stroke-width="0.18"'
    : 'fill="#aeb4b6" stroke="#7f878a" stroke-width="0.12"'));
}

for (const feature of roadOverlays.features ?? []) {
  if (feature.kind !== "sidewalk" || !feature.polygon?.length) continue;
  const points = feature.polygon.map(([x, , z]) => [x, z]);
  if (overlaps(boundsOfXZ(points), viewBounds)) layers.sidewalks.push(polygonSvg(points, 'fill="#cfc5b4" stroke="#968c7d" stroke-width="0.14"'));
}

// Pedestrian decks/stairs are raised structures in the runtime renderer.  In
// this top view draw the deck as a warm band and its two railings so it cannot
// be mistaken for an NPC road lane.
for (const bridge of network.overlays?.roads?.footbridges ?? []) {
  const xz = (bridge.points ?? []).map(([x, , z]) => [x, z]);
  if (xz.length < 2 || !overlaps(boundsOfXZ(xz), viewBounds)) continue;
  const halfWidth = Math.max(0.7, Number(bridge.width) || 2) / 2;
  const band = ribbonPoints(xz, halfWidth);
  const fill = bridge.kind === "stairs" ? "#df8b3d" : "#f0a04b";
  const dash = bridge.kind === "stairs" ? ' stroke-dasharray="1.2 0.8"' : "";
  layers.footbridges.push(polygonSvg(band, `fill="${fill}" fill-opacity="0.86" stroke="#8c4e1b" stroke-width="0.35"${dash}`));
  for (const side of [-1, 1]) {
    const rail = [];
    for (let index = 0; index < xz.length; index++) {
      const previous = xz[Math.max(0, index - 1)], next = xz[Math.min(xz.length - 1, index + 1)];
      const dx = next[0] - previous[0], dz = next[1] - previous[1];
      const length = Math.hypot(dx, dz) || 1;
      rail.push([xz[index][0] + (-dz / length) * side * halfWidth, xz[index][1] + (dx / length) * side * halfWidth]);
    }
    layers.footbridges.push(polylineSvg(rail, 'stroke="#6e3d18" stroke-width="0.28"'));
  }
  const middle = xz[Math.floor(xz.length / 2)];
  layers.labels.push(textSvg([middle[0] + 2, middle[1] - 2], bridge.kind === "stairs" ? "歩道橋階段" : "歩道橋", 'font-size="5.5" fill="#6e3d18" stroke="#fff5e5" stroke-width="1" paint-order="stroke"'));
}

for (const crossing of network.overlays?.roads?.crosswalks ?? []) {
  for (const stripe of crossing.stripes ?? []) {
    if (stripe.length < 3) continue;
    const points = stripe.map(([x, , z]) => [x, z]);
    if (overlaps(boundsOfXZ(points), viewBounds)) layers.crosswalks.push(polygonSvg(points, 'fill="#fffdf1" stroke="#b9b8af" stroke-width="0.08"'));
  }
}

for (const building of buildings.features ?? []) {
  const points = building.footprint ?? [];
  if (points.length < 3 || !overlaps(boundsOfXZ(points), viewBounds)) continue;
  const heightValue = Math.max(2, Number(building.height) || 6);
  const darkness = Math.round(clamp(72 - heightValue * 0.9, 35, 68));
  layers.buildings.push(polygonSvg(points, `fill="hsl(28 18% ${darkness}%)" stroke="#5f554c" stroke-width="0.22"`));
}

// Hand-authored landmark geometry is not present in either PLATEAU or OSM,
// but it is part of the playable world and must be visible in the final map.
const customObject = (id, points, label, fill = "#e7b86b") => {
  if (!points || points.length < 3 || !overlaps(boundsOfXZ(points), viewBounds)) return;
  layers.custom.push(polygonSvg(points, `fill="${fill}" fill-opacity="0.34" stroke="#9b6b2f" stroke-width="0.35" stroke-dasharray="1.4 0.8"`));
  if (label) {
    const center = points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]);
    layers.labels.push(textSvg([center[0] + 2, center[1]], label, 'font-size="5.5" fill="#85571f" stroke="#fff7e4" stroke-width="1.2" paint-order="stroke"'));
  }
};
const routeOffset = (s, lateral) => {
  const [x, z] = pointAt(s, network.surfacePath);
  const heading = headingAt(s, network.surfacePath);
  return [x + Math.cos(heading) * lateral, z - Math.sin(heading) * lateral];
};
const routeRect = (s, lateral, widthValue, depth) => {
  const [x, z] = routeOffset(s, lateral);
  return rectPoints(x, z, headingAt(s, network.surfacePath), -depth / 2, depth / 2, widthValue / 2);
};
const stopSByName = (name) => network.stops?.find((stop) => stop.name === name)?.s;
const roadHalfWidth = (s, side) => {
  const section = sectionAt(s);
  return side < 0 ? section.wL : section.wR;
};

const tojiEastX = 618.51;
const tojiSouthZ = -540.99;
const tojiNorthZ = Math.min(
  pointAt(network.intersections?.find((item) => item.name === "東寺道")?.s ?? 4141)[1],
  -811.26,
);
const tojiWestX = pointAt(network.intersections?.find((item) => item.name === "京阪国道口(国道1号)")?.s ?? 4705)[0];
customObject("toji-compound", [[tojiWestX, tojiNorthZ], [tojiEastX, tojiNorthZ], [tojiEastX, tojiSouthZ], [tojiWestX, tojiSouthZ]], "東寺境内", "#c7ae82");
customObject("toji-pagoda", [[575.22, -593.63], [605.22, -593.63], [605.22, -563.63], [575.22, -563.63]], "東寺五重塔");
customObject("toji-kondo", [[477.62, -645.03], [515.62, -645.03], [515.62, -619.03], [477.62, -619.03]], "東寺金堂");
customObject("toji-nandaimon", [[482.07, -546], [508.67, -546], [508.67, -536], [482.07, -536]], "東寺南大門");
customObject("toji-todaimon", [[610.81, -680], [626.21, -680], [626.21, -655.8], [610.81, -655.8]], "東寺東大門");

const aquariumS = stopSByName("七条大宮・京都水族館前");
if (aquariumS != null) customObject("kyoto-aquarium", routeRect(aquariumS + 20, roadHalfWidth(aquariumS + 20, 1) + 86.2, 52, 30), "京都水族館", "#77a8c8");
const towerS = stopSByName("七条大宮・京都水族館前");
if (towerS != null) {
  const tower = routeOffset(towerS, -620);
  if (tower[0] >= viewBounds.minX - 60 && tower[0] <= viewBounds.maxX + 60 && tower[1] >= viewBounds.minZ - 60 && tower[1] <= viewBounds.maxZ + 60) {
    layers.custom.push(circleSvg(tower, 20, 'fill="#d9dfe4" fill-opacity="0.36" stroke="#6b7780" stroke-width="0.45" stroke-dasharray="1.4 0.8"'));
    layers.labels.push(textSvg([tower[0] + 5, tower[1]], "京都タワー", 'font-size="5.5" fill="#56636c" stroke="#fff" stroke-width="1.2" paint-order="stroke"'));
  }
}

const mibuS = stopSByName("みぶ操車場前");
if (mibuS != null) customObject("mibu-depot", routeRect(mibuS, roadHalfWidth(mibuS, 1) + 33, 50, 56), "壬生操車場", "#9caeb5");
const terminal = network.stops?.find((stop) => stop.name === "久我石原町")?.pose ?? raw.terminalStop;
if (terminal?.x != null && terminal?.z != null) customObject("terminal-lot", [[terminal.x - 1.8, terminal.z - 2], [terminal.x + 20.7, terminal.z - 2], [terminal.x + 20.7, terminal.z + 22.7], [terminal.x - 1.8, terminal.z + 22.7]], "久我石原町操車場", "#9caeb5");

const rotaryRows = network.overlays?.nijoRotary?.road?.rows;
if (rotaryRows?.length >= 2 && S_FROM < 350) layers.patches.push(polygonSvg(rowsPolygon(rotaryRows), 'fill="#55585a" stroke="#272b2e" stroke-width="0.2"'));

for (const structure of network.structures ?? []) {
  if (structure.to < S_FROM || structure.from > S_TO) continue;
  const rows = [];
  for (let s = Math.max(S_FROM, structure.from); s <= Math.min(S_TO, structure.to); s += 4) {
    const { index } = locateS(s);
    const [x, z] = pointAt(s, network.surfacePath);
    const heading = headingAt(s, network.surfacePath);
    const nx = -Math.cos(heading), nz = Math.sin(heading);
    const bounds = network.driveBounds[index] ?? { left: 4, right: 4 };
    rows.push([[x - nx * bounds.left, z - nz * bounds.left], [x + nx * bounds.right, z + nz * bounds.right]]);
  }
  if (rows.length >= 2) layers.structures.push(polygonSvg(rowsPolygon(rows), 'fill="#32a6df" fill-opacity="0.25" stroke="#1179ad" stroke-width="0.35"'));
  const center = pointAt((structure.from + structure.to) / 2, network.surfacePath);
  layers.labels.push(textSvg([center[0] + 6, center[1] - 7], structure.name, 'font-size="7" fill="#075f8d"'));
}

for (const rail of network.railStructures ?? []) {
  if (rail.s < S_FROM - 80 || rail.s > S_TO + 80) continue;
  const [x, z] = pointAt(rail.s, network.surfacePath);
  const points = rectPoints(x, z, rail.heading, -rail.length / 2, rail.length / 2, (rail.width ?? 12) / 2);
  layers.structures.push(polygonSvg(points, 'fill="#6c4d34" fill-opacity="0.28" stroke="#5a3922" stroke-width="0.5"'));
  layers.labels.push(textSvg([x + 5, z + 5], rail.name, 'font-size="6" fill="#4e2e19"'));
}

for (const edge of network.trafficGraph?.edges ?? []) {
  const points = edge.points?.map(([x, , z]) => [x, z]) ?? [];
  if (points.length < 2 || !overlaps(boundsOfXZ(points), viewBounds)) continue;
  layers.graph.push(polylineSvg(points, 'stroke="#6a3da3" stroke-width="0.45" stroke-opacity="0.65"'));
}
for (const connector of network.trafficGraph?.connectors ?? []) {
  const points = connector.points?.map(([x, , z]) => [x, z]) ?? [];
  if (points.length < 2 || !overlaps(boundsOfXZ(points), viewBounds)) continue;
  const color = connector.turnDirection === "straight" ? "#a66bd6" : "#e48735";
  layers.graph.push(polylineSvg(points, `stroke="${color}" stroke-width="0.65" stroke-opacity="0.8" stroke-dasharray="1.8 1"`));
}

const leftBoundary = [], rightBoundary = [];
for (const node of rangeNodes) {
  const index = nodes.indexOf(node);
  const heading = node.heading, nx = -Math.cos(heading), nz = Math.sin(heading);
  const bounds = network.driveBounds[index] ?? { left: 4, right: 4 };
  leftBoundary.push([node.x - nx * bounds.left, node.z - nz * bounds.left]);
  rightBoundary.push([node.x + nx * bounds.right, node.z + nz * bounds.right]);
}
layers.bounds.push(polylineSvg(leftBoundary, 'stroke="#6dff7b" stroke-width="0.38" stroke-dasharray="2 1.5"'));
layers.bounds.push(polylineSvg(rightBoundary, 'stroke="#6dff7b" stroke-width="0.38" stroke-dasharray="2 1.5"'));

const reference = network.routeReferencePath.slice(rangeNodes[0] === nodes[0] ? 0 : locateS(S_FROM).index, locateS(S_TO).index + 2);
layers.lanes.push(polylineSvg(reference, 'stroke="#2d68d8" stroke-width="0.45" stroke-dasharray="3 2"'));
const surface = network.surfacePath.slice(locateS(S_FROM).index, locateS(S_TO).index + 2);
layers.lanes.push(polylineSvg(surface, 'stroke="#ffd34e" stroke-width="0.65"'));
for (const lanePath of (network.trafficPaths ?? []).filter((item) => item.role === "main")) {
  const color = lanePath.direction > 0 ? (lanePath.lane === 0 ? "#00f0ff" : "#f7f7f0") : "#ff67ce";
  const widthValue = lanePath.direction > 0 && lanePath.lane === 0 ? 0.85 : 0.5;
  for (const segment of activeSegments(lanePath)) layers.lanes.push(polylineSvg(segment, `stroke="${color}" stroke-width="${widthValue}"`));
}

for (let index = 1; index < nodes.length; index++) {
  const a = nodes[index - 1], b = nodes[index];
  if (b.s < S_FROM || a.s > S_TO) continue;
  const grade = Math.abs((b.y - a.y) / Math.max(1e-6, b.s - a.s));
  if (grade > 0.08) layers.grades.push(polylineSvg([[a.x, a.z], [b.x, b.z]], `stroke="${grade > 0.12 ? "#ff173d" : "#ff9f1a"}" stroke-width="${grade > 0.12 ? 3 : 2}"`));
}

for (const intersection of network.intersections ?? []) {
  if (intersection.s < S_FROM || intersection.s > S_TO) continue;
  const point = pointAt(intersection.s, network.surfacePath);
  layers.labels.push(circleSvg(point, 1.25, 'fill="#ffef54" stroke="#4c4300" stroke-width="0.25"'));
  if (intersection.name) layers.labels.push(textSvg([point[0] + 3, point[1] - 3], intersection.name, 'font-size="5.5" fill="#3c3500"'));
}
for (const stop of network.stops ?? []) {
  if (stop.s < S_FROM || stop.s > S_TO) continue;
  const point = [stop.pose?.x ?? pointAt(stop.s)[0], stop.pose?.z ?? pointAt(stop.s)[1]];
  layers.labels.push(circleSvg(point, 1.8, 'fill="#d7263d" stroke="#ffffff" stroke-width="0.45"'));
  layers.labels.push(textSvg([point[0] + 4, point[1] + 3], `${stop.name} s=${stop.s.toFixed(0)}`, 'font-size="6.5" fill="#7e0f20"'));
}

for (const section of network.sections ?? []) {
  if (section.to < S_FROM || section.from > S_TO) continue;
  const mid = (Math.max(section.from, S_FROM) + Math.min(section.to, S_TO)) / 2;
  if (section.to - section.from < 35) continue;
  const point = pointAt(mid, network.surfacePath);
  layers.labels.push(textSvg([point[0] + 2, point[1] + 2], `F${section.lanesF ?? 1}/B${section.lanesB ?? 0}`, 'font-size="5" fill="#111" stroke="#fff" stroke-width="1.3" paint-order="stroke"'));
}

const legendX = viewBounds.minX + 8, legendZ = viewBounds.minZ + 12;
const legend = [
  ["#00f0ff", "自車・同行車の正本経路"],
  ["#ff67ce", "対向車経路"],
  ["#ffd34e", "物理道路中心"],
  ["#2d68d8", "PLATEAUへスナップした元軸"],
  ["#cfc5b4", "歩道"],
  ["#7b6959", "建物（濃色ほど高い）"],
  ["#8b918e", "OSM道路中心線"],
  ["#5d8552", "OSM森林・低木林・緑地"],
  ["#e7b86b", "独自配置物・建物"],
  [terrainColor((terrainMin + terrainMax) / 2), `地形高度 ${terrainMin.toFixed(0)}〜${terrainMax.toFixed(0)}m`],
  ["#4fa8d8", "河川・水域"],
  ["#f0a04b", "歩道橋・階段"],
  ["#6a3da3", "OSM物理車線・交差点コネクタ"],
  ["#e48735", "OSM右左折コネクタ"],
  ["#ff173d", "12%超の高度急変"],
];
const legendSvg = [`<rect x="${legendX}" y="${legendZ - 8}" width="120" height="${legend.length * 10 + 9}" rx="2" fill="#ffffff" fill-opacity="0.9" stroke="#62686a" stroke-width="0.25"/>`];
legend.forEach(([color, label], index) => {
  const z = legendZ + index * 10;
  legendSvg.push(`<line x1="${legendX + 5}" y1="${z}" x2="${legendX + 20}" y2="${z}" stroke="${color}" stroke-width="1.4"/>`);
  legendSvg.push(textSvg([legendX + 24, z + 2], label, 'font-size="5.8" fill="#222"'));
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${number(viewBounds.minX)} ${number(viewBounds.minZ)} ${number(width)} ${number(height)}">
<title>${xml(raw.routeName)} runtime map ${S_FROM.toFixed(0)}-${S_TO.toFixed(0)}m</title>
<rect x="${number(viewBounds.minX)}" y="${number(viewBounds.minZ)}" width="${number(width)}" height="${number(height)}" fill="#c9d0c1"/>
<g id="terrain">${layers.terrain.join("\n")}</g>
<g id="water">${layers.water.join("\n")}</g>
<g id="osm-roads">${layers.osmRoads.join("\n")}</g>
<g id="osm-vegetation">${layers.vegetation.join("\n")}</g>
<g id="plateau-roads">${layers.roads.join("\n")}</g>
<g id="plateau-sidewalks">${layers.sidewalks.join("\n")}</g>
<g id="footbridges">${layers.footbridges.join("\n")}</g>
<g id="structures">${layers.structures.join("\n")}</g>
<g id="surface-patches">${layers.patches.join("\n")}</g>
<g id="crosswalks">${layers.crosswalks.join("\n")}</g>
<g id="npc-graph">${layers.graph.join("\n")}</g>
<g id="drive-bounds">${layers.bounds.join("\n")}</g>
<g id="lane-paths">${layers.lanes.join("\n")}</g>
<g id="steep-grades">${layers.grades.join("\n")}</g>
<g id="buildings">${layers.buildings.join("\n")}</g>
<g id="custom-objects">${layers.custom.join("\n")}</g>
<g id="labels" font-family="sans-serif">${layers.labels.join("\n")}</g>
<g id="legend" font-family="sans-serif">${legendSvg.join("\n")}</g>
</svg>`;

writeFileSync(OUT, svg);
console.log(`OK → ${OUT}`);
console.log(`runtime range ${S_FROM.toFixed(1)}..${S_TO.toFixed(1)}m / terrain ${layers.terrain.length} / water ${layers.water.length} / OSM roads ${layers.osmRoads.length} / OSM vegetation ${layers.vegetation.length} / roads ${layers.roads.length} / sidewalks ${layers.sidewalks.length} / footbridge parts ${layers.footbridges.length} / buildings ${layers.buildings.length} / custom objects ${layers.custom.length} / crosswalk stripes ${layers.crosswalks.length} / lane overlays ${layers.lanes.length} / steep segments ${layers.grades.length}`);
