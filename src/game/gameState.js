import { CFG } from '../config.js';
import { leftWidthAt } from '../route/routeData.js';
import { schedule, fmtTime, delayInfo } from './timetable.js';
import { setPrompt, setDoorStatus, showToast } from '../ui/hud.js';

export const DOOR = { CLOSED: 'CLOSED', OPENING: 'OPENING', OPEN: 'OPEN', CLOSING: 'CLOSING' };

/**
 * 停車業務の中枢: ドア開閉・正着判定・乗降・発車条件・通過違反
 * ctx: { bus, path, route, state, scoring, pax, stopsView, events }
 * events(任意): onDoorOpen/onDoorClose/onDepart(i)/onArrive(i)/onFare/onBuzzer/onComplete
 */
export function createOps(ctx) {
  const { bus, route, state, scoring, pax, stopsView, events = {} } = ctx;
  const O = CFG.ops;
  const S = CFG.score;

  state.doorState = DOOR.CLOSED;
  state.nextStopIndex = 0;
  state.buzzer = false;
  let doorT = 0;
  let boarding = null; // {alightLeft, boardLeft, aTimer, bTimer}
  let waitingDepart = false; // 停車完了しドアも閉、発車待ち(始発は乗車業務から)
  let stoppedIndex = 0; // waitingDepart 中の停留所
  let recentMinAccel = 0; // 直近の減速スパイク(スムーズ停車判定)
  let buzzerAnnounced = false;

  // 初期: 全停留所に待ち客を表示
  route.stops.forEach((_, i) => stopsView.setWaiting(i, pax.board[i]));

  /** 前扉の弧長位置(後軸 s + 前扉オフセット) */
  const doorS = () => state.s + CFG.bus.wheelbase + 1.2;
  /** 縁石ギャップ [m](車体左側面とその地点の実効縁石の距離。複数車線区間は路肩基準) */
  const curbGap = () => state.lateral - CFG.bus.width / 2 + leftWidthAt(state.s);

  function openDoor() {
    const stop = route.stops[state.nextStopIndex];
    const err = Math.abs(doorS() - stop.s);
    const gap = curbGap();
    if (err <= O.perfectWindow && gap <= 0.5) scoring.add(S.perfectStop, '正着!');
    else if (err <= 3.0) scoring.add(S.goodStop, '停車OK');
    else scoring.add(S.okStop, '停車');
    if (recentMinAccel > -3.2) scoring.add(S.smoothStop, 'スムーズ停車');
    state.doorState = DOOR.OPENING;
    doorT = 0;
    bus.throttleLocked = true;
    events.onDoorOpen?.();
  }

  function startBoarding() {
    const i = state.nextStopIndex;
    boarding = {
      alightLeft: pax.alight[i],
      boardLeft: pax.board[i],
      aTimer: 0.6,
      bTimer: 0.9,
    };
  }

  function finishStop() {
    waitingDepart = true;
    stoppedIndex = state.nextStopIndex;
    state.buzzer = false;
  }

  function depart(early) {
    const i = stoppedIndex;
    const sched = schedule[i];
    if (!early && sched.checkpoint) {
      const d = state.clock - sched.time;
      if (d >= 0 && d <= 30) scoring.add(S.onTimeDepart, '定時発車');
    }
    waitingDepart = false;
    buzzerAnnounced = false;
    if (state.nextStopIndex === i) state.nextStopIndex = i + 1;
    events.onDepart?.(i);
  }

  function advancePassed(mustStop) {
    if (mustStop) {
      scoring.add(S.skipStop, '停車違反(通過)');
      // 乗れなかった客は消える(苦情)
      stopsView.setWaiting(state.nextStopIndex, 0);
    } else {
      showToast('通過(乗降なし)', 'good');
    }
    state.buzzer = false;
    buzzerAnnounced = false;
    state.nextStopIndex++;
    waitingDepart = false;
  }

  function complete() {
    scoring.add(S.complete, '完走ボーナス');
    events.onComplete?.();
  }

  return {
    get doorState() { return state.doorState; },
    /** teleport 用: 業務状態を指定停留所の手前走行中に合わせる */
    resetTo(stopIndex) {
      state.nextStopIndex = stopIndex;
      state.doorState = DOOR.CLOSED;
      state.buzzer = false;
      waitingDepart = false;
      boarding = null;
      buzzerAnnounced = false;
      doorT = 0;
      bus.throttleLocked = false;
      setDoorStatus(null);
    },
    update(dt, ePressed) {
      const i = state.nextStopIndex;
      const last = i >= route.stops.length;
      const stop = last ? null : route.stops[i];

      // スムーズ停車判定用: 減速スパイクを減衰記録(微速域の停止カックンは対象外)
      recentMinAccel = recentMinAccel + dt * 2.0;
      if (bus.v > 2) recentMinAccel = Math.min(bus.accel, recentMinAccel);
      recentMinAccel = Math.min(recentMinAccel, 0);

      // 降車ブザー(次停に降車客 → 接近300mで点灯)
      if (!last && !waitingDepart && state.doorState === DOOR.CLOSED) {
        if (!buzzerAnnounced && pax.alight[i] > 0 && stop.s - state.s < 300) {
          state.buzzer = true;
          buzzerAnnounced = true;
          events.onBuzzer?.();
        }
      }

      // ---- ドア状態機械 ----
      bus.throttleLocked = state.doorState !== DOOR.CLOSED;
      let prompt = null, promptWarn = false;

      switch (state.doorState) {
        case DOOR.CLOSED: {
          if (waitingDepart) {
            // 発車待ち(ドア閉済み)
            const sched = schedule[stoppedIndex];
            const untilDepart = sched.time - state.clock;
            if (sched.checkpoint && untilDepart > O.departEarlyGrace) {
              prompt = `発車時刻 ${fmtTime(sched.time)} まで待機 (あと${Math.ceil(untilDepart)}秒)`;
              promptWarn = true;
              if (bus.v > 0.5) {
                scoring.add(S.earlyDepart, '早発!');
                depart(true);
              }
            } else if (bus.v > 0.5) {
              depart(false);
            }
            break;
          }
          if (last) break;
          const dS = doorS();
          const inZone = Math.abs(dS - stop.s) <= O.stopWindow * 2 && curbGap() <= O.curbWindow + 1.2;
          if (Math.abs(bus.v) < 0.1 && inZone) {
            const err = dS - stop.s;
            if (Math.abs(err) <= O.stopWindow * 2) {
              prompt = 'E : ドア開(乗降)';
              if (Math.abs(err) > 3) prompt += `  [停止線まで ${err > 0 ? '下がる' : '進む'} ${Math.abs(err).toFixed(1)}m]`;
              if (ePressed) openDoor();
            }
          } else if (Math.abs(bus.v) < 0.1 && Math.abs(dS - stop.s) <= O.stopWindow * 2 && curbGap() > O.curbWindow + 1.2) {
            // 位置は合っているが寄せ不足
            prompt = `左に寄せて停車してください(縁石との間隔 ${curbGap().toFixed(1)}m)`;
            promptWarn = true;
          } else if (dS > stop.s + 18 && bus.v > 1) {
            // 通過
            // 時刻表対象(checkpoint)停留所は乗降がなくても停車義務(時間調整)
            advancePassed(pax.mustStopAt(i) || schedule[i].checkpoint);
          }
          break;
        }
        case DOOR.OPENING: {
          doorT += dt;
          prompt = 'ドア開放中…';
          if (doorT >= O.doorTime) {
            state.doorState = DOOR.OPEN;
            startBoarding();
          }
          break;
        }
        case DOOR.OPEN: {
          const b = boarding;
          if (b.alightLeft > 0) {
            b.aTimer -= dt;
            if (b.aTimer <= 0) {
              b.alightLeft--;
              b.aTimer = O.alightInterval;
              pax.alightOne();
              state.fareTotal += O.fare;
              stopsView.spawnAlighting(i);
              events.onFare?.();
            }
          }
          if (b.boardLeft > 0) {
            b.bTimer -= dt;
            if (b.bTimer <= 0) {
              b.boardLeft--;
              b.bTimer = O.boardInterval;
              pax.boardOne();
              stopsView.setWaiting(i, b.boardLeft);
            }
          }
          const busy = b.alightLeft > 0 || b.boardLeft > 0;
          setDoorStatus(
            `降車 のこり${b.alightLeft}人 ・ 乗車 のこり${b.boardLeft}人<br>運賃箱 ¥${state.fareTotal.toLocaleString()}`
          );
          if (!busy) {
            prompt = 'E : ドア閉';
            if (ePressed) {
              state.doorState = DOOR.CLOSING;
              doorT = 0;
              setDoorStatus(null);
              events.onDoorClose?.();
            }
          }
          break;
        }
        case DOOR.CLOSING: {
          doorT += dt;
          prompt = 'ドア閉鎖中…';
          if (doorT >= O.doorTime) {
            state.doorState = DOOR.CLOSED;
            if (state.nextStopIndex === route.stops.length - 1) {
              state.nextStopIndex++;
              complete();
            } else {
              finishStop();
            }
          }
          break;
        }
      }

      state.promptText = prompt;
      state.waitingDepart = waitingDepart;
      setPrompt(prompt, promptWarn);
      return { waitingDepart };
    },
  };
}
