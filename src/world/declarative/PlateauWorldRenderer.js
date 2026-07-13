import * as THREE from "three";
import { buildRiverDips, riverDipDepthAt } from "../riverGeometry.js";

const DEFAULT_MATERIALS = {
  lowrise: 0xcfc8ba,
  midrise: 0xb9bec1,
  highrise: 0xaab3b9,
  commercial: 0xb9afa2,
  heritage: 0x87634a,
};

function colorValue(value, fallback) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return new THREE.Color(value).getHex();
  return fallback;
}

function polygonCenter(polygon) {
  let x = 0;
  let z = 0;
  for (const point of polygon) {
    x += point[0];
    z += point[2];
  }
  return [x / polygon.length, z / polygon.length];
}

function shiftedPolygon(polygon, heightAt, followSurface = false) {
  if (!heightAt || !polygon?.length) return polygon;
  if (followSurface) {
    return polygon.map(([px, py, pz]) => {
      const target = heightAt(px, pz);
      return [px, Number.isFinite(target) ? target : py, pz];
    });
  }
  const [x, z] = polygonCenter(polygon);
  const sourceBase = Math.min(...polygon.map((point) => point[1]));
  const delta = heightAt(x, z) - sourceBase;
  return polygon.map(([px, py, pz]) => [px, py + delta, pz]);
}

function appendSurface(polygon, positions, indices, yOffset = 0) {
  if (!Array.isArray(polygon) || polygon.length < 3) return;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1, z1] = polygon[i];
    const [x2, y2, z2] = polygon[(i + 1) % polygon.length];
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  const axes = [["x", Math.abs(nx)], ["y", Math.abs(ny)], ["z", Math.abs(nz)]]
    .sort((a, b) => b[1] - a[1])
    .map(([axis]) => axis);
  let faces = [];
  for (const axis of axes) {
    const shape = polygon.map(([x, y, z]) => axis === "x"
      ? new THREE.Vector2(y, z)
      : axis === "y" ? new THREE.Vector2(x, z) : new THREE.Vector2(x, y));
    faces = THREE.ShapeUtils.triangulateShape(shape, []);
    if (faces.length) break;
  }
  if (!faces.length) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, y, z] of polygon) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const maxPlausibleEdge = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 1.01 + 0.05;
  const base = positions.length / 3;
  for (const [x, y, z] of polygon) positions.push(x, y + yOffset, z);
  for (const face of faces) {
    const [a, b, c] = face.map((index) => polygon[index]);
    const edge = Math.max(
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
      Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]),
      Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]),
    );
    if (edge <= maxPlausibleEdge) indices.push(base + face[0], base + face[1], base + face[2]);
  }
}

function surfaceMesh(features, material, heightAt, yOffset = 0, followSurface = false) {
  const positions = [];
  const indices = [];
  for (const feature of features ?? []) {
    const polygon = shiftedPolygon(feature.polygon, heightAt, followSurface);
    appendSurface(polygon, positions, indices, yOffset);
  }
  if (!indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function area2d(polygon) {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area * 0.5;
}

function cross2(a, b, p) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function clipPolygonByEdge(polygon, a, b, keepPositive) {
  if (!polygon.length) return [];
  const inside = (point) => (keepPositive ? cross2(a, b, point) : -cross2(a, b, point)) >= -1e-5;
  const intersection = (from, to) => {
    const fromSide = cross2(a, b, from);
    const toSide = cross2(a, b, to);
    const denominator = fromSide - toSide;
    const t = Math.abs(denominator) < 1e-9 ? 0 : fromSide / denominator;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  };
  const clipped = [];
  let previous = polygon.at(-1);
  let previousInside = inside(previous);
  for (const current of polygon) {
    const currentInside = inside(current);
    if (currentInside !== previousInside) clipped.push(intersection(previous, current));
    if (currentInside) clipped.push(current);
    previous = current;
    previousInside = currentInside;
  }
  return clipped;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses = yi > point[1] !== yj > point[1]
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || 1e-9) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function roadFeatureIndex(features, originX, originZ, stepX, stepZ, width, height) {
  const index = new Map();
  const add = (ix, iz, feature) => {
    const key = `${ix}:${iz}`;
    const list = index.get(key) ?? [];
    list.push(feature);
    index.set(key, list);
  };
  for (const feature of features ?? []) {
    const polygon = feature.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3) continue;
    const xs = polygon.map((point) => point[0]);
    const zs = polygon.map((point) => point[2]);
    const ix0 = Math.max(0, Math.floor((Math.min(...xs) - originX) / stepX) - 1);
    const ix1 = Math.min(width - 2, Math.floor((Math.max(...xs) - originX) / stepX) + 1);
    const iz0 = Math.max(0, Math.floor((Math.min(...zs) - originZ) / stepZ) - 1);
    const iz1 = Math.min(height - 2, Math.floor((Math.max(...zs) - originZ) / stepZ) + 1);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) add(ix, iz, feature);
    }
  }
  return index;
}

function roadSectionAt(routeData, s) {
  for (const section of routeData?.roadSections ?? []) {
    if (s >= (section.from ?? 0) && s < (section.to ?? Infinity)) {
      const lanes = Math.max(1, Number(section.lanes) || 2);
      const defaultWidth = Math.max(4, lanes * 1.6 + 0.8);
      return {
        wL: section.wL ?? defaultWidth,
        wR: section.wR ?? defaultWidth,
      };
    }
  }
  return { wL: 4, wR: 4 };
}

