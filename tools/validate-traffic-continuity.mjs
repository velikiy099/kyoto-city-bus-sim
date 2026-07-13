#!/usr/bin/env node
import fs from "node:fs";
import { CFG } from "../src/config.js";
import { createGraphRuntime, RouteCursor } from "../src/world/traffic/graph.js";
import { createSpawner } from "../src/world/traffic/spawner.js";

const assert = (value, message) => { if (!value) throw new Error(message); };
const network = JSON.parse(fs.readFileSync("src/data/generated/driving-network.json", "utf8"));
const runtime = createGraphRuntime(network.trafficGraph);
const spawner = createSpawner(runtime);
const midpoint = network.nodes[Math.floor(network.nodes.length / 2)];
const busPoint = [midpoint.x, midpoint.z];
const cullRadius = Number(CFG.traffic.lod?.cullRadius) || 700;
const agents = [];
const despawned = { sink: 0, blocked: 0, radius: 0, stuck: 0 };
const visibleDespawned = { sink: 0, blocked: 0, radius: 0, stuck: 0 };
let seed = 0x18c0ffee;
const random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let value = seed;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};
const originalRandom = Math.random;
Math.random = random;

const tryActivate = (path, startDistance = 3, initialSpeed = 5) => {
  if (!path?.edge || !runtime.continuingEdgeIds.has(path.edge.id)) return false;
  if (agents.length >= CFG.traffic.maxVehicles) return false;
  if (agents.some((agent) => agent.cursor.current?.id === path.id
    && Math.abs(agent.cursor.distance - startDistance) < 20)) return false;
  const cursor = new RouteCursor(runtime, path, startDistance);
  if (!cursor.ensureHorizon(40)) return false;
  agents.push({ cursor, speed: Math.max(4, initialSpeed) });
  return true;
};

try {
  assert(runtime.continuingEdgeIds.size > 2000, "Continuing traffic core is unexpectedly small");
  assert([...runtime.continuingEdgeIds].every((edgeId) =>
    (runtime.connectorsByEdge.get(edgeId) ?? [])
      .some((connector) => runtime.continuingEdgeIds.has(connector.to))),
  "Continuing traffic core contains an edge without a core continuation");
  assert(runtime.spawnEdges.length > 0
    && runtime.spawnEdges.every((edge) => runtime.continuingEdgeIds.has(edge.id)),
  "Boundary spawn edges are not restricted to the continuing core");
  assert(spawner.eligibleEdgeIds.size > 0
    && [...spawner.eligibleEdgeIds].every((edgeId) => runtime.continuingEdgeIds.has(edgeId)),
  "Initial/refill eligible edges are not restricted to the continuing core");
  spawner.seedInitial(busPoint, tryActivate);
  const dt = 0.25;
  const duration = 600;
  let secondHalfActiveSum = 0;
  let secondHalfSamples = 0;
  let ended = 0;
  let blockedHorizons = 0;
  for (let step = 0; step < duration / dt; step++) {
    spawner.update(dt, busPoint, agents.length, tryActivate);
    for (let index = agents.length - 1; index >= 0; index--) {
      const agent = agents[index];
      if (!agent.cursor.ensureHorizon(40)) blockedHorizons++;
      const result = agent.cursor.advance(agent.speed * dt);
      if (!result.ended) continue;
      ended++;
      const pose = agent.cursor.pose();
      const visible = pose && Math.hypot(pose.x - busPoint[0], pose.z - busPoint[1]) <= cullRadius;
      const edge = agent.cursor.current?.edge;
      const reason = edge && runtime.sinkNodeIds.has(edge.to) ? "sink" : "blocked";
      despawned[reason]++;
      if (visible) visibleDespawned[reason]++;
      agents.splice(index, 1);
    }
    if (step * dt >= duration / 2) {
      secondHalfActiveSum += agents.length;
      secondHalfSamples++;
    }
  }
  const secondHalfAverageActive = secondHalfActiveSum / Math.max(1, secondHalfSamples);
  const visibleDespawnTotal = Object.values(visibleDespawned).reduce((sum, count) => sum + count, 0);
  assert(ended === 0 && blockedHorizons === 0, `Continuing traffic reached a graph terminal (ended=${ended}, blocked=${blockedHorizons})`);
  assert(visibleDespawnTotal === 0, `Traffic disappeared while visible (${JSON.stringify(visibleDespawned)})`);
  assert(secondHalfAverageActive >= 50, `Traffic floor regressed (${secondHalfAverageActive.toFixed(2)} active)`);
  console.log(JSON.stringify({
    status: "traffic-continuity-ok",
    duration,
    continuingEdges: runtime.continuingEdgeIds.size,
    terminalEdgesExcluded: runtime.edgeById.size - runtime.continuingEdgeIds.size,
    activeFinal: agents.length,
    secondHalfAverageActive: Number(secondHalfAverageActive.toFixed(3)),
    ended,
    blockedHorizons,
    despawned,
    visibleDespawned,
  }, null, 2));
} finally {
  Math.random = originalRandom;
}
