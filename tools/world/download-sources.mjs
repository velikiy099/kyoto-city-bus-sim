#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ensureCommand, flag, resolveRoot, run, valueAfter } from "./lib.mjs";
import { loadPipelineContext, loadRegionContext, routeIdFromArgv } from "../lib/pipeline-context.mjs";

const regionArg = valueAfter("--region-id");
const cfg = regionArg
  ? loadRegionContext(regionArg).region
  : loadPipelineContext(routeIdFromArgv()).worldConfig;
const archive = resolveRoot(`data/raw/plateau/${cfg.plateau.archiveName}`);
const force = flag("--force");

ensureCommand("curl");
ensureCommand("unzip");
fs.mkdirSync(path.dirname(archive), { recursive: true });

if (force && fs.existsSync(archive)) fs.rmSync(archive);
if (!fs.existsSync(archive)) {
  console.log(`Downloading PLATEAU CityGML:\n  ${cfg.plateau.downloadUrl}`);
  run("curl", [
    "--fail",
    "--location",
    "--retry", "5",
    "--retry-all-errors",
    "--continue-at", "-",
    "--output", archive,
    cfg.plateau.downloadUrl,
  ]);
} else {
  console.log(`PLATEAU archive cache hit: ${path.relative(process.cwd(), archive)}`);
}

console.log("Checking ZIP central directory...");
run("unzip", ["-tq", archive]);
console.log(`Ready: ${archive}`);
