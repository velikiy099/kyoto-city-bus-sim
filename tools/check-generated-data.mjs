import { existsSync } from "node:fs";

const repoRoot = new URL("..", import.meta.url);

const requiredFiles = [
  "src/data/route18.json",
  "src/data/generated/driving-network.json",
  "src/world/declarative/generated/terrain-grid.json",
  "src/world/declarative/generated/route-elevation.json",
  "data/osm/route18-corridor.json",
  "public/world/world-manifest.json",
  "public/world/generated/plateau-buildings.json",
  "public/world/generated/plateau-transportation.json",
  "public/world/generated/plateau-terrain.json",
  "public/world/generated/plateau-bridges.json",
  "public/world/generated/plateau-water.json",
  "public/world/generated/plateau-vegetation.json",
  "public/world/generated/plateau-furniture.json",
  "public/world/generated/osm-road-overlays.json",
];

const missingFiles = requiredFiles.filter(
  (relativePath) => !existsSync(new URL(relativePath, repoRoot)),
);

if (missingFiles.length === 0) {
  process.exit(0);
}

console.error("生成データが不足しています。次のファイルが見つかりません:");
for (const relativePath of missingFiles) {
  console.error(`- ${relativePath}`);
}

console.error("\n次の手順でデータを再生成してください:");
console.error(
  "1. npm run build-data … OSM経路データ生成(初回はネットワーク必須、tools/cache があればオフライン可)",
);
console.error("2. npm run world:download … PLATEAU CityGML ZIP取得(数GB、初回のみ)");
console.error(
  "3. npm run world:build … ワールドデータ生成(data/work/plateau/selected が既にあれば npm run world:build -- --skip-extract で選択展開を省略可)",
);

process.exitCode = 1;
