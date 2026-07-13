import { CFG } from "../../config.js";
import { clamp } from "./dynamics.js";

/**
 * コンパイル済み交通グラフのランタイム表現。
 * 車両は edge と turn connector を一つの経路列として先読みする。
 */
export function createGraphRuntime(trafficGraph) {
  const graph = trafficGraph ?? {};
  const edgeById = new Map((graph.edges ?? []).map((edge) => [edge.id, edge]));
  const nodeById = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const connectorsByEdge = new Map();
  for (const connector of graph.connectors ?? []) {
    if (!connectorsByEdge.has(connector.from)) connectorsByEdge.set(connector.from, []);
    connectorsByEdge.get(connector.from).push(connector);
  }
  // Greatest fixed point of edges that always have a route into another edge
  // in the same set.  Spawning and routing inside this directed core prevents
  // agents from entering visible graph boundaries and disappearing there.
  const continuingEdgeIds = new Set(edgeById.keys());
  let removedContinuingEdge = true;
  while (removedContinuingEdge) {
    removedContinuingEdge = false;
    for (const edgeId of [...continuingEdgeIds]) {
      const hasContinuation = (connectorsByEdge.get(edgeId) ?? [])
        .some((connector) => continuingEdgeIds.has(connector.to));
      if (hasContinuation) continue;
      continuingEdgeIds.delete(edgeId);
      removedContinuingEdge = true;
    }
  }

  const paths = new Map();
  const tessellateBezier = (points, divisions = 24) => {
    if (!Array.isArray(points) || points.length !== 4) return points;
    const [a, ctrlA, ctrlB, b] = points;
    const result = [];
    for (let index = 0; index <= divisions; index++) {
      const t = index / divisions;
      const inv = 1 - t;
      const w0 = inv ** 3;
      const w1 = 3 * inv ** 2 * t;
      const w2 = 3 * inv * t ** 2;
      const w3 = t ** 3;
      result.push([
        w0 * a[0] + w1 * ctrlA[0] + w2 * ctrlB[0] + w3 * b[0],
        w0 * a[1] + w1 * ctrlA[1] + w2 * ctrlB[1] + w3 * b[1],
        w0 * a[2] + w1 * ctrlA[2] + w2 * ctrlB[2] + w3 * b[2],
      ]);
    }
    return result;
  };
  const makePath = (id, points, extra = {}) => {
    if (!points || points.length < 2) return;
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      cumulative.push(cumulative.at(-1) + Math.hypot(b[0] - a[0], b[2] - a[2]));
    }
    paths.set(id, {
      id,
      points,
      cumulative,
      length: cumulative.at(-1),
      ...extra,
    });
  };
  for (const edge of graph.edges ?? []) makePath(edge.id, edge.points, { edge });
  for (const connector of graph.connectors ?? []) {
    const points = connector.zeroLength
      ? [connector.points[0], connector.points.at(-1)]
      : tessellateBezier(connector.points);
    makePath(connector.id, points, { connector });
  }
  const edgeEndHeading = new Map();
  for (const edge of graph.edges ?? []) {
    const path = paths.get(edge.id);
    if (!path || path.points.length < 2) continue;
    const a = path.points.at(-2);
    const b = path.points.at(-1);
    edgeEndHeading.set(edge.id, Math.atan2(b[0] - a[0], b[2] - a[2]));
  }

  const pointInPolygon = (x, z, polygon) => {
    if (!Array.isArray(polygon) || polygon.length < 3) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const ax = Number(a[0]), az = Number(a[1]);
      const bx = Number(b[0]), bz = Number(b[1]);
      if (![ax, az, bx, bz].every(Number.isFinite)) continue;
      if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) {
        inside = !inside;
      }
    }
    return inside;
  };

  // 地域倍率はエッジの中央点で一度だけ判定し、経路選択から参照する。
  const regions = Array.isArray(CFG.traffic.regions) ? CFG.traffic.regions : [];
  const configuredDefaultMultiplier = Number(CFG.traffic.defaultRegionMultiplier);
  const defaultRegionMultiplier = Number.isFinite(configuredDefaultMultiplier)
    ? configuredDefaultMultiplier
    : 1;
  const regionMultipliers = new Map();
  for (const edge of graph.edges ?? []) {
    const points = edge.points ?? [];
    const midpoint = points[Math.floor(points.length / 2)];
    let multiplier = defaultRegionMultiplier;
    if (midpoint) {
      for (const region of regions) {
        if (!pointInPolygon(midpoint[0], midpoint[2], region?.polygon)) continue;
        const candidate = Number(region.multiplier);
        if (Number.isFinite(candidate)) multiplier = candidate;
        break;
      }
    }
    regionMultipliers.set(edge.id, multiplier);
  }
  const regionMultiplier = (edgeId) => regionMultipliers.get(edgeId) ?? defaultRegionMultiplier;

  const spawnEdges = [];
  const sinkNodeIds = new Set();
  const isDeadEndNode = (node) => {
    const incoming = node.incoming ?? [];
    const outgoing = node.outgoing ?? [];
    const connectedIds = [...incoming, ...outgoing];
    if (connectedIds.length > 2) return false;
    const wayIds = new Set();
    for (const edgeId of connectedIds) {
      const edge = edgeById.get(edgeId);
      if (!edge || edge.wayId == null) return false;
      wayIds.add(String(edge.wayId));
    }
    return wayIds.size === 1;
  };
  for (const node of graph.nodes ?? []) {
    const incoming = node.incoming ?? [];
    const outgoing = node.outgoing ?? [];
    const deadEnd = isDeadEndNode(node);
    if (outgoing.length > 0 && (incoming.length === 0 || deadEnd)) {
      for (const edgeId of outgoing) {
        const edge = edgeById.get(edgeId);
        if (edge && paths.has(edge.id) && continuingEdgeIds.has(edge.id)) spawnEdges.push(edge);
      }
    }
    if (incoming.length > 0 && (outgoing.length === 0 || deadEnd)) sinkNodeIds.add(node.id);
  }

  const sample = (item, distance) => {
    if (!item) return null;
    const target = clamp(distance, 0, item.length);
    let i = 0;
    while (i < item.cumulative.length - 2 && item.cumulative[i + 1] < target) i++;
    const span = item.cumulative[i + 1] - item.cumulative[i] || 1;
    const t = (target - item.cumulative[i]) / span;
    const a = item.points[i], b = item.points[i + 1];
    return {
      x: a[0] + (b[0] - a[0]) * t,
      y: a[1] + (b[1] - a[1]) * t,
      z: a[2] + (b[2] - a[2]) * t,
      heading: Math.atan2(b[0] - a[0], b[2] - a[2]),
      pitch: -Math.atan2(b[1] - a[1], Math.hypot(b[0] - a[0], b[2] - a[2]) || 1),
    };
  };

  const isTurnConnector = (connector) => {
    if (!connector) return false;
    if (typeof connector.turn === "boolean") return connector.turn;
    // 明示的な turn フラグがない旧生成データとの互換性。
    const points = connector.points ?? [];
    if (points.length < 4) return false;
    const heading = (a, b) => Math.atan2(b[0] - a[0], b[2] - a[2]);
    let delta = heading(points.at(-2), points.at(-1)) - heading(points[0], points[1]);
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return Math.abs(delta) > Math.PI / 5 && Math.abs(delta) < Math.PI * 0.8;
  };

  /** 次エッジの highway と旋回可否から、コネクタを重み付きで選ぶ。 */
  const chooseNextConnector = (edge, canTurn, rng = Math.random) => {
    const options = (connectorsByEdge.get(edge?.id) ?? [])
      .filter((connector) => continuingEdgeIds.has(connector.to));
    const straightCandidates = options.filter((connector) => !isTurnConnector(connector));
    // minStraightAfterTurn is a preference.  If obeying it would terminate
    // the route, take the available legal turn and keep the vehicle alive.
    const candidates = canTurn || !straightCandidates.length
      ? options
      : straightCandidates;
    if (!candidates.length) return null;

    const weights = candidates.map((connector) => {
      const toEdge = edgeById.get(connector.to);
      const highwayWeight = CFG.traffic.routeWeights[toEdge?.highway] ?? 1;
      return highwayWeight
        * (isTurnConnector(connector) ? CFG.traffic.driver.turnWeightFactor : 1)
        * regionMultiplier(connector.to);
    });
    const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
    if (!(total > 0)) return candidates[Math.floor(rng() * candidates.length)] ?? null;
    let cursor = Math.max(0, Math.min(0.999999999, rng())) * total;
    for (let i = 0; i < candidates.length; i++) {
      cursor -= Math.max(0, weights[i]);
      if (cursor < 0) return candidates[i];
    }
    return candidates.at(-1) ?? null;
  };

  return {
    paths,
    edgeById,
    nodeById,
    connectorsByEdge,
    continuingEdgeIds,
    edgeEndHeading,
    spawnEdges,
    sinkNodeIds,
    regionMultiplier,
    sample,
    isTurnConnector,
    chooseNextConnector,
  };
}

