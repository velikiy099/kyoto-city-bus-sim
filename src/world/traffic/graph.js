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

  const paths = new Map();
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
      length: cumulative.at(-1) || 1,
      ...extra,
    });
  };
  for (const edge of graph.edges ?? []) makePath(edge.id, edge.points, { edge });
  for (const connector of graph.connectors ?? []) makePath(connector.id, connector.points, { connector });

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
    const options = connectorsByEdge.get(edge?.id) ?? [];
    const candidates = canTurn
      ? options
      : options.filter((connector) => !isTurnConnector(connector));
    if (!candidates.length) return null;

    const weights = candidates.map((connector) => {
      const toEdge = edgeById.get(connector.to);
      const highwayWeight = CFG.traffic.routeWeights[toEdge?.highway] ?? 1;
      return highwayWeight * (isTurnConnector(connector) ? CFG.traffic.driver.turnWeightFactor : 1);
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
      if (remaining <= EPSILON) break;
    }

    return { enteredConnector, ended };
  }

  pose() {
    return this.runtime.sample(this.current, this.distance);
  }

  poseAt(ahead) {
    if (!this.current) return null;
    let distance = Math.max(0, ahead);
    for (let index = 0; index < this.entries.length; index++) {
      const item = this.entries[index].item;
      const start = index === 0 ? this.distance : 0;
      const available = item.length - start;
      if (distance <= available) return this.runtime.sample(item, start + distance);
      distance -= available;
    }
    const last = this.entries.at(-1).item;
    return this.runtime.sample(last, last.length);
  }
}
