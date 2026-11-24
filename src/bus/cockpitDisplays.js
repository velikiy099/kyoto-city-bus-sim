import * as THREE from "three";

const GAUGE_W = 512;
const GAUGE_H = 256;
const STOP_W = 128;
const STOP_H = 128;
const BOARDING_W = 96;
const BOARDING_H = 256;

const START_DEG = 145;
const SWEEP_DEG = 250;

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function drawBaseCluster(ctx) {
  ctx.fillStyle = "#7a8086";
  ctx.fillRect(0, 0, GAUGE_W, GAUGE_H);

  ctx.strokeStyle = "#1e2226";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, GAUGE_W - 6, GAUGE_H - 6);

  // 上部ワーニングテルテール背景バー
  ctx.fillStyle = "#181b20";
  ctx.fillRect(24, 14, GAUGE_W - 48, 28);

  const dials = [
    {
      cx: 102,
      cy: 133,
      r: 68,
      unit: "km/h",
      ticks: ["0", "20", "40", "60", "80", "100", "120"],
      tach: false,
    },
    {
      cx: 256,
      cy: 133,
      r: 68,
      unit: "x100rpm",
      ticks: ["0", "5", "10", "15", "20", "25", "30"],
      tach: true,
    },
    {
      cx: 410,
      cy: 133,
      r: 68,
      unit: "F / AIR",
      ticks: ["E", "1/2", "F", "0", "5", "10"],
      tach: false,
    },
  ];

  for (const d of dials) {
    ctx.beginPath();
    ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2);
    ctx.fillStyle = "#181c22";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#3e444c";
    ctx.stroke();

    // エコ/レッドゾーン弧
    if (d.tach) {
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(
        d.cx,
        d.cy,
        d.r - 8,
        degToRad(START_DEG + (2 / 6) * SWEEP_DEG),
        degToRad(START_DEG + (4 / 6) * SWEEP_DEG),
      );
      ctx.strokeStyle = "#22c55e";
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(
        d.cx,
        d.cy,
        d.r - 8,
        degToRad(START_DEG + (5 / 6) * SWEEP_DEG),
        degToRad(START_DEG + SWEEP_DEG),
      );
      ctx.strokeStyle = "#ef4444";
      ctx.stroke();
    }

    const n = d.ticks.length;
    const subSteps = (n - 1) * 2;
    for (let s = 0; s <= subSteps; s++) {
      const ang = degToRad(START_DEG + (s / subSteps) * SWEEP_DEG);
      const isMajor = s % 2 === 0;
      const rIn = d.r - (isMajor ? 15 : 10);
      const rOut = d.r - 5;
      ctx.beginPath();
      ctx.moveTo(d.cx + rIn * Math.cos(ang), d.cy + rIn * Math.sin(ang));
      ctx.lineTo(d.cx + rOut * Math.cos(ang), d.cy + rOut * Math.sin(ang));
      ctx.lineWidth = isMajor ? 2.5 : 1.5;
      ctx.strokeStyle = "#cbd5e1";
      ctx.stroke();
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 12px sans-serif";
    d.ticks.forEach((lbl, k) => {
      const ang = degToRad(START_DEG + (k / (n - 1)) * SWEEP_DEG);
      const color =
        d.tach && k >= 2 && k <= 4
          ? "#22c55e"
          : d.tach && k >= 5
            ? "#ef4444"
            : "#f1f5f9";
      ctx.fillStyle = color;
      const rTxt = d.r - 27;
      ctx.fillText(lbl, d.cx + rTxt * Math.cos(ang), d.cy + rTxt * Math.sin(ang));
    });

    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(d.unit, d.cx, d.cy + 26);
  }

  // 下部注意プレート
  ctx.fillStyle = "#d97777";
  ctx.fillRect(154, 218, 296, 24);
  ctx.fillStyle = "#7f1d1d";
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("駅・操車所でブレーキを確認", 302, 230);
}

function drawNeedle(ctx, cx, cy, length, frac, color = "#fb923c") {
  const f = THREE.MathUtils.clamp(frac, 0, 1);
  const ang = degToRad(START_DEG + f * SWEEP_DEG);
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const px = -sin;
  const py = cos;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - cos * 10 + px * 3, cy - sin * 10 + py * 3);
  ctx.lineTo(cx + cos * length + px * 1, cy + sin * length + py * 1);
  ctx.lineTo(cx + cos * length - px * 1, cy + sin * length - py * 1);
  ctx.lineTo(cx - cos * 10 - px * 3, cy - sin * 10 - py * 3);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, 7.5, 0, Math.PI * 2);
  ctx.fillStyle = "#334155";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#94a3b8";
  ctx.stroke();
  ctx.restore();
}

