import { CFG } from "../config.js";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 乗客需要モデル。開始時に全停留所の乗車人数と各客の降車先を確定する。
 * 後乗り(中扉)・前降り(前扉)・後払い230円均一。
 */
export function createPassengers(nStops, seed = (Math.random() * 1e9) | 0) {
  const rand = mulberry32(seed);
  const P = CFG.passengers;

  const poisson = (lambda) => {
    const L = Math.exp(-lambda);
    let k = 0,
      p = 1;
    do {
      k++;
      p *= rand();
    } while (p > L);
    return k - 1;
  };

  // 降車先: 乗車停 i から幾何分布で先へ(終点クランプ)
  const pickDest = (i) => {
    let k = 1;
    while (rand() > P.alightGeomP && i + k < nStops - 1) k++;
    return Math.min(nStops - 1, i + k);
  };

  const board = new Array(nStops).fill(0); // 各停の乗車人数
  const alight = new Array(nStops).fill(0); // 各停の降車人数
  board[0] = P.initialBoard;
  for (let i = 1; i < nStops - 1; i++) board[i] = poisson(P.waitLambda);
  for (let i = 0; i < nStops - 1; i++) {
    for (let k = 0; k < board[i]; k++) alight[pickDest(i)]++;
  }

  let onboard = 0;
  let totalCarried = 0;

  return {
    seed,
    board,
    alight,
    get onboard() {
      return onboard;
    },
    get totalCarried() {
      return totalCarried;
    },
    /** 停留所 i に停車義務があるか */
    mustStopAt(i) {
      return board[i] > 0 || alight[i] > 0;
    },
    boardOne() {
      onboard++;
      totalCarried++;
    },
    alightOne() {
      onboard = Math.max(0, onboard - 1);
    },
  };
}
