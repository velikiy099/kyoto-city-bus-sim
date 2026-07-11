/** キーボード入力 + デバッグ用オーバーライド */
const keys = new Set();
const pressedEdge = new Set(); // このフレームで押されたキー
let override = null; // {throttle, brake, steer, door, ...} debug用

const KEYMAP = {
  KeyW: "throttle",
  ArrowUp: "throttle",
  KeyS: "brake",
  ArrowDown: "brake",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
};

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  pressedEdge.add(e.code);
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

export const input = {
  /** 連続入力(毎フレーム) */
  axes() {
    const o = override ?? {};
    return {
      throttle: o.throttle ?? (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0),
      brake: o.brake ?? (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0),
      steer:
        o.steer ??
        (keys.has("KeyA") || keys.has("ArrowLeft") ? -1 : 0) +
          (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0),
    };
  },
  /** 押下エッジ(1フレームだけ true) */
  pressed(code) {
    return pressedEdge.has(code);
  },
  /** 長押し判定(押されている間ずっと true) */
  held(code) {
    return keys.has(code);
  },
  /** フレーム終端で呼ぶ */
  endFrame() {
    pressedEdge.clear();
  },
  /** debug: 入力を上書き(null で解除) */
  setOverride(o) {
    override = o;
  },
  /** debug: 仮想キー押下 */
  press(code) {
    pressedEdge.add(code);
  },
  get overrideActive() {
    return override != null;
  },
};
