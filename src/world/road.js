import * as THREE from "three";
import { CFG } from "../config.js";
import { elevationAt, terrainElevationAt, halfWidthAt } from "../route/routeData.js";
import { buildRiverDips, clippedRiverPoints, riverDipDepthAt } from "./riverGeometry.js";

/**
 * 経路に沿った帯(リボン)ジオメトリを生成
 * latFrom/latTo: 横偏差(左が負) / sStep: サンプリング間隔
 */
export function makeRibbon(
  path,
  latFrom,
  latTo,
  y,
  sFrom = 0,
  sTo = null,
  sStep = 4,
  withElevation = true,
) {
  sTo = sTo ?? path.length;
  const positions = [];
  const indices = [];
  let row = 0;
  // セクション終端まで必ず描く(端数で終端が落ちると境界に切れ目が出る)
  for (let s = sFrom; ; s += sStep) {
    const ss = Math.min(s, sTo);
    const [px, pz] = path.getPoint(ss);
    const [tx, tz] = path.getTangent(ss);
    // 左法線 = (tz, -tx) が lateral 負方向(path.closestS の符号系と整合)
    const nx = -tz,
      nz = tx; // lateral 正(右)方向
    const ye = y + (withElevation ? elevationAt(ss) : terrainElevationAt(ss)); // 本線は構造標高、側道はPLATEAU地表標高
    positions.push(px + nx * latFrom, ye, pz + nz * latFrom);
    positions.push(px + nx * latTo, ye, pz + nz * latTo);
    if (row > 0) {
      const b = row * 2;
      indices.push(b - 2, b - 1, b, b - 1, b + 1, b);
    }
    row++;
    if (ss >= sTo) break;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function roadSectionsFor(path, route) {
  if (route?.roadSections?.length) return route.roadSections;
  return [{ from: 0, to: path.length, lanes: 2 }];
}

function roadHalfWidth(lanes = 2) {
  return Math.max(CFG.road.halfWidth, lanes * 1.6 + 0.8);
}

/** 区間の左右幅・車線数(旧形式 lanes のみのデータにもフォールバック) */
function sectionSpec(section) {
  const lanes = Math.max(1, Number(section.lanes) || 2);
  const lanesF = section.lanesF ?? Math.max(1, Math.floor(lanes / 2));
  const lanesB = section.lanesB ?? Math.max(1, lanes - lanesF);
  return {
    lanesF,
    lanesB,
    wL: section.wL ?? roadHalfWidth(lanes),
    wR: section.wR ?? roadHalfWidth(lanes),
    center: section.center ?? "line",
    sidewalk: section.sidewalk ?? "line",
  };
}

function addLine(g, path, lat, y, color, sFrom, sTo, width = 0.06) {
  const mat = new THREE.MeshLambertMaterial({ color });
  g.add(
    new THREE.Mesh(
      makeRibbon(path, lat - width, lat + width, y, sFrom, sTo, 3),
      mat,
    ),
  );
}

/** [from,to] から gaps([[g0,g1],…])を抜いた小区間のリストを返す */
function splitRanges(from, to, gaps) {
  let ranges = [[from, to]];
  for (const [g0, g1] of gaps) {
    const next = [];
    for (const [a, b] of ranges) {
      if (g1 <= a || g0 >= b) {
        next.push([a, b]);
        continue;
      }
      if (g0 > a) next.push([a, g0]);
      if (g1 < b) next.push([g1, b]);
    }
    ranges = next;
  }
  return ranges.filter(([a, b]) => b - a > 0.5);
}

/** 交差点の1腕分の区画線(センターライン・車線境界)をワールド座標で直接描く */
function addArmLaneMarkings(
  g,
  px,
  pz,
  heading,
  side,
  armLen,
  hw,
  lanesF,
  lanesB,
  elev,
) {
  if (lanesF + lanesB < 2) return;
  const dx = Math.sin(heading) * side,
    dz = Math.cos(heading) * side; // 腕の外向き方向
  const nx = Math.cos(heading),
    nz = -Math.sin(heading); // 横方向(+heading基準で一定)
  const lineMat = (color) => new THREE.MeshBasicMaterial({ color });
  const drawLine = (lat, color, width, y) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(width, armLen),
      lineMat(color),
    );
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = -heading;
    m.position.set(
      px + dx * (armLen / 2) + nx * lat,
      y + elev,
      pz + dz * (armLen / 2) + nz * lat,
    );
    g.add(m);
  };
  const usable = hw * 2 - 1.1;
  // lat の基準: nx/nz は heading 方向を"+"とした横方向。lanesF(+heading方向の車線)を
  // 負側、lanesB(heading+PI方向の車線)を正側に割り当て、中心にセンターラインを引く
  const wF = usable * (lanesF / (lanesF + lanesB));
  if (lanesB > 0) drawLine(0, 0xd8a017, 0.16, 0.028); // センターライン(黄)
  for (let i = 1; i < lanesF; i++)
    drawLine(-((wF * i) / lanesF), CFG.colors.roadLine, 0.09, 0.026);
  const wB = usable - wF;
  for (let i = 1; i < lanesB; i++)
    drawLine((wB * i) / lanesB, CFG.colors.roadLine, 0.09, 0.026);
}

