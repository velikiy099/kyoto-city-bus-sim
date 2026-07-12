const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smoothstep = (value) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

export const RIVER_LINE_REACH = 400;
export const RIVER_TERRAIN_DIP_DEPTH = 3.4;
const OSM_LINE_WIDTH_FALLBACK = {
  "桂川": 48,
  "鴨川": 22,
  "西高瀬川": 8,
};

/**
 * OSM waterway=river is normally a centreline, not a water-surface polygon.
 * Never use the bridge span as water width: that creates a false rectangular
 * lake.  Prefer an OSM width tag when the refreshed route data has one, then
 * use a conservative line-rendering fallback until a riverbank polygon exists.
 */
export function riverWidthMeters(bridge, line = null) {
  const tagged = Number(line?.widthMeters ?? bridge?.riverWidth);
  if (Number.isFinite(tagged) && tagged > 0) return tagged;
  return OSM_LINE_WIDTH_FALLBACK[bridge?.river] ?? 12;
}

/** Point-to-polyline distance in the world x-z plane. */
export function distToPolyline(px, pz, points) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const abx = b[0] - a[0];
    const abz = b[1] - a[1];
    const ab2 = abx * abx + abz * abz || 1e-9;
    let t = ((px - a[0]) * abx + (pz - a[1]) * abz) / ab2;
    t = Math.max(0, Math.min(1, t));
    const qx = a[0] + abx * t;
    const qz = a[1] + abz * t;
    best = Math.min(best, Math.hypot(px - qx, pz - qz));
  }
  return best;
}

/**
 * Return the OSM river polyline used by both water rendering and terrain carving.
 * Adjacent crossings of the same river are clipped around each bridge, while
 * single-crossing rivers retain the full extracted line.
 */
export function clippedRiverPoints(path, bridge, rivers) {
  const [px, pz] = path.getPoint(bridge.s);
  const [tx, tz] = path.getTangent(bridge.s);
  const heading = bridge.riverHeadingDeg != null
    ? (bridge.riverHeadingDeg * Math.PI) / 180
    : Math.atan2(tx, tz);
  const line = (rivers ?? []).find((river) => river.bridgeName === bridge.name);
  const full = line?.points?.length >= 2
    ? line.points
    : [
        [px - Math.sin(heading) * 170, pz - Math.cos(heading) * 170],
        [px, pz],
        [px + Math.sin(heading) * 170, pz + Math.cos(heading) * 170],
      ];
  const sameRiver = line && (rivers ?? []).some(
    (river) => river.bridgeName !== bridge.name && river.river === line.river,
  );
  if (!sameRiver) return full;

  let anchor = 0;
  let best = Infinity;
  for (let i = 0; i < full.length; i++) {
    const distance = Math.hypot(full[i][0] - px, full[i][1] - pz);
    if (distance < best) {
      best = distance;
      anchor = i;
    }
  }
  let from = anchor;
  let to = anchor;
  while (
    from > 0
    && Math.hypot(full[from - 1][0] - px, full[from - 1][1] - pz) < RIVER_LINE_REACH
  ) from--;
  while (
    to < full.length - 1
    && Math.hypot(full[to + 1][0] - px, full[to + 1][1] - pz) < RIVER_LINE_REACH
  ) to++;
  return full.slice(from, to + 1);
}

/** Build the exact river corridors used for both the visible water and terrain cut. */
export function buildRiverDips(path, bridges = [], rivers = []) {
  return bridges.map((bridge) => {
    const riverWidth = riverWidthMeters(bridge, (rivers ?? []).find((river) => river.bridgeName === bridge.name));
    const outer = Math.max(55, Math.min(200, riverWidth / 2 + 35));
    const points = clippedRiverPoints(path, bridge, rivers);
    const xs = points.map((point) => point[0]);
    const zs = points.map((point) => point[1]);
    return {
      bridgeName: bridge.name,
      river: bridge.river,
      points,
      inner: riverWidth / 2,
      outer,
      minX: Math.min(...xs) - outer,
      maxX: Math.max(...xs) + outer,
      minZ: Math.min(...zs) - outer,
      maxZ: Math.max(...zs) + outer,
    };
  });
}

/** Positive terrain cut depth at a world x-z coordinate. */
export function riverDipDepthAt(x, z, dips, depth = RIVER_TERRAIN_DIP_DEPTH) {
  let amount = 0;
  for (const item of dips ?? []) {
    if (x < item.minX || x > item.maxX || z < item.minZ || z > item.maxZ) continue;
    const distance = distToPolyline(x, z, item.points);
    const value = smoothstep(
      (item.outer - distance) / Math.max(1, item.outer - item.inner),
    );
    amount = Math.max(amount, value);
  }
  return amount * depth;
}
