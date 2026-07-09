import * as THREE from 'three';
import { route, leftWidthAt, rightWidthAt, turnExclusions, elevationAt } from '../route/routeData.js';
import { loadProps } from '../util/propsLib.js';

const mat = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, ...opts });

// 川底を地表(y=0)より低く見せる深さ[m]。橋は road.js のデッキ(elevationAt)がそのまま
// 川の上を跨ぐので、川岸ぶんだけ相対的に「道路が高く・川が低く」見える。
const RIVER_DEPTH = 3.2;
const BANK_TIERS = [
  { h: 1.2, w: 6, color: 0x7ba15e }, // 上段: 芝の土手
  { h: RIVER_DEPTH - 1.2, w: 4.5, color: 0x9c9178 }, // 下段: 護岸(土)
];

/**
 * 川(鴨川・桂川・西高瀬川)・橋・遠景の山・街路樹
 * 川は bridges の s 位置で経路と直交する帯として描く。川底は RIVER_DEPTH ぶん低く、
 * 土手は段状(芝→護岸)に地表から水面まで下る。
 */
export function buildNature(scene, path) {
  const g = new THREE.Group();
  scene.add(g);
  const exclusions = [];

  // ---- 川と橋 ----
  for (const br of route.bridges) {
    const [px, pz] = path.getPoint(br.s);
    const [tx, tz] = path.getTangent(br.s);
    const across = Math.atan2(tx, tz); // 経路方位
    const w = Math.max(18, br.length * 0.85); // 川幅
    const deckElev = elevationAt(br.s); // 跨線橋等と重なる場合は路面高さに追従

    // 川面(道路の左右に2枚 — 道路帯とは重ねない)。水面は地表より RIVER_DEPTH 低い。
    const nx = -tz, nz = tx; // 経路の横方向
    for (const side of [-1, 1]) {
      const water = new THREE.Mesh(new THREE.PlaneGeometry(340, w), mat(0x4fa8d8));
      water.rotation.x = -Math.PI / 2;
      water.rotation.z = -across;
      const off = side * (340 / 2 + 7);
      water.position.set(px + nx * off, -RIVER_DEPTH + 0.05, pz + nz * off);
      g.add(water);

      // 土手(地表→水面の段状斜面)。両岸(bankSide)・両段(BANK_TIERS)で計4段。
      for (const bankSide of [-1, 1]) {
        let yTop = 0, distFromWater = w / 2;
        for (const tier of BANK_TIERS) {
          const yMid = yTop - tier.h / 2;
          const bank = new THREE.Mesh(new THREE.BoxGeometry(340, tier.h, tier.w), mat(tier.color));
          bank.rotation.y = across;
          const d = distFromWater + tier.w / 2;
          bank.position.set(
            px + nx * off + tx * bankSide * d,
            yMid,
            pz + nz * off + tz * bankSide * d
          );
          g.add(bank);
          yTop -= tier.h;
          distFromWater += tier.w;
        }
      }
    }

    // 橋桁(路面 elevationAt(br.s) の下に確実に下げて z-fight を防ぐ)と欄干
    const deck = new THREE.Mesh(new THREE.BoxGeometry(11, 0.8, w + 10), mat(0x8f9499));
    deck.position.set(px, deckElev - 0.48, pz);
    deck.rotation.y = across;
    g.add(deck);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.15, w + 10), mat(0xdfe3e6));
      const nx = -tz, nz = tx;
      rail.position.set(px + nx * side * 5.1, deckElev + 0.85, pz + nz * side * 5.1);
      rail.rotation.y = across;
      g.add(rail);
    }

    // 川の上・土手には建物を置かない(半径は実際の川幅+土手ぶんに比例。
    // 以前は全橋一律340mで、実際の川幅(例: 小枝橋51m)よりはるかに広い範囲を
    // 建物禁止にしてしまい、小枝橋以南〜赤池の建物配置を妨げていた)
    exclusions.push({ x: px, z: pz, r: w / 2 + 24 });
  }

  // ---- 遠景の山(北・東・西 — 京都盆地) ----
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of path.points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const cx = (minX + maxX) / 2;
  const mountainMat = mat(0x6d8577);
  const mk = (x, z, r, h) => {
    const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mountainMat);
    m.position.set(x, 0, z);
    g.add(m);
  };
  // 北山(二条駅の北)
  for (let i = 0; i < 6; i++) mk(cx - 900 + i * 420, minZ - 750 - (i % 2) * 160, 520 + (i % 3) * 130, 260 + (i % 2) * 110);
  // 東山(左手)
  for (let i = 0; i < 7; i++) mk(maxX + 950 + (i % 2) * 200, minZ + 300 + i * 640, 480 + (i % 3) * 120, 230 + (i % 3) * 80);
  // 西山(右手)
  for (let i = 0; i < 6; i++) mk(minX - 980 - (i % 2) * 240, minZ + 500 + i * 700, 560 + (i % 3) * 140, 280 + (i % 2) * 100);

  // ---- 街路樹(Blender製2種を InstancedMesh で量産) ----
  const turnZones = turnExclusions(); // 右左折交差点のスタブ道路上には植えない
  // 線路の下(JR在来線・新幹線の桁が路側を大きく覆う区間)には植えない
  const railZones = (route.railStructures ?? []).map((r) => ({
    from: r.s - (r.width ?? 20) / 2 - 6,
    to: r.s + (r.width ?? 20) / 2 + 6,
  }));
  // 歩道が無い区間(旧千本通など)には街路樹を植えない
  const noSidewalkZones = (route.roadSections ?? [])
    .filter((sec) => sec.sidewalk === 'none')
    .map((sec) => ({ from: sec.from, to: sec.to }));
  const items = [];
  for (let s = 40; s < path.length * 0.62; s += 42) {
    if (railZones.some((z) => s > z.from && s < z.to)) continue;
    if (noSidewalkZones.some((z) => s > z.from && s < z.to)) continue;
    for (const side of [-1, 1]) {
      if (((s / 42) | 0) % 2 === (side === -1 ? 0 : 1)) continue; // 互い違い
      const [px, pz] = path.getPoint(s);
      const [tx, tz] = path.getTangent(s);
      const lat = side * ((side < 0 ? leftWidthAt(s) : rightWidthAt(s)) + 2.4); // 道路幅に合わせて外側へ
      const x = px + -tz * lat, z = pz + tx * lat;
      if (turnZones.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r)) continue;
      items.push([x, z]);
    }
  }
  // ---- 鳥羽離宮跡公園(OSM実測: way 341709499「鳥羽離宮跡公園」の敷地形状に合わせて木を配置) ----
  // 実測ポリゴン(約130m×154mの矩形)の重心を経路へ投影した結果: 城南宮道停留所の67m先・
  // 進行方向左へ71mの位置。以前は停留所+90m・半径190mの粗い円で過大に除外していたため、
  // 実際の公園より外側の区画にも建物が置けないままになっていた。
  const tobaStop = route.stops.find((st) => st.name === '城南宮道');
  if (tobaStop) {
    const anchorS = Math.min(path.length, tobaStop.s + 67);
    const [apx, apz] = path.getPoint(anchorS);
    const [atx, atz] = path.getTangent(anchorS);
    const anx = -atz, anz = atx;
    const [cx, cz] = [apx + anx * -71, apz + anz * -71];
    const halfW = 68, halfD = 80; // 実測バウンディングボックス(約130m×154m)+若干の余白
    exclusions.push({ x: cx, z: cz, r: Math.hypot(halfW, halfD) + 5 });
    let seed = 9001;
    const rndSeeded = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 150; i++) {
      const x = cx + (rndSeeded() - 0.5) * 2 * halfW;
      const z = cz + (rndSeeded() - 0.5) * 2 * halfD;
      if (turnZones.some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r)) continue;
      items.push([x, z]);
    }
  }

  // 座標由来の決定的な擬似乱数(向き・大きさのばらつき)
  const rnd = (x, z, k) => {
    const v = Math.sin(x * 127.1 + z * 311.7 + k * 74.7) * 43758.5453;
    return v - Math.floor(v);
  };
  loadProps().then((lib) => {
    const dummy = new THREE.Object3D();
    ['TreeA', 'TreeB'].forEach((name, vi) => {
      const own = items.filter((_, i) => i % 2 === vi); // 2種を交互に
      if (!own.length) return;
      lib.getObjectByName(name).traverse((part) => {
        if (!part.isMesh) return;
        const inst = new THREE.InstancedMesh(part.geometry, part.material, own.length);
        own.forEach(([x, z], i) => {
          dummy.position.set(x, 0, z);
          dummy.rotation.set(0, rnd(x, z, 1) * Math.PI * 2, 0);
          dummy.scale.setScalar(0.85 + rnd(x, z, 2) * 0.35);
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
        });
        inst.instanceMatrix.needsUpdate = true;
        g.add(inst);
      });
    });
  });

  return exclusions;
}
