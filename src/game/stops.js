import * as THREE from "three";
import { elevationAt } from "../route/routeData.js";
import { terrainHeightAtWorld } from "../world/declarative/continuousTerrain.js";
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

function addShelter(group, x, z, tx, tz, nx, nz, baseY, side = -1) {
  const shelter = new THREE.Group();
  shelter.position.set(x + nx * side * 1.4, baseY, z + nz * side * 1.4);
  shelter.rotation.y = Math.atan2(tx, tz);
  const postMat = new THREE.MeshLambertMaterial({ color: 0x59666a });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x8b9897 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 2.25, 8), postMat);
  for (const px of [-0.72, 0.72]) {
    for (const pz of [-1.25, 1.25]) {
      const p = post.clone();
      p.position.set(px, 1.12, pz);
      shelter.add(p);
    }
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.12, 3.2), roofMat);
  roof.position.y = 2.28;
  shelter.add(roof);
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(1.75, 1.8, 0.06),
    new THREE.MeshLambertMaterial({ color: 0xb8c2c1, transparent: true, opacity: 0.58 }),
  );
  back.position.set(0, 1.0, -1.25);
  shelter.add(back);
  group.add(shelter);
}

function addStopFrame(group, x, z, tx, tz, baseY) {
  const nx = -tz, nz = tx;
  const halfWidth = 1.3;
  const halfLength = 6;
  const corners = [[-halfWidth, -halfLength], [halfWidth, -halfLength], [halfWidth, halfLength], [-halfWidth, halfLength]]
    .map(([lateral, along]) => new THREE.Vector3(
      x + nx * lateral + tx * along,
      baseY + 0.04,
      z + nz * lateral + tz * along,
    ));
  corners.push(corners[0].clone());
  const geometry = new THREE.BufferGeometry().setFromPoints(corners);
  const frame = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xffffff }));
  frame.name = "bus-stop-frame";
  group.add(frame);
}

/**
 * 停留所(ポール・停止線・待ち客)を生成
 * 返り値: { setWaiting(i, n), spawnAlighting(i), updateWalkers(dt) }
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
    const terminal = stop.name === "久我石原町"
      ? terminusStopAnchor(terminusLotAnchor(path))
      : null;
    // The stopping pose is the single source for the stop marker, pole,
    // shelter and frame. OSM platform coordinates are metadata only.
    const pose = stop.pose ?? {};
    const HW = 1.5;
    const baseY = terminal
      ? terrainHeightAtWorld(terminal.x, terminal.z)
      : (pose.y ?? elevationAt(stop.s));
    const [px, pz] = terminal
      ? [terminal.x, terminal.z]
      : (pose.x != null ? [pose.x, pose.z] : path.getPoint(stop.s));
    const [tx, tz] = terminal
      ? [Math.sin(terminal.heading), Math.cos(terminal.heading)]
      : (pose.heading != null
        ? [Math.sin(pose.heading), Math.cos(pose.heading)]
        : path.getTangent(stop.s));
    const nx = -tz,
      nz = tx; // lateral 正方向(右)
    const side = terminal ? -1 : (stop.anchor?.side ?? -1);
    const [poleX, poleZ] = terminal
      ? [terminal.x, terminal.z]
      : [stop.anchor?.x ?? px + nx * side * (HW + 0.9), stop.anchor?.z ?? pz + nz * side * (HW + 0.9)];
    const waitingAt = (_lat, along = 0) => [
      poleX + nx * side * Math.abs(_lat),
      poleZ + nz * side * Math.abs(_lat) + tz * along,
    ];

    // ポール(道路端・進行方向左。歩道の有無によらず縁石すぐ外に置く)
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 2.4, 8),
      new THREE.MeshLambertMaterial({ color: 0x9a9d9a }),
    );
    pole.position.set(poleX, baseY + 1.2, poleZ);
    group.add(pole);

    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 0.06, 20),
      new THREE.MeshLambertMaterial({ color: 0x1e7a4f }),
    );
    disc.rotation.x = Math.PI / 2;
    disc.rotation.z = Math.atan2(tx, tz);
    disc.position.set(poleX, baseY + 2.55, poleZ);
    group.add(disc);

    // 名前看板(両面)
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.56),
      new THREE.MeshBasicMaterial({
        map: makeSignTexture(stop.name),
        side: THREE.DoubleSide,
      }),
    );
    sign.position.set(poleX, baseY + 1.75, poleZ);
    sign.rotation.y = Math.atan2(-side * nx, -side * nz); // 車道側を向く
    group.add(sign);

    if (stop.shelter) addShelter(group, poleX, poleZ, tx, tz, nx, nz, baseY, side);
    addStopFrame(group, px, pz, tx, tz, baseY);

    waiting.push({
      at: waitingAt,
      HW,
      baseY,
      meshes: [],
      face: Math.atan2(-side * nx, -side * nz),
    }); // face: 車道向き
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
        m.position.set(x, w.baseY ?? 0, z);
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
      holder.position.set(x, w.baseY ?? 0, z);
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
