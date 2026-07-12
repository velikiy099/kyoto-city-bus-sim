import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CFG } from "../config.js";
import { lambertize } from "../util/lambertize.js";
import { createDestinationDisplay } from "../bus/destinationDisplay.js";
import {
  route,
  elevationAt,
  surfaceElevationAt,
  gradeAt,
  lanesAt,
  halfWidthAt,
  laneCenterAt,
  speedLimitAt,
  fwdLanesAt,
  backLanesAt,
  leftWidthAt,
  rightWidthAt,
} from "../route/routeData.js";
import { RoutePath } from "../route/path.js";
import { terrainHeightAtWorld, roadHeightAtWorld } from "./declarative/continuousTerrain.js";

const mat = (color) => new THREE.MeshLambertMaterial({ color });
const signalMat = (color) => new THREE.MeshBasicMaterial({ color });

function makeCylinderBetween(a, b, radius, color) {
  const start = new THREE.Vector3(...a);
  const end = new THREE.Vector3(...b);
  const delta = end.clone().sub(start);
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, delta.length(), 8),
    mat(color),
  );
  mesh.position.copy(start.add(end).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    delta.normalize(),
  );
  return mesh;
}

// ===== 交通車両(Blender製 glb)を共有ロードし、クローンで量産 =====
const loader = new GLTFLoader();
let vehicleLib = null; // vehicles.glb: 'Sedan' / 'Truck'
let busLib = null; // bus.glb: 対向バス(自車と同型)
const pendingVehicle = [];
const pendingBus = [];
loader.load("models/vehicles.glb", (gltf) => {
  lambertize(gltf.scene);
  vehicleLib = gltf.scene;
  for (const fill of pendingVehicle.splice(0)) fill();
});
loader.load("models/bus.glb", (gltf) => {
  lambertize(gltf.scene);
  busLib = gltf.scene;
  for (const fill of pendingBus.splice(0)) fill();
});

/** glbノードをクローンし、塗装マテリアル(paintName)だけ色替えして返す(非同期充填) */
function makeVehicle(nodeName, paintName, color) {
  const holder = new THREE.Group();
  const fill = () => {
    const node = vehicleLib.getObjectByName(nodeName).clone(true);
    node.position.set(0, 0, 0);
    const paint = new THREE.MeshLambertMaterial({ color });
    node.traverse((o) => {
      if (o.isMesh && o.material.name === paintName) o.material = paint;
    });
    holder.add(node);
  };
  if (vehicleLib) fill();
  else pendingVehicle.push(fill);
  return holder;
}

/** 対向車のモデル(セダン、前方=+z) */
const makeCar = (color) => makeVehicle("Sedan", "CarPaint", color);

/** トラック(キャブオーバー+箱荷台、前方=+z) */
const makeTruck = (cabColor) => makeVehicle("Truck", "TruckCab", cabColor);

/** 対向の路線バス(京都市バス18号系統の北行き便の想定、前方=+z) */
function makeOncomingBus() {
  const holder = new THREE.Group();
  const destinationDisplay = createDestinationDisplay("oncoming");
  const fill = () => {
    const node = busLib.clone(true);
    // bus.glb は原点=後軸中心なので車体中心を holder 原点へ
    node.position.set(0, 0, -(CFG.bus.length / 2 - CFG.bus.rearOverhang));
    holder.add(node);
    // 方向幕: 対向車「大宮通 / 四条大宮・二条駅 / Nijo Sta. Via Shijo Omiya」。
    const tex = destinationDisplay.texture;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.36),
      new THREE.MeshBasicMaterial({ map: tex }),
    );
    const sf = node.getObjectByName("SignFront");
    if (sf?.geometry) {
      sf.geometry.computeBoundingBox();
      const b = sf.geometry.boundingBox;
      sign.position.set(
        (b.min.x + b.max.x) / 2,
        (b.min.y + b.max.y) / 2,
        b.max.z + 0.003,
      );
    } else {
      sign.position.set(
        0,
        2.79,
        CFG.bus.length - CFG.bus.rearOverhang + 0.028,
      );
    }
    node.add(sign);
  };
  if (busLib) fill();
  else pendingBus.push(fill);
  return holder;
}

// ===== 旋回(2次ベジェ)ユーティリティ: T字路合流・対向車の左折で共有 =====
// スナップせず弧長ベースで position/heading を連続的に算出することで、旋回時のカクつきを防ぐ。
function buildTurnArc(start, ctrl, end, steps = 16) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push([
      mt * mt * start[0] + 2 * mt * t * ctrl[0] + t * t * end[0],
      mt * mt * start[1] + 2 * mt * t * ctrl[1] + t * t * end[1],
    ]);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(
      cum[i - 1] +
        Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]),
    );
  }
  return { pts, cum, length: cum.at(-1) || 1e-6 };
}
/** u: 0..1(走行済み弧長の割合)→ {x, z, heading} */
function sampleTurnArc(arc, u) {
  const target = Math.max(0, Math.min(1, u)) * arc.length;
  let i = 0;
  while (i < arc.cum.length - 2 && arc.cum[i + 1] < target) i++;
  const segLen = arc.cum[i + 1] - arc.cum[i] || 1e-6;
  const t = (target - arc.cum[i]) / segLen;
  const [ax, az] = arc.pts[i],
    [bx, bz] = arc.pts[i + 1];
  const dx = bx - ax,
    dz = bz - az;
  return { x: ax + dx * t, z: az + dz * t, heading: Math.atan2(dx, dz) };
}


// ===== 共通走行ダイナミクス =====
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 信号の基準点は交差点中心。NPCはそこから9m手前を停止線とし、
// 車体前端が停止線の3.2m手前に来るように停止する。自車のsは後軸中心なので、
// 同じ前端位置になるよう、バスでは後軸から前端までの長さも差し引く。
const SIGNAL_STOP_LINE_OFFSET = 9;
const SIGNAL_STOP_GAP = 3.2;
const BUS_FRONT_OFFSET = CFG.bus.length - CFG.bus.rearOverhang;
const signalStopLineS = (signalS, dir = 1) => signalS - SIGNAL_STOP_LINE_OFFSET * dir;
const busSignalStopTargetS = (signalS, dir = 1) =>
  signalStopLineS(signalS, dir) - dir * (BUS_FRONT_OFFSET + SIGNAL_STOP_GAP);

/** IDM(知的運転者モデル)に近い追従加速度。前車との速度差を考慮し、
 * 単純な距離比例制御で起きていた急制動・速度振動を抑える。 */
function idmAcceleration(speed, desiredSpeed, gap = Infinity, leadSpeed = desiredSpeed, options = {}) {
  const acceleration = options.acceleration ?? 1.25;
  const comfortableBrake = options.comfortableBrake ?? 2.0;
  const minimumGap = options.minimumGap ?? 3.2;
  const timeHeadway = options.timeHeadway ?? 1.35;
  const target = Math.max(0.5, desiredSpeed);
  const freeRoad = 1 - Math.pow(speed / target, 4);
  if (!Number.isFinite(gap)) return acceleration * freeRoad;
  const closingSpeed = speed - Math.max(0, leadSpeed);
  const dynamicGap = minimumGap + Math.max(
    0,
    speed * timeHeadway + (speed * closingSpeed) / (2 * Math.sqrt(acceleration * comfortableBrake)),
  );
  const interaction = Math.pow(dynamicGap / Math.max(0.5, gap), 2);
  return clamp(acceleration * (freeRoad - interaction), -5.0, acceleration);
}

