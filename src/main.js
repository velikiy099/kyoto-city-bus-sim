import * as THREE from "three";
import "./style.css";
import { CFG } from "./config.js";
import { loadSessionBundle } from "./route/loadSession.js";
import { listRoutes, resolveRouteId } from "./route/routeRegistry.js";
import { input } from "./input.js";
import { BusPhysics } from "./bus/busPhysics.js";
import { createBusModel } from "./bus/busModel.js";
import { resolveHeadsignPhaseId } from "./bus/destinationDisplay.js";
import {
  buildContinuousTerrain,
  configureTerrainGrid,
  configureWorldHeightSamplers,
  terrainHeightAtWorld,
  roadHeightAtWorld,
} from "./world/declarative/continuousTerrain.js";
import { setupDebug, dbg, autoDriveInput, recordFrame } from "./debug.js";
import { initHud, updateHud, clearHudMessages } from "./ui/hud.js";
import { createMinimap } from "./ui/minimap.js";
import { showTitle, showResult } from "./ui/screens.js";
import { buildStops } from "./game/stops.js";
import { createPassengers } from "./game/passengers.js";
import { createScoring } from "./game/scoring.js";
import { createOps } from "./game/gameState.js";
import { createTimetable, fmtTime } from "./game/timetable.js";
import { buildLandmarks, resolveTerminusStopOverride } from "./world/landmarks.js";
import { buildNature } from "./world/nature.js";
import { buildRailways } from "./world/railways.js";
import { buildTraffic } from "./world/traffic/index.js";
import { buildWorldScenery } from "./world/declarative/buildWorldScenery.js";
import * as sfx from "./audio/sfx.js";
import { createAnnouncements } from "./audio/announcements.js";

const STEP = 1 / 60;
const DOOR_OFFSET = CFG.bus.wheelbase + 1.3; // 後軸→前扉

const selectedRouteId = resolveRouteId(window.location.search);
const { region, world, route } = await loadSessionBundle(selectedRouteId);
const semantics = route.semantics ?? {};
if (semantics.documentTitle || semantics.routeTitle) {
  document.title = semantics.documentTitle ?? semantics.routeTitle;
}

const path = route.path;
const timetable = createTimetable(route.stops, route.definitions.timetable);
const { schedule, firstDepartTime, scheduledClockAt, delayInfo } = timetable;
const announcements = createAnnouncements(route.definitions.announcements);

