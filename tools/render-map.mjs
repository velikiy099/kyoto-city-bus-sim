#!/usr/bin/env node
/**
 * route18.json から上面図 SVG を生成する検証ツール(ゲームを走らせずに地図を確認する)。
 * 描画は route18.json に埋め込まれた情報のみを使う(道路幅・交差点・信号設置座標・線路)。
 *
 * 使い方:
 *   node tools/render-map.mjs                     # 全区間 → tools/map.svg
 *   node tools/render-map.mjs --from 200 --to 600 # s 区間を切り出し(交差点のズーム確認)
 *   node tools/render-map.mjs --check             # 整合性チェック(信号柱が路面上にない等)
 *   node tools/render-map.mjs --out foo.svg
 *
 * 座標系: ワールド x → SVG x, ワールド z → SVG y(北=-z が上)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(
  readFileSync(join(ROOT, "src", "data", "route18.json"), "utf8"),
);

// ---- 引数 ----
const args = process.argv.slice(2);
const argVal = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const S_FROM = Number(argVal("--from", 0));
const S_TO = Number(argVal("--to", Infinity));
const OUT = argVal("--out", join(ROOT, "tools", "map.svg"));
const CHECK = args.includes("--check");

// ---- 経路ヘルパー(route18.json の path のみから構築) ----
const path = data.path;
const cumLen = [0];
for (let i = 1; i < path.length; i++) {
  cumLen.push(
    cumLen[i - 1] +
      Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]),
  );
}
const totalLength = cumLen.at(-1);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function pointAt(s) {
  const ss = clamp(s, 0, totalLength);
  let lo = 0,
    hi = cumLen.length - 1;
  while (lo < hi - 1) {
    const m = (lo + hi) >> 1;
    cumLen[m] <= ss ? (lo = m) : (hi = m);
  }
  const a = path[lo],
    b = path[Math.min(path.length - 1, lo + 1)];
  const len = cumLen[lo + 1] - cumLen[lo] || 1e-9;
  const t = (ss - cumLen[lo]) / len;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
function headingAt(s) {
  const a = pointAt(s - 1.5),
    b = pointAt(s + 1.5);
  return Math.atan2(b[0] - a[0], b[1] - a[1]);
}
/** 点→経路の最近傍 {s, dist} */
function projectPoint(pt) {
  let bd = Infinity,
    bs = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i],
      b = path[i + 1];
    const abx = b[0] - a[0],
      abz = b[1] - a[1];
    const ab2 = abx * abx + abz * abz || 1e-9;
    const t = clamp(((pt[0] - a[0]) * abx + (pt[1] - a[1]) * abz) / ab2, 0, 1);
    const dx = pt[0] - (a[0] + abx * t),
      dz = pt[1] - (a[1] + abz * t);
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) {
      bd = d2;
      bs = cumLen[i] + Math.sqrt(ab2) * t;
    }
  }
  return { s: bs, dist: Math.sqrt(bd) };
}

// roadSections から左右幅(routeData.sectionAt と同式。旧形式にもフォールバック)
const secAt = (s) => {
  for (const sec of data.roadSections ?? []) {
    if (s >= sec.from && s < sec.to) {
      const hw = Math.max(4.0, Math.max(2, sec.lanes || 2) * 1.6 + 0.8);
      return {
        wL: sec.wL ?? hw,
        wR: sec.wR ?? hw,
        center: sec.center ?? "line",
        lanesB: sec.lanesB ?? 1,
      };
    }
  }
  return { wL: 4.0, wR: 4.0, center: "line", lanesB: 1 };
};
const hwAt = (s) => Math.max(secAt(s).wL, secAt(s).wR);
/** 点の経路に対する符号付き横位置(右=正)とその側の路面幅 */
function sideWidthAt(pt) {
  const proj = projectPoint(pt);
  const [qx, qz] = pointAt(proj.s);
  const h = headingAt(proj.s);
  const lat = (pt[0] - qx) * -Math.cos(h) + (pt[1] - qz) * Math.sin(h);
  const sec = secAt(proj.s);
  return { s: proj.s, dist: proj.dist, need: lat < 0 ? sec.wL : sec.wR };
}

