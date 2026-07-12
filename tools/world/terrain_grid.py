"""Create a connected regular terrain grid from PLATEAU DEM triangles.

The old pipeline selected individual triangles by distance and count. That destroyed
mesh connectivity and produced floating fragments. This module bins DEM vertices,
interpolates a regular grid, fills missing cells by IDW extrapolation, and smooths the
result while retaining a single connected topology.
"""
from __future__ import annotations

import math
import statistics
from collections import defaultdict
from typing import Sequence


def _route_bounds(route_path: Sequence[Sequence[float]], padding: float):
    xs = [point[0] for point in route_path]
    zs = [point[1] for point in route_path]
    return min(xs) - padding, max(xs) + padding, min(zs) - padding, max(zs) + padding


def build_connected_terrain_grid(
    terrain_raw,
    datum: float,
    route_path: Sequence[Sequence[float]],
    spacing: float = 30.0,
    padding: float = 650.0,
    max_vertices: int = 160_000,
    smoothing_passes: int = 2,
):
    min_x, max_x, min_z, max_z = _route_bounds(route_path, padding)
    width_m = max_x - min_x
    height_m = max_z - min_z
    spacing = max(8.0, float(spacing))
    estimated = (math.ceil(width_m / spacing) + 1) * (math.ceil(height_m / spacing) + 1)
    if estimated > max_vertices:
        spacing *= math.sqrt(estimated / max_vertices)

    width = math.ceil(width_m / spacing) + 1
    height = math.ceil(height_m / spacing) + 1
    step_x = width_m / max(1, width - 1)
    step_z = height_m / max(1, height - 1)

    # Aggregate source vertices into small cells. This removes duplicate triangle
    # vertices and gives each area comparable influence regardless of tessellation.
    source_cell = max(4.0, spacing * 0.55)
    aggregate = defaultdict(lambda: [0.0, 0.0, 0.0, 0])
    raw_count = 0
    for vertices, _file, _crs, _distance in terrain_raw:
        for x, y, z in vertices:
            if x < min_x - spacing or x > max_x + spacing or z < min_z - spacing or z > max_z + spacing:
                continue
            key = (math.floor(x / source_cell), math.floor(z / source_cell))
            item = aggregate[key]
            item[0] += x
            item[1] += y - datum
            item[2] += z
            item[3] += 1
            raw_count += 1

    samples = []
    sample_grid = defaultdict(list)
    search_cell = spacing * 2.0
    for item in aggregate.values():
        x, y, z = item[0] / item[3], item[1] / item[3], item[2] / item[3]
        index = len(samples)
        samples.append((x, y, z))
        sample_grid[(math.floor(x / search_cell), math.floor(z / search_cell))].append(index)

    fallback = statistics.median([sample[1] for sample in samples]) if samples else 0.0

    def interpolate(x: float, z: float) -> float:
        gx, gz = math.floor(x / search_cell), math.floor(z / search_cell)
        candidates = set()
        for radius in (1, 2, 4, 8, 16, 32):
            for ix in range(gx - radius, gx + radius + 1):
                for iz in range(gz - radius, gz + radius + 1):
                    candidates.update(sample_grid.get((ix, iz), ()))
            if len(candidates) >= 12:
                break
        if not candidates:
            return fallback
        nearest = sorted(
            ((samples[index][0] - x) ** 2 + (samples[index][2] - z) ** 2, samples[index][1])
            for index in candidates
        )[:16]
        if nearest[0][0] < 0.25:
            return nearest[0][1]
        weighted = 0.0
        weights = 0.0
        regularizer = max(16.0, spacing * spacing * 0.12)
        for distance2, y in nearest:
            weight = 1.0 / (distance2 + regularizer)
            weighted += y * weight
            weights += weight
        return weighted / weights if weights else fallback

    values = [interpolate(min_x + ix * step_x, min_z + iz * step_z)
              for iz in range(height) for ix in range(width)]

    # Low-strength smoothing removes Voronoi seams in extrapolated regions while
    # preserving broad DEM gradients. The topology remains a regular connected grid.
    for _ in range(max(0, smoothing_passes)):
        previous = values
        values = previous.copy()
        for iz in range(1, height - 1):
            for ix in range(1, width - 1):
                index = iz * width + ix
                neighbors = (
                    previous[index - 1], previous[index + 1],
                    previous[index - width], previous[index + width],
                )
                values[index] = previous[index] * 0.72 + sum(neighbors) * 0.07

    return {
        "version": 1,
        "origin": [round(min_x, 3), round(min_z, 3)],
        "spacing": [round(step_x, 4), round(step_z, 4)],
        "width": width,
        "height": height,
        "heights": [round(value, 3) for value in values],
        "sourcePointCount": raw_count,
        "aggregatedSourcePointCount": len(samples),
        "interpolation": "inverse-distance-weighted-with-nearest-sample-extrapolation",
        "connected": True,
        "sourceInfluenceCorridorMeters": 420,
        "extrapolationPaddingMeters": padding,
    }
