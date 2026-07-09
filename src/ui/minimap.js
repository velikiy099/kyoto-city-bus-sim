/** ミニマップ(canvas 2D・縦長路線図) */
export function createMinimap(path, stops) {
  const W = 150,
    H = 430,
    M = 14;
  const canvas = document.createElement("canvas");
  canvas.id = "minimap";
  canvas.width = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  document.getElementById("hud").appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);

  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const [x, z] of path.points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const k = Math.min((W - M * 2) / (maxX - minX), (H - M * 2) / (maxZ - minZ));
  const ox = (W - (maxX - minX) * k) / 2;
  const oy = (H - (maxZ - minZ) * k) / 2;
  const toXY = ([x, z]) => [ox + (x - minX) * k, oy + (z - minZ) * k];

  const routePts = [];
  for (let i = 0; i < path.points.length; i += 8)
    routePts.push(toXY(path.points[i]));
  routePts.push(toXY(path.points[path.points.length - 1]));
  const stopPts = stops.map((st) => toXY(path.getPoint(st.s)));

  let blink = 0;
  return {
    update(pos, nextStopIndex, dt = 0.1) {
      blink += dt;
      ctx.clearRect(0, 0, W, H);
      // 経路
      ctx.beginPath();
      routePts.forEach(([x, y], i) =>
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y),
      );
      ctx.strokeStyle = "#5f7f6f";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      // 停留所
      stopPts.forEach(([x, y], i) => {
        ctx.beginPath();
        ctx.arc(x, y, i === nextStopIndex ? 3.6 : 2.2, 0, Math.PI * 2);
        if (i < nextStopIndex) ctx.fillStyle = "#3fae70";
        else if (i === nextStopIndex)
          ctx.fillStyle = blink % 0.9 < 0.55 ? "#ffb43c" : "#8a6a30";
        else ctx.fillStyle = "#c9d4de";
        ctx.fill();
      });
      // 自車
      const [bx, by] = toXY(pos);
      ctx.beginPath();
      ctx.arc(bx, by, 4.4, 0, Math.PI * 2);
      ctx.fillStyle = "#ff5544";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.4;
      ctx.stroke();
      // 端点ラベル
      ctx.fillStyle = "#dce6ee";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      const [tx, ty] = stopPts[0];
      ctx.fillText("二条駅西口", tx, ty - 7);
      const [gx, gy] = stopPts[stopPts.length - 1];
      ctx.fillText("久我石原町", gx, gy + 14);
    },
  };
}
