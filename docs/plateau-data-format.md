# PLATEAUワールドデータ

このプロジェクトのワールドは、PLATEAUを地形・道路面・建物の基準として描画します。OpenStreetMapから生成した路線データとdriving networkは、走行経路、停留所、車線、交通制御、道路詳細、河川・植生などに使用します。

## データの役割

| 対象 | 使用データ | 実行時の用途 |
| --- | --- | --- |
| 地形・標高 | PLATEAU `dem` | 連続した規則グリッドと経路標高 |
| 道路面・歩道面 | PLATEAU `tran` | 道路・歩道・交差点の面 |
| 建物 | PLATEAU `bldg` | footprintと高さから地形上に生成 |
| 走行経路 | `src/data/generated/driving-network.json` | バスの経路、路面、停留所、車線、標高 |
| 他車交通 | driving network | 交通グラフ、信号、合流、車線変更、IDM追従 |
| 道路詳細 | `public/world/generated/osm-road-overlays.json` と driving network | 歩道、区画線、車線、横断歩道 |
| 河川・水域 | `src/data/route18.json` | 水面、河床、護岸、橋との位置関係 |
| 橋梁・鉄道・高架 | `src/data/route18.json` と PLATEAU交通面 | 河川橋の橋面（3橋は浅いアーチ、天神橋は平坦）、付属歩道、橋脚、欄干、高架 |
| 植生・緑地 | `src/data/route18.json` | OSMの樹木、森林、低木、緑地 |

PLATEAU選択範囲の生成結果は、`bldg` 36ファイル、`tran` 36ファイル、`dem` 16ファイル、`frn` 3ファイルです。`brid`、`wtr`、`veg` の選択ファイルはありません。対応するワールドレイヤーは空のデータとして保持され、河川・植生・橋梁構造は路線データとOSM由来の要素で描画されます。

## 生成ファイル

### 公開ワールドレイヤー

- `public/world/generated/plateau-terrain.json`
- `public/world/generated/plateau-transportation.json`
- `public/world/generated/plateau-buildings.json`
- `public/world/generated/plateau-bridges.json`
- `public/world/generated/plateau-water.json`
- `public/world/generated/plateau-vegetation.json`
- `public/world/generated/plateau-furniture.json`
- `public/world/generated/osm-road-overlays.json`
- `public/world/world-manifest.json`

### 実行時・検証用データ

- `src/data/generated/driving-network.json`: 走行・交通ネットワーク
- `src/world/declarative/generated/terrain-grid.json`: 実行時に使う地形グリッド
- `src/world/declarative/generated/route-elevation.json`: 経路標高の生成・検証用プロファイル
- `data/work/plateau/build-report.json`: 変換レポート

## 連続地形形式

`public/world/generated/plateau-terrain.json` の `grid` と、実行時コピーの `terrain-grid.json` は同一の地形グリッドを持ちます。

```json
{
  "origin": [0, 0],
  "spacing": [30, 30],
  "width": 120,
  "height": 293,
  "heights": [],
  "connected": true,
  "sourceInfluenceCorridorMeters": 420,
  "extrapolationPaddingMeters": 650
}
```

現在のグリッドは35,160頂点、69,496三角形です。経路周辺420mはPLATEAU標高を使用し、外側は650mの余白まで連続する地形として外挿します。実行時の路面標高はdriving networkの標高と構造区間を使用します。

## 建物

PLATEAU `bldg` のfootprintと高さを地形に合わせて配置します。詳細シェルが利用できる建物はその形状を使用し、footprintと高さだけの建物は押し出し形状を使用します。実行時の建物レイヤーは17,363件です。

## 道路と構造区間

PLATEAU `tran` の道路・歩道ポリゴンを表示します。4つの河川橋は始終点をPLATEAU地盤に合わせ、橋の前後に地盤を持ち上げる区間は設けません。小枝橋・京川橋・久我橋は浅いアーチ、天神橋は平坦面とし、橋付属歩道もそれぞれの橋面に追従させます。同じ区間へ別の道路板は追加しません。

driving networkは、PLATEAU交通面へ走行経路を対応付けたデータです。道路ノード5,453件、停留所30件、交通グラフv3の辺3,938件と接続線5,762件を持ちます。交通グラフの双方向車線は進行方向の左側へ配置し、接続線は旋回方向ごとに接続先車線を正規化します。同一点を結ぶ直進接続は `zeroLength: true` として距離を持たないグラフ遷移を表します。辺の `physicsSafe` は隣接区間の最大折れ角が45度未満であることを示し、それ以外の辺と接続線手前ではNPCを経路拘束で走行させます。実行時は終端へ流入しない有向循環コアを抽出し、NPCの初期配置・流入・経路選択をその範囲に限定します。

## 河川・植生・道路詳細

PLATEAU選択範囲の水域・植生・橋梁・家具レイヤーは0件です。河川、水面、護岸、橋脚、欄干、緑地、樹木は路線データとOSM由来の情報から生成します。

`osm-road-overlays.json` にはPLATEAU道路面へ重ねるOSMの歩道ポリゴン423件を格納します。車線や区画線はdriving networkと路線メタデータから生成します。

## CityGMLの生成手順

プロジェクト設定のURLから取得して生成する場合:

```bash
npm run world:download
npm run world:build
```

手元のZIPを直接指定する場合:

```bash
npm run world:build -- --archive /path/to/26100_kyoto-shi_city_2025_citygml_1_op.zip
```

`world:build` は次の処理を実行します。

1. 経路周辺のCityGMLファイルを選択し、`data/work/plateau/selected` に展開
2. Python変換器でPLATEAUレイヤー、連続地形、OSM道路オーバーレイ、経路標高、マニフェストを生成
3. 実行時地形グリッドを同期
4. driving networkを生成
5. ワールドデータを検証

OpenStreetMapの経路データも更新する場合:

```bash
npm run world:refresh
```

## 検証

```bash
npm run world:validate
npm run validate:plateau-integration
npm run validate:terrain-fix
npm run validate:world-alignment
npm run validate:structural-road
npm run validate:driving-network
npm run validate:traffic-continuity
npm run validate:bridge-water-alignment
npm run map-check
npm run build
```

`world:validate` は生成ファイル、連続地形、実行時地形コピー、driving network、OSM歩道オーバーレイを検証します。`validate:world-alignment`、`validate:structural-road`、`validate:driving-network`、`validate:bridge-water-alignment` は標高、構造道路、交通グラフ、橋梁・河川の整合性を検証します。

OSM/PLATEAUデータへの手動補正の定義ファイル一覧は [`definitions.md`](definitions.md) を参照してください。
