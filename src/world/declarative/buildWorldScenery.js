import { WORLD_CONFIG } from "./config.js";
import { PlateauWorldRenderer, loadWorldManifest } from "./PlateauWorldRenderer.js";
import { snapHierarchyToTerrain } from "./continuousTerrain.js";

const asArray = (value) => Array.isArray(value) ? value : [];

function captureAndSnap(scene, build, heightAtWorld) {
  const before = new Set(scene.children);
  const result = build();
  for (const child of scene.children) {
    if (!before.has(child)) snapHierarchyToTerrain(child, heightAtWorld);
  }
  return result;
}

/**
 * Build the PLATEAU-authoritative scenery.
 *
 * OSM-derived data is consumed as route/network structure metadata and clipped
 * road-marking/sidewalk overlays. Generic OSM building/ground
 * rendering is never added here. PLATEAU remains the terrain and road-surface source.
 * Where a route is structurally elevated, the matching carriageway portion of the
 * original PLATEAU transportation mesh is moved to the same height used by vehicles
 * and road furniture; no duplicate road plate is added.
 */
export async function buildWorldScenery(scene, path, route, builders) {
  const surfacePath = route.surfacePath ?? path;
  // Railway/viaduct builders already distinguish ground height from deck height.
  builders.buildRailways(scene, surfacePath, route.railStructures, route.osmExpressways ?? []);

  const landmarkExclusions = asArray(
    captureAndSnap(scene, () => builders.buildLandmarks(scene, surfacePath), builders.terrainHeightAtWorld),
  );
  const natureExclusions = asArray(builders.buildNature(scene, surfacePath));
  const exclusions = [
    ...landmarkExclusions,
    ...natureExclusions,
    ...asArray(builders.turnExclusions()),
  ];

  const manifest = await loadWorldManifest(WORLD_CONFIG.manifestUrl);
  const renderer = new PlateauWorldRenderer(scene, {
    exclusions,
    enabled: WORLD_CONFIG.render,
    routePath: route.surfacePath ?? path,
    routeData: route,
    terrainHeightAtWorld: builders.terrainHeightAtWorld,
    roadHeightAtWorld: builders.roadHeightAtWorld,
    routeHeightAtS: builders.elevationAt,
  });
  const plateau = await renderer.load(manifest);
  if (plateau.hasConnectedTerrain && builders.baseTerrain) builders.baseTerrain.visible = false;
  if (!plateau.hasPlateauBuildings) {
    throw new Error("PLATEAU building layer is empty; OSM building fallback is intentionally disabled.");
  }
  console.info("PLATEAU-authoritative world loaded", { counts: plateau.counts });
  return { mode: "plateau", exclusions, plateau, manifest };
}
