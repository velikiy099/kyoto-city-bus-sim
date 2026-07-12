import * as THREE from "three";
import { CFG } from "../../config.js";
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
import { createSpawner } from "./spawner.js";

/**
 * コンパイル済みグラフ上を走る NPC エージェント群。
 * 車両の位置は RouteCursor のパスサンプルにスナップしたままにする。
 */
export function createTrafficAgents(scene, path, runtime, events = {}, signalsApi, spawner) {
  const group = new THREE.Group();
  scene.add(group);

  const defs = [
    { make: () => makeCar(0xd8dde2), length: 4.5, width: 1.82, height: 1.8, vMax: 11 },
    { make: () => makeCar(0x4e637b), length: 4.5, width: 1.82, height: 1.8, vMax: 10.5 },
    { make: () => makeTruck(0x7d8288), length: 6.6, width: 2.15, height: 2.8, vMax: 9.5 },
    { make: () => makeCar(0x704044), length: 4.5, width: 1.82, height: 1.8, vMax: 11.5 },
    { make: () => makeCar(0x9aa3ab), length: 4.5, width: 1.82, height: 1.8, vMax: 10.5 },
  ];
  const trafficSpawner = spawner ?? createSpawner(runtime);
  const agents = [];
  const stats = {
    active: 0,
    spawned: 0,
    despawned: { sink: 0, blocked: 0, radius: 0, stuck: 0 },
    spawnPointCount: trafficSpawner.spawnPoints.length,
    blockedTails: 0,
  };
  const maxVehicles = Math.max(0, Math.floor(CFG.traffic.maxVehicles));
  let serial = 0;
  let simulationTime = 0;
  let collisionCooldown = 0;
  let initialSeeded = false;
  const junctionBusy = new Map();

  const countActive = () => agents.reduce((count, agent) => count + (agent.active ? 1 : 0), 0);

  const makeAgent = (index) => {
    const def = defs[index % defs.length];
    const inner = def.make();
    const outer = new THREE.Group();
    outer.visible = false;
    outer.add(inner);
    group.add(outer);
    return {
      id: `graph-${serial++}`,
      outer,
      inner,
      ...def,
      active: false,
      cursor: null,
      v: 0,
      stuckTime: 0,
    };
  };

  for (let i = 0; i < maxVehicles; i++) agents.push(makeAgent(i));

  const place = (agent) => {
    const pose = agent.cursor ? agent.cursor.pose() : null;
    if (!pose) return false;
    agent.outer.position.set(pose.x, pose.y + 0.04, pose.z);
    agent.outer.rotation.y = pose.heading;
    agent.inner.rotation.x = pose.pitch;
    return true;
  };

  /** 端点の先頭20mに車がいる場合は、そこへの流入を受け付けない。 */
  const tryActivate = (startPath, startDistance = 3, initialSpeed = 5) => {
    if (!startPath?.id || !runtime.paths.has(startPath.id)) return false;
    const entryOccupied = agents.some((agent) => agent.active
      && agent.cursor?.current?.id === startPath.id
      && agent.cursor.distance < 20);
    if (entryOccupied) return false;

    const agent = agents.find((candidate) => !candidate.active);
    if (!agent) return false;
    const cursor = new RouteCursor(runtime, startPath, startDistance);
    agent.cursor = cursor;
    agent.v = Number.isFinite(initialSpeed) ? Math.max(0, initialSpeed) : 5;
    agent.stuckTime = 0;
    if (!place(agent)) {
      agent.cursor = null;
      agent.v = 0;
      return false;
    }
    agent.active = true;
    agent.outer.visible = true;
    stats.spawned++;
    stats.active++;
    return true;
  };

  const deactivate = (agent, reason) => {
    if (!agent.active) return;
    agent.active = false;
    agent.cursor = null;
    agent.v = 0;
    agent.stuckTime = 0;
    agent.outer.visible = false;
    if (stats.despawned[reason] != null) stats.despawned[reason]++;
    stats.active = countActive();
  };

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
      if (!agent.active) continue;
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
      if (other === agent || !other.active) continue;
      if (other.cursor.distance > ownDistance) {
        return other.cursor.distance - ownDistance - (agent.length + other.length) * 0.5;
      }
    }

    let distanceToEntry = agent.cursor.remainingOnCurrent();
    for (const entry of agent.cursor.entries.slice(1)) {
      const futureBucket = buckets.get(entry.item.id) ?? [];
      const lead = futureBucket.find((other) => other !== agent && other.active);
      if (lead) {
        return distanceToEntry
          + lead.cursor.distance
          - (agent.length + lead.length) * 0.5;
      }
      distanceToEntry += entry.item.length;
    }
    return Infinity;
  };

  const horizontalDistanceToBus = (agent, busPoint) => Math.hypot(
    agent.outer.position.x - busPoint[0],
    agent.outer.position.z - busPoint[1],
  );

  const terminalNodeId = (agent) => {
    const item = agent.cursor?.current;
    if (item?.edge) return item.edge.to;
    if (item?.connector) {
      return runtime.edgeById.get(item.connector.to)?.from ?? item.connector.node;
    }
    return null;
  };

  const endReason = (agent) => runtime.sinkNodeIds.has(terminalNodeId(agent)) ? "sink" : "blocked";

  return {
    agents,
    stats,
    update(dt, busS, busPos, busV, busHeading = 0, busLat = laneCenterAt(busS)) {
      simulationTime += dt;
      const bus = busPose(busS, busPos, busV, busHeading, busLat);
      const busPoint = [bus.x, bus.z];

      // 初回だけ、現在の自車位置を基準に全エッジへ初期配置する。
      if (!initialSeeded) {
        trafficSpawner.seedInitial(busPoint, tryActivate);
        initialSeeded = true;
      }
      trafficSpawner.update(dt, busPoint, countActive(), tryActivate);
      const buckets = buildPathBuckets();
      let blockedTails = 0;

      for (const agent of agents) {
        if (!agent.active || !agent.cursor?.current) continue;
        const hasHorizon = agent.cursor.ensureHorizon(Math.max(40, agent.v * 4));

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
        if (res.ended) {
          deactivate(agent, endReason(agent));
          continue;
        }

        place(agent);
        const busDistance = horizontalDistanceToBus(agent, busPoint);
        if (busDistance > CFG.traffic.spawn.despawnRadius) {
          deactivate(agent, "radius");
          continue;
        }
        if (agent.v < 0.05 && busDistance >= 200) agent.stuckTime += dt;
        else agent.stuckTime = 0;
        if (agent.stuckTime >= 120) {
          deactivate(agent, "stuck");
          continue;
        }
        if (!hasHorizon) blockedTails++;

        if (collisionCooldown <= 0 && orientedBoxesOverlap(agentPose(agent), bus)) {
          collisionCooldown = 4;
          events.onCollision?.();
        }
      }
      stats.blockedTails = blockedTails;
      stats.active = countActive();
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
        if (!agent.active) continue;
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
