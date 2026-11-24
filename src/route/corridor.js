/**
 * Return the Euclidean horizontal distance [m] from (x, z) to the closest
 * point on `path`. Returns Infinity when the path has no samples.
 */
export function distanceToRouteCorridor(path, x, z) {
  if (!path?.points?.length || typeof path.closestS !== "function") return Infinity;
  return path.closestS([x, z]).dist;
}

/**
 * Check whether world point (x, z) lies within `maxDistM` metres of `path`.
 */
export function isNearRouteCorridor(path, x, z, maxDistM = 400) {
  return distanceToRouteCorridor(path, x, z) <= maxDistM;
}
