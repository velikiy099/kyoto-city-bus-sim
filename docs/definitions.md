# 定義ファイル一覧

OSM/PLATEAUデータへの手動補正と、ハードコードから切り出した設定値は、git管理のJSON定義ファイルに集約しています。生成データ(`src/data/routes/<routeId>/route.json`、`public/world/routes/<routeId>/`、`src/world/declarative/generated/<routeId>/`、`data/osm/<routeId>-corridor.json` 等)はgit管理外で、これらの定義ファイルとパイプラインから再生成します。

配置ルール:

- `data/regions/<regionId>/` — 地域共通のデータ生成定義(`region.json`: PLATEAU設定・`projOrigin`・パイプライン既定値、`osm-patches/`: コリドー自動フィルタで路線に適用されるOSM補正カタログ)
- `data/routes/<routeId>/route.json` — 路線固有の生成入力(OSMリレーションID、区間差し替え、停留所順/位置補正、制限速度ゾーン、車線誘導)
- `data/definitions/rivers.json` — 河川幅フォールバック定義(パイプラインとランタイム共用)
- `src/data/definitions/` — ランタイム専用の定義(`regionRegistry.js` / `routeRegistry.js` 経由でロード)

ルートID規約:

- 正規IDは `<regionId>-<routeNumber>` 形式(例: `"kyoto-18"`)
- 短縮別名(`"18"` 等)もランタイムクエリ(`?route=18`)およびCLI引数(`--route-id 18`)の両方で受理

編集後の反映コマンド:

| 編集した定義 | 反映コマンド | 検証 |
| --- | --- | --- |
| `data/regions/<regionId>/osm-patches/{roads,intersections,structures}.json` / `data/routes/<routeId>/route.json` | `node tools/build-route-data.mjs --route-id kyoto-18` → `node tools/world/build-world.mjs --route-id kyoto-18 --skip-extract` | `npm run world:validate` ほか全validate |
| `data/regions/<regionId>/osm-patches/{roads,structures,terminus-turnarounds}.json`(driving-network系) | `node tools/world/build-driving-network.mjs --route-id kyoto-18` | `npm run validate:driving-network`, `validate:traffic-continuity` |
| `data/regions/<regionId>/region.json`(plateau/terrainRebuild) | `node tools/world/build-world.mjs --route-id kyoto-18 --skip-extract` | `npm run validate:terrain-fix`, `validate:world-alignment` |
| `rivers.json` / `src/data/definitions/*.json` | 再生成不要(`npm run dev` で即反映) | `npm run build` + 全validate |

## data/regions/<regionId>/ & data/routes/<routeId>/(パイプライン定義)

### data/regions/kyoto/region.json

京都市エリア共通の座標原点(`projOrigin`)、PLATEAU CityGML取得URL・コリドー幅・地形グリッド再構築設定(`terrainRebuild`)、およびOSMクエリの既定チューニング(`pipelineDefaults`)。

### data/regions/kyoto/osm-patches/

京都市全域で共有可能なOSM補正カタログ。`tools/lib/corridor-filter.mjs` により生成対象路線のコリドー内(または構成交差道路/終点名一致)の項目だけが自動適用されます。

- `roads.json`: 構内除外way、本線外一方通行(`EXTRA_ROADS[]`)、一方通行コリドー補正(`ONEWAY_CORRIDOR_PATCHES[]`)、way車線オーバーライド(`WAY_LANE_OVERRIDES`)、区間範囲オーバーライド(`SECTION_RANGE_OVERRIDES`)、橋一体歩道way・重複歩道橋除外・追加横断歩道(`EXTRA_CROSSWALKS[]`)
- `intersections.json`: 交差道路実勢オーバーライド(`INTERSECTION_OVERRIDES`)、右左折アンカー補正(`TURN_OVERRIDES`)、道なりカーブ降格アンカー(`FORCE_PLAIN_CURVE_ANCHORS`)
- `structures.json`: 交通網コンパイル既定値(`DRIVING_NETWORK_DEFAULTS`)、河川リレーション(`RIVER_RELATIONS[]`)、橋梁(`BRIDGES[]`)、跨線橋(`OVERPASSES[]`)、高速高架交差(`HIGHWAY_CROSSINGS[]`)、鉄道分類・無名水面命名設定
- `terminus-turnarounds.json`: 終点転回場(`TERMINUS_TURNAROUNDS[]`)。終点名および経路コリドー一致時のみコンパイル

