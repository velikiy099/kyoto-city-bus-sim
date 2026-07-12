#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { config, ensureCommand, readJson, resolveRoot, run, valueAfter, writeJson } from "./lib.mjs";

const cfg = config();
const archive = path.resolve(valueAfter("--archive") ?? resolveRoot(`data/raw/plateau/${cfg.plateau.archiveName}`));
const outputDir = path.resolve(valueAfter("--output") ?? resolveRoot("data/work/plateau/selected"));
const routeFile = path.resolve(valueAfter("--route") ?? resolveRoot(cfg.osm.routeFile));

if (!fs.existsSync(archive)) throw new Error(`PLATEAU archive not found: ${archive}\nRun npm run world:download first.`);
if (!fs.existsSync(routeFile)) throw new Error(`OSM route data not found: ${routeFile}`);
ensureCommand("unzip");

const route = readJson(routeFile);
if (!Array.isArray(route.projOrigin) || !Array.isArray(route.path) || route.path.length < 2) {
  throw new Error("route18.json must contain projOrigin and path");
}

function unproject([x, z], [lat0, lon0]) {
  const kLat = 111320;
  const kLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return [lat0 - z / kLat, lon0 + x / kLon];
}

function routeBounds(padMeters) {
  const points = route.path.map((point) => unproject(point, route.projOrigin));
  const lats = points.map((point) => point[0]);
  const lons = points.map((point) => point[1]);
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const latPad = padMeters / 111320;
  const lonPad = padMeters / (111320 * Math.cos((centerLat * Math.PI) / 180));
  return {
    south: Math.min(...lats) - latPad,
    west: Math.min(...lons) - lonPad,
    north: Math.max(...lats) + latPad,
    east: Math.max(...lons) + lonPad,
  };
}

function meshBounds(code) {
  if (!/^\d{4}(?:\d{2})?(?:\d{2})?$/.test(code)) return null;
  const p = Number(code.slice(0, 2));
  const q = Number(code.slice(2, 4));
  let south = p / 1.5;
  let west = q + 100;
  let height = 40 / 60;
  let width = 1;
  if (code.length >= 6) {
    const r = Number(code[4]);
    const s = Number(code[5]);
    south += r * (5 / 60);
    west += s * (7.5 / 60);
    height = 5 / 60;
    width = 7.5 / 60;
  }
  if (code.length >= 8) {
    const t = Number(code[6]);
    const u = Number(code[7]);
    south += t * (30 / 3600);
    west += u * (45 / 3600);
    height = 30 / 3600;
    width = 45 / 3600;
  }
  return { south, west, north: south + height, east: west + width };
}

function intersects(a, b) {
  return a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;
}

function featureTypeOf(entry) {
  const normalized = `/${entry}`.toLowerCase();
  for (const type of cfg.plateau.featureTypes) {
    if (normalized.includes(`/udx/${type}/`) && normalized.endsWith(".gml")) return type;
  }
  return null;
}

function meshCodeOf(entry) {
  const filename = path.basename(entry);
  return filename.match(/^(\d{4}(?:\d{2})?(?:\d{2})?)_[a-z0-9]+_/i)?.[1] ?? null;
}

const commonBounds = routeBounds(cfg.plateau.corridorMeters);
const boundsByType = Object.fromEntries(cfg.plateau.featureTypes.map((type) => [
  type,
  routeBounds(type === "dem" ? (cfg.plateau.terrainCorridorMeters ?? cfg.plateau.corridorMeters) : cfg.plateau.corridorMeters),
]));
const listing = run("unzip", ["-Z1", archive], { capture: true });
const entries = listing.split(/\r?\n/).filter(Boolean);
const selectedByType = Object.fromEntries(cfg.plateau.featureTypes.map((type) => [type, []]));
const meshCodesByType = Object.fromEntries(cfg.plateau.featureTypes.map((type) => [type, new Set()]));

for (const entry of entries) {
  const type = featureTypeOf(entry);
  if (!type) continue;
  const code = meshCodeOf(entry);
  const mesh = code ? meshBounds(code) : null;
  const bounds = boundsByType[type] ?? commonBounds;
  if (!mesh || intersects(bounds, mesh)) {
    selectedByType[type].push(entry);
    if (code) meshCodesByType[type].add(code);
  }
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
for (const type of cfg.plateau.featureTypes) {
  const target = path.join(outputDir, type);
  fs.mkdirSync(target, { recursive: true });
  if (!selectedByType[type].length) {
    console.warn(`WARNING: no ${type} CityGML files intersected the route. The runtime will use its fallback.`);
    continue;
  }
  console.log(`Extracting ${selectedByType[type].length} ${type} files...`);
  // The route corridor normally intersects only a small number of PLATEAU mesh files.
  run("unzip", ["-j", archive, ...selectedByType[type], "-d", target]);
}

const selection = {
  version: 3,
  archive,
  routeFile,
  boundsByType,
  featureTypes: Object.fromEntries(cfg.plateau.featureTypes.map((type) => [type, {
    meshCodes: [...meshCodesByType[type]].sort(),
    files: selectedByType[type].map((entry) => path.basename(entry)).sort(),
  }])),
};
writeJson(resolveRoot("data/work/plateau/selection.json"), selection);
console.log(`Extracted selected CityGML to: ${outputDir}`);
