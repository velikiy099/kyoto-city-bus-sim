import { WORLD_CONFIG } from "./config.js";
import { PlateauWorldRenderer, loadWorldManifest } from "./PlateauWorldRenderer.js";

const asArray = (value) => Array.isArray(value) ? value : [];

function selectedMode() {
  const requested = new URLSearchParams(window.location.search).get(WORLD_CONFIG.queryParameter);
  return WORLD_CONFIG.validModes.includes(requested) ? requested : WORLD_CONFIG.defaultMode;
}

function buildLegacy(scene, path, route, builders) {
  builders.buildRailways(scene, path, route.railStructures);
  const exclusions = [
    ...asArray(builders.buildLandmarks(scene, path)),
    ...asArray(builders.buildNature(scene, path)),
    ...asArray(builders.turnExclusions()),
  ];
  builders.buildBuildings(scene, path, exclusions, route.buildings);
  return { mode: "legacy", exclusions, plateau: null };
}

/**
 * Builds only scenery. The existing road drive mesh, bus physics, stops, passengers,
 * scoring, timetable, audio, extra roads and traffic AI stay in their original modules.
 */
export async function buildWorldScenery(scene, path, route, builders) {
  const mode = selectedMode();
  if (mode === "legacy") return buildLegacy(scene, path, route, builders);

  // Preserve detailed hand-authored landmarks and railway structures. They act as
  // explicit overrides on top of PLATEAU, and their exclusion circles suppress
  // overlapping generic PLATEAU buildings.
  builders.buildRailways(scene, path, route.railStructures);
  const landmarkExclusions = asArray(builders.buildLandmarks(scene, path));
  const natureExclusions = mode === "hybrid" ? asArray(builders.buildNature(scene, path)) : [];
  const exclusions = [...landmarkExclusions, ...natureExclusions, ...asArray(builders.turnExclusions())];

  try {
    const manifest = await loadWorldManifest(WORLD_CONFIG.manifestUrl);
    const renderer = new PlateauWorldRenderer(scene, {
      exclusions,
      enabled: WORLD_CONFIG.render,
    });
    const plateau = await renderer.load(manifest);
    if (!plateau.hasPlateauBuildings) {
      builders.buildBuildings(scene, path, exclusions, route.buildings);
    }
    console.info("OSM + PLATEAU world loaded", { mode, counts: plateau.counts });
    return { mode, exclusions, plateau, manifest };
  } catch (error) {
    console.warn("PLATEAU world data could not be loaded; using legacy OSM scenery.", error);
    if (!WORLD_CONFIG.fallbackToLegacy) throw error;
    // Railways and landmarks were already created above, so only add missing legacy
    // nature/buildings here to avoid duplicates.
    const fallbackNature = mode === "hybrid" ? [] : asArray(builders.buildNature(scene, path));
    const fallbackExclusions = [...exclusions, ...fallbackNature];
    builders.buildBuildings(scene, path, fallbackExclusions, route.buildings);
    return { mode: "legacy-fallback", exclusions: fallbackExclusions, plateau: null, error };
  }
}