function drawTelltales(ctx, { speedKmh, doorOpen, braking, turnLeft, turnRight }) {
  const parkOn = Math.abs(speedKmh) < 0.2 && (doorOpen || braking);
  const lamps = [
    { x: 72, bg: turnLeft ? "#22c55e" : "#12261c", fg: turnLeft ? "#052e16" : "#3b5948", label: "◀" },
    { x: 134, bg: doorOpen ? "#f59e0b" : "#3a2a14", fg: doorOpen ? "#111317" : "#785a28", label: "扉" },
    { x: 215, bg: parkOn ? "#ef4444" : "#3b181c", fg: parkOn ? "#ffffff" : "#7c2d34", label: "P" },
    { x: 286, bg: braking ? "#ef4444" : "#3b181c", fg: braking ? "#ffffff" : "#7c2d34", label: "●" },
    { x: 358, bg: "#17324a", fg: "#38bdf8", label: "ABS" },
    { x: 440, bg: turnRight ? "#22c55e" : "#12261c", fg: turnRight ? "#052e16" : "#3b5948", label: "▶" },
  ];

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 11px sans-serif";
  for (const l of lamps) {
    ctx.fillStyle = l.bg;
    ctx.fillRect(l.x - 19, 19, 38, 18);
    ctx.fillStyle = l.fg;
    ctx.fillText(l.label, l.x, 28);
  }
}

function buildBoardingLedDots() {
  const off = document.createElement("canvas");
  off.width = BOARDING_W;
  off.height = BOARDING_H;
  const octx = off.getContext("2d");
  octx.clearRect(0, 0, BOARDING_W, BOARDING_H);
  octx.fillStyle = "#ffffff";
  octx.textAlign = "center";
  octx.textBaseline = "middle";
  octx.font = "bold 54px sans-serif";
  octx.fillText("乗", BOARDING_W / 2, 54);
  octx.fillText("降", BOARDING_W / 2, 128);
  octx.fillText("中", BOARDING_W / 2, 202);
  const { data } = octx.getImageData(0, 0, BOARDING_W, BOARDING_H);
  const allDots = [];
  const litDots = [];
  for (let y = 10; y <= BOARDING_H - 10; y += 4) {
    for (let x = 10; x <= BOARDING_W - 10; x += 4) {
      const pt = { x, y };
      allDots.push(pt);
      const a = data[(y * BOARDING_W + x) * 4 + 3];
      if (a > 90) litDots.push(pt);
    }
  }
  return { allDots, litDots };
}

function drawBoardingLamp(ctx, doorOpen, ledGrid) {
  ctx.clearRect(0, 0, BOARDING_W, BOARDING_H);
  ctx.fillStyle = doorOpen ? "#050807" : "#070a09";
  ctx.fillRect(0, 0, BOARDING_W, BOARDING_H);

  ctx.strokeStyle = "#18201b";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, BOARDING_W - 4, BOARDING_H - 4);

  const { allDots, litDots } = ledGrid;
  ctx.fillStyle = "#0e1511";
  for (const d of allDots) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  if (doorOpen) {
    ctx.fillStyle = "rgba(20, 255, 115, 0.34)";
    for (const d of litDots) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, 2.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#22ff6a";
    for (const d of litDots) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, 1.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#caffdc";
    for (const d of litDots) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = "#132218";
    for (const d of litDots) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, 1.15, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawStopIndicator(ctx, buzzer) {
  ctx.clearRect(0, 0, STOP_W, STOP_H);
  const cx = STOP_W / 2;
  const cy = STOP_H / 2;
  const r = 62;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  if (buzzer) {
    const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, r);
    grad.addColorStop(0, "#ff4d2e");
    grad.addColorStop(1, "#d41414");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.lineWidth = 4;
    ctx.strokeStyle = "#ff8a70";
    ctx.stroke();

    ctx.fillStyle = "#140404";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = "bold 38px sans-serif";
    ctx.fillText("停車", cx, cy + 2);
  } else {
    ctx.fillStyle = "#220b0e";
    ctx.fill();

    ctx.lineWidth = 4;
    ctx.strokeStyle = "#120608";
    ctx.stroke();

    ctx.fillStyle = "#48181e";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = "bold 38px sans-serif";
    ctx.fillText("停車", cx, cy + 2);
  }
}