const STUB_LEN = 42; // road.js の addTurnIntersections と同値

/** 右左折交差点の腕(貫通道路の矩形)一覧 [{cx, cz, heading, from, to, hw}] */
function turnArms(t) {
  const stubInLen = t.stubInLen ?? STUB_LEN;
  const inArms = [];
  if (t.stubInHeadingDeg != null) {
    inArms.push({
      heading: t.headingIn,
      hw: t.hwIn,
      from: -(t.d + 2),
      to: t.hwOut,
    });
    inArms.push({
      heading: (t.stubInHeadingDeg * Math.PI) / 180,
      hw: t.stubInHw ?? t.hwIn,
      from: 0,
      to: stubInLen,
    });
  } else {
    inArms.push({
      heading: t.headingIn,
      hw: t.hwIn,
      from: -(t.d + 2),
      to: stubInLen,
    });
  }
  return [
    ...inArms,
    {
      heading: t.headingOut,
      hw: t.hwOut,
      from: -(t.stubBackLen ?? STUB_LEN),
      to: t.d + 2,
    },
  ].map((a) => ({ ...a, cx: t.x, cz: t.z }));
}
/** 点が腕矩形の内側か(margin>0 で緩め、<0 で厳しめ) */
function inArm(pt, arm, margin = 0) {
  const dx = pt[0] - arm.cx,
    dz = pt[1] - arm.cz;
  const dir = [Math.sin(arm.heading), Math.cos(arm.heading)];
  const along = dx * dir[0] + dz * dir[1];
  const lat = dx * dir[1] - dz * dir[0];
  return (
    along > arm.from - margin &&
    along < arm.to + margin &&
    Math.abs(lat) < arm.hw + margin
  );
}

// ================================================================ チェック
if (CHECK) {
  let fail = 0,
    warn = 0;
  const report = (level, msg) => {
    if (level === "FAIL") fail++;
    else warn++;
    console.log(`${level}  ${msg}`);
  };

  // 1) 信号柱が路面(ルート帯・右左折交差点の腕・通常交差点スタブ)の上に立っていないか
  const arms = (data.turnIntersections ?? []).flatMap(turnArms);
  for (const sig of data.signals ?? []) {
    if (!sig.heads?.length) {
      report("WARN", `信号 s=${sig.s} に heads がない`);
      continue;
    }
    for (const h of sig.heads) {
      const p = h.pole;
      const proj = sideWidthAt(p);
      if (proj.dist < proj.need - 0.3) {
        report(
          "FAIL",
          `信号柱が本線路面上: s=${sig.s} ${h.kind} pole=(${p[0]}, ${p[1]}) 路面中心まで${proj.dist.toFixed(1)}m < 幅${proj.need}`,
        );
      }
      for (const arm of arms) {
        if (inArm(p, arm, -0.3)) {
          report(
            "FAIL",
            `信号柱が右左折交差点の路面上: s=${sig.s} ${h.kind} pole=(${p[0]}, ${p[1]})`,
          );
        }
      }
      for (const ix of data.intersections ?? []) {
        const c = pointAt(ix.s);
        const dir = [Math.sin(ix.heading), Math.cos(ix.heading)];
        const dx = p[0] - c[0],
          dz = p[1] - c[1];
        const along = dx * dir[0] + dz * dir[1];
        const lat = dx * dir[1] - dz * dir[0];
        if (
          Math.abs(along) < ix.length / 2 - 0.3 &&
          Math.abs(lat) < ix.width / 2 - 0.3
        ) {
          report(
            "WARN",
            `信号柱が交差道路スタブ上: s=${sig.s} ${h.kind} pole=(${p[0]}, ${p[1]}) ${ix.name || ""}`,
          );
        }
      }
    }
  }

  // 2) 線路がルートとほぼ直交しているか
  for (const r of data.railStructures ?? []) {
    const routeH = headingAt(r.s);
    let a = Math.abs((((r.heading - routeH) % Math.PI) + Math.PI) % Math.PI); // 0..π
    const deg =
      ((Math.min(a, Math.PI - a) === a ? a : Math.PI - a) * 180) / Math.PI;
    const cross = 90 - Math.abs(90 - (a * 180) / Math.PI); // 交差角(0..90)
    if (cross < 70)
      report(
        "FAIL",
        `線路の交差角が浅い: ${r.name} s=${r.s} 交差角${cross.toFixed(1)}°`,
      );
    else
      console.log(`PASS  線路交差角 ${r.name} s=${r.s}: ${cross.toFixed(1)}°`);
  }

  // 3) 右左折交差点と停留所の重なり(円弧上に停止線があると正着が難しい)
  for (const t of data.turnIntersections ?? []) {
    for (const st of data.stops ?? []) {
      if (st.s > t.sIn - 5 && st.s < t.sOut + 5) {
        report(
          "WARN",
          `停留所「${st.name}」(s=${st.s}) が右左折交差点の円弧内 [${t.sIn}, ${t.sOut}]`,
        );
      }
    }
    if (!t.crossName)
      report(
        "WARN",
        `右左折交差点 s=${t.s} (${t.angleDeg}°) に交差道路名がない`,
      );
  }

  console.log(`\n=== チェック完了: FAIL ${fail} / WARN ${warn} ===`);
  process.exit(fail ? 1 : 0);
}