export function structuralRoadZones(path, routeData) {
  if (!path) return [];
  const inputs = [
    ...(routeData?.elevations ?? [])
      .filter((item) => item.profile === "flat-deck" || Number(item.height) > 0)
      .map((item) => ({
        ...item,
        from: Math.max(0, Number(item.from) - (item.profile === "flat-deck" ? 0 : Number(item.approachIn ?? 50))),
        to: Math.min(path.length, Number(item.to) + (item.profile === "flat-deck" ? 0 : Number(item.approachOut ?? 50))),
        reason: "structure",
      })),
  ];
  return inputs.map((item) => {
    const xs = [];
    const zs = [];
    for (let s = item.from; s <= item.to + 0.01; s += 10) {
      const [x, z] = path.getPoint(Math.min(item.to, s));
      xs.push(x);
      zs.push(z);
    }
    const margin = 18;
    return {
      ...item,
      centerS: (item.from + item.to) / 2,
      searchWindow: (item.to - item.from) / 2 + 80,
      minX: Math.min(...xs) - margin,
      maxX: Math.max(...xs) + margin,
      minZ: Math.min(...zs) - margin,
      maxZ: Math.max(...zs) + margin,
    };
  });
}

function polygonBounds(polygon) {
  const xs = polygon.map((point) => point[0]);
  const zs = polygon.map((point) => point[2]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}

function boundsOverlap(a, b) {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxZ >= b.minZ && a.minZ <= b.maxZ;
}

function triangulatedXZ(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return [];
  const shape = polygon.map(([x, , z]) => new THREE.Vector2(x, z));
  return THREE.ShapeUtils.triangulateShape(shape, []).map((face) =>
    face.map((index) => [polygon[index][0], polygon[index][2]]),
  );
}

/** Split a polygon by one directed edge into the kept and rejected half-planes. */
function splitPolygonByEdge(polygon, a, b, keepPositive) {
  return {
    inside: clipPolygonByEdge(polygon, a, b, keepPositive),
    outside: clipPolygonByEdge(polygon, a, b, !keepPositive),
  };
}

/**
 * Partition a polygon into the part inside a convex clip polygon and the
 * non-overlapping fragments outside it. The outside fragments plus the inside
 * fragment cover the original polygon exactly, so the bridge lane can replace
 * (rather than duplicate) the ground-level PLATEAU surface.
 */
function partitionPolygonByConvex(polygon, clip) {
  const keepPositive = area2d(clip) >= 0;
  let candidates = [polygon];
  const outside = [];
  for (let i = 0; i < clip.length && candidates.length; i++) {
    const next = [];
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    for (const candidate of candidates) {
      const split = splitPolygonByEdge(candidate, a, b, keepPositive);
      if (split.outside.length >= 3 && Math.abs(area2d(split.outside)) > 1e-5) {
        outside.push(split.outside);
      }
      if (split.inside.length >= 3 && Math.abs(area2d(split.inside)) > 1e-5) {
        next.push(split.inside);
      }
    }
    candidates = next;
  }
  return { inside: candidates, outside };
}

function appendXZSurface(polygon, positions, indices, heightAt, yOffset = 0) {
  if (!Array.isArray(polygon) || polygon.length < 3) return;
  const faces = THREE.ShapeUtils.triangulateShape(
    polygon.map(([x, z]) => new THREE.Vector2(x, z)),
    [],
  );
  if (!faces.length) return;
  const base = positions.length / 3;
  for (const [x, z] of polygon) positions.push(x, heightAt(x, z) + yOffset, z);
  for (const face of faces) indices.push(base + face[0], base + face[1], base + face[2]);
}

/**
 * Tessellate a ground transportation polygon until its linear triangles track
 * the authoritative PLATEAU terrain sampler.  A PLATEAU road feature often
 * spans several terrain-grid cells; a single large triangle through its
 * vertices otherwise cuts across the grid surface and leaves a visible gap
 * under a vehicle even though both datasets use the same heights.
 */
function appendTerrainConformingXZSurface(polygon, positions, indices, heightAt, yOffset = 0) {
  if (!Array.isArray(polygon) || polygon.length < 3) return;
  const faces = THREE.ShapeUtils.triangulateShape(
    polygon.map(([x, z]) => new THREE.Vector2(x, z)),
    [],
  );
  const addTriangle = (a, b, c, depth = 0) => {
    const ya = heightAt(a[0], a[1]);
    const yb = heightAt(b[0], b[1]);
    const yc = heightAt(c[0], c[1]);
    const center = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    const planarY = (ya + yb + yc) / 3;
    const terrainY = heightAt(center[0], center[1]);
    if (depth < 7 && Math.abs(terrainY - planarY) > 0.003) {
      const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const bc = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
      const ca = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2];
      addTriangle(a, ab, ca, depth + 1);
      addTriangle(ab, b, bc, depth + 1);
      addTriangle(ca, bc, c, depth + 1);
      addTriangle(ab, bc, ca, depth + 1);
      return;
    }
    const base = positions.length / 3;
    positions.push(a[0], ya + yOffset, a[1], b[0], yb + yOffset, b[1], c[0], yc + yOffset, c[1]);
    indices.push(base, base + 1, base + 2);
  };
  for (const face of faces) addTriangle(polygon[face[0]], polygon[face[1]], polygon[face[2]]);
}