configureTerrainGrid(world.terrainGrid);
configureWorldHeightSamplers(
  path,
  world.terrainElevationAt,
  world.elevationAt,
  world.roadAttachmentHalfWidthAt,
  world.surfacePath,
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

const baseTerrain = buildContinuousTerrain(path, world.bridges, world.rivers);
scene.add(baseTerrain);
let railwaysView = null;
void buildWorldScenery(scene, path, world, {
  buildRailways,
  buildLandmarks,
  buildNature,
  turnExclusions: world.turnExclusions,
  elevationAt: world.elevationAt,
  terrainHeightAtWorld,
  roadHeightAtWorld,
  baseTerrain,
}).then((res) => {
  railwaysView = res?.railways ?? null;
});

// ---------------------------------------------------------------- bus / game objects
const bus = new BusPhysics();
const busModel = createBusModel({
  destinationDisplayOptions: {
    routeNumber: semantics.routeNumber,
    phases: semantics.headsignPhases,
    oncomingHeadsign: semantics.oncomingHeadsign,
  },
});
scene.add(busModel.root);

const state = {
  phase: "TITLE",
  s: 0,
  lateral: 0,
  offRoute: false,
  clock: firstDepartTime - 45, // 始発発車の 45 秒前から乗車扱い
  score: 0,
  fareTotal: 0,
  nextStopIndex: 0,
  doorState: "CLOSED",
  buzzer: false,
  turnSignal: 0, // -1=左(Q), 0=消灯, +1=右(E)
  hazard: false, // ハザード(T)
  blinkTimer: 0,
  blinkOn: false,
  promptText: null,
  camMode: "chase",
  completed: false,
  paused: false,
  demoMode: false,
};

const pax = createPassengers(route.stops.length);
const stopsView = buildStops(scene, path, route.stops, {
  elevationAt: world.elevationAt,
  operatorName: semantics.operatorName ?? region.defaultOperatorName,
  resolveStopOverride: (stop) =>
    resolveTerminusStopOverride(path, stop, world.definitions.landmarks),
});
const scoring = createScoring(state);
const traffic = buildTraffic(scene, path, {
  world,
  stops: route.stops,
  trafficPaths: world.trafficPaths,
  trafficGraph: world.trafficGraph,
  useTrafficGraph: true,
  onCollision() {
    scoring.add(CFG.score.collision, "他車と接触!");
    (state.collisionLog ??= []).push(Math.round(state.s)); // 発生位置(デバッグ用)
  },
  onRedLight() {
    scoring.add(CFG.score.redLight, "信号無視!");
  },
});
let completeTimer = null;
const ops = createOps({
  bus,
  route,
  timetable,
  state,
  scoring,
  pax,
  stopsView,
  events: {
    onDoorOpen: () => {
      sfx.doorAir();
      sfx.doorBuzzer();
    },
    onDoorClose: () => {
      sfx.doorAir();
      sfx.doorBuzzer();
      announcements.announceDoorClose();
    },
    onFare: () => sfx.coin(),
    onBoard: () => sfx.middleDoorSensorBuzzer(1.5),
    onBuzzer: () => {
      sfx.buzzer();
      announcements.announceStopping();
    },
    onDepart() {
      const next = route.stops[state.nextStopIndex];
      if (next) announcements.announceNext(next.name);
    },
    onComplete() {
      state.completed = true;
      bus.v = 0;
      bus.throttleState = 0;
      bus.accel = 0;
      bus.latAccel = 0;
      bus.throttleLocked = true;
      dbg.autoDrive = false;
      state.turnSignal = 0;
      state.hazard = false;
      state.blinkTimer = 0;
      state.blinkOn = false;
      pendingDoorToggle = false;
      sfx.setLeftTurnVoice(false);
      sfx.setReverseBuzzer(false);
      const summary = scoring.resultSummary();
      const arrivalClock = state.clock;
      const carried = pax.totalCarried;
      const fare = state.fareTotal;
      const d = delayInfo(arrivalClock, path.length - 1);
      announcements.announceTerminal();
      if (completeTimer) clearTimeout(completeTimer);
      completeTimer = setTimeout(() => {
        completeTimer = null;
        if (!state.completed) return;
        state.phase = "RESULT";
        showResult(
          {
            score: summary.score,
            rank: summary.rank,
            carried,
            fare,
            clock: arrivalClock,
            schedArrival: schedule[schedule.length - 1].time,
            delayText: d.text,
            breakdown: summary.breakdown,
          },
          semantics,
        );
      }, 1200);
    },
  },
  isAutoDrive: () => dbg.autoDrive,
});

function placeBusAtS(s) {
  const [px, pz] = path.getPoint(s);
  const [tx, tz] = path.getTangent(s);
  bus.x = px;
  bus.z = pz;
  bus.heading = Math.atan2(tx, tz);
  bus.v = 0;
  bus.delta = 0;
  bus.gear = 1;
  bus.rpm = 600;
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
  const camElev = world.elevationAt(Math.max(0, state.s - 13));
  const lookElev = world.elevationAt(state.s + 8);
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

function guideSampleLateralAt(samples, s) {
  if (!samples?.length) return 0;
  if (s <= samples[0][0]) return samples[0][1];
  if (s >= samples.at(-1)[0]) return samples.at(-1)[1];
  let lo = 0, hi = samples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] <= s) lo = mid;
    else hi = mid;
  }
  const a = samples[lo], b = samples[hi];
  const t = (s - a[0]) / Math.max(1e-6, b[0] - a[0]);
  return a[1] + (b[1] - a[1]) * t;
}

function autoLaneGuideLateralAt(s) {
  for (const guide of route.autoLaneGuides ?? []) {
    if (s < guide.fromS || s > guide.toS) continue;
    const baseLat = guideSampleLateralAt(guide.samples, s);
    if (s < guide.holdFromS) {
      return baseLat * smoothstep01((s - guide.fromS) / Math.max(1e-6, guide.holdFromS - guide.fromS));
    }
    if (s <= guide.holdToS) return baseLat;
    return baseLat * (1 - smoothstep01((s - guide.holdToS) / Math.max(1e-6, guide.toS - guide.holdToS)));
  }
  return 0;
}