function setSurfacePose(vehicle, x, z, heading, heightAt, yOffset = 0.04) {
  const y = heightAt(x, z) + yOffset;
  vehicle.outer.position.set(x, y, z);
  vehicle.outer.rotation.y = heading;
  const look = 2.4;
  const dx = Math.sin(heading) * look;
  const dz = Math.cos(heading) * look;
  const backY = heightAt(x - dx, z - dz);
  const frontY = heightAt(x + dx, z + dz);
  vehicle.inner.rotation.x = -Math.atan2(frontY - backY, look * 2);
}

function setRoadPose(vehicle, x, z, heading, yOffset = 0.04) {
  setSurfacePose(vehicle, x, z, heading, roadHeightAtWorld, yOffset);
}

/** Main-route vehicles already know their route distance `s`.  Use that value
 * directly instead of finding the nearest sampled road again from x/z.  The
 * latter is ambiguous where roads run close together or cross at different
 * levels, and could place a vehicle on the terrain below an elevated road. */
function setRoutePose(vehicle, s, x, z, heading, dir = 1, yOffset = 0.04) {
  vehicle.outer.position.set(x, surfaceElevationAt(s, x, z) + yOffset, z);
  vehicle.outer.rotation.y = heading;
  vehicle.inner.rotation.x = -Math.atan(gradeAt(s) * dir);
}

function setGroundRoadPose(vehicle, x, z, heading, yOffset = 0.04) {
  setSurfacePose(vehicle, x, z, heading, terrainHeightAtWorld, yOffset);
}

function setFeederRoadPose(vehicle, x, z, heading, yOffset = 0.04) {
  // 小枝橋西行き車線橋のような経路外の橋は別RoutePathを持つため、
  // 地表面ではなく本線の共有道路標高へ投影する。
  const heightAt = vehicle.road?.name?.includes("橋")
    ? roadHeightAtWorld
    : terrainHeightAtWorld;
  setSurfacePose(vehicle, x, z, heading, heightAt, yOffset);
}

function orientedBoxesOverlap(a, b) {
  // Use the actual vertical overlap. The previous extra 0.35m tolerance made
  // vehicles on a nearby bridge/underpass count as collisions even when their
  // visible bodies were separated.
  if (Math.abs((a.y ?? 0) - (b.y ?? 0)) >= ((a.height ?? 2) + (b.height ?? 2)) * 0.5) return false;
  const axes = [
    [Math.sin(a.heading), Math.cos(a.heading)],
    [Math.cos(a.heading), -Math.sin(a.heading)],
    [Math.sin(b.heading), Math.cos(b.heading)],
    [Math.cos(b.heading), -Math.sin(b.heading)],
  ];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const cornersRadius = (box, axis) => {
    const f = [Math.sin(box.heading), Math.cos(box.heading)];
    const r = [Math.cos(box.heading), -Math.sin(box.heading)];
    return Math.abs(axis[0] * f[0] + axis[1] * f[1]) * box.halfLength
      + Math.abs(axis[0] * r[0] + axis[1] * r[1]) * box.halfWidth;
  };
  for (const axis of axes) {
    const centerDistance = Math.abs(dx * axis[0] + dz * axis[1]);
    if (centerDistance > cornersRadius(a, axis) + cornersRadius(b, axis)) return false;
  }
  return true;
}

const stopS = (name) => route.stops.find((st) => st.name === name)?.s ?? null;

function fallbackSignalPositions(path) {
  const SIG_STOPS = [
    "四条大宮",
    "大宮五条",
    "七条大宮・京都水族館前",
    "九条大宮",
    "千本十条",
    "城南宮道",
  ];
  return SIG_STOPS.map((name) => {
    const s0 = stopS(name);
    return s0 == null ? null : { s: s0 + 32, name };
  }).filter((sig) => sig && sig.s <= path.length - 30);
}

/**
 * Map-compiled traffic.  Every non-player vehicle follows one directed OSM
 * lane edge or a precompiled turn connector; runtime never synthesizes a
 * cross-street stub or moves a car across a median.
 */
