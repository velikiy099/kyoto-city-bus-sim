import * as THREE from 'three';
import './style.css';
import { CFG } from './config.js';
import { route, speedLimitKmhAt, speedLimitAt } from './route/routeData.js';
import { input } from './input.js';
import { BusPhysics } from './bus/busPhysics.js';
import { createBusModel } from './bus/busModel.js';
import { buildRoad, buildGround } from './world/road.js';
import { setupDebug, dbg, autoDriveInput, recordFrame } from './debug.js';
import { initHud, updateHud } from './ui/hud.js';
import { createMinimap } from './ui/minimap.js';
import { showTitle, showResult } from './ui/screens.js';
import { buildStops } from './game/stops.js';
import { createPassengers } from './game/passengers.js';
import { createScoring } from './game/scoring.js';
import { createOps } from './game/gameState.js';
import { schedule, delayInfo, scheduledClockAt } from './game/timetable.js';
import { buildLandmarks } from './world/landmarks.js';
import { buildNature } from './world/nature.js';
import { buildBuildings } from './world/buildings.js';
import { buildTraffic } from './world/traffic.js';
import * as sfx from './audio/sfx.js';
import { initAnnouncements, announceNext, announceApproach, announceTerminal, announceStart } from './audio/announcements.js';

const STEP = 1 / 60;
const DOOR_OFFSET = CFG.bus.wheelbase + 1.2; // 後軸→前扉
const path = route.path;

// ---------------------------------------------------------------- renderer / scene
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(CFG.colors.sky);
scene.fog = new THREE.Fog(CFG.colors.fog, 250, 900);

scene.add(new THREE.HemisphereLight(0xf5f8ff, 0x6a7a5a, 1.05));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.1);
sun.position.set(-300, 400, -200);
scene.add(sun);

scene.add(buildGround(path));
scene.add(buildRoad(path, route));
const exclusions = [...buildLandmarks(scene, path), ...buildNature(scene, path)];
buildBuildings(scene, path, exclusions, route.buildings);

// ---------------------------------------------------------------- bus / game objects
const bus = new BusPhysics();
const busModel = createBusModel();
scene.add(busModel.root);

const state = {
  phase: 'TITLE',
  s: 0,
  lateral: 0,
  offRoute: false,
  clock: CFG.ops.startClock - 45, // 9:59:15 発車準備
  score: 0,
  fareTotal: 0,
  nextStopIndex: 0,
  doorState: 'CLOSED',
  buzzer: false,
  promptText: null,
  camMode: 'chase',
  completed: false,
};

const pax = createPassengers(route.stops.length);
const stopsView = buildStops(scene, path, route.stops);
const scoring = createScoring(state);
const traffic = buildTraffic(scene, path, {
  onCollision() {
    scoring.add(CFG.score.collision, '対向車と接触!');
  },
  onRedLight() {
    scoring.add(CFG.score.redLight, '信号無視!');
  },
});
let approachAnnounced = false;
const ops = createOps({
  bus,
  route,
  state,
  scoring,
  pax,
  stopsView,
  events: {
    onDoorOpen: () => sfx.doorAir(),
    onDoorClose: () => sfx.doorAir(),
    onFare: () => sfx.coin(),
    onBuzzer: () => sfx.buzzer(),
    onDepart() {
      approachAnnounced = false;
      const next = route.stops[state.nextStopIndex];
      if (next) announceNext(next.name);
    },
    onComplete() {
      state.completed = true;
      announceTerminal();
      setTimeout(() => {
        state.phase = 'RESULT';
        const d = delayInfo(state.clock, path.length - 1);
        showResult({
          score: state.score,
          rank: scoring.rank(),
          carried: pax.totalCarried,
          fare: state.fareTotal,
          clock: state.clock,
          schedArrival: schedule[schedule.length - 1].time,
          delayText: d.text,
          breakdown: [...scoring.breakdown.entries()],
        });
      }, 1200);
    },
  },
});

function placeBusAtS(s, lat = CFG.road.laneCenter) {
  const [px, pz] = path.getPoint(s);
  const [tx, tz] = path.getTangent(s);
  bus.x = px + -tz * lat;
  bus.z = pz + tx * lat;
  bus.heading = Math.atan2(tx, tz);
  bus.v = 0;
  bus.delta = 0;
  state.s = s;
}

// ---------------------------------------------------------------- camera
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 1400);
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let camInit = false;

