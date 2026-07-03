import * as THREE from 'three';
import { CFG } from '../config.js';
import { route } from '../route/routeData.js';

const mat = (color) => new THREE.MeshLambertMaterial({ color });
const signalMat = (color) => new THREE.MeshBasicMaterial({ color });

function makeCylinderBetween(a, b, radius, color) {
  const start = new THREE.Vector3(...a);
  const end = new THREE.Vector3(...b);
  const delta = end.clone().sub(start);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), 8), mat(color));
  mesh.position.copy(start.add(end).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  return mesh;
}

/** 対向車のモデル(セダン風の2箱、前方=+z) */
function makeCar(color) {
  const g = new THREE.Group();
  const lower = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.65, 4.4), mat(color));
  lower.position.y = 0.65;
  const upper = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 2.2), mat(0x2c3844));
  upper.position.set(0, 1.25, -0.2);
  g.add(lower, upper);
  return g;
}

const stopS = (name) => route.stops.find((st) => st.name === name)?.s ?? null;

function fallbackSignalPositions(path) {
  const SIG_STOPS = ['四条大宮', '大宮五条', '七条大宮・京都水族館前', '九条大宮', '千本十条', '城南宮道'];
  return SIG_STOPS.map((name) => {
    const s0 = stopS(name);
    return s0 == null ? null : { s: s0 + 32, name };
  }).filter((sig) => sig && sig.s <= path.length - 30);
}

/**
 * 対向車と信号機。
 * update(dt, busS, busPos, busV) を毎ステップ呼ぶ。
 * events: { onCollision(), onRedLight() }
 */