// ---------------------------------------------------------------- game tick (fixed step)
function tick(dt, ePressed) {
  let axes;
  if (input.overrideActive) {
    axes = input.axes();
  } else if (dbg.autoDrive) {
    const autoStop = autoStopTarget();
    const target = autoStop?.target ?? autoStopTargetS();
    let effTarget = target;
    let vCap = Infinity;
    const lookaheadS = state.s + Math.max(8, Math.min(30, 6 + bus.v * 1.8));
    const dockLat = autoDockLateralAt(lookaheadS, autoStop?.stop);
    const guideLat = autoLaneGuideLateralAt(lookaheadS);
    const targetLat = Math.abs(dockLat) > 1e-3 ? dockLat : guideLat;
    // 赤信号の停止線が停留所より手前ならそちらを優先
    const redS = traffic.redStopTarget(state.s, bus.v);
    if (redS != null && (effTarget == null || redS < effTarget))
      effTarget = redS;
    // 前方の同行車との車間を保つ(信号待ち行列への追突や車線変更中の接触を防止)
    let lead = traffic.leadGapAhead(state.s, state.lateral);
    if (Math.abs(targetLat - state.lateral) > 0.35) {
      const targetLead = traffic.leadGapAhead(state.s, targetLat);
      if (targetLead != null && (lead == null || targetLead < lead)) {
        lead = targetLead;
      }
    }
    if (lead != null) {
      const followS = state.s + Math.max(0, lead - 4.0);
      if (effTarget == null || followS < effTarget) effTarget = followS;
    }
    axes = autoDriveInput(
      bus,
      path,
      state.s,
      effTarget,
      targetLat,
      vCap,
      route.speedLimitAt,
    );
    // ドア操作の自動化: プロンプトが出たら即 F
    if (state.promptText?.startsWith("F :")) ePressed = true;
  } else {
    axes = input.axes();
  }

  bus.step(dt, axes);

  const proj = path.closestS([bus.x, bus.z], state.s, 150);
  state.s = proj.s;
  state.lateral = proj.lateral;
  const roadBounds = route.driveBoundsAt(state.s);
  const busHalfWidth = CFG.bus.width / 2;
  state.offRoute =
    state.lateral - busHalfWidth < -roadBounds.left - CFG.road.offroadMargin ||
    state.lateral + busHalfWidth > roadBounds.right + CFG.road.offroadMargin;

  if (state.offRoute && bus.v > 15 / 3.6) bus.v = 15 / 3.6;

  state.clock += dt;
  ops.update(dt, ePressed);
  if (state.completed) return;
  // 衝突判定・中央線判定は後軸でなく車体中心基準
  const [bfx, bfz] = bus.forward;
  const centerOffset = CFG.bus.length / 2 - CFG.bus.rearOverhang;
  const hasCenterline = route.hasCenterlineAt(state.s);
  const centerLateral = hasCenterline
    ? route.centerlineLateralAt(
        bus.x + bfx * centerOffset,
        bus.z + bfz * centerOffset,
        state.s,
      )
    : -Infinity;
  scoring.tick(dt, bus, route.speedLimitAt(state.s), {
    hasCenterline,
    centerLateral,
  });
  traffic.update(
    dt,
    state.s,
    [
      bus.x + bfx * centerOffset,
      bus.z + bfz * centerOffset,
      route.surfaceElevationAt(state.s, bus.x + bfx * centerOffset, bus.z + bfz * centerOffset) + 1.6,
    ],
    bus.v,
    bus.heading,
    state.lateral,
  );
  stopsView.updateWalkers(dt);
  railwaysView?.update?.(dt);
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
  pendingDoorToggle = false;
  if (!pauseOverlay) pauseOverlay = createPauseOverlay();
  pauseOverlay.style.display = on ? "flex" : "none";
}

