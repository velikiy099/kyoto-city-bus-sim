import * as THREE from "three";
import { elevationAt, laneCenterAt } from "../../route/routeData.js";
import { makeCar, makeTruck } from "./vehicleModels.js";
import {
  clamp,
  idmAcceleration,
  orientedBoxesOverlap,
  SIGNAL_STOP_LINE_OFFSET,
  SIGNAL_STOP_GAP,
  signalStopLineS,
  busSignalStopTargetS,
} from "./dynamics.js";

/**
 * Map-compiled traffic.  Every non-player vehicle follows one directed OSM
 * lane edge or a precompiled turn connector; runtime never synthesizes a
 * cross-street stub or moves a car across a median.
 */
export function buildGraphTraffic(scene, path, events, signalTools) {
  const graph = events.trafficGraph;
  const g = new THREE.Group();
  scene.add(g);
  const edgeById = new Map((graph.edges ?? []).map((edge) => [edge.id, edge]));
  const connectorsByEdge = new Map();
  for (const connector of graph.connectors ?? []) {
    if (!connectorsByEdge.has(connector.from)) connectorsByEdge.set(connector.from, []);
    connectorsByEdge.get(connector.from).push(connector);
  }
  const nodeById = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const paths = new Map();
  const makePath = (id, points, extra = {}) => {
    if (!points || points.length < 2) return;
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      cumulative.push(cumulative.at(-1) + Math.hypot(b[0] - a[0], b[2] - a[2]));
    }
    paths.set(id, { id, points, cumulative, length: cumulative.at(-1) || 1, ...extra });
  };
  for (const edge of graph.edges ?? []) makePath(edge.id, edge.points, { edge });
  for (const connector of graph.connectors ?? []) makePath(connector.id, connector.points, { connector });
  const sample = (item, distance) => {
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
    // Compatibility with graphs generated before the explicit turn flag.
    const points = connector.points ?? [];
    if (points.length < 4) return false;
    const heading = (a, b) => Math.atan2(b[0] - a[0], b[2] - a[2]);
    let delta = heading(points.at(-2), points.at(-1)) - heading(points[0], points[1]);
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return Math.abs(delta) > Math.PI / 5 && Math.abs(delta) < Math.PI * 0.8;
  };
  const MIN_STRAIGHT_AFTER_TURN = 100;
  const defs = [
    { make: () => makeCar(0xd8dde2), length: 4.5, width: 1.82, height: 1.8, vMax: 11 },
    { make: () => makeCar(0x4e637b), length: 4.5, width: 1.82, height: 1.8, vMax: 10.5 },
    { make: () => makeTruck(0x7d8288), length: 6.6, width: 2.15, height: 2.8, vMax: 9.5 },
    { make: () => makeCar(0x704044), length: 4.5, width: 1.82, height: 1.8, vMax: 11.5 },
    { make: () => makeCar(0x9aa3ab), length: 4.5, width: 1.82, height: 1.8, vMax: 10.5 },
  ];
  const agents = [];
  let serial = 0;
  let simulationTime = 0;
  let collisionCooldown = 0;
  let lastBusS = 0;
  const junctionBusy = new Map();
  const nodePhase = (id) => [...String(id ?? "")].reduce((hash, character) => (hash * 33 + character.charCodeAt(0)) % 42, 0);
  const eligibleEdges = [...paths.values()].filter((item) => item.edge && item.length > 30);
  const distanceTo = (item, point) => {
    let best = Infinity;
    for (const samplePoint of item.points) best = Math.min(best, Math.hypot(samplePoint[0] - point[0], samplePoint[2] - point[1]));
    return best;
  };
  const makeAgent = (index) => {
    const def = defs[index % defs.length];
    const inner = def.make();
    const outer = new THREE.Group();
    outer.add(inner);
    g.add(outer);
    return {
      id: `graph-${serial++}`,
      outer,
      inner,
      ...def,
      path: null,
      distance: 0,
      distanceSinceTurn: MIN_STRAIGHT_AFTER_TURN,
      v: 5 + Math.random() * 2,
      nextEdge: null,
    };
  };
  const place = (agent) => {
    const pose = sample(agent.path, agent.distance);
    agent.outer.position.set(pose.x, pose.y + 0.04, pose.z);
    agent.outer.rotation.y = pose.heading;
    agent.inner.rotation.x = pose.pitch;
  };
  const respawn = (agent, busPoint) => {
    const candidates = eligibleEdges
      .map((item) => ({ item, distance: distanceTo(item, busPoint) }))
      .filter((item) => item.distance > 75 && item.distance < 1250)
      .sort((a, b) => a.distance - b.distance);
    const chosen = (candidates[Math.floor(Math.random() * Math.min(candidates.length, 80))] ?? { item: eligibleEdges[Math.floor(Math.random() * eligibleEdges.length)] }).item;
    agent.path = chosen;
    agent.distance = Math.min(Math.max(3, 8 + Math.random() * Math.max(1, chosen.length - 26)), Math.max(3, chosen.length - 8));
    agent.distanceSinceTurn = MIN_STRAIGHT_AFTER_TURN;
    agent.nextEdge = null;
    agent.v = 4 + Math.random() * 3;
    place(agent);
  };
  for (let i = 0; i < Math.min(64, Math.max(18, Math.ceil(eligibleEdges.length / 18))); i++) agents.push(makeAgent(i));
  const setSignalStates = (dt, busS, busV) => {
    for (const sig of signalTools.signals) {
      sig.phase = (sig.phase + dt) % 42;
      const state = sig.phase < 22 ? "green" : sig.phase < 25 ? "yellow" : "red";
      if (state !== sig.state) {
        sig.state = state;
        for (const head of sig.mainHeads) signalTools.paintHead(head, state);
      }
      const crossState = sig.phase >= 26 && sig.phase < 40 ? (sig.phase < 38 ? "green" : "yellow") : "red";
      if (crossState !== sig.crossState) {
        sig.crossState = crossState;
        for (const head of sig.crossHeads) signalTools.paintHead(head, crossState);
      }
      const lineS = signalStopLineS(sig.s);
      if (state === "red" && lastBusS < lineS && busS >= lineS && busV > 1.5) events.onRedLight?.();
    }
    lastBusS = busS;
  };
  const chooseConnector = (agent) => {
    const options = connectorsByEdge.get(agent.path.edge?.id) ?? [];
    if (!options.length) return null;
    const straight = options.filter((item) => !isTurnConnector(item));
    const canTurn = (agent.distanceSinceTurn ?? Infinity) >= MIN_STRAIGHT_AFTER_TURN;
    if (!canTurn && !straight.length) return null;
    const pool = canTurn
      ? (straight.length && Math.random() < 0.72 ? straight : options)
      : straight;
    return pool[Math.floor(Math.random() * pool.length)];
  };
  const busPose = (busS, busPos, busV, busHeading, busLat) => ({
    x: busPos[0], z: busPos[1], y: busPos[2] ?? elevationAt(busS) + 1.35, heading: busHeading,
    halfLength: 5.66, halfWidth: 1.19, height: 3, speed: busV, s: busS, lat: busLat,
  });
  const agentPose = (agent) => ({
    x: agent.outer.position.x, z: agent.outer.position.z, y: agent.outer.position.y + agent.height / 2,
    heading: agent.outer.rotation.y, halfLength: agent.length * 0.41, halfWidth: agent.width * 0.43, height: agent.height,
  });
  return {
    signals: signalTools.signals,
    update(dt, busS, busPos, busV, busHeading = 0, busLat = laneCenterAt(busS)) {
      simulationTime += dt;
      setSignalStates(dt, busS, busV);
      const bus = busPose(busS, busPos, busV, busHeading, busLat);
      const busPoint = [bus.x, bus.z];
      for (const agent of agents) if (!agent.path) respawn(agent, busPoint);
      for (const agent of agents) {
        let gap = Infinity;
        for (const other of agents) {
          if (other === agent || other.path?.id !== agent.path?.id || other.distance <= agent.distance) continue;
          gap = Math.min(gap, other.distance - agent.distance - (agent.length + other.length) * 0.5);
        }
        const node = agent.path.edge ? nodeById.get(agent.path.edge.to) : null;
        const remaining = agent.path.length - agent.distance;
        const phase = node?.signal ? ((simulationTime + nodePhase(node.id)) % 42) : 0;
        const stopForSignal = node?.signal && phase >= 22 && remaining < 22;
        const busyUntil = node ? junctionBusy.get(node.id) ?? 0 : 0;
        const stopForJunction = !node?.signal && busyUntil > simulationTime && remaining < 10;
        if (stopForSignal) {
          // remainingは車体基準点から信号ノードまでの距離。NPCの前端を
          // 停止線(ノードの9m手前)から安全車間だけ手前に置く。
          gap = Math.min(
            gap,
            Math.max(0, remaining - agent.length * 0.5 - SIGNAL_STOP_LINE_OFFSET),
          );
        } else if (stopForJunction) {
          gap = Math.min(gap, Math.max(0, remaining - 3));
        }
        const desired = Math.min(agent.vMax, agent.path.edge?.speed ?? 8.5);
        agent.v = clamp(agent.v + idmAcceleration(agent.v, desired, gap, gap < Infinity ? 0 : desired, { minimumGap: SIGNAL_STOP_GAP }) * dt, 0, desired);
        const distanceMoved = agent.v * dt;
        agent.distance += distanceMoved;
        if (!isTurnConnector(agent.path.connector)) {
          agent.distanceSinceTurn = Math.min(
            MIN_STRAIGHT_AFTER_TURN,
            (agent.distanceSinceTurn ?? MIN_STRAIGHT_AFTER_TURN) + distanceMoved,
          );
        }
        if (agent.distance >= agent.path.length) {
          if (agent.path.connector) {
            if (isTurnConnector(agent.path.connector)) agent.distanceSinceTurn = 0;
            agent.path = paths.get(agent.path.connector.to);
            agent.distance = 0.2;
          } else {
            const connector = chooseConnector(agent);
            if (connector && paths.has(connector.id)) {
              junctionBusy.set(connector.node, simulationTime + 2.5);
              agent.path = paths.get(connector.id);
              agent.distance = 0.1;
            } else {
              respawn(agent, busPoint);
            }
          }
        }
        place(agent);
        if (collisionCooldown <= 0 && orientedBoxesOverlap(agentPose(agent), bus)) {
          collisionCooldown = 4;
          events.onCollision?.();
        }
      }
      collisionCooldown = Math.max(0, collisionCooldown - dt);
    },
    /**
     * autoDrive用: グラフ上のNPCのうち、本線上で自車と同方向・同車線に
     * 近い車両までの実車間を返す。交差道路上の車は進行方向が一致しない
     * ため除外し、交差点付近の横切り車を同行車と誤認しない。
     */
    leadGapAhead(busS, busLat, maxDist = 80) {
      let best = null;
      for (const agent of agents) {
        if (!agent.path || agent.path.connector) continue;
        const projection = path.closestS(
          [agent.outer.position.x, agent.outer.position.z],
          busS,
          Math.max(150, maxDist + 50),
        );
        if (projection.s <= busS || projection.s - busS > maxDist) continue;
        if (projection.dist > 9 || Math.abs(projection.lateral - busLat) > 2.5) continue;
        const tangent = path.getTangent(projection.s);
        const heading = agent.outer.rotation.y;
        const forward = [Math.sin(heading), Math.cos(heading)];
        if (forward[0] * tangent[0] + forward[1] * tangent[1] < 0.8) continue;
        // Reject a geometrically nearby road at a different height, such as a
        // bridge or underpass crossing the bus route.
        const busY = elevationAt(busS);
        if (Math.abs(agent.outer.position.y - busY) > 2.5) continue;
        const gap = projection.s - busS - (agent.length + 11.4) * 0.5;
        if (gap > 0 && gap < maxDist && (best == null || gap < best)) best = gap;
      }
      return best;
    },
    nextSignal(busS) {
      let best = null;
      for (const sig of signalTools.signals) {
        const d = sig.s - busS;
        if (d > -5 && (!best || d < best.d)) best = { d, state: sig.state };
      }
      return best;
    },
    redStopTarget(busS, busV) {
      for (const sig of signalTools.signals) {
        const target = busSignalStopTargetS(sig.s);
        const d = target - busS;
        if (d >= 0 && d < 90 && sig.state !== "green") return busS + d;
      }
      return null;
    },
  };
}
