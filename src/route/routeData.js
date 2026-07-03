import raw from '../data/route18.json';
import { RoutePath } from './path.js';

/** 路線データ一式(経路・停留所・橋・速度ゾーン) */
export const route = {
  name: raw.routeName,
  operator: raw.operator,
  destination: raw.destination,
  originName: raw.origin,
  source: raw.source,
  scale: raw.scale,
  path: new RoutePath(raw.path),
  stops: raw.stops, // [{name, s}]
  bridges: raw.bridges, // [{name, s, length}]
  speedZones: raw.speedZones, // [{from, to, limit(km/h)}]
  roadSections: raw.roadSections ?? [], // [{from, to, lanes}]
  intersections: raw.intersections ?? [], // [{s, heading, width, lanes}]
  signals: raw.signals ?? [], // [{s, name}]
};

/** s 位置の制限速度 [m/s] */
export function speedLimitAt(s) {
  for (const z of route.speedZones) {
    if (s >= z.from && s < z.to) return z.limit / 3.6;
  }
  return 40 / 3.6;
}

/** s 位置の制限速度 [km/h](HUD表示用) */
export function speedLimitKmhAt(s) {
  for (const z of route.speedZones) {
    if (s >= z.from && s < z.to) return z.limit;
  }
  return 40;
}
