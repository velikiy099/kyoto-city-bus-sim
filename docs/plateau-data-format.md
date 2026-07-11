# PLATEAU + OSM 宣言的ワールドデータ

このドキュメントは `tools/world/` のパイプラインが生成する地図データの形式と、
統合にあたって発見・対処した既知の問題をまとめたものです。

## 役割分担

| 領域 | 権威データ | 備考 |
|---|---|---|
| 建物の外殻・位置・高さ | PLATEAU (`bldg`) | LOD2/3の壁面・屋根面があればそのまま描画。無ければ外形+高さで押し出し |
| 道路面・歩道・交差点の見た目 | PLATEAU (`tran`) | 走行判定には使わない(下記参照) |
| 地形・標高プロファイル | PLATEAU (`dem`) | `elevationAt()`の入力。地表メッシュ自体は現在非表示(後述) |
| 橋梁の見た目 | PLATEAU (`brid`) | 既存の橋・跨線橋の構造プロファイルに視覚を追加 |
| 信号機等の都市設備 | PLATEAU (`frn`) | 識別できたもののみ |
| 水部・植生 | PLATEAU (`wtr`/`veg`) | 経路コリドーと交差するもののみ |
| バス経路・停留所・一方通行・信号制御・車線構成・制限速度・交通AI | OSM (`route18.json`) | `src/world/traffic.js`, `src/world/extraRoads.js` は変更していない |

## PLATEAU生データ(CityGML ZIP)の形式

`npm run world:download` が取得する `26100_kyoto-shi_city_2025_citygml_1_op.zip`
(約2.7GB、97,678エントリ)の中身。

### ZIPのトップレベル構成

```
codelists/     属性値の統制語彙(コードリスト)XML。例: Building_usage.xml
schemas/       CityGML/GML本体 + 日本独自拡張(iUR urf/uro)のXSD
metadata/      納品メタデータ(品質情報、リソース一覧CSV等)
specification/ 地物一覧(xlsx)・仕様書(PDF)
udx/           実データ本体。地物型ごとのフォルダ
  bldg/        建物(LOD0〜3)
  tran/        交通(道路・軌道等の面情報)
  dem/         数値標高モデル(不整三角網 TIN)
  brid/        橋梁
  frn/         都市設備(信号機・標識等)
  veg/         植生
  fld/         浸水想定区域(natl/pref下に細分。今回は未使用)
  lsld/        土砂災害警戒区域(今回は未使用)
  luse/        土地利用(今回は未使用)
  urf/         都市計画決定情報(今回は未使用)
```

京都市の2025年度パッケージには `wtr`(水部)フォルダ自体が存在しない
(河川等は`tran`や別レイヤーに含まれるか、この提供範囲では非公開)。
`brid`は1ファイル、`veg`も市全域で1ファイルのみと非常に少ない。
このため経路コリドーと交差せず、`water`/`vegetation`/`bridges`の出力は
空になりやすい(コリドー設定の問題ではなくソースデータの母数が少ないため)。

### ファイル命名規則

`<メッシュコード>_<地物型>_<CRS番号>_op.gml`

例: `52353670_bldg_6697_op.gml`(8桁=3次メッシュ)、
`523535_dem_6697_00_op.gml`(6桁=2次メッシュ + PLATEAU独自の分割サフィックス)

メッシュコードはJIS X0410の地域メッシュ(標準地域メッシュ)。
`tools/world/select-citygml.mjs`の`meshBounds()`が実装している対応:

- 4桁(1次メッシュ、約80km四方): 南端緯度 = 先頭2桁 ÷ 1.5°、西端経度 = 次2桁 + 100°
- 6桁(2次メッシュ、約10km四方): 1次メッシュを緯度8分割・経度8分割
- 8桁(3次/基準メッシュ、約1km四方): 2次メッシュをさらに10×10分割

`dem`ファイル名末尾の`_00`/`_05`/`_50`/`_55`はPLATEAU側のタイル分割用
サフィックスで、上記の標準メッシュコード桁とは別物(1つの2次メッシュ相当の
広い範囲のDEMを複数ファイルに分けて配布するための識別子。正確な分割基準は
未確認)。

建物(`bldg`)・都市設備(`frn`)には`<メッシュコード>_<型>_<CRS>_appearance/`
という付随フォルダがあり、テクスチャ画像(jpg)が入っている。本パイプラインは
ジオメトリのみを変換し、テクスチャは一切参照・使用しない。