### data/routes/<routeId>/route.json

路線ごとの固有定義(`id`, `aliases`, `regionId`, `routeName`, `osm.relationId` / `southboundRelationId` / `segmentReplacements` / `extraQueryBboxes`, `stops`, `speedZones`, `autoLaneGuides`)。

### data/definitions/rivers.json

河川の描画幅フォールバック(桂川48m・鴨川22m・西高瀬川8m、既定12m)。OSMのwaterway中心線にwidthタグ・riverbankポリゴンが無い場合に使う。`src/world/riverGeometry.js`(ランタイム)と `tools/render-map.mjs`(QA地図)で共用。

## src/data/definitions/(ランタイム定義)

ランタイム起動時は `src/route/routeRegistry.js` と `src/world/regionRegistry.js` を起点に `src/route/loadSession.js` (`loadSessionBundle`) が **Region（地域共通カタログ）**・**World（地図・道路網・自然・交通）**・**Route（路線・停留所・ダイヤ・放送・方向幕）** の3層に分離してロードします。地域共通のランドマーク・公園定義は `src/route/corridor.js` により路線コリドー距離で自動フィルタされます。

| ファイル | スコープ | 内容 | 主な消費者 |
| --- | --- | --- | --- |
| landmarks.json | Region | 東寺・京都水族館・京都タワー・壬生操車場・終点転回場(`TERMINUS_LOTS[]`)の地域共通ワールド座標と `corridorRadiusM` | src/world/landmarks.js |
| nature.json | Region | 橋桁スパン例外(`BRIDGE_SPAN`)、川深さ・欄干寸法・樹木密度・街路樹配置、地域公園配列(`PARKS[]` + `worldPos`/`corridorRadiusM`) | src/world/nature.js |
| railways.json | Region | JR在来線アンダーパス既定値、新幹線高架、高速高架既定値と `variantRules` 配列 | src/world/railways.js |
| signals.json | Region | 信号位相(周期42s/青22s/黄3s)、フォールバック信号設定 | src/world/traffic/signals.js |
| npc-vehicles.json | Region | NPC車5種(車種・塗色・寸法・最高速・物理クラス) | src/world/traffic/agents.js |
| route-semantics.json | Route | 系統番号、タイトルUIメタデータ、起終点、除外停留所、汎用方向幕配列(`headsignPhases[]`)・対向車幕(`oncomingHeadsign`) | loadSession.js / destinationDisplay.js / screens.js / minimap.js |
| timetable.json | Route | 固定時刻表29エントリ(9:56二条駅西口発〜10:44久我石原町着) | src/game/timetable.js |
| announcements.json | Route | 車内放送文言4種(`{stop}` は停留所名に置換) | src/audio/announcements.js |

## 注意事項

- 数値・座標は実測由来のため、変更時は該当する再生成+validateを必ず実行する
- 素のNodeで動くバリデータ等が読み込む静的JSON import(`src/world/riverGeometry.js` 等)には `with { type: "json" }` を付ける。一方、`src/world/regionRegistry.js` / `src/route/routeRegistry.js` のVite動的 `import("...json")` ではVite開発サーバーのMIME判定との整合のため `{ with: { type: "json" } }` を付けない
- 新規路線を追加する場合は `src/route/routeRegistry.js` に登録し、`?route=<id>` クエリまたはタイトル画面の路線選択UIから切り替える
- 車両物理・交通AI・スコア等のゲームチューニングは従来どおり `src/config.js`(CFG)が担う
- 生成データの再生成手順は [README](../README.md) の「データ生成(初回セットアップ)」を参照
