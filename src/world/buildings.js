import * as THREE from "three";
import {
  route,
  leftWidthAt,
  rightWidthAt,
  sectionAt,
} from "../route/routeData.js";

// road.js が実際に描く縁石(+0.5m)+歩道(+2.7m、sidewalk:'none' 区間は無し)の外縁。
// leftWidthAt/rightWidthAt(車道帯のみ)を建物除外の基準にすると、歩道の上に建物の壁が
// めり込んで見える(車道には食い込んでいなくても「道路にはみ出て」見える)ため、
// 実際に舗装される歩道外縁までを除外の基準にする。
const CURB_SIDEWALK_W = 3.2;
function pavedHalfWidthAt(s, side) {
  const base = side < 0 ? leftWidthAt(s) : rightWidthAt(s);
  return base + (sectionAt(s).sidewalk === "none" ? 0.5 : CURB_SIDEWALK_W);
}

function footprintArea(footprint) {
  let area = 0;
  for (let i = 0; i < footprint.length; i++) {
    const p = footprint[i];
    const q = footprint[(i + 1) % footprint.length];
    area += p[0] * q[1] - q[0] * p[1];
  }
  return area / 2;
}

function footprintGeometry(footprint, height) {
  // 既存の側壁インデックスでは、x-z面で時計回りの輪郭だけが外向き法線になる。
  const oriented =
    footprintArea(footprint) > 0 ? [...footprint].reverse() : [...footprint];
  const verts2 = oriented.map(([x, z]) => new THREE.Vector2(x, z));
  const faces = THREE.ShapeUtils.triangulateShape(verts2, []);
  const positions = [];
  const indices = [];
  for (const [x, z] of oriented) positions.push(x, 0, z);
  for (const [x, z] of oriented) positions.push(x, height, z);
  const n = oriented.length;
  for (const face of faces) indices.push(face[2] + n, face[1] + n, face[0] + n);
  for (const face of faces) indices.push(face[0], face[1], face[2]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, j + n, i, j + n, i + n);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// 交差点(route.intersections)の各腕(交差道路)の舗装矩形。本線とは別に、これらの
// 腕の上に建物が乗っていないかも調べる必要がある(四条大宮=四条通など、本線の
// leftWidthAt/rightWidthAt だけでは検出できない交差側の食い込み)。
function intersectionArmRects(path) {
  const rects = [];
  for (const ix of route.intersections ?? []) {
    if (!ix.arms?.length) continue;
    const s = Math.max(0, Math.min(path.length - 0.1, ix.s));
    const [cx, cz] = path.getPoint(s);
    const armWFallback = Math.max(5.5, ix.width ?? 7);
    for (const arm of ix.arms) {
      if (!arm.exists || arm.length <= 0) continue;
      rects.push({
        cx,
        cz,
        heading: ix.heading ?? 0,
        side: arm.side,
        length: arm.length,
        halfW: (arm.width ?? armWFallback) / 2,
      });
    }
  }
  return rects;
}

// OSM建物の実ジオメトリと簡略化した経路形状には誤差があり、実道路より広い道路モデル(車道+縁石+歩道)に
// 建物の前面が数m食い込んでしまうことがある。
// 従来は食い込む建物を丸ごと非表示にしていたが、これだと沿道の一列が全滅してしまう区間(大宮通、旧千本通など)が
// あるため、道路から遠ざかる方向へ必要最小限だけ平行移動(セットバック)させて配置する。
// ただし、シフト量が大きすぎる(15m超)建物は異常データとして非表示にする。
// また、交差点の腕への食い込みは従来どおり非表示のままとする。
function overlapsArmRects(armRects, footprint) {
  for (const r of armRects) {
    for (const p of footprint) {
      const dx = p[0] - r.cx,
        dz = p[1] - r.cz;
      const along = dx * Math.sin(r.heading) + dz * Math.cos(r.heading);
      const perp = dx * Math.cos(r.heading) - dz * Math.sin(r.heading);
      const alongOk =
        r.side > 0
          ? along > 0 && along < r.length
          : along < 0 && along > -r.length;
      if (alongOk && Math.abs(perp) < r.halfW) return true;
    }
  }
  return false;
}

function buildOsmBuildings(scene, path, buildings, exclusions) {
  const isExcluded = (x, z) =>
    exclusions.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r);
  const armRects = intersectionArmRects(path);
  const materials = new Map();
  let count = 0;
  for (const b of buildings ?? []) {
    if (!b.footprint?.length || b.footprint.length < 3) continue;
    const center = b.footprint
      .reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0])
      .map((v) => v / b.footprint.length);
    if (isExcluded(center[0], center[1])) continue;
    if (overlapsArmRects(armRects, b.footprint)) continue;

    // 道路へのめり込み判定とセットバック処理
    const { lateral: centerLat } = path.closestS(center);
    const side = centerLat >= 0 ? 1 : -1;
    let maxShift = 0;
    const margin = 0.4;
    for (const p of b.footprint) {
      const { s: s_i, lateral: lateral_i } = path.closestS(p);
      const roadW = pavedHalfWidthAt(s_i, side);
      const overlap = roadW + margin - side * lateral_i;
      if (overlap > maxShift) {
        maxShift = overlap;
      }
    }

    if (maxShift > 15) {
      // 異常データとして非表示にする
      continue;
    }

    let footprint = b.footprint;
    if (maxShift > 0) {
      const { s: s_c } = path.closestS(center);
      const [tx_c, tz_c] = path.getTangent(s_c);
      // 右法線は [-tz, tx] なので、それに side を乗じて道路外側への向きにする
      const dirX = -tz_c * side;
      const dirZ = tx_c * side;
      footprint = b.footprint.map(([x, z]) => [
        x + dirX * maxShift,
        z + dirZ * maxShift,
      ]);
    }

    const color = b.color ?? 0xcfc8ba;
    if (!materials.has(color))
      materials.set(color, new THREE.MeshLambertMaterial({ color }));
    const mesh = new THREE.Mesh(
      footprintGeometry(footprint, Math.max(2.8, b.height ?? 6)),
      materials.get(color),
    );
    scene.add(mesh);
    count++;
  }
  return { count };
}

/** 沿道のOSM建物群。OSMデータが無い場合は埋め草を置かない。 */
export function buildBuildings(
  scene,
  path,
  exclusions = [],
  osmBuildings = [],
) {
  if (!osmBuildings?.length) return { count: 0 };
  return buildOsmBuildings(scene, path, osmBuildings, exclusions);
}