// ================================================================ SVG 生成
const inRange = (s) => s >= S_FROM - 60 && s <= S_TO + 60;
let minX = Infinity,
  maxX = -Infinity,
  minZ = Infinity,
  maxZ = -Infinity;
for (let i = 0; i < path.length; i++) {
  if (!inRange(cumLen[i])) continue;
  minX = Math.min(minX, path[i][0]);
  maxX = Math.max(maxX, path[i][0]);
  minZ = Math.min(minZ, path[i][1]);
  maxZ = Math.max(maxZ, path[i][1]);
}
const M = 90; // 余白 [m]
const vb = [minX - M, minZ - M, maxX - minX + M * 2, maxZ - minZ + M * 2];

const el = [];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const poly = (pts, fill, opacity = 1) =>
  el.push(
    `<polygon points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="${fill}" fill-opacity="${opacity}"/>`,
  );
const line = (a, b, stroke, w, opts = "") =>
  el.push(
    `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${stroke}" stroke-width="${w}" ${opts}/>`,
  );
const circle = (p, r, fill) =>
  el.push(
    `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${r}" fill="${fill}"/>`,
  );
const text = (p, str, size, fill = "#333", anchor = "start") =>
  el.push(
    `<text x="${p[0].toFixed(1)}" y="${p[1].toFixed(1)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-family="sans-serif">${esc(str)}</text>`,
  );
/** 中心・方位・矩形(along from..to, 幅 2*hw)→ 頂点4つ */
function rectPts(cx, cz, heading, from, to, hw) {
  const d = [Math.sin(heading), Math.cos(heading)];
  const n = [d[1], -d[0]];
  return [
    [cx + d[0] * from + n[0] * hw, cz + d[1] * from + n[1] * hw],
    [cx + d[0] * to + n[0] * hw, cz + d[1] * to + n[1] * hw],
    [cx + d[0] * to - n[0] * hw, cz + d[1] * to - n[1] * hw],
    [cx + d[0] * from - n[0] * hw, cz + d[1] * from - n[1] * hw],
  ];
}

