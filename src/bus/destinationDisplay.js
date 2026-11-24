import * as THREE from "three";

const SIGN_WIDTH = 512;
const SIGN_HEIGHT = 128;
const NUMBER_BOX_X = 408;
const NUMBER_BOX_COLOR = "#0068d9";
const TEXT_RIGHT = NUMBER_BOX_X - 12;
const JAPANESE_MAX_SIZE = 50;
const ENGLISH_MAX_SIZE = 23;
const DIVIDER_Y = 81;
const NUMBER_VERTICAL_SCALE = 1.3;

function fittedFont(ctx, text, maxSize, maxWidth, weight = "bold") {
  let size = maxSize;
  while (size > 12) {
    ctx.font = `${weight} ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return ctx.font;
    size -= 1;
  }
  return `${weight} ${size}px sans-serif`;
}

function drawCentered(ctx, text, y, maxSize, maxWidth, color = "#ffffff") {
  if (!text) return;
  ctx.fillStyle = color;
  ctx.font = fittedFont(ctx, text, maxSize, maxWidth);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, TEXT_RIGHT / 2, y, maxWidth);
}

function drawLeftAligned(ctx, text, x, y, maxSize, maxWidth, color = "#ffffff") {
  if (!text) return;
  ctx.fillStyle = color;
  ctx.font = fittedFont(ctx, text, maxSize, maxWidth);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y, maxWidth);
}

function drawJustified(ctx, text, y, maxSize, left, right, color = "#ffffff") {
  if (!text) return;
  const chars = Array.from(text);
  ctx.fillStyle = color;
  ctx.font = fittedFont(ctx, text, maxSize, right - left);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  if (chars.length < 2) {
    ctx.fillText(text, left, y);
    return;
  }

  const widths = chars.map((char) => ctx.measureText(char).width);
  const gap = (right - left - widths.reduce((sum, width) => sum + width, 0)) / (chars.length - 1);
  let x = left;
  chars.forEach((char, i) => {
    ctx.fillText(char, x, y);
    x += widths[i] + gap;
  });
}

function drawDisplay(ctx, routeNumber, copy) {
  ctx.clearRect(0, 0, SIGN_WIDTH, SIGN_HEIGHT);
  ctx.fillStyle = "#0d1116";
  ctx.fillRect(0, 0, SIGN_WIDTH, SIGN_HEIGHT);

  // Route number panel retained from the existing city-bus sign layout.
  ctx.fillStyle = NUMBER_BOX_COLOR;
  ctx.fillRect(NUMBER_BOX_X, 0, SIGN_WIDTH - NUMBER_BOX_X, SIGN_HEIGHT);
  const numberPanelWidth = SIGN_WIDTH - NUMBER_BOX_X;
  const label = String(routeNumber ?? "");
  ctx.font = fittedFont(ctx, label, 128, numberPanelWidth - 8);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const numberX = NUMBER_BOX_X + numberPanelWidth / 2;
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.save();
  ctx.translate(numberX, 66);
  ctx.scale(1, NUMBER_VERTICAL_SCALE);
  ctx.strokeText(label, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, 0, 0);
  ctx.restore();

  const resolvedCopy = copy ?? { via: null, japanese: "", english: "" };
  const compact = !resolvedCopy.via;
  ctx.fillStyle = compact ? "#ffffff" : "#d79cff";
  if (!compact) ctx.fillRect(8, 8, 7, SIGN_HEIGHT - 16);
  ctx.fillRect(compact ? 0 : 13, DIVIDER_Y, TEXT_RIGHT - (compact ? 0 : 13), 3);

  const left = 30;
  drawLeftAligned(ctx, resolvedCopy.via, left, 24, 25, TEXT_RIGHT - left - 10, "#fff4cf");
  if (resolvedCopy.via) {
    drawLeftAligned(ctx, resolvedCopy.japanese, left + 22, 55, JAPANESE_MAX_SIZE, TEXT_RIGHT - left - 32);
  } else {
    drawJustified(ctx, resolvedCopy.japanese, 48, JAPANESE_MAX_SIZE, 14, TEXT_RIGHT - 2);
  }
  drawCentered(ctx, resolvedCopy.english, 108, ENGLISH_MAX_SIZE, TEXT_RIGHT - 28);
}

/**
 * Determine which headsign phase ID should be active at `(nextStopIndex, progressS)`
 * based on declarative `switchAtStop` entries in `phases`.
 */
export function resolveHeadsignPhaseId(phases = [], stops = [], nextStopIndex = 0, progressS = 0) {
  if (!Array.isArray(phases) || !phases.length) return "initial";
  let activeId = phases[0].id ?? "initial";
  for (const phase of phases) {
    if (!phase?.switchAtStop) continue;
    const stopIdx = stops.findIndex((stop) => stop.name === phase.switchAtStop);
    if (stopIdx >= 0 && (nextStopIndex > stopIdx || progressS >= stops[stopIdx].s)) {
      activeId = phase.id;
    }
  }
  return activeId;
}

/**
 * Create a destination display texture shared by all faces of one bus.
 */
export function createDestinationDisplay({
  routeNumber = "",
  phases = [],
  oncomingHeadsign = null,
  direction = "self",
} = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = SIGN_WIDTH;
  canvas.height = SIGN_HEIGHT;
  const context = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;

  const phaseMap = new Map((phases ?? []).map((p) => [p.id, p.copy]));
  const defaultPhaseId = phases?.[0]?.id ?? "initial";
  let phaseId = direction === "oncoming" ? "oncoming" : defaultPhaseId;

  const render = () => {
    const copy = direction === "oncoming"
      ? oncomingHeadsign
      : phaseMap.get(phaseId) ?? phases?.[0]?.copy ?? oncomingHeadsign;
    drawDisplay(context, routeNumber, copy);
    texture.needsUpdate = true;
  };

  render();
  return {
    texture,
    setPhase(nextPhaseId) {
      if (direction === "oncoming" || !nextPhaseId || nextPhaseId === phaseId) return;
      phaseId = nextPhaseId;
      render();
    },
  };
}
