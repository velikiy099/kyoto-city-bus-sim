import * as THREE from 'three';
import { halfWidthAt } from '../route/routeData.js';

/** 停留所名の看板テクスチャ */
function makeSignTexture(name) {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 96;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#f4f6f2';
  ctx.fillRect(0, 0, 256, 96);
  ctx.fillStyle = '#1e7a4f';
  ctx.fillRect(0, 0, 256, 26);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('京都市バス', 128, 13);
  ctx.fillStyle = '#111';
  const size = name.length > 9 ? 21 : 26;
  ctx.font = `bold ${size}px sans-serif`;
  ctx.fillText(name, 128, 60, 244);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const paxColors = [0x546a7b, 0x7b5a4e, 0x4e6a52, 0x6a5a7b, 0x3d5a80, 0x8a6d3b];

/**
 * 停留所(ポール・停止線・待ち客)を生成
 * 返り値: { setWaiting(i, n), boardOne(i), stopLatOffset }
 */
export function buildStops(scene, path, stops) {
  const group = new THREE.Group();
  scene.add(group);
  const paxGeo = new THREE.CapsuleGeometry(0.26, 0.95, 3, 8);
  const paxMats = paxColors.map((c) => new THREE.MeshLambertMaterial({ color: c }));
  const waiting = []; // i -> [mesh...]

  stops.forEach((stop, i) => {
    const HW = halfWidthAt(stop.s); // 片道2車線以上の区間ではその路肩(縁石)基準で配置
    const [px, pz] = path.getPoint(stop.s);
    const [tx, tz] = path.getTangent(stop.s);
    const nx = -tz, nz = tx; // lateral 正方向(右)
    const at = (lat, along = 0) => [px + nx * lat + tx * along, pz + nz * lat + tz * along];

    // ポール(歩道上・進行方向左)
    const poleLat = -(HW + 1.1);
    const [poleX, poleZ] = at(poleLat);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 2.4, 8),
      new THREE.MeshLambertMaterial({ color: 0x9a9d9a })
    );
    pole.position.set(poleX, 1.2, poleZ);
    group.add(pole);

    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 0.06, 20),
      new THREE.MeshLambertMaterial({ color: 0x1e7a4f })
    );
    disc.rotation.x = Math.PI / 2;
    disc.rotation.z = Math.atan2(tx, tz);
    disc.position.set(poleX, 2.55, poleZ);
    group.add(disc);

    // 名前看板(両面)
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.56),
      new THREE.MeshBasicMaterial({ map: makeSignTexture(stop.name), side: THREE.DoubleSide })
    );
    sign.position.set(poleX, 1.75, poleZ);
    sign.rotation.y = Math.atan2(nx, nz); // 道路側を向く
    group.add(sign);

    // 停止線(路面・左端車線のみ)
    const lineW = Math.min(HW - 0.4, 3.4);
    const lineGeo = new THREE.PlaneGeometry(lineW, 0.35);
    const line = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }));
    const [lx, lz] = at(-(HW - 0.35 - lineW / 2), 1.2);
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = -Math.atan2(tx, tz);
    line.position.set(lx, 0.03, lz);
    group.add(line);

    // 「バス」路面標示風の枠
    const zone = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16 })
    );
    const [zx, zz] = at(-HW + 1.5, -3);
    zone.rotation.x = -Math.PI / 2;
    zone.rotation.z = -Math.atan2(tx, tz);
    zone.position.set(zx, 0.025, zz);
    group.add(zone);

    waiting.push({ at, HW, meshes: [] });
  });

  return {
    /** 待ち客を n 人表示 */
    setWaiting(i, n) {
      const w = waiting[i];
      while (w.meshes.length > n) group.remove(w.meshes.pop());
      while (w.meshes.length < n) {
        const k = w.meshes.length;
        const m = new THREE.Mesh(paxGeo, paxMats[(i * 3 + k) % paxMats.length]);
        const [x, z] = w.at(-(w.HW + 0.9) + (k % 2) * 0.55, -1.1 - Math.floor(k / 2) * 0.75);
        m.position.set(x, 0.75, z);
        group.add(m);
        w.meshes.push(m);
      }
    },
  };
}
