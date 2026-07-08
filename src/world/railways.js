import * as THREE from 'three';
import { makeRibbon } from './road.js';
import { elevationAt, gradeAt, halfWidthAt } from '../route/routeData.js';

const mat = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, ...opts });

function at(path, s) {
  const [x, z] = path.getPoint(Math.max(0, Math.min(path.length - 0.1, s)));
  return { x, z };
}

function addRailPair(group, trackOffset, railY, railLength, railGauge = 1.35) {
  const sleeper = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.08, railLength), mat(0x5b4a3c));
  sleeper.position.set(trackOffset, railY - 0.06, 0);
  group.add(sleeper);
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, railLength), mat(0xcbd0d5));
    rail.position.set(trackOffset + side * railGauge / 2, railY, 0);
    group.add(rail);
  }
}

function addDeckRails(group, width, y, length) {
  for (const side of [-1, 1]) {
    const parapet = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.1, length), mat(0xbec5c9));
    parapet.position.set(side * (width / 2 - 0.3), y, 0);
    group.add(parapet);
  }
}

function buildConventionalUnderpass(scene, path, spec) {
  const p = at(path, spec.s);
  const g = new THREE.Group();
  g.position.set(p.x, 0, p.z);
  g.rotation.y = spec.heading;

  const length = spec.length ?? 180;
  const width = spec.width ?? 28;
  const bed = new THREE.Mesh(new THREE.BoxGeometry(width, 0.35, length), mat(0x3f464b));
  bed.position.y = -0.34;
  g.add(bed);

  const wallMat = mat(0x8c9295);
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.0, length), wallMat);
    wall.position.set(side * (width / 2 + 0.25), 0.35, 0);
    g.add(wall);
  }

  const trackCount = spec.trackCount ?? 6;
  const spacing = 3.2;
  const first = -((trackCount - 1) * spacing) / 2;
  for (let i = 0; i < trackCount; i++) addRailPair(g, first + i * spacing, -0.05, length - 8);

  scene.add(g);

  const deckMat = mat(0x5f646a);
  const railFrom = spec.fromS ?? spec.s - 30;
  const railTo = spec.toS ?? spec.s + 30;
  // 高架桁の範囲(bridgeFromS/bridgeToS があれば八条通の先まで延伸)
  const sFrom = spec.bridgeFromS ?? railFrom;
  const sTo = spec.bridgeToS ?? railTo;
  const aIn = spec.approachIn ?? 52;
  const aOut = spec.approachOut ?? 52;
  const deckHalf = (spec.deckHalf ?? 7.2) + 3.4; // 車道+橋上歩道の外縁
  // デッキ・欄干(makeRibbon が標高追従するので路面と一緒に持ち上がる)
  scene.add(new THREE.Mesh(makeRibbon(path, -deckHalf, deckHalf, 0.22, sFrom, sTo, 2), deckMat));
  scene.add(new THREE.Mesh(makeRibbon(path, -(deckHalf + 0.25), -(deckHalf - 0.25), 0.92, sFrom - aIn, sTo + aOut, 2), mat(0xc8ced2)));
  scene.add(new THREE.Mesh(makeRibbon(path, deckHalf - 0.25, deckHalf + 0.25, 0.92, sFrom - aIn, sTo + aOut, 2), mat(0xc8ced2)));

  // 道路が持ち上がる場合(跨線橋): 桁とアプローチ擁壁で下部を埋める
  if ((spec.roadLayer ?? 0) > 0) {
    const concrete = mat(0x9aa0a4);
    const alongPitchBox = (sMid, boxLen, height, width = 17.4) => {
      const [px, pz] = path.getPoint(sMid);
      const [tx, tz] = path.getTangent(sMid);
      const grp = new THREE.Group();
      grp.position.set(px, 0, pz);
      grp.rotation.y = Math.atan2(tx, tz);
      const box = new THREE.Mesh(new THREE.BoxGeometry(width, height, boxLen), concrete);
      box.rotation.x = -Math.atan(gradeAt(sMid));
      box.position.y = elevationAt(sMid) - height / 2 + 0.1;
      grp.add(box);
      scene.add(grp);
    };
    // 桁(デッキ直下)
    alongPitchBox((sFrom + sTo) / 2, sTo - sFrom + 2, 1.1);
    // アプローチ擁壁(smoothstep 勾配に沿うよう約45mごとに分割)
    for (const [rampFrom, rampLen] of [[sFrom - aIn, aIn], [sTo, aOut]]) {
      const n = Math.max(1, Math.ceil(rampLen / 45));
      for (let k = 0; k < n; k++) {
        const seg = rampLen / n;
        alongPitchBox(rampFrom + seg * (k + 0.5), seg + 1, 0.9);
      }
    }
    // 橋脚(掘割の線路と高架下の交差道路は避ける: 桁端と線路脇)
    for (const sPier of [sFrom + 2, railTo + 6, sTo - 2]) {
      const [px, pz] = path.getPoint(sPier);
      const [tx, tz] = path.getTangent(sPier);
      const pier = new THREE.Mesh(new THREE.BoxGeometry(15, elevationAt(sPier), 1.4), concrete);
      pier.position.set(px, elevationAt(sPier) / 2 - 0.8, pz);
      pier.rotation.y = Math.atan2(tx, tz);
      scene.add(pier);
    }

    // 側道(両脇の1車線は地上レベル)— 線路の掘割で分断される
    if (spec.bridgeFromS != null) {
      const laneW = 3.2;
      const inner = deckHalf + 0.6; // 高架縁のすぐ外
      const roadMat = mat(0x565a60);
      const curbMat = mat(0xb9bdb9);
      const walkMat = mat(0xcfd2cc);
      const lineMat = mat(0xe8e8e8);
      for (const [a, b] of [[sFrom - aIn, railFrom - 5], [railTo + 5, sTo + aOut + 30]]) {
        if (b - a < 12) continue;
        for (const side of [-1, 1]) {
          const lat = (v) => side * v;
          const span = (u, v, y, mtl, step = 3) =>
            scene.add(new THREE.Mesh(makeRibbon(path, Math.min(lat(u), lat(v)), Math.max(lat(u), lat(v)), y, a, b, step, false), mtl));
          span(inner, inner + laneW, 0.012, roadMat);
          span(inner + 0.15, inner + 0.3, 0.026, lineMat); // 内側路側線
          span(inner + laneW - 0.3, inner + laneW - 0.15, 0.026, lineMat);
          span(inner + laneW, inner + laneW + 0.5, 0.13, curbMat);
          span(inner + laneW + 0.5, inner + laneW + 3.0, 0.1, walkMat);
        }
      }
      // 高架下の舗装(八条通が下をくぐる区間)
      scene.add(new THREE.Mesh(makeRibbon(path, -inner, inner, 0.008, railTo + 5, sTo + 8, 3, false), mat(0x51565c)));
    }
  }
}

