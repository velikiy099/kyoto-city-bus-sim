import * as THREE from "three";
import { buildSignals } from "./signals.js";
import { buildGraphTraffic } from "./graphTraffic.js";

/**
 * 交通(対向車・同方向の同行車)と交差点信号(各方向の灯器+連動)。
 * update(dt, busS, busPos, busV) を毎ステップ呼ぶ。
 * events: { onCollision(), onRedLight() }
 */
export function buildTraffic(scene, path, events = {}) {
  const group = new THREE.Group();
  scene.add(group);
  const { signals, paintHead } = buildSignals(group, path);
  if (!events.trafficGraph?.edges?.length) {
    console.warn("Traffic graph is missing; traffic simulation is inactive.");
    return {
      signals,
      update() {},
      leadGapAhead: () => null,
      nextSignal: () => null,
      redStopTarget: () => null,
    };
  }
  return buildGraphTraffic(scene, path, events, { signals, paintHead });
}
