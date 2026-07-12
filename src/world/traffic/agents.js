import * as THREE from "three";
import { elevationAt, laneCenterAt } from "../../route/routeData.js";
import { makeCar, makeTruck } from "./vehicleModels.js";
import {
  clamp,
  idmAcceleration,
  orientedBoxesOverlap,
  SIGNAL_STOP_LINE_OFFSET,
  SIGNAL_STOP_GAP,
} from "./dynamics.js";
import { RouteCursor } from "./graph.js";

/**
 * コンパイル済みグラフ上を走る NPC エージェント群。
 * 車両の位置は RouteCursor のパスサンプルにスナップしたままにする。
 */
export function createTrafficAgents(scene, path, runtime, events = {}, signalsApi) {
  const group = new THREE.Group();
  scene.add(group);

  const defs = [
    { make: () => makeCar(0xd8dde2), length: 4.5, width: 1.82, height: 1.8, vMax: 11 },
    { make: () => makeCar(0x4e637b), length: 4.5, width: 1.82, height: 1.8, vMax: 10.5 },
    { make: () => makeTruck(0x7d8288), length: 6.6, width: 2.15, height: 2.8, vMax: 9.5 },
    { make: () => makeCar(0x704044), length: 4.5, width: 1.82, height: 1.8, vMax: 11.5 },
    { make: () => makeCar(0x9aa3ab), length: 4.5, width: 1.82, height: 1.8, vMax: 10.5 },
  ];
  const eligibleEdges = [...runtime.paths.values()].filter((item) => item.edge && item.length > 30);
  const agents = [];
  const stats = { horizonFailures: 0 };
  let serial = 0;
  let simulationTime = 0;
  let collisionCooldown = 0;
  const junctionBusy = new Map();

  const distanceTo = (item, point) => {
    let best = Infinity;
    for (const samplePoint of item.points) {
      best = Math.min(best, Math.hypot(samplePoint[0] - point[0], samplePoint[2] - point[1]));
    }
    return best;
  };

  const makeAgent = (index) => {
    const def = defs[index % defs.length];
    const inner = def.make();
    const outer = new THREE.Group();
    outer.add(inner);
    group.add(outer);
    return {
      id: `graph-${serial++}`,
      outer,
      inner,
      ...def,
      cursor: null,
      v: 5 + Math.random() * 2,
    };
  };

  const place = (agent) => {
    const pose = agent.cursor.pose();
    if (!pose) return;
    agent.outer.position.set(pose.x, pose.y + 0.04, pose.z);
    agent.outer.rotation.y = pose.heading;
    agent.inner.rotation.x = pose.pitch;
  };

  const respawn = (agent, busPoint) => {
    if (!eligibleEdges.length) {
      agent.cursor = null;
      return;
    }
    const candidates = eligibleEdges
      .map((item) => ({ item, distance: distanceTo(item, busPoint) }))
      .filter((item) => item.distance > 75 && item.distance < 1250)
      .sort((a, b) => a.distance - b.distance);
    const chosen = (
      candidates[Math.floor(Math.random() * Math.min(candidates.length, 80))]
      ?? { item: eligibleEdges[Math.floor(Math.random() * eligibleEdges.length)] }
    ).item;
    const distance = Math.min(
      Math.max(3, 8 + Math.random() * Math.max(1, chosen.length - 26)),
      Math.max(3, chosen.length - 8),
    );
    agent.cursor = new RouteCursor(runtime, chosen, distance);
    agent.v = 4 + Math.random() * 3;
    place(agent);
  };

  for (let i = 0; i < Math.min(64, Math.max(18, Math.ceil(eligibleEdges.length / 18))); i++) {
    agents.push(makeAgent(i));
  }

  const busPose = (busS, busPos, busV, busHeading, busLat) => ({
    x: busPos[0],
    z: busPos[1],
    y: busPos[2] ?? elevationAt(busS) + 1.35,
    heading: busHeading,
    halfLength: 5.66,
    halfWidth: 1.19,
    height: 3,
    speed: busV,
    s: busS,
    lat: busLat,
  });

  const agentPose = (agent) => ({
    x: agent.outer.position.x,
    z: agent.outer.position.z,
    y: agent.outer.position.y + agent.height / 2,
    heading: agent.outer.rotation.y,
    halfLength: agent.length * 0.41,
    halfWidth: agent.width * 0.43,
    height: agent.height,
  });

  const buildPathBuckets = () => {
    const buckets = new Map();
    for (const agent of agents) {
      const item = agent.cursor?.current;
      if (!item) continue;
      if (!buckets.has(item.id)) buckets.set(item.id, []);
      buckets.get(item.id).push(agent);
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => a.cursor.distance - b.cursor.distance);
    }
    return buckets;
  };

  const gapToLead = (agent, buckets) => {
    const current = agent.cursor.current;
    const bucket = buckets.get(current.id) ?? [];
    const ownDistance = agent.cursor.distance;
    for (const other of bucket) {
      if (other === agent) continue;
      if (other.cursor.distance > ownDistance) {
        return other.cursor.distance - ownDistance - (agent.length + other.length) * 0.5;
      }
    }

    let distanceToEntry = agent.cursor.remainingOnCurrent();
    for (const entry of agent.cursor.entries.slice(1)) {
      const futureBucket = buckets.get(entry.item.id) ?? [];
      const lead = futureBucket.find((other) => other !== agent);
      if (lead) {
        return distanceToEntry
          + lead.cursor.distance
          - (agent.length + lead.length) * 0.5;
      }
      distanceToEntry += entry.item.length;
    }
    return Infinity;
  };

  return {
    agents,
    stats,
    update(dt, busS, busPos, busV, busHeading = 0, busLat = laneCenterAt(busS)) {
      simulationTime += dt;
      const bus = busPose(busS, busPos, busV, busHeading, busLat);
      const busPoint = [bus.x, bus.z];
      for (const agent of agents) if (!agent.cursor?.current) respawn(agent, busPoint);
      const buckets = buildPathBuckets();

      for (const agent of agents) {
        if (!agent.cursor?.current) continue;
        if (!agent.cursor.ensureHorizon(Math.max(40, agent.v * 4))) stats.horizonFailures++;

        const current = agent.cursor.current;
        let gap = gapToLead(agent, buckets);
        const node = current.edge ? runtime.nodeById.get(current.edge.to) : null;
        const remaining = agent.cursor.remainingOnCurrent();
        const stopForSignal = node?.signal
          && signalsApi.isNpcStopPhase(node.id, simulationTime)
          && remaining < 22;
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

        const desired = Math.min(agent.vMax, current.edge?.speed ?? 8.5);
        agent.v = clamp(
          agent.v + idmAcceleration(
            agent.v,
            desired,
            gap,
            gap < Infinity ? 0 : desired,
            { minimumGap: SIGNAL_STOP_GAP },
          ) * dt,
          0,
          desired,
        );
        const res = agent.cursor.advance(agent.v * dt);
        if (res.enteredConnector) {
          junctionBusy.set(res.enteredConnector.node, simulationTime + 2.5);
        }
        if (res.ended) respawn(agent, busPoint);

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
        const current = agent.cursor?.current;
        if (!current || current.connector) continue;
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
        // 高架とアンダーパスのように平面上で近くても高さが違う道路を除外する。
        const busY = elevationAt(busS);
        if (Math.abs(agent.outer.position.y - busY) > 2.5) continue;
        const gap = projection.s - busS - (agent.length + 11.4) * 0.5;
        if (gap > 0 && gap < maxDist && (best == null || gap < best)) best = gap;
      }
      return best;
    },
  };
}