// ---- 川(OSM waterway の実ポリラインをそのまま帯状に描く) ----
function ribbonPts(points, halfWidth) {
  const left = [],
    right = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b[0] - a[0],
      dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1e-9;
    const nx = -dz / len,
      nz = dx / len;
    left.push([points[i][0] + nx * halfWidth, points[i][1] + nz * halfWidth]);
    right.push([points[i][0] - nx * halfWidth, points[i][1] - nz * halfWidth]);
  }
  return [...left, ...right.reverse()];
}
for (const r of data.rivers ?? []) {
  const br = (data.bridges ?? []).find((b) => b.name === r.bridgeName);
  if (br && !inRange(br.s)) continue;
  if (!r.points?.length) continue;
  const halfWidth = Math.max(6, (br?.length ?? 30) / 2);
  poly(ribbonPts(r.points, halfWidth), "#4fa8d8", 0.55);
  el.push(
    `<polyline points="${r.points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="#2f6f9e" stroke-width="0.6"/>`,
  );
  const mid = r.points[Math.floor(r.points.length / 2)];
  text([mid[0] + 6, mid[1]], `${r.river}(実測OSM)`, 8, "#2f6f9e");

  // 比較用: ゲーム内(nature.js)が仮定している「経路に直交」の川帯を破線で重ねる。
  // 実測ポリラインとの向きのズレが一目で分かる。
  if (br) {
    const c = pointAt(br.s);
    const roadHeading = headingAt(br.s);
    const assumedPts = rectPts(
      c[0],
      c[1],
      roadHeading + Math.PI / 2,
      -110,
      110,
      halfWidth,
    );
    el.push(
      `<polygon points="${assumedPts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="#c0392b" stroke-width="0.7" stroke-dasharray="4,3"/>`,
    );
    const skewDeg = (() => {
      const riverH = r.headingDeg;
      let diff = Math.abs(((roadHeading * 180) / Math.PI - riverH) % 180);
      if (diff > 90) diff = 180 - diff;
      return Math.abs(90 - diff);
    })();
    text(
      [c[0] + 6, c[1] + 12],
      `想定(直交)とのズレ ${skewDeg.toFixed(0)}°`,
      7.5,
      "#c0392b",
    );
  }
}

// ---- 建物 ----
for (const b of data.buildings ?? []) {
  if (b.s != null && !inRange(b.s)) continue;
  if (b.footprint?.length > 2) poly(b.footprint, "#e2ded4");
}

// ---- 梅小路公園の樹木 ----
if (data.umekojiTrees) {
  for (const forest of data.umekojiTrees.forests || []) {
    if (forest.length > 2) poly(forest, "#4e7a3d", 0.35);
  }
  for (const treeRow of data.umekojiTrees.treeRows || []) {
    if (treeRow.length > 1) {
      el.push(
        `<polyline points="${treeRow.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="#4e7a3d" stroke-width="4" opacity="0.35"/>`,
      );
    }
  }
  for (const tree of data.umekojiTrees.trees || []) {
    circle(tree, 2, "#4e7a3d");
  }
}

// ---- 通常交差点スタブ ----
for (const ix of data.intersections ?? []) {
  if (!inRange(ix.s)) continue;
  const c = pointAt(ix.s);
  poly(
    rectPts(
      c[0],
      c[1],
      ix.heading,
      -ix.length / 2,
      ix.length / 2,
      ix.width / 2,
    ),
    "#565b61",
  );
}

// ---- 右左折交差点の腕 ----
for (const t of data.turnIntersections ?? []) {
  if (!inRange(t.s)) continue;
  for (const arm of turnArms(t))
    poly(
      rectPts(arm.cx, arm.cz, arm.heading, arm.from, arm.to, arm.hw),
      "#4a4f55",
    );
}

// ---- 本線路面(区間ごとに左右非対称の帯ポリゴンで描く) ----
function offsetPt(s, lat) {
  const [px, pz] = pointAt(s);
  const h = headingAt(s);
  return [px + -Math.cos(h) * lat, pz + Math.sin(h) * lat];
}
for (const sec of data.roadSections ?? [
  { from: 0, to: totalLength, lanes: 2 },
]) {
  const from = Math.max(sec.from, S_FROM - 60),
    to = Math.min(sec.to, S_TO === Infinity ? totalLength : S_TO + 60);
  if (to <= from) continue;
  const { wL, wR } = secAt((from + to) / 2);
  const left = [],
    right = [];
  // セクション終端まで必ず描く(端数で終端が落ちると境界に切れ目が出る)
  for (let s = from; ; s += 4) {
    const ss = Math.min(s, to);
    left.push(offsetPt(ss, -wL));
    right.push(offsetPt(ss, wR));
    if (ss >= to) break;
  }
  poly([...left, ...right.reverse()], "#4a4f55");
}
// センターライン(センターラインなし・一方通行区間は破線色を変えて示す)
for (const sec of data.roadSections ?? [
  { from: 0, to: totalLength, lanes: 2 },
]) {
  const from = Math.max(sec.from, S_FROM - 60),
    to = Math.min(sec.to, S_TO === Infinity ? totalLength : S_TO + 60);
  if (to <= from) continue;
  const spec = secAt((from + to) / 2);
  const pts = [];
  for (let s = from; s < to; s += 4) pts.push(pointAt(s));
  pts.push(pointAt(to));
  const hasCenter = spec.lanesB > 0 && spec.center !== "none";
  el.push(
    `<polyline points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="${hasCenter ? "#d8a017" : "#8a8f94"}" stroke-width="0.4" ${hasCenter ? "" : 'stroke-dasharray="3,3"'}/>`,
  );
}

