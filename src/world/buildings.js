import * as THREE from 'three';
import { CFG } from '../config.js';
import { leftWidthAt, rightWidthAt } from '../route/routeData.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function footprintGeometry(footprint, height) {
  const verts2 = footprint.map(([x, z]) => new THREE.Vector2(x, z));
  const faces = THREE.ShapeUtils.triangulateShape(verts2, []);
  const positions = [];
  const indices = [];
  for (const [x, z] of footprint) positions.push(x, 0, z);
  for (const [x, z] of footprint) positions.push(x, height, z);
  const n = footprint.length;
  for (const face of faces) indices.push(face[2] + n, face[1] + n, face[0] + n);
  for (const face of faces) indices.push(face[0], face[1], face[2]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, j + n, i, j + n, i + n);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildOsmBuildings(scene, buildings, exclusions) {
  const isExcluded = (x, z) => exclusions.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r);
  const materials = new Map();
  let count = 0;
  for (const b of buildings ?? []) {
    if (!b.footprint?.length || b.footprint.length < 3) continue;
    const center = b.footprint.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]).map((v) => v / b.footprint.length);
    if (isExcluded(center[0], center[1])) continue;
    const color = b.color ?? 0xcfc8ba;
    if (!materials.has(color)) materials.set(color, new THREE.MeshLambertMaterial({ color }));
    const mesh = new THREE.Mesh(footprintGeometry(b.footprint, Math.max(2.8, b.height ?? 6)), materials.get(color));
    scene.add(mesh);
    count++;
  }
  return { count };
}

/**
 * 沿道の建物群(InstancedMesh)。
 * 京都の景観: 市街地(二条〜九条)は中低層で高密、上鳥羽以南は低層+田畑。
 * ランドマーク周辺(landmarks.js の除外域)には置かない。
 */
export function buildBuildings(scene, path, exclusions = [], osmBuildings = []) {
  if (osmBuildings.length) return buildOsmBuildings(scene, osmBuildings, exclusions);

  const rand = mulberry32(20260703);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  boxGeo.translate(0, 0.5, 0); // 底面基準

  const palettes = [0xd9d2c4, 0xcfc8ba, 0xbfb7a8, 0xa89f90, 0x8f8a80, 0xe2ddd2, 0x9aa0a8, 0x7f8891];
  const roofPalettes = [0x4a4f55, 0x5d5348, 0x39424d, 0x6b625a];

  const items = []; // {x, z, ry, w, h, d, color}
  const roofItems = [];
  const L = path.length;

  const isExcluded = (x, z) => exclusions.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r);

  for (let s = 95; s < L - 10; s += 13 + rand() * 10) { // 二条駅西口の駅前広場(s<95)は空ける
    // 市街地係数: 路線北部(市街地)1.0 → 南部(郊外)へ緩やかに低下
    const t = s / L;
    const urban = t < 0.45 ? 1 : t < 0.62 ? 0.75 : 0.4;
    const [px, pz] = path.getPoint(s);
    const [tx, tz] = path.getTangent(s);
    const nx = -tz, nz = tx;
    for (const side of [-1, 1]) {
      if (rand() > (side === -1 ? 0.92 : 0.9) * urban + 0.18) continue; // 郊外は歯抜け
      const setback = 8.2 + rand() * 7;
      const w = 6 + rand() * (urban > 0.7 ? 9 : 5);
      const d = 6 + rand() * 8;
      let h;
      const r = rand();
      if (urban > 0.9) h = r < 0.5 ? 6 + rand() * 6 : r < 0.85 ? 12 + rand() * 10 : 24 + rand() * 14;
      else if (urban > 0.6) h = r < 0.6 ? 5 + rand() * 5 : 9 + rand() * 8;
      else h = r < 0.75 ? 4 + rand() * 3 : 7 + rand() * 4;
      const lat = side * ((side < 0 ? leftWidthAt(s) : rightWidthAt(s)) + setback + w / 2);
      const x = px + nx * lat + tx * (rand() - 0.5) * 4;
      const z = pz + nz * lat + tz * (rand() - 0.5) * 4;
      if (isExcluded(x, z)) continue;
      const ry = Math.atan2(tx, tz) + (rand() - 0.5) * 0.08;
      items.push({ x, z, ry, w, h, d, color: palettes[(rand() * palettes.length) | 0] });
      // 低層は瓦屋根風の薄い箱を載せる(京町家の雰囲気)
      if (h < 9 && rand() < 0.8) {
        roofItems.push({ x, z, ry, w: w + 1.0, h: 0.5, d: d + 1.0, y: h, color: roofPalettes[(rand() * roofPalettes.length) | 0] });
      }
    }
  }

  // 田畑(郊外の緑パッチ)
  const fieldGeo = new THREE.PlaneGeometry(1, 1);
  const fieldColors = [0x7da05e, 0x8fae6a, 0x6d9455, 0xa3b578];
  const fields = [];
  for (let s = L * 0.6; s < L - 20; s += 26 + rand() * 30) {
    const [px, pz] = path.getPoint(s);
    const [tx, tz] = path.getTangent(s);
    const nx = -tz, nz = tx;
    for (const side of [-1, 1]) {
      if (rand() < 0.45) continue;
      const lat = side * ((side < 0 ? leftWidthAt(s) : rightWidthAt(s)) + 14 + rand() * 26);
      const x = px + nx * lat, z = pz + nz * lat;
      if (isExcluded(x, z)) continue;
      fields.push({ x, z, w: 18 + rand() * 22, d: 14 + rand() * 16, ry: Math.atan2(tx, tz), color: fieldColors[(rand() * 4) | 0] });
    }
  }

  // ---- InstancedMesh 構築(色付き) ----
  const makeInstanced = (geo, list, getMatrix) => {
    if (!list.length) return null;
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    list.forEach((it, i) => {
      getMatrix(it, v, e, sc);
      q.setFromEuler(e);
      m.compose(v, q, sc);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, new THREE.Color(it.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
    return mesh;
  };

  makeInstanced(boxGeo, items, (it, v, e, sc) => {
    v.set(it.x, 0, it.z);
    e.set(0, it.ry, 0);
    sc.set(it.w, it.h, it.d);
  });
  makeInstanced(boxGeo, roofItems, (it, v, e, sc) => {
    v.set(it.x, it.y, it.z);
    e.set(0, it.ry, 0);
    sc.set(it.w, it.h, it.d);
  });
  makeInstanced(fieldGeo, fields, (it, v, e, sc) => {
    v.set(it.x, 0.06, it.z);
    e.set(-Math.PI / 2, 0, it.ry);
    sc.set(it.w, it.d, 1);
  });

  return { count: items.length };
}
