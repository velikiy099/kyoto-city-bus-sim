#!/usr/bin/env node
/**
 * 京都市バス18号系統 路線データ生成スクリプト
 *
 * OpenStreetMap の18号系統リレーション(id 13027168, 北行き: 久我石原町→二条駅西口)を
 * Overpass API から取得し、南行き(二条駅西口→久我石原町)のゲーム用経路データ
 * src/data/route18.json を生成する。
 *
 * 上鳥羽地区の一方通行区間(小枝橋〜上鳥羽塔ノ森)は南北で走る道が異なるため、
 * 南行きの実経路(千本通: 城南宮道・赤池停留所前)の way 形状で差し替える。
 *
 * 使い方:
 *   node tools/build-route-data.mjs             キャッシュ→なければOverpass取得
 *   node tools/build-route-data.mjs --fallback  ネット不通時: 内蔵実座標(停留所直結)で生成
 *
 * データ出典: © OpenStreetMap contributors (ODbL) — relation 13027168
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "tools", "cache");
const OUT = join(ROOT, "src", "data", "route18.json");
const OSM_VISUAL_OUT = join(ROOT, "data", "osm", "route18-corridor.json");
const RELATION_ID = 13027168;
const SOUTHBOUND_RELATION_ID = 13027169;
// 久我石原町の終点構内にある南北の parking_aisle(way 1454593592)は、
// バス停への構内動線であって、終点付近の公道として描かない。
const TERMINUS_INTERNAL_WAY_IDS = new Set([1454593592]);
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const REFRESH_OSM = process.argv.includes("--refresh-osm");
const REFRESH_RIVER_ONLY = process.argv.includes("--refresh-river");
const OSM_RIVER_MAP = process.argv.find((arg) => arg.startsWith("--osm-river-map="))?.split("=").slice(1).join("=") ?? null;

// 距離スケール: 実距離に乗算。1.0 で OSM 実距離どおり。
const SCALE = 1.0;
const CROSS_STREET_ARM_LEN = 100; // 交差点の腕(交差道路)を舗装・建物とも延ばす距離 [m]
const CROSS_STREET_ARM_MIN = 15; // これ未満は「腕なし(行き止まり)」とみなす
const RESAMPLE_STEP = 2; // 最終ポリラインの点間隔 [m]
const FILLET_RADIUS = 18; // 緩い折れの円弧半径 [m]
const FILLET_MIN_ANGLE = 25; // この角度[deg]を超える折れをフィレット化
const TURN_MIN_ANGLE = 55; // この角度[deg]以上の折れは「右左折交差点」扱い(小半径+交差描画)
const TURN_FILLET_RADIUS = 12; // 交差点内でバスが曲がる現実的な回転半径 [m]
const ROAD_AROUND_RADIUS = 90; // route node 周辺から接続道路を拾う距離 [m]
const BUILDING_AROUND_RADIUS = 95; // route node 周辺から沿道建物を拾う距離 [m]
const BUILDING_ROADSIDE_DEPTH = 20; // 道路端から沿道建物として拾う奥行き [m]
const FALLBACK_BUILDING_ROAD_HALF_WIDTH = 6;
const RAILWAY_BBOX = [34.982, 135.744, 34.9895, 135.752]; // 七条大宮〜東寺東門前のJR線群
const ROAD_TYPES = [
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "service",
];
const VISUAL_ROAD_TYPES = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
];
const OSM_VISUAL_CORRIDOR_METERS = 240;
const OSM_VEGETATION_CORRIDOR_METERS = 240;
const NIJO_STATION_BBOX = [35.0094, 135.7394, 35.0134, 135.7438];
// DETOUR_SOUTHBOUND(小枝橋→城南宮道→赤池→塔ノ森)はハードコード座標のため routeNodesQuery
// の「経路ノード周辺」取得に乗らず、周辺道路・建物が一切取れない。bboxで直接補う。
const DETOUR_BBOX = [34.943, 135.735, 34.956, 135.746]; // [south, west, north, east]
const RIVER_BBOX = [34.93, 135.715, 34.965, 135.755]; // 鴨川・西高瀬川・桂川(小枝橋〜久我橋)

// 南行き本線とは別の北行き一方通行路。地蔵前南側の対向車と景観道路に使う。
// OSM way 63124509 は南端→北端の順で収録されているため、そのまま北行きの交通経路にする。
const EXTRA_ROAD_WAY_IDS = [63124509, 621847402];
const EXTRA_ROADS_FALLBACK = [
  {
    id: 63124509,
    tags: {
      highway: "unclassified",
      oneway: "yes",
      lanes: "1",
      name: "地蔵前南側北行き一方通行",
    },
    geometry: [
      [34.9555805, 135.7418361],
      [34.9561599, 135.7420066],
      [34.9562131, 135.7420189],
      [34.9567324, 135.7421385],
      [34.9573175, 135.7423033],
      [34.9576014, 135.74238],
      [34.9577568, 135.7424219],
      [34.9579234, 135.7424666],
      [34.9580917, 135.7425123],
      [34.95865, 135.7426639],
    ].map(([lat, lon]) => ({ lat, lon })),
  },
  {
    id: 621847402,
    tags: {
      highway: "tertiary",
      bridge: "yes",
      oneway: "yes",
      lanes: "2",
      name: "小枝橋西行き車線橋",
    },
    geometry: [
      [34.9512626, 135.7428803],
      [34.951226, 135.7425805],
      [34.9510626, 135.7414334],
    ].map(([lat, lon]) => ({ lat, lon })),
  },
];

// 南行きの公式停留所順(京都市交通局 時刻表より、城南宮道経由・全区間便)
const STOP_ORDER = [
  "二条駅西口",
  "二条駅前",
  "千本三条・朱雀立命館前",
  "みぶ操車場前",
  "四条大宮",
  "大宮松原",
  "大宮五条",
  "島原口",
  "七条大宮・京都水族館前",
  "東寺東門前",
  "九条大宮",
  "東寺南門前",
  "羅城門",
  "唐戸町",
  "千本十条",
  "五丁橋",
  "上ノ町",
  "上鳥羽村山町",
  "上鳥羽小学校前",
  "城ケ前町",
  "岩ノ本町",
  "地蔵前",
  "奈須野",
  "小枝橋",
  "城南宮道",
  "赤池",
  "上鳥羽塔ノ森",
  "久我",
  "菱妻神社前",
  "久我石原町",
];
// OSM表記 → 公式表記のゆれ吸収
const NAME_ALIAS = { 城ヶ前町: "城ケ前町" };

// 北行きリレーションに含まれない南行き専用停留所(OSM実測座標)
const EXTRA_STOPS = {
  城南宮道: [34.9501719, 135.7431768], // node 8955892662
  赤池: [34.9473836, 135.7430396], // node 8955892665
};

// 南行きと北行きで停車位置(道)が異なる停留所: 南行きプラットフォームのOSM実測座標で上書き
const SOUTHBOUND_STOP_OVERRIDES = {
  千本十条: [34.973279, 135.7422175], // node 8955892643(十条通 南側)
  五丁橋: [34.9705886, 135.7426048], // node 8955892645(旧千本通)
  上ノ町: [34.9673125, 135.7425638], // node 8955892647(旧千本通)
  上鳥羽村山町: [34.96565, 135.74247], // 北行きのみ停車。データ整合のため旧千本通上へ射影
  上鳥羽小学校前: [34.9643776, 135.7424912], // node 8955892650
  地蔵前: [34.9585329, 135.7430509], // node 8955892656(一方通行南行き側)
  奈須野: [34.9561146, 135.7425598], // node 8955892658(一方通行南行き側)
  小枝橋: [34.9540361, 135.7415567], // node 8955892661
  上鳥羽塔ノ森: [34.946249, 135.738128], // 南行き停留所の実走位置(ユーザー指定)
};

// 南行き専用区間1(十条新千本→十条通を東進→十条旧千本→旧千本通を南進)
// 北行きは新千本通を通るため、南行きの実経路を way 実形状で差し替える。
// way ID を南行きの通過順に列挙(向きは連結時に自動判定)
const JUJO_WAY_IDS = [
  968070106, // 十条通り: 新千本通交点 → 東
  968070105, // 十条通り: → 旧千本通交点(十条旧千本)
  27211283, // 千本通(旧): 十条旧千本 → 南(一方通行)
  1061759843, // 千本通: → 中山稲荷線(府道201)
  968070098, // 千本通: 府道201 → 南(2車線・センターラインなし)
  63124503, // 千本通: → 地蔵前手前交差点
  116803173, // 千本通: 一方通行区間(地蔵前手前 → 34.9554 の合流部)
];
const JUJO_FROM = [34.9736, 135.7414]; // 差し替え開始: 新千本通・十条通の手前
const JUJO_TO = [34.9554039, 135.7421815]; // 差し替え終了: 一方通行南端の合流点

// 九条通は東西の分離された一方通行2車線。18号系統の南行きは
// 九条大宮から羅城門へ西行きの車線(国道1号側)を通る。リレーションの
// 形状は東行き車線(968070114)を逆向きに含んでいるため、実走車線の
// way を明示的に差し替える。
const KUJO_WESTBOUND_WAY_IDS = [968070112, 968070111];
const KUJO_WESTBOUND_FROM = [34.9793823, 135.7493066]; // 九条大宮交差点・東側
const KUJO_WESTBOUND_TO = [34.978789, 135.7414259]; // 羅城門交差点・西側

// 南行き専用区間(千本通西側→小枝橋(鴨川)→城南宮道→赤池→上鳥羽塔ノ森): 実 way 形状
// 小枝橋(man_made=bridge, name=小枝橋)の実位置は lat≈34.9511 で、停留所(lat≈34.9541)
// から更に南下した地点(千本通西側の way 1061759795 終点)にある。旧データはこれを
// 停留所直近(lat 34.9528)と誤認し、橋の手前約330mを直線でショートカットしていた。
// way 621847405(小枝橋・実走行方向) + way 621847400(逆順) + way 217638202(逆順)
// + 伏見向日線(968070101→27829717→27829722→27829721→968070099、赤池〜塔ノ森)
const DETOUR_SOUTHBOUND = [
  [34.9511124, 135.7413116], // 千本通(西側)から小枝橋(鴨川)西詰への連結点
  [34.9511333, 135.7414445], // 以下 小枝橋(way 621847405)
  [34.9513353, 135.7427624], // 橋東詰
  [34.951343, 135.742935], // 以下 way 621847400 逆順
  [34.9512693, 135.7429352],
  [34.9512193, 135.7429323],
  [34.9506648, 135.7427628],
  [34.950623, 135.7428108],
  [34.9505492, 135.7431534], // 以下 way 217638202 逆順(城南宮道・赤池停留所前)
  [34.9502205, 135.7431418],
  [34.9496474, 135.7431262],
  [34.9494315, 135.7431173],
  [34.9492009, 135.7431116],
  [34.9489446, 135.7430965],
  [34.9488022, 135.7430901],
  [34.94768, 135.7430038],
  [34.9474363, 135.7429903],
  [34.9472233, 135.7429758],
  [34.9468287, 135.7429606],
  [34.946756, 135.7429658],
  [34.9465764, 135.7429866],
  [34.9464497, 135.7430095], // 赤池交差点
  [34.9464652, 135.7413228], // 以下 伏見向日線(実 way 形状)を西進して上鳥羽塔ノ森へ
  [34.9464362, 135.7399997],
  [34.9464338, 135.7398396],
  [34.9464276, 135.7392257],
];
const DETOUR_FROM = [34.9511124, 135.7413116]; // 差し替え開始: 千本通(西側)・小枝橋西詰
const DETOUR_TO = [34.9464291, 135.7391553]; // 差し替え終了: 伏見向日線・塔ノ森手前の合流点

// 橋(名称, 実座標アンカー, 実長[m]) — s値はスクリプトが経路射影で算出
// アンカーは各河川(OSM waterway)の実ポリラインと経路の交点を実測して求めた値。
const BRIDGES = [
  {
    name: "小枝橋(鴨川)",
    anchor: [34.9512, 135.74216],
    realLength: 60,
    river: "鴨川",
    // 京川橋(鴨川)との実距離(約529m)を超えて切り出し、両橋の川ポリラインが
    // 途中で重なるようにする(小枝橋〜京川橋間は経路と鴨川がほぼ並走しており、
    // 既定の220m窓だと両者がつながらず、川筋が途切れて見えていた)。
    riverHalfWindowM: 560,
  },
  {
    name: "京川橋(鴨川)",
    anchor: [34.94664, 135.74047],
    realLength: 46,
    river: "鴨川",
    riverHalfWindowM: 560,
  },
  {
    name: "天神橋(西高瀬川)",
    anchor: [34.94668, 135.73948],
    realLength: 18,
    river: "西高瀬川",
  },
  {
    name: "久我橋(桂川)",
    anchor: [34.9457, 135.73607],
    realLength: 340,
    river: "桂川",
    // 桂川は橋長340mに対して水面幅が約289mあり、既定の片側220mでは橋上視界で
    // 流路方向の端が目立つ。キャッシュは久我橋前後2km以上を含むため、片側900mで
    // 橋上から見える範囲の水面が川として自然につながる長さを確保する。
    riverHalfWindowM: 900,
  },
];

// 名神高速道路の高架(片道3車線)。アンカーは実際の名神ルート(OSM)と経路の交点。
// 見出しは経路接線に直交させる(名神自体はほぼ直線だが、経路側のカーブにより実測角度
// (-65°付近)をそのまま使うと片方の交差点で浅くなるため、立体交差として自然な直交で描く)。
const HIGHWAY_CROSSINGS = [
  // 名神高速道路と鴨川の実交点は経路から約118m離れており(射影誤差の許容60mを超える)、
  // そのアンカーをそのまま使うとクロッシング自体が生成されなくなる。経路に射影できる
  // 範囲内で、実交点に最も近い位置(名神高速の実ジオメトリ上)をアンカーとする。
  // 名神高速道路(鴨川・小枝橋付近)は経路交点から名神沿いに約110m先で鴨川を跨ぐ。
  // 既定長210m(半長105m)ではその手前で高架が途切れ、川を跨ぎきらずに終わって
  // 見えるため、川を跨いだ先まで見えるよう長さを延長する。
  {
    name: "名神高速道路(鴨川・小枝橋付近)",
    anchor: [34.95228, 135.74118],
    length: 340,
  },
  { name: "名神高速道路(桂川・菱妻神社付近)", anchor: [34.94773, 135.72919] },
];

// 制限速度ゾーン(停留所名アンカー、[km/h])
const SPEED_ZONES = [
  { fromStop: null, toStop: "九条大宮", limit: 40 }, // 市街地
  { fromStop: "九条大宮", toStop: "羅城門", limit: 50 }, // 九条通
  { fromStop: "羅城門", toStop: "赤池", limit: 40 }, // 千本通・鳥羽街道
  { fromStop: "赤池", toStop: "久我", limit: 50 }, // 久我橋区間
  { fromStop: "久我", toStop: null, limit: 40 }, // 久我地区
];

const LANE_W = 3.2; // 1車線幅 [m]

// 交差道路の実勢オーバーライド(交差点スタブの幅・車線数を交通量調査どおりに)
// arms: heading方向(side:1)/heading+PI方向(side:-1)ごとの実在・車線・歩行者専用の上書き。
// lanesF=heading方向(+heading)の車線数、lanesB=heading+PI方向の車線数(道路全体で共通)。
const INTERSECTION_OVERRIDES = [
  {
    name: "四条通",
    lanes: 5,
    width: 17.6, // 片道2+右折で計5
    arms: [
      {
        side: 1,
        exists: true,
        length: CROSS_STREET_ARM_LEN,
        lanesF: 2,
        lanesB: 2,
      },
      {
        side: -1,
        exists: true,
        length: CROSS_STREET_ARM_LEN,
        lanesF: 2,
        lanesB: 2,
      },
    ],
  },
  {
    name: "五条大宮",
    label: "五条通",
    lanes: 9,
    width: 30.8,
    median: 1, // 片道4+中央分離帯、交差点付近計9
    arms: [
      {
        side: 1,
        exists: true,
        length: CROSS_STREET_ARM_LEN,
        lanesF: 4,
        lanesB: 4,
      },
      {
        side: -1,
        exists: true,
        length: CROSS_STREET_ARM_LEN,
        lanesF: 4,
        lanesB: 4,
      },
    ],
  },
  {
    name: "七条通",
    lanes: 4,
    width: 14.4, // 片道2
    arms: [
      {
        side: 1,
        exists: true,
        length: CROSS_STREET_ARM_LEN,
        lanesF: 2,
        lanesB: 2,
      },
      {
        side: -1,
        exists: true,
        length: CROSS_STREET_ARM_LEN,
        lanesF: 2,
        lanesB: 2,
      },
    ],
  },
  // 千本三条: heading(side1)は西向き。西側=東行き3車線・西行き2車線(実在)。
  // 東側(side-1)は商店街(歩行者専用、車道なし)
  {
    name: "三条通",
    arms: [
      {
        side: 1,
        exists: true,
        length: CROSS_STREET_ARM_LEN,
        lanesF: 2,
        lanesB: 3,
      },
      {
        side: -1,
        exists: true,
        length: CROSS_STREET_ARM_LEN,
        pedestrian: true,
        lanesF: 0,
        lanesB: 0,
      },
    ],
  },
  // 京阪国道口(国道1号): heading(side1)は南向き。北行き1車線・南行き2車線(実在、南北とも)。
  // 交差点自体の幅(計5車線分の広さ)は width で表現。
  {
    name: "壬生通",
    label: "京阪国道口(国道1号)",
    lanes: 5,
    width: 17.6,
    arms: [
      {
        side: 1,
        exists: true,
        length: CROSS_STREET_ARM_LEN,
        lanesF: 2,
        lanesB: 1,
      },
      {
        side: -1,
        exists: true,
        length: CROSS_STREET_ARM_LEN,
        lanesF: 2,
        lanesB: 1,
      },
    ],
  },
];

// 右左折交差点の脚オーバーライド(vertex 近傍の実座標でマッチ)
const TURN_OVERRIDES = [
  // 二条駅西口: 駅構内サービス路から御池通へ出る接続点。ここは単なる
  // 経路の折れではなく、OSM way 987925655 の御池通西側が続くT字接続。
  // 自動推定では経路のフィレットに隠れて交差道路名が落ちるため、実測方位を
  // 明示して駅前の西向き腕を描く。
  {
    anchor: [35.0114432, 135.7404478],
    crossName: "御池通",
    stubInHeadingDeg: -80.3,
    stubInHw: 4.0,
    stubInLen: 100,
  },
  {
    anchor: [34.97938, 135.74931],
    stubInHw: 4.0,
    crossWidth: 8.0,
    crossLanes: 2,
  }, // 九条大宮: 大宮通(九条以南)は片道1
  { anchor: [34.95865, 135.74266], crossName: "千本通" }, // Overpass実測で確認(way 63124503等)
  // 久我石原町終点の南北 parking_aisle は TERMINUS_INTERNAL_WAY_IDS で経路から除外。
  // そのため、ここは右左折交差点として扱わない。
  // 小枝橋(鴨川)西詰: 千本通(北)から小枝橋(東)へ折れる分岐点。上河原橋方面への
  // 一方通行ペア(way 27829570 北東行き / way 621847404 南西行き)が南西へ分岐する
  // 実在の交差点(OSM に信号ノードは無い)。直進スタブは実道路の方位(南西、実測 -68.2°)
  // へ向け、交差点の西側には道路が実在しないため退出道路の後方延長は描かない。
  {
    anchor: [34.9511124, 135.7413116],
    crossName: "羽束師墨染線(上河原橋方面)",
    stubInLen: 100,
    stubInHeadingDeg: -68.2, // 直進スタブの絶対方位 [deg](atan2(dx,dz)規約、A→(34.9508024,135.7403621) の実測)
    stubBackLen: 0, // 交差点の向こう(西=鴨川の土手)に道路は実在しない
  },
  // 小枝橋(鴨川)東詰: 小枝橋側の道路(羽束師墨染線)から千本通(城南宮方面)へ乗り換える
  // 実在の分岐点。進入路(羽束師墨染線)はこの先も約100m実景観に合わせて続く。
  { anchor: [34.9513353, 135.7427624], crossName: "千本通", stubInLen: 100 },
];

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Overpass はレート制限(429)が頻発するためミラー横断+バックオフで再試行する
async function fetchJson(_url, body) {
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          "User-Agent":
            "cc-sample-game-route-builder/0.1 (OpenStreetMap data refresh)",
        },
        body: body ? new URLSearchParams({ data: body }) : undefined,
      });
      if (res.ok) return res.json();
      const text = await res.text().catch(() => "");
      lastErr = new Error(
        `HTTP ${res.status} for ${url}${text ? `: ${text.slice(0, 300)}` : ""}`,
      );
      if (res.status !== 429 && res.status !== 504) throw lastErr;
    } catch (e) {
      lastErr = e;
    }
    const wait = 8000 * (attempt + 1);
    console.log(`  retry in ${wait / 1000}s (${lastErr.message.slice(0, 80)})`);
    await sleep(wait);
  }
  throw lastErr;
}

async function refreshKatsuraRelationCache(path) {
  const res = await fetch("https://api.openstreetmap.org/api/0.6/relation/9459116/full.json", {
    headers: {
      Accept: "application/json",
      "User-Agent": "cc-sample-game-route-builder/0.1 (OpenStreetMap data refresh)",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for OpenStreetMap relation 9459116`);
  const relationData = await res.json();
  if (OSM_RIVER_MAP && existsSync(OSM_RIVER_MAP)) {
    const xml = readFileSync(OSM_RIVER_MAP, "utf8");
    const nodes = new Map();
    for (const match of xml.matchAll(/<node\s+id="(\d+)"[^>]*\slat="([^"]+)"[^>]*\slon="([^"]+)"[^>]*\s*\/?>(?:<\/node>)?/g)) {
      nodes.set(match[1], { lat: Number(match[2]), lon: Number(match[3]) });
    }
    const mapWays = [];
    for (const match of xml.matchAll(/<way\s+id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
      const body = match[2];
      const tags = Object.fromEntries(
        [...body.matchAll(/<tag\s+k="([^"]+)"\s+v="([^"]*)"\s*\/?>(?:<\/tag>)?/g)]
          .map((tag) => [tag[1], tag[2]]),
      );
      const isKatsuraLine = tags.name === "桂川" && tags.waterway === "river";
      const isWaterSurface = tags.natural === "water"
        || tags.waterway === "riverbank"
        || ["river", "canal"].includes(tags.water ?? "");
      if (!isKatsuraLine && !isWaterSurface) continue;
      const refs = [...body.matchAll(/<nd\s+ref="(\d+)"\s*\/?>(?:<\/nd>)?/g)].map((nd) => nd[1]);
      const geometry = refs.map((ref) => nodes.get(ref)).filter(Boolean);
      if (geometry.length > 1) mapWays.push({ type: "way", id: Number(match[1]), tags, nodes: refs.map(Number), geometry });
    }
    relationData.elements.push(...mapWays);
    console.log(`  parsed ${mapWays.length} 桂川 ways from OSM map bbox`);
  }
  const cached = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 0.6, elements: [] };
  const memberIds = new Set(
    relationData.elements
      .find((element) => element.type === "relation" && element.id === 9459116)
      ?.members?.filter((member) => member.type === "way")
      .map((member) => String(member.ref)) ?? [],
  );
  const merged = new Map((cached.elements ?? []).map((element) => [`${element.type}/${element.id}`, element]));
  for (const element of relationData.elements) {
    if ((element.type === "relation" && element.id === 9459116)
      || (element.type === "way" && (memberIds.has(String(element.id))
        || element.tags?.natural === "water"
        || element.tags?.waterway === "riverbank"
        || ["river", "canal"].includes(element.tags?.water ?? "")))) {
      const previous = merged.get(`${element.type}/${element.id}`);
      merged.set(`${element.type}/${element.id}`, {
        ...(previous ?? {}),
        ...element,
        ...(element.geometry ? {} : previous?.geometry ? { geometry: previous.geometry } : {}),
      });
    }
  }
  const output = { ...cached, elements: [...merged.values()] };
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(path, JSON.stringify(output));
  console.log(`  merged OSM relation 9459116 into tools/cache/${path.split("/cache/").at(-1)}`);
  return output;
}

function loadCachedOrFetch(file, query) {
  const path = join(CACHE, file);
  if (REFRESH_RIVER_ONLY && file === "route18_rivers.json")
    return refreshKatsuraRelationCache(path);
  if (existsSync(path) && !REFRESH_OSM) {
    console.log(`  cache hit: tools/cache/${file}`);
    return Promise.resolve(JSON.parse(readFileSync(path, "utf8")));
  }
  console.log(`  fetching from Overpass: ${file} ...`);
  return fetchJson(null, query).then((data) => {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(path, JSON.stringify(data));
    return data;
  });
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const parsePositive = (v) => {
  const n = Number(String(v ?? "").match(/\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const laneCount = (tags = {}) => {
  const lanes = parsePositive(tags.lanes);
  if (lanes) return lanes;
  const forward = parsePositive(tags["lanes:forward"]);
  const backward = parsePositive(tags["lanes:backward"]);
  if (forward || backward) return (forward ?? 1) + (backward ?? 1);
  if (tags.oneway === "yes") return 1;
  return 2;
};
const roadWidth = (tags = {}) =>
  parsePositive(tags.width) ?? laneCount(tags) * 3.2 + 1.6;
const isMajorRoad = (tags = {}) => {
  if (!ROAD_TYPES.includes(tags.highway ?? "")) return false;
  return !["driveway", "parking_aisle", "drive-through", "alley"].includes(
    tags.service ?? "",
  );
};
const rand01 = (seed) => {
  let x = Math.imul((Number(seed) || 1) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

// way群(端点共有)を1本のポリラインに連結する
function connectWays(ways) {
  const segs = ways.map((w) => w.geometry.map((p) => [p.lat, p.lon]));
  let line = [...segs[0]];
  const used = new Set([0]);
  const EPS = 1e-13; // 座標一致判定(同一ノード共有なのでほぼ厳密一致)
  let progress = true;
  while (used.size < segs.length && progress) {
    progress = false;
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue;
      const s = segs[i];
      if (dist2(line.at(-1), s[0]) < EPS) line = line.concat(s.slice(1));
      else if (dist2(line.at(-1), s.at(-1)) < EPS)
        line = line.concat([...s].reverse().slice(1));
      else if (dist2(line[0], s.at(-1)) < EPS)
        line = s.slice(0, -1).concat(line);
      else if (dist2(line[0], s[0]) < EPS)
        line = [...s].reverse().slice(0, -1).concat(line);
      else continue;
      used.add(i);
      progress = true;
      break;
    }
  }
  if (used.size !== segs.length) {
    throw new Error(`way連結失敗: ${used.size}/${segs.length} 本のみ連結`);
  }
  return line;
}

function sameOsmNodeCoord(a, b) {
  // relation の outer way は同一ノード共有なので、座標は実質的に一致する。
  // 浮動小数点JSONの丸めだけ吸収し、川のような距離ベースの連結はしない。
  return dist2(a, b) < 1e-13;
}

function stitchBuildingOuterRings(members = []) {
  const segs = members
    .filter(
      (m) => m.type === "way" && m.role === "outer" && m.geometry?.length > 1,
    )
    .map((m) => m.geometry.map((p) => [p.lat, p.lon]));
  const used = new Array(segs.length).fill(false);
  const rings = [];
  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    let chain = [...segs[start]];
    let extended = true;
    while (!sameOsmNodeCoord(chain[0], chain.at(-1)) && extended) {
      extended = false;
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        const s = segs[i];
        if (sameOsmNodeCoord(chain.at(-1), s[0])) {
          chain = chain.concat(s.slice(1));
        } else if (sameOsmNodeCoord(chain.at(-1), s.at(-1))) {
          chain = chain.concat([...s].reverse().slice(1));
        } else if (sameOsmNodeCoord(chain[0], s.at(-1))) {
          chain = s.slice(0, -1).concat(chain);
        } else if (sameOsmNodeCoord(chain[0], s[0])) {
          chain = [...s].reverse().slice(0, -1).concat(chain);
        } else continue;
        used[i] = true;
        extended = true;
        break;
      }
    }
    // 閉じない outer は footprint として三角形分割できないため捨てる。
    // inner(穴)は沿道の建物外形を増やす目的では不要なのでここでは扱わない。
    if (chain.length > 3 && sameOsmNodeCoord(chain[0], chain.at(-1))) {
      rings.push(chain);
    }
  }
  return rings;
}

function buildingRelationFootprints(elements) {
  const footprints = [];
  for (const rel of elements) {
    if (rel.type !== "relation" || !rel.tags?.building) continue;
    const rings = stitchBuildingOuterRings(rel.members);
    for (let i = 0; i < rings.length; i++) {
      footprints.push({
        type: "way",
        id: rel.id * 1000 + i,
        tags: { ...rel.tags },
        geometry: rings[i].map(([lat, lon]) => ({ lat, lon })),
        sourceRelation: rel.id,
      });
    }
  }
  return footprints;
}

function buildingFootprintElements(elements) {
  return [
    ...elements.filter(
      (e) => e.type === "way" && e.tags?.building && e.geometry?.length > 2,
    ),
    ...buildingRelationFootprints(elements),
  ];
}

/** way を指定順に連結(各 way の向きは前の終端との距離で自動判定) */
function chainOrderedWays(ways, entry) {
  let line = [];
  let cursor = entry;
  for (const w of ways) {
    let seg = w.geometry.map((p) => [p.lat, p.lon]);
    if (dist2(seg.at(-1), cursor) < dist2(seg[0], cursor))
      seg = [...seg].reverse();
    line = line.concat(line.length ? seg.slice(1) : seg);
    cursor = line.at(-1);
  }
  return line;
}