function openTitleScreen() {
  showTitle({
    route,
    semantics,
    schedule,
    availableRoutes: listRoutes(),
    currentRouteId: route.id,
    onSelectRoute(nextRouteId) {
      const params = new URLSearchParams(window.location.search);
      params.set("route", nextRouteId);
      window.location.search = params.toString();
    },
    onStart(demoMode) {
      sfx.initAudio();
      announcements.init();
      if (demoMode) {
        state.demoMode = true;
        dbg.autoDrive = true;
      } else {
        state.demoMode = false;
        dbg.autoDrive = false;
      }
      announcements.announceStart();
      state.phase = "RUNNING";
      state.clock = firstDepartTime - 45;
    },
  });
}

// ---------------------------------------------------------------- return to title
function returnToTitle() {
  // ゲーム状態を完全にリセットしてタイトル画面を再表示する
  if (completeTimer) {
    clearTimeout(completeTimer);
    completeTimer = null;
  }
  state.phase = "TITLE";
  state.paused = false;
  state.demoMode = false;
  dbg.autoDrive = false;
  setPaused(false);
  // 音声を停止
  sfx.stopEngine();
  // 既存のタイトル画面以外のスクリーンとHUDメッセージを消す
  document.querySelectorAll(".screen").forEach((el) => el.remove());
  clearHudMessages();
  // バスを始発位置・完全停止状態に戻す
  placeBusAtS(Math.max(0.5, route.stops[0].s - DOOR_OFFSET));
  bus.throttleState = 0;
  bus.accel = 0;
  bus.latAccel = 0;
  bus.throttleLocked = false;
  bus.reverseArmed = false;
  bus.reverseHold = 0;
  bus.brakeWasDown = false;
  bus.brakeLamp = false;
  bus.reversing = false;
  bus.gear = 1;
  bus.rpm = 600;
  camInit = false;
  // 乗客・スコア・停留所・NPC交通・時計を全て初期化
  pax.reset();
  scoring.reset();
  stopsView.clearWalkers();
  traffic.reset();
  state.lateral = 0;
  state.offRoute = false;
  state.fareTotal = 0;
  state.nextStopIndex = 0;
  state.doorState = "CLOSED";
  state.buzzer = false;
  state.turnSignal = 0;
  state.hazard = false;
  state.blinkTimer = 0;
  state.blinkOn = false;
  state.promptText = null;
  state.waitingDepart = false;
  state.completed = false;
  pendingDoorToggle = false;
  state.collisionLog = [];
  state.clock = firstDepartTime - 45;
  ops.resetForNewRun();
  // タイトル再表示
  openTitleScreen();
}

// ---------------------------------------------------------------- frame loop
let minimap = null; // initHud() 後に生成
let last = performance.now();
let acc = 0;
let hudTimer = 0;
let pendingDoorToggle = false;