function buildShinkansenViaduct(scene, path, spec) {
  const p = at(path, spec.s);
  const g = new THREE.Group();
  g.position.set(p.x, 0, p.z);
  g.rotation.y = spec.heading;

  const length = spec.length ?? 190;
  const width = spec.width ?? 16;
  const deckY = 8.2;
  const girder = new THREE.Mesh(new THREE.BoxGeometry(width, 1.05, length), mat(0xd7d9d6));
  girder.position.y = deckY;
  g.add(girder);
  addDeckRails(g, width, deckY + 0.85, length);

  // 橋脚(道路上には立てない — 高架は線路が道路と直交して跨ぐ)
  const clearHalf = halfWidthAt(spec.s) + 4;
  for (const z of [-70, -35, 0, 35, 70]) {
    if (Math.abs(z) < clearHalf) continue;
    const pier = new THREE.Mesh(new THREE.BoxGeometry(width * 0.55, deckY - 0.55, 1.15), mat(0xb8b8b1));
    pier.position.set(0, (deckY - 0.55) / 2, z);
    g.add(pier);
  }

  for (const offset of [-2.7, 2.7]) addRailPair(g, offset, deckY + 0.72, length - 10, 1.45);
  scene.add(g);
}

/** 名神高速道路の高架(片道3車線・中央分離帯)。経路と斜めに交差する一般的な立体交差。 */
function buildExpresswayViaduct(scene, path, spec) {
  const p = at(path, spec.s);
  const g = new THREE.Group();
  g.position.set(p.x, 0, p.z);
  g.rotation.y = spec.heading;

  const length = spec.length ?? 210;
  const width = spec.width ?? 27;
  const deckY = 7.0;
  const girder = new THREE.Mesh(new THREE.BoxGeometry(width, 1.2, length), mat(0xaeb2ae));
  girder.position.y = deckY;
  g.add(girder);
  const deckTop = deckY + 0.62;
  const surf = new THREE.Mesh(new THREE.BoxGeometry(width - 1.2, 0.14, length), mat(0x4a4f55));
  surf.position.y = deckTop;
  g.add(surf);

  const lanesEachWay = spec.lanesEachWay ?? 3;
  const laneW = (width - 4) / (lanesEachWay * 2);
  for (let side of [-1, 1]) {
    for (let i = 1; i < lanesEachWay; i++) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.02, length - 6), mat(0xe8e8e8));
      line.position.set(side * (laneW * i + (side < 0 ? 1 : 0.5)), deckTop + 0.08, 0);
      g.add(line);
    }
  }
  const median = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, length), mat(0x8a9080));
  median.position.y = deckTop + 0.25;
  g.add(median);
  for (const side of [-1, 1]) {
    const parapet = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.05, length), mat(0xc4c8c4));
    parapet.position.set(side * (width / 2 - 0.2), deckTop + 0.5, 0);
    g.add(parapet);
  }

  // 橋脚(道路上には立てない — 高架は経路と斜めに交差する)
  const clearHalf = halfWidthAt(spec.s) + 5;
  for (const z of [-75, -38, 0, 38, 75]) {
    if (Math.abs(z) < clearHalf) continue;
    const pier = new THREE.Mesh(new THREE.BoxGeometry(width * 0.5, deckY - 0.6, 1.6), mat(0x9c9f9c));
    pier.position.set(0, (deckY - 0.6) / 2, z);
    g.add(pier);
  }
  scene.add(g);
}

export function buildRailways(scene, path, structures = []) {
  for (const spec of structures) {
    if (spec.kind === 'conventional-underpass') buildConventionalUnderpass(scene, path, spec);
    else if (spec.kind === 'shinkansen-viaduct') buildShinkansenViaduct(scene, path, spec);
    else if (spec.kind === 'expressway-viaduct') buildExpresswayViaduct(scene, path, spec);
  }
  return { count: structures.length };
}
