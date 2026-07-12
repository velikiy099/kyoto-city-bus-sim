export const WORLD_CONFIG = Object.freeze({
  manifestUrl: "/world/world-manifest.json",
  defaultMode: "plateau",
  fallbackToLegacy: false,
  render: {
    // main.js creates the connected PLATEAU grid synchronously so all systems can
    // sample it before asynchronous scenery loading. The renderer replaces that
    // provisional mesh with the transportation-cut version once the manifest loads.
    terrain: true,
    // PLATEAU transportation remains the visible road-surface source. OSM-derived
    // road markings and sidewalks are loaded as clipped overlays above it.
    transportation: true,
    osmRouteSurface: false,
    osmExtraRoadSurfaces: false,
    buildings: true,
    // The selected Kyoto PLATEAU tiles contain no usable features for these layers.
    // Route structure annotations provide the fallback and are ground-snapped.
    bridges: false,
    water: false,
    vegetation: false,
    furniture: false,
  },
});