function frame(now) {
  requestAnimationFrame(frame);
  const dtMs = Math.min(100, now - last);
  last = now;
  recordFrame(dtMs);
  const dt = dtMs / 1000;

  if (state.phase === "RUNNING") {
    // P キーでポーズトグル(完走後は無効)
    if (!state.completed && input.pressed("KeyP")) setPaused(!state.paused);

    if (!state.paused && !state.completed) {
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

      // Q / E / T キーでウインカー(左 / 右) / ハザードをトグル
      if (input.pressed("KeyT")) {
        state.hazard = !state.hazard;
        state.turnSignal = 0;
        state.blinkTimer = 0;
        state.blinkOn = state.hazard;
        if (state.blinkOn) sfx.blinkerClick(true);
      } else if (input.pressed("KeyQ")) {
        state.hazard = false;
        state.turnSignal = state.turnSignal === -1 ? 0 : -1;
        state.blinkTimer = 0;
        state.blinkOn = state.turnSignal !== 0;
        if (state.blinkOn) sfx.blinkerClick(true);
      } else if (input.pressed("KeyE")) {
        state.hazard = false;
        state.turnSignal = state.turnSignal === 1 ? 0 : 1;
        state.blinkTimer = 0;
        state.blinkOn = state.turnSignal !== 0;
        if (state.blinkOn) sfx.blinkerClick(true);
      }
      if (state.hazard || state.turnSignal !== 0) {
        state.blinkTimer += dt;
        let phaseDur = state.blinkOn ? 0.354 : 0.332;
        while (state.blinkTimer >= phaseDur) {
          state.blinkTimer -= phaseDur;
          state.blinkOn = !state.blinkOn;
          sfx.blinkerClick(state.blinkOn);
          phaseDur = state.blinkOn ? 0.354 : 0.332;
        }
      } else {
        state.blinkTimer = 0;
        state.blinkOn = false;
      }

      // . キー長押し中、停留所停車中のみ時間4倍速
      const dotHeld = input.held("Period");
      const atStop = state.doorState !== "CLOSED" || state.waitingDepart;
      const timeMultiplier = dotHeld && atStop ? 4 : 1;

      if (input.pressed("KeyF")) pendingDoorToggle = true;
      acc += dt * dbg.timeScale * timeMultiplier;
      let steps = 0;
      const maxSteps = Math.ceil(6 * dbg.timeScale * timeMultiplier);
      while (acc >= STEP && steps < maxSteps) {
        tick(STEP, pendingDoorToggle);
        pendingDoorToggle = false;
        acc -= STEP;
        steps++;
      }
      if (steps === maxSteps) acc = 0;
    }
  }

  busModel.update(
    bus,
    dt,
    route.surfaceElevationAt(state.s, bus.x, bus.z),
    route.gradeAt(state.s),
    {
      headsignPhaseId: resolveHeadsignPhaseId(
        semantics.headsignPhases,
        route.stops,
        state.nextStopIndex,
        state.s,
      ),
      buzzer: Boolean(state.buzzer && state.doorState === "CLOSED"),
      doorOpen: state.doorState !== "CLOSED",
      braking: bus.brakeLamp,
      reversing: bus.reversing,
      turnLeft: state.blinkOn && (state.hazard || state.turnSignal === -1),
      turnRight: state.blinkOn && (state.hazard || state.turnSignal === 1),
    },
  );
  updateCamera(dt);
  if (state.phase === "RUNNING" && !state.paused && !state.completed) {
    sfx.updateEngine(bus.speedKmh, bus.throttleState);
    sfx.setLeftTurnVoice(
      !state.hazard && state.turnSignal === -1 && state.doorState === "CLOSED",
    );
    sfx.setReverseBuzzer(Boolean(bus.reversing));
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
    else if (mustStopAt(i)) sub = `要停車 ・ あと${distTo.toFixed(0)}m`;
    else sub = `通過可 ・ あと${distTo.toFixed(0)}m`;
    const started = state.nextStopIndex > 0 || state.clock > firstDepartTime;
    const d = started ? delayInfo(state.clock, state.s) : null;
    updateHud({
      speedKmh: bus.speedKmh,
      limitKmh: route.speedLimitKmhAt(state.s),
      clock: state.clock,
      score: Math.round(state.score),
      passengers: pax.onboard,
      fareTotal: state.fareTotal,
      demoMode: state.demoMode,
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
minimap = createMinimap(path, route.stops, {
  origin: semantics.origin,
  terminal: semantics.terminal,
});
placeBusAtS(Math.max(0.5, route.stops[0].s - DOOR_OFFSET)); // 始発: 前扉を生成済み停止姿勢に合わせて待機
setupDebug({
  bus,
  path,
  route,
  traffic,
  scene,
  camera,
  tick: (dt, e) => {
    if (state.phase === "RUNNING") tick(dt, e);
  },
  getState: () => ({
    routeId: route.id,
    regionId: region.id,
    phase: state.phase,
    s: +state.s.toFixed(1),
    x: +bus.x.toFixed(1),
    z: +bus.z.toFixed(1),
    lateral: +state.lateral.toFixed(2),
    vKmh: +bus.speedKmh.toFixed(1),
    rpm: Math.round(bus.rpm),
    gear: bus.gear,
    turnSignal: state.turnSignal,
    hazard: state.hazard,
    brakeLamp: bus.brakeLamp,
    reversing: bus.reversing,
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
    traffic.reset();
    state.clock = scheduledClockAt(s); // ダイヤも位置に同期
  },
});

openTitleScreen();

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