/** line の from〜to 区間を detour で差し替える */
function spliceDetour(line, detour, from, to, label) {
  const iFrom = nearestIndex(line, from);
  const iTo = nearestIndex(line, to);
  if (!(iFrom < iTo))
    throw new Error(
      `差し替え区間の探索失敗(${label}) iFrom=${iFrom} iTo=${iTo}`,
    );
  return [...line.slice(0, iFrom + 1), ...detour, ...line.slice(iTo)];
}

const nearestIndex = (line, pt) => {
  let best = 0,
    bd = Infinity;
  for (let i = 0; i < line.length; i++) {
    const d = dist2(line[i], pt);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
};

// ------------------------------------------------------------ geometry pipeline

// 緯度経度 → メートル平面(equirectangular)。Three.js: 北=-z, 東=+x
function project(latlon, origin) {
  const [lat0, lon0] = origin;
  const kLat = 111320;
  const kLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return latlon.map(([lat, lon]) => [
    (lon - lon0) * kLon,
    -(lat - lat0) * kLat,
  ]);
}

const VISUAL_TAG_KEYS = [
  "highway",
  "name",
  "oneway",
  "lanes",
  "lanes:forward",
  "lanes:backward",
  "width",
  "sidewalk",
  "sidewalk:left",
  "sidewalk:right",
  "sidewalk:both",
  "footway",
  "surface",
  "junction",
  "bridge",
  "layer",
  "access",
  "vehicle",
  "motor_vehicle",
  "maxspeed",
  "turn:lanes",
  "surface",
  "crossing",
  "crossing:markings",
  "crossing:signals",
  "barrier",
  "height",
  "natural",
  "landuse",
  "leisure",
];

function visualTags(tags = {}) {
  return Object.fromEntries(
    VISUAL_TAG_KEYS
      .filter((key) => tags[key] != null && tags[key] !== "")
      .map((key) => [key, tags[key]]),
  );
}

function buildOsmVisualSource(ways, nodes, origin) {
  const roads = [];
  const sidewalks = [];
  const stationRoads = [];
  const crossings = [];
  const pedestrianWays = [];
  const hedges = [];
  const [stationSouth, stationWest, stationNorth, stationEast] = NIJO_STATION_BBOX;
  for (const way of ways ?? []) {
    const tags = way.tags ?? {};
    const geometry = way.geometry ?? [];
    const projected = project(geometry.map((point) => [point.lat, point.lon]), origin)
      .map(([x, z]) => [x * SCALE, z * SCALE]);
    const isSidewalk = tags.footway === "sidewalk" || tags["area:highway"] === "footway";
    // RDP is useful for display-only geometry, but traffic topology needs the
    // original OSM node sequence so way.nodes remains aligned with points.
    const points = (VISUAL_ROAD_TYPES.includes(tags.highway) && !isSidewalk
      ? projected
      : rdp(projected, 0.2)
    ).map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]);
    if (points.length < 2) continue;
    const record = {
      id: way.id,
      points,
      nodeIds: way.nodes ?? [],
      tags: visualTags(tags),
      source: { provider: "OpenStreetMap", wayId: way.id },
    };
    const isCrossing = tags.footway === "crossing"
      || tags.crossing === "marked"
      || tags["crossing:markings"] === "yes";
    const isPedestrianStructure = ["footway", "steps", "pedestrian"].includes(tags.highway)
      && tags.bridge === "yes";
    if (isCrossing) crossings.push(record);
    if (isPedestrianStructure) pedestrianWays.push(record);
    if (tags.barrier === "hedge") hedges.push(record);
    if (isSidewalk) sidewalks.push(record);
    else if (VISUAL_ROAD_TYPES.includes(tags.highway)) roads.push(record);
    if (
      !isSidewalk &&
      ["service", "unclassified"].includes(tags.highway) &&
      geometry.some((point) =>
        point.lat >= stationSouth && point.lat <= stationNorth &&
        point.lon >= stationWest && point.lon <= stationEast,
      )
    ) {
      stationRoads.push(record);
    }
  }
  const trafficSignals = (nodes ?? [])
    .filter((node) => node.tags?.highway === "traffic_signals")
    .map((node) => {
      const [[x, z]] = project([[node.lat, node.lon]], origin);
      return { id: node.id, point: [+x.toFixed(2), +z.toFixed(2)], tags: visualTags(node.tags ?? {}) };
    });
  return { roads, sidewalks, stationRoads, crossings, pedestrianWays, hedges, trafficSignals };
}