### 座標系

実データの`srsName`属性(全レイヤーで確認済み):

```
http://www.opengis.net/def/crs/EPSG/0/6697
```

EPSG:6697 = **JGD2011 + JGD2011 (vertical) height**
(日本測地系2011の水平成分と標高成分を組み合わせた複合座標参照系)。
pyprojで確認した軸情報:

| 軸 | 方向 | 単位 |
|---|---|---|
| Geodetic latitude (緯度) | north | 度 |
| Geodetic longitude (経度) | east | 度 |
| Gravity-related height (標高) | up | メートル |

**軸順序は「緯度, 経度, 標高」**(EPSG登録順。一般的な「経度,緯度」とは逆)。
`tools/world/convert_citygml.py`の`to_lon_lat()`は、値の大きさから
緯度優先か経度優先かをヒューリスティックに判定している
(`abs(x) <= 90 and abs(y) > 90` なら「1つ目=緯度, 2つ目=経度」と推定)。
EPSG:6697は地理座標系(`is_geographic=True`)なので`pyproj.Transformer`は
使わず、この座標をそのまま(lon, lat)として扱う。ただし`srsName`は要素ごとに
検出しており(`detect_srs()`)、将来別のCRS(平面直角座標系など)が
混在していても対応できる設計になっている。

標高(H)は**JGD2011鉛直基準**(おおむね東京湾平均海面 T.P. 基準)の
標高値で、海抜0m付近を基準とした絶対値。本パイプラインはこれをそのまま
使わず、経路始点(`route18.json`の`path[0]`)におけるDEM標高を
ローカル基準点(`datum`、京都駅付近の例では約35.5m)として差し引き、
**「経路始点からの相対標高」**に変換してから出力する
(`plateau-buildings.json`の`baseHeight`、`route-elevation.json`の`samples`等)。

### 水平座標のワールド変換

`to_lon_lat()`で得た(経度, 緯度)を、`route18.json`の`projOrigin`
(緯度, 経度)を原点として、単純な正距円筒図法近似で
ローカルメートル座標 (x, z) に変換する(`project_to_world()`):

```python
x = (lon - lon0) * 111320.0 * cos(radians(lat0))
z = -(lat - lat0) * 111320.0
```

OSM由来の`route18.json`も同じ`projOrigin`・同じ投影式でローカル座標化
されているため、PLATEAUとOSMのデータは変換後のワールド座標系で
そのまま重ね合わせられる。地図全体が数km〜十数km規模のため、
測地線の歪みは無視できる範囲としている。

## パイプライン

```
npm run world:download   # CityGML ZIPを取得(data/raw/plateau/, gitignore対象)
npm run world:select     # 経路コリドーに交差するメッシュだけ抽出(world:buildが内部で呼ぶ)
npm run world:build      # CityGML→宣言的JSONへ変換 + route-elevation生成
npm run world:validate   # 生成物の存在・件数チェック
npm run world:all        # download + build
npm run world:refresh    # OSM側(route18.json)も再取得してbuild
```

設定は `tools/world/world.config.json`(コリドー幅、高さ上限、CRS、出力パス等)。

## 生成ファイル

`public/world/generated/`:

- `plateau-buildings.json` — 建物(footprint, height, baseHeight, surfaces, material, osmMatch等)
- `plateau-transportation.json` — 道路面ポリゴン(kind: road/lane/intersection/sidewalk)
- `plateau-terrain.json` — 地形三角形(現在レンダリングでは無効。下記「既知の制限」参照)
- `plateau-bridges.json` / `plateau-water.json` / `plateau-vegetation.json` / `plateau-furniture.json`
- `osm-network.json` — 経路・停留所・信号等(OSM由来、既存ゲームロジックにそのまま渡す)
- `world-manifest.json` — 上記レイヤーの一覧とURL、フィーチャ数

`src/world/declarative/generated/route-elevation.json` — 経路距離sごとの標高サンプル
(`src/route/routeData.js` の `elevationAt(s)` が消費。バス・道路・交通車両・線路の
Y座標は全てこの関数経由で標高に追従する)

## レンダリング設定

`src/world/declarative/config.js` の `render` オブジェクトで、レイヤーごとに
描画のON/OFFを切り替えられる(データ生成自体は止めない)。

```js
render: {
  terrain: false,       // 理由は下記
  transportation: true,
  buildings: true,
  bridges: true,
  water: true,
  vegetation: true,
  furniture: true,
}
```

