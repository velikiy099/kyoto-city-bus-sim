import { existsSync } from "node:fs";
import { loadPipelineContext, resolveRoot, routeIdFromArgv } from "./lib/pipeline-context.mjs";

const ctx = loadPipelineContext(routeIdFromArgv());
const requiredFiles = [
  ctx.paths.routeFile,
  ctx.paths.drivingNetwork,
  ctx.paths.terrainGrid,
  ctx.paths.routeElevation,
  ctx.paths.osmVisualSource,
  ctx.paths.worldManifest,
  ctx.paths.plateauBuildings,
  ctx.paths.plateauTransportation,
  ctx.paths.plateauTerrain,
  ctx.paths.plateauBridges,
  ctx.paths.plateauWater,
  ctx.paths.plateauVegetation,
  ctx.paths.plateauFurniture,
  ctx.paths.osmOverlays,
];

const missingFiles = requiredFiles.filter((relPath) => !existsSync(resolveRoot(relPath)));

if (missingFiles.length === 0) {
  process.exit(0);
}

console.error(`生成データが不足しています (${ctx.routeId})。次のファイルが見つかりません:`);
for (const relPath of missingFiles) {
  console.error(`- ${relPath}`);
}

console.error("\n次の手順でデータを再生成してください:");
console.error(
  `1. npm run build-data -- --route-id ${ctx.routeId} … OSM経路データ生成(初回はネットワーク必須、tools/cache があればオフライン可)`,
);
console.error("2. npm run world:download … PLATEAU CityGML ZIP取得(数GB、初回のみ)");
console.error(
  `3. npm run world:build -- --route-id ${ctx.routeId} … ワールドデータ生成(data/work/plateau/selected が既にあれば --skip-extract で選択展開を省略可)`,
);

process.exitCode = 1;
