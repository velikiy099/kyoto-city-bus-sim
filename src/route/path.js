/**
 * RoutePath: 弧長パラメータ化された路線経路
 * path は 2m 等間隔リサンプル済みなので、s → index は O(1)。
 */
export class RoutePath {
  constructor(points, step = 2, distances = null) {
    this.points = points; // [[x, z], ...]
    this.step = step;
    // 端数対策: 正確な累積長を持つ(最終区間だけ step 未満)
    this.cum = new Float64Array(points.length);
    const useDistances = Array.isArray(distances)
      && distances.length === points.length
      && distances.every((value, index) => Number.isFinite(value) && (index === 0 || value > distances[index - 1]));
    if (useDistances) {
      for (let i = 0; i < points.length; i++) this.cum[i] = distances[i];
    } else {
      for (let i = 1; i < points.length; i++) {
        const dx = points[i][0] - points[i - 1][0];
        const dz = points[i][1] - points[i - 1][1];
        this.cum[i] = this.cum[i - 1] + Math.hypot(dx, dz);
      }
    }
    this.length = this.cum[points.length - 1];
  }

  _locate(s) {
    const clamped = Math.max(0, Math.min(this.length - 1e-6, s));
    let i = Math.min(this.points.length - 2, Math.floor(clamped / this.step));
    // リサンプル誤差の保険(±1程度しか動かない)
    while (i > 0 && this.cum[i] > clamped) i--;
    while (i < this.points.length - 2 && this.cum[i + 1] < clamped) i++;
    const segLen = this.cum[i + 1] - this.cum[i] || 1e-9;
    return { i, t: (clamped - this.cum[i]) / segLen };
  }

  getPoint(s) {
    const { i, t } = this._locate(s);
    const [a, b] = [this.points[i], this.points[i + 1]];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  getTangent(s) {
    const { i } = this._locate(s);
    const [a, b] = [this.points[i], this.points[i + 1]];
    const dx = b[0] - a[0],
      dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1e-9;
    return [dx / l, dz / l];
  }

  /** 曲率 [1/m](符号付き: 左カーブ正)。前後 lookahead m の接線差分から */
  curvatureAt(s, lookahead = 6) {
    const t1 = this.getTangent(Math.max(0, s - lookahead));
    const t2 = this.getTangent(Math.min(this.length, s + lookahead));
    const cross = t1[0] * t2[1] - t1[1] * t2[0];
    const dot = Math.max(-1, Math.min(1, t1[0] * t2[0] + t1[1] * t2[1]));
    return Math.atan2(cross, dot) / (2 * lookahead);
  }

  /**
   * 位置 → 最近傍の弧長 s と横偏差(進行方向左が負/右が正)
   * hintS 近傍(±window)のみ探索。hintS=null なら全探索。
   */
  closestS(pos, hintS = null, window = 150) {
    const [px, pz] = pos;
    let i0 = 0,
      i1 = this.points.length - 2;
    if (hintS != null) {
      i0 = Math.max(0, Math.floor((hintS - window) / this.step));
      i1 = Math.min(
        this.points.length - 2,
        Math.ceil((hintS + window) / this.step),
      );
    }
    let bestS = 0,
      bestD2 = Infinity,
      bestLat = 0;
    for (let i = i0; i <= i1; i++) {
      const a = this.points[i],
        b = this.points[i + 1];
      const abx = b[0] - a[0],
        abz = b[1] - a[1];
      const ab2 = abx * abx + abz * abz || 1e-12;
      let t = ((px - a[0]) * abx + (pz - a[1]) * abz) / ab2;
      t = Math.max(0, Math.min(1, t));
      const qx = a[0] + abx * t,
        qz = a[1] + abz * t;
      const dx = px - qx,
        dz = pz - qz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestS = this.cum[i] + Math.sqrt(ab2) * t;
        // 横偏差: 接線×偏差ベクトルの外積符号(右手系 x-z 平面)
        const l = Math.sqrt(ab2);
        bestLat = (abx / l) * dz - (abz / l) * dx; // 左が負・右が正になるよう符号調整済み
      }
    }
    return { s: bestS, lateral: bestLat, dist: Math.sqrt(bestD2) };
  }
}
