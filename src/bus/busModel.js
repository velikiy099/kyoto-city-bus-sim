import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CFG } from "../config.js";
import { lambertize } from "../util/lambertize.js";
import { createCockpitDisplays } from "./cockpitDisplays.js";
import { createDestinationDisplay } from "./destinationDisplay.js";

/**
 * 京都市バス風 車体モデル(Blender製 glTF)
 * 原点=後軸中心、前方=+z。root.rotation.y に heading をそのまま入れる。
 * Blender上ではZ-up正立で構築し、glTF出力時(export_yup=True)にThree.js座標系(Y-up・+Z前方)へ変換。
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
  const cockpitDisplays = createCockpitDisplays();
  let signsReady = false;

  const turnLMat = new THREE.MeshLambertMaterial({
    color: 0x9a5b06,
    emissive: 0x000000,
    emissiveIntensity: 0,
  });
  const turnRMat = new THREE.MeshLambertMaterial({
    color: 0x9a5b06,
    emissive: 0x000000,
    emissiveIntensity: 0,
  });
  const brakeMat = new THREE.MeshLambertMaterial({
    color: 0x7a1212,
    emissive: 0x220404,
    emissiveIntensity: 0.4,
  });
  const reverseMat = new THREE.MeshLambertMaterial({
    color: 0x949ea8,
    emissive: 0x000000,
    emissiveIntensity: 0,
  });
  const boardingMat = new THREE.MeshBasicMaterial({
    map: cockpitDisplays.boardingLampTexture,
  });

  // 運転席視点アンカー(モデル読込完了前から参照されるため同期生成)
  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(-0.78, 1.93, 5.55); // spec.COCKPIT_ANCHOR
  cockpitAnchor.rotation.order = "YXZ"; // 先にY(Math.PI)で前向き(+Z)にし、X(-0.15)で下向きチルト
  cockpitAnchor.rotation.set(-0.15, Math.PI, 0);
  body.add(cockpitAnchor);

  const wheels = [];
  let steering = null;

  new GLTFLoader().load(
    MODEL_URL,
    (gltf) => {
      const model = gltf.scene;
      lambertize(model);
      const bodyNode = model.getObjectByName("Body");
      bodyNode.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const swap = (m) => {
          if (m.name === "BusGauges")
            return new THREE.MeshBasicMaterial({
              map: cockpitDisplays.gaugesTexture,
            });
          if (m.name === "BusDashStopLamp")
            return new THREE.MeshBasicMaterial({
              map: cockpitDisplays.stopIndicatorTexture,
            });
          if (m.name === "BusTurnL") return turnLMat;
          if (m.name === "BusTurnR") return turnRMat;
          if (m.name === "BusBrakeLamp") return brakeMat;
          if (m.name === "BusReverseLamp") return reverseMat;
          if (m.name === "BusRearBoardingLamp") return boardingMat;
          return m;
        };
        o.material = Array.isArray(o.material)
          ? o.material.map(swap)
          : swap(o.material);
      });
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

  // 方向幕(前面・後面のみ動的表示、側面 SignSideL は無表示)。表示内容は九条大宮通過時に切り替える。
  function addSigns(parent) {
    // 幕ハウジングメッシュのバウンディングボックス(バスルート座標系)
    const signBox = (name) => {
      const mesh = parent.getObjectByName(name);
      if (!mesh?.geometry) return null;
      mesh.geometry.computeBoundingBox();
      return mesh.geometry.boundingBox;
    };
    const signTex = destinationDisplay.texture;
    const fb = signBox("SignFront");
    const headsign = new THREE.Mesh(
      new THREE.PlaneGeometry(
        fb ? fb.max.x - fb.min.x : 1.46,
        fb ? fb.max.y - fb.min.y : 0.25,
      ),
      new THREE.MeshBasicMaterial({ map: signTex }),
    );
    if (fb) {
      headsign.position.set(
        (fb.min.x + fb.max.x) / 2,
        (fb.min.y + fb.max.y) / 2,
        fb.max.z + 0.003,
      );
    } else {
      headsign.position.set(-0.09, 2.375, B.length - B.rearOverhang - 0.14);
    }
    parent.add(headsign);

    const rb = signBox("SignRear");
    const rearSign = new THREE.Mesh(
      new THREE.PlaneGeometry(
        rb ? rb.max.x - rb.min.x : 1.2,
        rb ? rb.max.y - rb.min.y : 0.29,
      ),
      new THREE.MeshBasicMaterial({ map: signTex }),
    );
    if (rb) {
      rearSign.position.set(
        (rb.min.x + rb.max.x) / 2,
        (rb.min.y + rb.max.y) / 2,
        rb.min.z - 0.003,
      );
    } else {
      rearSign.position.set(0, 2.205, -(B.rearOverhang - 0.06));
    }
    rearSign.rotation.y = Math.PI; // 後方(-z)を向ける
    parent.add(rearSign);

    // 側面(左・中扉直後の窓全体を占める SignSideL)は無表示のまま維持
    signsReady = true;
  }

  let wheelSpin = 0;
  return {
    root,
    body,
    cockpitAnchor,
    update(
      bus,
      dt,
      elev = 0,
      grade = 0,
      progressS = 0,
      kujoOmiyaS = Infinity,
      cockpitState = null,
    ) {
      if (signsReady)
        destinationDisplay.setPhase(progressS >= kujoOmiyaS ? "afterKujo" : "beforeKujo");
      const tl = Boolean(cockpitState?.turnLeft);
      const tr = Boolean(cockpitState?.turnRight);
      const brk = Boolean(cockpitState?.braking);
      const rev = Boolean(cockpitState?.reversing);
      cockpitDisplays.update({
        speedKmh: bus.speedKmh,
        rpm: bus.rpm ?? 600,
        doorOpen: Boolean(cockpitState?.doorOpen),
        braking: brk,
        buzzer: Boolean(cockpitState?.buzzer),
        turnLeft: tl,
        turnRight: tr,
      });
      turnLMat.color.setHex(tl ? 0xffb300 : 0x9a5b06);
      turnLMat.emissive.setHex(tl ? 0xff8c00 : 0x000000);
      turnLMat.emissiveIntensity = tl ? 1.6 : 0;
      turnRMat.color.setHex(tr ? 0xffb300 : 0x9a5b06);
      turnRMat.emissive.setHex(tr ? 0xff8c00 : 0x000000);
      turnRMat.emissiveIntensity = tr ? 1.6 : 0;
      brakeMat.color.setHex(brk ? 0xff2222 : 0x7a1212);
      brakeMat.emissive.setHex(brk ? 0xff1818 : 0x220404);
      brakeMat.emissiveIntensity = brk ? 1.8 : 0.4;
      reverseMat.color.setHex(rev ? 0xffffff : 0x949ea8);
      reverseMat.emissive.setHex(rev ? 0xf5f9ff : 0x000000);
      reverseMat.emissiveIntensity = rev ? 1.6 : 0;
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
