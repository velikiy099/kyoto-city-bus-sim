import { RoutePath } from "./path.js";

const FALLBACK_SECTION = { from: 0, to: Infinity, lanes: 2, lanesF: 1, lanesB: 1, wL: 4, wR: 4, center: "line" };

let activeRuntime = null;

/**
 * Runtime reads only the compiled driving network for driving geometry, road
 * height, stop poses and traffic semantics. `raw` is retained solely for
 * non-driving OSM metadata (building/vegetation source records, rivers).
 */
export function createRouteRuntime(raw = {}, drivingNetwork = {}, semantics = {}) {
  const path = new RoutePath(drivingNetwork.path ?? []);
  const surfacePath = new RoutePath(
    drivingNetwork.surfacePath ?? drivingNetwork.path ?? [],
    2,
    drivingNetwork.surfaceS,
  );
  const compiledOverlayVegetation = Object.values(drivingNetwork.overlays ?? {})
    .flatMap((overlay) => overlay?.vegetation ?? []);
  const osmVegetation = raw?.osmVegetation
    ? {
        ...raw.osmVegetation,
        greenAreas: [
          ...(raw.osmVegetation.greenAreas ?? []).filter(
            (area) => !compiledOverlayVegetation.some((compiled) => compiled.id === area.id),
          ),
          ...compiledOverlayVegetation,
        ],
      }
    : null;
  const sections = (drivingNetwork.sections ?? []).map((section) => ({
    ...FALLBACK_SECTION,
    ...section,
    lanesF: section.lanesF ?? Math.max(1, Math.floor((section.lanes ?? 2) / 2)),
    lanesB: section.lanesB ?? Math.max(1, Math.ceil((section.lanes ?? 2) / 2)),
    wL: section.wL ?? 4,
    wR: section.wR ?? 4,
  }));
  const excludedStops = semantics?.excludedStops ?? [];

  const route = {
    name: raw?.routeName ?? semantics?.routeTitle ?? "",
    source: raw?.source ?? "",
    scale: raw?.scale ?? 1,
    path,
    surfacePath,
    terminalStop: raw?.terminalStop ?? null,
    stops: (drivingNetwork.stops ?? []).filter((stop) => !excludedStops.includes(stop.name)),
    bridges: drivingNetwork.bridges ?? [],
    rivers: raw?.rivers ?? [],
    waterPolygons: raw?.waterPolygons ?? [],
    osmExpressways: raw?.osmExpressways ?? [],
    trafficPaths: drivingNetwork.trafficPaths ?? [],
    trafficGraph: drivingNetwork.trafficGraph ?? null,
    speedZones: drivingNetwork.speedZones ?? [],
    roadSections: sections,
    intersections: drivingNetwork.intersections ?? [],
    turnIntersections: drivingNetwork.turnIntersections ?? [],
    signals: drivingNetwork.signals ?? [],
    autoLaneGuides: drivingNetwork.autoLaneGuides ?? [],
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

  function sectionAt(s) {
    return sections.find((section) => s >= section.from && s < section.to)
      ?? (s < sections[0]?.from ? sections[0] : sections.at(-1) ?? FALLBACK_SECTION);
  }
  const lanesAt = (s) => { const sec = sectionAt(s); return sec.lanesF + sec.lanesB; };
  const fwdLanesAt = (s) => sectionAt(s).lanesF;
  const backLanesAt = (s) => sectionAt(s).lanesB;
  const leftWidthAt = (s) => sectionAt(s).wL;
  const rightWidthAt = (s) => sectionAt(s).wR;
  const halfWidthAt = (s) => { const sec = sectionAt(s); return Math.max(sec.wL, sec.wR); };

  /** 描画と同一条件で、対向車線と中央線が存在する区間かどうかを返す。 */
  function hasCenterlineAt(s) {
    const sec = sectionAt(s);
    return !sec.oneWay && sec.lanesB > 0 && sec.center !== "none";
  }

  /** 描画中央線(surfacePath)に対する横位置(左が負・右が正)を返す。 */
  function centerlineLateralAt(x, z, s) {
    return surfacePath.closestS([x, z], s, 150).lateral;
  }

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

  function driveBoundsAt(s) {
    return { left: driveBoundAt(s, "left"), right: driveBoundAt(s, "right") };
  }

  function laneCenterAt() { return 0; }
  function turnExclusions() {
    const result = [];
    for (const turn of route.turnIntersections) {
      const halfWidth = Math.max(halfWidthAt(turn.sIn), halfWidthAt(turn.sOut));
      result.push({ x: turn.x, z: turn.z, r: halfWidth + (turn.crossWidth ?? 8) / 2 + 3 });
    }
    return result;
  }

  const terrainElevationAt = (s) => networkNodeAt(s).y;
  const elevationAt = (s) => networkNodeAt(s).y;
  const surfaceElevationAt = (s) => networkNodeAt(s).y;
  function roadAttachmentHalfWidthAt(s) {
    const section = sectionAt(s);
    return Math.max(section.wL, section.wR) + (section.sidewalk === "none" ? 0.75 : 3.4);
  }
  const gradeAt = (s) => (elevationAt(s + 3) - elevationAt(s - 3)) / 6;
  const speedLimitAt = (s) =>
    (route.speedZones.find((zone) => s >= zone.from && s < zone.to)?.limit ?? 40) / 3.6;
  const speedLimitKmhAt = (s) =>
    route.speedZones.find((zone) => s >= zone.from && s < zone.to)?.limit ?? 40;

  return {
    route,
    drivingNetwork,
    networkNodeAt,
    sectionAt,
    lanesAt,
    fwdLanesAt,
    backLanesAt,
    leftWidthAt,
    rightWidthAt,
    halfWidthAt,
    hasCenterlineAt,
    centerlineLateralAt,
    driveBoundsAt,
    laneCenterAt,
    turnExclusions,
    terrainElevationAt,
    elevationAt,
    surfaceElevationAt,
    roadAttachmentHalfWidthAt,
    gradeAt,
    speedLimitAt,
    speedLimitKmhAt,
  };
}

export function setActiveRouteRuntime(runtime) {
  activeRuntime = runtime;
}

export function getActiveRouteRuntime() {
  return activeRuntime;
}

function networkNodeAt(s) {
  return activeRuntime ? activeRuntime.networkNodeAt(s) : { y: 0 };
}

export function sectionAt(s) {
  return activeRuntime ? activeRuntime.sectionAt(s) : FALLBACK_SECTION;
}
export function lanesAt(s) { return activeRuntime ? activeRuntime.lanesAt(s) : 2; }
export function fwdLanesAt(s) { return activeRuntime ? activeRuntime.fwdLanesAt(s) : 1; }
export function backLanesAt(s) { return activeRuntime ? activeRuntime.backLanesAt(s) : 1; }
export function leftWidthAt(s) { return activeRuntime ? activeRuntime.leftWidthAt(s) : 4; }
export function rightWidthAt(s) { return activeRuntime ? activeRuntime.rightWidthAt(s) : 4; }
export function halfWidthAt(s) { return activeRuntime ? activeRuntime.halfWidthAt(s) : 4; }
export function hasCenterlineAt(s) { return activeRuntime ? activeRuntime.hasCenterlineAt(s) : false; }
export function centerlineLateralAt(x, z, s) {
  return activeRuntime ? activeRuntime.centerlineLateralAt(x, z, s) : 0;
}
export function driveBoundsAt(s) {
  return activeRuntime ? activeRuntime.driveBoundsAt(s) : { left: 4, right: 4 };
}
export function laneCenterAt() { return 0; }
export function turnExclusions() {
  return activeRuntime ? activeRuntime.turnExclusions() : [];
}
export function terrainElevationAt(s) { return networkNodeAt(s).y; }
export function elevationAt(s) { return networkNodeAt(s).y; }
export function surfaceElevationAt(s) { return networkNodeAt(s).y; }
export function roadAttachmentHalfWidthAt(s) {
  return activeRuntime ? activeRuntime.roadAttachmentHalfWidthAt(s) : 7.4;
}
export function gradeAt(s) { return activeRuntime ? activeRuntime.gradeAt(s) : 0; }
export function speedLimitAt(s) { return activeRuntime ? activeRuntime.speedLimitAt(s) : 40 / 3.6; }
export function speedLimitKmhAt(s) { return activeRuntime ? activeRuntime.speedLimitKmhAt(s) : 40; }
