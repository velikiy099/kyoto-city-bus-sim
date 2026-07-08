import * as THREE from 'three';
import { CFG } from '../config.js';

/**
 * ルート外の周辺道路(景観用)。heading は atan2(dx,dz) 規約(0=南北)。
 * 千本通北側(二条駅前交差点)は road.js の右左折交差点スタブ(turnIntersections)が
 * 描画するようになったため削除済み。追加したい景観道路があればここに定義する。
 */
const EXTRA_ROADS = [];

export function buildExtraRoads(scene) {
  const g = new THREE.Group();
  scene.add(g);
  for (const r of EXTRA_ROADS) {
    const grp = new THREE.Group();
    grp.position.set(r.x, 0, r.z);
    grp.rotation.y = r.heading;
    g.add(grp);

    // 路面(ローカル z 軸=道路軸)
    const surf = new THREE.Mesh(
      new THREE.PlaneGeometry(r.width, r.length),
      new THREE.MeshLambertMaterial({ color: CFG.colors.road })
    );
    surf.rotation.x = -Math.PI / 2;
    surf.position.y = 0.004;
    grp.add(surf);

    // 区画線(交差点の内側 24m には引かない)
    const lineLen = r.length - 24;
    const lineOff = -12; // 北へ寄せる(交差点は南端)
    const center = new THREE.Mesh(
      new THREE.PlaneGeometry(0.16, lineLen),
      new THREE.MeshBasicMaterial({ color: 0xd8a017 })
    );
    center.rotation.x = -Math.PI / 2;
    center.position.set(0, 0.02, lineOff);
    grp.add(center);
    for (const side of [-1, 1]) {
      const edge = new THREE.Mesh(
        new THREE.PlaneGeometry(0.14, lineLen),
        new THREE.MeshBasicMaterial({ color: 0xe8e8e8 })
      );
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(side * (r.width / 2 - 0.45), 0.02, lineOff);
      grp.add(edge);

      // 縁石+歩道(交差点部は空ける)
      const curb = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, lineLen),
        new THREE.MeshLambertMaterial({ color: CFG.colors.curb })
      );
      curb.rotation.x = -Math.PI / 2;
      curb.position.set(side * (r.width / 2 + 0.25), 0.13, lineOff);
      grp.add(curb);
      const walk = new THREE.Mesh(
        new THREE.PlaneGeometry(2.6, lineLen),
        new THREE.MeshLambertMaterial({ color: 0xcfd2cc })
      );
      walk.rotation.x = -Math.PI / 2;
      walk.position.set(side * (r.width / 2 + 1.8), 0.1, lineOff);
      grp.add(walk);
    }
  }
  return g;
}
