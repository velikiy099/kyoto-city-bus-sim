export const WORLD_CONFIG = Object.freeze({
  manifestUrl: "/world/world-manifest.json",
  queryParameter: "world",
  defaultMode: "hybrid",
  validModes: ["hybrid", "plateau", "legacy"],
  fallbackToLegacy: true,
  render: {
    // The currently generated PLATEAU layers do not share a reliable vertical
    // reference with the legacy ground/road mesh. Rendering them together causes
    // buildings to float or sink, vehicles to appear buried, and overlapping road
    // surfaces to produce visibly broken intersections.
    //
    // Keep the declarative loader and generated data available for diagnostics,
    // but use the stable OSM-derived/hand-authored world until the converter emits
    // a continuous terrain surface and validated building shells. With buildings
    // disabled, buildWorldScenery automatically invokes the legacy building
    // fallback; hybrid mode also retains the existing nature and landmarks.
    terrain: false,
    transportation: false,
    buildings: false,
    bridges: false,
    water: false,
    vegetation: false,
    furniture: false,
  },
});