function structuralCorridorQuads(path, routeData, zones, step = 4) {
  const quads = [];
  for (const zone of zones) {
    for (let s = zone.from; s < zone.to; s += step) {
      const s0 = s;
      const s1 = Math.min(zone.to, s + step);
      const [aX, aZ] = path.getPoint(s0);
      const [bX, bZ] = path.getPoint(s1);
      const [taX, taZ] = path.getTangent(s0);
      const [tbX, tbZ] = path.getTangent(s1);
      const aSec = roadSectionAt(routeData, s0);
      const bSec = roadSectionAt(routeData, s1);
      const aNx = -taZ;
      const aNz = taX;
      const bNx = -tbZ;
      const bNz = tbX;
      const polygon = [
        [aX - aNx * aSec.wL, aZ - aNz * aSec.wL],
        [bX - bNx * bSec.wL, bZ - bNz * bSec.wL],
        [bX + bNx * bSec.wR, bZ + bNz * bSec.wR],
        [aX + aNx * aSec.wR, aZ + aNz * aSec.wR],
      ];
      quads.push({
        polygon,
        centerS: (s0 + s1) / 2,
        bounds: {
          minX: Math.min(...polygon.map((point) => point[0])),
          maxX: Math.max(...polygon.map((point) => point[0])),
          minZ: Math.min(...polygon.map((point) => point[1])),
          maxZ: Math.max(...polygon.map((point) => point[1])),
        },
      });
    }
  }
  return quads;
}

function lanePathMarkingMeshes(routeData, routeHeightAtS) {
  const network = routeData?.drivingNetwork;
  const paths = (network?.trafficPaths ?? []).filter((item) => item.role === "main");
  if (!network?.nodes?.length || !paths.length) return [];
  const distances = network.nodes.map((node) => node.s);
  const byKey = new Map(paths.map((item) => [`${item.direction}:${item.lane}`, item]));
  const centerPath = {
    points: network.surfacePath ?? network.path,
    active: distances.map(() => true),
  };
  const markingGaps = [
    ...(routeData.intersections ?? []).map((item) => ({
      from: item.s - Math.max(5, (Number(item.width) || 8) / 2 + 2),
      to: item.s + Math.max(5, (Number(item.width) || 8) / 2 + 2),
    })),
    ...(routeData.turnIntersections ?? []).map((item) => ({
      from: (item.sIn ?? item.s) - 3,
      to: (item.sOut ?? item.s) + 3,
    })),
  ];
  const insideMarkingGap = (s) => markingGaps.some((gap) => s >= gap.from && s <= gap.to);
  const sample = (item, s) => {
    if (!item) return null;
    let lo = 0, hi = distances.length - 1;
    const target = Math.max(0, Math.min(distances.at(-1), s));
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (distances[mid] <= target) lo = mid;
      else hi = mid;
    }
    if (item.active && (!item.active[lo] || !item.active[hi])) return null;
    const t = (target - distances[lo]) / Math.max(1e-6, distances[hi] - distances[lo]);
    const a = item.points[lo], b = item.points[hi];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const groups = new Map();
  const addBoundary = (kind, from, to, first, second) => {
    if (!first || !second || to - from < 1) return;
    if (!groups.has(kind)) groups.set(kind, { positions: [], indices: [] });
    const target = groups.get(kind);
    let row = 0;
    for (let s = from; ; s += 4) {
      const ss = Math.min(s, to);
      if (insideMarkingGap(ss)) {
        row = 0;
        if (ss >= to) break;
        continue;
      }
      const a = sample(first, ss), b = sample(second, ss);
      const nextA = sample(first, Math.min(to, ss + 0.5)) ?? a;
      const nextB = sample(second, Math.min(to, ss + 0.5)) ?? b;
      if (a && b) {
        const x = (a[0] + b[0]) / 2;
        const z = (a[1] + b[1]) / 2;
        const tx = nextA[0] + nextB[0] - a[0] - b[0];
        const tz = nextA[1] + nextB[1] - a[1] - b[1];
        const length = Math.hypot(tx, tz) || 1;
        const nx = -tz / length, nz = tx / length;
        const halfWidth = 0.045;
        const base = target.positions.length / 3;
        const y = routeHeightAtS(ss) + 0.022;
        target.positions.push(x - nx * halfWidth, y, z - nz * halfWidth);
        target.positions.push(x + nx * halfWidth, y, z + nz * halfWidth);
        if (row) {
          target.indices.push(base - 2, base - 1, base, base - 1, base + 1, base);
        }
        row++;
      }
      if (ss >= to) break;
    }
  };
  const meshes = [];
  for (const section of routeData.roadSections ?? []) {
    const from = Math.max(0, Number(section.from) || 0);
    const to = Math.min(distances.at(-1), Number(section.to) || distances.at(-1));
    const forwardCount = Math.max(1, Number(section.lanesF) || 1);
    const backwardCount = Math.max(0, Number(section.lanesB) || 0);
    const forward = (lane) => byKey.get(`1:${lane}`);
    const backward = (lane) => byKey.get(`-1:${lane}`);
    for (let lane = 0; lane < forwardCount - 1; lane++) {
      addBoundary("lane", from, to, forward(lane), forward(lane + 1));
    }
    for (let lane = 0; lane < backwardCount - 1; lane++) {
      addBoundary("lane", from, to, backward(lane), backward(lane + 1));
    }
    if (backwardCount && section.center !== "none") {
      addBoundary("center", from, to, centerPath, centerPath);
    }
  }
  const materials = { center: 0xd8a017, lane: 0xf4f4f0 };
  for (const [kind, data] of groups) {
    if (!data.indices.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.positions, 3));
    geometry.setIndex(data.indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: materials[kind], side: THREE.DoubleSide }),
    );
    mesh.name = `plateau-lane-markings:${kind}`;
    meshes.push(mesh);
  }
  return meshes;
}

/** OSM supplies lane topology only. These thin overlays are rendered on the
 * PLATEAU transportation surface, never as a second OSM road plate. */