function updateCamera(dt) {
  if (state.camMode === 'cockpit') {
    busModel.cockpitAnchor.updateWorldMatrix(true, false);
    camera.matrixAutoUpdate = false;
    camera.matrix.copy(busModel.cockpitAnchor.matrixWorld);
    camera.matrixWorldNeedsUpdate = true;
    return;
  }
  camera.matrixAutoUpdate = true;
  const [fx, fz] = bus.forward;
  const targetPos = new THREE.Vector3(bus.x - fx * 13, 5.2, bus.z - fz * 13);
  const targetLook = new THREE.Vector3(bus.x + fx * 8, 2.2, bus.z + fz * 8);
  if (!camInit || camPos.distanceTo(targetPos) > 60) {
    camPos.copy(targetPos);
    camLook.copy(targetLook);
    camInit = true;
  }
  const k = 1 - Math.exp(-dt * 4.5);
  camPos.lerp(targetPos, k);
  camLook.lerp(targetLook, k);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

// ---------------------------------------------------------------- autoDrive helpers
function autoStopTargetS() {
  // 発車ブロック(定刻待ち)中はその場停止を維持
  if (state.promptText?.startsWith('発車時刻')) return state.s;
  // 発車待ち解除直後: いま停まっている停留所は済んでいるので次から探す
  const from = state.waitingDepart ? state.nextStopIndex + 1 : state.nextStopIndex;
  for (let i = from; i < route.stops.length; i++) {
    if (pax.mustStopAt(i) || i === route.stops.length - 1) {
      return route.stops[i].s - DOOR_OFFSET;
    }
  }
  return null;
}

// ---------------------------------------------------------------- game tick (fixed step)
function tick(dt, ePressed) {
  let axes;
  if (input.overrideActive) {
    axes = input.axes();
  } else if (dbg.autoDrive) {
    const target = autoStopTargetS();
    const near = target != null && target - state.s < 110;
    let effTarget = target;
    let vCap = Infinity;
    if (target != null) {
      const d = target - state.s;
      // 停止目標に近いのに寄せが足りない → 目標を少し先送りし微速で寄せ直す
      if (d < 26 && d > -6 && state.lateral > -1.8 && state.doorState === 'CLOSED' && !state.waitingDepart) {
        effTarget = state.s + Math.max(d, 4);
        vCap = 1.4;
      }
    }
    // 赤信号の停止線が停留所より手前ならそちらを優先
    const redS = traffic.redStopTarget(state.s, bus.v);
    if (redS != null && (effTarget == null || redS < effTarget)) effTarget = redS;
    axes = autoDriveInput(bus, path, state.s, effTarget, near ? -2.35 : CFG.road.laneCenter, vCap);
    // ドア操作の自動化: プロンプトが出たら即 E
    if (state.promptText?.startsWith('E :')) ePressed = true;
  } else {
    axes = input.axes();
  }

  bus.step(dt, axes);

  const proj = path.closestS([bus.x, bus.z], state.s, 150);
  state.s = proj.s;
  state.lateral = proj.lateral;
  state.offRoute = proj.dist > CFG.road.halfWidth + CFG.road.offroadMargin + 2.5;

  if (state.offRoute && bus.v > 15 / 3.6) bus.v = 15 / 3.6;

  state.clock += dt;
  ops.update(dt, ePressed);
  scoring.tick(dt, bus, speedLimitAt(state.s));
  traffic.update(dt, state.s, [bus.x, bus.z], bus.v);

  // 「まもなく」アナウンス(次停留所の 120m 手前)
  const ns = route.stops[state.nextStopIndex];
  if (ns && !approachAnnounced && !state.waitingDepart && ns.s - state.s < CFG.ops.approachDist) {
    approachAnnounced = true;
    if (pax.mustStopAt(state.nextStopIndex)) announceApproach(ns.name);
  }
}

// ---------------------------------------------------------------- frame loop
let minimap = null; // initHud() 後に生成
let last = performance.now();
let acc = 0;
let hudTimer = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dtMs = Math.min(100, now - last);
  last = now;
  recordFrame(dtMs);
  const dt = dtMs / 1000;

  if (state.phase === 'RUNNING') {
    if (input.pressed('KeyC')) state.camMode = state.camMode === 'chase' ? 'cockpit' : 'chase';
    if (input.pressed('KeyM')) {
      const el = document.getElementById('minimap');
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
    if (input.pressed('KeyR')) {
      if (state.offRoute) scoring.add(CFG.score.offroadReset, 'コース外から復帰');
      placeBusAtS(state.s);
      camInit = false;
    }

    let ePressed = input.pressed('KeyE');
    acc += dt * dbg.timeScale;
    let steps = 0;
    const maxSteps = Math.ceil(6 * dbg.timeScale);
    while (acc >= STEP && steps < maxSteps) {
      tick(STEP, ePressed);
      ePressed = false;
      acc -= STEP;
      steps++;
    }
    if (steps === maxSteps) acc = 0;
  }

  busModel.update(bus, dt);
  updateCamera(dt);
  sfx.updateEngine(bus.speedKmh, bus.throttleState);

  hudTimer -= dt;
  if (hudTimer <= 0 && state.phase !== 'TITLE') {
    hudTimer = 0.1;
    const i = Math.min(state.nextStopIndex, route.stops.length - 1);
    const nextStop = route.stops[i];
    const distTo = Math.max(0, nextStop.s - (state.s + DOOR_OFFSET));
    let sub;
    if (state.completed) sub = '終点 おつかれさまでした';
    else if (state.doorState !== 'CLOSED') sub = '乗降中';
    else if (state.buzzer) sub = `🔔 つぎ とまります ・ あと${distTo.toFixed(0)}m`;
    else if (pax.mustStopAt(i)) sub = `停車 ・ あと${distTo.toFixed(0)}m`;
    else sub = `通過可 ・ あと${distTo.toFixed(0)}m`;
    const started = state.nextStopIndex > 0 || state.doorState !== 'CLOSED';
    const d = started ? delayInfo(state.clock, state.s) : null;
    updateHud({
      speedKmh: bus.speedKmh,
      limitKmh: speedLimitKmhAt(state.s),
      clock: state.clock,
      score: Math.round(state.score),
      passengers: pax.onboard,
      fareTotal: state.fareTotal,
      nextStopName: state.completed ? '── 終点 ──' : nextStop.name,
      nextStopSub: sub,
      delayText: d?.text ?? '--',
      delayKind: d?.kind ?? 'ontime',
    });
    minimap?.update([bus.x, bus.z], state.nextStopIndex);
  }

  renderer.render(scene, camera);
  input.endFrame();
}

// ---------------------------------------------------------------- boot
initHud();
minimap = createMinimap(path, route.stops);
placeBusAtS(Math.max(0.5, route.stops[0].s - DOOR_OFFSET), -2.4); // 始発: 前扉を二条駅西口の停止線に合わせて待機
setupDebug({
  bus,
  path,
  route,
  scene,
  camera,
  tick: (dt, e) => {
    if (state.phase === 'RUNNING') tick(dt, e);
  },
  getState: () => ({
    phase: state.phase,
    s: +state.s.toFixed(1),
    x: +bus.x.toFixed(1),
    z: +bus.z.toFixed(1),
    lateral: +state.lateral.toFixed(2),
    vKmh: +bus.speedKmh.toFixed(1),
    doorState: state.doorState,
    waitingDepart: !!state.waitingDepart,
    nextStopIndex: state.nextStopIndex,
    nextStop: route.stops[Math.min(state.nextStopIndex, route.stops.length - 1)]?.name,
    prompt: state.promptText,
    clock: Math.round(state.clock),
    delay: delayInfo(state.clock, state.s).delay,
    score: Math.round(state.score),
    onboard: pax.onboard,
    carried: pax.totalCarried,
    fare: state.fareTotal,
    buzzer: state.buzzer,
    offRoute: state.offRoute,
    autoDrive: dbg.autoDrive,
    timeScale: dbg.timeScale,
    paxSeed: pax.seed,
    boardPlan: pax.board.join(','),
    alightPlan: pax.alight.join(','),
  }),
  onTeleport: (s, stopIndex) => {
    state.s = s;
    camInit = false;
    ops.resetTo(stopIndex ?? 0);
    state.clock = scheduledClockAt(s); // ダイヤも位置に同期
  },
});

showTitle(() => {
  sfx.initAudio();
  initAnnouncements();
  announceStart();
  state.phase = 'RUNNING';
  state.clock = CFG.ops.startClock - 45;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

requestAnimationFrame(frame);
console.info(`[M4] game loop ready: ${route.name} ${path.length.toFixed(0)}m / ${route.stops.length} stops / pax seed=${pax.seed}`);
