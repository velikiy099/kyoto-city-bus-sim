export const DEFAULT_REGION_ID = "kyoto";

export const REGIONS = {
  kyoto: {
    id: "kyoto",
    name: "京都市",
    projOrigin: [34.9746902, 135.7422893],
    defaultOperatorName: "京都市バス",
    definitions: {
      landmarks: () =>
        import("../data/definitions/landmarks.json").then((m) => m.default),
      nature: () =>
        import("../data/definitions/nature.json").then((m) => m.default),
      railways: () =>
        import("../data/definitions/railways.json").then((m) => m.default),
      signals: () =>
        import("../data/definitions/signals.json").then((m) => m.default),
      npcVehicles: () =>
        import("../data/definitions/npc-vehicles.json").then((m) => m.default),
    },
  },
};

export function getRegionDescriptor(regionId = DEFAULT_REGION_ID) {
  return REGIONS[regionId] ?? REGIONS[DEFAULT_REGION_ID];
}