function addIntersections(
  g,
  path,
  intersections,
  turns = [],
  routeHwAt = null,
) {
  const roadMat = new THREE.MeshLambertMaterial({ color: CFG.colors.road });
  const pedMat = new THREE.MeshLambertMaterial({ color: 0xb9a488 }); // 商店街等の歩行者専用舗装
  const lineMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.52,
  });
  const medianMat = new THREE.MeshLambertMaterial({ color: 0x7d9668 }); // 植栽帯
  for (const ix of intersections ?? []) {
    // 右左折交差点の近傍は addTurnIntersections が本物の交差を描くのでスキップ。
    // 地蔵前手前のように、同じ分岐を構成するOSM wayの接続点が曲がり角の
    // 前後に別々に検出される場合、短い範囲では交差道路スタブが二重に残る。
    // addTurnIntersections の既定スタブ長(42m)まで含めて抑制し、分岐を1つにする。
    if (turns.some((t) => ix.s > t.sIn - 42 && ix.s < t.sOut + 42)) continue;
    const s = Math.max(0, Math.min(path.length - 0.1, ix.s));
    const [px, pz] = path.getPoint(s);
    const width = Math.max(5.5, ix.width ?? 7);
    const elev = ix.under ? terrainElevationAt(s) : elevationAt(s); // 高架下の交差道路(八条通)は地上のまま

    if (ix.arms?.length) {
      // 腕ごとに独立した舗装(実在しない側は描かない、腕ごとに幅・車線・歩行者専用を反映)
      for (const arm of ix.arms) {
        if (!arm.exists || arm.length <= 0) continue;
        const armW = arm.width ?? width;
        const off = (arm.side * arm.length) / 2;
        const mat = arm.pedestrian ? pedMat : roadMat;
        // PlaneGeometry の第1引数は rotation.x(-90°)+rotation.z(-heading) の合成後、
        // heading の「垂直」方向に対応する(第2引数が heading 方向)。ここでは
        // 腕の長さ(arm.length)を heading 方向へ伸ばしたいので第2引数に入れる。
        const stub = new THREE.Mesh(
          new THREE.PlaneGeometry(armW, arm.length),
          mat,
        );
        stub.rotation.x = -Math.PI / 2;
        stub.rotation.z = -(ix.heading ?? 0);
        stub.position.set(
          px + Math.sin(ix.heading) * off,
          0.006 + elev,
          pz + Math.cos(ix.heading) * off,
        );
        g.add(stub);
        if (!arm.pedestrian) {
          addArmLaneMarkings(
            g,
            px,
            pz,
            ix.heading,
            arm.side,
            arm.length,
            armW / 2,
            arm.lanesF ?? 1,
            arm.lanesB ?? 1,
            elev,
          );
        }
      }
    } else {
      // 旧形式データへのフォールバック(現行データは常に arms を持つため通常は通らない)
      const length = Math.max(28, ix.length ?? 54);
      const stub = new THREE.Mesh(
        new THREE.PlaneGeometry(width, length),
        roadMat,
      );
      stub.rotation.x = -Math.PI / 2;
      stub.rotation.z = -(ix.heading ?? 0);
      stub.position.set(px, 0.006 + elev, pz);
      g.add(stub);
    }
    const length = ix.arms?.length
      ? Math.max(...ix.arms.map((a) => (a.exists ? a.length : 0)), 28) * 2
      : Math.max(28, ix.length ?? 54);

    // 中央分離帯(五条通など): 交差道路の中心線に沿って、本線路面の外側から両端まで
    if (ix.median) {
      const hwRoute = (routeHwAt ? routeHwAt(s) : halfWidthAt(s)) + 6;
      const segLen = length / 2 - hwRoute;
      if (segLen > 6) {
        for (const side of [-1, 1]) {
          const strip = new THREE.Mesh(
            new THREE.BoxGeometry(1.6, 0.32, segLen),
            medianMat,
          );
          const d = side * (hwRoute + segLen / 2);
          strip.position.set(
            px + Math.sin(ix.heading) * d,
            0.16 + elev,
            pz + Math.cos(ix.heading) * d,
          );
          strip.rotation.y = ix.heading;
          g.add(strip);
        }
      }
    }

    const [tx, tz] = path.getTangent(s);
    const cw = new THREE.Mesh(
      new THREE.PlaneGeometry(
        Math.max(9, roadHalfWidth(ix.lanes ?? 2) * 2),
        2.8,
      ),
      lineMat,
    );
    cw.rotation.x = -Math.PI / 2;
    cw.rotation.z = -Math.atan2(tx, tz);
    cw.position.set(px, 0.034 + elev, pz);
    g.add(cw);
  }
}

