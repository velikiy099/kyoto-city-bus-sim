import { CFG } from "../../config.js";

/**
 * 交通グラフの端点からNPCを流入させるスポーナー。
 * 生成位置の判断はここで行い、プールの割り当ては agents.js に委譲する。
 */
export function createSpawner(runtime) {
  const spawnConfig = CFG.traffic.spawn;
  let refillAccumulator = 0;
  const baseRates = spawnConfig.baseRatePerMinute ?? {};
  const configuredDefaultMultiplier = Number(CFG.traffic.defaultRegionMultiplier);
  const defaultRegionMultiplier = Number.isFinite(configuredDefaultMultiplier)
    ? configuredDefaultMultiplier
    : 1;
  const edgeRatePerMinute = (edge) => {
    const configuredRate = Number(baseRates[edge?.highway]);
    const baseRate = Number.isFinite(configuredRate) ? configuredRate : 0.5;
    const region = Number(runtime.regionMultiplier?.(edge?.id));
    return Math.max(0, baseRate * (Number.isFinite(region) ? region : defaultRegionMultiplier));
  };

  const spawnPoints = (runtime.spawnEdges ?? [])
    .map((edge) => ({
      edge,
      path: runtime.paths.get(edge.id),
      ratePerMinute: edgeRatePerMinute(edge),
      accumulator: 0,
    }))
    .filter((point) => point.path);

  const eligibleEdges = [...(runtime.paths?.values() ?? [])]
    .filter((path) => path.edge
      && path.length >= 16
      && (runtime.continuingEdgeIds?.has(path.edge.id) ?? true))
    .map((path) => ({
      path,
      weight: edgeRatePerMinute(path.edge) * path.length,
    }));
  const eligibleEdgeIds = new Set(eligibleEdges.map(({ path }) => path.edge.id));

  const horizontalDistance = (point, busPoint) => {
    if (!point || !Array.isArray(busPoint)) return Infinity;
    return Math.hypot(point[0] - busPoint[0], point[2] - busPoint[1]);
  };

  const chooseInitialEdge = () => {
    const total = eligibleEdges.reduce((sum, item) => sum + item.weight, 0);
    if (!(total > 0)) {
      return eligibleEdges[Math.floor(Math.random() * eligibleEdges.length)]?.path ?? null;
    }
    let cursor = Math.max(0, Math.min(0.999999999, Math.random())) * total;
    for (const item of eligibleEdges) {
      cursor -= item.weight;
      if (cursor < 0) return item.path;
    }
    return eligibleEdges.at(-1)?.path ?? null;
  };

  const trySpawnInterior = (busPoint, tryActivate, minDistance, maxDistance) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const path = chooseInitialEdge();
      if (!path) return false;
      const distance = 8 + Math.random() * Math.max(0, path.length - 16);
      const pose = runtime.sample(path, distance);
      if (!pose) continue;
      const busDistance = horizontalDistance([pose.x, 0, pose.z], busPoint);
      if (!(busDistance > minDistance && busDistance < maxDistance)) continue;
      if (tryActivate?.(path, distance, 4 + Math.random() * 3)) return true;
    }
    return false;
  };

  const update = (dt, busPoint, activeCount, tryActivate) => {
    let currentActive = Number.isFinite(activeCount) ? activeCount : 0;
    const delta = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    for (const point of spawnPoints) {
      point.accumulator = Math.min(
        point.accumulator + (point.ratePerMinute / 60) * delta,
        2,
      );
      if (point.accumulator < 1 || currentActive >= CFG.traffic.maxVehicles) continue;

      const start = point.path.points?.[0];
      const distance = horizontalDistance(start, busPoint);
      if (!(distance > spawnConfig.minDist && distance < spawnConfig.maxDist)) continue;

      const initialSpeed = 4 + Math.random() * 3;
      if (!tryActivate?.(point.path, 3, initialSpeed)) continue;
      point.accumulator -= 1;
      currentActive++;
    }

    // Safe connector filtering deliberately shortens some graph routes. Keep
    // the configured initial traffic floor filled without restoring unsafe
    // movements. Refill in the fogged middle distance so replacements do not
    // pop into existence immediately beside the bus; boundary inflow may
    // still raise the active count from this floor to maxVehicles.
    const fraction = Number(spawnConfig.initialFraction);
    const target = Math.min(
      CFG.traffic.maxVehicles,
      Math.max(0, Math.floor(CFG.traffic.maxVehicles * (Number.isFinite(fraction) ? fraction : 0))),
    );
    const configuredRate = Number(spawnConfig.refillRatePerSecond);
    const refillRate = Number.isFinite(configuredRate) ? Math.max(0, configuredRate) : 3;
    if (currentActive < target && refillRate > 0) {
      refillAccumulator = Math.min(4, refillAccumulator + refillRate * delta);
      const configuredCull = Number(CFG.traffic.lod?.cullRadius);
      const cullRadius = Number.isFinite(configuredCull) ? configuredCull : spawnConfig.maxDist;
      let refillMin = Math.max(spawnConfig.minDist, cullRadius * 0.35);
      let refillMax = Math.min(spawnConfig.maxDist, cullRadius * 0.95);
      if (!(refillMax > refillMin)) {
        refillMin = spawnConfig.minDist;
        refillMax = spawnConfig.maxDist;
      }
      let attempts = 0;
      while (refillAccumulator >= 1 && currentActive < target && attempts++ < 4) {
        if (!trySpawnInterior(busPoint, tryActivate, refillMin, refillMax)) break;
        refillAccumulator -= 1;
        currentActive++;
      }
    } else if (currentActive >= target) {
      refillAccumulator = 0;
    }
  };

  const seedInitial = (busPoint, tryActivate) => {
    const fraction = Number(spawnConfig.initialFraction);
    const target = Math.min(
      CFG.traffic.maxVehicles,
      Math.max(0, Math.floor(CFG.traffic.maxVehicles * (Number.isFinite(fraction) ? fraction : 0))),
    );
    const maxAttempts = target * 10;
    const placedByPath = new Map();
    let spawned = 0;

    for (let attempt = 0; attempt < maxAttempts && spawned < target; attempt++) {
      const path = chooseInitialEdge();
      if (!path) break;
      const distance = 8 + Math.random() * Math.max(0, path.length - 16);
      const pose = runtime.sample(path, distance);
      if (!pose) continue;
      const busDistance = horizontalDistance([pose.x, 0, pose.z], busPoint);
      if (!(busDistance > spawnConfig.minDist && busDistance < spawnConfig.maxDist)) continue;

      const placed = placedByPath.get(path.id) ?? [];
      if (placed.some((otherDistance) => Math.abs(otherDistance - distance) < 20)) continue;
      if (!tryActivate?.(path, distance, 4 + Math.random() * 3)) continue;
      placed.push(distance);
      placedByPath.set(path.id, placed);
      spawned++;
    }
    return spawned;
  };

  return {
    spawnPoints,
    eligibleEdgeIds,
    seedInitial,
    update,
  };
}
