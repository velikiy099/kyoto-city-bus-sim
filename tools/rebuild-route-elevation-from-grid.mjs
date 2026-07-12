#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoutePath } from "../src/route/path.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const route = JSON.parse(readFileSync(join(ROOT, "src/data/route18.json"), "utf8"));
const grid = JSON.parse(
  readFileSync(join(ROOT, "src/world/declarative/generated/terrain-grid.json"), "utf8"),
);
const output = join(ROOT, "src/world/declarative/generated/route-elevation.json");

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const [originX, originZ] = grid.origin;
const [stepX, stepZ] = Array.isArray(grid.spacing)
  ? grid.spacing
  : [grid.spacing, grid.spacing];
const width = Number(grid.width);
const height = Number(grid.height);
const values = grid.heights;

function at(ix, iz) {
  const x = clamp(ix, 0, width - 1);
  const z = clamp(iz, 0, height - 1);
  return Number(values[z * width + x] ?? 0);
}

function sampleGrid(x, z) {
  const gx = clamp((x - originX) / stepX, 0, width - 1);
  const gz = clamp((z - originZ) / stepZ, 0, height - 1);
  const ix = Math.min(width - 2, Math.max(0, Math.floor(gx)));
  const iz = Math.min(height - 2, Math.max(0, Math.floor(gz)));
  const tx = gx - ix;
  const tz = gz - iz;
  const top = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * tx;
  const bottom = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * tx;
  return top + (bottom - top) * tz;
}

const path = new RoutePath(route.path);
const sampleStepMeters = 2;
const samples = [];
for (let s = 0; s < path.length; s += sampleStepMeters) {
  const [x, z] = path.getPoint(s);
  samples.push([+s.toFixed(3), +sampleGrid(x, z).toFixed(3)]);
}
const [endX, endZ] = path.getPoint(path.length);
samples.push([+path.length.toFixed(3), +sampleGrid(endX, endZ).toFixed(3)]);

writeFileSync(
  output,
  `${JSON.stringify(
    {
      version: 2,
      sampleStepMeters,
      verticalDatum: 0,
      generatedAt: new Date().toISOString(),
      source: "PLATEAU connected terrain grid sampled along current route18 path",
      samples,
    },
    null,
    2,
  )}\n`,
);
console.log(`route elevation rebuilt: ${samples.length} samples -> ${output}`);