/**
 * 右左折交差点: 経路が折れる地点を「道路同士の交差」として描く。
 * 離脱する道路(headingIn)は交差点の先へ直進し、曲がった先の道路(headingOut)は
 * 交差点の向こう(後方)へも続く。交差点ボックス内は無地舗装、各脚に横断歩道。
 */
function addTurnIntersections(g, path, turns) {
  const C = CFG.colors;
  const roadMat = new THREE.MeshLambertMaterial({ color: C.road });
  const lineMat = (color) => new THREE.MeshBasicMaterial({ color });
  const cwMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.52,
  });
  const STUB_LEN = 42;

  const flat = (grp, w, l, y, z, material) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), material);
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, y, z);
    grp.add(m);
    return m;
  };

  for (const t of turns ?? []) {
    const elev = elevationAt(t.s);
    const hwIn = t.hwIn ?? halfWidthAt(Math.max(0, t.sIn - 1));
    const hwOut = t.hwOut ?? halfWidthAt(t.sOut + 1);
    const dIn =
      t.d ??
      Math.hypot(
        t.x - path.getPoint(Math.max(0, t.sIn))[0],
        t.z - path.getPoint(Math.max(0, t.sIn))[1],
      );
    const dOut = dIn; // フィレットの接点距離は進入側・退出側で同一

    // 各「腕」= 交差点を貫く1本の道路。zSpan: 舗装矩形の範囲(ローカルz、+z=heading方向)
    // gap: 交差点ボックス縁(頂点からの距離)。ここから外側にのみ区画線・縁石・歩道を引く
    // stubInHw: 直進スタブ(交差点の先の道)の幅がルートと異なる場合(九条大宮の大宮通=片道1 等)
    const stubIn = t.stubInHw ?? hwIn;
    const splitIn = Math.abs(stubIn - hwIn) > 0.3 || t.stubInHeadingDeg != null;
    // 経路終端(=久我石原町終点のような行き止まり)近傍のターンは、その先に実在しない
    // 「直進する交差道路」のスタブを描かない(実際には交差点ではなく敷地への引き込み路のため)
    const isDeadEnd = path.length - t.sOut < STUB_LEN + 15;
    // stubInLen: 進入前の道路(headingIn)が交差点の先も実際にはもっと長く続く場合の
    // 描画長さ override(既定 STUB_LEN=42m)。例: 小枝橋東詰〜千本通の分岐は、進入路
    // (小枝橋側)がその先も約100m続く実景観に合わせる。
    const stubFwd = isDeadEnd
      ? Math.max(hwOut + 3, 6)
      : (t.stubInLen ?? STUB_LEN);
    const stubBack =
      t.stubBackLen ?? (isDeadEnd ? Math.max(hwIn + 3, 6) : STUB_LEN);
    const outBackMin = Math.min(-stubBack, -(hwIn + 3));
    const arms = [
      {
        heading: t.headingIn,
        hw: hwIn,
        zSpan: [-(dIn + 2), splitIn ? hwOut + 2.4 : stubFwd],
        furniture: splitIn ? [] : [[hwOut + 2, stubFwd - 1]],
        crosswalks: splitIn ? [-(hwOut + 3.6)] : [hwOut + 3.6, -(hwOut + 3.6)],
      },
      ...(splitIn
        ? [
            {
              heading:
                t.stubInHeadingDeg != null
                  ? (t.stubInHeadingDeg * Math.PI) / 180
                  : t.headingIn,
              hw: stubIn,
              zSpan:
                t.stubInHeadingDeg != null
                  ? [hwOut, stubFwd]
                  : [hwOut + 2.4, stubFwd],
              furniture: [[hwOut + 2.6, stubFwd - 1]],
              crosswalks: [hwOut + 3.6],
            },
          ]
        : []),
      {
        heading: t.headingOut,
        hw: hwOut,
        zSpan: [outBackMin, dOut + 2],
        furniture: stubBack < hwIn + 3 ? [] : [[-(stubBack - 1), -(hwIn + 2)]],
        crosswalks:
          stubBack < hwIn + 3.6 ? [hwIn + 3.6] : [hwIn + 3.6, -(hwIn + 3.6)],
      },
    ];

    for (const arm of arms) {
      const grp = new THREE.Group();
      grp.position.set(t.x, elev, t.z);
      grp.rotation.y = arm.heading;
      g.add(grp);

      // 舗装(路面 y=0 と区画線 y=0.02+ の間)
      const [z0, z1] = arm.zSpan;
      flat(grp, arm.hw * 2, z1 - z0, 0.005, (z0 + z1) / 2, roadMat);

      // 交差点ボックスの外側: センターライン・路側線・縁石・歩道(extraRoads と同パターン)
      for (const [f0, f1] of arm.furniture) {
        const len = f1 - f0;
        if (len < 2) continue;
        const mid = (f0 + f1) / 2;
        flat(grp, 0.16, len, 0.02, mid, lineMat(0xd8a017));
        for (const side of [-1, 1]) {
          const off = (w) => {
            const m = flat(grp, w.w, len, w.y, mid, w.m);
            m.position.x = side * w.x;
            return m;
          };
          off({ w: 0.14, x: arm.hw - 0.45, y: 0.02, m: lineMat(C.roadLine) });
          off({
            w: 0.5,
            x: arm.hw + 0.25,
            y: 0.13,
            m: new THREE.MeshLambertMaterial({ color: C.curb }),
          });
          off({
            w: 2.7,
            x: arm.hw + 1.85,
            y: 0.1,
            m: new THREE.MeshLambertMaterial({ color: 0xcfd2cc }),
          });
        }
      }

      // 横断歩道(ボックスの前後の縁)
      for (const cw of arm.crosswalks)
        flat(grp, arm.hw * 2, 2.8, 0.034, cw, cwMat);
    }

    // 四隅の歩道パッチ: 両道路の歩道帯(路端 +1.85m)が交わる点に正方形を置く
    const nA = [Math.cos(t.headingIn), -Math.sin(t.headingIn)]; // 道路Aの横方向単位ベクトル
    const nB = [Math.cos(t.headingOut), -Math.sin(t.headingOut)];
    const det = nA[0] * nB[1] - nA[1] * nB[0]; // = sin(headingIn - headingOut)
    if (Math.abs(det) > 0.3) {
      const walkMat = new THREE.MeshLambertMaterial({ color: 0xcfd2cc });
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const a = sa * (hwIn + 1.85),
            b = sb * (hwOut + 1.85);
          const px = (a * nB[1] - b * nA[1]) / det;
          const pz = (b * nA[0] - a * nB[0]) / det;
          const patch = new THREE.Mesh(
            new THREE.PlaneGeometry(3.8, 3.8),
            walkMat,
          );
          patch.rotation.x = -Math.PI / 2;
          patch.rotation.z = -t.headingIn;
          patch.position.set(t.x + px, elev + 0.1, t.z + pz);
          g.add(patch);
        }
      }
    }
  }
}

