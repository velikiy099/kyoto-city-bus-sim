#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const required = [
  "src/main.js",
  "src/route/routeData.js",
  "src/world/declarative/buildWorldScenery.js",
  "src/world/declarative/PlateauWorldRenderer.js",
  "src/world/declarative/generated/route-elevation.json",
  "tools/world/world.config.json",
  "tools/world/download-sources.mjs",
  "tools/world/select-citygml.mjs",
  "tools/world/build-world.mjs",
  "tools/world/convert_citygml.py",
  "public/world/world-manifest.json",
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Missing integration file: ${relative}`);
}
const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
if (!main.includes('import { buildWorldScenery } from "./world/declarative/buildWorldScenery.js";')) throw new Error("main.js does not import buildWorldScenery");
if (!main.includes("void buildWorldScenery(scene, path, route")) throw new Error("main.js does not start declarative world initialization");
for (const preservedImport of [
  './bus/busPhysics.js', './game/stops.js', './game/passengers.js', './game/scoring.js',
  './game/gameState.js', './world/traffic/index.js', './audio/sfx.js', './audio/announcements.js',
]) {
  if (!main.includes(preservedImport)) throw new Error(`Existing gameplay import disappeared: ${preservedImport}`);
}
const routeData = fs.readFileSync(path.join(root, "src/route/routeData.js"), "utf8");
if (!routeData.includes("drivingNetwork.nodes")) throw new Error("routeData.js is not connected to the compiled PLATEAU driving network");
if (!routeData.includes("export function terrainElevationAt(s) { return networkNodeAt(s).y; }")) throw new Error("Terrain height is not read from compiled driving-network nodes");
if (!routeData.includes("export function elevationAt(s) { return networkNodeAt(s).y; }")) throw new Error("Road height is not read from the compiled driving-network profile");
if (!routeData.includes("elevations: drivingNetwork.structures")) throw new Error("Compiled bridge/overpass structures are not exposed to the runtime");
if (routeData.includes("road-elevation.json")) throw new Error("Obsolete second road elevation profile is still imported");
const config = JSON.parse(fs.readFileSync(path.join(root, "tools/world/world.config.json"), "utf8"));
if (!config.plateau.downloadUrl.includes("26100_kyoto-shi_city_2025_citygml_1_op.zip")) throw new Error("Unexpected PLATEAU source URL");
const expectedTypes = ["bldg", "tran", "dem", "brid", "frn", "wtr", "veg"];
for (const type of expectedTypes) if (!config.plateau.featureTypes.includes(type)) throw new Error(`Missing PLATEAU feature type: ${type}`);
console.log(JSON.stringify({
  status: "integration-structure-ok",
  plateauSource: config.plateau.downloadUrl,
  featureTypes: config.plateau.featureTypes,
  preservedSystems: ["bus physics", "operations", "stops", "passengers", "scoring", "traffic AI", "audio", "HUD"],
}, null, 2));