export class RouteCursor {
  constructor(runtime, startItem, startDistance = 0) {
    this.runtime = runtime;
    this.entries = startItem ? [{ item: startItem }] : [];
    this.distance = startItem
      ? clamp(startDistance, 0, startItem.length)
      : 0;
    // スポーン直後は旋回可能。旋回後は advance() が 0 に戻す。
    this.distanceSinceTurn = CFG.traffic.driver.minStraightAfterTurn;
  }

  get current() {
    return this.entries[0]?.item ?? null;
  }

  remainingOnCurrent() {
    return Math.max(0, (this.current?.length ?? 0) - this.distance);
  }

  remainingDistance() {
    return this.remainingOnCurrent()
      + this.entries.slice(1).reduce((sum, entry) => sum + entry.item.length, 0);
  }

  /**
   * 現在位置から末尾までの距離も旋回後距離に加えて、先読み先での
   * 連続旋回を避けながら必要な経路長を確保する。
   */
  canTurnAtTail() {
    let distanceSinceTurn = this.distanceSinceTurn;
    for (let index = 0; index < this.entries.length; index++) {
      const item = this.entries[index].item;
      const distance = index === 0 ? this.remainingOnCurrent() : item.length;
      if (item.connector && this.runtime.isTurnConnector(item.connector)) {
        distanceSinceTurn = 0;
      } else {
        distanceSinceTurn = Math.min(
          CFG.traffic.driver.minStraightAfterTurn,
          distanceSinceTurn + distance,
        );
      }
    }
    return distanceSinceTurn >= CFG.traffic.driver.minStraightAfterTurn;
  }

