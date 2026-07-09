import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CFG } from "../config.js";
import { lambertize } from "../util/lambertize.js";

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

  // 運転席視点アンカー(モデル読込完了前から参照されるため同期生成)
  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(-0.8, 2.05, B.wheelbase + 1.9);
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

  // 方向幕(前面・側面): 「大宮通 久我石原町 | 18」Canvasテクスチャ。系統番号は右端の水色矩形。
  function addSigns(parent) {
    const cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 128;
    const cx2 = cv.getContext("2d");
    cx2.fillStyle = "#0d1116";
    cx2.fillRect(0, 0, 512, 128);
    const numBoxX = 392;
    cx2.fillStyle = "#3fa9dc";
    cx2.fillRect(numBoxX, 0, 512 - numBoxX, 128);
    cx2.fillStyle = "#ffffff";
    cx2.textBaseline = "middle";
    cx2.textAlign = "center";
    cx2.font = "bold 78px sans-serif";
    cx2.fillText("18", numBoxX + (512 - numBoxX) / 2, 68);
    cx2.font = "bold 15px sans-serif";
    cx2.fillStyle = "#ffb43c";
    cx2.fillText("大　宮　通", 196, 30);
    cx2.fillStyle = "#ffffff";
    cx2.font = "bold 48px sans-serif";
    cx2.fillText("久我石原町", 196, 82);
    const signTex = new THREE.CanvasTexture(cv);
    signTex.colorSpace = THREE.SRGBColorSpace;
    const headsign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.36),
      new THREE.MeshBasicMaterial({ map: signTex }),
    );
    headsign.position.set(0, 2.79, B.length - B.rearOverhang + 0.04);
    parent.add(headsign);
    // 側面(左・前扉上)の系統プレート
    const sideSign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 0.3),
      new THREE.MeshBasicMaterial({ map: signTex }),
    );
    sideSign.position.set(B.width / 2 + 0.02, 2.6, 7.1);
    sideSign.rotation.y = Math.PI / 2;
    parent.add(sideSign);
  }

  let wheelSpin = 0;
  return {
    root,
    body,
    cockpitAnchor,
    update(bus, dt, elev = 0, grade = 0) {
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
