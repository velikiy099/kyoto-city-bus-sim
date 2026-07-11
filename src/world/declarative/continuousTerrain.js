import * as THREE from "three";
import { CFG } from "../../config.js";
import terrainGrid from "./generated/terrain-grid.json";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const clamp01 = (value) => clamp(value, 0, 1);
const smoothstep = (value) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

class RouteHeightIndex {
  constructor(path, elevationAtS, sampleStep = 10, cellSize = 100) {
    this.path = path;
    this.elevationAtS = elevationAtS;
    this.cellSize = cellSize;
    this.samples = [];
    this.grid = new Map();

    for (let s = 0; s < path.length; s += sampleStep) {
      const [x, z] = path.getPoint(s);
      const sample = { x, z, y: elevationAtS(s), s };
      const index = this.samples.length;
      this.samples.push(sample);
      const key = `${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`;
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(index);
    }
    const [x, z] = path.getPoint(Math.max(0, path.length - 1e-4));
    this.samples.push({ x, z, y: elevationAtS(path.length), s: path.length });
  }

  nearest(x, z) {
    if (!this.samples.length) return { y: 0, distance: Infinity, s: 0 };
    const gx = Math.floor(x / this.cellSize);
    const gz = Math.floor(z / this.cellSize);
    let candidates = [];
    for (let radius = 0; radius <= 12; radius++) {
      candidates = [];
      for (let ix = gx - radius; ix <= gx + radius; ix++) {
        for (let iz = gz - radius; iz <= gz + radius; iz++) {
          candidates.push(...(this.grid.get(`${ix}:${iz}`) ?? []));
        }
      }
      if (candidates.length) break;
    }
    if (!candidates.length) candidates = this.samples.map((_, index) => index);
    let best = candidates[0];
    let bestDistance2 = Infinity;
    for (const index of candidates) {
      const sample = this.samples[index];
      const distance2 = (sample.x - x) ** 2 + (sample.z - z) ** 2;
      if (distance2 < bestDistance2) {
        bestDistance2 = distance2;
        best = index;
      }
    }
    const sample = this.samples[best];
    return { y: sample.y, distance: Math.sqrt(bestDistance2), s: sample.s };
  }
}

const gridOrigin = terrainGrid.origin ?? [0, 0];
const gridSpacing = Array.isArray(terrainGrid.spacing)
  ? terrainGrid.spacing
  : [terrainGrid.spacing ?? 1, terrainGrid.spacing ?? 1];
const gridWidth = Number(terrainGrid.width ?? 0);
const gridHeight = Number(terrainGrid.height ?? 0);
const gridHeights = terrainGrid.heights ?? [];
const gridMaxX = gridOrigin[0] + gridSpacing[0] * Math.max(0, gridWidth - 1);
const gridMaxZ = gridOrigin[1] + gridSpacing[1] * Math.max(0, gridHeight - 1);

let terrainRouteIndex = null;
let roadRouteIndex = null;

function gridAt(ix, iz) {
  const x = clamp(ix, 0, gridWidth - 1);
  const z = clamp(iz, 0, gridHeight - 1);
  return Number(gridHeights[z * gridWidth + x] ?? 0);
}

function sampleGrid(x, z) {
  if (gridWidth < 2 || gridHeight < 2 || !gridHeights.length) return null;
  const gx = (x - gridOrigin[0]) / gridSpacing[0];
  const gz = (z - gridOrigin[1]) / gridSpacing[1];
  const inside = gx >= 0 && gx <= gridWidth - 1 && gz >= 0 && gz <= gridHeight - 1;
  const cx = clamp(gx, 0, gridWidth - 1);
  const cz = clamp(gz, 0, gridHeight - 1);
  const ix = Math.min(gridWidth - 2, Math.max(0, Math.floor(cx)));
  const iz = Math.min(gridHeight - 2, Math.max(0, Math.floor(cz)));
  const tx = clamp01(cx - ix);
  const tz = clamp01(cz - iz);
  const a = gridAt(ix, iz);
  const b = gridAt(ix + 1, iz);
  const c = gridAt(ix, iz + 1);
  const d = gridAt(ix + 1, iz + 1);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  const y = top + (bottom - top) * tz;
  const outsideDistance = inside
    ? 0
    : Math.hypot(
        x < gridOrigin[0] ? gridOrigin[0] - x : x > gridMaxX ? x - gridMaxX : 0,
        z < gridOrigin[1] ? gridOrigin[1] - z : z > gridMaxZ ? z - gridMaxZ : 0,
      );
  return { y, inside, outsideDistance };
}

export function configureWorldHeightSamplers(path, terrainElevationAtS, roadElevationAtS) {
  terrainRouteIndex = new RouteHeightIndex(path, terrainElevationAtS);
  roadRouteIndex = new RouteHeightIndex(path, roadElevationAtS);
  return { terrainHeightAtWorld, roadHeightAtWorld };
}

/** Connected PLATEAU terrain height. Outside the generated grid, the boundary
 * height is blended toward the nearest route profile so the world never ends in a cliff. */
export function terrainHeightAtWorld(x, z) {
  const grid = sampleGrid(x, z);
  if (!grid) return terrainRouteIndex?.nearest(x, z).y ?? 0;
  if (grid.inside) return grid.y;
  const routeSample = terrainRouteIndex?.nearest(x, z);
  if (!routeSample) return grid.y;
  const blend = smoothstep(grid.outsideDistance / 320);
  return grid.y + (routeSample.y - grid.y) * blend;
}

/** Road height follows the shared route profile inside the main-road corridor.
 * Feeder roads remain on the connected PLATEAU terrain. */
