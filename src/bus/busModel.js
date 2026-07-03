import * as THREE from 'three';
import { CFG } from '../config.js';

/**
 * 京都市バス風 車体モデル(プリミティブ構成)
 * 原点=後軸中心、前方=+z。root.rotation.y に heading をそのまま入れる。
 * root > body(ロール/ピッチ演出) > 車体パーツ
 */
export function createBusModel() {
  const B = CFG.bus;
  const C = CFG.colors;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const bodyCenterZ = B.length / 2 - B.rearOverhang;
  const mat = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, ...opts });
  const decalMat = (color) => mat(color, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x2c3844, transparent: true, opacity: 0.55 });
  const addSideBand = (y, h, color) => {
    const material = decalMat(color);
    for (const [x, rotY] of [
      [B.width / 2 + 0.006, Math.PI / 2],
      [-(B.width / 2 + 0.006), -Math.PI / 2],
    ]) {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(B.length, h), material);
      side.position.set(x, y, bodyCenterZ);
      side.rotation.y = rotY;
      body.add(side);
    }
    for (const [z, rotY] of [
      [B.length - B.rearOverhang + 0.006, 0],
      [-B.rearOverhang - 0.006, Math.PI],
    ]) {
      const end = new THREE.Mesh(new THREE.PlaneGeometry(B.width, h), material);
      end.position.set(0, y, z);
      end.rotation.y = rotY;
      body.add(end);
    }
  };

  // 車体(クリーム)— 窓帯より上の屋根部と下半分に分割(運転席視点の視界確保)
  const lower = new THREE.Mesh(new THREE.BoxGeometry(B.width, 1.05, B.length), mat(C.busCream));
  lower.position.set(0, 1.075, bodyCenterZ);
  body.add(lower);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(B.width, 0.5, B.length), mat(C.busCream));
  roof.position.set(0, B.height - 0.25, bodyCenterZ);
  body.add(roof);
  // 窓柱(前後の柱)
  for (const z of [-B.rearOverhang + 0.15, B.length - B.rearOverhang - 0.15]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(B.width, B.height - 2.1, 0.3), mat(C.busCream));
    pillar.position.set(0, 1.6 + (B.height - 2.1) / 2 - 0.55, z);
    body.add(pillar);
  }

  // 窓帯(半透明ガラス)
  const winH = B.height - 0.5 - 1.6; // 屋根と下半分の間
  const win = new THREE.Mesh(new THREE.BoxGeometry(B.width - 0.06, winH, B.length - 0.5), glassMat);
  win.position.set(0, 1.6 + winH / 2, bodyCenterZ);
  body.add(win);

  // 緑帯(窓下・京都市バスの「みどりのバス」)
  addSideBand(1.42, 0.34, C.busGreen);
  addSideBand(1.16, 0.12, C.busDarkGreen);

  // 裾(スカート・濃緑)
  addSideBand(0.55, 0.35, C.busGreen);

  // 前後バンパー
  for (const [z, w] of [[B.length - B.rearOverhang + 0.03, B.width], [-B.rearOverhang - 0.03, B.width]]) {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(w, 0.28, 0.12), mat(0x3a3f45));
    bumper.position.set(0, 0.5, z);
    body.add(bumper);
  }

  // 方向幕(前面上部): 「18 横大路 久我石原町」
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 128;
  const cx2 = cv.getContext('2d');
  cx2.fillStyle = '#0d1116';
  cx2.fillRect(0, 0, 512, 128);
  cx2.fillStyle = '#ffffff';
  cx2.font = 'bold 92px sans-serif';
  cx2.textBaseline = 'middle';
  cx2.fillText('18', 28, 70);
  cx2.font = 'bold 15px sans-serif';
  cx2.fillStyle = '#ffb43c';
  cx2.textAlign = 'center';
  cx2.fillText('横 大 路', 330, 30);
  cx2.font = 'bold 52px sans-serif';
  cx2.fillText('久我石原町', 330, 82);
  const signTex = new THREE.CanvasTexture(cv);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const headsign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 0.44),
    new THREE.MeshBasicMaterial({ map: signTex })
  );
  headsign.position.set(0, 2.72, B.length - B.rearOverhang + 0.04);
  body.add(headsign);
  // 側面の系統番号プレート(前扉横)
  const sideSign = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.3), new THREE.MeshBasicMaterial({ map: signTex }));
  sideSign.position.set(-(B.width / 2 + 0.02), 2.35, B.wheelbase + 0.6);
  sideSign.rotation.y = -Math.PI / 2;
  body.add(sideSign);

  // タイヤ(前2輪は操舵で回す)
  const tireGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.32, 18);
  tireGeo.rotateZ(Math.PI / 2); // 軸を x に
  const tireMat = mat(0x1c1e20);
  const wheels = [];
  for (const [x, z, steered] of [
    [-(B.width / 2 - 0.22), 0, false], [B.width / 2 - 0.22, 0, false],
    [-(B.width / 2 - 0.22), B.wheelbase, true], [B.width / 2 - 0.22, B.wheelbase, true],
  ]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.46, z);
    const tire = new THREE.Mesh(tireGeo, tireMat);
    pivot.add(tire);
    root.add(pivot);
    wheels.push({ pivot, tire, steered });
  }

  // 運転席まわり(右ハンドル: 進行方向右 = -x)
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.36, 0.5), mat(0x30353a));
  dash.position.set(-0.8, 1.48, B.length - B.rearOverhang - 0.55);
  body.add(dash);
  const wheelCol = new THREE.Group();
  wheelCol.position.set(-0.8, 1.52, B.length - B.rearOverhang - 0.8);
  wheelCol.rotation.x = -1.05; // 手前に傾いたバスの大径ハンドル
  const steering = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 8, 20), mat(0x1a1d20));
  steering.rotation.x = Math.PI / 2;
  wheelCol.add(steering);
  body.add(wheelCol);

  // 運転席視点アンカー
  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(-0.8, 2.05, B.wheelbase + 1.9);
  cockpitAnchor.rotation.y = Math.PI; // カメラ既定 -z 向き → +z(前方)へ
  cockpitAnchor.rotation.x = -0.02; // わずかに下向き
  body.add(cockpitAnchor);

  let wheelSpin = 0;
  return {
    root,
    body,
    cockpitAnchor,
    update(bus, dt) {
      root.position.set(bus.x, 0, bus.z);
      root.rotation.y = bus.heading;
      // 視覚ロール(横G)・ピッチ(加減速) — 演出のみ
      const rollT = THREE.MathUtils.clamp(bus.latAccel * 0.018, -0.052, 0.052);
      const pitchT = THREE.MathUtils.clamp(-bus.accel * 0.009, -0.026, 0.026);
      body.rotation.z += (rollT - body.rotation.z) * Math.min(1, dt * 5);
      body.rotation.x += (pitchT - body.rotation.x) * Math.min(1, dt * 5);
      // タイヤ
      wheelSpin += (bus.v * dt) / 0.46;
      for (const w of wheels) {
        w.pivot.rotation.y = w.steered ? bus.delta : 0;
        w.tire.rotation.x = wheelSpin;
      }
      // ハンドル(舵角と連動して回転)
      steering.rotation.z = -bus.delta * 9;
    },
  };
}
