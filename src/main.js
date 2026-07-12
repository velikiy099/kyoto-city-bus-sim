import * as THREE from "three";
import "./style.css";
import { CFG } from "./config.js";
import {
  route,
  speedLimitKmhAt,
  speedLimitAt,
  elevationAt,
  surfaceElevationAt,
  terrainElevationAt,
  roadAttachmentHalfWidthAt,
  gradeAt,
  driveBoundsAt,
  turnExclusions,
} from "./route/routeData.js";
import { input } from "./input.js";
import { BusPhysics } from "./bus/busPhysics.js";
import { createBusModel } from "./bus/busModel.js";
import {
  buildContinuousTerrain,
  configureWorldHeightSamplers,
  terrainHeightAtWorld,
  roadHeightAtWorld,
} from "./world/declarative/continuousTerrain.js";
import { setupDebug, dbg, autoDriveInput, recordFrame } from "./debug.js";
import { initHud, updateHud } from "./ui/hud.js";
import { createMinimap } from "./ui/minimap.js";
import { showTitle, showResult } from "./ui/screens.js";
import { buildStops } from "./game/stops.js";
import { createPassengers } from "./game/passengers.js";
import { createScoring } from "./game/scoring.js";
import { createOps } from "./game/gameState.js";
import {
  schedule,
  fmtTime,
  delayInfo,
  scheduledClockAt,
  firstDepartTime,
} from "./game/timetable.js";
import { buildLandmarks } from "./world/landmarks.js";
import { buildNature } from "./world/nature.js";
import { buildRailways } from "./world/railways.js";
import { buildTraffic } from "./world/traffic.js";
import { buildWorldScenery } from "./world/declarative/buildWorldScenery.js";
import { WORLD_CONFIG } from "./world/declarative/config.js";
import * as sfx from "./audio/sfx.js";
import {
  initAnnouncements,
  announceNext,
  announceStopping,
  announceTerminal,
  announceStart,
} from "./audio/announcements.js";

const STEP = 1 / 60;
const DOOR_OFFSET = CFG.bus.wheelbase + 1.3; // 後軸→前扉
const path = route.path;
const kujoOmiyaS = route.stops.find((stop) => stop.name === "九条大宮")?.s ?? Infinity;
configureWorldHeightSamplers(
  path,
  terrainElevationAt,
  elevationAt,
  roadAttachmentHalfWidthAt,
  route.surfacePath,
);

// ---------------------------------------------------------------- renderer / scene
const app = document.getElementById("app");
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

const baseTerrain = buildContinuousTerrain(path, route.bridges, route.rivers);
scene.add(baseTerrain);
void buildWorldScenery(scene, path, route, {
  buildRailways,
  buildLandmarks,
  buildNature,
  turnExclusions,
  elevationAt,
  terrainHeightAtWorld,
  roadHeightAtWorld,
  baseTerrain,
});

// ---------------------------------------------------------------- bus / game objects
const bus = new BusPhysics();
const busModel = createBusModel();
scene.add(busModel.root);

const state = {
  phase: "TITLE",
  s: 0,
  lateral: 0,
  offRoute: false,
  clock: firstDepartTime - 45, // 始発 9:56 発の 45 秒前から乗車扱い
  score: 0,
  fareTotal: 0,
  nextStopIndex: 0,
  doorState: "CLOSED",
  buzzer: false,
  promptText: null,
  camMode: "chase",
  completed: false,
  paused: false,
  demoMode: false,
};