export function roadHeightAtWorld(x, z) {
  const ground = terrainHeightAtWorld(x, z);
  const roadRoute = roadRouteIndex?.nearest(x, z);
  if (!roadRoute || roadRoute.distance >= 24) return ground;

  // The vehicle and the route road ribbon use the shared route profile. Do not
  // reconstruct the road height by adding a structural delta to the connected
  // terrain grid: the grid is intentionally smoothed/extrapolated and can be
  // up to about a metre away from the sampled route DEM around 小枝橋. Using
  // that mixed value moves the PLATEAU road surface away from the bus exactly
  // on the bridge approach and its east-end descent.
  return roadRoute.y;
}

function pointToSegmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const denom = dx * dx + dz * dz || 1e-9;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / denom, 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function distToPolyline(px, pz, points) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    best = Math.min(
      best,
      pointToSegmentDistance(px, pz, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]),
    );
  }
  return best;
}

function clippedRiverPoints(path, bridge, rivers) {
  const [px, pz] = path.getPoint(bridge.s);
  const [tx, tz] = path.getTangent(bridge.s);
  const heading = bridge.riverHeadingDeg != null
    ? (bridge.riverHeadingDeg * Math.PI) / 180
    : Math.atan2(tx, tz);
  const line = (rivers ?? []).find((river) => river.bridgeName === bridge.name);
  const full = line?.points?.length >= 2
    ? line.points
    : [
        [px - Math.sin(heading) * 170, pz - Math.cos(heading) * 170],
        [px, pz],
        [px + Math.sin(heading) * 170, pz + Math.cos(heading) * 170],
      ];
  const sameRiver = line && (rivers ?? []).some(
    (river) => river.bridgeName !== bridge.name && river.river === line.river,
  );
  if (!sameRiver) return full;
  let anchor = 0;
  let best = Infinity;
  for (let i = 0; i < full.length; i++) {
    const distance = Math.hypot(full[i][0] - px, full[i][1] - pz);
    if (distance < best) {
      best = distance;
      anchor = i;
    }
  }
  let from = anchor;
  let to = anchor;
  while (from > 0 && Math.hypot(full[from - 1][0] - px, full[from - 1][1] - pz) < 400) from--;
  while (to < full.length - 1 && Math.hypot(full[to + 1][0] - px, full[to + 1][1] - pz) < 400) to++;
  return full.slice(from, to + 1);
}

function riverDips(path, bridges, rivers) {
  return (bridges ?? []).map((bridge) => {
    const riverWidth = Math.max(18, bridge.length * 0.85);
    const outer = Math.max(55, Math.min(200, riverWidth / 2 + 35));
    const points = clippedRiverPoints(path, bridge, rivers);
    const xs = points.map((point) => point[0]);
    const zs = points.map((point) => point[1]);
    return {
      points,
      inner: riverWidth / 2,
      outer,
      minX: Math.min(...xs) - outer,
      maxX: Math.max(...xs) + outer,
      minZ: Math.min(...zs) - outer,
      maxZ: Math.max(...zs) + outer,
    };
  });
}

function riverDipAt(x, z, dips) {
  let dip = 0;
  for (const item of dips) {
    if (x < item.minX || x > item.maxX || z < item.minZ || z > item.maxZ) continue;
    const distance = distToPolyline(x, z, item.points);
    const value = smoothstep((item.outer - distance) / Math.max(1, item.outer - item.inner));
    dip = Math.max(dip, value);
  }
  return dip * 3.4;
}

/** Build one indexed terrain mesh from the generated regular grid. River valleys are
 * carved into the same connected topology; water is rendered separately by nature.js. */
export function buildContinuousTerrain(path, bridges = [], rivers = []) {
  const positions = [];
  const indices = [];
  const colors = [];
  const dips = riverDips(path, bridges, rivers);
  const baseColor = new THREE.Color(CFG.colors.ground);
  const riverBankColor = new THREE.Color(0x70815f);

  for (let iz = 0; iz < gridHeight; iz++) {
    const z = gridOrigin[1] + iz * gridSpacing[1];
    for (let ix = 0; ix < gridWidth; ix++) {
      const x = gridOrigin[0] + ix * gridSpacing[0];
      const dip = riverDipAt(x, z, dips);
      const y = gridAt(ix, iz) - dip - 0.045;
      positions.push(x, y, z);
      const blend = clamp01(dip / 3.4) * 0.55;
      const color = baseColor.clone().lerp(riverBankColor, blend);
      colors.push(color.r, color.g, color.b);
    }
  }

  for (let iz = 0; iz < gridHeight - 1; iz++) {
    for (let ix = 0; ix < gridWidth - 1; ix++) {
      const a = iz * gridWidth + ix;
      const b = a + 1;
      const c = a + gridWidth;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  );
  mesh.name = "plateau-connected-terrain";
  mesh.userData.connectedTerrain = true;
  mesh.userData.grid = {
    width: gridWidth,
    height: gridHeight,
    origin: gridOrigin,
    spacing: gridSpacing,
  };
  return mesh;
}

function boundsFor(object) {
  object.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(object);
  return box.isEmpty() ? null : box;
}

/** Compatibility helper for hand-authored landmarks. It moves compact roots as a
 * unit and descends into large groups, preserving bridge/deck relative geometry. */
export function snapHierarchyToTerrain(object, heightAt = terrainHeightAtWorld) {
  const snap = (node) => {
    const box = boundsFor(node);
    if (!box) return;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const compact = size.x <= 220 && size.z <= 220;
    if (!compact && node.children.length) {
      for (const child of node.children) snap(child);
      return;
    }
    const target = heightAt(center.x, center.z);
    const delta = target - box.min.y;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.001) return;
    const scaleY = node.parent?.getWorldScale(new THREE.Vector3()).y || 1;
    node.position.y += delta / scaleY;
    node.updateWorldMatrix(true, true);
  };
  snap(object);
  return object;
}