/**
 * Keep the mapped Meishin mainline as a continuous OSM-derived overlay.
 * Ramps are intentionally excluded: they are separate motorway_link ways and
 * must not be mistaken for the mainline carriageway. Each source way remains
 * a segment so bridge/layer tags are preserved for the runtime renderer.
 */
function buildOsmExpressways(ways, origin) {
  return (ways ?? [])
    .filter((way) => way.tags?.highway === "motorway" && way.geometry?.length > 1)
    .map((way) => {
      const points = rdp(
        project(way.geometry.map((point) => [point.lat, point.lon]), origin)
          .map(([x, z]) => [x * SCALE, z * SCALE]),
        0.35,
      ).map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]);
      const lanes = parsePositive(way.tags?.lanes) ?? 3;
      const taggedWidth = parsePositive(way.tags?.width);
      return {
        id: way.id,
        points,
        width: +(taggedWidth ?? (lanes * 3.5 + 4.5)).toFixed(1),
        lanes,
        bridge: way.tags?.bridge === "yes",
        layer: Number(way.tags?.layer ?? 0) || 0,
        tags: visualTags(way.tags),
        source: { provider: "OpenStreetMap", wayId: way.id },
      };
    })
    .filter((way) => way.points.length > 1);
}

const OSM_TREE_AREA_TAGS = new Set(["wood", "forest", "scrub"]);
const OSM_GREEN_AREA_TAGS = new Set(["grass", "park", "garden"]);

function buildOsmVegetationSource(elements, origin) {
  const trees = [];
  const treeRows = [];
  const treeAreas = [];
  const greenAreas = [];
  for (const element of elements ?? []) {
    const tags = element.tags ?? {};
    if (element.type === "node" && tags.natural === "tree") {
      const [x, z] = project([[element.lat, element.lon]], origin)[0];
      trees.push({
        id: element.id,
        point: [+(x * SCALE).toFixed(2), +(z * SCALE).toFixed(2)],
        species: tags.species ?? tags.genus ?? null,
      });
      continue;
    }
    if (element.type !== "way" || !element.geometry?.length) continue;
    let points = project(
      element.geometry.map((point) => [point.lat, point.lon]),
      origin,
    ).map(([x, z]) => [x * SCALE, z * SCALE]);
    if (points.length < 2) continue;
    const natural = tags.natural ?? "";
    const landuse = tags.landuse ?? "";
    const leisure = tags.leisure ?? "";
    if (natural === "tree_row") {
      treeRows.push({
        id: element.id,
        points: rdp(points, 0.4).map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]),
      });
    }
    if (OSM_TREE_AREA_TAGS.has(natural) || landuse === "forest") {
      // 面wayは始点を終点に繰り返す閉じたリングになっている。
      // 閉じたままRDPへ渡すと基準線の長さが0になり、全体が2点へ縮退するため、
      // 簡略化前に終端の重複点だけ外す。レンダラー側で暗黙に閉じる。
      if (points.length > 2 && dist2(points[0], points.at(-1)) < 0.25)
        points = points.slice(0, -1);
      treeAreas.push({
        id: element.id,
        kind: natural || landuse,
        polygon: rdp(points, 0.8).map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]),
      });
    }
    if (OSM_GREEN_AREA_TAGS.has(landuse) || OSM_GREEN_AREA_TAGS.has(leisure)) {
      // Closed OSM rings repeat their first point at the end.  Remove only
      // that duplicate before simplification; otherwise RDP sees a zero-length
      // baseline and collapses an entire planted island to a point.
      if (points.length > 2 && dist2(points[0], points.at(-1)) < 0.25)
        points = points.slice(0, -1);
      greenAreas.push({
        id: element.id,
        kind: landuse || leisure,
        polygon: rdp(points, 0.8).map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]),
      });
    }
  }
  return { trees, treeRows, treeAreas, greenAreas };
}

// Ramer-Douglas-Peucker 簡略化
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts.at(-1)];
  let maxD = 0,
    idx = 0;
  const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dx, dz) || 1e-12;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dx * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * dz) / len;
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [a, b];
  return rdp(pts.slice(0, idx + 1), eps)
    .slice(0, -1)
    .concat(rdp(pts.slice(idx), eps));
}

// river waterway way(緯度経度 LineString の集合)を端点近傍(STITCH_TOL 度以内)で
// つなぎ合わせ、実世界で連続した1本(またはそれ以上)のポリラインの配列にする。
// OSM の川は橋・中州・支流合流などで way が細切れになっており、connectWays のような
// 厳密一致(同一ノード共有前提)では繋がらないことがあるため、距離ベースで緩めに結合する。
const RIVER_STITCH_TOL = 0.0003; // 度(約30m)。橋部分などの短い断絶を許容
function stitchRiverWays(ways) {
  const segs = ways.map((w) => w.geometry.map((p) => [p.lat, p.lon]));
  const used = new Array(segs.length).fill(false);
  const chains = [];
  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    let chain = [...segs[start]];
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        const s = segs[i];
        if (dist2(chain.at(-1), s[0]) < RIVER_STITCH_TOL ** 2) {
          chain = chain.concat(s.slice(1));
        } else if (dist2(chain.at(-1), s.at(-1)) < RIVER_STITCH_TOL ** 2) {
          chain = chain.concat([...s].reverse().slice(1));
        } else if (dist2(chain[0], s.at(-1)) < RIVER_STITCH_TOL ** 2) {
          chain = s.slice(0, -1).concat(chain);
        } else if (dist2(chain[0], s[0]) < RIVER_STITCH_TOL ** 2) {
          chain = [...s].reverse().slice(0, -1).concat(chain);
        } else continue;
        used[i] = true;
        extended = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

/**
 * 橋の実座標アンカー周辺の川ポリラインを実データ(OSM waterway)から切り出し、
 * ゲーム座標へ投影する。戻り値は経路 SVG 表示・水面配置の向き決定に使う
 * {points:[[x,z],...], headingDeg}(headingDeg は経路 heading と同じ規約: 0=南, 東回り+)。
 */
function extractRiverLine(
  riverWays,
  riverName,
  anchor,
  origin,
  halfWindowM = 220,
) {
  const ways = riverWays.filter((w) => w.tags?.name === riverName);
  if (!ways.length) return null;
  const chains = stitchRiverWays(ways);
  // アンカーに最も近いチェーン・頂点を探す
  let best = null;
  for (const chain of chains) {
    for (let i = 0; i < chain.length; i++) {
      const d = dist2(chain[i], anchor);
      if (!best || d < best.d) best = { d, chain, idx: i };
    }
  }
  if (!best) return null;
  const { chain, idx } = best;
  // アンカーから実距離 halfWindowM だけ前後に切り出す(等緯度近似: 1度≒111320m)
  const kLat = 111320;
  const kLon = 111320 * Math.cos((anchor[0] * Math.PI) / 180);
  const distFrom = (i) =>
    Math.hypot(
      (chain[i][1] - anchor[1]) * kLon,
      (chain[i][0] - anchor[0]) * kLat,
    );
  let lo = idx,
    hi = idx;
  while (lo > 0 && distFrom(lo - 1) < halfWindowM) lo--;
  while (hi < chain.length - 1 && distFrom(hi + 1) < halfWindowM) hi++;
  const clipped = chain.slice(lo, hi + 1);
  if (clipped.length < 2) return null;
  const projected = project(clipped, origin).map(([x, z]) => [
    +(x * SCALE).toFixed(2),
    +(z * SCALE).toFixed(2),
  ]);
  const simplified = rdp(projected, 1.5 * SCALE);
  const taggedWidths = ways
    .map((way) => parsePositive(way.tags?.width))
    .filter((width) => width != null)
    .sort((a, b) => a - b);
  const widthMeters = taggedWidths.length
    ? taggedWidths[Math.floor(taggedWidths.length / 2)]
    : null;
  // 交差点(アンカー)ちょうどの実測の川方位を求める。頂点間隔が疎な区間もあるため、
  // 頂点番号ではなく実距離(±HEADING_WINDOW_M)でアンカー前後をたどって局所方位を取る
  // (川全体のゆるいカーブに引っ張られず、橋の直近の向きを反映させるため)。
  const HEADING_WINDOW_M = 60;
  const anchorIdx = idx - lo;
  const distAlong = (i) =>
    Math.hypot(
      projected[i][0] - projected[anchorIdx][0],
      projected[i][1] - projected[anchorIdx][1],
    );
  let ai = anchorIdx,
    bi = anchorIdx;
  while (ai > 0 && distAlong(ai - 1) < HEADING_WINDOW_M) ai--;
  while (bi < projected.length - 1 && distAlong(bi + 1) < HEADING_WINDOW_M)
    bi++;
  // 頂点間隔が疎で窓内に隣接点が無い場合は、最低限1つ隣の頂点を使う(方位0への縮退回避)
  if (ai === anchorIdx && ai > 0) ai--;
  if (bi === anchorIdx && bi < projected.length - 1) bi++;
  const a = projected[ai];
  const b = projected[bi];
  const headingDeg = +(
    (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) /
    Math.PI
  ).toFixed(1);
  return { points: simplified, headingDeg, ...(widthMeters ? { widthMeters } : {}) };
}

// 鋭い折れを円弧フィレットに置換。TURN_MIN_ANGLE 以上の折れ(右左折交差点)は
// 小半径 turnRadius で曲げ、交差点情報(頂点・接点・進入/退出方位)を corners に記録する。
function filletCorners(
  pts,
  radius,
  minAngleDeg,
  turnMinAngleDeg = Infinity,
  turnRadius = radius,
) {
  const out = [pts[0]];
  const corners = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const v1 = [p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]];
    const v2 = [pts[i + 1][0] - p[0], pts[i + 1][1] - p[1]];
    const l1 = Math.hypot(...v1),
      l2 = Math.hypot(...v2);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const u1 = [v1[0] / l1, v1[1] / l1],
      u2 = [v2[0] / l2, v2[1] / l2];
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const dot = u1[0] * u2[0] + u1[1] * u2[1];
    const angle = Math.atan2(cross, dot); // 転回角(符号付き)
    if (Math.abs(angle) < (minAngleDeg * Math.PI) / 180) {
      out.push(p);
      continue;
    }
    const isTurn = Math.abs(angle) >= (turnMinAngleDeg * Math.PI) / 180;
    const baseR = isTurn ? turnRadius : radius;
    // 接点距離 d = R tan(|θ|/2)。セグメント長でクランプし実効半径を再計算
    let d = baseR * Math.tan(Math.abs(angle) / 2);
    const dMax = 0.45 * Math.min(l1, l2);
    const r = d > dMax ? dMax / Math.tan(Math.abs(angle) / 2) : baseR;
    d = Math.min(d, dMax);
    const t1 = [p[0] - u1[0] * d, p[1] - u1[1] * d];
    // 円弧中心: t1 から進入方向の法線(曲がる側)へ r
    const sign = Math.sign(angle);
    const n1 = [-u1[1] * sign, u1[0] * sign];
    const c = [t1[0] + n1[0] * r, t1[1] + n1[1] * r];
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    const steps = Math.max(
      2,
      Math.ceil(Math.abs(angle) / ((5 * Math.PI) / 180)),
    );
    for (let k = 0; k <= steps; k++) {
      const a = a0 + (angle * k) / steps;
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
    if (isTurn) {
      corners.push({
        vertex: p,
        t1,
        t2: [p[0] + u2[0] * d, p[1] + u2[1] * d],
        u1,
        u2,
        angle,
        r,
        d,
      });
    }
  }
  out.push(pts.at(-1));
  return { pts: out, corners };
}

// 等間隔リサンプル
function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= segLen) {
      out.push([
        a[0] + ((b[0] - a[0]) * t) / segLen,
        a[1] + ((b[1] - a[1]) * t) / segLen,
      ]);
      t += step;
    }
    carry = segLen - (t - step);
  }
  out.push(pts.at(-1));
  return out;
}

// 点をポリラインに射影して弧長 s を返す(fromS 以降を探索: 停留所順の単調性を保証)
function projectToPath(path, cumLen, pt, fromS = 0) {
  let bestS = fromS,
    bd = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    if (cumLen[i + 1] < fromS) continue;
    const [a, b] = [path[i], path[i + 1]];
    const [abx, abz] = [b[0] - a[0], b[1] - a[1]];
    const ab2 = abx * abx + abz * abz || 1e-12;
    let t = ((pt[0] - a[0]) * abx + (pt[1] - a[1]) * abz) / ab2;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + abx * t, a[1] + abz * t];
    const s = cumLen[i] + Math.hypot(abx, abz) * t;
    if (s < fromS) continue;
    const d = dist2(q, pt);
    if (d < bd) {
      bd = d;
      bestS = s;
    }
  }
  return { s: bestS, dist: Math.sqrt(bd) };
}

function pointSegDistance(pt, a, b) {
  const abx = b[0] - a[0],
    abz = b[1] - a[1];
  const ab2 = abx * abx + abz * abz || 1e-12;
  const t = clamp(((pt[0] - a[0]) * abx + (pt[1] - a[1]) * abz) / ab2, 0, 1);
  const q = [a[0] + abx * t, a[1] + abz * t];
  return { d: Math.hypot(pt[0] - q[0], pt[1] - q[1]), q, t };
}

function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function pointOnSegment(p, a, b, eps = 1e-9) {
  return (
    Math.min(a[0], b[0]) - eps <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) + eps &&
    Math.min(a[1], b[1]) - eps <= p[1] &&
    p[1] <= Math.max(a[1], b[1]) + eps &&
    Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) <=
      eps
  );
}

function segmentOrientation(a, b, c, eps = 1e-9) {
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(cross) <= eps) return 0;
  return cross > 0 ? 1 : -1;
}

function segmentsIntersect(a, b, c, d) {
  const o1 = segmentOrientation(a, b, c);
  const o2 = segmentOrientation(a, b, d);
  const o3 = segmentOrientation(c, d, a);
  const o4 = segmentOrientation(c, d, b);
  if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4)
    return true;
  return (
    (o1 === 0 && pointOnSegment(c, a, b)) ||
    (o2 === 0 && pointOnSegment(d, a, b)) ||
    (o3 === 0 && pointOnSegment(a, c, d)) ||
    (o4 === 0 && pointOnSegment(b, c, d))
  );
}

