#!/usr/bin/env python3
"""Build declarative runtime layers from Kyoto PLATEAU CityGML and route18 OSM data.

PLATEAU is authoritative for visible city geometry (terrain, road/sidewalk surfaces,
buildings, bridges, water, vegetation and city furniture). OSM remains authoritative for
route topology, traffic direction, names, stops, signals and the existing traffic AI.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Iterator, Sequence

from pyproj import CRS, Transformer
from tqdm import tqdm

GML_ID = "{http://www.opengis.net/gml}id"


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def first_text(element: ET.Element, names: set[str]) -> str | None:
    for child in element.iter():
        if local_name(child.tag) in names and child.text and child.text.strip():
            return child.text.strip()
    return None


def all_text(element: ET.Element, names: set[str]) -> list[str]:
    values = []
    for child in element.iter():
        if local_name(child.tag) in names and child.text and child.text.strip():
            values.append(child.text.strip())
    return list(dict.fromkeys(values))


def numeric_text(element: ET.Element, names: set[str]) -> float | None:
    text = first_text(element, names)
    if text is None:
        return None
    match = re.search(r"[-+]?\d+(?:\.\d+)?", text)
    return float(match.group(0)) if match else None


def epsg_from_srs(value: str | None, fallback: str) -> str:
    if value:
        match = re.search(r"EPSG(?:/0/|::|:)(\d+)", value, flags=re.I)
        if match:
            return f"EPSG:{match.group(1)}"
        match = re.search(r"/(\d{4,5})$", value)
        if match:
            return f"EPSG:{match.group(1)}"
    return fallback


def detect_srs(element: ET.Element, fallback: str) -> str:
    for child in element.iter():
        value = child.attrib.get("srsName")
        if value:
            return epsg_from_srs(value, fallback)
    return fallback


def parse_coord_text(text: str, dimension: int) -> list[tuple[float, float, float]]:
    values = [float(value) for value in text.split()]
    if dimension not in (2, 3):
        dimension = 3 if len(values) % 3 == 0 else 2
    if len(values) % dimension != 0:
        if len(values) % 3 == 0:
            dimension = 3
        elif len(values) % 2 == 0:
            dimension = 2
        else:
            return []
    result = []
    for index in range(0, len(values), dimension):
        result.append((values[index], values[index + 1], values[index + 2] if dimension == 3 else 0.0))
    return result


def ring_from_linear_ring(linear_ring: ET.Element) -> list[tuple[float, float, float]]:
    for child in linear_ring.iter():
        if local_name(child.tag) == "posList" and child.text:
            dimension = int(child.attrib.get("srsDimension", linear_ring.attrib.get("srsDimension", "3")))
            return parse_coord_text(child.text, dimension)
    points = []
    for child in linear_ring.iter():
        if local_name(child.tag) == "pos" and child.text:
            points.extend(parse_coord_text(child.text, int(child.attrib.get("srsDimension", "3"))))
    return points


def exterior_rings(container: ET.Element) -> list[list[tuple[float, float, float]]]:
    rings = []
    for polygon in container.iter():
        if local_name(polygon.tag) not in {"Polygon", "PolygonPatch", "Triangle"}:
            continue
        exterior = next((child for child in polygon if local_name(child.tag) == "exterior"), None)
        search = exterior if exterior is not None else polygon
        linear_ring = next((child for child in search.iter() if local_name(child.tag) == "LinearRing"), None)
        if linear_ring is None:
            continue
        ring = ring_from_linear_ring(linear_ring)
        if len(ring) >= 3:
            rings.append(ring)
    return rings


def all_positions(container: ET.Element) -> list[tuple[float, float, float]]:
    positions = []
    for child in container.iter():
        if local_name(child.tag) == "posList" and child.text:
            positions.extend(parse_coord_text(child.text, int(child.attrib.get("srsDimension", "3"))))
        elif local_name(child.tag) == "pos" and child.text:
            positions.extend(parse_coord_text(child.text, int(child.attrib.get("srsDimension", "3"))))
    return positions


def signed_area(points: Sequence[Sequence[float]]) -> float:
    area = 0.0
    for index, point in enumerate(points):
        other = points[(index + 1) % len(points)]
        area += point[0] * other[1] - other[0] * point[1]
    return area / 2.0


def polygon_centroid(points: Sequence[Sequence[float]]) -> tuple[float, float]:
    area = signed_area(points)
    if abs(area) < 1e-8:
        return (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))
    cx = cz = 0.0
    for index, point in enumerate(points):
        other = points[(index + 1) % len(points)]
        cross = point[0] * other[1] - other[0] * point[1]
        cx += (point[0] + other[0]) * cross
        cz += (point[1] + other[1]) * cross
    return cx / (6.0 * area), cz / (6.0 * area)


def clean_ring_2d(points: list[list[float]]) -> list[list[float]]:
    cleaned = []
    for point in points:
        rounded = [round(point[0], 3), round(point[1], 3)]
        if not cleaned or math.dist(cleaned[-1], rounded) > 0.03:
            cleaned.append(rounded)
    if len(cleaned) > 2 and math.dist(cleaned[0], cleaned[-1]) < 0.03:
        cleaned.pop()
    if len(cleaned) >= 3 and signed_area(cleaned) > 0:
        cleaned.reverse()
    return cleaned


def clean_ring_3d(points: list[list[float]]) -> list[list[float]]:
    cleaned = []
    for point in points:
        rounded = [round(point[0], 3), round(point[1], 3), round(point[2], 3)]
        if not cleaned or math.dist([cleaned[-1][0], cleaned[-1][2]], [rounded[0], rounded[2]]) > 0.03:
            cleaned.append(rounded)
    if len(cleaned) > 2 and math.dist([cleaned[0][0], cleaned[0][2]], [cleaned[-1][0], cleaned[-1][2]]) < 0.03:
        cleaned.pop()
    if len(cleaned) >= 3 and signed_area([[p[0], p[2]] for p in cleaned]) > 0:
        cleaned.reverse()
    return cleaned


@dataclass
class Nearest:
    distance: float
    s: float
    x: float
    z: float


class RouteIndex:
    def __init__(self, points: Sequence[Sequence[float]], cell_size: float = 100.0):
        self.points = points
        self.cell_size = cell_size
        self.segments = []
        self.grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        cumulative = 0.0
        for index in range(len(points) - 1):
            ax, az = points[index]
            bx, bz = points[index + 1]
            length = math.hypot(bx - ax, bz - az)
            self.segments.append((ax, az, bx, bz, cumulative, length))
            cumulative += length
            for gx in range(math.floor(min(ax, bx) / cell_size) - 1, math.floor(max(ax, bx) / cell_size) + 2):
                for gz in range(math.floor(min(az, bz) / cell_size) - 1, math.floor(max(az, bz) / cell_size) + 2):
                    self.grid[(gx, gz)].append(index)
        self.length = cumulative

    def nearest(self, point: Sequence[float]) -> Nearest:
        px, pz = point
        gx, gz = math.floor(px / self.cell_size), math.floor(pz / self.cell_size)
        candidates: set[int] = set()
        max_radius = 8
        for radius in (1, 2, 4, max_radius):
            for ix in range(gx - radius, gx + radius + 1):
                for iz in range(gz - radius, gz + radius + 1):
                    candidates.update(self.grid.get((ix, iz), ()))
            if candidates:
                break
        if not candidates:
            # Nothing indexed within max_radius * cell_size (800m by default): the
            # point is far outside any corridor this codebase filters with (<=420m),
            # so an exact distance is unnecessary. Scanning every route segment here
            # is prohibitively slow for CityGML tiles where most geometry sits well
            # outside the route corridor (e.g. full DEM mesh tiles).
            return Nearest(float("inf"), 0.0, px, pz)
        best = Nearest(float("inf"), 0.0, 0.0, 0.0)
        for index in candidates:
            ax, az, bx, bz, start_s, length = self.segments[index]
            dx, dz = bx - ax, bz - az
            denom = dx * dx + dz * dz
            t = 0.0 if denom == 0 else max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / denom))
            x, z = ax + t * dx, az + t * dz
            distance = math.hypot(px - x, pz - z)
            if distance < best.distance:
                best = Nearest(distance, start_s + t * length, x, z)
        return best


class PointElevationIndex:
    def __init__(self, points: Sequence[Sequence[float]], cell_size: float = 80.0):
        self.points = points
        self.cell_size = cell_size
        self.grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for index, (x, _y, z) in enumerate(points):
            self.grid[(math.floor(x / cell_size), math.floor(z / cell_size))].append(index)

    def nearest(self, x: float, z: float, max_distance: float = 300.0) -> float | None:
        gx, gz = math.floor(x / self.cell_size), math.floor(z / self.cell_size)
        best_d = max_distance
        best_y = None
        max_radius = max(1, math.ceil(max_distance / self.cell_size))
        for radius in range(max_radius + 1):
            found = False
            for ix in range(gx - radius, gx + radius + 1):
                for iz in range(gz - radius, gz + radius + 1):
                    for index in self.grid.get((ix, iz), ()):
                        px, py, pz = self.points[index]
                        d = math.hypot(px - x, pz - z)
                        if d < best_d:
                            best_d, best_y, found = d, py, True
            if found and radius > 1:
                break
        return best_y


class OsmBuildingIndex:
    def __init__(self, buildings: Sequence[dict], cell_size: float = 50.0):
        self.cell_size = cell_size
        self.records = []
        self.grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for source_index, building in enumerate(buildings):
            footprint = building.get("footprint") or []
            if len(footprint) < 3:
                continue
            center = polygon_centroid(footprint)
            record = len(self.records)
            self.records.append((source_index, center, building))
            self.grid[(math.floor(center[0] / cell_size), math.floor(center[1] / cell_size))].append(record)

    def nearest(self, center: Sequence[float], limit: float = 20.0) -> dict | None:
        gx, gz = math.floor(center[0] / self.cell_size), math.floor(center[1] / self.cell_size)
        best = None
        best_distance = limit
        for ix in range(gx - 1, gx + 2):
            for iz in range(gz - 1, gz + 2):
                for record in self.grid.get((ix, iz), ()):
                    source_index, source_center, building = self.records[record]
                    distance = math.dist(center, source_center)
                    if distance < best_distance:
                        best_distance = distance
                        best = {"index": source_index, "distanceMeters": round(distance, 2), "id": building.get("id")}
        return best


@lru_cache(maxsize=None)
def make_transformer(source_crs: str):
    # CRS/Transformer construction is expensive (PROJ database lookups) and
    # source_crs is effectively constant per file, so build each one once
    # instead of once per ring/triangle (this was the dominant cost when
    # converting DEM meshes with hundreds of thousands of triangles).
    crs = CRS.from_user_input(source_crs)
    if crs.is_geographic:
        return None
    return Transformer.from_crs(crs, CRS.from_epsg(4326), always_xy=True)


def to_lon_lat(x: float, y: float, source_crs: str, transformer: Transformer | None) -> tuple[float, float]:
    if transformer is not None:
        return transformer.transform(x, y)
    if abs(x) <= 90 and abs(y) > 90:  # authority axis order: lat, lon
        return y, x
    return x, y


def project_to_world(lon: float, lat: float, origin: Sequence[float]) -> tuple[float, float]:
    lat0, lon0 = origin
    return ((lon - lon0) * 111320.0 * math.cos(math.radians(lat0)), -(lat - lat0) * 111320.0)


def transform_ring(ring, source_crs: str, origin, vertical_datum: float = 0.0, include_y: bool = True):
    transformer = make_transformer(source_crs)
    result = []
    for x, y, z in ring:
        lon, lat = to_lon_lat(x, y, source_crs, transformer)
        wx, wz = project_to_world(lon, lat, origin)
        result.append([wx, z - vertical_datum, wz] if include_y else [wx, wz])
    return result


def iter_features(files: Sequence[Path], feature_names: set[str], fallback_crs: str) -> Iterator[tuple[ET.Element, str, Path]]:
    for file in files:
        context = ET.iterparse(file, events=("start", "end"))
        file_srs = fallback_crs
        for event, element in context:
            if event == "start" and element.attrib.get("srsName"):
                file_srs = epsg_from_srs(element.attrib.get("srsName"), file_srs)
            if event == "end" and local_name(element.tag) in feature_names:
                yield element, detect_srs(element, file_srs), file
                element.clear()


def road_half_width(route: dict, s: float) -> float:
    for section in route.get("roadSections") or []:
        if float(section.get("from", 0)) <= s < float(section.get("to", float("inf"))):
            left = float(section.get("wL", max(4.0, float(section.get("lanes", 2)) * 1.6 + 0.8)))
            right = float(section.get("wR", left))
            return max(left, right) + (0.5 if section.get("sidewalk") == "none" else 3.2)
    return 7.2


def candidate_ground_rings(building: ET.Element):
    ground = []
    for child in building.iter():
        if local_name(child.tag) == "GroundSurface":
            ground.extend(exterior_rings(child))
    if ground:
        return ground
    polygons = exterior_rings(building)
    if not polygons:
        return []
    stats = []
    for ring in polygons:
        zs = [p[2] for p in ring]
        stats.append((sum(zs) / len(zs), max(zs) - min(zs), ring))
    min_z = min(item[0] for item in stats)
    return [ring for avg, spread, ring in stats if avg <= min_z + 1.0 and spread <= 1.5] or [min(stats)[2]]


def semantic_attributes(feature: ET.Element) -> dict:
    attrs = {}
    for key, names in {
        "name": {"name"}, "class": {"class"}, "function": {"function"}, "usage": {"usage"},
        "storeysAboveGround": {"storeysAboveGround"}, "storeysBelowGround": {"storeysBelowGround"},
        "measuredHeight": {"measuredHeight"},
    }.items():
        values = all_text(feature, names)
        if values:
            attrs[key] = values[0] if len(values) == 1 else values
    return attrs


def geometry_height(feature: ET.Element):
    zs = [p[2] for p in all_positions(feature)]
    return (min(zs), max(zs), max(zs) - min(zs)) if zs else (None, None, None)


def material_for(attrs: dict, height: float) -> str:
    name = str(attrs.get("name", ""))
    usage = str(attrs.get("usage", ""))
    if any(token in name for token in ("寺", "神社", "塔")):
        return "heritage"
    if any(code in usage for code in ("411", "412", "413", "414", "415")):
        return "commercial"
    if height >= 24:
        return "highrise"
    if height >= 12:
        return "midrise"
    return "lowrise"


def polygon_kind(attrs: dict) -> str:
    text = " ".join(str(value) for value in attrs.values())
    if "1020" in text or "交差" in text:
        return "intersection"
    if "1010" in text or "車線" in text:
        return "lane"
    if "2000" in text or "歩道" in text:
        return "sidewalk"
    if "3000" in text or "島" in text:
        return "island"
    return "road"


def sample_route_profile(route: dict, terrain_index: PointElevationIndex | None, datum: float, step: float, window: int):
    if terrain_index is None:
        return {"version": 1, "sampleStepMeters": step, "samples": []}
    route_index = RouteIndex(route["path"])
    samples = []
    s = 0.0
    while s <= route_index.length + 0.001:
        # Find point by walking the route segments.
        point = route["path"][-1]
        for ax, az, bx, bz, start_s, length in route_index.segments:
            if s <= start_s + length or length == 0:
                t = 0 if length == 0 else max(0.0, min(1.0, (s - start_s) / length))
                point = [ax + (bx - ax) * t, az + (bz - az) * t]
                break
        elevation = terrain_index.nearest(point[0], point[1])
        samples.append([round(s, 2), round((elevation - datum) if elevation is not None else 0.0, 3)])
        s += step
    if samples and samples[-1][0] < route_index.length:
        samples.append([round(route_index.length, 2), samples[-1][1]])
    if window > 1 and samples:
        half = window // 2
        smoothed = []
        for index, sample in enumerate(samples):
            values = [samples[j][1] for j in range(max(0, index - half), min(len(samples), index + half + 1))]
            smoothed.append([sample[0], round(sum(values) / len(values), 3)])
        samples = smoothed
    return {"version": 1, "sampleStepMeters": step, "verticalDatum": round(datum, 3), "samples": samples}


_DEM_WORKER: dict = {}


def _init_dem_worker(route_path, origin, fallback_crs, terrain_corridor, max_edge):
    _DEM_WORKER["route_index"] = RouteIndex(route_path)
    _DEM_WORKER["origin"] = origin
    _DEM_WORKER["fallback_crs"] = fallback_crs
    _DEM_WORKER["terrain_corridor"] = terrain_corridor
    _DEM_WORKER["max_edge"] = max_edge


def _process_dem_file(file: Path):
    route_index = _DEM_WORKER["route_index"]
    origin = _DEM_WORKER["origin"]
    fallback_crs = _DEM_WORKER["fallback_crs"]
    terrain_corridor = _DEM_WORKER["terrain_corridor"]
    max_edge = _DEM_WORKER["max_edge"]
    terrain_raw = []
    stats = defaultdict(int)
    for triangle, source_crs, source_file in iter_features([file], {"Triangle"}, fallback_crs):
        rings = exterior_rings(triangle)
        if not rings:
            continue
        for ring in rings:
            transformed = transform_ring(ring, source_crs, origin, 0.0, True)
            transformed = clean_ring_3d(transformed)
            if len(transformed) < 3:
                continue
            # Triangle elements can repeat the closing point; retain the first three unique vertices.
            vertices = transformed[:3]
            center = [sum(p[0] for p in vertices) / 3, sum(p[2] for p in vertices) / 3]
            route_distance = route_index.nearest(center).distance
            if route_distance > terrain_corridor:
                continue
            edges = [math.dist([vertices[i][0], vertices[i][2]], [vertices[(i + 1) % 3][0], vertices[(i + 1) % 3][2]]) for i in range(3)]
            if max(edges) > max_edge:
                stats["terrainLargeTriangleRejected"] += 1
                continue
            terrain_raw.append((vertices, source_file.name, source_crs, route_distance))
    return terrain_raw, dict(stats)


_BLDG_WORKER: dict = {}


def _init_bldg_worker(route, origin, fallback_crs, corridor, cfg_plateau, terrain_points_relative, datum, route_buildings):
    _BLDG_WORKER["route_index"] = RouteIndex(route["path"])
    _BLDG_WORKER["route"] = route
    _BLDG_WORKER["origin"] = origin
    _BLDG_WORKER["fallback_crs"] = fallback_crs
    _BLDG_WORKER["corridor"] = corridor
    _BLDG_WORKER["cfg_plateau"] = cfg_plateau
    _BLDG_WORKER["terrain_index"] = PointElevationIndex(terrain_points_relative) if terrain_points_relative else None
    _BLDG_WORKER["datum"] = datum
    _BLDG_WORKER["osm_index"] = OsmBuildingIndex(route_buildings or [])


def _process_bldg_file(file: Path):
    route_index = _BLDG_WORKER["route_index"]
    route = _BLDG_WORKER["route"]
    origin = _BLDG_WORKER["origin"]
    fallback_crs = _BLDG_WORKER["fallback_crs"]
    corridor = _BLDG_WORKER["corridor"]
    cfg_plateau = _BLDG_WORKER["cfg_plateau"]
    terrain_index = _BLDG_WORKER["terrain_index"]
    datum = _BLDG_WORKER["datum"]
    osm_index = _BLDG_WORKER["osm_index"]
    stats = defaultdict(int)
    crs_seen = set()
    results = []
    for feature, source_crs, source_file in iter_features([file], {"Building", "BuildingPart"}, fallback_crs):
        crs_seen.add(source_crs)
        attrs = semantic_attributes(feature)
        min_z, max_z, derived_height = geometry_height(feature)
        measured = numeric_text(feature, {"measuredHeight"})
        height = measured if measured is not None else derived_height
        height = max(float(cfg_plateau["minimumHeightMeters"]), min(float(cfg_plateau["maximumHeightMeters"]), height or 6.0))
        gml_id = feature.attrib.get(GML_ID) or f"anonymous-building-{len(results)+1}"
        ground_rings = candidate_ground_rings(feature)
        raw_shell_rings = exterior_rings(feature)
        if min_z is not None:
            # A handful of PLATEAU LOD2 features carry stray polygons far outside
            # their own measuredHeight envelope (e.g. an unrelated fixture folded
            # into the same <Building>). Such a ring renders as a flat plate tens
            # of meters above the real roof, visible as debris hanging in the sky.
            # measuredHeight (when present) is authoritative, so drop any raw
            # shell ring whose points fall outside [min_z, min_z + height] with a
            # generous tolerance for eaves/parapets rather than trusting every
            # polygon the feature happens to contain.
            tolerance = 3.0
            plausible_top = min_z + height + tolerance
            plausible_bottom = min_z - tolerance
            raw_shell_rings = [
                ring for ring in raw_shell_rings
                if all(plausible_bottom <= p[2] <= plausible_top for p in ring)
            ]
        shell_surfaces = [
            clean_ring_3d(transform_ring(shell, source_crs, origin, datum, True))
            for shell in raw_shell_rings
        ]
        shell_surfaces = [surface for surface in shell_surfaces if len(surface) >= 3]
        for part_index, ring in enumerate(ground_rings):
            footprint = clean_ring_2d(transform_ring(ring, source_crs, origin, datum, False))
            if len(footprint) < 3 or abs(signed_area(footprint)) < 1.0:
                continue
            center = polygon_centroid(footprint)
            nearest = route_index.nearest(center)
            if nearest.distance > corridor:
                continue
            max_overlap = 0.0
            for vertex in footprint:
                vn = route_index.nearest(vertex)
                max_overlap = max(max_overlap, road_half_width(route, vn.s) + 0.4 - vn.distance)
            setback = 0.0
            if max_overlap > 0:
                if max_overlap > float(cfg_plateau["maximumRoadSetbackMeters"]):
                    stats["buildingRoadOverlapRejected"] += 1
                    continue
                dx, dz = center[0] - nearest.x, center[1] - nearest.z
                norm = math.hypot(dx, dz)
                if norm > 1e-6:
                    setback = max_overlap
                    footprint = [[x + dx / norm * setback, z + dz / norm * setback] for x, z in footprint]
                    center = polygon_centroid(footprint)
            key = (round(center[0], 1), round(center[1], 1), round(abs(signed_area(footprint)), 1), round(height, 1))
            osm_match = osm_index.nearest(center)
            if osm_match:
                stats["buildingOsmMatched"] += 1
            feature_id = gml_id if len(ground_rings) == 1 else f"{gml_id}#part-{part_index+1}"
            terrain_base = terrain_index.nearest(center[0], center[1]) if terrain_index else 0.0
            source_base = (min_z - datum) if min_z is not None else terrain_base
            # Some low-LOD PLATEAU layers are encoded at z=0 even when the DEM uses
            # an absolute elevation datum. Snap clearly inconsistent bases to DEM.
            shell_for_feature = shell_surfaces if len(ground_rings) == 1 else []
            if terrain_base is not None and (source_base < terrain_base - 10 or source_base > terrain_base + 80):
                delta = terrain_base - source_base
                source_base = terrain_base
                shell_for_feature = [[[x, y + delta, z] for x, y, z in surface] for surface in shell_for_feature]
                stats["buildingBaseSnappedToTerrain"] += 1
            if shell_for_feature:
                stats["buildingDetailedShell"] += 1
            results.append((key, {
                "id": feature_id,
                "footprint": footprint,
                "height": round(height, 2),
                "baseHeight": round(source_base or 0.0, 3),
                "surfaces": shell_for_feature,
                "material": material_for(attrs, height),
                "center": [round(center[0], 3), round(center[1], 3)],
                "routeDistanceMeters": round(nearest.distance, 2),
                "setbackMeters": round(setback, 2),
                "attributes": attrs,
                "osmMatch": osm_match,
                "source": {"provider": "PLATEAU", "gmlId": gml_id, "file": source_file.name, "crs": source_crs},
            }))
    return results, dict(stats), crs_seen


def convert(args) -> dict:
    cfg = read_json(args.config)
    route = read_json(args.route)
    origin = route["projOrigin"]
    route_index = RouteIndex(route["path"])
    fallback_crs = cfg["plateau"].get("sourceCrsFallback", "EPSG:6697")
    corridor = float(cfg["plateau"]["corridorMeters"])
    terrain_corridor = float(cfg["plateau"].get("terrainCorridorMeters", corridor))
    max_edge = float(cfg["plateau"].get("maximumTerrainTriangleEdgeMeters", 220))
    max_triangles = int(cfg["plateau"].get("maximumTerrainTriangles", 70000))
    max_polygons = int(cfg["plateau"].get("maximumSurfacePolygonsPerLayer", 60000))
    files_by_type = {kind: sorted((args.input_dir / kind).glob("*.gml")) for kind in cfg["plateau"]["featureTypes"]}
    stats = defaultdict(int)
    crs_values = set()

    # Terrain first, because its elevation at the route start becomes the local y=0 datum.
    # Each DEM file is an independent CityGML document, so file-level parsing and
    # corridor filtering parallelizes across processes with no shared mutable state.
    dem_files = files_by_type.get("dem", [])
    terrain_raw = []
    if dem_files:
        dem_workers = min(len(dem_files), os.cpu_count() or 1)
        with ProcessPoolExecutor(
            max_workers=dem_workers,
            initializer=_init_dem_worker,
            initargs=(route["path"], origin, fallback_crs, terrain_corridor, max_edge),
        ) as pool:
            futures = [pool.submit(_process_dem_file, file) for file in dem_files]
            for _ in tqdm(as_completed(futures), total=len(futures), desc="dem", unit="file"):
                pass
            # Merge in the original sorted file order (not completion order) so
            # terrain decimation below stays deterministic across runs.
            for future in futures:
                partial_raw, partial_stats = future.result()
                terrain_raw.extend(partial_raw)
                for key, value in partial_stats.items():
                    stats[key] += value
    for _vertices, _file_name, source_crs, _route_distance in terrain_raw:
        crs_values.add(source_crs)
    terrain_points = [vertex for vertices, _file_name, _crs, _dist in terrain_raw for vertex in vertices]
    terrain_index_abs = PointElevationIndex(terrain_points) if terrain_points else None
    start_x, start_z = route["path"][0]
    datum = terrain_index_abs.nearest(start_x, start_z) if terrain_index_abs else None
    if datum is None:
        datum = statistics.median([p[1] for p in terrain_points]) if terrain_points else 0.0
    if len(terrain_raw) > max_triangles:
        # Keep the triangles closest to the route and drop the farthest ones first.
        # A naive stride (every Nth triangle in file-scan order) thins near-route
        # ground and distant off-corridor hillsides equally, which leaves sparse,
        # disconnected patches of elevated terrain that look like floating debris.
        # Distance-first decimation keeps the immediate roadside dense and only
        # trims decorative terrain far from the route.
        terrain_raw.sort(key=lambda item: item[3])
        stats["terrainDecimationDroppedFar"] = len(terrain_raw) - max_triangles
        terrain_raw = terrain_raw[:max_triangles]
    terrain_triangles = [
        [[round(p[0], 3), round(p[1] - datum, 3), round(p[2], 3)] for p in triangle]
        for triangle, _file, _crs, _dist in terrain_raw
    ]
    terrain_points_relative = [[p[0], p[1] - datum, p[2]] for p in terrain_points]
    terrain_index = PointElevationIndex(terrain_points_relative) if terrain_points_relative else None

    # Building parsing/geometry work is independent per file; only the final
    # cross-file dedup (seen_buildings) has to stay sequential, so it runs here
    # in the main process over results gathered in the original file order.
    bldg_files = files_by_type.get("bldg", [])
    buildings = []
    seen_buildings = set()
    if bldg_files:
        bldg_workers = min(len(bldg_files), os.cpu_count() or 1)
        with ProcessPoolExecutor(
            max_workers=bldg_workers,
            initializer=_init_bldg_worker,
            initargs=(route, origin, fallback_crs, corridor, cfg["plateau"], terrain_points_relative, datum, route.get("buildings")),
        ) as pool:
            futures = [pool.submit(_process_bldg_file, file) for file in bldg_files]
            for _ in tqdm(as_completed(futures), total=len(futures), desc="bldg", unit="file"):
                pass
            # Merge in the original sorted file order so the seen_buildings dedup
            # resolves duplicate footprints the same way every run.
            for future in futures:
                file_results, partial_stats, partial_crs = future.result()
                for key, value in partial_stats.items():
                    stats[key] += value
                crs_values.update(partial_crs)
                for key, building in file_results:
                    if key in seen_buildings:
                        continue
                    seen_buildings.add(key)
                    buildings.append(building)

    def convert_surface_layer(kind: str, feature_names: set[str], semantic_areas: bool = False):
        surfaces = []
        kind_files = files_by_type.get(kind, [])
        for file in tqdm(kind_files, desc=kind, unit="file"):
            for feature, source_crs, _file in iter_features([file], feature_names, fallback_crs):
                crs_values.add(source_crs)
                parent_attrs = semantic_attributes(feature)
                containers = []
                if semantic_areas:
                    containers = [child for child in feature.iter() if local_name(child.tag) in {"TrafficArea", "AuxiliaryTrafficArea"}]
                if not containers:
                    containers = [feature]
                gml_id = feature.attrib.get(GML_ID) or f"anonymous-{kind}-{len(surfaces)+1}"
                for container_index, container in enumerate(containers):
                    attrs = {**parent_attrs, **semantic_attributes(container)}
                    for ring_index, ring in enumerate(exterior_rings(container)):
                        polygon = clean_ring_3d(transform_ring(ring, source_crs, origin, datum, True))
                        if len(polygon) < 3:
                            continue
                        center2d = polygon_centroid([[p[0], p[2]] for p in polygon])
                        if route_index.nearest(center2d).distance > corridor:
                            continue
                        terrain_y = terrain_index.nearest(center2d[0], center2d[1]) if terrain_index else None
                        average_y = sum(p[1] for p in polygon) / len(polygon)
                        # PLATEAU road LOD0/1 can be stored at z=0. In that case use DEM
                        # elevation so the visual road does not sink below the terrain.
                        if terrain_y is not None and (average_y < terrain_y - 10 or average_y > terrain_y + 120):
                            delta = terrain_y - average_y
                            polygon = [[x, y + delta, z] for x, y, z in polygon]
                            stats[f"{kind}SurfaceSnappedToTerrain"] += 1
                        surfaces.append({
                            "id": f"{gml_id}#{container_index+1}-{ring_index+1}",
                            "kind": polygon_kind(attrs) if kind == "tran" else kind,
                            "polygon": polygon,
                            "attributes": attrs,
                            "source": {"provider": "PLATEAU", "gmlId": gml_id, "file": file.name, "crs": source_crs},
                        })
                        if len(surfaces) >= max_polygons:
                            stats[f"{kind}PolygonLimitReached"] += 1
                            return surfaces
        return surfaces

    transportation = convert_surface_layer("tran", {"Road"}, True)
    bridges = convert_surface_layer("brid", {"Bridge", "BridgePart"})
    water = convert_surface_layer("wtr", {"WaterBody"})
    vegetation = convert_surface_layer("veg", {"PlantCover", "SolitaryVegetationObject"})

    furniture = []
    for file in tqdm(files_by_type.get("frn", []), desc="frn", unit="file"):
        for feature, source_crs, _file in iter_features([file], {"CityFurniture"}, fallback_crs):
            crs_values.add(source_crs)
            coords = all_positions(feature)
            if not coords:
                continue
            transformed = transform_ring(coords, source_crs, origin, datum, True)
            center = [sum(p[0] for p in transformed) / len(transformed), sum(p[1] for p in transformed) / len(transformed), sum(p[2] for p in transformed) / len(transformed)]
            if route_index.nearest([center[0], center[2]]).distance > corridor:
                continue
            attrs = semantic_attributes(feature)
            text = " ".join(str(v) for v in attrs.values()).lower()
            visual_kind = "traffic-signal" if any(token in text for token in ("信号", "traffic signal", "signal")) else "city-furniture"
            furniture.append({
                "id": feature.attrib.get(GML_ID) or f"anonymous-frn-{len(furniture)+1}",
                "kind": visual_kind,
                "position": [round(center[0], 3), round(center[1], 3), round(center[2], 3)],
                "attributes": attrs,
                "source": {"provider": "PLATEAU", "file": file.name, "crs": source_crs},
            })

    generated_at = datetime.now(timezone.utc).isoformat()
    source_common = {
        "provider": "Project PLATEAU", "municipalityCode": cfg["plateau"]["municipalityCode"],
        "municipality": cfg["plateau"]["municipality"], "year": cfg["plateau"]["year"],
        "format": "CityGML", "downloadUrl": cfg["plateau"]["downloadUrl"], "crs": sorted(crs_values),
        "verticalDatumSourceMeters": round(datum, 3),
    }
    materials = {
        "lowrise": "#cfc8ba", "midrise": "#b9bec1", "highrise": "#aab3b9",
        "commercial": "#b9afa2", "heritage": "#87634a",
    }
    outputs = {
        "buildings": {"version": 2, "generatedAt": generated_at, "source": source_common, "materials": materials, "features": buildings},
        "transportation": {"version": 2, "generatedAt": generated_at, "source": source_common, "features": transportation},
        "terrain": {"version": 2, "generatedAt": generated_at, "source": source_common, "triangles": terrain_triangles},
        "bridges": {"version": 2, "generatedAt": generated_at, "source": source_common, "features": bridges},
        "furniture": {"version": 2, "generatedAt": generated_at, "source": source_common, "features": furniture},
        "water": {"version": 2, "generatedAt": generated_at, "source": source_common, "features": water},
        "vegetation": {"version": 2, "generatedAt": generated_at, "source": source_common, "features": vegetation},
    }
    route_profile = sample_route_profile(
        route, terrain_index, 0.0,
        float(cfg["plateau"].get("routeElevationSampleMeters", 10)),
        int(cfg["plateau"].get("routeElevationSmoothingWindow", 7)),
    )
    route_profile.update({"generatedAt": generated_at, "source": "PLATEAU dem", "verticalDatumSourceMeters": round(datum, 3)})
    osm_network = {
        "version": 2, "generatedAt": generated_at,
        "source": {"provider": "OpenStreetMap", "relationId": cfg["osm"]["relationId"], "license": cfg["osm"]["license"], "generatedAt": route.get("generatedAt")},
        "authority": cfg["osm"]["authority"],
        "route": {"name": route.get("routeName"), "path": route.get("path", []), "roadSections": route.get("roadSections", [])},
        "stops": route.get("stops", []), "intersections": route.get("intersections", []),
        "turnIntersections": route.get("turnIntersections", []), "signals": route.get("signals", []),
        "extraRoads": route.get("extraRoads", []), "speedZones": route.get("speedZones", []),
    }

    output_paths = {
        "buildings": args.buildings, "transportation": args.transportation, "terrain": args.terrain,
        "bridges": args.bridges, "furniture": args.furniture, "water": args.water,
        "vegetation": args.vegetation,
    }
    for key, output in outputs.items():
        write_json(output_paths[key], output)
    write_json(args.route_elevation, route_profile)
    write_json(args.osm_network, osm_network)

    counts = {key: len(value.get("features", value.get("triangles", []))) for key, value in outputs.items()}
    manifest = {
        "version": 3, "generatedAt": generated_at, "status": "ready",
        "sources": {"osm": osm_network["source"], "plateau": source_common},
        "policies": cfg["integration"],
        "layers": [
            {"id": "terrain", "provider": "plateau", "url": "/world/generated/plateau-terrain.json", "featureCount": counts["terrain"]},
            {"id": "transportation", "provider": "plateau", "url": "/world/generated/plateau-transportation.json", "featureCount": counts["transportation"]},
            {"id": "water", "provider": "plateau", "url": "/world/generated/plateau-water.json", "featureCount": counts["water"]},
            {"id": "vegetation", "provider": "plateau", "url": "/world/generated/plateau-vegetation.json", "featureCount": counts["vegetation"]},
            {"id": "bridges", "provider": "plateau", "url": "/world/generated/plateau-bridges.json", "featureCount": counts["bridges"]},
            {"id": "buildings", "provider": "plateau", "url": "/world/generated/plateau-buildings.json", "featureCount": counts["buildings"], "fallback": "route18.json buildings"},
            {"id": "furniture", "provider": "plateau", "url": "/world/generated/plateau-furniture.json", "featureCount": counts["furniture"], "semanticFallback": "OSM signals"},
            {"id": "osm-network", "provider": "osm", "url": "/world/generated/osm-network.json"},
        ],
    }
    write_json(args.manifest, manifest)
    report = {
        "generatedAt": generated_at, "sourceCrs": sorted(crs_values), "verticalDatumSourceMeters": round(datum, 3),
        "inputFiles": {kind: len(files) for kind, files in files_by_type.items()}, "counts": counts,
        "routeElevationSamples": len(route_profile["samples"]), "stats": dict(sorted(stats.items())),
    }
    write_json(args.report, report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--route", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--buildings", type=Path, required=True)
    parser.add_argument("--transportation", type=Path, required=True)
    parser.add_argument("--terrain", type=Path, required=True)
    parser.add_argument("--bridges", type=Path, required=True)
    parser.add_argument("--furniture", type=Path, required=True)
    parser.add_argument("--water", type=Path, required=True)
    parser.add_argument("--vegetation", type=Path, required=True)
    parser.add_argument("--osm-network", type=Path, required=True)
    parser.add_argument("--route-elevation", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = convert(args)
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
