import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { lambertize } from "../../util/lambertize.js";

// ===== 交通車両(Blender製 glb)を共有ロードし、クローンで量産 =====
const loader = new GLTFLoader();
let vehicleLib = null; // vehicles.glb: 'Sedan' / 'Truck'
const pendingVehicle = [];
loader.load("models/vehicles.glb", (gltf) => {
  lambertize(gltf.scene);
  vehicleLib = gltf.scene;
  for (const fill of pendingVehicle.splice(0)) fill();
});

/** glbノードをクローンし、塗装マテリアル(paintName)だけ色替えして返す(非同期充填) */
export function makeVehicle(nodeName, paintName, color) {
  const holder = new THREE.Group();
  const fill = () => {
    const node = vehicleLib.getObjectByName(nodeName).clone(true);
    node.position.set(0, 0, 0);
    const paint = new THREE.MeshLambertMaterial({ color });
    node.traverse((o) => {
      if (o.isMesh && o.material.name === paintName) o.material = paint;
    });
    holder.add(node);
  };
  if (vehicleLib) fill();
  else pendingVehicle.push(fill);
  return holder;
}

/** 対向車のモデル(セダン、前方=+z) */
export const makeCar = (color) => makeVehicle("Sedan", "CarPaint", color);

/** トラック(キャブオーバー+箱荷台、前方=+z) */
export const makeTruck = (cabColor) => makeVehicle("Truck", "TruckCab", cabColor);
