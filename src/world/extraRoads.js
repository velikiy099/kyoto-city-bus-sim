import * as THREE from "three";
import { CFG } from "../config.js";
import { route } from "../route/routeData.js";
import { terrainHeightAtWorld, roadHeightAtWorld } from "./declarative/continuousTerrain.js";

/**
 * 経路外のOSM実測道路。pointsはゲーム座標の折れ線で、各wayの実形状をそのまま描く。
 * 交差点スタブと端部を重ねないため、道路を矩形へ簡略化しない。
 */
const FALLBACK_ROADS = [
  {
    id: 621847402,
    name: "小枝橋西行き車線橋",
    points: [
      [62.6, 2596.5],
      [29.0, 2602.5],
      [-69.4, 2618.8],
    ],
    width: 7.0,
    lanes: 2,
    oneway: true,
    direction: "westbound",
  },
];

function polylineRibbon(points, from, to, y, heightAt = terrainHeightAtWorld) {
  const positions = [];
  const indices = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const [x, z] = points[i];
    const fromX = x + nx * from;
    const fromZ = z + nz * from;
    const toX = x + nx * to;
    const toZ = z + nz * to;
    positions.push(fromX, heightAt(fromX, fromZ) + y, fromZ);
    positions.push(toX, heightAt(toX, toZ) + y, toZ);
    if (i > 0) {
      const b = i * 2;
      indices.push(b - 2, b - 1, b, b - 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function addStrip(group, points, from, to, y, material, heightAt) {
  group.add(
    new THREE.Mesh(
      polylineRibbon(points, Math.min(from, to), Math.max(from, to), y, heightAt),
      material,
    ),
  );
}

function drawRoad(group, road) {
  const points = road.points;
  if (!points || points.length < 2) return;
  const width = road.width ?? (road.lanes ?? 1) * 3.2;
  const roadMat = new THREE.MeshLambertMaterial({ color: CFG.colors.road });
  const lineMat = new THREE.MeshBasicMaterial({ color: CFG.colors.roadLine });
  const curbMat = new THREE.MeshLambertMaterial({ color: CFG.colors.curb });
  const walkMat = new THREE.MeshLambertMaterial({ color: 0xcfd2cc });
  const heightAt = road.name?.includes("橋")
    ? (x, z) => Math.max(roadHeightAtWorld(x, z), terrainHeightAtWorld(x, z))
    : terrainHeightAtWorld;

  addStrip(group, points, -width / 2, width / 2, 0.006, roadMat, heightAt);

  // 片側1車線は中央線を引かず、2車線一方通行の小枝橋だけ車線境界を引く。
  if ((road.lanes ?? 1) >= 2 && road.oneway)
    addStrip(group, points, -0.045, 0.045, 0.026, lineMat, heightAt);

  for (const side of [-1, 1]) {
    const edge = side * (width / 2 - 0.28);
    addStrip(group, points, edge - 0.07, edge + 0.07, 0.025, lineMat, heightAt);
    const curb = side * (width / 2 + 0.15);
    addStrip(group, points, curb - side * 0.25, curb + side * 0.25, 0.12, curbMat, heightAt);

    // 小枝橋の橋面では歩道を細くし、道路端の板状の張り出しを作らない。
    const walk = side * (width / 2 + 0.9);
    addStrip(group, points, walk - side * 0.65, walk + side * 0.65, 0.09, walkMat, heightAt);
  }
}

export function buildExtraRoads(scene, { render = true } = {}) {
  const group = new THREE.Group();
  scene.add(group);
  const roads = route.extraRoads?.length ? route.extraRoads : FALLBACK_ROADS;
  if (render) for (const road of roads) drawRoad(group, road);

  return {
    trafficRoads: roads.filter((road) => road.direction === "northbound"),
  };
}
