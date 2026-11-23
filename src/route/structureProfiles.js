export const RIVER_BRIDGE_ARCH_HEIGHT = 0.4;

/** Return a shallow parabolic bridge deck that meets PLATEAU at both ends. */
export function archedDeckElevation(
  terrainAtS,
  from,
  to,
  s,
  archHeight = RIVER_BRIDGE_ARCH_HEIGHT,
) {
  const span = Math.max(1e-6, to - from);
  const t = Math.max(0, Math.min(1, (s - from) / span));
  const startY = Number(terrainAtS(from));
  const endY = Number(terrainAtS(to));
  if (!Number.isFinite(startY) || !Number.isFinite(endY)) {
    throw new Error(`Arched deck endpoints are not finite: ${from}..${to}`);
  }
  // A quartic arch reaches the requested crest while keeping both endpoint
  // slopes at zero, so the bridge meets the PLATEAU road without a kink.
  const appliedArchHeight = Math.min(Number(archHeight), Math.max(0.2, span * 0.015));
  const archShape = 16 * t ** 2 * (1 - t) ** 2;
  return startY + (endY - startY) * t + appliedArchHeight * archShape;
}