function polygonSelfIntersects(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i],
      b = poly[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) === 1 || (i === 0 && j === n - 1)) continue;
      const c = poly[j],
        d = poly[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function simplifyClosed(poly, eps = 0.6) {
  if (poly.length <= 8) return poly;
  const simplified = rdp([...poly, poly[0]], eps).slice(0, -1);
  if (simplified.length >= 3 && simplified.length <= 20) return simplified;
  if (simplified.length >= 3) return simplified.slice(0, 20);
  return poly.slice(0, 20);
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

function closestRoadSample(path, cumLen, roadPts, fromS = 0) {
  let best = null;
  for (let i = 0; i < roadPts.length - 1; i++) {
    const a = roadPts[i],
      b = roadPts[i + 1];
    const segHeading = Math.atan2(b[0] - a[0], b[1] - a[1]);
    for (let k = 0; k <= 2; k++) {
      const t = k / 2;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const hit = projectToPath(path, cumLen, p, fromS);
      if (!best || hit.dist < best.dist) best = { ...hit, heading: segHeading };
    }
  }
  return best;
}

function closestRoadNearS(path, cumLen, road, s) {
  const [px, pz] = pointAtPath(path, cumLen, s);
  let best = null;
  for (let i = 0; i < road.pts.length - 1; i++) {
    const a = road.pts[i],
      b = road.pts[i + 1];
    const segH = Math.atan2(b[0] - a[0], b[1] - a[1]);
    const hit = pointSegDistance([px, pz], a, b);
    const qHit = projectToPath(path, cumLen, hit.q, Math.max(0, s - 140));
    const ds = Math.abs(qHit.s - s);
    const score = hit.d + ds * 0.45;
    if (!best || score < best.score)
      best = { ...qHit, heading: segH, distToRoad: hit.d, ds, score };
  }
  return best;
}

function routeHeadingAt(path, cumLen, s) {
  let i = 0;
  while (i < cumLen.length - 2 && cumLen[i + 1] < s) i++;
  const a = path[i],
    b = path[Math.min(path.length - 1, i + 1)];
  return Math.atan2(b[0] - a[0], b[1] - a[1]);
}

// 区間の左右幅(センター〜路端)。一方通行は経路=道路中心なので左右等分
function sectionWidths(sec) {
  if (!sec.lanesB) {
    const w = (sec.lanesF * LANE_W + 2.8) / 2;
    return { wL: +w.toFixed(2), wR: +w.toFixed(2) };
  }
  return {
    wL: +(sec.lanesF * LANE_W + 0.8).toFixed(2),
    wR: +(sec.lanesB * LANE_W + 0.8).toFixed(2),
  };
}

/** sections の [from,to] 部分だけ mut を適用(必要に応じて区間分割) */
function overlayLanes(sections, from, to, mut) {
  if (to - from < 4) return sections;
  const out = [];
  for (const sec of sections) {
    const a = Math.max(sec.from, from),
      b = Math.min(sec.to, to);
    if (b - a < 0.5) {
      out.push(sec);
      continue;
    }
    if (sec.from < a - 0.01) out.push({ ...sec, to: a });
    out.push(mut({ ...sec, from: a, to: b }));
    if (b < sec.to - 0.01) out.push({ ...sec, from: b, to: sec.to });
  }
  return out;
}

/**
 * OSM way の車線タグから routeSections を生成する。
 *
 * 以前は、交差点名・座標・現地推定を並べた LANE_PLAN が経路の車線の
 * 正本になっていた。そのため本線のセンターラインと交差道路の接続が
 * 別々に更新され、OSMの実形状から車線が外れていた。ここでは経路に
 * 最近接し、進行方向が一致する OSM way を各断面で選び、lanes / oneway /
 * sidewalk を連続区間へ畳み込む。PLATEAUの実路面へのスナップは後段の
 * driving-network compiler が一括して行う。
 */
function buildLaneSections(
  path,
  cumLen,
  origin,
  roads,
  signals,
  turnSpans,
  intersections,
  elevations = [],
) {
  const projectedRoads = (roads ?? [])
    .map((road) => ({
      id: road.id,
      tags: road.tags ?? {},
      points: project(
        (road.geometry ?? []).map((point) => [point.lat, point.lon]),
        origin,
      ).map(([x, z]) => [x * SCALE, z * SCALE]),
    }))
    .filter((road) => road.points.length > 1);
  const profileAt = (s) => {
    const point = pointAtPath(path, cumLen, s);
    const routeHeading = routeHeadingAt(path, cumLen, s);
    let best = null;
    for (const road of projectedRoads) {
      for (let index = 1; index < road.points.length; index++) {
        const a = road.points[index - 1], b = road.points[index];
        const hit = pointSegDistance(point, a, b);
        const roadHeading = Math.atan2(b[0] - a[0], b[1] - a[1]);
        const alignment = Math.min(angleDiff(roadHeading, routeHeading), angleDiff(roadHeading, routeHeading + Math.PI));
        if (hit.d > 22 || alignment > 0.65) continue;
        const score = hit.d + alignment * 9;
        if (!best || score < best.score) best = { road, score, roadHeading };
      }
    }
    const tags = best?.road.tags ?? {};
    const oneway = ["yes", "1", "true", "-1"].includes(String(tags.oneway));
    const wayLanes = laneCount(tags);
    const sameDirection = best
      ? angleDiff(best.roadHeading, routeHeading) < Math.PI / 2
      : true;
    let lanesF;
    let lanesB;
    if (oneway) {
      // The route relation is authoritative for which direction the bus uses;
      // a reversed OSM way still describes a one-way carriageway, not an
      // invitation to create an opposing lane.
      lanesF = Math.max(1, wayLanes);
      lanesB = 0;
    } else {
      const forward = parsePositive(tags["lanes:forward"]);
      const backward = parsePositive(tags["lanes:backward"]);
      const total = Math.max(2, wayLanes);
      const f = forward ?? Math.ceil(total / 2);
      const b = backward ?? Math.floor(total / 2);
      lanesF = Math.max(1, Math.round(sameDirection ? f : b));
      lanesB = Math.max(0, Math.round(sameDirection ? b : f));
    }
    return {
      lanesF,
      lanesB,
      center: lanesB ? "line" : "none",
      sidewalk: tags.sidewalk === "no" || tags["sidewalk:both"] === "no" ? "none" : "line",
      sourceWay: best?.road.id ?? null,
    };
  };
  const total = cumLen.at(-1);
  const samplePositions = new Set();
  for (let s = 0; s <= total; s += 8) samplePositions.add(Math.min(total, s));
  for (const s of [
    ...turnSpans.flatMap((span) => [span.sIn, span.sOut]),
    ...(intersections ?? []).map((intersection) => intersection.s),
  ]) if (s > 0 && s < total) samplePositions.add(s);
  const samples = [...samplePositions]
    .sort((a, b) => a - b)
    .map((s) => ({ s, profile: profileAt(s) }));
  const sameProfile = (a, b) => a.lanesF === b.lanesF
    && a.lanesB === b.lanesB
    && a.center === b.center
    && a.sidewalk === b.sidewalk;
  const sections = [];
  let from = samples[0]?.s ?? 0;
  let current = samples[0]?.profile ?? { lanesF: 1, lanesB: 1, center: "line", sidewalk: "line" };
  for (let index = 1; index < samples.length; index++) {
    const next = samples[index];
    if (sameProfile(current, next.profile)) continue;
    sections.push({ from, to: next.s, ...current });
    from = next.s;
    current = next.profile;
  }
  sections.push({ from, to: total, ...current });
  let normalized = sections;
  // 跨線橋区間: 中央の片道2車線だけを橋上車線とし、両外側の側道は地表に残す。
  // laneOverride が付いた elevations のみ対象(河川の小さな盛土は車線数を変えない)
  for (const e of elevations) {
    if (!e.laneOverride) continue;
    // A structural laneOverride describes the physical deck, while
    // autoEntryFrom describes where the outer ground-level lane merges into
    // that deck. Keep that merge as a data-driven transition rather than a
    // hand-authored road-name section.
    if (e.autoEntryFrom != null && e.autoEntryFrom < e.from) {
      normalized = overlayLanes(
        normalized,
        e.autoEntryFrom,
        e.from,
        (sec) => ({
          ...sec,
          lanesF: Math.max(sec.lanesF, 2 + Number(e.laneOverride)),
          lanesB: Math.max(sec.lanesB, 2 + Number(e.laneOverride)),
          center: "line",
        }),
      );
    }
    normalized = overlayLanes(
      normalized,
      e.from - (e.approachIn ?? 50),
      e.to + (e.approachOut ?? 50),
      (sec) => ({
        ...sec,
        lanesF: 2,
        lanesB: 2,
        bridge: 1,
        sidewalk: "none", // 高架橋のデッキ・取り付け部に歩道は無い
      }),
    );
  }
  return normalized
    .filter((sec) => sec.to - sec.from > 0.5)
    .map((sec) => ({
      from: +sec.from.toFixed(1),
      to: +sec.to.toFixed(1),
      lanes: sec.lanesF + sec.lanesB,
      lanesF: sec.lanesF,
      lanesB: sec.lanesB,
      center: sec.center,
      ...(sec.sidewalk === "none" ? { sidewalk: "none" } : {}),
      ...(sec.bridge ? { bridge: 1 } : {}),
      ...sectionWidths(sec),
    }));
}

// 交差点腕(側=+1: heading方向 / 側=-1: heading+PI方向)の実在判定と長さ。
// OSMは交差点ごとに way を分割するため、マッチした1本の way だけでは実際の街路の
// 延長を過小評価してしまう(4差路が偽のT字路に見える)。そのため周辺の全 road の中から
// heading 軸にほぼ平行(±22°)かつ軸から近い(横ずれ7m以内)セグメントを拾い集め、
// 交差点中心から各側へ届く最大距離を求める。
function armExtent(roads, crossPt, heading) {
  const dx = Math.sin(heading),
    dz = Math.cos(heading);
  const nx = Math.cos(heading),
    nz = -Math.sin(heading);
  const LAT_TOL = 7,
    MAX_REACH = 160,
    PARALLEL_TOL = (22 * Math.PI) / 180;
  let pos = 0,
    neg = 0;
  for (const road of roads) {
    for (let i = 0; i < road.pts.length - 1; i++) {
      const a = road.pts[i],
        b = road.pts[i + 1];
      const segH = Math.atan2(b[0] - a[0], b[1] - a[1]);
      const parallel =
        Math.min(angleDiff(segH, heading), angleDiff(segH, heading + Math.PI)) <
        PARALLEL_TOL;
      if (!parallel) continue;
      for (const p of [a, b]) {
        const rx = p[0] - crossPt[0],
          rz = p[1] - crossPt[1];
        const along = rx * dx + rz * dz;
        const lat = rx * nx + rz * nz;
        if (Math.abs(lat) > LAT_TOL || Math.abs(along) > MAX_REACH) continue;
        if (along > pos) pos = along;
        if (-along > neg) neg = -along;
      }
    }
  }
  return { pos, neg };
}
function buildArms(roads, crossPt, heading, lanes) {
  const { pos, neg } = armExtent(roads, crossPt, heading);
  const lanesF = Math.max(1, Math.ceil(lanes / 2));
  const lanesB = Math.max(0, Math.floor(lanes / 2));
  const mk = (side, extent) => ({
    side,
    exists: extent >= CROSS_STREET_ARM_MIN,
    length: extent >= CROSS_STREET_ARM_MIN ? CROSS_STREET_ARM_LEN : 0,
    lanesF,
    lanesB,
  });
  return [mk(1, pos), mk(-1, neg)];
}

function roadMetadata(path, cumLen, origin, roads, signalNodes) {
  const projectedRoads = roads
    .map((road) => ({
      id: road.id,
      tags: road.tags ?? {},
      pts: project(
        road.geometry.map((p) => [p.lat, p.lon]),
        origin,
      ).map(([x, z]) => [x * SCALE, z * SCALE]),
    }))
    .filter((r) => r.pts.length > 1);

  const intersectionCandidates = [];
  for (const road of projectedRoads) {
    const hit = closestRoadSample(path, cumLen, road.pts, 0);
    if (!hit || hit.dist > 14) continue;
    const routeH = routeHeadingAt(path, cumLen, hit.s);
    const crossing = Math.min(
      angleDiff(routeH, hit.heading),
      angleDiff(routeH, hit.heading + Math.PI),
    );
    if (crossing < 0.42) continue;
    const lanes0 = laneCount(road.tags);
    intersectionCandidates.push({
      s: +hit.s.toFixed(1),
      heading: +hit.heading.toFixed(4),
      width: +roadWidth(road.tags).toFixed(1),
      length: +Math.max(34, roadWidth(road.tags) * 7).toFixed(1),
      lanes: lanes0,
      highway: road.tags.highway,
      name: road.tags.name ?? "",
      dist: hit.dist,
      arms: buildArms(
        projectedRoads,
        pointAtPath(path, cumLen, hit.s),
        hit.heading,
        lanes0,
      ),
    });
  }
  intersectionCandidates.sort((a, b) => a.s - b.s || a.dist - b.dist);
  const intersections = [];
  for (const ix of intersectionCandidates) {
    const prev = intersections.at(-1);
    if (prev && Math.abs(ix.s - prev.s) < 24) {
      if (ix.width > prev.width) Object.assign(prev, ix);
    } else {
      intersections.push(ix);
    }
  }

  const signals = signalNodes
    .map((node) => {
      const pt = project([[node.lat, node.lon]], origin)[0].map(
        (v) => v * SCALE,
      );
      const { s, dist } = projectToPath(path, cumLen, pt, 0);
      return {
        s: +s.toFixed(1),
        name: node.tags?.name ?? "traffic_signal",
        dist,
      };
    })
    .filter((sig) => sig.dist < 35)
    .sort((a, b) => a.s - b.s)
    .reduce((acc, sig) => {
      if (!acc.length || Math.abs(sig.s - acc.at(-1).s) > 42)
        acc.push({ s: sig.s, name: sig.name });
      return acc;
    }, []);

  for (const sig of signals) {
    if (intersections.some((ix) => Math.abs(ix.s - sig.s) < 28)) continue;
    const routeH = routeHeadingAt(path, cumLen, sig.s);
    let best = null;
    for (const road of projectedRoads) {
      const hit = closestRoadNearS(path, cumLen, road, sig.s);
      if (!hit || hit.dist > 45 || hit.ds > 55) continue;
      const crossing = Math.min(
        angleDiff(routeH, hit.heading),
        angleDiff(routeH, hit.heading + Math.PI),
      );
      if (crossing < 0.35) continue;
      if (!best || hit.score < best.hit.score) best = { road, hit };
    }
    if (best) {
      const tags = best.road.tags;
      const lanes0 = laneCount(tags);
      intersections.push({
        s: sig.s,
        heading: +best.hit.heading.toFixed(4),
        width: +roadWidth(tags).toFixed(1),
        length: +Math.max(38, roadWidth(tags) * 7).toFixed(1),
        lanes: lanes0,
        highway: tags.highway,
        name: tags.name ?? sig.name,
        dist: best.hit.dist,
        arms: buildArms(
          projectedRoads,
          pointAtPath(path, cumLen, sig.s),
          best.hit.heading,
          lanes0,
        ),
      });
    }
  }
  intersections.sort((a, b) => a.s - b.s || a.dist - b.dist);

  // 交差道路の実勢オーバーライド(五条通=計9・四条通=計5 等)
  for (const ov of INTERSECTION_OVERRIDES) {
    for (const ix of intersections) {
      if (ix.name !== ov.name) continue;
      if (ov.width != null) ix.width = ov.width;
      if (ov.lanes != null) ix.lanes = ov.lanes;
      if (ov.width != null) ix.length = +Math.max(34, ov.width * 7).toFixed(1);
      if (ov.median) ix.median = 1;
      if (ov.label) ix.name = ov.label;
      if (ov.arms) {
        ix.arms = (
          ix.arms ?? [
            { side: 1, exists: true, length: CROSS_STREET_ARM_LEN },
            { side: -1, exists: true, length: CROSS_STREET_ARM_LEN },
          ]
        ).map((a) => {
          const o = ov.arms.find((x) => x.side === a.side);
          return o ? { ...a, ...o } : a;
        });
      }
    }
  }

  return { intersections, signals };
}

function buildingHeight(tags = {}, s, routeLength, id) {
  const taggedHeight = parsePositive(tags.height);
  if (taggedHeight) return clamp(taggedHeight, 2.8, 42);
  const levels = parsePositive(tags["building:levels"]);
  if (levels) return clamp(levels * 3.1, 2.8, 42);
  const t = s / routeLength;
  const r = rand01(id);
  if (t < 0.45) return +(6 + r * 16).toFixed(1);
  if (t < 0.65) return +(5 + r * 10).toFixed(1);
  return +(3.8 + r * 6.5).toFixed(1);
}

function parseColorTag(value) {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  const hex6 = s.match(/^#?([0-9a-f]{6})$/);
  if (hex6) return Number.parseInt(hex6[1], 16);
  const hex3 = s.match(/^#?([0-9a-f]{3})$/);
  if (hex3) {
    const v = hex3[1]
      .split("")
      .map((c) => c + c)
      .join("");
    return Number.parseInt(v, 16);
  }
  return (
    {
      white: 0xe8e4dc,
      grey: 0xaeb4b8,
      gray: 0xaeb4b8,
      black: 0x2f3438,
      brown: 0x8b6f5a,
      beige: 0xd9d2c4,
      red: 0xb56a61,
      orange: 0xc9894b,
      yellow: 0xd7bf62,
      green: 0x7f9a72,
      blue: 0x6f8fae,
    }[s] ?? null
  );
}

function buildingColor(tags = {}, id) {
  // OSMの色指定は way ではなく multipolygon relation 側だけに付くことがあるため、
  // relation 展開後に引き継いだ tags からも外壁色を拾う。
  const taggedColor = parseColorTag(
    tags["building:colour"] ??
      tags["building:color"] ??
      tags.colour ??
      tags.color,
  );
  if (taggedColor != null) return taggedColor;
  if (tags.amenity === "parking") return 0xaab1b7;
  const palette = [
    0xd9d2c4, 0xcfc8ba, 0xbfb7a8, 0xa89f90, 0x8f8a80, 0xe2ddd2, 0xaeb4b8,
    0x9aa0a8,
  ];
  return palette[Math.floor(rand01(id) * palette.length)];
}

function closestFootprintVertex(path, cumLen, footprint) {
  let best = null;
  for (const p of footprint) {
    const hit = projectToPath(path, cumLen, p, 0);
    if (!best || hit.dist < best.dist) best = hit;
  }
  return best;
}

function buildingMetadata(
  path,
  cumLen,
  origin,
  buildingWays,
  roadHalfWidthAt = () => FALLBACK_BUILDING_ROAD_HALF_WIDTH,
) {
  const selected = [];
  for (const way of buildingWays) {
    if (!way.geometry?.length || !way.tags?.building) continue;
    let footprint = project(
      way.geometry.map((p) => [p.lat, p.lon]),
      origin,
    ).map(([x, z]) => [+(x * SCALE).toFixed(2), +(z * SCALE).toFixed(2)]);
    if (footprint.length > 2 && dist2(footprint[0], footprint.at(-1)) < 0.05)
      footprint = footprint.slice(0, -1);
    if (footprint.length < 3) continue;
    // 面積の大小では除外しない。物置や大型商業施設も道路端から20m以内なら
    // 収録対象にするため、ここでは三角形分割できない退化形状だけを落とす。
    if (
      Math.abs(polygonArea(footprint)) < 1e-6 ||
      polygonSelfIntersects(footprint)
    )
      continue;
    const hit = closestFootprintVertex(path, cumLen, footprint);
    const keepDist = roadHalfWidthAt(hit.s) + BUILDING_ROADSIDE_DEPTH;
    if (hit.dist > keepDist) continue;
    footprint = simplifyClosed(footprint);
    if (footprint.length < 3 || Math.abs(polygonArea(footprint)) < 1e-6)
      continue;
    if (polygonArea(footprint) < 0) footprint.reverse();
    selected.push({
      id: way.id,
      s: +hit.s.toFixed(1),
      dist: +hit.dist.toFixed(1),
      height: +buildingHeight(way.tags, hit.s, cumLen.at(-1), way.id).toFixed(
        1,
      ),
      color: buildingColor(way.tags, way.id),
      footprint,
    });
  }
  selected.sort((a, b) => a.s - b.s || a.dist - b.dist);
  return selected.map(({ id, dist, ...b }) => b);
}

function railwayMetadata(path, cumLen, origin, railWays, sFrom, sTo) {
  const groups = { conventional: [], shinkansen: [] };
  for (const way of railWays) {
    const tags = way.tags ?? {};
    if (tags.railway !== "rail" || tags.railway === "platform") continue;
    if (
      tags.railway === "platform" ||
      tags.usage === "tourism" ||
      tags["railway:preserved"]
    )
      continue;
    const pts = project(
      way.geometry.map((p) => [p.lat, p.lon]),
      origin,
    ).map(([x, z]) => [x * SCALE, z * SCALE]);
    if (pts.length < 2) continue;
    const hit = closestRoadSample(path, cumLen, pts, Math.max(0, sFrom - 80));
    if (!hit || hit.dist > 45 || hit.s < sFrom || hit.s > sTo) continue;
    const routeH = routeHeadingAt(path, cumLen, hit.s);
    const crossing = Math.min(
      angleDiff(routeH, hit.heading),
      angleDiff(routeH, hit.heading + Math.PI),
    );
    if (crossing < 0.75) continue;
    const name = tags["name:ja"] ?? tags.name ?? "";
    const isShinkansen =
      tags.highspeed === "yes" ||
      tags.gauge === "1435" ||
      name.includes("新幹線");
    const isConventional =
      tags.gauge === "1067" ||
      name.includes("東海道本線") ||
      name.includes("山陰本線");
    if (!isShinkansen && !isConventional) continue;
    groups[isShinkansen ? "shinkansen" : "conventional"].push({
      s: hit.s,
      heading: hit.heading,
      service: tags.service ?? "",
      name,
    });
  }

  const buildGroup = (kind, list) => {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a.s - b.s);
    const sMin = sorted[0].s;
    const sMax = sorted.at(-1).s;
    const main = sorted.filter(
      (r) => !["crossover", "siding", "yard", "spur"].includes(r.service),
    );
    const src = main.length ? main : sorted;
    const mainTracks = main.length;
    const s = src.reduce((a, r) => a + r.s, 0) / src.length;
    // 方位は mod-π の円周平均(倍角トリック)。OSM の way は東向き/西向きが混在し
    // (θ と θ+π)、単純平均では打ち消し合って道路と平行な向きに潰れてしまう。
    const heading =
      0.5 *
      Math.atan2(
        src.reduce((a, r) => a + Math.sin(2 * r.heading), 0),
        src.reduce((a, r) => a + Math.cos(2 * r.heading), 0),
      );
    if (kind === "shinkansen") {
      return {
        kind: "shinkansen-viaduct",
        name: "東海道新幹線",
        s: +s.toFixed(1),
        heading: +heading.toFixed(4),
        length: 190,
        width: 16,
        trackCount: 2,
        layer: 3,
      };
    }
    const trackCount = clamp(Math.round(mainTracks || sorted.length), 4, 8);
    return {
      kind: "conventional-underpass",
      name: "JR在来線(東海道本線・山陰本線)",
      s: +s.toFixed(1),
      fromS: +Math.max(sFrom, sMin - 18).toFixed(1),
      toS: +Math.min(sTo, sMax + 18).toFixed(1),
      heading: +heading.toFixed(4),
      length: 185,
      width: +(trackCount * 3.2 + 8).toFixed(1),
      trackCount,
      layer: 0,
      roadLayer: 1,
    };
  };

  return [
    buildGroup("conventional", groups.conventional),
    buildGroup("shinkansen", groups.shinkansen),
  ]
    .filter(Boolean)
    .sort((a, b) => a.s - b.s);
}

/**
 * 信号の柱・灯器のワールド座標を計算して heads 配列を返す(JSONに埋め込み、描画側は置くだけ)。
 * 右左折交差点では四隅の歩道角(両道路の路端+1.85m の交点)に柱を立てる。
 * 通常交差点ではルート接線基準・従道柱は交差道路の幅の外側。
 * head: {kind:'main'|'cross', face, pole:[x,z], head:[x,z], arm?, hoods?}
 */
function placeSignalHeads(sig, turns, intersections, path, cumLen, widths) {
  const { hwAt, wLAt, wRAt, laneCenterAt, oppLaneCenterAt } = widths;
  const round = (p) => [+p[0].toFixed(2), +p[1].toFixed(2)];
  // 柱の退避対象となる舗装矩形: 近傍の交差道路スタブ + 右左折交差点の腕
  const rects = [
    ...intersections
      .filter((i) => Math.abs(i.s - sig.s) < 70)
      .map((i) => {
        const [cx, cz] = pointAtPath(path, cumLen, i.s);
        return {
          cx,
          cz,
          heading: i.heading,
          from: -i.length / 2,
          to: i.length / 2,
          hw: i.width / 2,
        };
      }),
    ...turns
      .filter((t) => Math.abs(t.s - sig.s) < 90)
      .flatMap((t) => [
        {
          cx: t.x,
          cz: t.z,
          heading: t.headingIn,
          from: -(t.d + 2),
          to: 42,
          hw: t.hwIn,
        },
        {
          cx: t.x,
          cz: t.z,
          heading: t.headingOut,
          from: -42,
          to: t.d + 2,
          hw: t.hwOut,
        },
      ]),
  ];
  // 柱が路面(本線・スタブ)に乗っていたら外へ押し出す(最終保険・反復)
  const clearPole = (p0) => {
    let p = p0;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const { s, dist } = projectToPath(path, cumLen, p, 0);
      const [qx, qz] = pointAtPath(path, cumLen, s);
      const h = routeHeadingAt(path, cumLen, s);
      // 進行右方向の法線 (-cos h, sin h) との内積で左右を判定し、その側の幅で退避
      const latSign = (p[0] - qx) * -Math.cos(h) + (p[1] - qz) * Math.sin(h);
      const need = (latSign < 0 ? wLAt(s) : wRAt(s)) + 1.2;
      if (dist < need) {
        let ux = p[0] - qx,
          uz = p[1] - qz;
        const len = Math.hypot(ux, uz);
        if (len < 0.5) {
          ux = -Math.cos(h); // ほぼ路面中心に居る場合は経路の右法線方向へ
          uz = Math.sin(h);
        } else {
          ux /= len;
          uz /= len;
        }
        p = [qx + ux * (need + 0.5), qz + uz * (need + 0.5)];
        moved = true;
      }
      for (const r of rects) {
        const dx = p[0] - r.cx,
          dz = p[1] - r.cz;
        const dir = [Math.sin(r.heading), Math.cos(r.heading)];
        const along = dx * dir[0] + dz * dir[1];
        const lat = dx * dir[1] - dz * dir[0];
        if (
          along > r.from - 0.5 &&
          along < r.to + 0.5 &&
          Math.abs(lat) < r.hw + 0.7
        ) {
          const target = (lat >= 0 ? 1 : -1) * (r.hw + 0.9); // 矩形の短手方向へ退避
          p = [p[0] + dir[1] * (target - lat), p[1] - dir[0] * (target - lat)];
          moved = true;
        }
      }
      if (!moved) break;
    }
    return p;
  };
  const heads = [];
  const push = (kind, face, pole, head, opts = {}) => {
    heads.push({
      kind,
      face: +face.toFixed(4),
      pole: round(clearPole(pole)),
      head: round(head),
      ...opts,
    });
  };

  const t = turns.find((tt) => Math.abs(tt.s - sig.s) <= 30);
  if (t) {
    // 右左折交差点: 円弧(バスの実走路)を避け、交差点ボックスの外側に軸沿いで配置する。
    // pt(基準軸, along, latRight): 軸方向 along + 進行右方向 latRight のワールド座標
    const dirA = [Math.sin(t.headingIn), Math.cos(t.headingIn)];
    const rightA = [-Math.cos(t.headingIn), Math.sin(t.headingIn)];
    const dirB = [Math.sin(t.headingOut), Math.cos(t.headingOut)];
    const rightB = [-Math.cos(t.headingOut), Math.sin(t.headingOut)];
    const ptA = (along, lat) => [
      t.x + dirA[0] * along + rightA[0] * lat,
      t.z + dirA[1] * along + rightA[1] * lat,
    ];
    const ptB = (along, lat) => [
      t.x + dirB[0] * along + rightB[0] * lat,
      t.z + dirB[1] * along + rightB[1] * lat,
    ];
    const boxA = Math.max(t.d, t.hwOut) + 2.6; // 進入側ボックス端(円弧開始より手前)
    const boxB = Math.max(t.d, t.hwIn) + 2.6; // 退出側ボックス端(円弧終了より先)

    // 進入路(バス)向き: ボックス手前・左路端の柱からアームで自車線上へ
    push(
      "main",
      t.headingIn,
      ptA(-boxA, -(wLAt(Math.max(0, t.sIn - 1)) + 1.85)),
      ptA(-boxA, laneCenterAt(t.sIn) - 0.2),
      { arm: 1, hoods: 1 },
    );
    // 退出路の対向車向き: ボックスの先・ルート右側の柱、対向車線上へ(一方通行なら省略)
    const oppOut = oppLaneCenterAt(t.sOut + 1);
    if (oppOut != null) {
      push(
        "main",
        t.headingOut + Math.PI,
        ptB(boxB, wRAt(t.sOut + 1) + 1.85),
        ptB(boxB, oppOut + 0.2),
        { arm: 1 },
      );
    }
    // 従道向き(交差点内連動): 両道路の路端が交わる歩道角に柱を置く(柱直付け)
    // p·nA = a, p·nB = b の連立解(nA/nB は各道路軸の左法線)
    const nA = [Math.cos(t.headingIn), -Math.sin(t.headingIn)];
    const nB = [Math.cos(t.headingOut), -Math.sin(t.headingOut)];
    const det = nA[0] * nB[1] - nA[1] * nB[0];
    if (Math.abs(det) > 0.3) {
      const cornerPole = (a, b) => [
        t.x + (a * nB[1] - b * nA[1]) / det,
        t.z + (-a * nB[0] + b * nA[0]) / det,
      ];
      // 直進スタブの先から来る車向き: A軸の先(alongA>0)側の角
      for (const sb of [1, -1]) {
        const p = cornerPole(-(t.hwIn + 1.85), sb * (t.hwOut + 1.85));
        const alongA = (p[0] - t.x) * dirA[0] + (p[1] - t.z) * dirA[1];
        if (alongA > 0) {
          push("cross", t.headingIn + Math.PI, p, [
            p[0] + nA[0] * 0.6,
            p[1] + nA[1] * 0.6,
          ]);
          break;
        }
      }
      // 退出路の後方から来る車向き: B軸の後方(alongB<0)側の角
      for (const sa of [1, -1]) {
        const p = cornerPole(sa * (t.hwIn + 1.85), t.hwOut + 1.85);
        const alongB = (p[0] - t.x) * dirB[0] + (p[1] - t.z) * dirB[1];
        if (alongB < 0) {
          push("cross", t.headingOut, p, [
            p[0] - nB[0] * 0.6,
            p[1] - nB[1] * 0.6,
          ]);
          break;
        }
      }
    }
    return heads;
  }

  // 通常交差点: ルート接線基準(従来 traffic.js にあった配置式を移植)。
  // 柱の前後オフセットは交差道路の幅の外側まで取る(交差道路の路上に立てない)
  const [px, pz] = pointAtPath(path, cumLen, sig.s);
  const theta = routeHeadingAt(path, cumLen, sig.s);
  const [tx, tz] = [Math.sin(theta), Math.cos(theta)];
  const nx = -tz,
    nz = tx; // lateral 正(右)方向
  const HW = hwAt(sig.s);
  const ix = intersections.find((i) => Math.abs(i.s - sig.s) < 28);
  const ch = ix ? ix.heading : theta + Math.PI / 2;
  const crossHalf = (ix?.width ?? 8) / 2;
  // 主道柱の前後オフセット: 交差道路の路端の外まで。斜め交差では路端が主道方向に伸びる分を割り増す
  const crossAngle = Math.min(
    angleDiff(theta, ch),
    angleDiff(theta, ch + Math.PI),
  );
  const ahead = Math.min(
    16,
    Math.max(5.2, (crossHalf + 2.2) / Math.max(0.45, Math.sin(crossAngle))),
  );
  const at = (lat, d) => [px + nx * lat + tx * d, pz + nz * lat + tz * d];
  push(
    "main",
    theta,
    at(-(wLAt(sig.s) + 1.7), -ahead),
    at(laneCenterAt(sig.s) - 0.2, -ahead),
    { arm: 1, hoods: 1 },
  );
  const opp = oppLaneCenterAt(sig.s);
  if (opp != null) {
    push(
      "main",
      theta + Math.PI,
      at(wRAt(sig.s) + 1.7, ahead),
      at(opp + 0.2, ahead),
      { arm: 1 },
    );
  }
  const cd = [Math.sin(ch), Math.cos(ch)];
  for (const dir of [1, -1]) {
    // 柱は主道の路端(HW+2.2)より先・交差道路の路端(crossHalf+1.6)の外側
    const pole = [
      px - cd[0] * dir * (HW + 2.2) + cd[1] * dir * (crossHalf + 1.6),
      pz - cd[1] * dir * (HW + 2.2) - cd[0] * dir * (crossHalf + 1.6),
    ];
    push("cross", dir === 1 ? ch : ch + Math.PI, pole, [
      pole[0] + cd[0] * dir * 0.6,
      pole[1] + cd[1] * dir * 0.6,
    ]);
  }
  return heads;
}

function pointAtPath(path, cumLen, s) {
  const ss = clamp(s, 0, cumLen.at(-1));
  let i = 0;
  while (i < cumLen.length - 2 && cumLen[i + 1] < ss) i++;
  const a = path[i],
    b = path[Math.min(path.length - 1, i + 1)];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-12;
  const t = (ss - cumLen[i]) / len;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// ---------------------------------------------------------------- main

async function buildFromOSM() {
  console.log("[1/5] OSMデータ取得");
  const relData = await loadCachedOrFetch(
    "route18_osm.json",
    `[out:json][timeout:90];relation(${RELATION_ID});out body geom;`,
  );
  const nodeData = await loadCachedOrFetch(
    "route18_nodes.json",
    `[out:json][timeout:90];rel(${RELATION_ID});node(r);out body;`,
  );
  const southboundRelData = await loadCachedOrFetch(
    "route18_southbound_osm.json",
    `[out:json][timeout:90];relation(${SOUTHBOUND_RELATION_ID});out body geom;`,
  );
  const southboundNodeData = await loadCachedOrFetch(
    "route18_southbound_nodes.json",
    `[out:json][timeout:90];rel(${SOUTHBOUND_RELATION_ID});node(r);out body;`,
  );

  const rel = relData.elements.find((e) => e.type === "relation");
  const southboundRel = southboundRelData.elements.find(
    (e) => e.type === "relation" && e.id === SOUTHBOUND_RELATION_ID,
  );
  // 経路ノード = 北行きリレーションの way + 南行き専用区間(十条〜旧千本通)の way
  const routeNodesQuery = `rel(${RELATION_ID})->.routeRel;
way(r.routeRel)->.relWays;
way(id:${JUJO_WAY_IDS.join(",")})->.jujoWays;
(.relWays; .jujoWays;)->.routeWays;
node(w.routeWays)->.routeNodes;`;
  const roadData = await loadCachedOrFetch(
    "route18_roads_wide2.json",
    `[out:json][timeout:90];
${routeNodesQuery}
(
  .routeWays;
  ${ROAD_TYPES.map((type) => `way(around.routeNodes:${ROAD_AROUND_RADIUS})["highway"="${type}"];`).join("\n  ")}
  node(around.routeNodes:${ROAD_AROUND_RADIUS})["highway"="traffic_signals"];
);
out body geom;`,
  );
  const [visualSouth, visualWest, visualNorth, visualEast] = DETOUR_BBOX;
  const visualRoadPattern = `^(${VISUAL_ROAD_TYPES.join("|")})$`;
  const visualData = await loadCachedOrFetch(
    "route18_visual_roads.json",
    `[out:json][timeout:120];
${routeNodesQuery}
(
  way(around.routeNodes:${OSM_VISUAL_CORRIDOR_METERS})["highway"~"${visualRoadPattern}"];
  way(around.routeNodes:${OSM_VISUAL_CORRIDOR_METERS})["footway"="sidewalk"];
  way(around.routeNodes:${OSM_VISUAL_CORRIDOR_METERS})["highway"]["sidewalk"];
  way(around.routeNodes:${OSM_VISUAL_CORRIDOR_METERS})["footway"="crossing"];
  way(around.routeNodes:${OSM_VISUAL_CORRIDOR_METERS})["highway"="crossing"];
  way(around.routeNodes:${OSM_VISUAL_CORRIDOR_METERS})["highway"~"^(footway|steps|pedestrian)$"]["bridge"="yes"];
  way(around.routeNodes:${OSM_VISUAL_CORRIDOR_METERS})["barrier"="hedge"];
  node(around.routeNodes:${OSM_VISUAL_CORRIDOR_METERS})["highway"="traffic_signals"];
  way["highway"~"${visualRoadPattern}"](${visualSouth},${visualWest},${visualNorth},${visualEast});
  way["footway"="sidewalk"](${visualSouth},${visualWest},${visualNorth},${visualEast});
  way["highway"] ["sidewalk"](${visualSouth},${visualWest},${visualNorth},${visualEast});
  way["footway"="crossing"](${visualSouth},${visualWest},${visualNorth},${visualEast});
  way["highway"="crossing"](${visualSouth},${visualWest},${visualNorth},${visualEast});
  way["highway"~"^(footway|steps|pedestrian)$"]["bridge"="yes"](${visualSouth},${visualWest},${visualNorth},${visualEast});
  way["barrier"="hedge"](${visualSouth},${visualWest},${visualNorth},${visualEast});
  node["highway"="traffic_signals"](${visualSouth},${visualWest},${visualNorth},${visualEast});
);
out body geom;`,
  );
  const [vegetationSouth, vegetationWest, vegetationNorth, vegetationEast] = DETOUR_BBOX;
  const vegetationData = await loadCachedOrFetch(
    "route18_vegetation.json",
    `[out:json][timeout:120];
${routeNodesQuery}
(
  node(around.routeNodes:${OSM_VEGETATION_CORRIDOR_METERS})["natural"="tree"];
  way(around.routeNodes:${OSM_VEGETATION_CORRIDOR_METERS})["natural"~"^(wood|scrub|tree_row)$"];
  way(around.routeNodes:${OSM_VEGETATION_CORRIDOR_METERS})["landuse"~"^(forest|grass|orchard|plant_nursery)$"];
  way(around.routeNodes:${OSM_VEGETATION_CORRIDOR_METERS})["leisure"~"^(park|garden)$"];
  node["natural"="tree"](${vegetationSouth},${vegetationWest},${vegetationNorth},${vegetationEast});
  way["natural"~"^(wood|scrub|tree_row)$"](${vegetationSouth},${vegetationWest},${vegetationNorth},${vegetationEast});
  way["landuse"~"^(forest|grass|orchard|plant_nursery)$"](${vegetationSouth},${vegetationWest},${vegetationNorth},${vegetationEast});
  way["leisure"~"^(park|garden)$"](${vegetationSouth},${vegetationWest},${vegetationNorth},${vegetationEast});
);
out body geom;`,
  );
  const buildingData = await loadCachedOrFetch(
    "route18_buildings3.json",
    `[out:json][timeout:120];
${routeNodesQuery}
(
  way(around.routeNodes:${BUILDING_AROUND_RADIUS})["building"];
  relation(around.routeNodes:${BUILDING_AROUND_RADIUS})["building"];
);
out body geom;`,
  );
  const jujoData = await loadCachedOrFetch(
    "route18_jujo_southbound.json",
    `[out:json][timeout:60];way(id:${JUJO_WAY_IDS.join(",")});out body geom;`,
  );
  const [detourSouth, detourWest, detourNorth, detourEast] = DETOUR_BBOX;
  const detourRoadData = await loadCachedOrFetch(
    "route18_detour_roads.json",
    `[out:json][timeout:90];
(
  ${ROAD_TYPES.map((type) => `way["highway"="${type}"](${detourSouth},${detourWest},${detourNorth},${detourEast});`).join("\n  ")}
  node["highway"="traffic_signals"](${detourSouth},${detourWest},${detourNorth},${detourEast});
);
out body geom;`,
  );
  const detourBuildingData = await loadCachedOrFetch(
    "route18_detour_buildings2.json",
    `[out:json][timeout:120];
(
  way["building"](${detourSouth},${detourWest},${detourNorth},${detourEast});
  relation["building"](${detourSouth},${detourWest},${detourNorth},${detourEast});
);
out body geom;`,
  );
  const [railSouth, railWest, railNorth, railEast] = RAILWAY_BBOX;
  const railwayData = await loadCachedOrFetch(
    "route18_railways_sevenjo_toji.json",
    `[out:json][timeout:90];
(
  way[railway](${railSouth},${railWest},${railNorth},${railEast});
);
out body geom;`,
  );
  const [riverSouth, riverWest, riverNorth, riverEast] = RIVER_BBOX;
  const riverData = await loadCachedOrFetch(
    "route18_rivers.json",
    `[out:json][timeout:90];
(
  way["waterway"~"^(river|stream|canal)$"](${riverSouth},${riverWest},${riverNorth},${riverEast});
  way["waterway"="riverbank"](${riverSouth},${riverWest},${riverNorth},${riverEast});
  way["natural"="water"](${riverSouth},${riverWest},${riverNorth},${riverEast});
  way["water"~"^(river|canal)$"](${riverSouth},${riverWest},${riverNorth},${riverEast});
  relation["natural"="water"](${riverSouth},${riverWest},${riverNorth},${riverEast});
  relation["water"~"^(river|canal)$"](${riverSouth},${riverWest},${riverNorth},${riverEast});
  relation["type"="waterway"]["name"="桂川"](${riverSouth},${riverWest},${riverNorth},${riverEast});
  relation["type"="waterway"]["name:ja"="桂川"](${riverSouth},${riverWest},${riverNorth},${riverEast});
  relation(9459116)->.katsuraRelation;
  way(r.katsuraRelation);
);
out body geom;`,
  );
  const umekojiTreesData = await loadCachedOrFetch(
    "umekoji_park_trees.json",
    `[out:json][timeout:60];
area["name"="梅小路公園"]["leisure"="park"]->.park;
(
  node(area.park)["natural"="tree"];
  way(area.park)["natural"~"wood|scrub|tree_row"];
  way(area.park)["landuse"="forest"];
);
out geom;
(
  way["name"="梅小路公園"]["leisure"="park"];
  relation["name"="梅小路公園"]["leisure"="park"];
);
out geom;`,
  );
  const ways = rel.members.filter(
    (m) =>
      m.type === "way" &&
      m.role === "" &&
      !TERMINUS_INTERNAL_WAY_IDS.has(m.ref),
  );
  const northboundPlatformRefs = rel.members
    .filter((m) => m.role.startsWith("platform") || m.role.startsWith("stop"))
    .map((m) => m.ref);
  const southboundPlatformRefs = southboundRel?.members
    ?.filter((m) => m.role.startsWith("platform") || m.role.startsWith("stop"))
    .map((m) => m.ref) ?? [];
  const nodeById = new Map(nodeData.elements.map((n) => [n.id, n]));
  const southboundNodeById = new Map(southboundNodeData.elements.map((n) => [n.id, n]));
  const kujoSourceWays = [...roadData.elements, ...visualData.elements];
  const kujoWestboundWays = KUJO_WESTBOUND_WAY_IDS.map((id) =>
    kujoSourceWays.find((e) => e.type === "way" && e.id === id),
  );
  if (kujoWestboundWays.some((way) => !way?.geometry?.length))
    throw new Error(`九条通西行き way が見つからない: ${KUJO_WESTBOUND_WAY_IDS.join(",")}`);

  console.log("[2/5] 北行き経路を連結 → 南行きへ反転・一方通行区間を差し替え");
  let line = connectWays(ways); // 北行き: 久我石原町 → 二条駅西口
  // 始点側が久我石原町(南)であることを確認してから反転
  if (line[0][0] > line.at(-1)[0]) line.reverse(); // 念のため: 先頭を北(二条駅)側に
  line.reverse(); // → いま先頭=二条駅西口(北) … reverse2回で意味が消えるためチェックし直す
  if (line[0][0] < line.at(-1)[0]) line.reverse(); // 先頭の緯度が小さい(南)なら反転して北始まりに
  // ここで line = 南行き(二条駅西口 → 久我石原町)

  // 南行き専用区間1: 十条新千本→十条通→十条旧千本→旧千本通(北行きは新千本通経由のため)
  const jujoWays = JUJO_WAY_IDS.map((id) => {
    const w = jujoData.elements.find((e) => e.type === "way" && e.id === id);
    if (!w?.geometry?.length)
      throw new Error(`十条南行き way が見つからない: ${id}`);
    return w;
  });
  line = spliceDetour(
    line,
    chainOrderedWays(jujoWays, JUJO_FROM),
    JUJO_FROM,
    JUJO_TO,
    "十条南行き",
  );
  // 九条通はリレーションが拾った東行き車線の逆走形状を使わず、
  // 実際の西行き車線を九条大宮→羅城門の順で通す。
  line = spliceDetour(
    line,
    [
      KUJO_WESTBOUND_FROM,
      ...chainOrderedWays(kujoWestboundWays, KUJO_WESTBOUND_FROM),
    ],
    KUJO_WESTBOUND_FROM,
    KUJO_WESTBOUND_TO,
    "九条西行き",
  );
  // 南行き専用区間2: 小枝橋→城南宮道→赤池→上鳥羽塔ノ森
  line = spliceDetour(
    line,
    DETOUR_SOUTHBOUND,
    DETOUR_FROM,
    DETOUR_TO,
    "城南宮道",
  );

  console.log("[3/5] 停留所を南行き順に整列");
  // 南行きリレーションのplatform順は二条駅西口→久我石原町なので、
  // 反対車線の北行き停留所を反転して流用せず、南行き側を直接使う。
  const useSouthboundStops = southboundPlatformRefs.length > 0;
  const stopRefs = useSouthboundStops ? southboundPlatformRefs : northboundPlatformRefs;
  const stopNodes = useSouthboundStops ? southboundNodeById : nodeById;
  const osmStops = stopRefs
    .map((ref) => stopNodes.get(ref))
    .filter(Boolean)
    .map((n) => ({
      name: NAME_ALIAS[n.tags?.name] ?? n.tags?.name,
      latlon: [n.lat, n.lon],
      tags: n.tags ?? {},
      osmId: n.id,
    }))
    .filter((stop) => stop.name);
  if (!useSouthboundStops) {
    osmStops.reverse();
    for (const [name, latlon] of Object.entries(EXTRA_STOPS))
      osmStops.push({ name, latlon });
  }
  for (const st of osmStops) {
    // 旧手動アンカーは北行きフォールバックと、南行きリレーションに
    // 含まれない通過停留所の位置にだけ使う。
    if ((!useSouthboundStops || st.name === "上鳥羽村山町") && SOUTHBOUND_STOP_OVERRIDES[st.name])
      st.latlon = SOUTHBOUND_STOP_OVERRIDES[st.name];
  }
  if (useSouthboundStops && !osmStops.some((stop) => stop.name === "上鳥羽村山町")) {
    osmStops.push({
      name: "上鳥羽村山町",
      latlon: SOUTHBOUND_STOP_OVERRIDES["上鳥羽村山町"],
      tags: {},
      osmId: null,
    });
  }
  const stopsLL = STOP_ORDER.map((name) => {
    const hit = osmStops.find((s) => s.name === name);
    if (!hit) throw new Error(`停留所がOSMデータに見つからない: ${name}`);
    return {
      name,
      latlon: hit.latlon,
      tags: hit.tags ?? {},
      osmId: hit.osmId,
    };
  });

  // OSM ID(建物relationは合成ID)で重複排除しつつ、detour bbox 由来の道路・建物・信号をマージ
  const byId = (arr) => {
    const seen = new Set();
    return arr.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  };
  const roads = byId([
    ...roadData.elements.filter(
      (e) => e.type === "way" && isMajorRoad(e.tags) && e.geometry?.length > 1,
    ),
    ...detourRoadData.elements.filter(
      (e) => e.type === "way" && isMajorRoad(e.tags) && e.geometry?.length > 1,
    ),
    // The route relation contains the opposite Kujo carriageway, while the
    // actual southbound path is explicitly selected above. Keep that selected
    // OSM geometry in the lane-section source as well.
    ...kujoWestboundWays.filter(Boolean),
    ...jujoWays,
  ]);
  const visualWays = byId(
    visualData.elements.filter(
      (e) => e.type === "way" && e.geometry?.length > 1,
    ),
  );
  const visualNodes = byId(
    visualData.elements.filter((e) => e.type === "node"),
  );
  const signalNodes = byId([
    ...roadData.elements.filter(
      (e) => e.type === "node" && e.tags?.highway === "traffic_signals",
    ),
    ...detourRoadData.elements.filter(
      (e) => e.type === "node" && e.tags?.highway === "traffic_signals",
    ),
  ]);
  const buildings = byId([
    ...buildingFootprintElements(buildingData.elements),
    ...buildingFootprintElements(detourBuildingData.elements),
  ]);
  const railways = railwayData.elements.filter(
    (e) => e.type === "way" && e.tags?.railway && e.geometry?.length > 1,
  );
  const directRiverWays = riverData.elements.filter(
    (e) => e.type === "way" && e.tags?.waterway && e.geometry?.length > 1,
  );
  // 桂川 relation/9459116 is a waterway relation: its geometry is carried by
  // member ways rather than by a single top-level named way.  Overpass's
  // `out body geom` places those geometries under relation.members, so flatten
  // the members and inherit the relation's river name/tags for line matching.
  const sourceRiverWaysById = new Map(
    riverData.elements
      .filter((element) => element.type === "way" && element.geometry?.length > 1)
      .map((element) => [String(element.id), element]),
  );
  const relationRiverWays = riverData.elements
    .filter((e) => e.type === "relation" && e.members?.length)
    .flatMap((relation) => relation.members
      .filter((member) => member.type === "way"
        && !["outer", "inner"].includes(member.role ?? "")
        && (member.geometry?.length > 1 || sourceRiverWaysById.get(String(member.ref))?.geometry?.length > 1))
      .map((member) => {
        const sourceWay = sourceRiverWaysById.get(String(member.ref));
        return {
          ...(sourceWay ?? {}),
          ...member,
          id: member.ref ?? member.id,
          geometry: member.geometry ?? sourceWay?.geometry,
        type: "way",
        tags: {
          ...(relation.tags ?? {}),
          ...(sourceWay?.tags ?? {}),
          ...(member.tags ?? {}),
          waterway: member.tags?.waterway ?? relation.tags?.waterway ?? "river",
        },
        };
      }));
  const riverWays = [...new Map(
    [...directRiverWays, ...relationRiverWays]
      .filter((way) => way.id != null)
      .map((way) => [String(way.id), way]),
  ).values()];
  const directWaterElements = riverData.elements.filter(
    (e) => e.type === "way"
      && e.geometry?.length >= 3
      && (e.tags?.waterway === "riverbank"
        || e.tags?.natural === "water"
        || ["river", "canal"].includes(e.tags?.water)),
  );
  const relationWaterElements = riverData.elements
    .filter((e) => e.type === "relation" && e.members?.length)
    .flatMap((relation) => relation.members
      .filter((member) => member.type === "way"
        && ["outer", "inner"].includes(member.role ?? "")
        && (member.geometry?.length >= 3 || sourceRiverWaysById.get(String(member.ref))?.geometry?.length >= 3))
      .map((member) => {
        const sourceWay = sourceRiverWaysById.get(String(member.ref));
        return {
          ...(sourceWay ?? {}),
          ...member,
          id: member.ref ?? member.id,
          geometry: member.geometry ?? sourceWay?.geometry,
        type: "way",
          tags: { ...(relation.tags ?? {}), ...(sourceWay?.tags ?? {}), ...(member.tags ?? {}) },
        };
      }));
  const waterElements = [...new Map(
    [...directWaterElements, ...relationWaterElements]
      .filter((way) => way.id != null)
      .map((way) => [String(way.id), way]),
  ).values()];
  const extraRoadWays = EXTRA_ROAD_WAY_IDS
    .map((id) => detourRoadData.elements.find((e) => e.type === "way" && e.id === id))
    .filter((e) => e?.geometry?.length > 1);

  return {
    line,
    stopsLL,
    roads,
    visualWays,
    visualNodes,
    southboundPlatformRefs,
    southboundNodeById,
    hasSouthboundRelation: Boolean(southboundRel),
    vegetationElements: vegetationData.elements,
    signalNodes,
    buildings,
    railways,
    riverWays,
    waterElements,
    extraRoadWays,
    expresswayWays: visualWays,
    umekojiTreesData,
    source: `OpenStreetMap relations ${RELATION_ID} (route geometry) and ${SOUTHBOUND_RELATION_ID} (southbound stops) © OpenStreetMap contributors (ODbL)`,
  };
}

function buildFallback() {
  console.log("[fallback] 内蔵の実測停留所座標(OSM由来)を直結して経路を生成");
  // OSMから取得済みの実座標を埋め込み(南行き順)
  const coords = {
    二条駅西口: [35.011273, 135.74124],
    二条駅前: [35.0115206, 135.7424701],
    "千本三条・朱雀立命館前": [35.0089865, 135.7425339],
    みぶ操車場前: [35.0061817, 135.7456743],
    四条大宮: [35.0040538, 135.7484709],
    大宮松原: [34.9992554, 135.7490947],
    大宮五条: [34.9970686, 135.7491156],
    島原口: [34.9933278, 135.7490955],
    "七条大宮・京都水族館前": [34.9884228, 135.7490843],
    東寺東門前: [34.9823598, 135.7491945],
    九条大宮: [34.9801091, 135.7491864],
    東寺南門前: [34.9793729, 135.7469272],
    羅城門: [34.97912, 135.7429916],
    唐戸町: [34.9760434, 135.7413693],
    千本十条: SOUTHBOUND_STOP_OVERRIDES["千本十条"],
    五丁橋: SOUTHBOUND_STOP_OVERRIDES["五丁橋"],
    上ノ町: SOUTHBOUND_STOP_OVERRIDES["上ノ町"],
    上鳥羽村山町: SOUTHBOUND_STOP_OVERRIDES["上鳥羽村山町"],
    上鳥羽小学校前: SOUTHBOUND_STOP_OVERRIDES["上鳥羽小学校前"],
    城ケ前町: [34.9626138, 135.7424736],
    岩ノ本町: [34.9607101, 135.7425161],
    地蔵前: SOUTHBOUND_STOP_OVERRIDES["地蔵前"],
    奈須野: SOUTHBOUND_STOP_OVERRIDES["奈須野"],
    小枝橋: SOUTHBOUND_STOP_OVERRIDES["小枝橋"],
    城南宮道: EXTRA_STOPS["城南宮道"],
    赤池: EXTRA_STOPS["赤池"],
    上鳥羽塔ノ森: SOUTHBOUND_STOP_OVERRIDES["上鳥羽塔ノ森"],
    久我: [34.945528, 135.7342175],
    菱妻神社前: [34.94775, 135.7293566],
    久我石原町: [34.9476875, 135.7248118],
  };
  const line = STOP_ORDER.map((n) => coords[n]);
  const stopsLL = STOP_ORDER.map((n) => ({ name: n, latlon: coords[n] }));
  return {
    line,
    stopsLL,
    roads: [],
    visualWays: [],
    visualNodes: [],
    southboundPlatformRefs: [],
    southboundNodeById: new Map(),
    hasSouthboundRelation: false,
    vegetationElements: [],
    signalNodes: [],
    buildings: [],
    railways: [],
    riverWays: [],
    waterElements: [],
    extraRoadWays: EXTRA_ROADS_FALLBACK,
    expresswayWays: [],
    umekojiTreesData: null,
    source: "fallback: OSM実測停留所座標の直結近似",
  };
}

async function main() {
  const fallback = process.argv.includes("--fallback");
  const {
    line,
    stopsLL,
    roads,
    visualWays,
    visualNodes,
    vegetationElements,
    signalNodes,
    buildings: buildingWays,
    railways,
    riverWays,
    waterElements,
    extraRoadWays,
    expresswayWays,
    umekojiTreesData,
    source,
  } = fallback ? buildFallback() : await buildFromOSM();

  console.log(
    "[4/5] 座標変換: 投影 → スケール → フィレット → リサンプル",
  );
  const origin = [
    line.reduce((a, p) => a + p[0], 0) / line.length,
    line.reduce((a, p) => a + p[1], 0) / line.length,
  ];
  const osmExpressways = buildOsmExpressways(expresswayWays, origin);
  const riverSurfaceAnchors = BRIDGES.map((bridge) => ({
    name: bridge.river,
    point: bridge.anchor,
  }));
  const waterSurfaceName = (element) => {
    const taggedName = element.tags?.name ?? element.tags?.["name:ja"] ?? null;
    if (taggedName) return taggedName;
    const isRiverSurface = element.tags?.waterway === "riverbank"
      || element.tags?.water === "river"
      || element.tags?.water === "canal";
    if (!isRiverSurface || !element.geometry?.length) return null;
    const center = element.geometry.reduce(
      (sum, point) => [sum[0] + point.lat, sum[1] + point.lon],
      [0, 0],
    ).map((value) => value / element.geometry.length);
    const nearest = riverSurfaceAnchors
      .map((anchor) => ({
        ...anchor,
        distance: Math.hypot(
          (center[0] - anchor.point[0]) * 111320,
          (center[1] - anchor.point[1]) * 111320 * Math.cos((center[0] * Math.PI) / 180),
        ),
      }))
      .sort((a, b) => a.distance - b.distance)[0];
    return nearest?.distance <= 1800 ? nearest.name : null;
  };
  const waterPolygons = waterElements.map((element) => {
    const polygon = project(
      element.geometry.map((point) => [point.lat, point.lon]),
      origin,
    ).map(([x, z]) => [+(x * SCALE).toFixed(2), +(z * SCALE).toFixed(2)]);
    return {
      id: element.id,
      name: waterSurfaceName(element),
      tags: visualTags(element.tags ?? {}),
      polygon,
    };
  }).filter((item) => item.polygon.length >= 3);
  const osmVisual = buildOsmVisualSource(visualWays, visualNodes, origin);
  const osmVegetation = buildOsmVegetationSource(vegetationElements, origin);
  mkdirSync(dirname(OSM_VISUAL_OUT), { recursive: true });
  writeFileSync(
    OSM_VISUAL_OUT,
    JSON.stringify({
      version: 2,
      generatedAt: new Date().toISOString(),
      source: {
        provider: "OpenStreetMap",
        relationId: RELATION_ID,
        license: "ODbL",
        corridorMeters: OSM_VISUAL_CORRIDOR_METERS,
      },
      roads: osmVisual.roads,
      sidewalks: osmVisual.sidewalks,
      stationRoads: osmVisual.stationRoads,
      crossings: osmVisual.crossings,
      pedestrianWays: osmVisual.pedestrianWays,
      hedges: osmVisual.hedges,
      trafficSignals: osmVisual.trafficSignals,
      expressways: osmExpressways,
      vegetation: osmVegetation,
    }),
  );
  let path = project(line, origin).map(([x, z]) => [x * SCALE, z * SCALE]);
  path = rdp(path, 1.2);
  // 始端に助走 18m・終端に 30m を直線延長(始発でバスを停留所手前に置く / 終点で停まり切る)
  const ext = (a, b, d) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
    return [a[0] + ((a[0] - b[0]) / l) * d, a[1] + ((a[1] - b[1]) / l) * d];
  };
  path.unshift(ext(path[0], path[1], 18));
  path.push(ext(path.at(-1), path.at(-2), 30));
  const filleted = filletCorners(
    path,
    FILLET_RADIUS,
    FILLET_MIN_ANGLE,
    TURN_MIN_ANGLE,
    TURN_FILLET_RADIUS,
  );
  const turnCorners = filleted.corners;
  // OSM のway中心線から離れる全体平滑化は行わない。交差点だけは
  // filletCorners() の実走用円弧で処理し、それ以外は OSM の実形状を保つ。
  path = resample(filleted.pts, RESAMPLE_STEP);
  path = path.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]);

  const cumLen = [0];
  for (let i = 1; i < path.length; i++) {
    cumLen.push(
      cumLen[i - 1] +
        Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]),
    );
  }
  const totalLength = cumLen.at(-1);

  // 景観道路・交通AIが共有するOSMポリライン。wayの向きは南端→北端へ正規化する。
  const extraRoads = (extraRoadWays ?? []).map((way) => {
    const geometry = way.geometry.map((p) => [p.lat, p.lon]);
    if (geometry[0][0] > geometry.at(-1)[0]) geometry.reverse();
    const points = rdp(
      project(geometry, origin).map(([x, z]) => [x * SCALE, z * SCALE]),
      0.4,
    ).map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]);
    const merge = projectToPath(path, cumLen, points.at(-1), 0);
    return {
      id: way.id,
      name: way.tags?.name ??
        (way.id === 621847402 ? "小枝橋西行き車線橋" : "地蔵前南側北行き一方通行"),
      points,
      width: 3.2,
      lanes: Number(way.tags?.lanes) || (way.id === 621847402 ? 2 : 1),
      oneway: true,
      direction: way.id === 621847402 ? "westbound" : "northbound",
      mergeS: +merge.s.toFixed(1),
    };
  });

  console.log("[5/5] 停留所・橋・速度ゾーンを弧長に射影");
  let cursor = 0;
  const stops = stopsLL.map(({ name, latlon, tags, osmId }) => {
    const pt = project([latlon], origin)[0].map((v) => v * SCALE);
    const { s, dist } = projectToPath(path, cumLen, pt, cursor);
    cursor = s + 10; // 次の停留所はこの先(単調性)
    return {
      name,
      s: +s.toFixed(1),
      projDist: +dist.toFixed(1),
      platform: pt.map((v) => +v.toFixed(2)),
      ...(osmId != null ? { osmId } : {}),
      ...(tags?.shelter === "yes" ? { shelter: true } : {}),
      ...(tags?.bench === "yes" ? { bench: true } : {}),
    };
  });
  const terminalStopLL = stopsLL.find((st) => st.name === "久我石原町");
  const terminalStopPt = terminalStopLL
    ? project([terminalStopLL.latlon], origin)[0].map((v) => v * SCALE)
    : null;

  const stopS = (name) => stops.find((st) => st.name === name).s;
  const speedZones = SPEED_ZONES.map((z) => ({
    from: z.fromStop ? stopS(z.fromStop) : 0,
    to: z.toStop ? stopS(z.toStop) : +totalLength.toFixed(1),
    limit: z.limit,
  }));
  const { intersections, signals: signalsRaw } = roadMetadata(
    path,
    cumLen,
    origin,
    roads,
    signalNodes,
  );

  const railStructures = railwayMetadata(
    path,
    cumLen,
    origin,
    railways,
    stopS("七条大宮・京都水族館前"),
    stopS("東寺東門前"),
  );

  // 大宮跨線橋: 大宮木津屋橋交差点の約30m南にある側道分岐から
  // 中央4車線だけが上り始め、JR在来線との交点を最高点として、
  // 東寺道交差点の手前約100mまで緩やかに下る。
  // 両外側の側道はPLATEAU地表面のまま残す。
  const elevations = [];
  const railJR = railStructures.find(
    (r) => r.kind === "conventional-underpass",
  );
  if (railJR) {
    const omiyaKizuyabashi = intersections.find(
      (ix) => ix.name === "木津屋橋通" && ix.s < railJR.s,
    );
    if (!omiyaKizuyabashi) {
      throw new Error("大宮木津屋橋交差点が見つからないため、大宮跨線橋の開始点を決定できません");
    }
    const tojimae = intersections.find(
      (ix) => ix.name === "東寺道" && ix.s > railJR.s,
    );
    // 実際の道路形状に合わせ、交差点中心から30m南を側道分岐・上り坂開始点とする。
    // 無名OSM道路との交点(s=3446.3)は側道分岐ではないため、開始点には使わない。
    const from = +(omiyaKizuyabashi.s + 30).toFixed(1);
    const peak = +railJR.s.toFixed(1);
    const to = tojimae ? +(tojimae.s - 100).toFixed(1) : +(railJR.toS + 262.2).toFixed(1);
    Object.assign(railJR, {
      bridgeFromS: from,
      bridgeToS: to,
      approachIn: 0,
      approachOut: 0,
      deckHalf: 7.2,
    });
    elevations.push({
      name: "大宮跨線橋",
      profile: "single-crest",
      from,
      peak,
      to,
      height: 4,
      // 北側はPLATEAU地表の局所的な盛り上がりを越えつつ、JR交点で
      // 勾配0になる単調なHermite曲線にする。3.5%は都市部跨線橋として
      // 緩やかな範囲で、開始直後から路面が確実に地表より上へ離れる。
      riseStartGrade: 0.035,
      // South of the JR crossing the PLATEAU ground rises again. Use an
      // absolute vertical alignment with a delayed power descent so the JR
      // crossing remains the sole crest while the road stays above terrain.
      fallPower: 3,
      approachIn: 0,
      approachOut: 0,
      laneOverride: 1,
      // 自動運転は大宮木津屋橋交差点から中央側へ寄せ始め、
      // 30m南の側道分岐・橋開始点で橋上車線への合流を完了する。
      autoEntryFrom: +omiyaKizuyabashi.s.toFixed(1),
    });
    for (const ix of intersections) {
      if (ix.s > from - 20 && ix.s < to + 20) ix.under = 1; // 八条通など高架下の交差道路は地上のまま
    }
    // 東寺東門前停留所: 東寺道交差点の約20m先(南)に実際の停留所がある
    const tojimonStop = stops.find((st) => st.name === "東寺東門前");
    if (tojimae && tojimonStop) tojimonStop.s = +(tojimae.s + 20).toFixed(1);
  }
  // 鴨川(小枝橋)・名神高速道路が近接して交差する地点: 川岸なので道路をわずかに高く、
  // 川を低く見せる(river-crossing elevation。車線数は変えない = laneOverride なし)
  // 検証・地図表示用: 各橋の川ポリライン(実測 OSM waterway をゲーム座標に投影)
  const riverLines = new Map(
    BRIDGES.map((b) => [
      b.name,
      extractRiverLine(
        riverWays,
        b.river,
        b.anchor,
        origin,
        b.riverHalfWindowM ?? 220,
      ),
    ]),
  );
  const bridges = BRIDGES.map(({ name, anchor, realLength, river }) => {
    const pt = project([anchor], origin)[0].map((v) => v * SCALE);
    const { s } = projectToPath(path, cumLen, pt, 0);
    return {
      name,
      s: +s.toFixed(1),
      length: +(realLength * SCALE).toFixed(1),
      river,
      // 実測の川方位(headingDeg、経路 heading と同じ規約)。取得できない場合は
      // 従来どおり経路に直交する向きにフォールバックする(nature.js 側の既定値)。
      riverHeadingDeg: riverLines.get(name)?.headingDeg ?? null,
    };
  });
  const rivers = BRIDGES.map(({ name, river }) => {
    const line = riverLines.get(name);
    return line && { bridgeName: name, river, ...line };
  }).filter(Boolean);
  // 河川橋は、実橋長の始点から終点まで一つの絶対標高で平坦にする。
  // PLATEAU地表は routeData.js 側で参照し、橋面標高は区間内の地表最高点に
  // 必要な構造物高さを加えて決定する。これにより始点・終点を含む橋面全体が
  // 同じ高さになり、道路・自車・一般車・欄干が同一の elevationAt(s) を使える。
  for (const b of bridges) {
    const halfLength = b.length / 2;
    const isKoeda = b.name === "小枝橋(鴨川)";
    elevations.push({
      name: `${b.name}(flat deck)`,
      profile: "flat-deck",
      from: +(b.s - halfLength).toFixed(2),
      to: +(b.s + halfLength).toFixed(2),
      height: isKoeda ? 2.6 : 1.8,
      approachIn: isKoeda ? 26 : 22,
      approachOut: isKoeda ? 26 : 22,
    });
  }

  // 名神高速道路の高架(片道3車線)。JR/新幹線と同じ railStructures 配列に載せ、
  // railways.js の同一ループで描画する(main.js 側の配線変更が不要)。
  for (const hc of HIGHWAY_CROSSINGS) {
    const pt = project([hc.anchor], origin)[0].map((v) => v * SCALE);
    const { s, dist } = projectToPath(path, cumLen, pt, 0);
    if (dist > 60) {
      console.warn(
        `  警告: 名神高速クロッシングの射影誤差 ${dist.toFixed(0)}m @ ${hc.name}`,
      );
      continue;
    }
    railStructures.push({
      kind: "expressway-viaduct",
      name: hc.name,
      s: +s.toFixed(1),
      heading: +(routeHeadingAt(path, cumLen, s) + Math.PI / 2).toFixed(4),
      length: hc.length ?? 210,
      width: 27,
      lanesEachWay: 3,
      layer: 2,
    });
  }
  railStructures.sort((a, b) => a.s - b.s);

  // 高架上の信号は存在しない(高架下の信号は自車に無関係)ので除外
  const signals = signalsRaw.filter(
    (sig) =>
      !elevations.some(
        (e) =>
          sig.s > e.from - e.approachIn + 5 && sig.s < e.to + e.approachOut - 5,
      ),
  );

  // 右左折交差点の弧長スパン(右折車線を円弧内に食い込ませないためのクランプ)
  const turnSpans = turnCorners.map((c) => {
    const sIn = projectToPath(path, cumLen, c.t1, 0).s;
    return { sIn, sOut: projectToPath(path, cumLen, c.t2, sIn).s, corner: c };
  });
  const roadSections = buildLaneSections(
    path,
    cumLen,
    origin,
    roads,
    signals,
    turnSpans,
    intersections,
    elevations,
  );

  // ゲーム内道路幅・車線中心(routeData.js と同式)
  const secAt = (s) =>
    roadSections.find((x) => s >= x.from && s < x.to) ?? roadSections.at(-1);
  const wLAtS = (s) => secAt(s).wL;
  const wRAtS = (s) => secAt(s).wR;
  const hwAtS = (s) => Math.max(secAt(s).wL, secAt(s).wR);
  const laneCenterAtS = (s) => {
    const sec = secAt(s);
    if (!sec.lanesB) return 0; // 一方通行: 道路中央を走る
    return -(((sec.wL - 0.55) * (sec.lanesF - 0.5)) / sec.lanesF);
  };
  const oppLaneCenterAtS = (s) => {
    const sec = secAt(s);
    if (!sec.lanesB) return null; // 対向車線なし
    return ((sec.wR - 0.55) * (sec.lanesB - 0.5)) / sec.lanesB;
  };
  const widths = {
    hwAt: hwAtS,
    wLAt: wLAtS,
    wRAt: wRAtS,
    laneCenterAt: laneCenterAtS,
    oppLaneCenterAt: oppLaneCenterAtS,
  };

  // 右左折交差点: フィレット記録を弧長に射影し、交差道路名を intersections からマッチ
  // (マッチしたエントリは削除 — 旧スタブとの二重描画防止)
  const turnIntersectionsAll = turnSpans.map(({ sIn, sOut, corner: c }) => {
    const sMid = projectToPath(path, cumLen, c.vertex, sIn).s;
    let cross = null;
    for (const ix of intersections) {
      if (
        Math.abs(ix.s - sMid) < 30 &&
        (!cross || Math.abs(ix.s - sMid) < Math.abs(cross.s - sMid))
      )
        cross = ix;
    }
    if (cross) intersections.splice(intersections.indexOf(cross), 1);
    return {
      s: +sMid.toFixed(1),
      sIn: +sIn.toFixed(1),
      sOut: +sOut.toFixed(1),
      x: +c.vertex[0].toFixed(2),
      z: +c.vertex[1].toFixed(2),
      headingIn: +Math.atan2(c.u1[0], c.u1[1]).toFixed(4),
      headingOut: +Math.atan2(c.u2[0], c.u2[1]).toFixed(4),
      angleDeg: +((c.angle * 180) / Math.PI).toFixed(1),
      d: +c.d.toFixed(1), // 頂点→円弧接点の距離(交差点ボックス描画用)
      hwIn: +hwAtS(Math.max(0, sIn - 1)).toFixed(1),
      hwOut: +hwAtS(sOut + 1).toFixed(1),
      crossName: cross?.name ?? "",
      crossWidth: cross?.width ?? 8,
      crossLanes: cross?.lanes ?? 2,
    };
  });

  // 右左折交差点の脚オーバーライド(九条大宮の大宮通=片道1、羽束師墨染線=計5 等)。
  // crossName は自動マッチが既に実名を見つけている場合(例: 城南宮道)は上書きしない。
  for (const ov of TURN_OVERRIDES) {
    const pt = project([ov.anchor], origin)[0].map((v) => v * SCALE);
    let best = null;
    for (const t of turnIntersectionsAll) {
      const d = Math.hypot(t.x - pt[0], t.z - pt[1]);
      if (d < 45 && (!best || d < best.d)) best = { t, d };
    }
    if (!best) {
      console.warn(
        `  警告: TURN_OVERRIDES のアンカーに一致する右左折交差点がない: [${ov.anchor}]`,
      );
      continue;
    }
    if (ov.stubInHw != null) best.t.stubInHw = ov.stubInHw;
    if (ov.stubInLen != null) best.t.stubInLen = ov.stubInLen;
    if (ov.crossWidth != null) best.t.crossWidth = ov.crossWidth;
    if (ov.crossLanes != null) best.t.crossLanes = ov.crossLanes;
    if (ov.crossName != null && !best.t.crossName)
      best.t.crossName = ov.crossName;
    if (ov.stubInHeadingDeg != null)
      best.t.stubInHeadingDeg = ov.stubInHeadingDeg;
    if (ov.stubBackLen != null) best.t.stubBackLen = ov.stubBackLen;
  }

  // フィレット処理は折れ角(TURN_MIN_ANGLE 以上)だけで「右左折交差点」を機械的に判定する
  // ため、実際には交差する道路が無く経路自身がその場で曲がっているだけの地点まで
  // 十字路として描いてしまうことがある。既知の誤検出だけをアンカーで無効化し、
  // フィレット済みの曲線(道なりカーブ)としてのみ残す(交差点の箱・スタブ道路・
  // 信号待ちは描かれなくなる)。
  // OSM の実道路(Overpass で直接確認)によると、小枝橋(鴨川)〜城南宮道の間は千本通の
  // 続き(way 1061759795→968070103→621847405[橋]→621847400→217638202)が道なりに
  // 曲がっているだけで、城南宮道(s≈8430.4)以外に実在する交差道路は無い。
  //   s≈8393.6: 城南宮道の手前で千本通がもう一段曲がっているだけの地点
  // 西詰(A)は上河原橋方面への一方通行ペア(way 27829570 / 621847404)が分岐する実在の
  // 交差点なので右左折交差点として描く。s≈8317.7(橋東詰)は、小枝橋側の道路(進入路)から
  // 千本通(城南宮方面)へ乗り換える実在の分岐点のため交差点として残す(TURN_OVERRIDES で
  // crossName・スタブ長を指定)。
  const FORCE_PLAIN_CURVE_ANCHORS = [[34.95066, 135.74276]];
  const forcePlainCurve = FORCE_PLAIN_CURVE_ANCHORS.map((a) =>
    project([a], origin)[0].map((v) => v * SCALE),
  );
  const turnIntersections = turnIntersectionsAll.filter((t) => {
    const isForced = forcePlainCurve.some(
      (pt) => Math.hypot(t.x - pt[0], t.z - pt[1]) < 25,
    );
    if (isForced)
      console.log(
        `  実交差道路なしのため交差点描画を省略(道なりカーブとして扱う): s=${t.s}`,
      );
    return !isForced;
  });

  // 信号の柱・灯器の設置座標を計算して埋め込む(交差点内の路上に立てない)
  const signalsOut = signals.map((sig) => ({
    ...sig,
    heads: placeSignalHeads(
      sig,
      turnIntersections,
      intersections,
      path,
      cumLen,
      widths,
    ),
  }));

  const buildings = buildingMetadata(path, cumLen, origin, buildingWays, hwAtS);

  const umekojiTrees = { trees: [], forests: [], treeRows: [] };
  if (umekojiTreesData) {
    for (const e of umekojiTreesData.elements) {
      if (e.type === "node" && e.tags?.natural === "tree") {
        const pt = project([[e.lat, e.lon]], origin)[0];
        umekojiTrees.trees.push([
          +(pt[0] * SCALE).toFixed(1),
          +(pt[1] * SCALE).toFixed(1),
        ]);
      } else if (e.type === "way" && e.tags?.landuse === "forest") {
        let pts = project(
          e.geometry.map((p) => [p.lat, p.lon]),
          origin,
        ).map((p) => [p[0] * SCALE, p[1] * SCALE]);
        if (pts.length > 0 && dist2(pts[0], pts[pts.length - 1]) < 0.05)
          pts.pop();
        pts = rdp(pts, 1.0 * SCALE);
        umekojiTrees.forests.push(
          pts.map((p) => [+p[0].toFixed(1), +p[1].toFixed(1)]),
        );
      } else if (e.type === "way" && e.tags?.natural === "tree_row") {
        const pts = project(
          e.geometry.map((p) => [p.lat, p.lon]),
          origin,
        ).map((p) => [+(p[0] * SCALE).toFixed(1), +(p[1] * SCALE).toFixed(1)]);
        umekojiTrees.treeRows.push(pts);
      }
    }
  }

  const out = {
    routeName: "18号系統",
    operator: "京都市交通局(横大路営業所)",
    destination: "大宮通 久我石原町",
    origin: "二条駅西口",
    source,
    generatedAt: new Date().toISOString(),
    scale: SCALE,
    projOrigin: [+origin[0].toFixed(7), +origin[1].toFixed(7)], // 投影原点 [lat, lon](座標変換用)
    totalLength: +totalLength.toFixed(1),
    path,
    terminalStop: terminalStopPt
      ? { x: +terminalStopPt[0].toFixed(2), z: +terminalStopPt[1].toFixed(2) }
      : null,
    stops: stops.map(({ name, s, platform, osmId, shelter, bench }) => ({
      name,
      s,
      platform,
      ...(osmId != null ? { osmId } : {}),
      ...(shelter ? { shelter: true } : {}),
      ...(bench ? { bench: true } : {}),
    })),
    extraRoads,
    bridges,
    rivers,
    waterPolygons,
    osmExpressways,
    speedZones,
    roadSections,
    intersections: intersections.map(({ dist, ...ix }) => ix),
    turnIntersections,
    signals: signalsOut,
    buildings,
    railStructures,
    elevations,
    umekojiTrees,
    osmVegetation,
    osmStationRoads: osmVisual.stationRoads,
  };
  writeFileSync(OUT, JSON.stringify(out));

  // ---- 検証ログ ----
  console.log("\n=== 生成結果 ===");
  console.log(
    `経路点数: ${path.length}  全長: ${totalLength.toFixed(0)}m (実距離 約${(totalLength / SCALE / 1000).toFixed(2)}km)`,
  );
  console.log(`データ源: ${source}`);
  console.log("停留所30(s値 / 射影誤差m):");
  for (const st of stops)
    console.log(
      `  ${String(st.s).padStart(7)}  ${st.name}  (±${st.projDist}m)`,
    );
  console.log("橋:", bridges.map((b) => `${b.name}@${b.s}`).join("  "));
  console.log(
    "速度ゾーン:",
    speedZones.map((z) => `${z.from}-${z.to}:${z.limit}km/h`).join("  "),
  );
  console.log(
    `道路区間: ${roadSections.length}  交差点: ${intersections.length}  OSM信号: ${signals.length}  OSM建物: ${buildings.length}  鉄道構造: ${railStructures.length}`,
  );
  console.log(
    `梅小路公園 樹木: 単木${umekojiTrees.trees.length} 樹林${umekojiTrees.forests.length} 並木${umekojiTrees.treeRows.length}`,
  );
  console.log(`右左折交差点: ${turnIntersections.length}`);
  for (const t of turnIntersections) {
    console.log(
      `  s=${String(t.s).padStart(7)}  ${String(t.angleDeg).padStart(6)}°  ${t.crossName || "(交差道路名なし)"}`,
    );
  }
  for (const r of railStructures) {
    console.log(
      `鉄道: ${r.name}  s=${r.s}  heading=${r.heading.toFixed(4)}rad`,
    );
  }
  const bad = stops.filter((st, i) => i > 0 && st.s <= stops[i - 1].s);
  if (bad.length)
    throw new Error(
      `s値が単調増加でない停留所: ${bad.map((b) => b.name).join(",")}`,
    );
  if (stops.length !== 30)
    throw new Error(`停留所数が30でない: ${stops.length}`);
  console.log(`\nOK → ${OUT}`);
}

main().catch((e) => {
  console.error("生成失敗:", e.message);
  console.error("ネットワーク不通の場合は --fallback を試してください");
  process.exit(1);
});
