import * as THREE from "three";
import { CFG } from "../../config.js";
import terrainGrid from "./generated/terrain-grid.json";
import { buildRiverDips, riverDipDepthAt } from "../riverGeometry.js";

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

  project(x, z) {
    const coarse = this.nearest(x, z);
    const closest = this.path.closestS([x, z], coarse.s, 35);
    return {
      y: this.elevationAtS(closest.s),
      distance: closest.dist,
      lateral: closest.lateral,
      s: closest.s,
    };
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
let routeSurfaceIndex = null;
let roadAttachmentHalfWidthAtS = null;

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
  // Match the terrain mesh exactly: each cell is split into (a,c,b) and
  // (b,c,d), rather than sampled as a separate bilinear surface.
  const y = tx + tz <= 1
    ? a + (b - a) * tx + (c - a) * tz
    : d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
  const outsideDistance = inside
    ? 0
    : Math.hypot(
        x < gridOrigin[0] ? gridOrigin[0] - x : x > gridMaxX ? x - gridMaxX : 0,
        z < gridOrigin[1] ? gridOrigin[1] - z : z > gridMaxZ ? z - gridMaxZ : 0,
      );
  return { y, inside, outsideDistance };
}

export function configureWorldHeightSamplers(
  path,
  terrainElevationAtS,
  routeSurfaceHeightAtS,
  attachmentHalfWidthAtS = null,
  surfacePath = path,
) {
  terrainRouteIndex = new RouteHeightIndex(path, terrainElevationAtS);
  routeSurfaceIndex = new RouteHeightIndex(surfacePath, routeSurfaceHeightAtS);
  roadAttachmentHalfWidthAtS = attachmentHalfWidthAtS;
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

/**
 * Main-route surface height in world coordinates.
 *
 * The returned elevated value is exactly the same single route height used by
 * the bus, traffic, rails and stops. Only the actual road/sidewalk corridor is
 * lifted; the previous fixed 24 m radius also lifted nearby and crossing
 * PLATEAU transportation polygons, creating grey plates around overpasses.
 */
export function roadHeightAtWorld(x, z) {
  const ground = terrainHeightAtWorld(x, z);
  const roadRoute = routeSurfaceIndex?.project(x, z);
  if (!roadRoute) return ground;
  const corridorHalfWidth = roadAttachmentHalfWidthAtS
    ? roadAttachmentHalfWidthAtS(roadRoute.s)
    : 7.5;
  if (Math.abs(roadRoute.lateral) > corridorHalfWidth) return ground;
  return roadRoute.y;
}

/** Build one indexed terrain mesh from the generated regular grid. River valleys are
 * carved into the same connected topology; water is rendered separately by nature.js. */
export function buildContinuousTerrain(path, bridges = [], rivers = []) {
  const positions = [];
  const indices = [];
  const colors = [];
  const dips = buildRiverDips(path, bridges, rivers);
  const baseColor = new THREE.Color(CFG.colors.ground);
  const riverBankColor = new THREE.Color(0x70815f);

  for (let iz = 0; iz < gridHeight; iz++) {
    const z = gridOrigin[1] + iz * gridSpacing[1];
    for (let ix = 0; ix < gridWidth; ix++) {
      const x = gridOrigin[0] + ix * gridSpacing[0];
      const dip = riverDipDepthAt(x, z, dips);
      const y = gridAt(ix, iz) - dip;
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
