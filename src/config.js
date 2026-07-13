/** 全チューニング定数 */
export const CFG = {
  // --- 車両(いすゞエルガ級 大型路線車) ---
  bus: {
    length: 10.29,
    width: 2.49,
    wheelbase: 4.8,
    rearOverhang: 3.15, // 後軸から車体後端まで
    maxAccel: 1.2, // [m/s^2]
    throttleTau: 0.3, // アクセル一次遅れ [s]
    maxBrake: 3.5, // 常用ブレーキ最大 [m/s^2]
    rollingDrag: 0.3, // 転がり抵抗 [m/s^2]
    speedDrag: 0.05, // 速度比例抵抗 [1/s]
    maxSpeed: 60 / 3.6, // [m/s]
    maxReverse: 5 / 3.6,
    reverseAccel: 0.8,
    maxSteerDeg: 40, // 静止時最大舵角
    steerSpeedFactor: 6, // δmax(v) = maxSteer / (1 + v/factor)
    steerRate: (60 * Math.PI) / 180, // 操舵追従 [rad/s]
    centerRate: (45 * Math.PI) / 180, // 自動センタリング [rad/s]
  },
  // --- 道路 ---
  road: {
    offroadMargin: 1.0, // 道路端からこれ以上で場外
  },
  // --- NPC交通 ---
  traffic: {
    maxVehicles: 64, // 同時存在数の上限
    lod: {
      physicsRadius: 120, // 自車からこれ以内で物理LODへ昇格 [m]
      simpleRadius: 160, // これ以遠で簡易LODへ降格 [m](ヒステリシス40m)
      maxPhysicsVehicles: 20, // 物理LODの同時台数上限
      cullRadius: 700, // これ以遠は走行更新を続けつつ描画しない [m]
    },
    physics: {
      // NpcPhysicsのパラメータ(車種別)。意味はCFG.busと同じ。
      car: {
        wheelbase: 2.7,
        maxAccel: 2.2,
        maxBrake: 4.5,
        throttleTau: 0.15,
        rollingDrag: 0.3,
        speedDrag: 0.05,
        maxSpeed: 16.7,
        maxSteerDeg: 38,
        steerSpeedFactor: 7,
        steerRateDeg: 120,
        centerRateDeg: 90,
      },
      truck: {
        wheelbase: 3.8,
        maxAccel: 1.4,
        maxBrake: 3.8,
        throttleTau: 0.2,
        rollingDrag: 0.35,
        speedDrag: 0.06,
        maxSpeed: 13.9,
        maxSteerDeg: 35,
        steerSpeedFactor: 6,
        steerRateDeg: 100,
        centerRateDeg: 80,
      },
    },
    spawn: {
      minDist: 90, // 自車からこれ未満の端点では発生しない [m]
      maxDist: 1400, // 自車からこれ超の端点では発生しない [m]
      despawnRadius: 1600, // 自車からこれ以遠に離れた車は消滅 [m]
      initialFraction: 0.8, // 起動時に maxVehicles×この割合まで初期配置
      refillRatePerSecond: 3, // 経路終端で減った初期交通量を中距離帯へ補充 [台/s]
      // 端点1レーンあたりの流入量 [台/分]
      baseRatePerMinute: {
        motorway: 6,
        motorway_link: 3,
        trunk: 6,
        primary: 5,
        secondary: 4,
        tertiary: 3,
        unclassified: 1.6,
        residential: 1.0,
        service: 0.3,
      },
    },
    // 地域ポリゴン(world x-z 座標)。エッジ中点で判定し、
    // スポーン量と経路重みに掛かる。
    regions: [],
    defaultRegionMultiplier: 1.0,
    // 次エッジの highway 種別でコネクタを選ぶ重み
    routeWeights: {
      motorway: 6,
      motorway_link: 2,
      trunk: 5,
      primary: 4,
      secondary: 3,
      tertiary: 2,
      unclassified: 1,
      residential: 0.7,
      service: 0.2,
    },
    driver: {
      turnWeightFactor: 0.35, // 旋回コネクタの重み係数(直進=1.0)
      minStraightAfterTurn: 100, // 旋回後に再旋回しない距離 [m]
      maxLatAccel: 2.5, // カーブ減速の横加速度上限 [m/s²]
      lookAheadMin: 5, // pure pursuit先読み距離の下限 [m]
      lookAheadMax: 22, // pure pursuit先読み距離の上限 [m]
      headway: 1.35, // IDMの希望車間時間 [s]
      minGap: 3.2, // IDMの停止時最小車間 [m]
    },
  },
  // --- 運行 ---
  ops: {
    doorTime: 1.8, // ドア開閉アニメ [s]
    boardInterval: 1.1, // 乗車1人あたり [s]
    alightInterval: 1.3, // 降車1人あたり [s]
    fare: 230, // 大人運賃 [円]
    stopWindow: 3.0, // 停止線からこの距離以内でドア開可 [m]
    perfectWindow: 1.0, // 正着判定 [m]
    curbWindow: 0.8, // 縁石からの許容ギャップ [m]
    departEarlyGrace: 5, // 早発猶予 [s]
    autoDoorCloseLead: 5, // 自動運転で定時前到着したときのドア閉開始 [s]
    // ダイヤは timetable.js の固定時刻表(9:56 発〜10:44 着)を使用
  },
  // --- スコア ---
  score: {
    perfectStop: 150,
    goodStop: 80,
    okStop: 30,
    smoothStop: 30,
    onTimeDepart: 50,
    earlyDepart: -300,
    skipStop: -400,
    redLight: -200,
    collision: -300,
    harshBrake: -50,
    harshTurn: -30,
    overspeedPerSec: -5,
    centerlinePerSec: -3,
    offroadReset: -500,
    complete: 500,
    harshBrakeThreshold: 3.9, // [m/s^2](フルブレーキ3.5+走行抵抗が瞬間的に超えても継続しなければ許容)
    harshLatThreshold: 3.0, // [m/s^2]
    overspeedMargin: 5 / 3.6, // 制限+5km/h から減点
  },
  // --- 乗客 ---
  passengers: {
    initialBoard: 12, // 始発乗車
    waitLambda: 2.0, // 各停留所の待ち人数 Poisson λ
    alightGeomP: 0.22, // 降車停留所の幾何分布パラメータ
  },
  // --- 色 ---
  colors: {
    sky: 0xbfe3f2,
    fog: 0xcfe0ea,
    ground: 0x9aa77c,
  },
};
