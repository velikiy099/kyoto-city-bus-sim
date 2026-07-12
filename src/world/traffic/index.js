import * as THREE from "three";
import { buildSignals } from "./signals.js";
import { createGraphRuntime } from "./graph.js";
import { createTrafficAgents } from "./agents.js";
import { createSpawner } from "./spawner.js";

/**
 * 交通(対向車・同方向の同行車)と交差点信号(各方向の灯器+連動)。
 * update(dt, busS, busPos, busV) を毎ステップ呼ぶ。
 * events: { trafficGraph, onCollision(), onRedLight() }
 */
export function buildTraffic(scene, path, events = {}) {
  const group = new THREE.Group();
  scene.add(group);
  const signalsApi = buildSignals(group, path);
  const runtime = createGraphRuntime(events.trafficGraph);

  if (!events.trafficGraph?.edges?.length) {
    console.warn("Traffic graph is missing; traffic simulation is inactive.");
    return {
      signals: signalsApi.signals,
      agents: [],
      stats: {
        active: 0,
        spawned: 0,
        despawned: { sink: 0, blocked: 0, radius: 0, stuck: 0 },
        spawnPointCount: 0,
        blockedTails: 0,
        physicsCount: 0,
        visibleCount: 0,
        snapBacks: 0,
      },
      update(dt, busS, _busPos, busV) {
        signalsApi.update(dt, busS, busV, events.onRedLight);
      },
      leadGapAhead: () => null,
      nextSignal: signalsApi.nextSignal,
      redStopTarget: signalsApi.redStopTarget,
    };
  }

  signalsApi.attachNodes(runtime);
  const spawner = createSpawner(runtime);
  const agentsApi = createTrafficAgents(scene, path, runtime, events, signalsApi, spawner);
  return {
    signals: signalsApi.signals,
    agents: agentsApi.agents,
    stats: agentsApi.stats,
    update(dt, busS, busPos, busV, busHeading = 0, busLat) {
      signalsApi.update(dt, busS, busV, events.onRedLight);
      agentsApi.update(dt, busS, busPos, busV, busHeading, busLat);
    },
    leadGapAhead: agentsApi.leadGapAhead,
    nextSignal: signalsApi.nextSignal,
    redStopTarget: signalsApi.redStopTarget,
  };
}
