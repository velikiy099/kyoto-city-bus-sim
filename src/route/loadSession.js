import { getRegionDescriptor } from "../world/regionRegistry.js";
import { createRouteRuntime, setActiveRouteRuntime } from "./routeData.js";
import { DEFAULT_ROUTE_ID, ROUTES } from "./routeRegistry.js";

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load JSON (${response.status}): ${url}`);
  }
  return response.json();
}

/**
 * Load a complete playable session separated into three explicit layers:
 * - region: city/area-level shared metadata and definition catalogs
 * - world: compiled map/terrain/road/traffic/scenery runtime without route semantics
 * - route: service route path, stops, timetable, announcements and headsign phases
 */
export async function loadSessionBundle(
  routeId = DEFAULT_ROUTE_ID,
  baseUrl = import.meta.env.BASE_URL ?? "/",
) {
  const routeEntry = ROUTES[routeId] ?? ROUTES[DEFAULT_ROUTE_ID];
  const regionEntry = getRegionDescriptor(routeEntry.regionId);
  const drivingNetworkUrl = routeEntry.drivingNetworkUrl(baseUrl);

  const [
    raw,
    drivingNetwork,
    terrainGrid,
    landmarks,
    nature,
    railways,
    signals,
    npcVehicles,
    semantics,
    timetable,
    announcements,
  ] = await Promise.all([
    routeEntry.loadRawRoute(),
    fetchJson(drivingNetworkUrl),
    routeEntry.loadTerrainGrid(),
    regionEntry.definitions.landmarks(),
    regionEntry.definitions.nature(),
    regionEntry.definitions.railways(),
    regionEntry.definitions.signals(),
    regionEntry.definitions.npcVehicles(),
    routeEntry.definitions.semantics(),
    routeEntry.definitions.timetable(),
    routeEntry.definitions.announcements(),
  ]);

  const routeRuntime = createRouteRuntime(raw, drivingNetwork, semantics);
  setActiveRouteRuntime(routeRuntime);
  const internalRoute = routeRuntime.route;

  const region = {
    id: regionEntry.id,
    name: regionEntry.name,
    projOrigin: regionEntry.projOrigin,
    defaultOperatorName: regionEntry.defaultOperatorName,
    definitions: {
      landmarks,
      nature,
      railways,
      signals,
      npcVehicles,
    },
  };

  const world = {
    regionId: region.id,
    terrainGrid,
    worldManifestUrl: routeEntry.worldManifestUrl(baseUrl),
    surfacePath: internalRoute.surfacePath,
    drivingNetwork,
    roadSections: internalRoute.roadSections,
    intersections: internalRoute.intersections,
    turnIntersections: internalRoute.turnIntersections,
    bridges: internalRoute.bridges,
    rivers: internalRoute.rivers,
    waterPolygons: internalRoute.waterPolygons,
    osmExpressways: internalRoute.osmExpressways,
    osmVegetation: internalRoute.osmVegetation,
    railStructures: internalRoute.railStructures,
    elevations: internalRoute.elevations,
    signals: internalRoute.signals,
    trafficPaths: internalRoute.trafficPaths,
    trafficGraph: internalRoute.trafficGraph,
    definitions: region.definitions,
    leftWidthAt: routeRuntime.leftWidthAt,
    rightWidthAt: routeRuntime.rightWidthAt,
    halfWidthAt: routeRuntime.halfWidthAt,
    driveBoundsAt: routeRuntime.driveBoundsAt,
    laneCenterAt: routeRuntime.laneCenterAt,
    turnExclusions: routeRuntime.turnExclusions,
    terrainElevationAt: routeRuntime.terrainElevationAt,
    elevationAt: routeRuntime.elevationAt,
    surfaceElevationAt: routeRuntime.surfaceElevationAt,
    roadAttachmentHalfWidthAt: routeRuntime.roadAttachmentHalfWidthAt,
    gradeAt: routeRuntime.gradeAt,
  };

  const route = {
    id: routeEntry.id,
    regionId: region.id,
    name: internalRoute.name,
    source: internalRoute.source,
    scale: internalRoute.scale,
    path: internalRoute.path,
    terminalStop: internalRoute.terminalStop,
    stops: internalRoute.stops,
    speedZones: internalRoute.speedZones,
    autoLaneGuides: internalRoute.autoLaneGuides,
    semantics,
    definitions: {
      semantics,
      timetable,
      announcements,
    },
    speedLimitAt: routeRuntime.speedLimitAt,
    speedLimitKmhAt: routeRuntime.speedLimitKmhAt,
    driveBoundsAt: routeRuntime.driveBoundsAt,
    hasCenterlineAt: routeRuntime.hasCenterlineAt,
    centerlineLateralAt: routeRuntime.centerlineLateralAt,
    elevationAt: routeRuntime.elevationAt,
    surfaceElevationAt: routeRuntime.surfaceElevationAt,
    gradeAt: routeRuntime.gradeAt,
  };

  return { region, world, route, routeRuntime };
}
