#!/usr/bin/env node
import fs from "node:fs";

const required = [
  "src/world/declarative/continuousTerrain.js",
  "src/world/declarative/PlateauWorldRenderer.js",
  "tools/world/terrain_grid.py",
];
for (const file of required) {
  if (!fs.existsSync(file)) throw new Error(`Missing terrain fix file: ${file}`);
}
const routeData = fs.readFileSync("src/route/routeData.js", "utf8");
if (!routeData.includes("export function terrainElevationAt")) throw new Error("terrainElevationAt is not exported");
const main = fs.readFileSync("src/main.js", "utf8");
if (!main.includes("buildContinuousTerrain")) throw new Error("continuous terrain is not wired into main.js");
const renderer = fs.readFileSync("src/world/declarative/PlateauWorldRenderer.js", "utf8");
if (!renderer.includes("detailedShell") || !renderer.includes("connected-grid")) throw new Error("renderer safeguards are missing");
if (!renderer.includes("partitionPolygonByConvex") || !renderer.includes("sourceTriangles")) throw new Error("PLATEAU polygon union subtraction is missing");
if (renderer.includes("routeRoadCutFeatures") || renderer.includes("terrainCutMaxEdge")) throw new Error("OSM route ribbons still cut terrain");
console.log(JSON.stringify({ status: "terrain-fix-structure-ok" }, null, 2));
