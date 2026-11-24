export const DEFAULT_ROUTE_ID = "18";

export const ROUTES = {
  "18": {
    id: "18",
    regionId: "kyoto",
    label: "18号系統 (二条駅西口 → 久我石原町)",
    loadRawRoute: () => import("../data/route18.json").then((m) => m.default),
    drivingNetworkUrl: (base = "/") => `${base}world/generated/driving-network.json`,
    worldManifestUrl: (base = "/") => `${base}world/world-manifest.json`,
    loadTerrainGrid: () =>
      import("../world/declarative/generated/terrain-grid.json").then((m) => m.default),
    definitions: {
      semantics: () =>
        import("../data/definitions/route-semantics.json").then((m) => m.default),
      timetable: () =>
        import("../data/definitions/timetable.json").then((m) => m.default),
      announcements: () =>
        import("../data/definitions/announcements.json").then((m) => m.default),
    },
  },
};

export function listRoutes() {
  return Object.values(ROUTES).map(({ id, regionId, label }) => ({
    id,
    regionId,
    label,
  }));
}

export function resolveRouteId(search = "") {
  const params = new URLSearchParams(search);
  const requested = params.get("route");
  return requested && Object.hasOwn(ROUTES, requested) ? requested : DEFAULT_ROUTE_ID;
}
