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
import { NpcPhysics } from "./npcPhysics.js";
import { curveSpeedLimit, pedalsForAccel, steerInput } from "./npcDriver.js";
import { createSpawner } from "./spawner.js";

/**
 * コンパイル済みグラフ上を走る NPC エージェント群。
 * 遠方の車両はパスへスナップし、近傍の車両はキネマティック自転車で走行する。
 */
export function createTrafficAgents(scene, path, runtime, events = {}, signalsApi, spawner) {
  const group = new THREE.Group();
  scene.add(group);

  const defs = [
    { make: () => makeCar(0xd8dde2), length: 4.5, width: 1.82, height: 1.8, vMax: 11, physics: "car" },
    { make: () => makeCar(0x4e637b), length: 4.5, width: 1.82, height: 1.8, vMax: 10.5, physics: "car" },
    { make: () => makeTruck(0x7d8288), length: 6.6, width: 2.15, height: 2.8, vMax: 9.5, physics: "truck" },
    { make: () => makeCar(0x704044), length: 4.5, width: 1.82, height: 1.8, vMax: 11.5, physics: "car" },
    { make: () => makeCar(0x9aa3ab), length: 4.5, width: 1.82, height: 1.8, vMax: 10.5, physics: "car" },
  ];
  const trafficSpawner = spawner ?? createSpawner(runtime);
  const agents = [];
  const stats = {
    active: 0,
    spawned: 0,
    despawned: { sink: 0, blocked: 0, radius: 0, stuck: 0 },
    spawnPointCount: trafficSpawner.spawnPoints.length,
    blockedTails: 0,
    physicsCount: 0,
    visibleCount: 0,
    snapBacks: 0,
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
      lod: "simple",
      phys: null,
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

  const placePhysics = (agent) => {
    const pose = agent.cursor ? agent.cursor.pose() : null;
    if (!pose || !agent.phys) return false;
    agent.outer.position.set(agent.phys.x, pose.y + 0.04, agent.phys.z);
    agent.outer.rotation.y = agent.phys.heading;
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
    agent.lod = "simple";
    agent.phys = null;
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
    agent.lod = "simple";
    agent.phys = null;
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
        return {
          gap: other.cursor.distance - ownDistance - (agent.length + other.length) * 0.5,
          leadSpeed: other.v,
        };
      }
    }

    let distanceToEntry = agent.cursor.remainingOnCurrent();
    for (const entry of agent.cursor.entries.slice(1)) {
      const futureBucket = buckets.get(entry.item.id) ?? [];
      const lead = futureBucket.find((other) => other !== agent && other.active);
      if (lead) {
        return {
          gap: distanceToEntry
            + lead.cursor.distance
            - (agent.length + lead.length) * 0.5,
          leadSpeed: lead.v,
        };
      }
      distanceToEntry += entry.item.length;
    }
    return null;
  };

  const horizontalDistanceToBus = (agent, busPoint) => Math.hypot(
    agent.outer.position.x - busPoint[0],
    agent.outer.position.z - busPoint[1],
  );

  const promoteToPhysics = (agent) => {
    if (!agent.active || agent.lod === "physics" || !agent.cursor) return false;
    const pose = agent.cursor.pose();
    const params = CFG.traffic.physics[agent.physics] ?? CFG.traffic.physics.car;
    if (!pose || !params) return false;
    agent.phys = new NpcPhysics(params, pose.x, pose.z, pose.heading);
    agent.phys.v = agent.v;
    agent.lod = "physics";
    return true;
  };

  const demoteToSimple = (agent) => {
    if (agent.lod === "physics" && agent.phys) agent.v = agent.phys.v;
    agent.phys = null;
    agent.lod = "simple";
  };

  /** 自車との距離に応じて、近い車だけを物理LODへ昇格する。 */
  const updateLod = (busPoint) => {
    const physicsConfig = CFG.traffic.lod ?? {};
    const physicsRadius = Number(physicsConfig.physicsRadius);
    const simpleRadius = Number(physicsConfig.simpleRadius);
    const configuredCullRadius = Number(physicsConfig.cullRadius);
    const cullRadius = Number.isFinite(configuredCullRadius)
      ? Math.max(0, configuredCullRadius)
      : Infinity;
    const maxPhysics = Math.max(0, Math.floor(Number(physicsConfig.maxPhysicsVehicles) || 0));
    const ranked = agents
      .filter((agent) => agent.active && agent.cursor?.current)
      .map((agent) => ({ agent, distance: horizontalDistanceToBus(agent, busPoint) }))
      .sort((a, b) => a.distance - b.distance);

    for (const { agent, distance } of ranked) {
      agent.outer.visible = distance <= cullRadius;
      if (agent.lod === "physics" && !agent.phys) agent.lod = "simple";
      if (agent.lod === "physics" && agent.phys && distance > simpleRadius) {
        demoteToSimple(agent);
      }
    }

    const physicsAgents = ranked
      .filter(({ agent }) => agent.lod === "physics" && agent.phys)
      .sort((a, b) => b.distance - a.distance);
    while (physicsAgents.length > maxPhysics) {
      demoteToSimple(physicsAgents.shift().agent);
    }

    let physicsCount = ranked.reduce(
      (count, { agent }) => count + (agent.lod === "physics" && agent.phys ? 1 : 0),
      0,
    );
    for (const { agent, distance } of ranked) {
      if (physicsCount >= maxPhysics) break;
      if (agent.lod === "simple" && distance < physicsRadius && promoteToPhysics(agent)) {
        physicsCount++;
      }
    }
    stats.physicsCount = physicsCount;
    stats.visibleCount = ranked.reduce(
      (count, { agent }) => count + (agent.outer.visible ? 1 : 0),
      0,
    );
  };

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
      updateLod(busPoint);
      const buckets = buildPathBuckets();
      let blockedTails = 0;

      for (const agent of agents) {
        if (!agent.active || !agent.cursor?.current) continue;
        const isPhysics = agent.lod === "physics" && agent.phys;
        const speed = isPhysics ? agent.phys.v : agent.v;
        const hasHorizon = agent.cursor.ensureHorizon(Math.max(40, speed * 4));

        const current = agent.cursor.current;
        let gap = gapToLead(agent, buckets);
        let leadSpeed = gap?.leadSpeed ?? 0;
        let leadIsNpc = gap != null;
        gap = gap?.gap ?? Infinity;
        if (horizontalDistanceToBus(agent, busPoint) < 120) {
          const busProj = agent.cursor.projectPoint(bus.x, bus.z, 100);
          if (busProj && busProj.lateral < 2.2) {
            const fwd = [Math.sin(bus.heading), Math.cos(bus.heading)];
            const seg = [Math.sin(busProj.segmentHeading), Math.cos(busProj.segmentHeading)];
            if (fwd[0] * seg[0] + fwd[1] * seg[1] > 0.7) {
              const busGap = busProj.arcAhead - (agent.length + 11.4) * 0.5;
              if (busGap < gap) {
                gap = busGap;
                leadSpeed = Math.max(0, bus.speed);
                leadIsNpc = false;
              }
            }
          }
        }
        const node = current.edge ? runtime.nodeById.get(current.edge.to) : null;
        const remaining = agent.cursor.remainingOnCurrent();
        const approachHeading = runtime.edgeEndHeading.get(current.edge?.id) ?? 0;
        const stopForSignal = node?.signal
          && signalsApi.shouldNpcStop(node.id, approachHeading, simulationTime)
          && remaining < 22;
        const busyUntil = node ? junctionBusy.get(node.id) ?? 0 : 0;
        const stopForJunction = !node?.signal && busyUntil > simulationTime && remaining < 10;
        if (stopForSignal) {
          // remainingは車体基準点から信号ノードまでの距離。NPCの前端を
          // 停止線(ノードの9m手前)から安全車間だけ手前に置く。
          const stopGap = Math.max(0, remaining - agent.length * 0.5 - SIGNAL_STOP_LINE_OFFSET);
          if (stopGap < gap) {
            gap = stopGap;
            leadSpeed = 0;
            leadIsNpc = false;
          }
        } else if (stopForJunction) {
          const stopGap = Math.max(0, remaining - 3);
          if (stopGap < gap) {
            gap = stopGap;
            leadSpeed = 0;
            leadIsNpc = false;
          }
        }

        const desired = isPhysics
          ? Math.min(
            agent.vMax,
            current.edge?.speed ?? 8.5,
            curveSpeedLimit(agent.cursor, speed),
          )
          : Math.min(agent.vMax, current.edge?.speed ?? 8.5);
        let res;
        if (isPhysics) {
          const accel = idmAcceleration(
            agent.phys.v,
            desired,
            gap,
            gap < Infinity ? leadSpeed : desired,
            {
              minimumGap: CFG.traffic.driver.minGap ?? SIGNAL_STOP_GAP,
              timeHeadway: CFG.traffic.driver.headway ?? 1.35,
            },
          );
          const pedals = pedalsForAccel(agent.phys, accel);
          const steer = steerInput(agent.phys, agent.cursor);
          agent.phys.step(dt, { ...pedals, steer });
          const proj = agent.cursor.project(
            agent.phys.x,
            agent.phys.z,
            agent.phys.v * dt * 4 + 4,
            agent.phys.heading,
          );
          if (proj == null || proj.lateral > 3.0 || proj.headingErr > Math.PI / 3) {
            const pose = agent.cursor.pose();
            if (pose) {
              agent.phys.x = pose.x;
              agent.phys.z = pose.z;
              agent.phys.heading = pose.heading;
            }
            agent.phys.delta = 0;
            agent.phys.throttleState = 0;
            agent.phys.v *= 0.5;
            agent.v = agent.phys.v;
            stats.snapBacks++;
            place(agent);
            if (!hasHorizon) blockedTails++;
            continue;
          }
          agent.v = agent.phys.v;
          res = agent.cursor.advance(proj.deltaArc);
        } else {
          agent.v = clamp(
            agent.v + idmAcceleration(
              agent.v,
              desired,
              gap,
              gap < Infinity ? leadSpeed : desired,
              {
                minimumGap: CFG.traffic.driver.minGap ?? SIGNAL_STOP_GAP,
                timeHeadway: CFG.traffic.driver.headway ?? 1.35,
              },
            ) * dt,
            0,
            desired,
          );
          res = agent.cursor.advance(agent.v * dt);
        }
        if (res.enteredConnector) {
          junctionBusy.set(res.enteredConnector.node, simulationTime + 2.5);
        }
        if (res.ended) {
          deactivate(agent, endReason(agent));
          continue;
        }

        if (isPhysics) placePhysics(agent);
        else place(agent);
        const busDistance = horizontalDistanceToBus(agent, busPoint);
        const configuredCullRadius = Number(CFG.traffic.lod?.cullRadius);
        const cullRadius = Number.isFinite(configuredCullRadius)
          ? Math.max(0, configuredCullRadius)
          : Infinity;
        agent.outer.visible = busDistance <= cullRadius;
        if (busDistance > CFG.traffic.spawn.despawnRadius && !agent.outer.visible) {
          deactivate(agent, "radius");
          continue;
        }
        if (agent.v < 0.05 && !agent.outer.visible && leadIsNpc) agent.stuckTime += dt;
        else agent.stuckTime = 0;
        if (agent.stuckTime >= 90) {
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
      stats.physicsCount = agents.reduce(
        (count, agent) => count + (agent.active && agent.lod === "physics" && agent.phys ? 1 : 0),
        0,
      );
      stats.visibleCount = agents.reduce(
        (count, agent) => count + (agent.active && agent.outer.visible ? 1 : 0),
        0,
      );
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
