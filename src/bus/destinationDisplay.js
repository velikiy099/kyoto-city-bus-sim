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

const DISPLAY_COPY = {
  selfBeforeKujo: {
    via: "大宮通",
    japanese: "東寺・久我石原町",
    english: "Koga Ishiharacho",
  },
  selfAfterKujo: {
    via: null,
    japanese: "久我石原町",
    english: "Koga Ishiharacho",
  },
  oncoming: {
    via: "大宮通",
    japanese: "四条大宮・二条駅",
    english: "Nijo Sta. Via Shijo Omiya",
  },
};

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

function drawDisplay(ctx, copy) {
  ctx.clearRect(0, 0, SIGN_WIDTH, SIGN_HEIGHT);
  ctx.fillStyle = "#0d1116";
  ctx.fillRect(0, 0, SIGN_WIDTH, SIGN_HEIGHT);

  // Route number panel retained from the existing Kyoto city bus-style sign.
  ctx.fillStyle = NUMBER_BOX_COLOR;
  ctx.fillRect(NUMBER_BOX_X, 0, SIGN_WIDTH - NUMBER_BOX_X, SIGN_HEIGHT);
  const numberPanelWidth = SIGN_WIDTH - NUMBER_BOX_X;
  ctx.font = fittedFont(ctx, "18", 128, numberPanelWidth - 8);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const numberX = NUMBER_BOX_X + numberPanelWidth / 2;
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.save();
  ctx.translate(numberX, 66);
  ctx.scale(1, NUMBER_VERTICAL_SCALE);
  ctx.strokeText("18", 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillText("18", 0, 0);
  ctx.restore();

  // The compact terminal display has no left frame and uses a white divider.
  const compact = !copy.via;
  ctx.fillStyle = compact ? "#ffffff" : "#d79cff";
  if (!compact) ctx.fillRect(8, 8, 7, SIGN_HEIGHT - 16);
  ctx.fillRect(compact ? 0 : 13, DIVIDER_Y, TEXT_RIGHT - (compact ? 0 : 13), 3);

  const left = 30;
  drawLeftAligned(ctx, copy.via, left, 24, 25, TEXT_RIGHT - left - 10, "#fff4cf");
  if (copy.via) {
    // The destination line is indented by roughly one half-width character.
    drawLeftAligned(ctx, copy.japanese, left + 22, 55, JAPANESE_MAX_SIZE, TEXT_RIGHT - left - 32);
  } else {
    drawJustified(ctx, copy.japanese, 48, JAPANESE_MAX_SIZE, 14, TEXT_RIGHT - 2);
  }
  drawCentered(ctx, copy.english, 108, ENGLISH_MAX_SIZE, TEXT_RIGHT - 28);
}

/**
 * Create a destination display texture shared by all faces of one bus.
 * `setPhase("afterKujo")` is used by the player's bus after 九条大宮.
 */
export function createDestinationDisplay(direction = "self") {
  const canvas = document.createElement("canvas");
  canvas.width = SIGN_WIDTH;
  canvas.height = SIGN_HEIGHT;
  const context = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  let phase = direction === "oncoming" ? "oncoming" : "beforeKujo";
  const render = () => {
    const copy = direction === "oncoming"
      ? DISPLAY_COPY.oncoming
      : phase === "afterKujo"
        ? DISPLAY_COPY.selfAfterKujo
        : DISPLAY_COPY.selfBeforeKujo;
    drawDisplay(context, copy);
    texture.needsUpdate = true;
  };

  render();
  return {
    texture,
    setPhase(nextPhase) {
      if (direction === "oncoming" || nextPhase === phase) return;
      phase = nextPhase;
      render();
    },
  };
}
