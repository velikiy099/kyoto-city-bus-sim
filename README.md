# 京都市バス 18号系統 運転シミュレーター

京都市バス18号系統（上鳥羽線）の運転シミュレーターです。二条駅西口から久我石原町までの南行き経路を、OpenStreetMapの経路・停留所・交通情報と、京都市の2025年PLATEAU CityGMLデータを使って描画します。

経路は約10.7km、ゲーム内では29停留所を運行します。東寺五重塔、京都水族館、鴨川、桂川などの沿線要素を含みます。

## 起動

```bash
npm install
npm run dev
```

ブラウザで `http://localhost:5173` を開きます。

## 操作

| キー | 操作 |
| --- | --- |
| W / ↑ | アクセル |
| S / ↓ | ブレーキ。停止中に押し直して長押しすると後退 |
| A・D / ←・→ | ハンドル |
| E | ドア開閉。停留所停車中のみ |
| C | カメラ切替 |
| M | ミニマップ表示切替 |
| R | コース上へ復帰。コース外では減点 |
| Shift+R | タイトル画面へ戻る |

後乗り・前降り、運賃230円均一、停車位置、定刻発車、信号、速度、急ブレーキ、接触を運行ルールとして扱います。終点到着後にスコアとランクを表示します。

## 路線データ

```bash
npm run build-data
```

OpenStreetMapの関係・way・停留所・交通情報から、次のデータを生成します。

- `src/data/route18.json`: 経路以外の河川、水域、植生、橋梁、鉄道・高架などの補助メタデータ
- `src/data/generated/driving-network.json`: 走行経路、路面、停留所、車線、交通グラフ、速度区間

ネットワークへ接続できない場合は、内蔵の停留所座標を使う次のコマンドを実行できます。

```bash
node tools/build-route-data.mjs --fallback
```

## PLATEAUワールドデータ

現行のワールドはPLATEAUを地形・道路面・建物の基準にし、OpenStreetMapを経路・交通・道路詳細・自然要素の補助データとして使用します。

- 地形: PLATEAU DEMを30m間隔の連続グリッドとして使用
- 道路面・歩道面: PLATEAU `tran`
- 建物: PLATEAU `bldg` のfootprintと高さ
- 走行経路・車線・停留所・信号・交通グラフ: OpenStreetMapから生成した driving network
- 道路詳細: OSM由来の歩道オーバーレイ、コンパイル済みの車線・区画線・横断歩道
- 河川・水域・植生・橋梁構造・鉄道・高架: 路線データの構造メタデータと自然要素

現在の生成データは、建物17,363件、交通ポリゴン3,988件、地形35,160頂点・69,496三角形、OSM歩道オーバーレイ423件です。選択したPLATEAU範囲では `brid`、`wtr`、`veg`、`frn` の特徴数は0で、該当要素は路線データとOSM由来の描画で補います。

### CityGMLの取得・選択・変換

通常はプロジェクトの設定にあるPLATEAU URLから取得します。

```bash
npm run world:download
npm run world:build
```

DownloadsなどにあるZIPを直接指定する場合は、ZIPをコピーせずに次のように実行できます。

```bash
npm run world:build -- --archive "$HOME/Downloads/26100_kyoto-shi_city_2025_citygml_1_op.zip"
```

`world:build` は経路周辺のCityGMLだけを `data/work/plateau/selected` に展開し、PLATEAUレイヤー、連続地形、路面ネットワーク、マニフェストを生成します。選択処理だけを実行する場合は次のコマンドを使います。

```bash
npm run world:select -- --archive /path/to/26100_kyoto-shi_city_2025_citygml_1_op.zip
```

OpenStreetMapの経路データを更新してワールドを再生成する場合は次を使います。

```bash
npm run world:refresh
```

生成先は次のとおりです。

- `public/world/generated/plateau-terrain.json`
- `public/world/generated/plateau-transportation.json`
- `public/world/generated/plateau-buildings.json`
- `public/world/generated/plateau-bridges.json`
- `public/world/generated/plateau-water.json`
- `public/world/generated/plateau-vegetation.json`
- `public/world/generated/plateau-furniture.json`
- `public/world/generated/osm-road-overlays.json`
- `src/world/declarative/generated/terrain-grid.json`
- `src/world/declarative/generated/route-elevation.json`
- `public/world/world-manifest.json`

## マップ確認

```bash
npm run map
npm run map-check
```

`npm run map` は `tools/map.svg` を生成します。`map-check` はdriving network、路面、車線、標高、地形接続、道路外ポリゴンを検査します。区間を指定して描画する場合は次のように実行します。

```bash
node tools/render-map.mjs --from 3400 --to 4250 --terrain-step 1 --out tools/map-omiya.svg
```

## デバッグAPI

ブラウザコンソールから次のAPIを使用できます。

```js
game.debug.autoDrive(true);       // 自動運転
game.debug.timeScale(4);           // 時間倍率
game.debug.teleport(11);           // 停留所11の手前へ移動
game.debug.teleportS(5000);        // 経路上の距離[m]へ移動
game.debug.fastForward(600);       // ゲーム内時間を600秒進める
game.debug.status();               // 現在の状態
game.debug.returnToTitle();        // タイトル画面へ戻る
```

## 検証

```bash
npm run world:validate
npm run validate:plateau-integration
npm run validate:terrain-fix
npm run validate:world-alignment
npm run validate:structural-road
npm run validate:driving-network
npm run validate:bridge-water-alignment
npm run map-check
npm run build
```

データ形式と各レイヤーの役割は [`docs/plateau-data-format.md`](docs/plateau-data-format.md) に記載しています。

## 出典

- 経路・停留所・交通情報: © OpenStreetMap contributors（ODbL）、relation 13027168
- 地形・道路面・建物: Project PLATEAU 京都市2025 CityGML
- 運賃、ダイヤ、乗客数、スコア: シミュレーター用の設定
