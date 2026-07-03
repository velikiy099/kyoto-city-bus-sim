import * as THREE from 'three';
import { makeRibbon } from './road.js';

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
  const sFrom = spec.fromS ?? spec.s - 30;
  const sTo = spec.toS ?? spec.s + 30;
  scene.add(new THREE.Mesh(makeRibbon(path, -8.8, 8.8, 0.22, sFrom, sTo, 2), deckMat));
  scene.add(new THREE.Mesh(makeRibbon(path, -9.25, -8.75, 0.92, sFrom, sTo, 2), mat(0xc8ced2)));
  scene.add(new THREE.Mesh(makeRibbon(path, 8.75, 9.25, 0.92, sFrom, sTo, 2), mat(0xc8ced2)));
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

  for (const z of [-70, -35, 0, 35, 70]) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(width * 0.55, deckY - 0.55, 1.15), mat(0xb8b8b1));
    pier.position.set(0, (deckY - 0.55) / 2, z);
    g.add(pier);
  }

  for (const offset of [-2.7, 2.7]) addRailPair(g, offset, deckY + 0.72, length - 10, 1.45);
  scene.add(g);
}

export function buildRailways(scene, path, structures = []) {
  for (const spec of structures) {
    if (spec.kind === 'conventional-underpass') buildConventionalUnderpass(scene, path, spec);
    else if (spec.kind === 'shinkansen-viaduct') buildShinkansenViaduct(scene, path, spec);
  }
  return { count: structures.length };
}