function plateauRouteMarkingMeshes(path, routeData, routeHeightAtS) {
  if (!path || !routeHeightAtS) return [];
  if (routeData?.drivingNetwork?.trafficPaths?.length) {
    return lanePathMarkingMeshes(routeData, routeHeightAtS);
  }
  const groups = new Map();
  const addRibbon = (color, from, to, latFrom, latTo) => {
    if (to - from < 1) return;
    if (!groups.has(color)) groups.set(color, { positions: [], indices: [] });
    const target = groups.get(color);
    const base = target.positions.length / 3;
    let row = 0;
    for (let s = from; ; s += 4) {
      const ss = Math.min(s, to);
      const [x, z] = path.getPoint(ss);
      const [tx, tz] = path.getTangent(ss);
      const nx = -tz;
      const nz = tx;
      // A rendering-only lift prevents z-fighting; it is not an independent
      // elevation model and the underlying height remains routeHeightAtS().
      const y = routeHeightAtS(ss) + 0.022;
      target.positions.push(x + nx * latFrom, y, z + nz * latFrom);
      target.positions.push(x + nx * latTo, y, z + nz * latTo);
      if (row) {
        const b = base + row * 2;
        target.indices.push(b - 2, b - 1, b, b - 1, b + 1, b);
      }
      row++;
      if (ss >= to) break;
    }
  };

  for (const section of routeData?.roadSections ?? []) {
    const from = Math.max(0, Number(section.from) || 0);
    const to = Math.min(path.length, Number(section.to) || path.length);
    if (to <= from) continue;
    const lanesF = Math.max(1, Number(section.lanesF) || 1);
    const lanesB = Math.max(0, Number(section.lanesB) || 0);
    const wL = Number(section.wL) || 4;
    const wR = Number(section.wR) || 4;
    const width = 0.09;
    if (lanesB && section.center !== "none") addRibbon("center", from, to, -width, width);
    const usable = Math.max(1, wL + wR - 1.1);
    const forwardWidth = usable * (lanesF / (lanesF + lanesB || lanesF));
    for (let lane = 1; lane < lanesF; lane++) {
      const lateral = -forwardWidth * lane / lanesF;
      addRibbon("lane", from, to, lateral - width / 2, lateral + width / 2);
    }
    const backwardWidth = usable - forwardWidth;
    for (let lane = 1; lane < lanesB; lane++) {
      const lateral = backwardWidth * lane / lanesB;
      addRibbon("lane", from, to, lateral - width / 2, lateral + width / 2);
    }
  }
  return [...groups].map(([kind, data]) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.positions, 3));
    geometry.setIndex(data.indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: kind === "center" ? 0xd8a017 : 0xffffff }),
    );
    mesh.name = `plateau-route-markings:${kind}`;
    return mesh;
  });
}

/** Small, build-authored joins between adjacent PLATEAU transportation
 * polygons.  These are emitted by driving-network, never inferred while the
 * simulator runs. */
