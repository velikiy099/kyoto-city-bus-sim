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

function clipPolygonToTriangle(polygon, triangle) {
  const keepPositive = area2d(triangle) >= 0;
  let clipped = polygon;
  for (let i = 0; i < triangle.length && clipped.length >= 3; i++) {
    clipped = clipPolygonByEdge(
      clipped,
      triangle[i],
      triangle[(i + 1) % triangle.length],
      keepPositive,
    );
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
      .filter((item) => Number(item.height) > 0)
      .map((item) => ({
        ...item,
        from: Math.max(0, Number(item.from) - Number(item.approachIn ?? 50)),
        to: Math.min(path.length, Number(item.to) + Number(item.approachOut ?? 50)),
        reason: "structure",
      })),
    ...(routeData?.roadSurfaceAlignments ?? []).map((item) => ({
      ...item,
      from: Math.max(0, Number(item.from)),
      to: Math.min(path.length, Number(item.to)),
      reason: "surface-alignment",
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

function polygonSamples(polygon, spacing = 8) {
  const samples = [];
  let centerX = 0;
  let centerZ = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    centerX += a[0];
    centerZ += a[2];
    const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const divisions = Math.max(1, Math.ceil(length / spacing));
    for (let j = 0; j < divisions; j++) {
      const t = j / divisions;
      samples.push([a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  samples.push([centerX / polygon.length, centerZ / polygon.length]);
  return samples;
}

/** Clip a 2D polygon to a convex corridor quad. */
function clipPolygonToConvex(polygon, clip) {
  const keepPositive = area2d(clip) >= 0;
  let clipped = polygon;
  for (let i = 0; i < clip.length && clipped.length >= 3; i++) {
    clipped = clipPolygonByEdge(clipped, clip[i], clip[(i + 1) % clip.length], keepPositive);
  }
  return clipped;
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
  yOffset = 0.015,
) {
  const positions = [];
  const indices = [];
  const quads = path && routeHeightAtS && zones?.length
    ? structuralCorridorQuads(path, routeData, zones)
    : [];

  for (const feature of features ?? []) {
    const polygon = feature.polygon ?? [];
    if (polygon.length < 3) continue;
    const featureBounds = polygonBounds(polygon);
    const candidates = quads.filter((quad) => boundsOverlap(featureBounds, quad.bounds));

    if (!candidates.length) {
      appendSurface(
        shiftedPolygon(polygon, terrainHeightAtWorld, true),
        positions,
        indices,
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
        appendXZSurface(fragment, positions, indices, terrainHeightAtWorld, yOffset);
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

function ribbonCutFeature(a, b, wL, wR, id) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz) || 1;
  const nx = -dz / length;
  const nz = dx / length;
  const left = [
    a[0] + nx * -wL,
    0,
    a[1] + nz * -wL,
  ];
  const leftNext = [
    b[0] + nx * -wL,
    0,
    b[1] + nz * -wL,
  ];
  const rightNext = [
    b[0] + nx * wR,
    0,
    b[1] + nz * wR,
  ];
  const right = [
    a[0] + nx * wR,
    0,
    a[1] + nz * wR,
  ];
  return { id, kind: "osm-road-cut", polygon: [left, leftNext, rightNext, right] };
}

/**
 * Build terrain-cut polygons from the same OSM route ribbons used by the
 * simulator. PLATEAU transportation polygons remain the authoritative visible
 * road surfaces; these extra masks make the terrain follow the current route
 * shape even where the two datasets differ by a few metres.
 */
function routeRoadCutFeatures(path, routeData) {
  if (!path || !routeData) return [];
  const features = [];
  const step = 12;
  const margin = 0.35;
  for (let s = 0; s < path.length; s += step) {
    const s0 = s;
    const s1 = Math.min(path.length, s + step);
    const p0 = path.getPoint(s0);
    const p1 = path.getPoint(s1);
    const w0 = roadSectionAt(routeData, s0);
    const w1 = roadSectionAt(routeData, s1);
    const dx0 = path.getTangent(s0)[0];
    const dz0 = path.getTangent(s0)[1];
    const dx1 = path.getTangent(s1)[0];
    const dz1 = path.getTangent(s1)[1];
    const n0 = Math.hypot(dx0, dz0) || 1;
    const n1 = Math.hypot(dx1, dz1) || 1;
    const left0 = [p0[0] - dz0 / n0 * (w0.wL + margin), p0[1] + dx0 / n0 * (w0.wL + margin)];
    const right0 = [p0[0] + dz0 / n0 * (w0.wR + margin), p0[1] - dx0 / n0 * (w0.wR + margin)];
    const left1 = [p1[0] - dz1 / n1 * (w1.wL + margin), p1[1] + dx1 / n1 * (w1.wL + margin)];
    const right1 = [p1[0] + dz1 / n1 * (w1.wR + margin), p1[1] - dx1 / n1 * (w1.wR + margin)];
    features.push({
      id: `osm-route-cut-${s0.toFixed(1)}`,
      kind: "osm-road-cut",
      polygon: [
        [left0[0], 0, left0[1]],
        [left1[0], 0, left1[1]],
        [right1[0], 0, right1[1]],
        [right0[0], 0, right0[1]],
      ],
    });
  }
  for (const road of routeData.extraRoads ?? []) {
    const points = road.points ?? [];
    const halfWidth = (road.width ?? (road.lanes ?? 1) * 3.2) / 2 + margin;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const feature = ribbonCutFeature(
        a,
        b,
        halfWidth,
        halfWidth,
        `osm-extra-road-cut-${road.id ?? i}-${i}`,
      );
      features.push(feature);
    }
  }
  return features;
}

export function terrainGridMesh(
  grid,
  roadFeatures = [],
  routeCutFeatures = [],
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
    [...roadFeatures, ...routeCutFeatures],
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
      - riverDipDepthAt(x, z, riverDips)
      - 0.035;
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
  const roadTerrainMaxEdge = 10;
  const roadMaskForTriangle = (triangle, candidates) => {
    const outerArea = Math.abs(area2d(triangle));
    if (outerArea < 1e-6) return;
    const holes = [];
    let fullyCovered = false;
    for (const feature of candidates ?? []) {
      const polygon = feature.polygon?.map((point) => [point[0], point[2]]);
      if (!polygon || polygon.length < 3) continue;
      const clipped = clipPolygonToTriangle(polygon, triangle);
      const clippedArea = Math.abs(area2d(clipped));
      if (clippedArea < 0.12) continue;
      if (clippedArea >= outerArea * 0.985) {
        fullyCovered = true;
        break;
      }
      if (area2d(clipped) * area2d(triangle) > 0) clipped.reverse();
      holes.push({ polygon: clipped, area: clippedArea });
    }
    if (fullyCovered) return { fullyCovered: true, holes: [] };

    // TrafficArea and AuxiliaryTrafficArea polygons can touch or overlap at
    // their boundaries. Keep the largest clipped ring when a smaller ring is
    // wholly inside it so ear-clipping receives non-overlapping holes.
    holes.sort((a, b) => b.area - a.area);
    const accepted = [];
    for (const hole of holes) {
      const center = hole.polygon.reduce((sum, point) => [sum[0] + point[0] / hole.polygon.length, sum[1] + point[1] / hole.polygon.length], [0, 0]);
      if (accepted.some((item) => pointInPolygon(center, item))) continue;
      accepted.push(hole.polygon);
    }
    return { fullyCovered: false, holes: accepted };
  };

  const appendTriangle = (triangle, values, candidates, depth = 0) => {
    const roadMask = roadMaskForTriangle(triangle, candidates);
    if (!roadMask) return;
    if (roadMask.fullyCovered) return;

    const maxEdge = Math.max(
      Math.hypot(triangle[0][0] - triangle[1][0], triangle[0][1] - triangle[1][1]),
      Math.hypot(triangle[1][0] - triangle[2][0], triangle[1][1] - triangle[2][1]),
      Math.hypot(triangle[2][0] - triangle[0][0], triangle[2][1] - triangle[0][1]),
    );
    // Refine only where a PLATEAU road polygon actually intersects the
    // terrain. This keeps the connected terrain grid inexpensive while
    // making the road boundary independent of the original 30m cell size.
    if (roadMask.holes.length && depth < 2 && maxEdge > roadTerrainMaxEdge) {
      const [a, b, c] = triangle;
      const [va, vb, vc] = values;
      const ab = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
      const bc = [(b[0] + c[0]) * 0.5, (b[1] + c[1]) * 0.5];
      const ca = [(c[0] + a[0]) * 0.5, (c[1] + a[1]) * 0.5];
      const vab = (va + vb) * 0.5;
      const vbc = (vb + vc) * 0.5;
      const vca = (vc + va) * 0.5;
      appendTriangle([a, ab, ca], [va, vab, vca], candidates, depth + 1);
      appendTriangle([ab, b, bc], [vab, vb, vbc], candidates, depth + 1);
      appendTriangle([ca, bc, c], [vca, vbc, vc], candidates, depth + 1);
      appendTriangle([ab, bc, ca], [vab, vbc, vca], candidates, depth + 1);
      return;
    }

    const contours = [triangle, ...roadMask.holes];
    const faces = roadMask.holes.length
      ? THREE.ShapeUtils.triangulateShape(
          triangle.map((point) => new THREE.Vector2(...point)),
          roadMask.holes.map((hole) => hole.map((point) => new THREE.Vector2(...point))),
        )
      : [[0, 1, 2]];
    if (!faces.length) {
      // Never restore the complete terrain triangle after a road mask was
      // found. That fallback was the source of terrain reappearing over
      // narrow/overlapping PLATEAU road polygons. The road surface remains
      // responsible for covering the masked area.
      return;
    }
    const offsets = [];
    let offset = 0;
    for (const contour of contours) {
      offsets.push(offset);
      for (const point of contour) {
        const y = heightAtTriangle(point, triangle, values);
        positions.push(point[0], y, point[1]);
        offset++;
      }
    }
    const base = positions.length / 3 - offset;
    for (const face of faces) indices.push(base + face[0], base + face[1], base + face[2]);
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

    const routeCuts = routeRoadCutFeatures(this.routePath, this.routeData);
    const structuralZones = structuralRoadZones(this.routePath, this.routeData);
    const transportationFeatures = documents.transportation?.features ?? [];
    const terrain = terrainGridMesh(
      documents.terrain?.grid,
      documents.transportation?.features,
      routeCuts,
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
    }
    if (documents["osm-road-overlays"]) {
      const overlayFeatures = documents["osm-road-overlays"].features ?? [];
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
