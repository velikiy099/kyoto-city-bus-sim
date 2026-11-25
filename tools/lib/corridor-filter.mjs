const METERS_PER_DEG_LAT = 111320;

export function latLonDistanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const midLatRad = (((a[0] + b[0]) * 0.5) * Math.PI) / 180;
  const kLon = METERS_PER_DEG_LAT * Math.cos(midLatRad);
  return Math.hypot((a[0] - b[0]) * METERS_PER_DEG_LAT, (a[1] - b[1]) * kLon);
}

export function computeLatLonBounds(latlonLine = [], bufferMeters = 250) {
  if (!latlonLine.length) return [0, 0, 0, 0];
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const [lat, lon] of latlonLine) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
  }
  const centerLat = (south + north) * 0.5;
  const dLat = bufferMeters / METERS_PER_DEG_LAT;
  const dLon = bufferMeters / (METERS_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180));
  return [south - dLat, west - dLon, north + dLat, east + dLon];
}

export function boundsIntersect(a, b) {
  if (!a || !b) return false;
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function pointToSegmentDist2D(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-12) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export function minDistanceToLatLonPathMeters(latlon, latlonLine = []) {
  if (!latlon || !latlonLine.length) return Infinity;
  const kLon = METERS_PER_DEG_LAT * Math.cos((latlon[0] * Math.PI) / 180);
  if (latlonLine.length === 1) return latLonDistanceMeters(latlon, latlonLine[0]);
  let best = Infinity;
  for (let i = 1; i < latlonLine.length; i++) {
    const a = latlonLine[i - 1];
    const b = latlonLine[i];
    const d = pointToSegmentDist2D(
      0,
      0,
      (a[1] - latlon[1]) * kLon,
      (a[0] - latlon[0]) * METERS_PER_DEG_LAT,
      (b[1] - latlon[1]) * kLon,
      (b[0] - latlon[0]) * METERS_PER_DEG_LAT,
    );
    if (d < best) best = d;
  }
  return best;
}

export function minDistanceToXZPathMeters(x, z, pathPoints = []) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !pathPoints.length) return Infinity;
  if (pathPoints.length === 1) return Math.hypot(x - pathPoints[0][0], z - pathPoints[0][1]);
  let best = Infinity;
  for (let i = 1; i < pathPoints.length; i++) {
    const d = pointToSegmentDist2D(
      x,
      z,
      pathPoints[i - 1][0],
      pathPoints[i - 1][1],
      pathPoints[i][0],
      pathPoints[i][1],
    );
    if (d < best) best = d;
  }
  return best;
}

export function filterBridgesForRoute(bridges = [], latlonLine = [], maxDistM = 60) {
  return bridges.filter(
    (b) => b?.anchor && minDistanceToLatLonPathMeters(b.anchor, latlonLine) <= maxDistM,
  );
}

export function filterHighwayCrossingsForRoute(crossings = [], latlonLine = [], maxDistM = 60) {
  return crossings.filter(
    (hc) => hc?.anchor && minDistanceToLatLonPathMeters(hc.anchor, latlonLine) <= maxDistM,
  );
}

export function filterExtraRoadsForRoute(extraRoads = [], routeBounds) {
  if (!routeBounds) return extraRoads;
  return extraRoads.filter((road) => {
    if (!road?.geometry?.length) return false;
    const roadBounds = computeLatLonBounds(road.geometry, 50);
    return boundsIntersect(roadBounds, routeBounds);
  });
}

export function filterTurnOverridesForRoute(turnOverrides = [], latlonLine = [], maxDistM = 80) {
  return turnOverrides.filter(
    (ov) => ov?.anchor && minDistanceToLatLonPathMeters(ov.anchor, latlonLine) <= maxDistM,
  );
}

export function filterForcePlainCurvesForRoute(anchors = [], latlonLine = [], maxDistM = 80) {
  return anchors.filter(
    (anchor) => anchor && minDistanceToLatLonPathMeters(anchor, latlonLine) <= maxDistM,
  );
}

export function filterRiverRelationsForRoute(riverRelations = [], routeBounds) {
  if (!routeBounds) return riverRelations;
  return riverRelations.filter(
    (rel) => !rel?.bbox || boundsIntersect(rel.bbox, routeBounds),
  );
}

export function filterExtraCrosswalksForRoute(crosswalks = [], pathPoints = [], maxDistM = 80) {
  return crosswalks.filter((cw) => {
    if (!cw?.a || !cw?.b) return false;
    const midX = (cw.a[0] + cw.b[0]) * 0.5;
    const midZ = (cw.a[1] + cw.b[1]) * 0.5;
    return minDistanceToXZPathMeters(midX, midZ, pathPoints) <= maxDistM;
  });
}
