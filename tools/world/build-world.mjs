#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { flag, resolveRoot, run, valueAfter } from "./lib.mjs";
import { loadPipelineContext, routeIdFromArgv, writeResolvedWorldConfig } from "../lib/pipeline-context.mjs";

const ctx = loadPipelineContext(routeIdFromArgv());
const cfg = ctx.worldConfig;
const routeFile = path.resolve(valueAfter("--route") ?? resolveRoot(cfg.osm.routeFile));
const skipExtract = flag("--skip-extract") || Boolean(valueAfter("--citygml-dir"));
const inputDir = path.resolve(
  valueAfter("--citygml-dir")
  ?? (skipExtract ? resolveRoot(ctx.paths.selectedCitygmlDir) : resolveRoot(`data/work/plateau/selected/${ctx.routeId}`)),
);
const archive = path.resolve(valueAfter("--archive") ?? resolveRoot(ctx.paths.plateauArchive));
const refreshOsm = flag("--refresh-osm");

if (refreshOsm) {
  console.log(`Refreshing OSM route and traffic source data for ${ctx.routeId}...`);
  run("npm", ["run", "build-data", "--", "--route-id", ctx.routeId, "--refresh-osm"]);
}
if (!fs.existsSync(routeFile)) throw new Error(`Route data not found: ${routeFile}`);
const osmVisualSource = resolveRoot(cfg.output.osmVisualSource);
if (!fs.existsSync(osmVisualSource)) {
  throw new Error(`OSM visual source not found: ${osmVisualSource}\nRun npm run build-data -- --route-id ${ctx.routeId} to refresh OSM display data.`);
}
run("node", [resolveRoot("tools/world/setup-python.mjs")]);
if (!skipExtract) {
  if (!fs.existsSync(archive)) throw new Error(`CityGML archive not found: ${archive}\nRun npm run world:download first.`);
  run("node", [
    resolveRoot("tools/world/select-citygml.mjs"),
    "--route-id", ctx.routeId,
    "--archive", archive,
    "--route", routeFile,
    "--output", inputDir,
  ]);
}
if (!fs.existsSync(inputDir)) throw new Error(`Selected CityGML directory not found: ${inputDir}`);

const resolvedConfigPath = writeResolvedWorldConfig(ctx);
const python = process.platform === "win32"
  ? resolveRoot(".venv-world/Scripts/python.exe")
  : resolveRoot(".venv-world/bin/python3");
const out = cfg.output;
run(python, [
  resolveRoot("tools/world/convert_citygml.py"),
  "--input-dir", inputDir,
  "--route", routeFile,
  "--config", resolvedConfigPath,
  "--buildings", resolveRoot(out.plateauBuildings),
  "--transportation", resolveRoot(out.plateauTransportation),
  "--terrain", resolveRoot(out.plateauTerrain),
  "--bridges", resolveRoot(out.plateauBridges),
  "--furniture", resolveRoot(out.plateauFurniture),
  "--water", resolveRoot(out.plateauWater),
  "--vegetation", resolveRoot(out.plateauVegetation),
  "--osm-visual-source", osmVisualSource,
  "--osm-overlays", resolveRoot(out.osmOverlays),
  "--route-elevation", resolveRoot(out.routeElevation),
  "--manifest", resolveRoot(out.worldManifest),
  "--report", resolveRoot(out.report),
]);
// The driving network and browser runtime must read the exact same terrain
// grid.  Rebuild the runtime copy before deriving lane/road elevations.
run(python, [
  resolveRoot("tools/world/rebuild_generated_terrain.py"),
  "--config", resolvedConfigPath,
  "--route", routeFile,
  "--profile", resolveRoot(out.routeElevation),
  "--terrain", resolveRoot(out.plateauTerrain),
  "--buildings", resolveRoot(out.plateauBuildings),
  "--transportation", resolveRoot(out.plateauTransportation),
  "--output-runtime", resolveRoot(out.terrainGrid),
  "--manifest", resolveRoot(out.worldManifest),
]);
run("node", [
  resolveRoot("tools/world/build-driving-network.mjs"),
  "--route-id", ctx.routeId,
  "--route", routeFile,
  "--transportation", resolveRoot(out.plateauTransportation),
  "--terrain", resolveRoot(out.plateauTerrain),
  "--osm-source", osmVisualSource,
  "--output", resolveRoot(out.drivingNetwork),
]);
run(python, [
  resolveRoot("tools/world/convert_citygml.py"),
  "--overlays-only",
  "--transportation", resolveRoot(out.plateauTransportation),
  "--osm-visual-source", osmVisualSource,
  "--driving-network", resolveRoot(out.drivingNetwork),
  "--osm-overlays", resolveRoot(out.osmOverlays),
  "--manifest", resolveRoot(out.worldManifest),
  "--report", resolveRoot(out.report),
]);
run("node", [resolveRoot("tools/world/validate-world-data.mjs"), "--route-id", ctx.routeId]);
console.log(`OSM + PLATEAU declarative world data is ready for ${ctx.routeId}.`);
console.log(`Run npm run build, then open the simulator with ?route=${ctx.routeId}.`);
