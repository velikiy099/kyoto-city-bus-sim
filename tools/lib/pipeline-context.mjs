import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = path.resolve(TOOLS_DIR, "..");
export const DEFAULT_ROUTE_ID = "kyoto-18";

const readJson = (absPath) => JSON.parse(fs.readFileSync(absPath, "utf8"));

export function resolveRoot(relativePath) {
  return path.resolve(ROOT, relativePath);
}

export function listPipelineRoutes() {
  const routesDir = resolveRoot("data/routes");
  if (!fs.existsSync(routesDir)) return [];
  const entries = fs.readdirSync(routesDir, { withFileTypes: true });
  const list = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const routeFile = path.join(routesDir, entry.name, "route.json");
    if (!fs.existsSync(routeFile)) continue;
    const data = readJson(routeFile);
    list.push({
      id: data.id ?? entry.name,
      aliases: data.aliases ?? [],
      regionId: data.regionId ?? "kyoto",
      path: routeFile,
    });
  }
  return list;
}

export function resolvePipelineRouteId(rawId = DEFAULT_ROUTE_ID) {
  const routes = listPipelineRoutes();
  const normalized = String(rawId || DEFAULT_ROUTE_ID).trim();
  for (const r of routes) {
    if (r.id === normalized || r.aliases.includes(normalized)) return r.id;
  }
  return DEFAULT_ROUTE_ID;
}

function argValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.split("=").slice(1).join("=") : null;
}

export function routeIdFromArgv(argv = process.argv) {
  const explicit = argValue(argv, "--route-id");
  if (explicit) return resolvePipelineRouteId(explicit);
  const routeArg = argValue(argv, "--route");
  if (routeArg && !routeArg.endsWith(".json")) {
    return resolvePipelineRouteId(routeArg);
  }
  if (routeArg && routeArg.endsWith(".json")) {
    const routes = listPipelineRoutes();
    const resolved = path.resolve(routeArg);
    for (const r of routes) {
      if (resolved.includes(`${path.sep}${r.id}${path.sep}`)) return r.id;
    }
  }
  return DEFAULT_ROUTE_ID;
}

export function loadRegionContext(regionId = "kyoto") {
  const regionDir = resolveRoot(`data/regions/${regionId}`);
  const regionPath = path.join(regionDir, "region.json");
  if (!fs.existsSync(regionPath)) {
    throw new Error(`Region config not found: ${regionPath}`);
  }
  const region = readJson(regionPath);
  const patchesDir = path.join(regionDir, "osm-patches");
  const loadPatch = (name) => {
    const file = path.join(patchesDir, `${name}.json`);
    return fs.existsSync(file) ? readJson(file) : {};
  };
  return {
    regionId: region.id ?? regionId,
    regionPath,
    region,
    patches: {
      roads: loadPatch("roads"),
      intersections: loadPatch("intersections"),
      structures: loadPatch("structures"),
      terminusTurnarounds: loadPatch("terminus-turnarounds"),
    },
  };
}

export function loadPipelineContext(routeIdInput = DEFAULT_ROUTE_ID) {
  const routeId = resolvePipelineRouteId(routeIdInput);
  const routeDefPath = resolveRoot(`data/routes/${routeId}/route.json`);
  if (!fs.existsSync(routeDefPath)) {
    throw new Error(`Route config not found: ${routeDefPath}`);
  }
  const route = readJson(routeDefPath);
  const regionCtx = loadRegionContext(route.regionId ?? "kyoto");
  const publicDirRel = `public/world/routes/${routeId}/generated`;
  const selectedPreferred = `data/work/plateau/selected/${routeId}`;
  const selectedLegacy = "data/work/plateau/selected";
  const selectedCitygmlRel = fs.existsSync(resolveRoot(selectedPreferred))
    ? selectedPreferred
    : fs.existsSync(resolveRoot(selectedLegacy))
      ? selectedLegacy
      : selectedPreferred;

  const paths = {
    routeFile: `src/data/routes/${routeId}/route.json`,
    osmVisualSource: `data/osm/${routeId}-corridor.json`,
    publicDirectory: publicDirRel,
    plateauBuildings: `${publicDirRel}/plateau-buildings.json`,
    plateauTransportation: `${publicDirRel}/plateau-transportation.json`,
    plateauTerrain: `${publicDirRel}/plateau-terrain.json`,
    plateauBridges: `${publicDirRel}/plateau-bridges.json`,
    plateauFurniture: `${publicDirRel}/plateau-furniture.json`,
    plateauWater: `${publicDirRel}/plateau-water.json`,
    plateauVegetation: `${publicDirRel}/plateau-vegetation.json`,
    osmOverlays: `${publicDirRel}/osm-road-overlays.json`,
    drivingNetwork: `${publicDirRel}/driving-network.json`,
    worldManifest: `public/world/routes/${routeId}/world-manifest.json`,
    routeElevation: `src/world/declarative/generated/${routeId}/route-elevation.json`,
    terrainGrid: `src/world/declarative/generated/${routeId}/terrain-grid.json`,
    report: `data/work/plateau/${routeId}/build-report.json`,
    resolvedConfig: `data/work/plateau/${routeId}/resolved-config.json`,
    selectedCitygmlDir: selectedCitygmlRel,
    plateauArchive: `data/raw/plateau/${regionCtx.region.plateau.archiveName}`,
  };

  const worldConfig = {
    version: 3,
    regionId: regionCtx.regionId,
    routeId,
    plateau: regionCtx.region.plateau,
    terrainRebuild: regionCtx.region.terrainRebuild,
    osm: {
      ...(regionCtx.region.osm ?? {}),
      relationId: route.osm?.relationId,
      routeFile: paths.routeFile,
      refreshCommand: `npm run build-data -- --route-id ${routeId}`,
    },
    integration: regionCtx.region.integration,
    output: paths,
  };

  return {
    routeId,
    routeDefPath,
    route,
    regionId: regionCtx.regionId,
    regionPath: regionCtx.regionPath,
    region: regionCtx.region,
    patches: regionCtx.patches,
    paths,
    worldConfig,
    resolveRoot,
  };
}

export function writeResolvedWorldConfig(ctx) {
  const target = resolveRoot(ctx.paths.resolvedConfig);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(ctx.worldConfig, null, 2)}\n`);
  return target;
}
