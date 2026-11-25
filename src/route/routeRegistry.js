export const DEFAULT_ROUTE_ID = "kyoto-18";

export const ROUTES = {
  "kyoto-18": {
    id: "kyoto-18",
    aliases: ["18"],
    regionId: "kyoto",
    label: "18号系統 (二条駅西口 → 久我石原町)",
    loadRawRoute: () => import("../data/routes/kyoto-18/route.json").then((m) => m.default),
    drivingNetworkUrl: (base = "/") => `${base}world/routes/kyoto-18/generated/driving-network.json`,
    worldManifestUrl: (base = "/") => `${base}world/routes/kyoto-18/world-manifest.json`,
    loadTerrainGrid: () =>
      import("../world/declarative/generated/kyoto-18/terrain-grid.json").then((m) => m.default),
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

export const ROUTE_ALIASES = Object.freeze({
  "18": "kyoto-18",
});

export function listRoutes() {
  return Object.values(ROUTES).map(({ id, regionId, aliases, label }) => ({
    id,
    regionId,
    aliases,
    label,
  }));
}

export function resolveRouteId(search = "") {
  const params = new URLSearchParams(search);
  const requested = params.get("route");
  if (!requested) return DEFAULT_ROUTE_ID;
  const canonical = ROUTE_ALIASES[requested] ?? requested;
  return Object.hasOwn(ROUTES, canonical) ? canonical : DEFAULT_ROUTE_ID;
}