function drivingSurfacePatchMeshes(network) {
  const meshFromRows = (rows, name, material, lift = 0.018) => {
    const positions = [];
    const indices = [];
    for (const row of rows) {
      for (const [x, y, z] of row) positions.push(x, y + lift, z);
    }
    for (let row = 1; row < rows.length; row++) {
      const i = row * 2;
      indices.push(i - 2, i - 1, i, i - 1, i + 1, i);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    return mesh;
  };
  const asphalt = new THREE.MeshLambertMaterial({ color: 0x55585a, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 });
  const meshes = (network?.surfacePatches ?? []).map((patch, patchIndex) =>
    meshFromRows(patch.rows ?? [], `driving-network-surface-patch:${patchIndex}`, asphalt),
  );
  const rotary = network?.overlays?.nijoRotary?.road;
  if (rotary?.rows?.length >= 2)
    meshes.push(meshFromRows(rotary.rows, "nijo-rotary-road", asphalt));
  if (rotary?.laneDividerRows?.length >= 2) {
    const white = new THREE.MeshBasicMaterial({ color: 0xf4f4f0, side: THREE.DoubleSide });
    meshes.push(meshFromRows(rotary.laneDividerRows, "nijo-rotary-lane-divider", white, 0.04));
  }
  return meshes;
}

/** OSM topology details compiled with the driving network: medians, explicit
 * zebra crossings, bridge-attached sidewalks and pedestrian bridges. Their
 * vertices already carry the selected PLATEAU road elevation, so they never
 * resample a competing surface at runtime. */
function compiledRoadDetailMeshes(network, terrainHeightAtWorld) {
  const result = [];
  const rowsMesh = (rows, name, material, lift = 0.03) => {
    if (!rows || rows.length < 2) return null;
    const positions = [], indices = [];
    for (const row of rows) for (const [x, y, z] of row) positions.push(x, y + lift, z);
    for (let row = 1; row < rows.length; row++) {
      const i = row * 2;
      indices.push(i - 2, i - 1, i, i - 1, i + 1, i);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    return mesh;
  };
  const details = network?.overlays?.roads ?? {};
  const medianMat = new THREE.MeshLambertMaterial({ color: 0x85867c, side: THREE.DoubleSide });
  const plantedMat = new THREE.MeshLambertMaterial({ color: 0x58743b });
  for (const median of details.medians ?? []) {
    const mesh = rowsMesh(median.rows, `osm-median:${median.id}`, medianMat, 0.075);
    if (mesh) result.push(mesh);
    if (!median.planted) continue;
    const shrub = new THREE.IcosahedronGeometry(0.48, 1);
    const group = new THREE.Group();
    for (let i = 1; i < (median.rows?.length ?? 0) - 1; i += 2) {
      const [a, b] = median.rows[i];
      const x = (a[0] + b[0]) / 2, z = (a[2] + b[2]) / 2, y = (a[1] + b[1]) / 2 + 0.45;
      const item = new THREE.Mesh(shrub, plantedMat);
      item.position.set(x, y, z);
      item.scale.set(1.25, 0.85, 1.25);
      group.add(item);
    }
    group.name = `osm-median-shrubs:${median.id}`;
    result.push(group);
  }
  const white = new THREE.MeshBasicMaterial({ color: 0xf7f7f2, side: THREE.DoubleSide });
  for (const crossing of details.crosswalks ?? []) {
    for (const stripe of crossing.stripes ?? []) {
      if (stripe.length < 3) continue;
      const shape = new THREE.BufferGeometry();
      const positions = stripe.flatMap(([x, y, z]) => [x, y + 0.06, z]);
      shape.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      shape.setIndex([0, 1, 2, 0, 2, 3]);
      shape.computeVertexNormals();
      const mesh = new THREE.Mesh(shape, white);
      mesh.name = `osm-crosswalk:${crossing.id}`;
      result.push(mesh);
    }
  }
  const deckMat = new THREE.MeshLambertMaterial({ color: 0x8c9194 });
  const sidewalkMat = new THREE.MeshLambertMaterial({ color: 0xcfd2cc, side: THREE.DoubleSide });
  const railMat = new THREE.MeshLambertMaterial({ color: 0xd8dde0 });
  for (const sidewalk of details.bridgeSidewalks ?? []) {
    const mesh = rowsMesh(sidewalk.rows, `osm-bridge-sidewalk:${sidewalk.id}`, sidewalkMat, 0.045);
    if (mesh) result.push(mesh);
  }
  for (const structure of details.footbridges ?? []) {
    const points = structure.points ?? [];
    const group = new THREE.Group();
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz);
      if (length < 0.2) continue;
      const heading = Math.atan2(dx, dz), pitch = -Math.atan2(b[1] - a[1], length);
      const midY = (a[1] + b[1]) / 2;
      if (structure.kind === "stairs") {
        const count = Math.max(1, Math.ceil(length / 0.38));
        for (let step = 0; step < count; step++) {
          const t = (step + 0.5) / count;
          const x = a[0] + dx * t, z = a[2] + dz * t, y = a[1] + (b[1] - a[1]) * t;
          const box = new THREE.Mesh(new THREE.BoxGeometry(structure.width, 0.16, length / count + 0.03), deckMat);
          box.position.set(x, y, z);
          box.rotation.y = heading;
          group.add(box);
        }
      } else {
        const deck = new THREE.Mesh(new THREE.BoxGeometry(structure.width, 0.18, length + 0.04), deckMat);
        deck.position.set((a[0] + b[0]) / 2, midY, (a[2] + b[2]) / 2);
        deck.rotation.order = "YXZ";
        deck.rotation.y = heading;
        deck.rotation.x = pitch;
        group.add(deck);
      }
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.05, length + 0.03), railMat);
        rail.position.set((a[0] + b[0]) / 2 + Math.cos(heading) * side * (structure.width / 2 - 0.04), midY + 0.58, (a[2] + b[2]) / 2 - Math.sin(heading) * side * (structure.width / 2 - 0.04));
        rail.rotation.order = "YXZ";
        rail.rotation.y = heading;
        rail.rotation.x = pitch;
        group.add(rail);
      }
      if (structure.kind === "deck") for (let d = 6; d < length; d += 10) {
        const t = d / length;
        const x = a[0] + dx * t, z = a[2] + dz * t, y = a[1] + (b[1] - a[1]) * t;
        const groundY = terrainHeightAtWorld?.(x, z) ?? 0;
        const height = Math.max(1, y - groundY - 0.1);
        const support = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, height, 8), deckMat);
        support.position.set(x, groundY + height / 2, z);
        group.add(support);
      }
    }
    group.name = `osm-pedestrian-structure:${structure.id}`;
    result.push(group);
  }
  return result;
}

/**
 * Build one PLATEAU transportation mesh with structural lanes edited in-place.
 *
 * A source triangle is partitioned into ground and bridge-lane fragments. The
 * bridge fragment replaces the corresponding ground fragment and is assigned
 * routeHeightAtS(s). No second road-coloured object is layered above the source
 * polygon, and parts outside the carriageway corridor (including Omiya's outer
 * service roads) remain at the PLATEAU terrain height.
 */
