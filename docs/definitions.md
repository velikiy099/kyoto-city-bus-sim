# 定義ファイル一覧

OSM/PLATEAUデータへの手動補正と、ハードコードから切り出した設定値は、git管理のJSON定義ファイルに集約しています。生成データ(`src/data/route18.json`、`src/data/generated/`、`public/world/generated/` 等)はgit管理外で、これらの定義ファイルとパイプラインから再生成します。

配置ルール:

- `data/definitions/` — データ生成パイプライン(tools/)が使う定義。`rivers.json` のみランタイム(src/)と共用
- `src/data/definitions/` — ランタイム(ゲーム本体)専用の定義。Viteの静的import(`with { type: "json" }` 付き)で読み込む
- `tools/world/world.config.json` — PLATEAUパイプラインの設定(取得URL・コリドー幅・地形グリッド・出力パス)

編集後の反映コマンド:

| 編集した定義 | 反映コマンド | 検証 |
| --- | --- | --- |
| route18-osm-patches / route18-intersections / route18-pipeline-tuning | `npm run build-data` → `npm run world:build -- --skip-extract` | `npm run world:validate` ほか全validate |
| driving-network-patches | `node tools/world/build-driving-network.mjs` | `npm run validate:driving-network`, `validate:traffic-continuity` |
| world.config.json(plateau/terrainRebuild) | `npm run world:build -- --skip-extract` | `npm run validate:terrain-fix`, `validate:world-alignment` |
| rivers / src/data/definitions/*.json | 再生成不要(`npm run dev` で即反映) | `npm run build` + 全validate |

## data/definitions/(パイプライン補正)

### route18-osm-patches.json

`tools/build-route-data.mjs` が使うOSMデータへの手動補正。© OpenStreetMap contributors (ODbL) の実測に基づく。

| キー | 内容 |
| --- | --- |
| RELATION_ID / SOUTHBOUND_RELATION_ID | 18号系統の北行き(13027168)・南行き(13027169)リレーション |
| KATSURA_RIVER_RELATION_ID | 桂川のwaterwayリレーション(9459116) |
| TERMINUS_INTERNAL_WAY_IDS | 久我石原町終点構内の非公道way(除外) |
| EXTRA_ROAD_WAY_IDS / EXTRA_ROADS_FALLBACK / EXTRA_ROAD_TAG_OVERRIDES / EXTRA_ROAD_WIDTH_M | 本線外の一方通行路(地蔵前対向・小枝橋西行き)の way と名称・車線の補完 |
| STOP_ORDER | 南行き公式停留所順(30停、京都市交通局時刻表準拠) |
| NAME_ALIAS | OSM表記→公式表記のゆれ吸収(城ヶ前町→城ケ前町) |
| EXTRA_STOPS / SOUTHBOUND_STOP_OVERRIDES | 南行き専用停留所と停車位置上書き(OSM node実測座標) |
| JUJO_* / KUJO_WESTBOUND_* / DETOUR_* | 南行きと北行きで走る道が異なる3区間のway差し替え(十条・九条通西行き・小枝橋〜塔ノ森の27頂点ポリライン) |
| BRIDGES | 河川橋4橋(アンカー実座標・実橋長・河川名・川ポリライン切り出し窓) |
| HIGHWAY_CROSSINGS / EXPRESSWAY_VIADUCT_DEFAULTS | 名神高速の高架交差2箇所と高架の既定寸法 |
| SPEED_ZONES | 制限速度ゾーン(停留所名アンカー) |
| FORCE_PLAIN_CURVE_ANCHORS | 誤検出された右左折交差点を道なりカーブへ降格するアンカー |
| FALLBACK_STOP_COORDS | `--fallback` モード用の停留所実座標(ネット不通時) |
| OMIYA_OVERPASS | 大宮跨線橋の縦断構造(木津屋橋+30m〜東寺道-100m、高さ4m、勾配3.5%等)と東寺東門前停留所の+20m補正 |
| RAILWAY_CLASSIFICATION | 新幹線/在来線の分類条件(軌間・名称)と表示名・構造既定値 |
| WATER_SURFACE_NAMING | 無名水面ポリゴンを最寄り橋の河川名で命名する半径 |

### route18-intersections.json

交差点の実勢オーバーライド。`INTERSECTION_OVERRIDES`(四条通・五条大宮・七条通・三条通・壬生通の車線数・幅・中央分離帯・歩行者専用腕)と `TURN_OVERRIDES`(右左折交差点5箇所の交差道路名・スタブ方位・車線)。`arms[].length` を省略した場合は `CROSS_STREET_ARM_LEN`(route18-pipeline-tuning.json)が適用される。

### route18-pipeline-tuning.json

`tools/build-route-data.mjs` のチューニング定数。Overpass APIエンドポイント、取得BBOX(鉄道・二条駅・迂回区間・河川)、コリドー半径、フィレット/右左折判定角、リサンプル間隔、車線幅、経路端の延長距離など。

### driving-network-patches.json

`tools/world/build-driving-network.mjs` がOSM路面をPLATEAU路面へコンパイルする際の補正。久我橋のway ID/名称、フラットデッキ橋の構造名、大宮跨線橋の側道8way除外と回廊しきい値(18m/整列0.82)、橋一体の歩道way、重複歩道橋の除去、歩道橋クリアランス5.2m、車線幅・セル寸法。

### rivers.json

河川の描画幅フォールバック(桂川48m・鴨川22m・西高瀬川8m、既定12m)。OSMのwaterway中心線にwidthタグ・riverbankポリゴンが無い場合に使う。`src/world/riverGeometry.js`(ランタイム)と `tools/render-map.mjs`(QA地図)で共用。

## src/data/definitions/(ランタイム定義)

| ファイル | 内容 | 主な消費者 |
| --- | --- | --- |
| landmarks.json | 東寺(門・塔・金堂のOSM/PLATEAU実測アンカー、参照交差点名)、久我石原町ターミナル敷地(22.5×24.7m)、水族館・京都タワー・壬生操車場の配置 | src/world/landmarks.js |
| nature.json | 鳥羽離宮跡公園(OSM way 341709499)、橋桁スパン例外(久我橋/天神橋)、川深さ・欄干寸法・樹木密度・街路樹配置 | src/world/nature.js |
| railways.json | JR在来線アンダーパス既定値、新幹線高架(deckY 8.2m・橋脚列)、名神高架(deckY 7.0m・名前分岐・橋脚列) | src/world/railways.js |
| signals.json | 信号位相(周期42s/青22s/黄3s)、フォールバック信号6停留所 | src/world/traffic/signals.js |
| npc-vehicles.json | NPC車5種(車種・塗色・寸法・最高速・物理クラス) | src/world/traffic/agents.js |
| route-semantics.json | 系統番号、起終点、方向幕切替停留所(九条大宮)、除外停留所(上鳥羽村山町)、方向幕文言 | main.js / routeData.js / stops.js / destinationDisplay.js / minimap.js |
| timetable.json | 固定時刻表29エントリ(9:56二条駅西口発〜10:44久我石原町着) | src/game/timetable.js |
| announcements.json | 車内放送文言4種(`{stop}` は停留所名に置換) | src/audio/announcements.js |

## 注意事項

- 数値・座標は実測由来のため、変更時は該当する再生成+validateを必ず実行する
- src配下でJSON定義をimportする際は `with { type: "json" }` を付ける(バリデータが素のNodeでsrcモジュールを読み込むため必須)
- 車両物理・交通AI・スコア等のゲームチューニングは従来どおり `src/config.js`(CFG)が担う
- 生成データの再生成手順は [README](../README.md) の「データ生成(初回セットアップ)」を参照
