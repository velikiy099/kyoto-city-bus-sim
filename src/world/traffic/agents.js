import * as THREE from "three";
import { CFG } from "../../config.js";
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

const DEFAULT_NPC_VEHICLES = [
  { kind: "car", color: "#d8dde2", length: 4.5, width: 1.82, height: 1.8, vMax: 11, physics: "car" },
];

/**
 * コンパイル済みグラフ上を走る NPC エージェント群。
 * 遠方の車両はパスへスナップし、近傍の車両はキネマティック自転車で走行する。
 */
export function createTrafficAgents(scene, path, runtime, events = {}, signalsApi, spawner) {
  const world = events?.world ?? {};
  const elevationAt = world.elevationAt ?? (() => 0);
  const laneCenterAt = world.laneCenterAt ?? (() => 0);
  const vehicleSpecs =
    events?.npcVehicleDefs?.VEHICLES ??
    world.definitions?.npcVehicles?.VEHICLES ??
    DEFAULT_NPC_VEHICLES;

  const PHYSICS_CONNECTOR_APPROACH = 6;
  const wrapAngle = (angle) => {
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    return angle;
  };
  const group = new THREE.Group();
  scene.add(group);

  const vehicleFactories = { car: makeCar, truck: makeTruck };
  const defs = vehicleSpecs.map(({ kind, color, ...spec }) => ({
    make: () => vehicleFactories[kind](parseInt(color.slice(1), 16)),
    ...spec,
  }));
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
    visibleDespawned: { sink: 0, blocked: 0, radius: 0, stuck: 0 },
    visibleTerminalHolds: 0,
  };
  const maxVehicles = Math.max(0, Math.floor(CFG.traffic.maxVehicles));
  let serial = 0;
  let simulationTime = 0;
  let collisionCooldown = 0;
  let initialSeeded = false;
  let lastBusPoint = null;
  const junctionBusy = new Map();

  const countActive = () => agents.reduce((count, agent) => count + (agent.active ? 1 : 0), 0);
  const effectiveCullRadius = () => {
    const configured = Number(CFG.traffic.lod?.cullRadius);
    return Number.isFinite(configured) ? Math.max(0, configured) : Infinity;
  };

  const makeAgent = (index) => {
    const def = defs[index % defs.length];
    const physParams = CFG.traffic.physics[def.physics] ?? CFG.traffic.physics.car;
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
      wheelbase: physParams?.wheelbase ?? 2.7,
      maxSteerRad: ((physParams?.maxSteerDeg ?? 36) * Math.PI) / 180,
      steerSpeedFactor: physParams?.steerSpeedFactor ?? 7,
      active: false,
      cursor: null,
      v: 0,
      stuckTime: 0,
      terminalHolding: false,
      lod: "simple",
      phys: null,
      displayHeading: null,
      blendOffsetX: 0,
      blendOffsetZ: 0,
      yieldStuckTime: 0,
      yieldBypassUntil: 0,
    };
  };

  for (let i = 0; i < maxVehicles; i++) agents.push(makeAgent(i));

  const place = (agent, dt = 0) => {
    const pose = agent.cursor ? agent.cursor.pose() : null;
    if (!pose) return false;
    const decay = dt > 0 ? Math.exp(-dt * 8) : 0;
    agent.blendOffsetX *= decay;
    agent.blendOffsetZ *= decay;
    agent.outer.position.set(
      pose.x + agent.blendOffsetX,
      pose.y + 0.04,
      pose.z + agent.blendOffsetZ,
    );
    if (dt > 0 && agent.displayHeading != null) {
      if (agent.v > 0.05) {
        const dh = wrapAngle(pose.heading - agent.displayHeading);
        const effSteer = agent.maxSteerRad / (1 + agent.v / agent.steerSpeedFactor);
        const kinematicYaw = (agent.v / agent.wheelbase) * Math.tan(effSteer) * 1.15;
        const latCapYaw = 5.5 / Math.max(2.0, agent.v);
        const maxYawRate = Math.min(1.2, Math.max(0.25, kinematicYaw), latCapYaw);
        agent.displayHeading = wrapAngle(
          agent.displayHeading + clamp(dh, -maxYawRate * dt, maxYawRate * dt),
        );
      }
    } else {
      agent.displayHeading = pose.heading;
    }
    agent.outer.rotation.y = agent.displayHeading;
    agent.inner.rotation.x = pose.pitch;
    return true;
  };

  const placePhysics = (agent) => {
    const pose = agent.cursor ? agent.cursor.pose() : null;
    if (!pose || !agent.phys) return false;
    agent.outer.position.set(agent.phys.x, pose.y + 0.04, agent.phys.z);
    agent.displayHeading = agent.phys.heading;
    agent.blendOffsetX = 0;
    agent.blendOffsetZ = 0;
    agent.outer.rotation.y = agent.phys.heading;
    agent.inner.rotation.x = pose.pitch;
    return true;
  };

  /** 空間距離・高さ層・道路種別(車種制限)・信号状態を考慮して流入させる。 */
  const tryActivate = (startPath, startDistance = 3, initialSpeed = 5) => {
    if (!startPath?.id || !runtime.paths.has(startPath.id)) return false;
    const pose = runtime.sample(startPath, startDistance);
    if (!pose) return false;

    // 防御チェック: 自車バスの至近距離には発生させない
    if (lastBusPoint && Math.hypot(pose.x - lastBusPoint[0], pose.z - lastBusPoint[1]) < 50) {
      return false;
    }

    // 空間距離(2D + 高さ層)で他車との重なり・近接を防止する
    const spawnFwdX = Math.sin(pose.heading);
    const spawnFwdZ = Math.cos(pose.heading);
    const spawnY = pose.y + 0.04;
    const occupied = agents.some((other) => {
      if (!other.active) return false;
      if (Math.abs(other.outer.position.y - spawnY) >= 3.0) return false;
      const dist = Math.hypot(other.outer.position.x - pose.x, other.outer.position.z - pose.z);
      const sameEdge = other.cursor?.current?.id === startPath.id;
      const otherHeading = other.outer.rotation.y;
      const align = spawnFwdX * Math.sin(otherHeading) + spawnFwdZ * Math.cos(otherHeading);
      const minClearance = (sameEdge || align > 0.7) ? 22 : 12;
      return dist < minClearance;
    });
    if (occupied) return false;

    // 狭路(service/residential/unclassified等)にはトラックを割り当てない
    const truckBlocked = CFG.traffic.spawn.truckBlockedHighways ?? [];
    const disallowTruck = truckBlocked.includes(startPath.edge?.highway);
    const agent = agents.find(
      (candidate) => !candidate.active && (!disallowTruck || candidate.physics !== "truck"),
    );
    if (!agent) return false;

    const cursor = new RouteCursor(runtime, startPath, startDistance);
    const roadSpeed = Math.min(agent.vMax, startPath.edge?.speed ?? 8.5);
    let speed = Number.isFinite(initialSpeed)
      ? Math.min(roadSpeed * 0.85, Math.max(2, initialSpeed))
      : roadSpeed * 0.75;
    const toNode = startPath.edge ? runtime.nodeById.get(startPath.edge.to) : null;
    const remaining = Math.max(0, startPath.length - startDistance);
    const approachHeading = runtime.edgeEndHeading.get(startPath.edge?.id) ?? pose.heading;
    if (
      toNode?.signal
      && signalsApi.shouldNpcStop(toNode.id, approachHeading, simulationTime)
      && remaining < 30
    ) {
      const stopDist = Math.max(
        0,
        remaining - agent.length * 0.5 - SIGNAL_STOP_LINE_OFFSET - SIGNAL_STOP_GAP,
      );
      speed = Math.min(speed, Math.sqrt(2 * 1.5 * stopDist));
    }

    agent.cursor = cursor;
    agent.v = Math.max(0, speed);
    agent.stuckTime = 0;
    agent.terminalHolding = false;
    agent.lod = "simple";
    agent.phys = null;
    agent.displayHeading = null;
    agent.blendOffsetX = 0;
    agent.blendOffsetZ = 0;
    agent.yieldStuckTime = 0;
    agent.yieldBypassUntil = 0;
    if (!place(agent, 0)) {
      agent.cursor = null;
      agent.v = 0;
      return false;
    }
    agent.active = true;
    const cullRadius = effectiveCullRadius();
    agent.outer.visible = lastBusPoint
      ? horizontalDistanceToBus(agent, lastBusPoint) <= cullRadius
      : true;
    stats.spawned++;
    stats.active++;
    return true;
  };

  const deactivate = (agent, reason) => {
    if (!agent.active) return;
    if (agent.outer.visible && stats.visibleDespawned[reason] != null) {
      stats.visibleDespawned[reason]++;
    }
    agent.active = false;
    agent.cursor = null;
    agent.v = 0;
    agent.stuckTime = 0;
    agent.terminalHolding = false;
    agent.lod = "simple";
    agent.phys = null;
    agent.displayHeading = null;
    agent.blendOffsetX = 0;
    agent.blendOffsetZ = 0;
    agent.yieldStuckTime = 0;
    agent.yieldBypassUntil = 0;
    agent.outer.visible = false;
    if (stats.despawned[reason] != null) stats.despawned[reason]++;
    stats.active = countActive();
  };

  const busPose = (busS, busPos, busV, busHeading, busLat) => ({
    x: busPos[0],
    z: busPos[1],
    y: busPos[2] ?? elevationAt(busS) + 1.35,
    heading: busHeading,
    halfLength: CFG.bus.length * 0.5,
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

  const physicsPathClear = (agent) => Boolean(agent.cursor?.current?.edge)
    && agent.cursor.current.edge.physicsSafe !== false
    && agent.cursor.remainingOnCurrent() > PHYSICS_CONNECTOR_APPROACH;

  const promoteToPhysics = (agent) => {
    if (!agent.active || agent.lod === "physics" || !physicsPathClear(agent)) return false;
    const pose = agent.cursor.pose();
    const params = CFG.traffic.physics[agent.physics] ?? CFG.traffic.physics.car;
    if (!pose || !params) return false;
    if (
      agent.displayHeading != null
      && Math.abs(wrapAngle(pose.heading - agent.displayHeading)) > 0.12
    ) {
      return false;
    }
    if (Math.hypot(agent.blendOffsetX, agent.blendOffsetZ) > 0.3) return false;
    agent.phys = new NpcPhysics(
      params,
      pose.x + agent.blendOffsetX,
      pose.z + agent.blendOffsetZ,
      agent.displayHeading ?? pose.heading,
    );
    agent.phys.v = agent.v;
    agent.lod = "physics";
    return true;
  };

  const demoteToSimple = (agent) => {
    if (agent.lod === "physics" && agent.phys) {
      agent.v = agent.phys.v;
      const pose = agent.cursor?.pose();
      if (pose) {
        agent.blendOffsetX = clamp(agent.phys.x - pose.x, -3.5, 3.5);
        agent.blendOffsetZ = clamp(agent.phys.z - pose.z, -3.5, 3.5);
      }
      agent.displayHeading = agent.phys.heading;
    }
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
      // Junction connectors are compiled path geometry.  Keep agents exactly
      // on that geometry, then create a fresh physics state after they reach
      // the next edge instead of carrying steering error through the turn.
      if (agent.lod === "physics" && agent.cursor.current?.connector) {
        demoteToSimple(agent);
      }
      if (agent.lod === "physics" && !physicsPathClear(agent)) {
        demoteToSimple(agent);
      }
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
      if (agent.lod === "simple"
        && physicsPathClear(agent)
        && distance < physicsRadius
        && promoteToPhysics(agent)) {
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

  /** 可視台数が不足した際、指定距離以遠の非表示車両のうち最遠方の1台を解放する。 */
  const recycleFarthest = (minDist = CFG.traffic.spawn.recycleMinDist ?? 850) => {
    if (!lastBusPoint) return false;
    let farthest = null;
    let farthestDist = minDist;
    for (const agent of agents) {
      if (!agent.active || agent.outer.visible) continue;
      const dist = horizontalDistanceToBus(agent, lastBusPoint);
      if (dist > farthestDist) {
        farthestDist = dist;
        farthest = agent;
      }
    }
    if (!farthest) return false;
    deactivate(farthest, "radius");
    return true;
  };

  const findUpcomingRightTurn = (cursor, maxDist = 18) => {
    if (!cursor?.entries?.length) return null;
    let dist = 0;
    for (let i = 0; i < cursor.entries.length && dist < maxDist; i++) {
      const item = cursor.entries[i].item;
      if (i > 0 && dist > 0.5 && item.connector && item.connector.right) {
        return { connector: item.connector, distToEntry: dist };
      }
      dist += i === 0 ? cursor.remainingOnCurrent() : item.length;
    }
    return null;
  };

  const reset = () => {
    for (const agent of agents) {
      agent.active = false;
      agent.cursor = null;
      agent.v = 0;
      agent.stuckTime = 0;
      agent.terminalHolding = false;
      agent.lod = "simple";
      agent.phys = null;
      agent.displayHeading = null;
      agent.blendOffsetX = 0;
      agent.blendOffsetZ = 0;
      agent.yieldStuckTime = 0;
      agent.yieldBypassUntil = 0;
      agent.outer.visible = false;
    }
    junctionBusy.clear();
    collisionCooldown = 0;
    initialSeeded = false;
    lastBusPoint = null;
    stats.active = 0;
    stats.spawned = 0;
    stats.blockedTails = 0;
    stats.physicsCount = 0;
    stats.visibleCount = 0;
    stats.snapBacks = 0;
    stats.visibleTerminalHolds = 0;
    for (const key of Object.keys(stats.despawned)) stats.despawned[key] = 0;
    for (const key of Object.keys(stats.visibleDespawned)) stats.visibleDespawned[key] = 0;
    trafficSpawner.reset?.();
  };

  return {
    agents,
    stats,
    reset,
    update(dt, busS, busPos, busV, busHeading = 0, busLat = laneCenterAt(busS)) {
      simulationTime += dt;
      const bus = busPose(busS, busPos, busV, busHeading, busLat);
      const busPoint = [bus.x, bus.z];
      lastBusPoint = busPoint;

      // 初回だけ、現在の自車位置を基準に周辺エッジへ初期配置する。
      if (!initialSeeded) {
        trafficSpawner.seedInitial(busPoint, tryActivate);
        initialSeeded = true;
      }
      const cullRadiusNow = effectiveCullRadius();
      let visibleBeforeSpawn = 0;
      for (const agent of agents) {
        if (!agent.active) continue;
        const vis = horizontalDistanceToBus(agent, busPoint) <= cullRadiusNow;
        agent.outer.visible = vis;
        if (vis) visibleBeforeSpawn++;
      }
      trafficSpawner.update(dt, busPoint, countActive(), tryActivate, {
        visibleCount: visibleBeforeSpawn,
        recycleFarthest,
      });
      updateLod(busPoint);
      const buckets = buildPathBuckets();
      let blockedTails = 0;

      for (const agent of agents) {
        if (!agent.active || !agent.cursor?.current) continue;
        if (agent.lod === "physics" && !physicsPathClear(agent)) {
          demoteToSimple(agent);
        }
        const isPhysics = agent.lod === "physics" && agent.phys;
        const speed = isPhysics ? agent.phys.v : agent.v;
        const hasHorizon = agent.cursor.ensureHorizon(Math.max(40, speed * 4));

        const current = agent.cursor.current;
        let gap = gapToLead(agent, buckets);
        let leadSpeed = gap?.leadSpeed ?? 0;
        let leadIsNpc = gap != null;
        gap = gap?.gap ?? Infinity;
        let stoppedForSignalOrBus = false;
        let yieldingToCrossNpc = false;
        let blockingNpc = null;

        // 自車バスの前後端・中心・予測到達点を前方経路へ射影し、同方向・対向はみ出し・交差/右左折中のバスを回避する。
        if (horizontalDistanceToBus(agent, busPoint) < 80
          && Math.abs(agent.outer.position.y - (bus.y - 1.5)) < 3.0) {
          const inConnector = Boolean(current.connector);
          const fwd = [Math.sin(bus.heading), Math.cos(bus.heading)];
          const busPts = [
            { pt: [bus.x, bus.z], predictive: false },
            { pt: [bus.x + fwd[0] * 4.8, bus.z + fwd[1] * 4.8], predictive: false },
            { pt: [bus.x - fwd[0] * 4.8, bus.z - fwd[1] * 4.8], predictive: false },
          ];
          if (bus.speed > 2.0) {
            busPts.push(
              { pt: [bus.x + fwd[0] * (4.8 + bus.speed * 1.0), bus.z + fwd[1] * (4.8 + bus.speed * 1.0)], predictive: true },
              { pt: [bus.x + fwd[0] * (4.8 + bus.speed * 2.0), bus.z + fwd[1] * (4.8 + bus.speed * 2.0)], predictive: true },
            );
          }
          const oppClearance = 1.19 + agent.width * 0.5 + 0.35;
          for (const { pt: [bx, bz], predictive } of busPts) {
            const busProj = agent.cursor.projectPoint(bx, bz, 55);
            if (!busProj) continue;
            const seg = [Math.sin(busProj.segmentHeading), Math.cos(busProj.segmentHeading)];
            const dot = fwd[0] * seg[0] + fwd[1] * seg[1];
            if (!predictive && dot > 0.7) {
              if (busProj.lateral < 2.3) {
                const busGap = busProj.arcAhead - (agent.length + 2.5) * 0.5;
                if (busGap < gap) {
                  gap = busGap;
                  leadSpeed = Math.max(0, bus.speed);
                  leadIsNpc = false;
                  if (bus.speed < 0.5) stoppedForSignalOrBus = true;
                }
              }
            } else if (inConnector) {
              const connLookahead = Math.max(agent.length * 0.5 + 6.0, speed * 2.2 + agent.length * 0.5 + 3.0);
              if (busProj.arcAhead > 0.2 && busProj.arcAhead < connLookahead && busProj.lateral < (predictive ? 3.4 : 3.0)) {
                const busGap = Math.max(0, busProj.arcAhead - agent.length * 0.5 - 2.0);
                if (busGap < gap) {
                  gap = busGap;
                  leadSpeed = 0;
                  leadIsNpc = false;
                  stoppedForSignalOrBus = true;
                }
              }
            } else if (!predictive && dot < -0.7) {
              if (busProj.arcAhead > 0.5 && busProj.arcAhead < 28 && busProj.lateral < oppClearance) {
                const busGap = Math.max(0, busProj.arcAhead - agent.length * 0.5 - 5.0);
                if (busGap < gap) {
                  gap = busGap;
                  leadSpeed = 0;
                  leadIsNpc = false;
                  stoppedForSignalOrBus = true;
                }
              }
            } else if (Math.abs(dot) <= 0.7 && busProj.arcAhead > 0.5 && busProj.arcAhead < 32 && busProj.lateral < 3.6) {
              const busGap = Math.max(0, busProj.arcAhead - agent.length * 0.5 - 3.6);
              if (busGap < gap) {
                gap = busGap;
                leadSpeed = 0;
                leadIsNpc = false;
                stoppedForSignalOrBus = true;
              }
            }
          }

          // 対向車線から交差点へ右折進入する際、直進接近中の自車バスへ譲る(進入前のみ)。
          const busRightTurn = findUpcomingRightTurn(agent.cursor, 28);
          if (busRightTurn) {
            const rightNode = runtime.nodeById.get(busRightTurn.connector.node);
            if (rightNode?.point) {
              const ownFromEdge = runtime.edgeById.get(busRightTurn.connector.from);
              const ownApproachH = ownFromEdge
                ? (runtime.edgeEndHeading.get(ownFromEdge.id) ?? agent.outer.rotation.y)
                : agent.outer.rotation.y;
              const oppDot = fwd[0] * Math.sin(ownApproachH) + fwd[1] * Math.cos(ownApproachH);
              const busDistToNode = Math.hypot(bus.x - rightNode.point[0], bus.z - rightNode.point[1]);
              const busAheadTowardNode = (rightNode.point[0] - bus.x) * fwd[0]
                + (rightNode.point[1] - bus.z) * fwd[1];
              const busYieldDist = bus.speed < 0.3 ? 14 : Math.max(36, bus.speed * 4.0 + 16);
              if (oppDot < -0.5 && busDistToNode < busYieldDist && busAheadTowardNode > -6) {
                const yieldGap = Math.max(0, busRightTurn.distToEntry - agent.length * 0.5 - 1.5);
                if (yieldGap < gap) {
                  gap = yieldGap;
                  leadSpeed = 0;
                  leadIsNpc = false;
                  stoppedForSignalOrBus = true;
                }
              }
            }
          }
        }

        // 赤信号は先読み経路(最大55m先)まで確認し、停止線通過済みなら交差点内で急停止しない。
        // 分離帯内の短い接続辺(停止線未満の長さ)や右左折コネクタの先の直交信号では停止しない。
        let distAccum = 0;
        for (let ei = 0; ei < agent.cursor.entries.length && distAccum < 55; ei++) {
          const entryItem = agent.cursor.entries[ei].item;
          if (entryItem.connector?.turn) break;
          const itemRem = ei === 0 ? agent.cursor.remainingOnCurrent() : entryItem.length;
          const distToEnd = distAccum + itemRem;
          if (entryItem.edge && entryItem.edge.length >= SIGNAL_STOP_LINE_OFFSET + 3 && distToEnd < 55) {
            const sigNode = runtime.nodeById.get(entryItem.edge.to);
            if (sigNode?.signal) {
              const approachHeading = runtime.edgeEndHeading.get(entryItem.edge.id) ?? 0;
              if (signalsApi.shouldNpcStop(sigNode.id, approachHeading, simulationTime)) {
                const rawStopGap = distToEnd - agent.length * 0.5 - SIGNAL_STOP_LINE_OFFSET;
                if (rawStopGap >= -1.0) {
                  const stopGap = Math.max(0, rawStopGap);
                  if (stopGap < gap) {
                    gap = stopGap;
                    leadSpeed = 0;
                    leadIsNpc = false;
                    stoppedForSignalOrBus = true;
                  }
                  break;
                }
              }
            }
          }
          distAccum = distToEnd;
        }

        const node = current.edge ? runtime.nodeById.get(current.edge.to) : null;
        const remaining = agent.cursor.remainingOnCurrent();
        const busyUntil = node ? junctionBusy.get(node.id) ?? 0 : 0;
        if (!node?.signal && busyUntil > simulationTime && remaining < 10) {
          const stopGap = Math.max(0, remaining - 3);
          if (stopGap < gap) {
            gap = stopGap;
            leadSpeed = 0;
            leadIsNpc = false;
          }
        }
        if (!current.connector && node && !node.signal && node.point && remaining < 18
          && Math.abs(agent.outer.position.y - (bus.y - 1.5)) < 3.0) {
          const ownApproachH = runtime.edgeEndHeading.get(current.edge.id) ?? agent.outer.rotation.y;
          const busFwdX = Math.sin(bus.heading), busFwdZ = Math.cos(bus.heading);
          const crossDot = Math.abs(busFwdX * Math.sin(ownApproachH) + busFwdZ * Math.cos(ownApproachH));
          if (crossDot < 0.72) {
            const nodeDistToBus = Math.hypot(node.point[0] - bus.x, node.point[1] - bus.z);
            const busAheadTowardNode = (node.point[0] - bus.x) * busFwdX + (node.point[1] - bus.z) * busFwdZ;
            const holdDist = Math.max(28, bus.speed * 3.0 + 14);
            if (nodeDistToBus < holdDist && busAheadTowardNode > -8) {
              const holdGap = Math.max(0, remaining - agent.length * 0.5 - 1.5);
              if (holdGap < gap) {
                gap = holdGap;
                leadSpeed = 0;
                leadIsNpc = false;
                stoppedForSignalOrBus = true;
              }
            }
          }
        }

        // 他NPCとの交差点内交差回避・右直譲り合い
        const ownPose = agent.cursor.pose();
        if (simulationTime >= agent.yieldBypassUntil && ownPose) {
          const ownRightTurn = findUpcomingRightTurn(agent.cursor, 18);
          const ownFromEdge = ownRightTurn ? runtime.edgeById.get(ownRightTurn.connector.from) : null;
          const ownApproachH = ownFromEdge
            ? (runtime.edgeEndHeading.get(ownFromEdge.id) ?? ownPose.heading)
            : ownPose.heading;
          const rightNode = ownRightTurn ? runtime.nodeById.get(ownRightTurn.connector.node) : null;

          for (const other of agents) {
            if (other === agent || !other.active) continue;
            if (Math.abs(other.outer.position.y - agent.outer.position.y) >= 3.0) continue;
            const ox = other.outer.position.x, oz = other.outer.position.z;
            if (Math.hypot(ox - ownPose.x, oz - ownPose.z) > 28) continue;

            const proj = agent.cursor.projectPoint(ox, oz, 22);
            if (proj && proj.arcAhead > 0.5 && proj.lateral < (agent.width + other.width) * 0.58) {
              const otherH = other.outer.rotation.y;
              const dot = Math.sin(otherH) * Math.sin(proj.segmentHeading)
                + Math.cos(otherH) * Math.cos(proj.segmentHeading);
              const crossGap = Math.max(0, proj.arcAhead - (agent.length + other.length) * 0.55);
              if (crossGap < gap) {
                gap = crossGap;
                leadSpeed = dot > 0.5 ? other.v : 0;
                leadIsNpc = true;
                if (dot <= 0.5 || (other.cursor?.current?.id !== current.id && crossGap < 4.0)) {
                  yieldingToCrossNpc = true;
                  blockingNpc = other;
                }
              }
            }

            if (ownRightTurn && rightNode?.point) {
              const otherDistToNode = Math.hypot(ox - rightNode.point[0], oz - rightNode.point[1]);
              if (otherDistToNode < 22) {
                const otherH = other.outer.rotation.y;
                const oppDot = Math.sin(otherH) * Math.sin(ownApproachH)
                  + Math.cos(otherH) * Math.cos(ownApproachH);
                const otherRight = findUpcomingRightTurn(other.cursor, 18);
                if (oppDot < -0.5 && (!otherRight || otherRight.connector.node !== ownRightTurn.connector.node)) {
                  const yieldGap = Math.max(0, ownRightTurn.distToEntry - agent.length * 0.5 - 1.5);
                  if (yieldGap < gap) {
                    gap = yieldGap;
                    leadSpeed = 0;
                    leadIsNpc = true;
                    yieldingToCrossNpc = true;
                    blockingNpc = other;
                  }
                }
              }
            }
          }
        }

        if (yieldingToCrossNpc && !stoppedForSignalOrBus && speed < 0.15) {
          agent.yieldStuckTime += dt;
          const blockerSpeed = blockingNpc
            ? (blockingNpc.lod === "physics" && blockingNpc.phys ? blockingNpc.phys.v : blockingNpc.v)
            : 1;
          if (
            (agent.yieldStuckTime >= 2.5 && blockerSpeed < 0.15 && (!blockingNpc || agent.id < blockingNpc.id))
            || agent.yieldStuckTime >= 4.0
          ) {
            agent.yieldBypassUntil = simulationTime + 2.5;
            agent.yieldStuckTime = 0;
          }
        } else {
          agent.yieldStuckTime = 0;
        }

        const desired = Math.min(
          agent.vMax,
          current.edge?.speed ?? 8.5,
          curveSpeedLimit(agent.cursor, speed),
        );
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
            place(agent, dt);
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
          // Core routing makes this unreachable for normal agents.  Retain a
          // visible vehicle as a diagnostic-safe fallback; graph-boundary
          // despawn is permitted only after it leaves the culling radius.
          if (agent.outer.visible) {
            agent.v = 0;
            if (agent.phys) agent.phys.v = 0;
            if (!agent.terminalHolding) {
              agent.terminalHolding = true;
              stats.visibleTerminalHolds++;
            }
            place(agent, dt);
            if (!hasHorizon) blockedTails++;
            continue;
          }
          deactivate(agent, endReason(agent));
          continue;
        }

        if (agent.cursor.current?.connector && agent.lod === "physics") {
          demoteToSimple(agent);
        }
        if (agent.lod === "physics" && agent.phys) placePhysics(agent);
        else place(agent, dt);
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
     * autoDrive用: グラフ上のNPCのうち、本線上で自車と同方向・同車線に近い車両、
     * または前方交差点のコネクタ上で自車の進路を占有中の車両までの実車間を返す。
     */
    leadGapAhead(busS, busLat, maxDist = 80) {
      let best = null;
      const busY = elevationAt(busS);
      for (const agent of agents) {
        if (!agent.active) continue;
        const current = agent.cursor?.current;
        if (!current) continue;
        // 高架とアンダーパスのように平面上で近くても高さが違う道路を除外する。
        if (Math.abs(agent.outer.position.y - busY) > 2.5) continue;
        const projection = path.closestS(
          [agent.outer.position.x, agent.outer.position.z],
          busS,
          Math.max(150, maxDist + 50),
        );
        if (projection.s <= busS || projection.s - busS > maxDist || projection.dist > Math.max(9, Math.abs(busLat) + 5)) continue;
        const tangent = path.getTangent(projection.s);
        const heading = agent.outer.rotation.y;
        const forward = [Math.sin(heading), Math.cos(heading)];
        const dot = forward[0] * tangent[0] + forward[1] * tangent[1];
        const latDiff = Math.abs(projection.lateral - busLat);
        const sameLaneMatch = !current.connector && dot >= 0.8 && latDiff <= 2.5;
        const sinCross = Math.sqrt(Math.max(0, 1 - dot * dot));
        const occupyHalfW = 1.2 + Math.abs(dot) * (agent.width * 0.5) + sinCross * (agent.length * 0.5);
        const corridorOccupy = (projection.s - busS) < Math.min(maxDist, 45)
          && latDiff < occupyHalfW
          && !(dot < -0.75 && latDiff > 2.25);
        if (!sameLaneMatch && !corridorOccupy) continue;
        const npcHalfAlong = Math.abs(dot) * (agent.length * 0.5) + sinCross * (agent.width * 0.5);
        const rawGap = projection.s - busS - ((CFG.bus.length - CFG.bus.rearOverhang) + npcHalfAlong);
        if (rawGap > -2.5 && rawGap < maxDist) {
          const gap = Math.max(0, rawGap);
          if (best == null || gap < best) best = gap;
        }
      }
      return best;
    },
  };
}