export function transportationSurfaceMesh(
  features,
  material,
  terrainHeightAtWorld,
  path,
  routeData,
  routeHeightAtS,
  zones,
  yOffset = 0,
) {
  const positions = [];
  const indices = [];
  const quads = path && routeHeightAtS && zones?.length
    ? structuralCorridorQuads(path, routeData, zones)
    : [];

  for (const feature of features ?? []) {
    const polygon = feature.polygon ?? [];
    if (polygon.length < 3) continue;
    const sourceId = feature.source?.gmlId ?? feature.id?.replace(/#.*$/, "");
    const fullPolygonZone = (zones ?? []).find((zone) =>
      (zone.sourceFeatureIds ?? []).includes(sourceId),
    );
    // Elevate a complete, authoritative PLATEAU road polygon in place for
    // wide bridge decks, rather than leaving its outer fragments on ground.
    if (fullPolygonZone) {
      for (const sourceTriangle of triangulatedXZ(polygon)) {
        appendTerrainConformingXZSurface(
          sourceTriangle,
          positions,
          indices,
          (x, z) => {
            const projection = path.closestS([x, z], fullPolygonZone.centerS, fullPolygonZone.searchWindow);
            // A PLATEAU source polygon can include the bridge approaches and
            // the east-end junction as one feature.  Only its declared
            // structural interval is a bridge surface; assigning the
            // path-centre height to the rest made that ground road tilt and
            // left a lateral height mismatch below vehicles.
            return projection.s >= fullPolygonZone.from && projection.s <= fullPolygonZone.to
              ? routeHeightAtS(projection.s)
              : terrainHeightAtWorld(x, z);
          },
          yOffset,
        );
      }
      continue;
    }
    const featureBounds = polygonBounds(polygon);
    const candidates = quads.filter((quad) => boundsOverlap(featureBounds, quad.bounds));

    if (!candidates.length) {
      // Transportation is a horizontal surface in the map plane.  Use the
      // same XZ triangulation as the clipped/structural branches; the former
      // generic 3D polygon projection could create a long stray triangle at
      // concave road and junction polygons.
      appendTerrainConformingXZSurface(
        polygon.map(([x, , z]) => [x, z]),
        positions,
        indices,
        terrainHeightAtWorld,
        yOffset,
      );
      continue;
    }

    for (const sourceTriangle of triangulatedXZ(polygon)) {
      let groundFragments = [sourceTriangle];
      const triangleBounds = {
        minX: Math.min(...sourceTriangle.map((point) => point[0])),
        maxX: Math.max(...sourceTriangle.map((point) => point[0])),
        minZ: Math.min(...sourceTriangle.map((point) => point[1])),
        maxZ: Math.max(...sourceTriangle.map((point) => point[1])),
      };

      for (const quad of candidates) {
        if (!boundsOverlap(triangleBounds, quad.bounds) || !groundFragments.length) continue;
        const remaining = [];
        for (const fragment of groundFragments) {
          const fragmentBounds = {
            minX: Math.min(...fragment.map((point) => point[0])),
            maxX: Math.max(...fragment.map((point) => point[0])),
            minZ: Math.min(...fragment.map((point) => point[1])),
            maxZ: Math.max(...fragment.map((point) => point[1])),
          };
          if (!boundsOverlap(fragmentBounds, quad.bounds)) {
            remaining.push(fragment);
            continue;
          }
          const partition = partitionPolygonByConvex(fragment, quad.polygon);
          for (const inside of partition.inside) {
            appendXZSurface(
              inside,
              positions,
              indices,
              (x, z) => {
                const projection = path.closestS([x, z], quad.centerS, 14);
                return routeHeightAtS(projection.s);
              },
              yOffset,
            );
          }
          remaining.push(...partition.outside);
        }
        groundFragments = remaining;
      }

      for (const fragment of groundFragments) {
        appendTerrainConformingXZSurface(fragment, positions, indices, terrainHeightAtWorld, yOffset);
      }
    }
  }

  if (!indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.structuralLaneReplacement = true;
  return mesh;
}

export function terrainGridMesh(
  grid,
  roadFeatures = [],
  path = null,
  bridges = [],
  rivers = [],
) {
  if (!grid || !Array.isArray(grid.heights)) return null;
  const width = Number(grid.width);
  const height = Number(grid.height);
  const [originX, originZ] = grid.origin ?? [];
  const [stepX, stepZ] = Array.isArray(grid.spacing) ? grid.spacing : [grid.spacing, grid.spacing];
  if (!(width >= 2 && height >= 2) || grid.heights.length !== width * height) return null;
  const positions = [];
  const indices = [];
  const riverDips = path ? buildRiverDips(path, bridges, rivers) : [];
  const roads = roadFeatureIndex(
    roadFeatures,
    originX,
    originZ,
    stepX,
    stepZ,
    width,
    height,
  );
  const heightAtGrid = (ix, iz) => {
    const x = originX + ix * stepX;
    const z = originZ + iz * stepZ;
    return Number(grid.heights[iz * width + ix] ?? 0)
      - riverDipDepthAt(x, z, riverDips);
  };
  const heightAtTriangle = (point, triangle, values) => {
    const [a, b, c] = triangle;
    const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(denominator) < 1e-9) return values[0];
    const wa = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
    const wb = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
    const wc = 1 - wa - wb;
    return wa * values[0] + wb * values[1] + wc * values[2];
  };
  const sourceTriangles = new WeakMap();
  const trianglesFor = (feature) => {
    if (!sourceTriangles.has(feature)) {
      sourceTriangles.set(feature, triangulatedXZ(feature.polygon ?? []));
    }
    return sourceTriangles.get(feature);
  };
  const appendTriangle = (triangle, values, candidates) => {
    // Subtract every PLATEAU transportation triangle in sequence. This is a
    // true polygon union by repeated difference, so overlapping TrafficArea
    // rings cannot leave terrain slivers or require a jagged OSM route mask.
    let groundFragments = [triangle];
    for (const feature of candidates ?? []) {
      for (const roadTriangle of trianglesFor(feature)) {
        if (!groundFragments.length) break;
        const roadBounds = {
          minX: Math.min(...roadTriangle.map((point) => point[0])),
          maxX: Math.max(...roadTriangle.map((point) => point[0])),
          minZ: Math.min(...roadTriangle.map((point) => point[1])),
          maxZ: Math.max(...roadTriangle.map((point) => point[1])),
        };
        const next = [];
        for (const fragment of groundFragments) {
          const fragmentBounds = {
            minX: Math.min(...fragment.map((point) => point[0])),
            maxX: Math.max(...fragment.map((point) => point[0])),
            minZ: Math.min(...fragment.map((point) => point[1])),
            maxZ: Math.max(...fragment.map((point) => point[1])),
          };
          if (!boundsOverlap(fragmentBounds, roadBounds)) {
            next.push(fragment);
            continue;
          }
          next.push(...partitionPolygonByConvex(fragment, roadTriangle).outside);
        }
        groundFragments = next;
      }
    }
    for (const fragment of groundFragments) {
      appendXZSurface(
        fragment,
        positions,
        indices,
        (x, z) => heightAtTriangle([x, z], triangle, values),
      );
    }
  };

  for (let iz = 0; iz < height - 1; iz++) {
    for (let ix = 0; ix < width - 1; ix++) {
      const x = originX + ix * stepX;
      const z = originZ + iz * stepZ;
      const a = [x, z];
      const b = [x + stepX, z];
      const c = [x, z + stepZ];
      const d = [x + stepX, z + stepZ];
      const candidates = roads.get(`${ix}:${iz}`) ?? [];
      appendTriangle([a, c, b], [heightAtGrid(ix, iz), heightAtGrid(ix, iz + 1), heightAtGrid(ix + 1, iz)], candidates);
      appendTriangle([b, c, d], [heightAtGrid(ix + 1, iz), heightAtGrid(ix, iz + 1), heightAtGrid(ix + 1, iz + 1)], candidates);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ color: 0x798b66, side: THREE.DoubleSide }),
  );
}