export function buildTraffic(scene, path, events = {}) {
  const g = new THREE.Group();
  scene.add(g);

  // ---- 対向車(反対車線を s 減少方向へ走る) ----
  const carColors = [0xd8dde2, 0x30343a, 0x9aa3ab, 0x7a1f24, 0x274a72, 0xc8c0a8];
  const cars = [];
  const N_CARS = 6;
  for (let i = 0; i < N_CARS; i++) {
    const mesh = makeCar(carColors[i % carColors.length]);
    g.add(mesh);
    cars.push({
      mesh,
      s: ((i + 1) / (N_CARS + 1)) * path.length,
      v: 8 + (i % 3) * 1.5, // 30〜40km/h
    });
  }
  const LAT_ONCOMING = 2.15; // 対向車線中心

  // ---- 信号機(主要交差点) ----
  const CYCLE = 42, GREEN = 22, YELLOW = 3; // [s] 残りは赤
  const signals = [];
  const signalDefs = route.signals?.length ? route.signals : fallbackSignalPositions(path);
  for (const def of signalDefs) {
    const s = def.s;
    if (s > path.length - 30) continue;
    const [px, pz] = path.getPoint(s);
    const [tx, tz] = path.getTangent(s);
    const nx = -tz, nz = tx;

    // 信号柱(進行方向左・交差点手前)+ 3灯(横型・日本式)
    const poleLat = -(CFG.road.halfWidth + 1.7);
    const headLat = CFG.road.laneCenter - 0.2;
    const headAhead = -5.2;
    const poleX = px + nx * poleLat + tx * headAhead;
    const poleZ = pz + nz * poleLat + tz * headAhead;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 5.4, 6), mat(0x8a8f94));
    pole.position.set(poleX, 2.7, poleZ);
    g.add(pole);
    const headX = px + nx * headLat + tx * headAhead;
    const headZ = pz + nz * headLat + tz * headAhead;
    const arm = makeCylinderBetween([poleX, 5.1, poleZ], [headX, 5.1, headZ], 0.06, 0x8a8f94);
    g.add(arm);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.75, 0.38), signalMat(0x23282d));
    housing.position.set(headX, 4.85, headZ);
    housing.rotation.y = Math.atan2(tx, tz);
    g.add(housing);
    const lampGeo = new THREE.SphereGeometry(0.28, 16, 10);
    const lampList = [
      ['red', -0.72],
      ['yellow', 0],
      ['green', 0.72],
    ].map(([key, x]) => {
      const lamp = new THREE.Mesh(lampGeo, signalMat(0x223322));
      lamp.position.set(x, 0, -0.24);
      housing.add(lamp);
      const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.12, 16, 1, true), signalMat(0x11161a));
      hood.rotation.x = Math.PI / 2;
      hood.position.set(lamp.position.x, 0, -0.2);
      housing.add(hood);
      return [key, lamp];
    });
    const lamps = Object.fromEntries(lampList);

    signals.push({ s, phase: Math.random() * CYCLE, lamps, state: null });
  }

  const OFF = { green: 0x1c3a24, yellow: 0x4a3d14, red: 0x451818 };
  const ON = { green: 0x2ee86a, yellow: 0xffd23c, red: 0xff4433 };

  function paintSignal(sig, st) {
    sig.state = st;
    sig.lamps.green.material.color.setHex(st === 'green' ? ON.green : OFF.green);
    sig.lamps.yellow.material.color.setHex(st === 'yellow' ? ON.yellow : OFF.yellow);
    sig.lamps.red.material.color.setHex(st === 'red' ? ON.red : OFF.red);
  }

  let collisionCooldown = 0;
  let lastBusS = 0;

  return {
    signals,
    update(dt, busS, busPos, busV) {
      // 対向車
      for (const c of cars) {
        c.s -= c.v * dt;
        if (c.s < 15) c.s = path.length - 15 - Math.random() * 60;
        // 前方カーブで減速(簡易)
        const k = Math.abs(path.curvatureAt(c.s));
        const vMax = k > 1e-4 ? Math.max(3.5, Math.sqrt(2.4 / k)) : 11;
        c.v += (Math.min(vMax, 11) - c.v) * Math.min(1, dt * 0.8);
        const [px, pz] = path.getPoint(c.s);
        const [tx, tz] = path.getTangent(c.s);
        c.mesh.position.set(px + -tz * LAT_ONCOMING, 0, pz + tx * LAT_ONCOMING);
        c.mesh.rotation.y = Math.atan2(-tx, -tz); // 逆走向き
        // 衝突判定
        if (collisionCooldown <= 0) {
          const dx = c.mesh.position.x - busPos[0];
          const dz = c.mesh.position.z - busPos[1];
          if (dx * dx + dz * dz < 2.2 * 2.2) {
            collisionCooldown = 4;
            events.onCollision?.();
          }
        }
      }
      collisionCooldown = Math.max(0, collisionCooldown - dt);

      // 信号
      for (const sig of signals) {
        sig.phase = (sig.phase + dt) % CYCLE;
        const st = sig.phase < GREEN ? 'green' : sig.phase < GREEN + YELLOW ? 'yellow' : 'red';
        if (st !== sig.state) {
          paintSignal(sig, st);
        }
        // 赤信号無視: 停止線(交差点 8m 手前)を v>1.5 で通過
        const lineS = sig.s - 8;
        if (sig.state === 'red' && lastBusS < lineS && busS >= lineS && busV > 1.5) {
          events.onRedLight?.();
        }
      }
      lastBusS = busS;
    },
    /** 直近の信号情報(HUD 用) */
    nextSignal(busS) {
      let best = null;
      for (const sig of signals) {
        const d = sig.s - busS;
        if (d > -5 && (best == null || d < best.d)) best = { d, state: sig.state };
      }
      return best;
    },
    /**
     * autoDrive 用: 前方の止まるべき信号の停止線 s(なければ null)。
     * 黄は停止可能距離があるときのみ止まる。青は残り時間を読まず進む。
     */
    redStopTarget(busS, busV) {
      let best = null;
      for (const sig of signals) {
        const lineS = sig.s - 9;
        const d = lineS - busS;
        if (d < -2 || d > 90) continue;
        if (sig.state === 'green') continue;
        // 停止可能か(減速度 2.6m/s^2 想定)。無理なら通過
        const brakeDist = (busV * busV) / (2 * 2.6);
        if (d < brakeDist - 4) continue;
        if (best == null || lineS < best) best = lineS;
      }
      return best;
    },
  };
}
