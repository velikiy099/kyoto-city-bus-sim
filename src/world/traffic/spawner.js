import { CFG } from "../../config.js";

const CELL_SIZE = 256;

/**
 * 交通グラフの端点流入および中遠距離帯への補充を担うスポーナー。
 * 空間グリッドで自車周辺の候補エッジのみを抽出し、生成位置を判断する。
 */
export function createSpawner(runtime) {
  const spawnConfig = CFG.traffic.spawn;
  let refillAccumulator = 0;
  let spawnCursor = 0;
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

  const cellKey = (cx, cz) => `${cx},${cz}`;
  const eligibleGrid = new Map();
  const eligibleEdges = [...(runtime.paths?.values() ?? [])]
    .filter((path) => path.edge
      && path.length >= 16
      && (runtime.continuingEdgeIds?.has(path.edge.id) ?? true))
    .map((path) => {
      const mid = path.points[Math.floor(path.points.length / 2)] ?? path.points[0];
      const item = {
        path,
        weight: edgeRatePerMinute(path.edge) * path.length,
        midX: mid[0],
        midZ: mid[2],
      };
      const cx = Math.floor(item.midX / CELL_SIZE);
      const cz = Math.floor(item.midZ / CELL_SIZE);
      const key = cellKey(cx, cz);
      if (!eligibleGrid.has(key)) eligibleGrid.set(key, []);
      eligibleGrid.get(key).push(item);
      return item;
    });
  const eligibleEdgeIds = new Set(eligibleEdges.map(({ path }) => path.edge.id));

  const horizontalDistance = (point, busPoint) => {
    if (!point || !Array.isArray(busPoint)) return Infinity;
    return Math.hypot(point[0] - busPoint[0], point[2] - busPoint[1]);
  };

  const candidatesInRange = (busPoint, minDistance, maxDistance) => {
    if (!Array.isArray(busPoint) || !Number.isFinite(maxDistance)) return eligibleEdges;
    const searchRadius = maxDistance + CELL_SIZE;
    const minCx = Math.floor((busPoint[0] - searchRadius) / CELL_SIZE);
    const maxCx = Math.floor((busPoint[0] + searchRadius) / CELL_SIZE);
    const minCz = Math.floor((busPoint[1] - searchRadius) / CELL_SIZE);
    const maxCz = Math.floor((busPoint[1] + searchRadius) / CELL_SIZE);
    const result = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = eligibleGrid.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (const item of bucket) {
          const d = Math.hypot(item.midX - busPoint[0], item.midZ - busPoint[1]);
          const halfLen = item.path.length * 0.5;
          if (d + halfLen > minDistance && d - halfLen < maxDistance) {
            result.push(item);
          }
        }
      }
    }
    return result;
  };

  const pickWeighted = (items, totalWeight) => {
    if (!items.length) return null;
    if (!(totalWeight > 0)) {
      return items[Math.floor(Math.random() * items.length)]?.path ?? null;
    }
    let cursor = Math.max(0, Math.min(0.999999999, Math.random())) * totalWeight;
    for (const item of items) {
      cursor -= item.weight;
      if (cursor < 0) return item.path;
    }
    return items.at(-1)?.path ?? null;
  };

  const trySpawnInterior = (busPoint, tryActivate, minDistance, maxDistance) => {
    const candidates = candidatesInRange(busPoint, minDistance, maxDistance);
    if (!candidates.length) return false;
    const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
    for (let attempt = 0; attempt < 16; attempt++) {
      const path = pickWeighted(candidates, totalWeight);
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

  const update = (dt, busPoint, activeCount, tryActivate, options = {}) => {
    let currentActive = Number.isFinite(activeCount) ? activeCount : 0;
    let currentVisible = Number.isFinite(options.visibleCount) ? options.visibleCount : null;
    const recycleFarthest = typeof options.recycleFarthest === "function"
      ? options.recycleFarthest
      : null;
    const delta = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const configuredCull = Number(CFG.traffic.lod?.cullRadius);
    const cullRadius = Number.isFinite(configuredCull) ? configuredCull : spawnConfig.maxDist;
    const recycleMinDist = Number.isFinite(Number(spawnConfig.recycleMinDist))
      ? Number(spawnConfig.recycleMinDist)
      : Math.max(cullRadius + 150, 850);
    const fraction = Number(spawnConfig.initialFraction);
    const target = Math.min(
      CFG.traffic.maxVehicles,
      Math.max(0, Math.floor(CFG.traffic.maxVehicles * (Number.isFinite(fraction) ? fraction : 0))),
    );
    const visFraction = Number(spawnConfig.minVisibleFraction);
    const targetVisible = Math.min(
      target,
      Math.max(0, Math.floor(CFG.traffic.maxVehicles * (Number.isFinite(visFraction) ? visFraction : 0.45))),
    );

    // 範囲内の端点だけレートを蓄積し、ラウンドロビン走査で配列先頭への偏りを防ぐ。
    const pointCount = spawnPoints.length;
    if (pointCount > 0) {
      const startIndex = spawnCursor % pointCount;
      for (let offset = 0; offset < pointCount; offset++) {
        const idx = (startIndex + offset) % pointCount;
        const point = spawnPoints[idx];
        const spawnPose = runtime.sample(point.path, 3);
        const start = spawnPose ? [spawnPose.x, 0, spawnPose.z] : point.path.points?.[0];
        const distance = horizontalDistance(start, busPoint);
        if (!(distance > spawnConfig.minDist && distance < spawnConfig.maxDist)) {
          point.accumulator = 0;
          continue;
        }
        point.accumulator = Math.min(
          point.accumulator + (point.ratePerMinute / 60) * delta,
          1.5,
        );
        if (point.accumulator < 1) continue;

        if (currentActive >= CFG.traffic.maxVehicles) {
          const canRecycle = currentVisible != null
            && currentVisible < targetVisible
            && distance <= cullRadius
            && recycleFarthest?.(recycleMinDist);
          if (!canRecycle) continue;
          currentActive--;
        }

        const initialSpeed = 4 + Math.random() * 3;
        if (!tryActivate?.(point.path, 3, initialSpeed)) continue;
        point.accumulator -= 1;
        currentActive++;
        if (currentVisible != null && distance <= cullRadius) currentVisible++;
        spawnCursor = (idx + 1) % pointCount;
      }
    }

    // 視界外・霧の中遠距離帯へ交通量を補充する。
    // 可視台数が不足して上限に達している場合は、最遠方の非表示車両をリサイクルして枠を作る。
    const configuredRate = Number(spawnConfig.refillRatePerSecond);
    const refillRate = Number.isFinite(configuredRate) ? Math.max(0, configuredRate) : 3;
    const needsActiveRefill = currentActive < target;
    const needsVisibleRefill = currentVisible != null
      && currentVisible < targetVisible
      && recycleFarthest != null;

    if ((needsActiveRefill || needsVisibleRefill) && refillRate > 0) {
      refillAccumulator = Math.min(4, refillAccumulator + refillRate * delta);
      let refillMin = Number.isFinite(Number(spawnConfig.refillMinDist))
        ? Number(spawnConfig.refillMinDist)
        : Math.max(spawnConfig.minDist, cullRadius * 0.65);
      let refillMax = Number.isFinite(Number(spawnConfig.refillMaxDist))
        ? Number(spawnConfig.refillMaxDist)
        : Math.min(spawnConfig.maxDist, cullRadius * 1.35);
      if (!(refillMax > refillMin)) {
        refillMin = spawnConfig.minDist;
        refillMax = spawnConfig.maxDist;
      }

      let attempts = 0;
      while (refillAccumulator >= 1 && attempts++ < 4) {
        const stillNeedsActive = currentActive < target;
        const stillNeedsVisible = currentVisible != null
          && currentVisible < targetVisible
          && recycleFarthest != null;
        if (!stillNeedsActive && !stillNeedsVisible) break;

        if (currentActive >= CFG.traffic.maxVehicles) {
          if (!stillNeedsVisible || !recycleFarthest(recycleMinDist)) break;
          currentActive--;
        }

        // 可視台数不足時は霧の濃い視界縁リング(refillMin〜cullRadius-20)へ優先補充する。
        const useVisibleRing = stillNeedsVisible && !stillNeedsActive && cullRadius - 20 > refillMin;
        const rangeMin = refillMin;
        const rangeMax = useVisibleRing ? Math.min(refillMax, cullRadius - 20) : refillMax;
        if (!trySpawnInterior(busPoint, tryActivate, rangeMin, rangeMax)) break;
        refillAccumulator -= 1;
        currentActive++;
        if (currentVisible != null && rangeMax <= cullRadius) currentVisible++;
      }
    } else {
      refillAccumulator = 0;
    }
  };

  const seedInitial = (busPoint, tryActivate) => {
    const fraction = Number(spawnConfig.initialFraction);
    const target = Math.min(
      CFG.traffic.maxVehicles,
      Math.max(0, Math.floor(CFG.traffic.maxVehicles * (Number.isFinite(fraction) ? fraction : 0))),
    );
    const minDist = Number.isFinite(Number(spawnConfig.initialMinDist))
      ? Number(spawnConfig.initialMinDist)
      : 90;
    const maxDist = Number.isFinite(Number(spawnConfig.initialMaxDist))
      ? Number(spawnConfig.initialMaxDist)
      : spawnConfig.maxDist;
    const candidates = candidatesInRange(busPoint, minDist, maxDist);
    if (!candidates.length) return 0;
    const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
    const maxAttempts = Math.max(target * 12, 120);
    const placedByPath = new Map();
    let spawned = 0;

    for (let attempt = 0; attempt < maxAttempts && spawned < target; attempt++) {
      const path = pickWeighted(candidates, totalWeight);
      if (!path) break;
      const distance = 8 + Math.random() * Math.max(0, path.length - 16);
      const pose = runtime.sample(path, distance);
      if (!pose) continue;
      const busDistance = horizontalDistance([pose.x, 0, pose.z], busPoint);
      if (!(busDistance > minDist && busDistance < maxDist)) continue;

      const placed = placedByPath.get(path.id) ?? [];
      if (placed.some((otherDistance) => Math.abs(otherDistance - distance) < 22)) continue;
      if (!tryActivate?.(path, distance, 4 + Math.random() * 3)) continue;
      placed.push(distance);
      placedByPath.set(path.id, placed);
      spawned++;
    }
    return spawned;
  };

  const reset = () => {
    refillAccumulator = 0;
    spawnCursor = 0;
    for (const point of spawnPoints) point.accumulator = 0;
  };

  return {
    spawnPoints,
    eligibleEdgeIds,
    seedInitial,
    update,
    reset,
  };
}
