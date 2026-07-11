#!/usr/bin/env node
import fs from "node:fs";
import { config, readJson, resolveRoot } from "./lib.mjs";

const cfg = config();
const files = {
  manifest: cfg.output.worldManifest,
  buildings: cfg.output.plateauBuildings,
  transportation: cfg.output.plateauTransportation,
  terrain: cfg.output.plateauTerrain,
  bridges: cfg.output.plateauBridges,
  furniture: cfg.output.plateauFurniture,
  water: cfg.output.plateauWater,
  vegetation: cfg.output.plateauVegetation,
  osmNetwork: cfg.output.osmNetwork,
  routeElevation: cfg.output.routeElevation,
};
for (const [name, relative] of Object.entries(files)) {
  const file = resolveRoot(relative);
  if (!fs.existsSync(file)) throw new Error(`${name} output is missing: ${file}`);
}
const data = Object.fromEntries(Object.entries(files).map(([name, relative]) => [name, readJson(resolveRoot(relative))]));
if (data.manifest.version !== 3 || !Array.isArray(data.manifest.layers)) throw new Error("Invalid world manifest");
if (!Array.isArray(data.buildings.features)) throw new Error("Invalid building layer");
if (!Array.isArray(data.transportation.features)) throw new Error("Invalid transportation layer");
if (!Array.isArray(data.terrain.triangles)) throw new Error("Invalid terrain layer");
if (!Array.isArray(data.routeElevation.samples)) throw new Error("Invalid route elevation profile");
if (!Array.isArray(data.osmNetwork.signals) || !Array.isArray(data.osmNetwork.intersections)) throw new Error("Invalid OSM network layer");

const ids = new Set();
for (const building of data.buildings.features) {
  if (!building.id || ids.has(building.id)) throw new Error(`Missing or duplicate building id: ${building.id}`);
  ids.add(building.id);
  if (!Array.isArray(building.footprint) || building.footprint.length < 3) throw new Error(`Invalid footprint: ${building.id}`);
  if (!(Number(building.height) >= 2.8)) throw new Error(`Invalid building height: ${building.id}`);
}
for (const triangle of data.terrain.triangles.slice(0, 1000)) {
  if (!Array.isArray(triangle) || triangle.length !== 3 || triangle.some((point) => !Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite))) {
    throw new Error("Invalid terrain triangle");
  }
}
for (const surface of [...data.transportation.features, ...data.bridges.features, ...data.water.features, ...data.vegetation.features].slice(0, 5000)) {
  if (!Array.isArray(surface.polygon) || surface.polygon.length < 3) throw new Error(`Invalid surface polygon: ${surface.id}`);
}
console.log(JSON.stringify({
  status: data.manifest.status,
  plateauYear: data.manifest.sources?.plateau?.year,
  osmRelationId: data.manifest.sources?.osm?.relationId,
  counts: {
    buildings: data.buildings.features.length,
    transportation: data.transportation.features.length,
    terrainTriangles: data.terrain.triangles.length,
    bridges: data.bridges.features.length,
    furniture: data.furniture.features.length,
    water: data.water.features.length,
    vegetation: data.vegetation.features.length,
    routeElevationSamples: data.routeElevation.samples.length,
  },
}, null, 2));