function detailedShell(building) {
  const surfaces = Array.isArray(building.surfaces) ? building.surfaces : [];
  const values = surfaces.flatMap((surface) => surface.map((point) => point[1]));
  if (surfaces.length < 4 || values.length < 12) return null;
  const low = Math.min(...values);
  const spread = Math.max(...values) - low;
  const expected = Math.max(1.5, Number(building.height ?? 6) * 0.3);
  if (spread < expected) return null;
  let vertical = 0;
  let roof = 0;
  for (const surface of surfaces) {
    const ys = surface.map((point) => point[1]);
    const surfaceSpread = Math.max(...ys) - Math.min(...ys);
    if (surfaceSpread >= expected * 0.65) vertical++;
    else if (surfaceSpread < 1.2 && ys.reduce((sum, value) => sum + value, 0) / ys.length > low + expected * 0.6) roof++;
  }
  return vertical >= 2 && roof >= 1 ? surfaces : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function appendBuilding(building, positions, indices, heightAt) {
  const footprint = building.footprint ?? [];
  if (footprint.length < 3) return;
  const center = building.center ?? footprint.reduce((sum, point) => [sum[0] + point[0] / footprint.length, sum[1] + point[1] / footprint.length], [0, 0]);
  const terrainSamples = heightAt
    ? [heightAt(center[0], center[1]), ...footprint.map(([x, z]) => heightAt(x, z))]
    : [];
  const targetBase = heightAt ? median(terrainSamples) : Number(building.baseHeight ?? 0);
  const shell = detailedShell(building);
  if (shell) {
    const sourceBase = Math.min(...shell.flatMap((surface) => surface.map((point) => point[1])));
    const delta = targetBase - sourceBase;
    for (const polygon of shell) appendSurface(polygon.map(([x, y, z]) => [x, y + delta, z]), positions, indices);
    return;
  }

  const base = positions.length / 3;
  const y0 = targetBase;
  const y1 = y0 + Math.max(2.8, Number(building.height ?? 6));
  const shape = footprint.map(([x, z]) => new THREE.Vector2(x, z));
  const faces = THREE.ShapeUtils.triangulateShape(shape, []);
  for (const [x, z] of footprint) positions.push(x, y0, z);
  for (const [x, z] of footprint) positions.push(x, y1, z);
  const n = footprint.length;
  for (const face of faces) {
    indices.push(base + face[2] + n, base + face[1] + n, base + face[0] + n);
    indices.push(base + face[0], base + face[1], base + face[2]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(base + i, base + j, base + j + n, base + i, base + j + n, base + i + n);
  }
}

function buildingMeshes(document, exclusions, heightAt) {
  const groups = new Map();
  const excluded = (building) => exclusions.some((entry) => {
    const center = building.center ?? [0, 0];
    return (center[0] - entry.x) ** 2 + (center[1] - entry.z) ** 2 < entry.r ** 2;
  });
  for (const building of document.features ?? []) {
    if (excluded(building)) continue;
    const name = building.material ?? "lowrise";
    if (!groups.has(name)) groups.set(name, { positions: [], indices: [] });
    const target = groups.get(name);
    appendBuilding(building, target.positions, target.indices, heightAt);
  }
  const sourceMaterials = { ...DEFAULT_MATERIALS, ...(document.materials ?? {}) };
  const meshes = [];
  for (const [name, data] of groups) {
    if (!data.indices.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.positions, 3));
    geometry.setIndex(data.indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({ color: colorValue(sourceMaterials[name], DEFAULT_MATERIALS.lowrise) });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `plateau-buildings:${name}`;
    meshes.push(mesh);
  }
  return meshes;
}

function furnitureGroup(features, heightAt) {
  const signals = (features ?? []).filter((feature) => feature.kind === "traffic-signal");
  if (!signals.length) return null;
  const group = new THREE.Group();
  group.name = "plateau-city-furniture";
  const poleGeometry = new THREE.CylinderGeometry(0.07, 0.09, 3.4, 8);
  const poleMaterial = new THREE.MeshLambertMaterial({ color: 0x555555 });
  const headGeometry = new THREE.BoxGeometry(0.28, 0.8, 0.22);
  const headMaterial = new THREE.MeshLambertMaterial({ color: 0x262626 });
  for (const feature of signals) {
    const [x, sourceY, z] = feature.position;
    const y = heightAt ? heightAt(x, z) : sourceY;
    const pole = new THREE.Mesh(poleGeometry, poleMaterial);
    pole.position.set(x, y + 1.7, z);
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.set(x, y + 3.25, z);
    group.add(pole, head);
  }
  return group;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

export class PlateauWorldRenderer {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.exclusions = options.exclusions ?? [];
    this.enabled = options.enabled ?? {};
    this.terrainHeightAtWorld = options.terrainHeightAtWorld;
    this.roadHeightAtWorld = options.roadHeightAtWorld ?? options.terrainHeightAtWorld;
    this.routeHeightAtS = options.routeHeightAtS;
    this.routePath = options.routePath;
    this.routeData = options.routeData;
    this.groups = [];
  }

  async load(manifest) {
    const layers = new Map((manifest.layers ?? []).map((layer) => [layer.id, layer]));
    const wanted = ["terrain", "transportation", "osm-road-overlays", "water", "vegetation", "bridges", "buildings", "furniture"]
      .filter((id) => this.enabled[id] !== false && layers.get(id)?.url)
      .filter((id) => id !== "terrain" || layers.get(id)?.geometry === "connected-grid");
    const documents = Object.fromEntries(await Promise.all(wanted.map(async (id) => [id, await fetchJson(layers.get(id).url)])));

    const structuralZones = structuralRoadZones(this.routePath, this.routeData);
    const transportationFeatures = documents.transportation?.features ?? [];
    const terrain = terrainGridMesh(
      documents.terrain?.grid,
      documents.transportation?.features,
      this.routePath,
      this.routeData?.bridges ?? [],
      this.routeData?.rivers ?? [],
    );
    if (terrain) this.add("terrain", terrain);
    if (documents.transportation) {
      const byKind = transportationFeatures.reduce((acc, feature) => {
        (acc[feature.kind ?? "road"] ??= []).push(feature);
        return acc;
      }, {});
      const materials = {
        road: new THREE.MeshLambertMaterial({ color: 0x55585a, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }),
        lane: new THREE.MeshLambertMaterial({ color: 0x515456, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }),
        intersection: new THREE.MeshLambertMaterial({ color: 0x4c4f51, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }),
        sidewalk: new THREE.MeshLambertMaterial({ color: 0x99958d, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }),
        island: new THREE.MeshLambertMaterial({ color: 0x8c8b82, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }),
      };
      // Edit the original PLATEAU transportation mesh: only the bridge-lane
      // portion is moved to elevationAt(s), while the same portion is removed
      // from ground level. No additional road-coloured plate is generated.
      for (const [kind, features] of Object.entries(byKind)) {
        this.add(`transportation:${kind}`, transportationSurfaceMesh(
          features,
          materials[kind] ?? materials.road,
          this.terrainHeightAtWorld,
          this.routePath,
          this.routeData,
          this.routeHeightAtS,
          structuralZones,
        ));
      }
      for (const mesh of plateauRouteMarkingMeshes(this.routePath, this.routeData, this.routeHeightAtS)) {
        this.add(mesh.name, mesh);
      }
      for (const mesh of drivingSurfacePatchMeshes(this.routeData?.drivingNetwork)) this.add(mesh.name, mesh);
      for (const mesh of compiledRoadDetailMeshes(this.routeData?.drivingNetwork, this.terrainHeightAtWorld)) this.add(mesh.name, mesh);
    }
    if (documents["osm-road-overlays"]) {
      // Road markings come from the compiled driving network above. Ignore
      // legacy OSM line overlays, which otherwise draw a second white/yellow
      // line on top of the generated marking.
      const overlayFeatures = (documents["osm-road-overlays"].features ?? [])
        .filter((feature) => feature.kind === "sidewalk");
      const byKind = overlayFeatures.reduce((acc, feature) => {
        (acc[feature.kind ?? "lane-divider"] ??= []).push(feature);
        return acc;
      }, {});
      const materials = {
        centerline: new THREE.MeshLambertMaterial({ color: 0xd8a017, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }),
        "lane-divider": new THREE.MeshLambertMaterial({ color: 0xf4f4f0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }),
        sidewalk: new THREE.MeshLambertMaterial({ color: 0xcfd2cc, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }),
      };
      for (const [kind, features] of Object.entries(byKind)) {
        this.add(`osm-road-overlay:${kind}`, surfaceMesh(
          features,
          materials[kind] ?? materials["lane-divider"],
          this.roadHeightAtWorld,
          kind === "sidewalk" ? 0.045 : 0.065,
          true,
        ));
      }
    }
    if (documents.water) this.add("water", surfaceMesh(documents.water.features, new THREE.MeshLambertMaterial({ color: 0x4b86a6, transparent: true, opacity: 0.78, side: THREE.DoubleSide }), this.terrainHeightAtWorld, -0.12));
    if (documents.vegetation) this.add("vegetation", surfaceMesh(documents.vegetation.features, new THREE.MeshLambertMaterial({ color: 0x547448, side: THREE.DoubleSide }), this.terrainHeightAtWorld, 0.025));
    if (documents.bridges) this.add("bridges", surfaceMesh(documents.bridges.features, new THREE.MeshLambertMaterial({ color: 0x777777, side: THREE.DoubleSide }), this.roadHeightAtWorld, 0.02));
    if (documents.buildings) for (const mesh of buildingMeshes(documents.buildings, this.exclusions, this.terrainHeightAtWorld)) this.add(mesh.name, mesh);
    if (documents.furniture) this.add("furniture", furnitureGroup(documents.furniture.features, this.roadHeightAtWorld));

    return {
      groups: this.groups,
      counts: Object.fromEntries(Object.entries(documents).map(([id, doc]) => [id, (doc.features ?? doc.triangles ?? doc.grid?.heights ?? []).length])),
      hasPlateauBuildings: Boolean(documents.buildings?.features?.length),
      hasConnectedTerrain: Boolean(terrain),
    };
  }

  add(name, object) {
    if (!object) return;
    object.name ||= `plateau:${name}`;
    this.scene.add(object);
    this.groups.push(object);
  }
}

export async function loadWorldManifest(url) {
  const manifest = await fetchJson(url);
  if (manifest.status !== "ready") throw new Error(`World manifest is not ready (${manifest.status ?? "unknown"})`);
  return manifest;
}