/**
 * 運転席まわりの動的テクスチャ(速度計・タコメータ・運転士頭上「停車」表示)を生成・更新する。
 */
export function createCockpitDisplays() {
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = GAUGE_W;
  baseCanvas.height = GAUGE_H;
  drawBaseCluster(baseCanvas.getContext("2d"));

  const gaugeCanvas = document.createElement("canvas");
  gaugeCanvas.width = GAUGE_W;
  gaugeCanvas.height = GAUGE_H;
  const gCtx = gaugeCanvas.getContext("2d");
  const gaugesTexture = new THREE.CanvasTexture(gaugeCanvas);
  gaugesTexture.colorSpace = THREE.SRGBColorSpace;
  gaugesTexture.flipY = false;

  const stopCanvas = document.createElement("canvas");
  stopCanvas.width = STOP_W;
  stopCanvas.height = STOP_H;
  const sCtx = stopCanvas.getContext("2d");
  const stopIndicatorTexture = new THREE.CanvasTexture(stopCanvas);
  stopIndicatorTexture.colorSpace = THREE.SRGBColorSpace;
  stopIndicatorTexture.flipY = false;

  const boardingCanvas = document.createElement("canvas");
  boardingCanvas.width = BOARDING_W;
  boardingCanvas.height = BOARDING_H;
  const bCtx = boardingCanvas.getContext("2d");
  const boardingLampTexture = new THREE.CanvasTexture(boardingCanvas);
  boardingLampTexture.colorSpace = THREE.SRGBColorSpace;
  boardingLampTexture.flipY = false;
  const boardingLedGrid = buildBoardingLedDots();

  let lastSpeed = -999;
  let lastRpm = -999;
  let lastDoor = null;
  let lastBraking = null;
  let lastTurnLeft = null;
  let lastTurnRight = null;
  let lastBuzzer = null;

  function update({
    speedKmh = 0,
    rpm = 600,
    doorOpen = false,
    braking = false,
    buzzer = false,
    turnLeft = false,
    turnRight = false,
  } = {}) {
    const tl = Boolean(turnLeft);
    const tr = Boolean(turnRight);
    const door = Boolean(doorOpen);
    const brk = Boolean(braking);

    if (
      Math.abs(speedKmh - lastSpeed) >= 0.08 ||
      Math.abs(rpm - lastRpm) >= 4 ||
      door !== lastDoor ||
      brk !== lastBraking ||
      tl !== lastTurnLeft ||
      tr !== lastTurnRight
    ) {
      if (door !== lastDoor) {
        drawBoardingLamp(bCtx, door, boardingLedGrid);
        boardingLampTexture.needsUpdate = true;
      }
      lastSpeed = speedKmh;
      lastRpm = rpm;
      lastDoor = door;
      lastBraking = brk;
      lastTurnLeft = tl;
      lastTurnRight = tr;

      gCtx.drawImage(baseCanvas, 0, 0);
      drawTelltales(gCtx, {
        speedKmh,
        doorOpen: door,
        braking: brk,
        turnLeft: tl,
        turnRight: tr,
      });
      drawNeedle(gCtx, 102, 133, 52, Math.abs(speedKmh) / 120, "#f8fafc");
      drawNeedle(gCtx, 256, 133, 52, rpm / 3000, "#fb923c");
      const airFrac = door ? 0.68 : brk ? 0.74 : 0.78;
      drawNeedle(gCtx, 410, 133, 48, airFrac, "#f8fafc");
      gaugesTexture.needsUpdate = true;
    }

    const buzz = Boolean(buzzer);
    if (buzz !== lastBuzzer) {
      lastBuzzer = buzz;
      drawStopIndicator(sCtx, buzz);
      stopIndicatorTexture.needsUpdate = true;
    }
  }

  update({
    speedKmh: 0,
    rpm: 600,
    doorOpen: false,
    braking: false,
    buzzer: false,
    turnLeft: false,
    turnRight: false,
  });

  return {
    gaugesTexture,
    stopIndicatorTexture,
    boardingLampTexture,
    update,
  };
}