const pax = createPassengers(route.stops.length);
const stopsView = buildStops(scene, path, route.stops);
const scoring = createScoring(state);
const traffic = buildTraffic(scene, path, {
  trafficPaths: route.trafficPaths,
  trafficGraph: route.trafficGraph,
  useTrafficGraph: true,
  onCollision() {
    scoring.add(CFG.score.collision, "他車と接触!");
    (state.collisionLog ??= []).push(Math.round(state.s)); // 発生位置(デバッグ用)
  },
  onRedLight() {
    scoring.add(CFG.score.redLight, "信号無視!");
  },
});
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
    onBuzzer: () => {
      sfx.buzzer();
      announceStopping();
    },
    onDepart() {
      const next = route.stops[state.nextStopIndex];
      if (next) announceNext(next.name);
    },
    onComplete() {
      state.completed = true;
      announceTerminal();
      setTimeout(() => {
        state.phase = "RESULT";
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

function placeBusAtS(s) {
  const [px, pz] = path.getPoint(s);
  const [tx, tz] = path.getTangent(s);
  bus.x = px;
  bus.z = pz;
  bus.heading = Math.atan2(tx, tz);
  bus.v = 0;
  bus.delta = 0;
  state.s = s;
}

// ---------------------------------------------------------------- camera
const camera = new THREE.PerspectiveCamera(
  62,
  window.innerWidth / window.innerHeight,
  0.1,
  1400,
);
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let camInit = false;

function updateCamera(dt) {
  if (state.camMode === "cockpit") {
    busModel.cockpitAnchor.updateWorldMatrix(true, false);
    camera.matrixAutoUpdate = false;
    camera.matrix.copy(busModel.cockpitAnchor.matrixWorld);
    camera.matrixWorldNeedsUpdate = true;
    return;
  }
  camera.matrixAutoUpdate = true;
  const [fx, fz] = bus.forward;
  // 追従カメラも路面標高(跨線橋)に追従させる
  const camElev = elevationAt(Math.max(0, state.s - 13));
  const lookElev = elevationAt(state.s + 8);
  const targetPos = new THREE.Vector3(
    bus.x - fx * 13,
    5.2 + camElev,
    bus.z - fz * 13,
  );
  const targetLook = new THREE.Vector3(
    bus.x + fx * 8,
    2.2 + lookElev,
    bus.z + fz * 8,
  );
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
/** 停車義務: 乗降需要あり、または時刻表対象(全停留所) */
const mustStopAt = (i) => pax.mustStopAt(i) || !!schedule[i]?.checkpoint;

function autoStopTargetS() {
  // 発車ブロック(定刻待ち)中はその場停止を維持
  if (state.promptText?.startsWith("発車時刻")) return state.s;
  // 発車待ち解除直後: いま停まっている停留所は済んでいるので次から探す
  const from = state.waitingDepart
    ? state.nextStopIndex + 1
    : state.nextStopIndex;
  for (let i = from; i < route.stops.length; i++) {
    if (mustStopAt(i) || i === route.stops.length - 1) {
      const target = route.stops[i].s - DOOR_OFFSET;
      if (target < state.s - 10) continue; // 通り過ぎた停留所は諦めて先へ(スタック防止)
      return target;
    }
  }
  return null;
}

function autoStopTarget() {
  if (state.promptText?.startsWith("発車時刻")) return null;
  const from = state.waitingDepart
    ? state.nextStopIndex + 1
    : state.nextStopIndex;
  for (let i = from; i < route.stops.length; i++) {
    if (!mustStopAt(i) && i !== route.stops.length - 1) continue;
    const stop = route.stops[i];
    const target = stop.s - DOOR_OFFSET;
    if (target < state.s - 10) continue;
    return { stop, target };
  }
  return null;
}

function smoothstep01(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function autoDockLateralAt(s, stop) {
  if (!stop?.dockLateral || state.waitingDepart) return 0;
  const target = stop.s - DOOR_OFFSET;
  const approach = 60;
  const depart = 30;
  if (s <= target - approach || s >= target + depart) return 0;
  if (s <= target)
    return (
      stop.dockLateral * smoothstep01((s - (target - approach)) / approach)
    );
  return stop.dockLateral * (1 - smoothstep01((s - target) / depart));
}

// ---------------------------------------------------------------- game tick (fixed step)
function tick(dt, ePressed) {
  let axes;
  if (input.overrideActive) {
    axes = input.axes();
  } else if (dbg.autoDrive) {
    const autoStop = autoStopTarget();
    const target = autoStop?.target ?? autoStopTargetS();
    const near = target != null && target - state.s < 110;
    let effTarget = target;
    let vCap = Infinity;
    if (target != null) {
      const d = target - state.s;
      // 停止目標に近いのに寄せが足りない → 目標を少し先送りし微速で寄せ直す
    }
    // 赤信号の停止線が停留所より手前ならそちらを優先
    const redS = traffic.redStopTarget(state.s, bus.v);
    if (redS != null && (effTarget == null || redS < effTarget))
      effTarget = redS;
    // 前方の同行車との車間を保つ(信号待ち行列への追突防止)
    const lead = traffic.leadGapAhead(state.s, state.lateral);
    if (lead != null) {
      const followS = state.s + lead - 11;
      if (effTarget == null || followS < effTarget) effTarget = followS;
    }
    axes = autoDriveInput(
      bus,
      path,
      state.s,
      effTarget,
      autoDockLateralAt(
        state.s + Math.max(8, Math.min(30, 6 + bus.v * 1.8)),
        autoStop?.stop,
      ),
      vCap,
    );
    // ドア操作の自動化: プロンプトが出たら即 E
    if (state.promptText?.startsWith("E :")) ePressed = true;
  } else {
    axes = input.axes();
  }

  bus.step(dt, axes);

  const proj = path.closestS([bus.x, bus.z], state.s, 150);
  state.s = proj.s;
  state.lateral = proj.lateral;
  const roadBounds = driveBoundsAt(state.s);
  const busHalfWidth = CFG.bus.width / 2;
  state.offRoute =
    state.lateral - busHalfWidth < -roadBounds.left - CFG.road.offroadMargin ||
    state.lateral + busHalfWidth > roadBounds.right + CFG.road.offroadMargin;

  if (state.offRoute && bus.v > 15 / 3.6) bus.v = 15 / 3.6;

  state.clock += dt;
  ops.update(dt, ePressed);
  scoring.tick(dt, bus, speedLimitAt(state.s));
  // 衝突判定は後軸でなく車体中心基準
  const [bfx, bfz] = bus.forward;
  traffic.update(
    dt,
    state.s,
    [
      bus.x + bfx * 3.15,
      bus.z + bfz * 3.15,
      surfaceElevationAt(state.s, bus.x + bfx * 3.15, bus.z + bfz * 3.15) + 1.6,
    ],
    bus.v,
    bus.heading,
    state.lateral,
  );
  stopsView.updateWalkers(dt);
}

// ---------------------------------------------------------------- pause overlay
function createPauseOverlay() {
  const div = document.createElement("div");
  div.id = "pause-overlay";
  div.innerHTML = `<div class="pause-card"><div class="pause-title">⏸ PAUSE</div><div class="pause-hint">P キーで再開</div></div>`;
  document.body.appendChild(div);
  return div;
}
let pauseOverlay = null;

function setPaused(on) {
  state.paused = on;
  if (!pauseOverlay) pauseOverlay = createPauseOverlay();
  pauseOverlay.style.display = on ? "flex" : "none";
}

// ---------------------------------------------------------------- return to title
function returnToTitle() {
  // ゲーム状態をリセットしてタイトル画面を再表示する
  state.phase = "TITLE";
  state.paused = false;
  state.demoMode = false;
  setPaused(false);
  // 音声を停止
  sfx.stopEngine();
  // 既存のタイトル画面以外のスクリーンを消す(リザルト等)
  document.querySelectorAll(".screen").forEach((el) => el.remove());
  // バスを始発位置に戻す
  placeBusAtS(Math.max(0.5, route.stops[0].s - DOOR_OFFSET));
  camInit = false;
  // 乗客・スコア・時計をリセット
  pax.reset?.();
  scoring.reset?.();
  state.score = 0;
  state.fareTotal = 0;
  state.nextStopIndex = 0;
  state.doorState = "CLOSED";
  state.buzzer = false;
  state.promptText = null;
  state.completed = false;
  state.clock = firstDepartTime - 45;
  ops.resetTo(0);
  // タイトル再表示
  showTitle((demoMode) => {
    sfx.initAudio();
    initAnnouncements();
    if (demoMode) {
      state.demoMode = true;
      dbg.autoDrive = true;
    } else {
      state.demoMode = false;
      dbg.autoDrive = false;
    }
    announceStart();
    state.phase = "RUNNING";
    state.clock = firstDepartTime - 45;
  });
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

  if (state.phase === "RUNNING") {
    // P キーでポーズトグル
    if (input.pressed("KeyP")) setPaused(!state.paused);

    if (!state.paused) {
      if (input.pressed("KeyC"))
        state.camMode = state.camMode === "chase" ? "cockpit" : "chase";
      if (input.pressed("KeyM")) {
        const el = document.getElementById("minimap");
        el.style.display = el.style.display === "none" ? "block" : "none";
      }
      if (input.pressed("KeyR") && !state.demoMode) {
        if (state.offRoute)
          scoring.add(CFG.score.offroadReset, "コース外から復帰");
        placeBusAtS(state.s);
        camInit = false;
      }

      // . キー長押し中、停留所停車中のみ時間4倍速
      const dotHeld = input.held("Period");
      const atStop = state.doorState !== "CLOSED" || state.waitingDepart;
      const timeMultiplier = dotHeld && atStop ? 4 : 1;

      let ePressed = input.pressed("KeyE");
      acc += dt * dbg.timeScale * timeMultiplier;
      let steps = 0;
      const maxSteps = Math.ceil(6 * dbg.timeScale * timeMultiplier);
      while (acc >= STEP && steps < maxSteps) {
        tick(STEP, ePressed);
        ePressed = false;
        acc -= STEP;
        steps++;
      }
      if (steps === maxSteps) acc = 0;
    }
  }

  busModel.update(
    bus,
    dt,
    surfaceElevationAt(state.s, bus.x, bus.z),
    gradeAt(state.s),
    state.s,
    kujoOmiyaS,
  );
  updateCamera(dt);
  if (state.phase === "RUNNING") {
    sfx.updateEngine(bus.speedKmh, bus.throttleState);
  } else {
    sfx.stopEngine();
  }

  hudTimer -= dt;
  if (hudTimer <= 0 && state.phase !== "TITLE") {
    hudTimer = 0.1;
    const i = Math.min(state.nextStopIndex, route.stops.length - 1);
    const nextStop = route.stops[i];
    const distTo = Math.max(0, nextStop.s - (state.s + DOOR_OFFSET));
    let sub;
    if (state.completed) sub = "終点 おつかれさまでした";
    else if (state.doorState !== "CLOSED") sub = "乗降中";
    else if (state.buzzer)
      sub = `🔔 つぎ とまります ・ あと${distTo.toFixed(0)}m`;
    else if (mustStopAt(i)) sub = `停車 ・ あと${distTo.toFixed(0)}m`;
    else sub = `通過可 ・ あと${distTo.toFixed(0)}m`;
    const started = state.nextStopIndex > 0 || state.doorState !== "CLOSED";
    const d = started ? delayInfo(state.clock, state.s) : null;
    updateHud({
      speedKmh: bus.speedKmh,
      limitKmh: speedLimitKmhAt(state.s),
      clock: state.clock,
      score: Math.round(state.score),
      passengers: pax.onboard,
      fareTotal: state.fareTotal,
      nextStopName: state.completed ? "── 終点 ──" : nextStop.name,
      nextStopSchedule: state.completed ? null : fmtTime(schedule[i].time),
      nextStopSub: sub,
      delayText: d?.text ?? "--",
      delayKind: d?.kind ?? "ontime",
    });
    minimap?.update([bus.x, bus.z], state.nextStopIndex);
  }

  renderer.render(scene, camera);
  input.endFrame();
}

// ---------------------------------------------------------------- boot
initHud();
minimap = createMinimap(path, route.stops);
placeBusAtS(Math.max(0.5, route.stops[0].s - DOOR_OFFSET)); // 始発: 前扉を生成済み停止姿勢に合わせて待機
setupDebug({
  bus,
  path,
  route,
  scene,
  camera,
  tick: (dt, e) => {
    if (state.phase === "RUNNING") tick(dt, e);
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
    nextStop:
      route.stops[Math.min(state.nextStopIndex, route.stops.length - 1)]?.name,
    prompt: state.promptText,
    clock: Math.round(state.clock),
    delay: delayInfo(state.clock, state.s).delay,
    score: Math.round(state.score),
    onboard: pax.onboard,
    carried: pax.totalCarried,
    fare: state.fareTotal,
    buzzer: state.buzzer,
    offRoute: state.offRoute,
    collisionLog: state.collisionLog ?? [],
    autoDrive: dbg.autoDrive,
    timeScale: dbg.timeScale,
    paxSeed: pax.seed,
    boardPlan: pax.board.join(","),
    alightPlan: pax.alight.join(","),
  }),
  onTeleport: (s, stopIndex) => {
    state.s = s;
    camInit = false;
    ops.resetTo(stopIndex ?? 0);
    state.clock = scheduledClockAt(s); // ダイヤも位置に同期
  },
});

showTitle((demoMode) => {
  sfx.initAudio();
  initAnnouncements();
  if (demoMode) {
    state.demoMode = true;
    dbg.autoDrive = true;
  }
  announceStart();
  state.phase = "RUNNING";
  state.clock = firstDepartTime - 45;
});

// ---------------------------------------------------------------- Shift+R: タイトルへ戻る
window.game.debug.returnToTitle = returnToTitle;
function isReturnToTitleShortcut(e) {
  // Keyboard layouts may expose either `code` or the shifted character in
  // `key`; accept both so the documented shortcut works consistently.
  return (
    !e.repeat &&
    e.shiftKey &&
    (e.code === "KeyR" || e.key?.toLowerCase() === "r")
  );
}
window.addEventListener("keydown", (e) => {
  // The shortcut is also useful from the result screen, and should be
  // ignored only while the title screen is already visible.
  if (isReturnToTitleShortcut(e) && state.phase !== "TITLE") {
    e.preventDefault();
    returnToTitle();
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

requestAnimationFrame(frame);
console.info(
  `[M4] game loop ready: ${route.name} ${path.length.toFixed(0)}m / ${route.stops.length} stops / pax seed=${pax.seed}`,
);
