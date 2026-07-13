import * as THREE from "three";
import {
  route,
  elevationAt,
  laneCenterAt,
  halfWidthAt,
} from "../../route/routeData.js";
import SIGNAL_DEFS from "../../data/definitions/signals.json" with { type: "json" };
import { signalStopLineS, busSignalStopTargetS } from "./dynamics.js";

const SIGNAL_TIMING = SIGNAL_DEFS.TIMING;
const mat = (color) => new THREE.MeshLambertMaterial({ color });
const signalMat = (color) => new THREE.MeshBasicMaterial({ color });

function makeCylinderBetween(a, b, radius, color) {
  const start = new THREE.Vector3(...a);
  const end = new THREE.Vector3(...b);
  const delta = end.clone().sub(start);
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, delta.length(), 8),
    mat(color),
  );
  mesh.position.copy(start.add(end).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    delta.normalize(),
  );
  return mesh;
}

const stopS = (name) => route.stops.find((st) => st.name === name)?.s ?? null;

export const nodePhase = (id) =>
  [...String(id ?? "")].reduce(
    (hash, character) => (hash * 33 + character.charCodeAt(0)) % SIGNAL_TIMING.cycleS,
    0,
  );

export const isNpcStopPhase = (nodeId, simulationTime) =>
  ((simulationTime + nodePhase(nodeId)) % SIGNAL_TIMING.cycleS) >= SIGNAL_TIMING.greenS;

function fallbackSignalPositions(path) {
  return SIGNAL_DEFS.FALLBACK.stops.map((name) => {
    const s0 = stopS(name);
    return s0 == null ? null : { s: s0 + SIGNAL_DEFS.FALLBACK.offsetM, name };
  }).filter((sig) => sig && sig.s <= path.length - SIGNAL_DEFS.FALLBACK.endMarginM);
}

