import * as THREE from 'three';
import { CFG } from '../config.js';
import { elevationAt } from '../route/routeData.js';

/**
 * 経路に沿った帯(リボン)ジオメトリを生成
 * latFrom/latTo: 横偏差(左が負) / sStep: サンプリング間隔
 */
export function makeRibbon(path, latFrom, latTo, y, sFrom = 0, sTo = null, sStep = 4) {
  sTo = sTo ?? path.length;
  const positions = [];
  const indices = [];
  let row = 0;
  for (let s = sFrom; s <= sTo + 0.001; s += sStep) {
    const ss = Math.min(s, sTo);
    const [px, pz] = path.getPoint(ss);
    const [tx, tz] = path.getTangent(ss);
    // 左法線 = (tz, -tx) が lateral 負方向(path.closestS の符号系と整合)
    const nx = -tz, nz = tx; // lateral 正(右)方向
    const ye = y + elevationAt(ss); // 跨線橋区間は路面ごと持ち上げる
    positions.push(px + nx * latFrom, ye, pz + nz * latFrom);
    positions.push(px + nx * latTo, ye, pz + nz * latTo);
    if (row > 0) {
      const b = row * 2;
      indices.push(b - 2, b - 1, b, b - 1, b + 1, b);
    }
    row++;
    if (ss >= sTo) break;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function roadSectionsFor(path, route) {
  if (route?.roadSections?.length) return route.roadSections;
  return [{ from: 0, to: path.length, lanes: 2 }];
}

function roadHalfWidth(lanes = 2) {
  return Math.max(CFG.road.halfWidth, lanes * 1.6 + 0.8);
}

function addLine(g, path, lat, y, color, sFrom, sTo, width = 0.06) {
  const mat = new THREE.MeshLambertMaterial({ color });
  g.add(new THREE.Mesh(makeRibbon(path, lat - width, lat + width, y, sFrom, sTo, 3), mat));
}

function addIntersections(g, path, intersections) {
  const roadMat = new THREE.MeshLambertMaterial({ color: CFG.colors.road });
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.52 });
  for (const ix of intersections ?? []) {
    const s = Math.max(0, Math.min(path.length - 0.1, ix.s));
    const [px, pz] = path.getPoint(s);
    const width = Math.max(5.5, ix.width ?? 7);
    const length = Math.max(28, ix.length ?? 54);
    const elev = elevationAt(s);
    const stub = new THREE.Mesh(new THREE.PlaneGeometry(length, width), roadMat);
    stub.rotation.x = -Math.PI / 2;
    stub.rotation.z = -(ix.heading ?? 0);
    stub.position.set(px, 0.006 + elev, pz);
    g.add(stub);

    const [tx, tz] = path.getTangent(s);
    const cw = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(9, roadHalfWidth(ix.lanes ?? 2) * 2), 2.8), lineMat);
    cw.rotation.x = -Math.PI / 2;
    cw.rotation.z = -Math.atan2(tx, tz);
    cw.position.set(px, 0.034 + elev, pz);
    g.add(cw);
  }
}

/** 道路一式(路面・センターライン・路側線・縁石・歩道)を返す */
export function buildRoad(path, route = null) {
  const g = new THREE.Group();
  const C = CFG.colors;
  const mat = (color) => new THREE.MeshLambertMaterial({ color });
  const sections = roadSectionsFor(path, route);

  for (const section of sections) {
    const from = Math.max(0, section.from ?? 0);
    const to = Math.min(path.length, section.to ?? path.length);
    if (to <= from) continue;
    const lanes = Math.max(2, Number(section.lanes) || 2);
    const HW = roadHalfWidth(lanes);

    // 路面
    g.add(new THREE.Mesh(makeRibbon(path, -HW, HW, 0.0, from, to), mat(C.road)));

    // センターライン(黄色実線)
    g.add(new THREE.Mesh(makeRibbon(path, -0.08, 0.08, 0.024, from, to, 3), mat(0xd8a017)));

    // 車線境界(方向別に1車線を超える場合のみ白線)
    const leftLanes = Math.max(1, Math.floor(lanes / 2));
    const rightLanes = Math.max(1, lanes - leftLanes);
    const usableLeft = HW - 0.55;
    const usableRight = HW - 0.55;
    for (let i = 1; i < leftLanes; i++) addLine(g, path, -(usableLeft * i) / leftLanes, 0.026, C.roadLine, from, to, 0.035);
    for (let i = 1; i < rightLanes; i++) addLine(g, path, (usableRight * i) / rightLanes, 0.026, C.roadLine, from, to, 0.035);

    // 路側線(白実線)
    g.add(new THREE.Mesh(makeRibbon(path, -HW + 0.35, -HW + 0.5, 0.025, from, to, 3), mat(C.roadLine)));
    g.add(new THREE.Mesh(makeRibbon(path, HW - 0.5, HW - 0.35, 0.025, from, to, 3), mat(C.roadLine)));

    // 縁石
    g.add(new THREE.Mesh(makeRibbon(path, -HW - 0.5, -HW, 0.13, from, to), mat(C.curb)));
    g.add(new THREE.Mesh(makeRibbon(path, HW, HW + 0.5, 0.13, from, to), mat(C.curb)));

    // 歩道
    g.add(new THREE.Mesh(makeRibbon(path, -HW - 3.2, -HW - 0.5, 0.1, from, to), mat(0xcfd2cc)));
    g.add(new THREE.Mesh(makeRibbon(path, HW + 0.5, HW + 3.2, 0.1, from, to), mat(0xcfd2cc)));
  }

  addIntersections(g, path, route?.intersections ?? []);

  return g;
}

/** 地面(経路バウンディングボックス+マージンの1枚板) */
export function buildGround(path) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of path.points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const m = 600;
  const w = maxX - minX + m * 2, h = maxZ - minZ + m * 2;
  const geo = new THREE.PlaneGeometry(w, h);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: CFG.colors.ground }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((minX + maxX) / 2, -0.05, (minZ + maxZ) / 2);
  return mesh;
}