// ---- 線路 ----
for (const r of data.railStructures ?? []) {
  if (!inRange(r.s)) continue;
  const c = pointAt(r.s);
  const u = [Math.sin(r.heading), Math.cos(r.heading)]; // 線路軸
  const v = [Math.cos(r.heading), -Math.sin(r.heading)]; // 軌道並び方向
  const color = r.kind === "shinkansen-viaduct" ? "#3a6ea5" : "#7a5c3a";
  const spacing = r.kind === "shinkansen-viaduct" ? 5.4 : 3.2;
  const n = r.trackCount ?? 2;
  poly(
    rectPts(
      c[0],
      c[1],
      r.heading,
      -r.length / 2,
      r.length / 2,
      (r.width ?? 20) / 2,
    ),
    color,
    0.15,
  );
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * spacing;
    const a = [
      c[0] + v[0] * off - (u[0] * r.length) / 2,
      c[1] + v[1] * off - (u[1] * r.length) / 2,
    ];
    const b = [
      c[0] + v[0] * off + (u[0] * r.length) / 2,
      c[1] + v[1] * off + (u[1] * r.length) / 2,
    ];
    line(a, b, color, 0.8);
  }
  text([c[0] + 12, c[1] - r.width / 2 - 4], `${r.name} (${r.kind})`, 8, color);
}

// ---- 信号(柱=紺点, 灯器=kind色, 向きチック=接近車の方向へ) ----
for (const sig of data.signals ?? []) {
  if (!inRange(sig.s)) continue;
  for (const h of sig.heads ?? []) {
    const color = h.kind === "cross" ? "#d97706" : "#1a7f37";
    circle(h.pole, 1.0, "#1e2a5a");
    line(h.pole, h.head, color, 0.5);
    circle(h.head, 0.7, color);
    // face 方向に進む車から見える → 接近車側(face の逆方向)へチック
    const back = [
      h.head[0] - Math.sin(h.face) * 4,
      h.head[1] - Math.cos(h.face) * 4,
    ];
    line(h.head, back, color, 0.3, 'stroke-dasharray="1,1"');
  }
}

// ---- 右左折交差点の注記 ----
for (const t of data.turnIntersections ?? []) {
  if (!inRange(t.s)) continue;
  circle([t.x, t.z], 1.6, "#c0392b");
  text(
    [t.x + 4, t.z - 4],
    `${t.crossName || "(無名)"} ${t.angleDeg}° s=${t.s}`,
    8,
    "#c0392b",
  );
}

// ---- 停留所 ----
for (const st of data.stops ?? []) {
  if (!inRange(st.s)) continue;
  const p = pointAt(st.s);
  circle(p, 2.2, "#b03030");
  circle(p, 1.2, "#ffffff");
  text([p[0] + 5, p[1] + 3], `${st.name} (s=${st.s})`, 9, "#802020");
}

// ---- s 目盛(200m ごと) ----
for (let s = 0; s <= totalLength; s += 200) {
  if (!inRange(s)) continue;
  const p = pointAt(s);
  circle(p, 0.8, "#888");
  if (s % 1000 === 0) text([p[0] - 6, p[1] - 3], `s=${s}`, 7, "#888", "end");
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map((v) => v.toFixed(0)).join(" ")}">
<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="#f2f4ee"/>
${el.join("\n")}
</svg>`;
writeFileSync(OUT, svg);
console.log(
  `OK → ${OUT}  (viewBox: ${vb.map((v) => v.toFixed(0)).join(" ")}, 要素数 ${el.length})`,
);