/** 道路一式(路面・センターライン・路側線・縁石・歩道)を返す */
export function buildRoad(path, route = null) {
  const g = new THREE.Group();
  const C = CFG.colors;
  const mat = (color) => new THREE.MeshLambertMaterial({ color });
  const sections = roadSectionsFor(path, route);
  const turns = route?.turnIntersections ?? [];
  // 右左折交差点の円弧区間では線・縁石・歩道を途切れさせる(路面は連続)
  const gaps = turns.map((t) => [t.sIn - 2, t.sOut + 2]);

  for (const section of sections) {
    const from = Math.max(0, section.from ?? 0);
    const to = Math.min(path.length, section.to ?? path.length);
    if (to <= from) continue;
    const { lanesF, lanesB, wL, wR, center, sidewalk } = sectionSpec(section);

    // 路面(交差点円弧の下も含め連続 — バスの走行面)
    g.add(
      new THREE.Mesh(makeRibbon(path, -wL, wR, 0.0, from, to), mat(C.road)),
    );

    for (const [f, tt] of splitRanges(from, to, gaps)) {
      // センターライン(黄色実線。一方通行・センターライン無し区間は引かない)
      if (lanesB > 0 && center !== "none") {
        g.add(
          new THREE.Mesh(
            makeRibbon(path, -0.08, 0.08, 0.024, f, tt, 3),
            mat(0xd8a017),
          ),
        );
      }

      // 車線境界(方向別に1車線を超える場合のみ白線)
      const usableLeft = wL - 0.55;
      const usableRight = wR - 0.55;
      for (let i = 1; i < lanesF; i++)
        addLine(
          g,
          path,
          -(usableLeft * i) / lanesF,
          0.026,
          C.roadLine,
          f,
          tt,
          0.035,
        );
      for (let i = 1; i < lanesB; i++)
        addLine(
          g,
          path,
          (usableRight * i) / lanesB,
          0.026,
          C.roadLine,
          f,
          tt,
          0.035,
        );

      // 路側線(白実線)
      g.add(
        new THREE.Mesh(
          makeRibbon(path, -wL + 0.35, -wL + 0.5, 0.025, f, tt, 3),
          mat(C.roadLine),
        ),
      );
      g.add(
        new THREE.Mesh(
          makeRibbon(path, wR - 0.5, wR - 0.35, 0.025, f, tt, 3),
          mat(C.roadLine),
        ),
      );

      // 縁石
      g.add(
        new THREE.Mesh(
          makeRibbon(path, -wL - 0.5, -wL, 0.13, f, tt),
          mat(C.curb),
        ),
      );
      g.add(
        new THREE.Mesh(
          makeRibbon(path, wR, wR + 0.5, 0.13, f, tt),
          mat(C.curb),
        ),
      );

      // 歩道(旧千本通など歩道が無い区間は sidewalk:'none' でスキップ)
      if (sidewalk !== "none") {
        g.add(
          new THREE.Mesh(
            makeRibbon(path, -wL - 3.2, -wL - 0.5, 0.1, f, tt),
            mat(0xcfd2cc),
          ),
        );
        g.add(
          new THREE.Mesh(
            makeRibbon(path, wR + 0.5, wR + 3.2, 0.1, f, tt),
            mat(0xcfd2cc),
          ),
        );
      }
    }
  }

  const routeHwAt = (s) => {
    const sec = sections.find(
      (x) => s >= (x.from ?? 0) && s < (x.to ?? path.length),
    );
    if (!sec) return CFG.road.halfWidth;
    const spec = sectionSpec(sec);
    return Math.max(spec.wL, spec.wR);
  };
  addIntersections(g, path, route?.intersections ?? [], turns, routeHwAt);
  addTurnIntersections(g, path, turns);

  return g;
}

