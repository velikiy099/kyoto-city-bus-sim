export const WORLD_CONFIG = Object.freeze({
  manifestUrl: "/world/world-manifest.json",
  queryParameter: "world",
  defaultMode: "hybrid",
  validModes: ["hybrid", "plateau", "legacy"],
  fallbackToLegacy: true,
  render: {
    // The DEM triangles are corridor-filtered and decimated independently per
    // triangle, so they lose mesh connectivity and render as disconnected,
    // gap-filled patches rather than a continuous ground surface. Route
    // elevation (elevationAt) and building/road base-height snapping already
    // consume the DEM data directly in the build step (route-elevation.json,
    // baseHeight/tranSurfaceSnappedToTerrain) and do not depend on this mesh,
    // so disabling the visual ground layer does not affect bus/road physics.
    terrain: false,
    transportation: true,
    buildings: true,
    bridges: true,
    water: true,
    vegetation: true,
    furniture: true,
  },
});
