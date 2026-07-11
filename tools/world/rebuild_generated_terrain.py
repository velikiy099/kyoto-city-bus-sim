#!/usr/bin/env python3
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public/world/generated"
ROUTE_FILE = ROOT / "src/data/route18.json"
PROFILE_FILE = ROOT / "src/world/declarative/generated/route-elevation.json"
SOURCE_TERRAIN = PUBLIC / "plateau-terrain.json"
BUILDINGS = PUBLIC / "plateau-buildings.json"
TRANSPORT = PUBLIC / "plateau-transportation.json"
OUTPUT_PUBLIC = SOURCE_TERRAIN
OUTPUT_RUNTIME = ROOT / "src/world/declarative/generated/terrain-grid.json"
MANIFEST = ROOT / "public/world/world-manifest.json"

GRID_SPACING = 30.0
PADDING = 650.0
SOURCE_CELL = 12.0
INDEX_CELL = 90.0
ROUTE_INDEX_CELL = 100.0
MAX_NEIGHBORS = 18


def load(path: Path):
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def route_profile_sampler(samples):
    def sample(s: float) -> float:
        if s <= samples[0][0]:
            return float(samples[0][1])
        if s >= samples[-1][0]:
            return float(samples[-1][1])
        lo, hi = 0, len(samples) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if samples[mid][0] <= s:
                lo = mid
            else:
                hi = mid
        s0, y0 = samples[lo]
        s1, y1 = samples[hi]
        t = 0.0 if s1 == s0 else (s - s0) / (s1 - s0)
        return y0 + (y1 - y0) * t
    return sample


class RouteIndex:
    def __init__(self, points, elevations):
        self.points = points
        self.elevations = elevations
        self.grid = defaultdict(list)
        for i, (x, z) in enumerate(points):
            self.grid[(math.floor(x / ROUTE_INDEX_CELL), math.floor(z / ROUTE_INDEX_CELL))].append(i)

    def nearest(self, x: float, z: float):
        gx, gz = math.floor(x / ROUTE_INDEX_CELL), math.floor(z / ROUTE_INDEX_CELL)
        candidates = []
        for radius in range(0, 10):
            candidates.clear()
            for ix in range(gx - radius, gx + radius + 1):
                for iz in range(gz - radius, gz + radius + 1):
                    candidates.extend(self.grid.get((ix, iz), ()))
            if candidates:
                break
        if not candidates:
            candidates = range(len(self.points))
        best = min(candidates, key=lambda i: (self.points[i][0] - x) ** 2 + (self.points[i][1] - z) ** 2)
        px, pz = self.points[best]
        return self.elevations[best], math.hypot(px - x, pz - z), best