export function buildSignals(group, path) {
  // ================= 信号 =================
  // 位相: 自道 青22→黄3→赤17 / 交差道は自道が赤の間に 全赤1→青14→黄2(交差点内で連動)
  const CYCLE = SIGNAL_TIMING.cycleS,
    GREEN = SIGNAL_TIMING.greenS,
    YELLOW = SIGNAL_TIMING.yellowS;
  const mainStateOf = (ph) =>
    ph < GREEN ? "green" : ph < GREEN + YELLOW ? "yellow" : "red";
  const crossStateOf = (ph) =>
    ph >= GREEN + YELLOW + SIGNAL_TIMING.crossAllRedLeadS && ph < CYCLE - SIGNAL_TIMING.crossYellowS
      ? "green"
      : ph >= CYCLE - SIGNAL_TIMING.crossYellowS
        ? "yellow"
        : "red";

  const OFF = { green: 0x1c3a24, yellow: 0x4a3d14, red: 0x451818 };
  const ON = { green: 0x2ee86a, yellow: 0xffd23c, red: 0xff4433 };

  const lampGeo = new THREE.SphereGeometry(0.28, 12, 8);
  const housingGeo = new THREE.BoxGeometry(2.25, 0.75, 0.38);
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.09, 5.4, 6);

  /** 横型3灯の灯器。faceHeading 方向に進む車から見える(-z面)。左=青・右=赤(日本式) */
  function makeHead(x, y, z, faceHeading, withHoods = false) {
    const housing = new THREE.Mesh(housingGeo, signalMat(0x23282d));
    housing.position.set(x, y, z);
    housing.rotation.y = faceHeading;
    group.add(housing);
    const lamps = {};
    for (const [key, lx] of [
      ["green", 0.72],
      ["yellow", 0],
      ["red", -0.72],
    ]) {
      const lamp = new THREE.Mesh(lampGeo, signalMat(OFF[key]));
      lamp.position.set(lx, 0, -0.24);
      housing.add(lamp);
      lamps[key] = lamp;
      if (withHoods) {
        const hood = new THREE.Mesh(
          new THREE.CylinderGeometry(0.34, 0.34, 0.12, 16, 1, true),
          signalMat(0x11161a),
        );
        hood.rotation.x = Math.PI / 2;
        hood.position.set(lx, 0, -0.2);
        housing.add(hood);
      }
    }
    return lamps;
  }

  function paintHead(lamps, st) {
    lamps.green.material.color.setHex(st === "green" ? ON.green : OFF.green);
    lamps.yellow.material.color.setHex(
      st === "yellow" ? ON.yellow : OFF.yellow,
    );
    lamps.red.material.color.setHex(st === "red" ? ON.red : OFF.red);
  }

  const signals = [];
  const signalDefs = route.signals?.length
    ? route.signals
    : fallbackSignalPositions(path);
  /** 柱を立て、必要ならアームを渡し、灯器を付ける */
  let activeSignalElevation = 0;
  function buildHead(h) {
    const pole = new THREE.Mesh(poleGeo, mat(0x8a8f94));
    pole.position.set(h.pole[0], activeSignalElevation + 2.7, h.pole[1]);
    group.add(pole);
    if (h.arm)
      group.add(
        makeCylinderBetween(
          [h.pole[0], activeSignalElevation + 5.1, h.pole[1]],
          [h.head[0], activeSignalElevation + 5.1, h.head[1]],
          0.06,
          0x8a8f94,
        ),
      );
    return makeHead(h.head[0], activeSignalElevation + 4.85, h.head[1], h.face, !!h.hoods);
  }

  for (const def of signalDefs) {
    const s = def.s;
    if (s > path.length - 30) continue;
    activeSignalElevation = elevationAt(s);
    const mainHeads = [];
    const crossHeads = [];

    if (def.heads?.length) {
      // 設置座標はビルド時に計算済み(route18.json)。ここでは置くだけ
      for (const h of def.heads)
        (h.kind === "cross" ? crossHeads : mainHeads).push(buildHead(h));
    } else {
      // フォールバック(--fallback データ等で heads がない場合): ルート接線基準の簡易配置
      const [px, pz] = path.getPoint(s);
      const [tx, tz] = path.getTangent(s);
      const nx = -tz,
        nz = tx; // lateral 正(右)方向
      const HW = halfWidthAt(s);
      const theta = Math.atan2(tx, tz);
      const at = (lat, ahead) => [
        px + nx * lat + tx * ahead,
        pz + nz * lat + tz * ahead,
      ];
      mainHeads.push(
        buildHead({
          pole: at(-(HW + 1.7), -5.2),
          head: at(laneCenterAt(s) - 0.2, -5.2),
          face: theta,
          arm: 1,
          hoods: 1,
        }),
      );
      mainHeads.push(
        buildHead({
          pole: at(HW + 1.7, 5.2),
          head: at(-laneCenterAt(s) + 0.2, 5.2),
          face: theta + Math.PI,
          arm: 1,
        }),
      );
      const ch = theta + Math.PI / 2;
      const cd = [Math.sin(ch), Math.cos(ch)];
      for (const dir of [1, -1]) {
        const ax = px - cd[0] * dir * (HW + 2.2) + cd[1] * dir * 4.0;
        const az = pz - cd[1] * dir * (HW + 2.2) - cd[0] * dir * 4.0;
        crossHeads.push(
          buildHead({
            pole: [ax, az],
            head: [ax + cd[0] * dir * 0.6, az + cd[1] * dir * 0.6],
            face: dir === 1 ? ch : ch + Math.PI,
          }),
        );
      }
    }

    signals.push({
      s,
      phase: Math.random() * CYCLE,
      mainHeads,
      crossHeads,
      state: null,
      crossState: null,
    });
  }

  const nodeSignalMap = new Map();
  const attachNodes = (runtime) => {
    nodeSignalMap.clear();
    const signalNodes = [...(runtime?.nodeById?.values() ?? [])]
      .filter((node) => node.signal === true);
    for (const node of signalNodes) {
      const [nx, nz] = node.point ?? [];
      if (!Number.isFinite(nx) || !Number.isFinite(nz)) continue;
      let best = null;
      for (const sig of signals) {
        const [sx, sz] = path.getPoint(sig.s);
        const distance = Math.hypot(nx - sx, nz - sz);
        if (distance <= 25 && (!best || distance < best.distance)) {
          best = { sig, distance };
        }
      }
      if (best) {
        nodeSignalMap.set(node.id, {
          sig: best.sig,
          mainTangent: path.getTangent(best.sig.s),
        });
      }
    }
    console.debug("signal nodes mapped:", nodeSignalMap.size, "/", signalNodes.length);
  };

  const shouldNpcStop = (nodeId, approachHeading, simulationTime) => {
    const mapping = nodeSignalMap.get(nodeId);
    if (!mapping) return isNpcStopPhase(nodeId, simulationTime);
    const forward = [Math.sin(approachHeading), Math.cos(approachHeading)];
    const [tx, tz] = mapping.mainTangent;
    const mainDot = forward[0] * tx + forward[1] * tz;
    const state = Math.abs(mainDot) > 0.7
      ? mapping.sig.state
      : mapping.sig.crossState;
    return state !== "green";
  };

  let lastBusS = 0;
  const update = (dt, busS = 0, busV = 0, onRedLight) => {
    for (const sig of signals) {
      sig.phase = (sig.phase + dt) % CYCLE;
      const state = sig.phase < GREEN ? "green" : sig.phase < GREEN + YELLOW ? "yellow" : "red";
      if (state !== sig.state) {
        sig.state = state;
        for (const head of sig.mainHeads) paintHead(head, state);
      }
      const crossState = sig.phase >= 26 && sig.phase < 40
        ? (sig.phase < 38 ? "green" : "yellow")
        : "red";
      if (crossState !== sig.crossState) {
        sig.crossState = crossState;
        for (const head of sig.crossHeads) paintHead(head, crossState);
      }
      const lineS = signalStopLineS(sig.s);
      if (state === "red" && lastBusS < lineS && busS >= lineS && busV > 1.5) {
        onRedLight?.();
      }
    }
    lastBusS = busS;
  };

  const nextSignal = (busS) => {
    let best = null;
    for (const sig of signals) {
      const d = sig.s - busS;
      if (d > -5 && (!best || d < best.d)) best = { d, state: sig.state };
    }
    return best;
  };

  const redStopTarget = (busS, busV) => {
    for (const sig of signals) {
      const target = busSignalStopTargetS(sig.s);
      const d = target - busS;
      if (d >= 0 && d < 90 && sig.state !== "green") return busS + d;
    }
    return null;
  };

  return {
    signals,
    paintHead,
    update,
    isNpcStopPhase,
    attachNodes,
    shouldNpcStop,
    nextSignal,
    redStopTarget,
  };
}
