import * as THREE from "three";

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

function appendSurface(polygon, positions, indices, yOffset = 0) {
  if (!Array.isArray(polygon) || polygon.length < 3) return;
  // Project the 3D polygon onto its dominant plane. This supports both horizontal
  // road/terrain surfaces and vertical/oblique LOD2 building walls and roofs.
  let nx = 0, ny = 0, nz = 0;
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
  // ShapeUtils.triangulateShape assumes a simple (non-self-intersecting) 2D
  // polygon. Real-world LOD2/3 CityGML wall/roof rings occasionally violate
  // that after coordinate rounding/simplification, and the ear-clipping
  // triangulator then produces "bowtie" triangles that jump between distant
  // corners of the ring instead of only connecting adjacent vertices. Such a
  // triangle's longest edge always exceeds the polygon's own bounding-box
  // diagonal, so reject those rather than let them render as stray shards.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, y, z] of polygon) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const maxPlausibleEdge = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 1.01 + 0.05;
  const base = positions.length / 3;
  for (const [x, y, z] of polygon) positions.push(x, y + yOffset, z);
  for (const face of faces) {
    const [a, b, c] = face.map((i) => polygon[i]);
    const edge = Math.max(
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
      Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]),
      Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]),
    );
    if (edge > maxPlausibleEdge) continue;
    indices.push(base + face[0], base + face[1], base + face[2]);
  }
}

function surfaceMesh(features, material, yOffset = 0) {
  const positions = [];
  const indices = [];
  for (const feature of features ?? []) appendSurface(feature.polygon, positions, indices, yOffset);
  if (!indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function terrainMesh(triangles) {
  const positions = [];
  for (const triangle of triangles ?? []) {
    for (const [x, y, z] of triangle) positions.push(x, y - 0.03, z);
  }
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ color: 0x798b66, side: THREE.DoubleSide }),
  );
}

function appendBuilding(building, positions, indices) {
  if (Array.isArray(building.surfaces) && building.surfaces.length) {
    for (const polygon of building.surfaces) appendSurface(polygon, positions, indices);
    return;
  }
  const footprint = building.footprint ?? [];
  if (footprint.length < 3) return;
  const base = positions.length / 3;
  const y0 = Number(building.baseHeight ?? 0);
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

function buildingMeshes(document, exclusions = []) {
  const groups = new Map();
  const excluded = (building) => exclusions.some((entry) => {
    const center = building.center ?? [0, 0];
    return (center[0] - entry.x) ** 2 + (center[1] - entry.z) ** 2 < entry.r ** 2;
  });
  for (const building of document.features ?? []) {
    if (excluded(building)) continue;
    const materialName = building.material ?? "lowrise";
    if (!groups.has(materialName)) groups.set(materialName, { positions: [], indices: [] });
    const target = groups.get(materialName);
    appendBuilding(building, target.positions, target.indices);
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

function furnitureGroup(features) {
  const signals = (features ?? []).filter((feature) => feature.kind === "traffic-signal");
  if (!signals.length) return null;
  const group = new THREE.Group();
  group.name = "plateau-city-furniture";
  const poleGeometry = new THREE.CylinderGeometry(0.07, 0.09, 3.4, 8);
  const poleMaterial = new THREE.MeshLambertMaterial({ color: 0x555555 });
  const headGeometry = new THREE.BoxGeometry(0.28, 0.8, 0.22);
  const headMaterial = new THREE.MeshLambertMaterial({ color: 0x262626 });
  for (const feature of signals) {
    const [x, y, z] = feature.position;
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
    this.groups = [];
  }

  async load(manifest) {
    const layers = new Map((manifest.layers ?? []).map((layer) => [layer.id, layer]));
    const wanted = ["terrain", "transportation", "water", "vegetation", "bridges", "buildings", "furniture"]
      .filter((id) => this.enabled[id] !== false && layers.get(id)?.url);
    const documents = Object.fromEntries(await Promise.all(wanted.map(async (id) => [id, await fetchJson(layers.get(id).url)])));

    if (documents.terrain) this.add("terrain", terrainMesh(documents.terrain.triangles));
    if (documents.transportation) {
      const byKind = Object.groupBy
        ? Object.groupBy(documents.transportation.features ?? [], (feature) => feature.kind ?? "road")
        : (documents.transportation.features ?? []).reduce((acc, feature) => {
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
      for (const [kind, features] of Object.entries(byKind)) this.add(`transportation:${kind}`, surfaceMesh(features, materials[kind] ?? materials.road, 0.015));
    }
    if (documents.water) this.add("water", surfaceMesh(documents.water.features, new THREE.MeshLambertMaterial({ color: 0x4b86a6, transparent: true, opacity: 0.78, side: THREE.DoubleSide }), 0.03));
    if (documents.vegetation) this.add("vegetation", surfaceMesh(documents.vegetation.features, new THREE.MeshLambertMaterial({ color: 0x547448, side: THREE.DoubleSide }), 0.025));
    if (documents.bridges) this.add("bridges", surfaceMesh(documents.bridges.features, new THREE.MeshLambertMaterial({ color: 0x777777, side: THREE.DoubleSide }), 0.02));
    if (documents.buildings) for (const mesh of buildingMeshes(documents.buildings, this.exclusions)) this.add(mesh.name, mesh);
    if (documents.furniture) this.add("furniture", furnitureGroup(documents.furniture.features));

    return {
      groups: this.groups,
      counts: Object.fromEntries(Object.entries(documents).map(([id, doc]) => [id, (doc.features ?? doc.triangles ?? []).length])),
      hasPlateauBuildings: Boolean(documents.buildings?.features?.length),
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
