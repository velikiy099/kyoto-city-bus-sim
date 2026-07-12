#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { config, flag, resolveRoot, run, valueAfter } from "./lib.mjs";

const cfg = config();
const routeFile = path.resolve(valueAfter("--route") ?? resolveRoot(cfg.osm.routeFile));
const inputDir = path.resolve(valueAfter("--citygml-dir") ?? resolveRoot("data/work/plateau/selected"));
const archive = path.resolve(valueAfter("--archive") ?? resolveRoot(`data/raw/plateau/${cfg.plateau.archiveName}`));
const skipExtract = flag("--skip-extract") || Boolean(valueAfter("--citygml-dir"));
const refreshOsm = flag("--refresh-osm");

if (refreshOsm) {
  console.log("Refreshing OSM route and traffic source data...");
  run("npm", ["run", "build-data"]);
}
if (!fs.existsSync(routeFile)) throw new Error(`Route data not found: ${routeFile}`);
const osmVisualSource = resolveRoot(cfg.output.osmVisualSource);
if (!fs.existsSync(osmVisualSource)) {
  throw new Error(`OSM visual source not found: ${osmVisualSource}\nRun npm run build-data to refresh OSM display data.`);
}
run("node", [resolveRoot("tools/world/setup-python.mjs")]);
if (!skipExtract) {
  if (!fs.existsSync(archive)) throw new Error(`CityGML archive not found: ${archive}\nRun npm run world:download first.`);
  run("node", [resolveRoot("tools/world/select-citygml.mjs"), "--archive", archive, "--route", routeFile, "--output", inputDir]);
}
if (!fs.existsSync(inputDir)) throw new Error(`Selected CityGML directory not found: ${inputDir}`);

const python = process.platform === "win32"
  ? resolveRoot(".venv-world/Scripts/python.exe")
  : resolveRoot(".venv-world/bin/python3");
const out = cfg.output;
run(python, [
  resolveRoot("tools/world/convert_citygml.py"),
  "--input-dir", inputDir,
  "--route", routeFile,
  "--config", resolveRoot("tools/world/world.config.json"),
  "--buildings", resolveRoot(out.plateauBuildings),
  "--transportation", resolveRoot(out.plateauTransportation),
  "--terrain", resolveRoot(out.plateauTerrain),
  "--bridges", resolveRoot(out.plateauBridges),
  "--furniture", resolveRoot(out.plateauFurniture),
  "--water", resolveRoot(out.plateauWater),
  "--vegetation", resolveRoot(out.plateauVegetation),
  "--osm-network", resolveRoot(out.osmNetwork),
  "--osm-visual-source", osmVisualSource,
  "--osm-overlays", resolveRoot(out.osmOverlays),
  "--route-elevation", resolveRoot(out.routeElevation),
  "--manifest", resolveRoot(out.worldManifest),
  "--report", resolveRoot(out.report),
]);
run("node", [resolveRoot("tools/world/validate-world-data.mjs")]);
console.log("OSM + PLATEAU declarative world data is ready.");
console.log("Run npm run build, then open the simulator with ?world=hybrid.");
