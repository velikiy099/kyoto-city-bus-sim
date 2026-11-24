import * as THREE from "three";

/**
 * glTFのStandardマテリアルを世界観(Lambert)に合わせて変換する。
 * ガラスはマテリアル名で判別して半透明に差し替え。
 */
const GLASS = {
  BusGlass: { color: 0x46545f, opacity: 0.28 },
  BusGlassDark: { color: 0x20282e, opacity: 0.55 },
  CarGlass: { color: 0x232e38, opacity: 0.8 },
};

const cache = new Map();

function convert(m) {
  if (cache.has(m.uuid)) return cache.get(m.uuid);
  const g = GLASS[m.name];
  const out = g
    ? new THREE.MeshLambertMaterial({
        color: g.color,
        transparent: true,
        opacity: g.opacity,
      })
    : new THREE.MeshLambertMaterial({
        color: m.color,
        map: m.map ?? null,
        emissive: m.emissive ?? new THREE.Color(0x000000),
        emissiveIntensity: m.emissiveIntensity ?? 1,
        emissiveMap: m.emissiveMap ?? null,
        transparent: Boolean(m.transparent),
        opacity: m.opacity ?? 1,
        alphaTest: m.alphaTest ?? 0,
      });
  out.name = m.name;
  out.side = g ? THREE.DoubleSide : m.side; // ガラスは両面表示、不透明パーツは単面(FrontSide)を維持
  cache.set(m.uuid, out);
  return out;
}

export function lambertize(model) {
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material)
      ? o.material.map(convert)
      : convert(o.material);
  });
}