def aggregate_sources(terrain_doc, buildings_doc, transport_doc):
    # key -> sumX, sumY, sumZ, sumWeight, sourceMask
    cells = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0, 0])

    def put(x, y, z, weight, mask):
        if not all(map(math.isfinite, (x, y, z))):
            return
        key = (math.floor(x / SOURCE_CELL), math.floor(z / SOURCE_CELL))
        item = cells[key]
        item[0] += x * weight
        item[1] += y * weight
        item[2] += z * weight
        item[3] += weight
        item[4] |= mask

    for tri in terrain_doc.get("triangles", []):
        for x, y, z in tri:
            put(float(x), float(y), float(z), 1.0, 1)

    # Building GroundSurface/baseHeight is useful outside the aggressively cropped DEM strip.
    for building in buildings_doc.get("features", []):
        base = float(building.get("baseHeight", 0.0))
        footprint = building.get("footprint") or []
        center = building.get("center")
        if center:
            put(float(center[0]), base, float(center[1]), 0.7, 2)
        # Sparse footprint samples keep broad blocks from flattening into a single center point.
        step = max(1, len(footprint) // 4)
        for x, z in footprint[::step]:
            put(float(x), base, float(z), 0.35, 2)

    for feature in transport_doc.get("features", []):
        polygon = feature.get("polygon") or []
        if not polygon:
            continue
        # Transportation surfaces are often planar and reliable enough as weak elevation samples.
        step = max(1, len(polygon) // 6)
        for x, y, z in polygon[::step]:
            put(float(x), float(y), float(z), 0.25, 4)

    samples = []
    for sx, sy, sz, sw, mask in cells.values():
        if sw > 0:
            samples.append([sx / sw, sy / sw, sz / sw, mask])
    return samples


def build_grid(route, profile, sources):
    path = route["path"]
    route_step = 2.0
    profile_at = route_profile_sampler(profile["samples"])
    route_elevations = [profile_at(i * route_step) for i in range(len(path))]
    route_index = RouteIndex(path, route_elevations)

    # Convert source heights to residuals from the closest route elevation. This preserves
    # real cross slopes locally while making long-distance extrapolation stable.
    sample_grid = defaultdict(list)
    residual_samples = []
    for x, y, z, mask in sources:
        baseline, route_distance, _ = route_index.nearest(x, z)
        residual = max(-18.0, min(18.0, y - baseline))
        idx = len(residual_samples)
        residual_samples.append((x, z, residual, route_distance, mask))
        sample_grid[(math.floor(x / INDEX_CELL), math.floor(z / INDEX_CELL))].append(idx)

    min_x = min(p[0] for p in path) - PADDING
    max_x = max(p[0] for p in path) + PADDING
    min_z = min(p[1] for p in path) - PADDING
    max_z = max(p[1] for p in path) + PADDING
    width = math.ceil((max_x - min_x) / GRID_SPACING) + 1
    height = math.ceil((max_z - min_z) / GRID_SPACING) + 1
    step_x = (max_x - min_x) / (width - 1)
    step_z = (max_z - min_z) / (height - 1)

    def nearby(x, z):
        gx, gz = math.floor(x / INDEX_CELL), math.floor(z / INDEX_CELL)
        found = []
        for radius in range(0, 7):
            found.clear()
            for ix in range(gx - radius, gx + radius + 1):
                for iz in range(gz - radius, gz + radius + 1):
                    found.extend(sample_grid.get((ix, iz), ()))
            if len(found) >= MAX_NEIGHBORS:
                break
        return found

    values = [0.0] * (width * height)
    route_distances = [0.0] * (width * height)
    source_distances = [9999.0] * (width * height)
    for iz in range(height):
        z = min_z + iz * step_z
        for ix in range(width):
            x = min_x + ix * step_x
            k = iz * width + ix
            baseline, route_distance, _ = route_index.nearest(x, z)
            route_distances[k] = route_distance
            ids = nearby(x, z)
            nearest = []
            for idx in ids:
                sx, sz, residual, sample_route_distance, mask = residual_samples[idx]
                d2 = (sx - x) ** 2 + (sz - z) ** 2
                nearest.append((d2, residual, sample_route_distance, mask))
            nearest.sort(key=lambda item: item[0])
            nearest = nearest[:MAX_NEIGHBORS]
            if not nearest:
                values[k] = baseline
                continue
            source_distance = math.sqrt(nearest[0][0])
            source_distances[k] = source_distance
            weighted = 0.0
            weights = 0.0
            for d2, residual, sample_route_distance, mask in nearest:
                # DEM samples dominate; building/transport samples only extend coverage.
                quality = 1.0 if mask & 1 else (0.55 if mask & 2 else 0.35)
                w = quality / (d2 + 225.0)
                weighted += residual * w
                weights += w
            residual = weighted / weights if weights else 0.0

            # Keep measured influence through the intended 420 m corridor, then decay
            # smoothly so the terrain continues without a cliff into the far field.
            if source_distance <= 45:
                influence = 1.0
            elif source_distance <= 420:
                influence = 1.0 - 0.45 * ((source_distance - 45) / 375) ** 2
            else:
                influence = 0.55 * math.exp(-(source_distance - 420) / 220.0)
            # Close to the route, the generated route elevation is the exact road/terrain
            # constraint. Blend out over 28 m to avoid roads floating above the terrain.
            route_constraint = max(0.0, min(1.0, route_distance / 28.0))
            values[k] = baseline + residual * influence * route_constraint

    def smooth_once(src):
        dst = src.copy()
        for iz in range(1, height - 1):
            for ix in range(1, width - 1):
                k = iz * width + ix
                avg = (src[k - 1] + src[k + 1] + src[k - width] + src[k + width]) * 0.25
                # More smoothing in extrapolated areas, less where DEM points are close.
                alpha = 0.12 if source_distances[k] < 60 else 0.28
                dst[k] = src[k] * (1 - alpha) + avg * alpha
        return dst

    for _ in range(3):
        values = smooth_once(values)

    # Reapply route constraint after smoothing and limit implausible cell-to-cell slopes.
    for iz in range(height):
        z = min_z + iz * step_z
        for ix in range(width):
            x = min_x + ix * step_x
            k = iz * width + ix
            baseline, route_distance, _ = route_index.nearest(x, z)
            if route_distance < 28:
                blend = 1.0 - route_distance / 28.0
                values[k] = values[k] * (1 - blend) + baseline * blend

    max_delta = 7.5
    for _ in range(2):
        for iz in range(height):
            for ix in range(width):
                k = iz * width + ix
                if ix:
                    values[k] = max(values[k - 1] - max_delta, min(values[k - 1] + max_delta, values[k]))
                if iz:
                    values[k] = max(values[k - width] - max_delta, min(values[k - width] + max_delta, values[k]))
        for iz in range(height - 1, -1, -1):
            for ix in range(width - 1, -1, -1):
                k = iz * width + ix
                if ix < width - 1:
                    values[k] = max(values[k + 1] - max_delta, min(values[k + 1] + max_delta, values[k]))
                if iz < height - 1:
                    values[k] = max(values[k + width] - max_delta, min(values[k + width] + max_delta, values[k]))

    grid = {
        "version": 2,
        "origin": [round(min_x, 3), round(min_z, 3)],
        "spacing": [round(step_x, 5), round(step_z, 5)],
        "width": width,
        "height": height,
        "heights": [round(v, 3) for v in values],
        "connected": True,
        "sourceInfluenceCorridorMeters": 420,
        "sourceCoverageNote": "surviving DEM vertices plus PLATEAU building-base and transportation elevations",
        "extrapolationPaddingMeters": PADDING,
        "interpolation": "route-constrained-idw-residual-with-decaying-extrapolation",
        "sourceSampleCount": len(sources),
    }
    return grid


def main():
    route = load(ROUTE_FILE)
    profile = load(PROFILE_FILE)
    terrain_doc = load(SOURCE_TERRAIN)
    if not terrain_doc.get("triangles") and terrain_doc.get("grid"):
        grid = terrain_doc["grid"]
        OUTPUT_RUNTIME.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_RUNTIME.write_text(json.dumps(grid, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        print(json.dumps({"status": "already-connected", "vertices": len(grid.get("heights", []))}, ensure_ascii=False))
        return
    buildings_doc = load(BUILDINGS)
    transport_doc = load(TRANSPORT)
    sources = aggregate_sources(terrain_doc, buildings_doc, transport_doc)
    grid = build_grid(route, profile, sources)

    source = terrain_doc.get("source", {})
    output = {
        "version": 3,
        "generatedAt": terrain_doc.get("generatedAt"),
        "source": source,
        "grid": grid,
        "triangles": [],
    }
    OUTPUT_PUBLIC.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    OUTPUT_RUNTIME.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_RUNTIME.write_text(json.dumps(grid, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    manifest = load(MANIFEST)
    for layer in manifest.get("layers", []):
        if layer.get("id") == "terrain":
            layer["geometry"] = "connected-grid"
            layer["featureCount"] = (grid["width"] - 1) * (grid["height"] - 1) * 2
    policies = manifest.setdefault("policies", {})
    policies["terrainPolicy"] = "plateau-connected-grid-route-constrained-420m-with-decaying-extrapolation"
    policies["roadVisualPolicy"] = "osm-route-network-projected-on-plateau-terrain"
    policies["buildingPolicy"] = "plateau-footprint-and-height-ground-snapped"
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"width": grid["width"], "height": grid["height"], "vertices": len(grid["heights"]), "sources": len(sources)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
