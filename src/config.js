/** 全チューニング定数 */
export const CFG = {
  // --- 車両(いすゞエルガ級 大型路線車) ---
  bus: {
    length: 10.29,
    width: 2.49,
    height: 3.14,
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
    halfWidth: 4.0, // 最小の片側幅(センターまで)。実効値は routeData の halfWidthAt(s)
    offroadMargin: 1.0, // 道路端からこれ以上で場外
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
    road: 0x565a60,
    roadLine: 0xe8e8e8,
    curb: 0xb9bdb9,
    busCream: 0xf2efe1,
    busGreen: 0x1e7a4f,
    busDarkGreen: 0x145c3a,
  },
};
