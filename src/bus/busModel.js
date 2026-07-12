import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CFG } from "../config.js";
import { lambertize } from "../util/lambertize.js";
import { createDestinationDisplay } from "./destinationDisplay.js";

/**
 * 京都市バス風 車体モデル(Blender製 glTF)
 * 原点=後軸中心、前方=+z。root.rotation.y に heading をそのまま入れる。
 * glb はゲーム座標系(Y-up・+Z前方)のまま出力済み(export_yup=False)。
 * 階層: root > body(ロール/ピッチ演出) > glTF 'Body' ノード
 *       root > WheelPivotFL/FR(操舵)・RL/RR > ホイールメッシュ
 */
const MODEL_URL = "models/bus.glb";

export function createBusModel() {
  const B = CFG.bus;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const destinationDisplay = createDestinationDisplay();
  let signsReady = false;

  // 運転席視点アンカー(モデル読込完了前から参照されるため同期生成)
  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(-0.8, 2.05, 5.64);
  cockpitAnchor.rotation.y = Math.PI; // カメラ既定 -z 向き → +z(前方)へ
  cockpitAnchor.rotation.x = -0.02;
  body.add(cockpitAnchor);

  const wheels = [];
  let steering = null;

  new GLTFLoader().load(
    MODEL_URL,
    (gltf) => {
      const model = gltf.scene;
      lambertize(model);
      const bodyNode = model.getObjectByName("Body");
      body.add(bodyNode);
      steering = bodyNode.getObjectByName("SteeringWheel");
      for (const [name, steered] of [
        ["WheelPivotFL", true],
        ["WheelPivotFR", true],
        ["WheelPivotRL", false],
        ["WheelPivotRR", false],
      ]) {
        const pivot = model.getObjectByName(name);
        if (!pivot) continue;
        root.add(pivot);
        wheels.push({ pivot, tire: pivot.children[0], steered });
      }
      addSigns(body);
    },
    undefined,
    (err) => console.error("bus.glb の読み込みに失敗", err),
  );

  // 方向幕(前面・後面・側面)。表示内容は九条大宮通過時に切り替える。
  function addSigns(parent) {
    // 幕ハウジングメッシュのバウンディングボックス(バスルート座標系)
    const signBox = (name) => {
      const mesh = parent.getObjectByName(name);
      if (!mesh?.geometry) return null;
      mesh.geometry.computeBoundingBox();
      return mesh.geometry.boundingBox;
    };
    const signTex = destinationDisplay.texture;
    const headsign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.36),
      new THREE.MeshBasicMaterial({ map: signTex }),
    );
    const fb = signBox("SignFront");
    if (fb) {
      headsign.position.set(
        (fb.min.x + fb.max.x) / 2,
        (fb.min.y + fb.max.y) / 2,
        fb.max.z + 0.003,
      );
    } else {
      headsign.position.set(0, 2.79, B.length - B.rearOverhang + 0.028);
    }
    parent.add(headsign);
    const rearSign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.36),
      new THREE.MeshBasicMaterial({ map: signTex }),
    );
    const rb = signBox("SignRear");
    if (rb) {
      rearSign.position.set(
        (rb.min.x + rb.max.x) / 2,
        (rb.min.y + rb.max.y) / 2,
        rb.min.z - 0.003,
      );
    } else {
      rearSign.position.set(0, 2.79, -(B.rearOverhang + 0.028));
    }
    rearSign.rotation.y = Math.PI; // 後方(-z)を向ける
    parent.add(rearSign);
    // 側面(左・前扉上)の系統プレート
    const sideSign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 0.3),
      new THREE.MeshBasicMaterial({ map: signTex }),
    );
    const sb = signBox("SignSideL");
    if (sb) {
      sideSign.position.set(
        sb.max.x + 0.005,
        (sb.min.y + sb.max.y) / 2,
        (sb.min.z + sb.max.z) / 2,
      );
    } else {
      sideSign.position.set(B.width / 2 + 0.02, 2.6, 6.5);
    }
    sideSign.rotation.y = Math.PI / 2;
    parent.add(sideSign);
    signsReady = true;
  }

  let wheelSpin = 0;
  return {
    root,
    body,
    cockpitAnchor,
    update(bus, dt, elev = 0, grade = 0, progressS = 0, kujoOmiyaS = Infinity) {
      if (signsReady)
        destinationDisplay.setPhase(progressS >= kujoOmiyaS ? "afterKujo" : "beforeKujo");
      root.position.set(bus.x, elev, bus.z);
      root.rotation.y = bus.heading;
      // 視覚ロール(横G)・ピッチ(加減速+路面勾配)
      const rollT = THREE.MathUtils.clamp(bus.latAccel * 0.018, -0.052, 0.052);
      const pitchT =
        THREE.MathUtils.clamp(-bus.accel * 0.009, -0.026, 0.026) -
        Math.atan(grade);
      body.rotation.z += (rollT - body.rotation.z) * Math.min(1, dt * 5);
      body.rotation.x += (pitchT - body.rotation.x) * Math.min(1, dt * 5);
      // タイヤ(前輪は操舵ピボットごと回す)
      wheelSpin += (bus.v * dt) / 0.46;
      for (const w of wheels) {
        w.pivot.rotation.y = w.steered ? bus.delta : 0;
        w.tire.rotation.x = wheelSpin;
      }
      // ハンドル(舵角と連動)
      if (steering) steering.rotation.z = -bus.delta * 9;
    },
  };
}
