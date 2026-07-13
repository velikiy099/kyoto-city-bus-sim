import raw from "../data/route18.json";
import drivingNetwork from "../data/generated/driving-network.json";
import ROUTE_SEMANTICS from "../data/definitions/route-semantics.json" with { type: "json" };
import { RoutePath } from "./path.js";

/**
 * Runtime reads only this compiled network for driving geometry, road height,
 * stop poses and traffic semantics.  raw is retained solely for non-driving
 * OSM metadata such as building source records used when matching PLATEAU
 * attributes, and vegetation source records.
 */
const path = new RoutePath(drivingNetwork.path);
const surfacePath = new RoutePath(
  drivingNetwork.surfacePath ?? drivingNetwork.path,
  2,
  drivingNetwork.surfaceS,
);
const compiledNijoVegetation = drivingNetwork.overlays?.nijoRotary?.vegetation ?? [];
const osmVegetation = raw.osmVegetation
  ? {
      ...raw.osmVegetation,
      greenAreas: [
        ...(raw.osmVegetation.greenAreas ?? []).filter((area) => !compiledNijoVegetation.some((compiled) => compiled.id === area.id)),
        ...compiledNijoVegetation,
      ],
    }
  : null;
const FALLBACK_SECTION = { from: 0, to: Infinity, lanes: 2, lanesF: 1, lanesB: 1, wL: 4, wR: 4, center: "line" };
const sections = (drivingNetwork.sections ?? []).map((section) => ({
  ...FALLBACK_SECTION,
  ...section,
  lanesF: section.lanesF ?? Math.max(1, Math.floor((section.lanes ?? 2) / 2)),
  lanesB: section.lanesB ?? Math.max(1, Math.ceil((section.lanes ?? 2) / 2)),
  wL: section.wL ?? 4,
  wR: section.wR ?? 4,
}));

export const route = {
  name: raw.routeName,
  source: raw.source,
  scale: raw.scale,
  path,
  surfacePath,
  terminalStop: raw.terminalStop ?? null,
  stops: (drivingNetwork.stops ?? []).filter((stop) => !ROUTE_SEMANTICS.excludedStops.includes(stop.name)),
  bridges: drivingNetwork.bridges ?? [],
  rivers: raw.rivers ?? [],
  waterPolygons: raw.waterPolygons ?? [],
  osmExpressways: raw.osmExpressways ?? [],
  trafficPaths: drivingNetwork.trafficPaths ?? [],
  trafficGraph: drivingNetwork.trafficGraph ?? null,
  speedZones: drivingNetwork.speedZones ?? [],
  roadSections: sections,
  intersections: drivingNetwork.intersections ?? [],
  turnIntersections: drivingNetwork.turnIntersections ?? [],
  signals: drivingNetwork.signals ?? [],
  osmVegetation,
  railStructures: drivingNetwork.railStructures ?? [],
  elevations: drivingNetwork.structures ?? [],
  drivingNetwork,
};

function networkNodeAt(s) {
  const nodes = drivingNetwork.nodes;
  if (!nodes?.length) return { y: 0 };
  const step = nodes.length > 1 ? nodes[1].s - nodes[0].s : 2;
  let index = Math.max(0, Math.min(nodes.length - 2, Math.floor(s / Math.max(step, 0.1))));
  while (index > 0 && nodes[index].s > s) index--;
  while (index < nodes.length - 2 && nodes[index + 1].s < s) index++;
  const a = nodes[index], b = nodes[index + 1];
  const t = Math.max(0, Math.min(1, (s - a.s) / Math.max(1e-6, b.s - a.s)));
  return { y: a.y + (b.y - a.y) * t };
}

export function sectionAt(s) {
  return sections.find((section) => s >= section.from && s < section.to)
    ?? (s < sections[0]?.from ? sections[0] : sections.at(-1) ?? FALLBACK_SECTION);
}
export function lanesAt(s) { const sec = sectionAt(s); return sec.lanesF + sec.lanesB; }
export function fwdLanesAt(s) { return sectionAt(s).lanesF; }
export function backLanesAt(s) { return sectionAt(s).lanesB; }
export function leftWidthAt(s) { return sectionAt(s).wL; }
export function rightWidthAt(s) { return sectionAt(s).wR; }
export function halfWidthAt(s) { const sec = sectionAt(s); return Math.max(sec.wL, sec.wR); }

function driveBoundAt(s, side) {
  const bounds = drivingNetwork.driveBounds;
  if (!bounds?.length) return halfWidthAt(s);
  let index = Math.max(0, Math.min(bounds.length - 2, Math.floor(s / 2)));
  while (index > 0 && bounds[index].s > s) index--;
  while (index < bounds.length - 2 && bounds[index + 1].s < s) index++;
  const a = bounds[index], b = bounds[index + 1];
  const t = Math.max(0, Math.min(1, (s - a.s) / Math.max(1e-6, b.s - a.s)));
  return a[side] + (b[side] - a[side]) * t;
}

/** Physical PLATEAU road extents from the already lane-centred driving path. */
export function driveBoundsAt(s) {
  return { left: driveBoundAt(s, "left"), right: driveBoundAt(s, "right") };
}

// The compiled path is already the bus lane. No runtime lateral lane model or
// bridge-specific merge is permitted.
export function laneCenterAt() { return 0; }
export function turnExclusions() {
  const result = [];
  for (const turn of route.turnIntersections) {
    const halfWidth = Math.max(halfWidthAt(turn.sIn), halfWidthAt(turn.sOut));
    result.push({ x: turn.x, z: turn.z, r: halfWidth + (turn.crossWidth ?? 8) / 2 + 3 });
  }
  return result;
}

export function terrainElevationAt(s) { return networkNodeAt(s).y; }
export function elevationAt(s) { return networkNodeAt(s).y; }
export function surfaceElevationAt(s) { return networkNodeAt(s).y; }
export function roadAttachmentHalfWidthAt(s) {
  const section = sectionAt(s);
  return Math.max(section.wL, section.wR) + (section.sidewalk === "none" ? 0.75 : 3.4);
}
export function gradeAt(s) { return (elevationAt(s + 3) - elevationAt(s - 3)) / 6; }
export function speedLimitAt(s) {
  return (route.speedZones.find((zone) => s >= zone.from && s < zone.to)?.limit ?? 40) / 3.6;
}
export function speedLimitKmhAt(s) {
  return route.speedZones.find((zone) => s >= zone.from && s < zone.to)?.limit ?? 40;
}