  ensureHorizon(meters) {
    const horizon = Math.max(0, meters);
    let blocked = false;
    let guard = 0;
    while (this.entries.length && this.remainingDistance() < horizon && guard++ < 512) {
      const tail = this.entries.at(-1).item;
      if (tail.edge) {
        const connector = this.runtime.chooseNextConnector(tail, this.canTurnAtTail());
        const connectorPath = connector && this.runtime.paths.get(connector.id);
        if (!connectorPath) {
          blocked = true;
          break;
        }
        this.entries.push({ item: connectorPath });
      } else if (tail.connector) {
        const edgePath = this.runtime.paths.get(tail.connector.to);
        if (!edgePath) {
          blocked = true;
          break;
        }
        this.entries.push({ item: edgePath });
      } else {
        blocked = true;
        break;
      }
    }
    if (guard >= 512) blocked = true;
    return !blocked && this.remainingDistance() >= horizon;
  }

  advance(delta) {
    let remaining = Number.isFinite(delta) ? Math.max(0, delta) : 0;
    let enteredConnector = null;
    let ended = false;
    const EPSILON = 1e-9;

    while (this.entries.length) {
      const item = this.entries[0].item;
      const available = Math.max(0, item.length - this.distance);
      if (remaining > EPSILON) {
        const moved = Math.min(remaining, available);
        this.distance += moved;
        remaining -= moved;
        if (!(item.connector && this.runtime.isTurnConnector(item.connector))) {
          this.distanceSinceTurn = Math.min(
            CFG.traffic.driver.minStraightAfterTurn,
            this.distanceSinceTurn + moved,
          );
        }
      }

      if (this.distance < item.length - EPSILON) break;
      if (this.entries.length === 1) {
        ended = true;
        break;
      }

      const finished = item;
      this.entries.shift();
      this.distance = 0;
      const next = this.entries[0].item;
      if (finished.connector && this.runtime.isTurnConnector(finished.connector)) {
        this.distanceSinceTurn = 0;
      }
      if (finished.edge && next.connector) enteredConnector = next.connector;
      // A zero-length straight connector is a graph transition, not a
      // physical metre of road.  Consume it atomically even when this update
      // landed exactly on the preceding edge endpoint, so pose() can never
      // expose its undefined heading for one frame.
      if (remaining <= EPSILON && next.length > EPSILON) break;
    }

    return { enteredConnector, ended };
  }