## 既知の制限・修正した不具合

### 1. 地形メッシュは現在非表示 (`render.terrain: false`)

DEMのTriangleは経路コリドー(既定420m)との距離でフィルタし、上限
`maximumTerrainTriangles`(既定70,000)まで間引いて出力するが、**間引き後も
隣接三角形の接続関係を保持しない**(個々のTriangleを独立に選別しているだけ)。
そのため連続した地表面ではなく、隙間だらけの点在パッチとして描画され、
特に経路から離れた区間(道路から見えない場所)のパッチが水平線付近に
「破片が浮遊しているように」見える問題があった。

標高プロファイル(`route-elevation.json`)と建物・道路のベース高さスナップは
地表メッシュの描画とは独立にビルド時計算されるため、`render.terrain: false`に
しても物理・見た目の標高追従には影響しない。地表面を再度描画したい場合は、
間引きをスプライン/グリッドベースの連続メッシュ生成に置き換える必要がある。

### 2. 建物シェルへの無関係ジオメトリ混入(`tools/world/convert_citygml.py`)

一部のPLATEAU LOD2建物で、`measuredHeight`(信頼できる公式属性、例: 3.3m)とは
無関係な水平面(例: y=+9m, +12m — 屋根から20m以上高い位置)が
`exterior_rings(feature)` の走査で建物のshellに混入し、空中に浮く板として
描画される不具合があった。`_process_bldg_file()` で、生ジオメトリの
`min_z`と信頼できる`height`から妥当な高さレンジ`[min_z-3, min_z+height+3]`を
算出し、そのレンジ外の点を含むリングは事前に除外するフィルタを追加した。

### 3. `PlateauWorldRenderer.appendSurface` の三角形分割ガード

`THREE.ShapeUtils.triangulateShape`は非自己交差(simple)な多角形を前提とする。
座標の丸め・簡略化により稀に破綻したリングが渡ると、離れた頂点同士を結ぶ
「蝶ネクタイ」三角形を生成しうる。ポリゴン自身のバウンディングボックス対角線を
超える辺を持つ三角形は結果から除外するようにした(上記2と合わせた多層防御)。

### 4. `RouteIndex.nearest()` の性能(`tools/world/convert_citygml.py`)

経路(`route18.json`)は5,346点・平均間隔1.5mという非常に密なポリラインのため、
コリドー判定で「近傍グリッドに候補が無い→全セグメントを線形走査」という
フォールバックが、コリドー外(ほとんどの地形三角形)に対して毎回発動し、
致命的に遅かった(1ファイルあたり数分)。半径8セル(既定800m)以内に候補が
無ければ、それだけで「本アプリが使う最大コリドー(420m)より確実に遠い」と
判断できるため、全走査せず`Infinity`を返すよう変更。この最適化は
コリドー閾値が800m未満である限り安全(呼び出し側は必ず
`distance > corridor`のしきい値判定にしか使わない)。

### 5. 変換パイプラインの並列化・高速化

- `tools/world/lib.mjs` の `run()` に `maxBuffer` を追加(未設定だとNode既定の
  1MBを超える`unzip -Z1`出力でENOBUFSになり、紛らわしい`status 80`エラーに
  なっていた)
- `convert_citygml.py`: dem(16ファイル)・bldg(36ファイル)を
  `ProcessPoolExecutor`でファイル単位に並列化(18コア使用)
- `make_transformer()` に`lru_cache`を追加(三角形/リングごとにpyprojの
  CRS/Transformerを再生成していたコストを削減)
- `tqdm`でフェーズ(dem/bldg/tran/brid/wtr/veg/frn)ごとの進捗表示を追加
- 地形の間引きを「ファイル走査順のstride間引き」から
  「経路への距離が近い三角形を優先して残す」方式に変更(遠くの装飾的地形から
  間引かれるようにした。ただし根本的な間引き後の非連続性は#1の通り未解決)

## 京都市データの規模感(参考値)

- CityGML ZIP全体: 約2.7GB、97,678エントリ
- 経路コリドーで抽出: bldg 36ファイル(1.7GB) / tran 36ファイル(62MB) /
  dem 16ファイル(6.8GB) / frn 3ファイル / brid・wtr・veg は経路と交差せず0件
- 変換後: 建物17,421件、道路面ポリゴン4,002件、地形三角形70,000枚(上限まで間引き)