/** 地面(経路バウンディングボックス+マージンの1枚板)。
 * route.bridges(+実測 rivers ポリライン)を渡すと、川(nature.js の水面・土手)沿いの
 * 地面をなだらかに沈めて掘り下げ、単一の平らな地面が水面・土手を覆い隠してしまうのを防ぐ。
 * 沈み込みは橋の直交断面だけでなく、実際の川筋(ポリライン)全体に沿って追従する
 * (経路とほぼ並走する川は、橋の直近だけ沈めても並走区間の水面が地面に埋もれて見えなくなるため)。 */
export function buildGround(path, bridges = [], rivers = []) {
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
  const m = 600;
  const w = maxX - minX + m * 2,
    h = maxZ - minZ + m * 2;
  const cx = (minX + maxX) / 2,
    cz = (minZ + maxZ) / 2;

  // nature.js の水面・土手は実測の川ポリライン(rivers)に沿ったリボンとして置かれる。
  // 道路直近(帯の内側)は沈めず、その帯の実効範囲だけをなだらかに沈める。
  const dips = buildRiverDips(path, bridges, rivers);
  const segX = dips.length
    ? Math.min(220, Math.max(40, Math.round(w / 40)))
    : 1;
  const segZ = dips.length
    ? Math.min(220, Math.max(40, Math.round(h / 40)))
    : 1;
  const geo = new THREE.PlaneGeometry(w, h, segX, segZ);
  if (dips.length) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = cx + pos.getX(i),
        wz = cz - pos.getY(i);
      const dip = riverDipDepthAt(wx, wz, dips);
      if (dip > 0) pos.setZ(i, -dip);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ color: CFG.colors.ground }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(cx, -0.05, cz);
  return mesh;
}
