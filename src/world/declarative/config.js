export const WORLD_CONFIG = Object.freeze({
  manifestUrl: "/world/world-manifest.json",
  defaultMode: "plateau",
  fallbackToLegacy: false,
  render: {
    // main.js creates the connected PLATEAU grid synchronously so all systems can
    // sample it before asynchronous scenery loading. The renderer replaces that
    // provisional mesh with the transportation-cut version once the manifest loads.
    terrain: true,
    // Visible road/sidewalk surfaces come exclusively from PLATEAU transportation.
    // OSM remains route/network metadata for physics, stops, signals and traffic.
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
