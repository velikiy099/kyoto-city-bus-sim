# PLATEAU基準の宣言的ワールド

このプロジェクトでは、見た目と標高の基準をPLATEAUへ統一しています。OSMはバス経路、
停留所、車線方向、一方通行、信号、交差点、道路接続などの論理情報にのみ使用します。

## データの役割

| 対象 | 基準データ | 実装 |
|---|---|---|
| 地形・標高 | PLATEAU DEM | 連続した規則グリッドへ再メッシュ |
| 建物 | PLATEAU bldg | footprint + measuredHeightを地形上で押し出し |
| 道路の論理形状 | OSM route/network | PLATEAU地形へ投影して走行面を生成 |
| 河川 | PLATEAU地形 + 経路水路注記 | 地形を谷状に下げ、水面・護岸を着色 |
| 河川橋・跨線橋 | 経路構造メタデータ | 地表とデッキを分離し、橋脚を両者の間へ配置 |
| 鉄道・高速高架 | 経路構造メタデータ | PLATEAU地表を下端として桁・橋脚を配置 |
| 他車交通 | OSM交差点・車線接続 | IDM追従、安全合流、交差点予約、動的分岐 |

京都市2025年PLATEAUの選択タイルでは、経路付近の`wtr`、`brid`、`veg`が空です。
そのため河川と橋梁の論理区間は既存の経路注記を補助的に使いますが、Y座標はすべて
PLATEAU地形サンプラーから決まります。

## 連続地形形式

`public/world/generated/plateau-terrain.json`と
`src/world/declarative/generated/terrain-grid.json`は次のグリッドを持ちます。

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

隣接格子点をインデックスで接続するため、従来のような独立三角形の破片にはなりません。
経路付近は`route-elevation.json`を拘束条件にし、420mまではPLATEAU由来標高の影響を
維持し、外側は勾配を減衰させながら650m余白まで外挿します。

アップロードされた生成済みDEMは、旧処理によって経路近傍へすでに切り詰められていました。
コミット済みグリッドは、残存DEMに加えPLATEAU建物基部と交通面の標高を補助サンプルとして
再構成しています。元CityGMLから`npm run world:build`を実行する場合は、420mコリドーの
DEMを枚数切り捨てせず直接グリッド化します。

## 建物

京都市データの多くは`surfaces`にGroundSurface一枚しかなく、詳細な外殻ではありません。
変換時と描画時の双方で、壁面と屋根面が揃った完全なシェルだけを採用します。それ以外は
PLATEAUのfootprintとheightから押し出します。基礎高はフットプリント各点の地形標高中央値です。
OSM建物は通常起動では使用しません。

## 標高API

- `terrainHeightAtWorld(x, z)`: 地表の標高
- `roadHeightAtWorld(x, z)`: 本線近傍のみ橋・高架の構造標高を加えた路面標高
- `terrainElevationAt(s)`: 経路中心の地表標高
- `elevationAt(s)`: 経路中心の地表 + 橋・高架標高

地上の道路・建物・停留所・人物・樹木・ランドマークは地表標高を使い、橋面・高架面・
本線車両だけが構造標高を使います。橋脚は地表または河床からデッキ下端まで伸ばします。

## 他車交通

`src/world/traffic.js`は次の処理を行います。

- 相対速度を考慮したIDM型追従
- 前後安全間隔を満たすまで支線合流を待機
- 信号交差点の進入予約による相反交通の排他
- `route.intersections[].arms`から分岐先を動的選択
- 複数車線での安全確認付き車線変更
- 走行位置ごとの地形・路面標高と勾配追従
- 車両向きと高さを考慮した立体衝突判定

## 生成・検証

```bash
npm run world:build
npm run world:validate
npm run validate:plateau-integration
npm run validate:terrain-fix
npm run validate:world-alignment
npm run build
```

`validate:world-alignment`は地形接続、経路との標高差、格子勾配、不完全建物シェル、
OSM建物フォールバックの不在、交通安全ロジック、橋梁の地表参照を検証します。
