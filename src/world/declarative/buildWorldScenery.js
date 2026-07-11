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
 * OSM-derived data is consumed only as route/network metadata by the existing road,
 * stop, signal and traffic systems. Generic OSM building/ground rendering is never
 * added here. Kyoto's selected PLATEAU package has no usable water/vegetation/bridge
 * features along the route, so the hand-authored route annotations remain as visual
 * fallbacks, but every one of them is placed on the shared PLATEAU terrain sampler.
 */
export async function buildWorldScenery(scene, path, route, builders) {
  // Railway/viaduct builders already distinguish ground height from deck height.
  builders.buildRailways(scene, path, route.railStructures);

  const landmarkExclusions = asArray(
    captureAndSnap(scene, () => builders.buildLandmarks(scene, path), builders.terrainHeightAtWorld),
  );
  const natureExclusions = asArray(builders.buildNature(scene, path));
  const exclusions = [
    ...landmarkExclusions,
    ...natureExclusions,
    ...asArray(builders.turnExclusions()),
  ];

  const manifest = await loadWorldManifest(WORLD_CONFIG.manifestUrl);
  const renderer = new PlateauWorldRenderer(scene, {
    exclusions,
    enabled: WORLD_CONFIG.render,
    routePath: path,
    routeData: route,
    terrainHeightAtWorld: builders.terrainHeightAtWorld,
    roadHeightAtWorld: builders.roadHeightAtWorld,
  });
  const plateau = await renderer.load(manifest);
  if (plateau.hasConnectedTerrain && builders.baseTerrain) builders.baseTerrain.visible = false;
  if (!plateau.hasPlateauBuildings) {
    throw new Error("PLATEAU building layer is empty; OSM building fallback is intentionally disabled.");
  }
  console.info("PLATEAU-authoritative world loaded", { counts: plateau.counts });
  return { mode: "plateau", exclusions, plateau, manifest };
}
