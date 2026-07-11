import * as THREE from "three";
import { leftWidthAt } from "../route/routeData.js";
import { loadProps } from "../util/propsLib.js";
import {
  terminusLotAnchor,
  terminusStopAnchor,
} from "../world/landmarks.js";

/** 停留所名の看板テクスチャ */
function makeSignTexture(name) {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 96;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#f4f6f2";
  ctx.fillRect(0, 0, 256, 96);
  ctx.fillStyle = "#1e7a4f";
  ctx.fillRect(0, 0, 256, 26);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("京都市バス", 128, 13);
  ctx.fillStyle = "#111";
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
  const waiting = []; // i -> [mesh...]

  // 待ち客(Blender製の人物モデル。服の色は PaxBody マテリアル差し替え)
  const paxMats = paxColors.map(
    (c) => new THREE.MeshLambertMaterial({ color: c }),
  );
  function makeWaitingPax(colorIdx, heading, k) {
    const holder = new THREE.Group();
    loadProps().then((lib) => {
      const fig = lib.getObjectByName("Passenger").clone(true);
      fig.position.set(0, 0, 0);
      fig.traverse((o) => {
        if (o.isMesh && o.material.name === "PaxBody")
          o.material = paxMats[colorIdx];
      });
      holder.add(fig);
    });
    holder.rotation.y = heading + (((k * 53) % 7) - 3) * 0.14; // 道路向き+ばらつき
    holder.scale.setScalar(0.92 + ((k * 37) % 5) * 0.035); // 身長ばらつき
    return holder;
  }

  stops.forEach((stop, i) => {
    // 久我石原町(終点)は道路上ではなく敷地内(landmarks.js の駐車場)に停車するため、
    // 道路上のポール・停止線・バスゾーン路面標示は作らない。待機/降車客の基準位置だけ
    // 敷地のシェルター付近(landmarks.js と共通のアンカー計算)に合わせる。
    if (stop.name === "久我石原町") {
      const lot = terminusLotAnchor(path);
      if (lot) {
        // 敷地は世界座標軸に揃っている(landmarks.js buildTerminus と同じ規約)。
        // バス停は敷地西端に置き、北向きのバスの東側(敷地内)で待てるようにする。
        const terminal = terminusStopAnchor(lot);
        const atLot = (lat, along = 0) => [
          terminal.x - lat,
          terminal.z + along,
        ];
        waiting.push({
          at: atLot,
          HW: 1.4,
          meshes: [],
          face: -Math.PI / 2, // 西(バス側)を向く。乗降後は東側の敷地内へ歩く
        });
        return;
      }
    }

    const HW = leftWidthAt(stop.s); // 進行方向左側の路肩(縁石)基準で配置
    const [px, pz] = path.getPoint(stop.s);
    const [tx, tz] = path.getTangent(stop.s);
    const nx = -tz,
      nz = tx; // lateral 正方向(右)
    const at = (lat, along = 0) => [
      px + nx * lat + tx * along,
      pz + nz * lat + tz * along,
    ];

    // ポール(道路端・進行方向左。歩道の有無によらず縁石すぐ外に置く)
    const poleLat = -(HW + 0.7);
    const [poleX, poleZ] = at(poleLat);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 2.4, 8),
      new THREE.MeshLambertMaterial({ color: 0x9a9d9a }),
    );
    pole.position.set(poleX, 1.2, poleZ);
    group.add(pole);

    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 0.06, 20),
      new THREE.MeshLambertMaterial({ color: 0x1e7a4f }),
    );
    disc.rotation.x = Math.PI / 2;
    disc.rotation.z = Math.atan2(tx, tz);
    disc.position.set(poleX, 2.55, poleZ);
    group.add(disc);

    // 名前看板(両面)
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.56),
      new THREE.MeshBasicMaterial({
        map: makeSignTexture(stop.name),
        side: THREE.DoubleSide,
      }),
    );
    sign.position.set(poleX, 1.75, poleZ);
    sign.rotation.y = Math.atan2(nx, nz); // 道路側を向く
    group.add(sign);

    // 停止線(路面・左端車線のみ)
    const lineW = Math.min(HW - 0.4, 3.4);
    const lineGeo = new THREE.PlaneGeometry(lineW, 0.35);
    const line = new THREE.Mesh(
      lineGeo,
      new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }),
    );
    const [lx, lz] = at(-(HW - 0.35 - lineW / 2), 1.2);
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = -Math.atan2(tx, tz);
    line.position.set(lx, 0.03, lz);
    group.add(line);

    // 「バス」路面標示風の枠
    const zone = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.16,
      }),
    );
    const [zx, zz] = at(-HW + 1.5, -3);
    zone.rotation.x = -Math.PI / 2;
    zone.rotation.z = -Math.atan2(tx, tz);
    zone.position.set(zx, 0.025, zz);
    group.add(zone);

    waiting.push({ at, HW, meshes: [], face: Math.atan2(nx, nz) }); // face: 車道向き
  });

  // ---- 降車客(ドア付近に現れ、バス停から歩いて離れていく) ----
  const walkers = []; // {mesh, vx, vz, life}
  const WALK_SPEED = 1.15; // [m/s]
  const WALK_LIFE = 6; // 消えるまでの秒数

  return {
    /** 待ち客を n 人表示 */
    setWaiting(i, n) {
      const w = waiting[i];
      while (w.meshes.length > n) group.remove(w.meshes.pop());
      while (w.meshes.length < n) {
        const k = w.meshes.length;
        const m = makeWaitingPax(
          (i * 3 + k) % paxMats.length,
          w.face,
          i * 7 + k,
        );
        const [x, z] = w.at(
          -(w.HW + 0.6) + (k % 2) * 0.5,
          -1.1 - Math.floor(k / 2) * 0.75,
        );
        m.position.set(x, 0, z);
        group.add(m);
        w.meshes.push(m);
      }
    },
    /** 降車客を1人スポーンし、道路から離れる向きへ歩かせる */
    spawnAlighting(i) {
      const w = waiting[i];
      if (!w) return;
      const along = (Math.random() - 0.5) * 3;
      const [x, z] = w.at(-(w.HW + 0.4), along);
      const awayAngle = w.face + Math.PI + (Math.random() - 0.5) * 0.7; // 車道と反対向き+ばらつき
      const holder = makeWaitingPax(
        (Math.random() * paxColors.length) | 0,
        awayAngle,
        Math.floor(Math.random() * 1000),
      );
      holder.rotation.y = awayAngle;
      holder.position.set(x, 0, z);
      group.add(holder);
      walkers.push({
        mesh: holder,
        vx: Math.sin(awayAngle) * WALK_SPEED,
        vz: Math.cos(awayAngle) * WALK_SPEED,
        life: WALK_LIFE,
      });
    },
    /** 降車客の徒歩アニメーションを進める(毎フレーム呼ぶ) */
    updateWalkers(dt) {
      for (let k = walkers.length - 1; k >= 0; k--) {
        const w = walkers[k];
        w.mesh.position.x += w.vx * dt;
        w.mesh.position.z += w.vz * dt;
        w.life -= dt;
        if (w.life <= 0) {
          group.remove(w.mesh);
          walkers.splice(k, 1);
        }
      }
    },
  };
}