  pose() {
    const EPSILON = 1e-9;
    for (let index = 0; index < this.entries.length; index++) {
      const item = this.entries[index].item;
      if (item.length <= EPSILON) continue;
      return this.runtime.sample(item, index === 0 ? this.distance : 0);
    }
    return null;
  }

  poseAt(ahead) {
    if (!this.current) return null;
    let distance = Math.max(0, ahead);
    for (let index = 0; index < this.entries.length; index++) {
      const item = this.entries[index].item;
      const start = index === 0 ? this.distance : 0;
      const available = item.length - start;
      if (available <= 1e-9) continue;
      if (distance <= available) return this.runtime.sample(item, start + distance);
      distance -= available;
    }
    const last = this.entries.at(-1).item;
    return this.runtime.sample(last, last.length);
  }

  /** 現在位置近傍の経路へ、前方限定で平面位置を射影する。 */
  project(x, z, maxAhead = 6, heading = null) {
    if (!this.current || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    const lookAhead = Math.max(6, Number.isFinite(maxAhead) ? maxAhead : 6);
    const referenceHeading = Number.isFinite(heading) ? heading : null;
    let offsetToStart = 0;
    let best = null;

    for (let entryIndex = 0; entryIndex < this.entries.length; entryIndex++) {
      const item = this.entries[entryIndex].item;
      const localStart = entryIndex === 0 ? this.distance : 0;
      const localEnd = entryIndex === 0
        ? Math.min(item.length, this.distance + lookAhead)
        : Math.min(item.length, lookAhead - offsetToStart);
      if (localEnd < localStart) {
        if (entryIndex > 0) break;
        continue;
      }

      for (let segmentIndex = 0; segmentIndex < item.points.length - 1; segmentIndex++) {
        const a = item.points[segmentIndex];
        const b = item.points[segmentIndex + 1];
        const dx = b[0] - a[0];
        const dz = b[2] - a[2];
        const segmentLength = Math.hypot(dx, dz);
        if (!(segmentLength > 1e-9)) continue;
        const segmentStart = item.cumulative[segmentIndex];
        const segmentEnd = item.cumulative[segmentIndex + 1];
        const rangeStart = Math.max(segmentStart, localStart);
        const rangeEnd = Math.min(segmentEnd, localEnd);
        if (rangeEnd < rangeStart) continue;

        const lenSq = dx * dx + dz * dz;
        const rawT = ((x - a[0]) * dx + (z - a[2]) * dz) / lenSq;
        const rangeT0 = (rangeStart - segmentStart) / segmentLength;
        const rangeT1 = (rangeEnd - segmentStart) / segmentLength;
        const t = Math.max(rangeT0, Math.min(rangeT1, rawT));
        const px = a[0] + dx * t;
        const pz = a[2] + dz * t;
        const lateral = Math.hypot(x - px, z - pz);
        const distanceOnItem = segmentStart + segmentLength * t;
        const deltaArc = entryIndex === 0
          ? Math.max(0, distanceOnItem - this.distance)
          : Math.max(0, offsetToStart + distanceOnItem);
        let headingErr = 0;
        if (referenceHeading != null) {
          let deltaHeading = Math.atan2(dx, dz) - referenceHeading;
          while (deltaHeading > Math.PI) deltaHeading -= 2 * Math.PI;
          while (deltaHeading < -Math.PI) deltaHeading += 2 * Math.PI;
          headingErr = Math.abs(deltaHeading);
        }
        const headingCompatible = referenceHeading == null || headingErr <= Math.PI / 3;
        if (
          !best
          || (headingCompatible && !best.headingCompatible)
          || (
            headingCompatible === best.headingCompatible
            && (
              lateral < best.lateral - 1e-9
              || (Math.abs(lateral - best.lateral) <= 1e-9 && deltaArc > best.deltaArc)
            )
          )
        ) {
          best = { deltaArc, lateral, headingErr, headingCompatible };
        }
      }

      offsetToStart += entryIndex === 0 ? item.length - this.distance : item.length;
      if (offsetToStart > lookAhead) break;
    }
    return best;
  }

  /** 任意の平面位置を、現在位置から前方の経路へ射影する。 */
  projectPoint(x, z, maxAhead = 6) {
    if (!this.current || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    const lookAhead = Math.max(0, Number.isFinite(maxAhead) ? maxAhead : 6);
    let offsetToStart = 0;
    let best = null;

    for (let entryIndex = 0; entryIndex < this.entries.length; entryIndex++) {
      const item = this.entries[entryIndex].item;
      const localStart = entryIndex === 0 ? this.distance : 0;
      const localEnd = entryIndex === 0
        ? Math.min(item.length, this.distance + lookAhead)
        : Math.min(item.length, lookAhead - offsetToStart);
      if (localEnd < localStart) {
        if (entryIndex > 0) break;
        continue;
      }

      for (let segmentIndex = 0; segmentIndex < item.points.length - 1; segmentIndex++) {
        const a = item.points[segmentIndex];
        const b = item.points[segmentIndex + 1];
        const dx = b[0] - a[0];
        const dz = b[2] - a[2];
        const segmentLength = Math.hypot(dx, dz);
        if (!(segmentLength > 1e-9)) continue;
        const segmentStart = item.cumulative[segmentIndex];
        const segmentEnd = item.cumulative[segmentIndex + 1];
        const rangeStart = Math.max(segmentStart, localStart);
        const rangeEnd = Math.min(segmentEnd, localEnd);
        if (rangeEnd < rangeStart) continue;

        const lenSq = dx * dx + dz * dz;
        const rawT = ((x - a[0]) * dx + (z - a[2]) * dz) / lenSq;
        const rangeT0 = (rangeStart - segmentStart) / segmentLength;
        const rangeT1 = (rangeEnd - segmentStart) / segmentLength;
        const t = Math.max(rangeT0, Math.min(rangeT1, rawT));
        const px = a[0] + dx * t;
        const pz = a[2] + dz * t;
        const lateral = Math.hypot(x - px, z - pz);
        const distanceOnItem = segmentStart + segmentLength * t;
        const arcAhead = entryIndex === 0
          ? Math.max(0, distanceOnItem - this.distance)
          : Math.max(0, offsetToStart + distanceOnItem);
        if (
          !best
          || lateral < best.lateral - 1e-9
          || (Math.abs(lateral - best.lateral) <= 1e-9 && arcAhead > best.arcAhead)
        ) {
          best = {
            arcAhead,
            lateral,
            segmentHeading: Math.atan2(dx, dz),
          };
        }
      }

      offsetToStart += entryIndex === 0 ? item.length - this.distance : item.length;
      if (offsetToStart > lookAhead) break;
    }
    return best;
  }
}