function buildGraphTraffic(scene, path, events, signalTools) {
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

/**
 * 交通(対向車・同方向の同行車)と交差点信号(各方向の灯器+連動)。
 * update(dt, busS, busPos, busV) を毎ステップ呼ぶ。
 * events: { onCollision(), onRedLight() }
 */
export function buildTraffic(scene, path, events = {}) {
  const g = new THREE.Group();
  scene.add(g);
  const trafficPaths = events.trafficPaths ?? [];
  // Cross-street traffic must come from compiled lane paths/connectors. The
  // old straight-line intersection stubs are available only as an explicit
  // fallback for legacy maps and are never inferred from an intersection box.
  const allowSyntheticIntersectionTraffic = events.allowSyntheticIntersectionTraffic === true;
  const mainTrafficLanes = trafficPaths
    .filter((item) => item.role === "main" && item.points?.length >= 2)
    .map((item) => ({
      ...item,
      path: new RoutePath(item.points, 2, item.distances),
    }));

  function mainLane(direction, laneIndex = 0) {
    const candidates = mainTrafficLanes
      .filter((item) => item.direction === direction)
      .sort((a, b) => a.lane - b.lane);
    if (!candidates.length) return null;
    return candidates.find((item) => item.lane === laneIndex)
      ?? candidates.at(-1);
  }

  function mainLanePose(s, direction, laneIndex = 0) {
    if (direction < 0 && backLanesAt(s) === 0) return null;
    const lane = mainLane(direction, laneIndex);
    if (!lane) return null;
    const location = lane.path._locate(s);
    const lateralA = lane.laterals?.[location.i] ?? 0;
    const lateralB = lane.laterals?.[location.i + 1] ?? lateralA;
    const [x, z] = lane.path.getPoint(s);
    const [tx, tz] = lane.path.getTangent(s);
    return {
      x,
      z,
      tx,
      tz,
      lateral: lateralA + (lateralB - lateralA) * location.t,
    };
  }

  // ================= 信号 =================
  // 位相: 自道 青22→黄3→赤17 / 交差道は自道が赤の間に 全赤1→青14→黄2(交差点内で連動)
  const CYCLE = 42,
    GREEN = 22,
    YELLOW = 3;
  const mainStateOf = (ph) =>
    ph < GREEN ? "green" : ph < GREEN + YELLOW ? "yellow" : "red";
  const crossStateOf = (ph) =>
    ph >= GREEN + YELLOW + 1 && ph < CYCLE - 2
      ? "green"
      : ph >= CYCLE - 2
        ? "yellow"
        : "red";

  const OFF = { green: 0x1c3a24, yellow: 0x4a3d14, red: 0x451818 };
  const ON = { green: 0x2ee86a, yellow: 0xffd23c, red: 0xff4433 };

  const lampGeo = new THREE.SphereGeometry(0.28, 12, 8);
  const housingGeo = new THREE.BoxGeometry(2.25, 0.75, 0.38);
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.09, 5.4, 6);

  /** 横型3灯の灯器。faceHeading 方向に進む車から見える(-z面)。左=青・右=赤(日本式) */
  function makeHead(x, y, z, faceHeading, withHoods = false) {
    const housing = new THREE.Mesh(housingGeo, signalMat(0x23282d));
    housing.position.set(x, y, z);
    housing.rotation.y = faceHeading;
    g.add(housing);
    const lamps = {};
    for (const [key, lx] of [
      ["green", 0.72],
      ["yellow", 0],
      ["red", -0.72],
    ]) {
      const lamp = new THREE.Mesh(lampGeo, signalMat(OFF[key]));
      lamp.position.set(lx, 0, -0.24);
      housing.add(lamp);
      lamps[key] = lamp;
      if (withHoods) {
        const hood = new THREE.Mesh(
          new THREE.CylinderGeometry(0.34, 0.34, 0.12, 16, 1, true),
          signalMat(0x11161a),
        );
        hood.rotation.x = Math.PI / 2;
        hood.position.set(lx, 0, -0.2);
        housing.add(hood);
      }
    }
    return lamps;
  }

  function paintHead(lamps, st) {
    lamps.green.material.color.setHex(st === "green" ? ON.green : OFF.green);
    lamps.yellow.material.color.setHex(
      st === "yellow" ? ON.yellow : OFF.yellow,
    );
    lamps.red.material.color.setHex(st === "red" ? ON.red : OFF.red);
  }

  const signals = [];
  const signalDefs = route.signals?.length
    ? route.signals
    : fallbackSignalPositions(path);
  /** 柱を立て、必要ならアームを渡し、灯器を付ける */
  let activeSignalElevation = 0;
  function buildHead(h) {
    const pole = new THREE.Mesh(poleGeo, mat(0x8a8f94));
    pole.position.set(h.pole[0], activeSignalElevation + 2.7, h.pole[1]);
    g.add(pole);
    if (h.arm)
      g.add(
        makeCylinderBetween(
          [h.pole[0], activeSignalElevation + 5.1, h.pole[1]],
          [h.head[0], activeSignalElevation + 5.1, h.head[1]],
          0.06,
          0x8a8f94,
        ),
      );
    return makeHead(h.head[0], activeSignalElevation + 4.85, h.head[1], h.face, !!h.hoods);
  }

  for (const def of signalDefs) {
    const s = def.s;
    if (s > path.length - 30) continue;
    activeSignalElevation = elevationAt(s);
    const mainHeads = [];
    const crossHeads = [];

    if (def.heads?.length) {
      // 設置座標はビルド時に計算済み(route18.json)。ここでは置くだけ
      for (const h of def.heads)
        (h.kind === "cross" ? crossHeads : mainHeads).push(buildHead(h));
    } else {
      // フォールバック(--fallback データ等で heads がない場合): ルート接線基準の簡易配置
      const [px, pz] = path.getPoint(s);
      const [tx, tz] = path.getTangent(s);
      const nx = -tz,
        nz = tx; // lateral 正(右)方向
      const HW = halfWidthAt(s);
      const theta = Math.atan2(tx, tz);
      const at = (lat, ahead) => [
        px + nx * lat + tx * ahead,
        pz + nz * lat + tz * ahead,
      ];
      mainHeads.push(
        buildHead({
          pole: at(-(HW + 1.7), -5.2),
          head: at(laneCenterAt(s) - 0.2, -5.2),
          face: theta,
          arm: 1,
          hoods: 1,
        }),
      );
      mainHeads.push(
        buildHead({
          pole: at(HW + 1.7, 5.2),
          head: at(-laneCenterAt(s) + 0.2, 5.2),
          face: theta + Math.PI,
          arm: 1,
        }),
      );
      const ch = theta + Math.PI / 2;
      const cd = [Math.sin(ch), Math.cos(ch)];
      for (const dir of [1, -1]) {
        const ax = px - cd[0] * dir * (HW + 2.2) + cd[1] * dir * 4.0;
        const az = pz - cd[1] * dir * (HW + 2.2) - cd[0] * dir * 4.0;
        crossHeads.push(
          buildHead({
            pole: [ax, az],
            head: [ax + cd[0] * dir * 0.6, az + cd[1] * dir * 0.6],
            face: dir === 1 ? ch : ch + Math.PI,
          }),
        );
      }
    }

    signals.push({
      s,
      phase: Math.random() * CYCLE,
      mainHeads,
      crossHeads,
      state: null,
      crossState: null,
    });
  }

  // 交差点内を同時に相反する流入が占有しないよう、交差交通が進入した間だけ
  // 短い予約を保持する。信号切替直後の「まだ交差点内にいる車」も保護できる。
  let simulationTime = 0;
  const intersectionReservations = new Map();
  const reservationKey = (sig) => Math.round(sig.s * 10) / 10;
  function activeReservation(sig) {
    const key = reservationKey(sig);
    const item = intersectionReservations.get(key);
    if (item && item.until > simulationTime) return item;
    if (item) intersectionReservations.delete(key);
    return null;
  }
  function reserveIntersection(sig, owner, seconds = 4.5) {
    const key = reservationKey(sig);
    const current = activeReservation(sig);
    if (current && current.owner !== owner) return false;
    intersectionReservations.set(key, { owner, until: simulationTime + seconds });
    return true;
  }
  function releaseIntersection(sig, owner) {
    const key = reservationKey(sig);
    const current = intersectionReservations.get(key);
    if (current?.owner === owner) intersectionReservations.delete(key);
  }

  /** 進行方向 dir(+1/-1)の車が s 位置・速度 v で従うべき停止線までの距離(なければ null) */
  function redDistAhead(s, dir, v) {
    let best = null;
    for (const sig of signals) {
      const line = signalStopLineS(sig.s, dir);
      const d = (line - s) * dir;
      if (d < -2 || d > 90) continue;
      const reservedByCross = activeReservation(sig)?.owner?.startsWith("cross-");
      if (sig.state === "green" && !reservedByCross) continue;
      const brakeDist = (v * v) / (2 * 2.6);
      if (d < brakeDist - 4) continue;
      // 黄信号: 停止線まで余裕があれば止まらない(yellow→stopは行わない)
      if (sig.state === "yellow" && d > brakeDist + YELLOW * 3) continue;
      if (best == null || d < best) best = d;
    }
    return best;
  }

  // The compiled OSM graph is the runtime source for all NPCs, including
  // off-route roads. The bus still uses its canonical main lane path for
  // physics, while NPC geometry is snapped to the same PLATEAU road surfaces.
  if (events.useTrafficGraph && events.trafficGraph?.edges?.length) {
    return buildGraphTraffic(scene, path, events, { signals, paintHead });
  }

  /** 交差点(自ルート外)を横切る他車が、交差道路の入り口で停止すべき残距離(なければ null) */
  function crossRedDist(cc) {
    const reserved = activeReservation(cc.sig);
    if (cc.sig.crossState === "green" && (!reserved || reserved.owner === cc.id)) return null;
    const ix = cc.ix;
    // off=0=中心。車両は端(entryOff)の手前で停止。entryOffの符号は dir=1→-、dir=-1→+
    const entryOff = ((ix.width ?? 8) / 2 + 5) * cc.dir * -1;
    // off は dir=1 で増加、dir=-1 で減少するため、dir を掛けて「進行方向基準の残距離」に揃える
    const distToEntry = cc.dir * (entryOff - cc.off); // 正=未到達, 負=通過済み

    if (distToEntry < -2) return null; // 既に停止線を通過済み
    const brakeDist = (cc.v * cc.v) / (2 * 2.6);
    if (distToEntry > Math.max(brakeDist + 4, 20)) return null; // まだ反応する距離ではない

    return distToEntry;
  }

  // ================= 車両 =================
  /** dir: +1=同方向(道路左側) / -1=対向(右側)。laneIdx: 0=センター寄り, 1=外側 */
  function laneLat(s, dir, laneIdx = 0) {
    return mainLanePose(s, dir, laneIdx)?.lateral ?? null;
  }

  // 二条駅前ロータリー(急カーブ・狭隘)には一般車を入れない
  const TRAFFIC_MIN_S = 360;

  // 分岐・離脱先は route.intersections の実在する道路腕から動的に選択する。

  // 右左折交差点の交錯ゾーン(近接ターンは連結: 狭隘路のS字ジョグ等)
  const turnZones = [];
  for (const t of route.turnIntersections ?? []) {
    const last = turnZones.at(-1);
    if (last && t.sIn - last.to < 45) last.to = Math.max(last.to, t.sOut);
    else turnZones.push({ from: t.sIn, to: t.sOut });
  }

  const ONCOMING_BASE = [
    { make: () => makeCar(0xd8dde2), hitR: 2.0, vMax: 11 },
    { make: () => makeCar(0x7a1f24), hitR: 2.0, vMax: 11.5 },
    { make: () => makeTruck(0x2e5e8c), hitR: 2.35, vMax: 10 },
    { make: () => makeCar(0x30343a), hitR: 2.0, vMax: 11 },
    { make: () => makeOncomingBus(), hitR: 2.8, vMax: 9.5 },
    { make: () => makeCar(0x274a72), hitR: 2.0, vMax: 12 },
    { make: () => makeTruck(0x8c8f6a), hitR: 2.35, vMax: 9.5 },
    { make: () => makeCar(0x9aa3ab), hitR: 2.0, vMax: 11 },
    { make: () => makeCar(0xc8c0a8), hitR: 2.0, vMax: 10.5 },
    { make: () => makeCar(0x5b2231), hitR: 2.0, vMax: 11.5 },
    { make: () => makeTruck(0xd8d8d2), hitR: 2.35, vMax: 10 },
    { make: () => makeCar(0x6f8091), hitR: 2.0, vMax: 12 },
  ];
  const SAME_BASE = [
    { make: () => makeCar(0xe2e4e6), hitR: 2.0, vMax: 11 },
    { make: () => makeCar(0x3f5e48), hitR: 2.0, vMax: 10.5 },
    { make: () => makeTruck(0x7d8288), hitR: 2.35, vMax: 9.5 },
    { make: () => makeCar(0x243a5e), hitR: 2.0, vMax: 11.5 },
    { make: () => makeCar(0xcfc4a2), hitR: 2.0, vMax: 10.5 },
    { make: () => makeTruck(0x8c3a2e), hitR: 2.35, vMax: 9.5 },
  ];
  // 片側2車線以上の区間では対向車・同行車を5倍の体感密度にするため、車種バリエーションを
  // 使い回しつつプールを拡張する(リスポーン位置は多車線区間へ寄せる。1車線区間は従来並み)。
  const DENSITY_FACTOR = 5;
  const expandDefs = (base) =>
    Array.from(
      { length: base.length * DENSITY_FACTOR },
      (_, i) => base[i % base.length],
    );
  const ONCOMING_DEFS = expandDefs(ONCOMING_BASE);
  const SAME_DEFS = expandDefs(SAME_BASE);

  // sBase 付近(±searchRange)で片側2車線以上の区間があればそこへ寄せたsを返す
  function nearMultiLane(sBase, searchRange = 500, step = 25) {
    const qualifies = (s) =>
      s >= 0 && s <= path.length && fwdLanesAt(s) >= 2 && backLanesAt(s) >= 2;
    if (qualifies(sBase)) return sBase;
    for (let d = step; d <= searchRange; d += step) {
      if (qualifies(sBase + d)) return sBase + d;
      if (qualifies(sBase - d)) return sBase - d;
    }
    return sBase; // 近傍に多車線区間が無ければそのまま(1車線区間は疎らな密度を維持)
  }

  let trafficSerial = 0;
  const dimensionsFor = (def) => def.hitR >= 2.7
    ? { length: 11.4, width: 2.45, height: 3.2 }
    : def.hitR >= 2.3
      ? { length: 6.6, width: 2.15, height: 2.8 }
      : { length: 4.5, width: 1.82, height: 1.8 };

  const cars = [];
  ONCOMING_DEFS.forEach((def, i) => {
    const sBase = ((i + 1) / (ONCOMING_DEFS.length + 1)) * path.length;
    cars.push(spawnCar(def, -1, nearMultiLane(sBase), i % 2));
  });
  SAME_DEFS.forEach((def, i) => {
    // 自車(始発)の前方に並べる。走行中はリスポーンで前後に維持される
    // lane-0 is the canonical same-direction lane shared with the bus path.
    cars.push(spawnCar(def, 1, nearMultiLane(400 + i * 180), 0));
  });

  function spawnCar(def, dir, s, laneIdx) {
    const inner = def.make();
    const outer = new THREE.Group();
    outer.add(inner);
    g.add(outer);
    const dimensions = dimensionsFor(def);
    return {
      id: `main-${trafficSerial++}`,
      outer,
      inner,
      dir,
      laneIdx,
      desiredLane: laneIdx,
      laneChangeCooldown: 1 + Math.random() * 4,
      hitR: def.hitR,
      length: dimensions.length,
      width: dimensions.width,
      height: dimensions.height,
      vMax: def.vMax,
      s: Math.max(360, Math.min(path.length - 15, s)),
      v: 6,
      latCur: null,
      reservationKey: null,
      exitPlan: null,
    };
  }

  // 地蔵前南側の北行き一方通行路。南端から北へ進み、地蔵前交差点を抜けて
  // 本線の北行き車線へ合流させる。B=0の南行き本線に対向車を無理に置かない。
  const feederPaths = trafficPaths
    .filter((road) => ["merge", "local"].includes(road.role) && road.points?.length >= 2)
    .map((road) => ({ ...road, path: new RoutePath(road.points) }));
  const feederCars = [];
  let feederSerial = 0;
  const feederPosition = (c) => {
    const [x, z] = c.path.getPoint(c.s);
    const [tx, tz] = c.path.getTangent(c.s);
    setFeederRoadPose(c, x, z, Math.atan2(tx, tz));
  };
  const spawnFeederCar = (road, offset = 0) => {
    const def = ONCOMING_BASE[feederSerial++ % ONCOMING_BASE.length];
    const inner = def.make();
    const outer = new THREE.Group();
    outer.add(inner);
    g.add(outer);
    const dimensions = dimensionsFor(def);
    const c = {
      id: `feeder-${trafficSerial++}`,
      road,
      path: road.path,
      outer,
      inner,
      s: Math.max(4, Math.min(road.path.length - 18, 18 + offset)),
      v: 7,
      vMax: def.vMax,
      hitR: def.hitR,
      length: dimensions.length,
      width: dimensions.width,
      height: dimensions.height,
      mergeArc: null,
      mergeT: 0,
      waitingForGap: false,
    };
    feederPosition(c);
    feederCars.push(c);
  };
  for (const road of feederPaths) {
    spawnFeederCar(road, 0);
    spawnFeederCar(road, 52);
  }

  // ================= 交差点(自ルート外の交差道路)を横切る他車 =================
  // route.intersections(信号との対応)を利用し、交差する道路上にも信号に従う他車を走らせる。
  // 交差道路自体の実ジオメトリは持たないため、交差点中心(path.getPoint(ix.s))を基準に
  // ix.heading 方向の直線上を走らせる簡易表現(スタブ道路の長さの範囲内)。
  // ix.arms(実在・車線・歩行者専用)を見て、四差路は従来どおり直進往復(mode:'through')、
  // 片側しか実在しないT字路はその腕から本線へ左右どちらかへ旋回合流させる(mode:'tstub')。
  // 実在しない腕・歩行者専用の腕には他車を生成しない。
  const CROSS_DEFS = [
    { make: () => makeCar(0xb9bec4), hitR: 2.0 },
    { make: () => makeCar(0x5b3a3a), hitR: 2.0 },
    { make: () => makeTruck(0x7d8288), hitR: 2.35 },
    { make: () => makeCar(0x33465e), hitR: 2.0 },
    { make: () => makeCar(0xc8c0a8), hitR: 2.0 },
  ];
  const crossCars = [];
  function spawnCrossCar(ix, sig, dir, mode, arm) {
    const def = CROSS_DEFS[crossCars.length % CROSS_DEFS.length];
    const inner = def.make();
    const outer = new THREE.Group();
    outer.add(inner);
    g.add(outer);
    const vMax = 7 + Math.random() * 3;
    const dimensions = dimensionsFor(def);
    if (mode === "tstub") {
      // 腕(side)の外側寄りに出現し、中心(本線)へ向かって進む(進行方向は常に中心向き)
      const armLen = Math.max(24, arm.length ?? 60);
      const off =
        arm.side *
        (Math.max(20, armLen * 0.35) + Math.random() * (armLen * 0.5));
      return {
        id: `cross-${trafficSerial++}`,
        ix,
        sig,
        dir: -arm.side,
        mode,
        arm,
        off,
        v: 6,
        vMax,
        hitR: def.hitR,
        length: dimensions.length,
        width: dimensions.width,
        height: dimensions.height,
        phase: "approach",
        turnT: 0,
        turnArc: null,
        outer,
        inner,
      };
    }
    const range = Math.max(16, Math.min(60, (ix.length ?? 40) / 2 - 4));
    return {
      id: `cross-${trafficSerial++}`,
      ix,
      sig,
      dir,
      mode: "through",
      range,
      off: (Math.random() * 1.6 - 0.8) * range,
      v: 6,
      vMax,
      hitR: def.hitR,
      length: dimensions.length,
      width: dimensions.width,
      height: dimensions.height,
      outer,
      inner,
    };
  }
  if (allowSyntheticIntersectionTraffic) for (const sig of signals) {
    let nearestIx = null,
      bestD = 28;
    for (const ix of route.intersections ?? []) {
      const d = Math.abs(ix.s - sig.s);
      if (d < bestD) {
        bestD = d;
        nearestIx = ix;
      }
    }
    if (!nearestIx) continue;
    const armPos = nearestIx.arms?.find((a) => a.side === 1);
    const armNeg = nearestIx.arms?.find((a) => a.side === -1);
    const bothThrough =
      armPos?.exists &&
      !armPos.pedestrian &&
      armNeg?.exists &&
      !armNeg.pedestrian;
    if (!nearestIx.arms?.length || bothThrough) {
      // 従来どおり(四差路、または腕情報がない旧データへのフォールバック): 直進往復
      crossCars.push(spawnCrossCar(nearestIx, sig, 1, "through"));
      crossCars.push(spawnCrossCar(nearestIx, sig, -1, "through"));
    } else {
      // T字路: 実在し、かつ車道(非歩行者専用)の腕だけに他車を生成し、本線へ旋回合流させる
      for (const arm of [armPos, armNeg]) {
        if (!arm?.exists || arm.pedestrian) continue;
        crossCars.push(spawnCrossCar(nearestIx, sig, arm.side, "tstub", arm));
      }
    }
  }

  let collisionCooldown = 0;
  let lastBusS = 0;

  // Keep the collision hull just inside the visible body. This prevents a
  // near-miss between lane neighbors from being scored as contact while still
  // leaving a small safety allowance for mirrors and model rounding.
  const COLLISION_LENGTH_SHRINK = 0.18;
  const COLLISION_WIDTH_SHRINK = 0.12;

  const busPoseFrom = (busS, busPos, busV, busHeading, busLat) => ({
    x: busPos[0],
    z: busPos[1],
    y: busPos[2] ?? elevationAt(busS) + 1.35,
    heading: busHeading,
    halfLength: (11.5 - COLLISION_LENGTH_SHRINK) * 0.5,
    halfWidth: (2.5 - COLLISION_WIDTH_SHRINK) * 0.5,
    height: 3.0,
    speed: busV,
    s: busS,
    lat: busLat,
  });

  function vehiclePose(vehicle) {
    const length = Math.max(0.5, (vehicle.length ?? 4.5) - COLLISION_LENGTH_SHRINK);
    const width = Math.max(0.5, (vehicle.width ?? 1.8) - COLLISION_WIDTH_SHRINK);
    return {
      x: vehicle.outer.position.x,
      z: vehicle.outer.position.z,
      y: vehicle.outer.position.y + (vehicle.height ?? 2) * 0.5,
      heading: vehicle.outer.rotation.y,
      halfLength: length * 0.5,
      halfWidth: width * 0.5,
      height: vehicle.height ?? 2,
    };
  }

  function checkBusCollision(vehicle, busPose) {
    if (collisionCooldown > 0) return;
    if (orientedBoxesOverlap(vehiclePose(vehicle), busPose)) {
      collisionCooldown = 4;
      events.onCollision?.();
    }
  }

  function laneIndexAt(vehicle) {
    return vehicle.desiredLane ?? vehicle.laneIdx ?? 0;
  }

  function laneNeighbors(s, dir, laneIdx, exclude, busPose) {
    let lead = null;
    let trail = null;
    const targetLat = laneLat(s, dir, laneIdx);
    if (targetLat == null) return { lead, trail };
    const consider = (otherS, otherSpeed, otherLength, otherLat, ref) => {
      if (Math.abs(otherLat - targetLat) > 1.85) return;
      const longitudinal = (otherS - s) * dir;
      const item = {
        gap: Math.abs(longitudinal) - ((exclude?.length ?? 4.5) + otherLength) * 0.5,
        speed: otherSpeed,
        ref,
      };
      if (longitudinal > 0) {
        if (!lead || item.gap < lead.gap) lead = item;
      } else if (longitudinal < 0) {
        if (!trail || item.gap < trail.gap) trail = item;
      }
    };
    for (const other of cars) {
      if (other === exclude || other.dir !== dir || other.turnArc) continue;
      consider(
        other.s,
        other.v,
        other.length ?? 4.5,
        other.latCur ?? laneLat(other.s, dir, laneIndexAt(other)) ?? 0,
        other,
      );
    }
    if (dir === 1 && busPose) {
      consider(busPose.s, busPose.speed, 11.4, busPose.lat, busPose);
    }
    return { lead, trail };
  }

  function canMergeIntoLane(s, dir, laneIdx, speed, busPose, exclude = null) {
    const { lead, trail } = laneNeighbors(s, dir, laneIdx, exclude, busPose);
    const frontNeed = Math.max(12, speed * 1.45);
    const rearNeed = Math.max(10, (trail?.speed ?? speed) * 1.25);
    return (!lead || lead.gap > frontNeed) && (!trail || trail.gap > rearNeed);
  }

  function chooseLane(vehicle, busPose, dt) {
    vehicle.laneChangeCooldown = Math.max(0, (vehicle.laneChangeCooldown ?? 0) - dt);
    const count = vehicle.dir === 1 ? fwdLanesAt(vehicle.s) : backLanesAt(vehicle.s);
    if (count <= 1) {
      vehicle.desiredLane = 0;
      return;
    }
    const current = clamp(laneIndexAt(vehicle), 0, count - 1);
    vehicle.desiredLane = current;
    if (vehicle.laneChangeCooldown > 0) return;
    const currentLead = laneNeighbors(vehicle.s, vehicle.dir, current, vehicle, busPose).lead;
    if (!currentLead || currentLead.gap > Math.max(32, vehicle.v * 2.4)) return;
    let bestLane = current;
    let bestGap = currentLead.gap;
    for (const candidate of [current - 1, current + 1]) {
      if (candidate < 0 || candidate >= count) continue;
      const neighbors = laneNeighbors(vehicle.s, vehicle.dir, candidate, vehicle, busPose);
      const frontGap = neighbors.lead?.gap ?? Infinity;
      if (
        frontGap > bestGap + 12 &&
        canMergeIntoLane(vehicle.s, vehicle.dir, candidate, vehicle.v, busPose, vehicle)
      ) {
        bestLane = candidate;
        bestGap = frontGap;
      }
    }
    if (bestLane !== current) {
      vehicle.desiredLane = bestLane;
      vehicle.laneIdx = bestLane;
      vehicle.laneChangeCooldown = 5 + Math.random() * 4;
    } else {
      vehicle.laneChangeCooldown = 2 + Math.random() * 2;
    }
  }

  const driveableArms = (ix) => (ix.arms ?? []).filter((arm) => arm?.exists && !arm.pedestrian);

  function assignExitPlan(vehicle) {
    vehicle.exitPlan = null;
    if (!allowSyntheticIntersectionTraffic) return;
    if (Math.random() > 0.32) return;
    const candidates = (route.intersections ?? []).filter((ix) => {
      const ahead = (ix.s - vehicle.s) * vehicle.dir;
      return ahead > 180 && ahead < 1250 && driveableArms(ix).length > 0;
    });
    if (!candidates.length) return;
    const ix = candidates[Math.floor(Math.random() * Math.min(candidates.length, 8))];
    const arms = driveableArms(ix);
    const arm = arms[Math.floor(Math.random() * arms.length)];
    vehicle.exitPlan = { ix, arm, triggered: false };
  }

  function beginNetworkExit(vehicle) {
    const plan = vehicle.exitPlan;
    if (!plan || plan.triggered) return false;
    const distance = (plan.ix.s - vehicle.s) * vehicle.dir;
    if (distance < -3 || distance > 8) return false;
    const side = plan.arm.side || (Math.random() < 0.5 ? -1 : 1);
    const [cx, cz] = path.getPoint(plan.ix.s);
    const hx = Math.sin(plan.ix.heading);
    const hz = Math.cos(plan.ix.heading);
    const exitDistance = Math.max(24, Math.min(70, (plan.arm.length ?? 55) * 0.65));
    const end = [cx + hx * side * exitDistance, cz + hz * side * exitDistance];
    const start = [vehicle.outer.position.x, vehicle.outer.position.z];
    const startHeading = vehicle.outer.rotation.y;
    const ctrl = [
      start[0] + Math.sin(startHeading) * 13,
      start[1] + Math.cos(startHeading) * 13,
    ];
    vehicle.turnArc = buildTurnArc(start, ctrl, end, 24);
    vehicle.turnT = 0;
    plan.triggered = true;
    return true;
  }

  function respawnMainCar(vehicle, busS) {
    vehicle.turnArc = null;
    vehicle.turnT = 0;
    vehicle.reservationKey = null;
    if (vehicle.dir === 1) {
      const offset = Math.random() < 0.35
        ? -(220 + Math.random() * 420)
        : 320 + Math.random() * 1050;
      vehicle.s = nearMultiLane(
        clamp(busS + offset, TRAFFIC_MIN_S, path.length - 20),
        350,
      );
    } else {
      let candidate = nearMultiLane(
        clamp(busS + 450 + Math.random() * 1300, TRAFFIC_MIN_S, path.length - 20),
        350,
      );
      for (let k = 0; k < 50 && backLanesAt(candidate) === 0; k++) {
        candidate = clamp(candidate + 50, TRAFFIC_MIN_S, path.length - 20);
      }
      if (backLanesAt(candidate) === 0) candidate = clamp(busS - 450, TRAFFIC_MIN_S, path.length - 20);
      vehicle.s = candidate;
    }
    vehicle.v = 5 + Math.random() * 2;
    vehicle.laneIdx = 0;
    vehicle.desiredLane = 0;
    vehicle.latCur = null;
    vehicle.laneChangeCooldown = 2 + Math.random() * 4;
    assignExitPlan(vehicle);
  }

  for (const vehicle of cars) assignExitPlan(vehicle);

  function updateFeederCars(dt, busPose) {
    for (let i = feederCars.length - 1; i >= 0; i--) {
      const c = feederCars[i];
      if (c.mergeArc) {
        const accel = idmAcceleration(c.v, Math.min(c.vMax, 8));
        c.v = clamp(c.v + accel * dt, 0, c.vMax);
        c.mergeT += (c.v * dt) / c.mergeArc.length;
        if (c.mergeT >= 1) {
          const mergeS = c.mergeS;
          const merged = {
            id: `main-${trafficSerial++}`,
            outer: c.outer,
            inner: c.inner,
            dir: c.mergeDir,
            laneIdx: 0,
            desiredLane: 0,
            laneChangeCooldown: 4,
            hitR: c.hitR,
            length: c.length,
            width: c.width,
            height: c.height,
            vMax: c.vMax,
            s: mergeS,
            v: c.v,
            latCur: c.mergeLat,
            reservationKey: null,
            exitPlan: null,
            turnArc: null,
            turnT: 0,
          };
          assignExitPlan(merged);
          cars.push(merged);
          feederCars.splice(i, 1);
          continue;
        }
        const sample = sampleTurnArc(c.mergeArc, c.mergeT);
        setRoadPose(c, sample.x, sample.z, sample.heading);
        checkBusCollision(c, busPose);
        continue;
      }

      let leadGap = Infinity;
      let leadSpeed = c.vMax;
      for (const other of feederCars) {
        if (other === c || other.road !== c.road || other.mergeArc) continue;
        const gap = other.s - c.s - ((c.length + other.length) * 0.5);
        if (gap > 0 && gap < leadGap) {
          leadGap = gap;
          leadSpeed = other.v;
        }
      }
      const mergeDir = c.road.mergeDir ?? -1;
      const joinsMainRoute = c.road.role === "merge";
      const mergeS = clamp(
        (c.road.mergeS ?? path.closestS(c.road.points.at(-1)).s) - 18 * mergeDir,
        20,
        path.length - 20,
      );
      const remaining = c.path.length - 18 - c.s;
      const mergeSafe = joinsMainRoute && canMergeIntoLane(mergeS, mergeDir, 0, c.v, busPose);
      if (!joinsMainRoute) {
        const desired = Math.min(c.vMax, 8);
        const accel = idmAcceleration(c.v, desired, leadGap, leadSpeed, { timeHeadway: 1.5 });
        c.v = clamp(c.v + accel * dt, 0, desired);
        c.s += c.v * dt;
        if (c.s >= c.path.length - 4) c.s = Math.min(18, Math.max(4, c.path.length * 0.25));
        const [x, z] = c.path.getPoint(c.s);
        const [tx, tz] = c.path.getTangent(c.s);
        setFeederRoadPose(c, x, z, Math.atan2(tx, tz));
        checkBusCollision(c, busPose);
        continue;
      }
      if (!mergeSafe && remaining < leadGap) {
        leadGap = Math.max(0, remaining);
        leadSpeed = 0;
        c.waitingForGap = true;
      } else {
        c.waitingForGap = false;
      }
      const desired = Math.min(c.vMax, 8);
      const accel = idmAcceleration(c.v, desired, leadGap, leadSpeed, { timeHeadway: 1.5 });
      c.v = clamp(c.v + accel * dt, 0, desired);
      c.s = Math.min(c.path.length - 18, c.s + c.v * dt);

      if (remaining <= 0.35 && mergeSafe) {
        const [sx, sz] = c.path.getPoint(c.path.length - 1);
        const [ftx, ftz] = c.path.getTangent(c.path.length - 3);
        const mergeLat = laneLat(mergeS, mergeDir, 0) ?? 0;
        const [px, pz] = path.getPoint(mergeS);
        const [tx, tz] = path.getTangent(mergeS);
        const end = [px - tz * mergeLat, pz + tx * mergeLat];
        const ctrl = [sx + ftx * 13, sz + ftz * 13];
        c.mergeArc = buildTurnArc([sx, sz], ctrl, end, 24);
        c.mergeT = 0;
        c.mergeDir = mergeDir;
        c.mergeS = mergeS;
        c.mergeLat = mergeLat;
        continue;
      }
      const [x, z] = c.path.getPoint(c.s);
      const [tx, tz] = c.path.getTangent(c.s);
      setFeederRoadPose(c, x, z, Math.atan2(tx, tz));
      checkBusCollision(c, busPose);
    }
  }

  function updateSignalStates(dt, busS, busV) {
    for (const sig of signals) {
      sig.phase = (sig.phase + dt) % CYCLE;
      const state = mainStateOf(sig.phase);
      const crossState = crossStateOf(sig.phase);
      if (state !== sig.state) {
        sig.state = state;
        for (const head of sig.mainHeads) paintHead(head, state);
      }
      if (crossState !== sig.crossState) {
        sig.crossState = crossState;
        for (const head of sig.crossHeads) paintHead(head, crossState);
      }
      const lineS = signalStopLineS(sig.s);
      if (sig.state === "red" && lastBusS < lineS && busS >= lineS && busV > 1.5) {
        events.onRedLight?.();
      }
    }
    lastBusS = busS;
  }

  function mainIntersectionReservation(vehicle) {
    for (const sig of signals) {
      const relative = (sig.s - vehicle.s) * vehicle.dir;
      if (relative > -18 && relative < 18 && sig.state === "green") {
        reserveIntersection(sig, vehicle.id, 3.2);
        vehicle.reservationKey = reservationKey(sig);
        return;
      }
      if (vehicle.reservationKey === reservationKey(sig) && Math.abs(relative) > 28) {
        releaseIntersection(sig, vehicle.id);
        vehicle.reservationKey = null;
      }
    }
  }

  function updateMainCars(dt, busS, busPose) {
    for (let index = cars.length - 1; index >= 0; index--) {
      const c = cars[index];
      if (c.turnArc) {
        const accel = idmAcceleration(c.v, Math.min(c.vMax, 8));
        c.v = clamp(c.v + accel * dt, 0, c.vMax);
        c.turnT += (c.v * dt) / c.turnArc.length;
        if (c.turnT >= 1) {
          respawnMainCar(c, busS);
          continue;
        }
        const sample = sampleTurnArc(c.turnArc, c.turnT);
        setRoadPose(c, sample.x, sample.z, sample.heading);
        checkBusCollision(c, busPose);
        continue;
      }

      let lanePose = mainLanePose(c.s, c.dir, laneIndexAt(c));
      const invalidDirection = lanePose == null;

      chooseLane(c, busPose, dt);
      lanePose = mainLanePose(c.s, c.dir, laneIndexAt(c)) ?? lanePose;

      let desiredSpeed = Math.min(c.vMax, speedLimitAt(c.s) * 1.05);
      const curvature = Math.abs(path.curvatureAt(c.s));
      if (curvature > 1e-4) desiredSpeed = Math.min(desiredSpeed, Math.max(3.2, Math.sqrt(2.3 / curvature)));

      const neighbors = laneNeighbors(c.s, c.dir, laneIndexAt(c), c, busPose);
      let gap = neighbors.lead?.gap ?? Infinity;
      let leadSpeed = neighbors.lead?.speed ?? desiredSpeed;

      const redDistance = redDistAhead(c.s, c.dir, c.v);
      if (redDistance != null && redDistance - c.length * 0.5 < gap) {
        gap = Math.max(0, redDistance - c.length * 0.5);
        leadSpeed = 0;
      }

      if (c.dir === -1 && lanesAt(c.s) <= 2) {
        const meetingDistance = c.s - busS;
        if (meetingDistance > -14 && meetingDistance < 45) {
          desiredSpeed = Math.min(desiredSpeed, 5.5);
        }
        for (const zone of turnZones) {
          if (busS > zone.from - 35 && busS < zone.to + 25 && c.s > zone.to) {
            const d = c.s - (zone.to + 26);
            if (d < gap) {
              gap = Math.max(0, d - 1.5);
              leadSpeed = 0;
            }
            break;
          }
        }
      }

      const acceleration = idmAcceleration(c.v, desiredSpeed, gap, leadSpeed, {
        timeHeadway: c.length > 8 ? 1.8 : 1.35,
        minimumGap: c.length > 8 ? 4.5 : 3.0,
      });
      c.v = clamp(c.v + acceleration * dt, 0, desiredSpeed + 0.8);
      c.s += c.v * dt * c.dir;

      mainIntersectionReservation(c);
      if (beginNetworkExit(c)) continue;

      if (
        c.s < TRAFFIC_MIN_S ||
        c.s > path.length - 15 ||
        Math.abs(c.s - busS) > 1900 ||
        invalidDirection
      ) {
        respawnMainCar(c, busS);
        lanePose = mainLanePose(c.s, c.dir, laneIndexAt(c));
      }

      lanePose ??= mainLanePose(c.s, c.dir, 0);
      if (!lanePose) {
        respawnMainCar(c, busS);
        continue;
      }
      c.latCur = lanePose.lateral;
      setRoutePose(
        c,
        c.s,
        lanePose.x,
        lanePose.z,
        Math.atan2(lanePose.tx * c.dir, lanePose.tz * c.dir),
        c.dir,
      );
      checkBusCollision(c, busPose);
    }
  }

  function crossLead(cc) {
    let leadGap = Infinity;
    let leadSpeed = cc.vMax;
    for (const other of crossCars) {
      if (other === cc || other.ix !== cc.ix || other.dir !== cc.dir || other.phase === "turn") continue;
      const longitudinal = (other.off - cc.off) * cc.dir;
      const gap = longitudinal - ((cc.length + other.length) * 0.5);
      if (gap > 0 && gap < leadGap) {
        leadGap = gap;
        leadSpeed = other.v;
      }
    }
    return { gap: leadGap, speed: leadSpeed };
  }

  function startCrossMerge(cc, busPose) {
    const s0 = clamp(cc.ix.s, 0, path.length);
    if (cc.mergeDir == null) cc.mergeDir = Math.random() < 0.5 ? 1 : -1;
    const mergeDir = cc.mergeDir;
    const mergeS = clamp(s0 + mergeDir * 18, 30, path.length - 30);
    if (!canMergeIntoLane(mergeS, mergeDir, 0, cc.v, busPose)) return false;
    if (!reserveIntersection(cc.sig, cc.id, 5.5)) return false;
    const [px, pz] = path.getPoint(s0);
    const hx = Math.sin(cc.ix.heading);
    const hz = Math.cos(cc.ix.heading);
    const laneOffset = 2.6 * (cc.dir > 0 ? 1 : -1);
    const start = [px + hx * cc.off + hz * laneOffset, pz + hz * cc.off - hx * laneOffset];
    const startHeading = cc.dir > 0 ? cc.ix.heading : cc.ix.heading + Math.PI;
    const mergeLat = laneLat(mergeS, mergeDir, 0) ?? 0;
    const [mpx, mpz] = path.getPoint(mergeS);
    const [mtx, mtz] = path.getTangent(mergeS);
    const end = [mpx - mtz * mergeLat, mpz + mtx * mergeLat];
    const ctrl = [start[0] + Math.sin(startHeading) * 12, start[1] + Math.cos(startHeading) * 12];
    cc.turnArc = buildTurnArc(start, ctrl, end, 24);
    cc.turnT = 0;
    cc.phase = "turn";
    cc.mergeS = mergeS;
    cc.mergeLat = mergeLat;
    return true;
  }

  function updateCrossCars(dt, busPose) {
    for (let index = crossCars.length - 1; index >= 0; index--) {
      const cc = crossCars[index];
      if (cc.phase === "turn") {
        const accel = idmAcceleration(cc.v, Math.min(cc.vMax, 7.5));
        cc.v = clamp(cc.v + accel * dt, 0, cc.vMax);
        cc.turnT += (cc.v * dt) / cc.turnArc.length;
        if (cc.turnT >= 1) {
          releaseIntersection(cc.sig, cc.id);
          const merged = {
            id: `main-${trafficSerial++}`,
            outer: cc.outer,
            inner: cc.inner,
            dir: cc.mergeDir,
            laneIdx: 0,
            desiredLane: 0,
            laneChangeCooldown: 4,
            hitR: cc.hitR,
            length: cc.length,
            width: cc.width,
            height: cc.height,
            vMax: cc.vMax,
            s: cc.mergeS,
            v: cc.v,
            latCur: cc.mergeLat,
            reservationKey: null,
            exitPlan: null,
            turnArc: null,
            turnT: 0,
          };
          assignExitPlan(merged);
          cars.push(merged);
          crossCars.splice(index, 1);
          continue;
        }
        const sample = sampleTurnArc(cc.turnArc, cc.turnT);
        setRoadPose(cc, sample.x, sample.z, sample.heading);
        checkBusCollision(cc, busPose);
        continue;
      }

      const lead = crossLead(cc);
      let gap = lead.gap;
      let leadSpeed = lead.speed;
      const redDistance = crossRedDist(cc);
      if (redDistance != null && redDistance - cc.length * 0.5 < gap) {
        gap = Math.max(0, redDistance - cc.length * 0.5);
        leadSpeed = 0;
      }

      if (cc.mode === "tstub") {
        const edge = (cc.ix.width ?? 8) / 2 + 3;
        const distanceToMerge = Math.abs(cc.off) - edge;
        if (distanceToMerge <= 0.35) {
          if (startCrossMerge(cc, busPose)) continue;
          gap = Math.min(gap, Math.max(0, distanceToMerge));
          leadSpeed = 0;
        }
      }

      if (cc.mode === "through") {
        const entry = ((cc.ix.width ?? 8) / 2 + 5) * cc.dir * -1;
        const distanceToEntry = cc.dir * (entry - cc.off);
        if (distanceToEntry > -2 && distanceToEntry < 8 && cc.sig.crossState === "green") {
          if (!reserveIntersection(cc.sig, cc.id, 4.5)) {
            gap = Math.min(gap, Math.max(0, distanceToEntry));
            leadSpeed = 0;
          }
        }
      }

      const accel = idmAcceleration(cc.v, cc.vMax, gap, leadSpeed, { timeHeadway: 1.45 });
      cc.v = clamp(cc.v + accel * dt, 0, cc.vMax);
      cc.off += cc.v * dt * cc.dir;

      if (cc.mode === "through" && (cc.off > cc.range || cc.off < -cc.range)) {
        releaseIntersection(cc.sig, cc.id);
        cc.off = -Math.sign(cc.dir) * cc.range;
        cc.v = 4.5 + Math.random() * 2;
      }

      const s = clamp(cc.ix.s, 0, path.length);
      const [px, pz] = path.getPoint(s);
      const hx = Math.sin(cc.ix.heading);
      const hz = Math.cos(cc.ix.heading);
      const laneOffset = 2.6 * (cc.dir > 0 ? 1 : -1);
      const x = px + hx * cc.off + hz * laneOffset;
      const z = pz + hz * cc.off - hx * laneOffset;
      const heading = cc.dir > 0 ? cc.ix.heading : cc.ix.heading + Math.PI;
      setGroundRoadPose(cc, x, z, heading);
      checkBusCollision(cc, busPose);
    }
  }

  return {
    signals,
    update(dt, busS, busPos, busV, busHeading = 0, busLat = laneCenterAt(busS)) {
      simulationTime += dt;
      updateSignalStates(dt, busS, busV);
      const busPose = busPoseFrom(busS, busPos, busV, busHeading, busLat);
      updateFeederCars(dt, busPose);
      updateMainCars(dt, busS, busPose);
      updateCrossCars(dt, busPose);
      collisionCooldown = Math.max(0, collisionCooldown - dt);
    },
    /** autoDrive 用: 前方の同方向車(同一レーン近傍)までの実車間 [m](なければ null) */
    leadGapAhead(busS, busLat, maxDist = 80) {
      let best = null;
      for (const c of cars) {
        if (c.dir !== 1 || c.turnArc) continue;
        const gap = c.s - busS - (c.length + 11.4) * 0.5;
        if (gap > 0 && gap < maxDist && Math.abs((c.latCur ?? 0) - busLat) < 1.85) {
          if (best == null || gap < best) best = gap;
        }
      }
      return best;
    },
    /** 直近の信号情報(HUD 用) */
    nextSignal(busS) {
      let best = null;
      for (const sig of signals) {
        const d = sig.s - busS;
        if (d > -5 && (best == null || d < best.d)) best = { d, state: sig.state };
      }
      return best;
    },
    /** autoDrive 用: 前方の止まるべき信号の停止線 s(なければ null) */
    redStopTarget(busS, busV) {
      const d = redDistAhead(busS, 1, busV);
      return d == null ? null : busSignalStopTargetS(busS + d);
    },
  };
}
