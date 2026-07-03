import * as THREE from 'three';
import { CFG } from '../config.js';
import { route, halfWidthAt } from '../route/routeData.js';

const mat = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, ...opts });

/**
 * 川(鴨川・桂川)・橋・遠景の山・街路樹
 * 川は bridges の s 位置で経路と直交する帯として描く。
 */
export function buildNature(scene, path) {
  const g = new THREE.Group();
  scene.add(g);
  const exclusions = [];

  // ---- 川と橋 ----
  for (const br of route.bridges) {
    const [px, pz] = path.getPoint(br.s);
    const [tx, tz] = path.getTangent(br.s);
    const across = Math.atan2(tx, tz); // 経路方位
    const w = Math.max(24, br.length * 0.85); // 川幅

    // 川面(道路の左右に2枚 — 道路帯とは重ねない。地面 y=-0.05 より上)
    const nx = -tz, nz = tx; // 経路の横方向
    for (const side of [-1, 1]) {
      const water = new THREE.Mesh(new THREE.PlaneGeometry(340, w), mat(0x5d8fb5));
      water.rotation.x = -Math.PI / 2;
      water.rotation.z = -across;
      const off = side * (340 / 2 + 7);
      water.position.set(px + nx * off, 0.015, pz + nz * off);
      g.add(water);

      // 土手(両岸の緑帯)も左右分割
      for (const bankSide of [-1, 1]) {
        const bank = new THREE.Mesh(new THREE.PlaneGeometry(340, 9), mat(0x7ba15e));
        bank.rotation.x = -Math.PI / 2;
        bank.rotation.z = -across;
        bank.position.set(
          px + nx * off + tx * bankSide * (w / 2 + 4.5),
          0.025,
          pz + nz * off + tz * bankSide * (w / 2 + 4.5)
        );
        g.add(bank);
      }
    }

    // 橋桁(路面より確実に下げて z-fight を防ぐ)と欄干
    const deck = new THREE.Mesh(new THREE.BoxGeometry(11, 0.8, w + 10), mat(0x8f9499));
    deck.position.set(px, -0.48, pz);
    deck.rotation.y = across;
    g.add(deck);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.15, w + 10), mat(0xdfe3e6));
      const nx = -tz, nz = tx;
      rail.position.set(px + nx * side * 5.1, 0.85, pz + nz * side * 5.1);
      rail.rotation.y = across;
      g.add(rail);
    }

    // 川の上には建物を置かない
    exclusions.push({ x: px, z: pz, r: 340 });
  }

  // ---- 遠景の山(北・東・西 — 京都盆地) ----
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of path.points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const cx = (minX + maxX) / 2;
  const mountainMat = mat(0x6d8577);
  const mk = (x, z, r, h) => {
    const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mountainMat);
    m.position.set(x, 0, z);
    g.add(m);
  };
  // 北山(二条駅の北)
  for (let i = 0; i < 6; i++) mk(cx - 900 + i * 420, minZ - 750 - (i % 2) * 160, 520 + (i % 3) * 130, 260 + (i % 2) * 110);
  // 東山(左手)
  for (let i = 0; i < 7; i++) mk(maxX + 950 + (i % 2) * 200, minZ + 300 + i * 640, 480 + (i % 3) * 120, 230 + (i % 3) * 80);
  // 西山(右手)
  for (let i = 0; i < 6; i++) mk(minX - 980 - (i % 2) * 240, minZ + 500 + i * 700, 560 + (i % 3) * 140, 280 + (i % 2) * 100);

  // ---- 街路樹(市街地区間の歩道、InstancedMesh) ----
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 2.6, 5);
  trunkGeo.translate(0, 1.3, 0);
  const crownGeo = new THREE.SphereGeometry(1.5, 6, 5);
  crownGeo.translate(0, 3.6, 0);
  const items = [];
  for (let s = 40; s < path.length * 0.62; s += 42) {
    for (const side of [-1, 1]) {
      if (((s / 42) | 0) % 2 === (side === -1 ? 0 : 1)) continue; // 互い違い
      const [px, pz] = path.getPoint(s);
      const [tx, tz] = path.getTangent(s);
      const lat = side * (halfWidthAt(s) + 2.4); // 複数車線区間は広い道路幅に合わせて外側へ
      items.push([px + -tz * lat, pz + tx * lat]);
    }
  }
  const place = (geo, color) => {
    const mesh = new THREE.InstancedMesh(geo, mat(color), items.length);
    const m = new THREE.Matrix4();
    items.forEach(([x, z], i) => {
      m.makeTranslation(x, 0, z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    g.add(mesh);
  };
  place(trunkGeo, 0x6b4f3a);
  place(crownGeo, 0x4e7a3d);

  return exclusions;
}
