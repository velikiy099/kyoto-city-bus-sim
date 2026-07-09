import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { lambertize } from "./lambertize.js";

let promise = null;

/** props.glb(Passenger / TreeA / TreeB)を一度だけロードして共有する */
export function loadProps() {
  promise ??= new Promise((resolve, reject) => {
    new GLTFLoader().load(
      "models/props.glb",
      (gltf) => {
        lambertize(gltf.scene);
        resolve(gltf.scene);
      },
      undefined,
      reject,
    );
  });
  return promise;
}
