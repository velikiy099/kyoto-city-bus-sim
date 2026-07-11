#!/usr/bin/env python3
"""Remove incomplete PLATEAU surface shells from generated building data.

Kyoto's selected PLATEAU tiles mainly expose a GroundSurface polygon for each
building. Such a polygon is useful as a footprint, but it is not a complete
3-D shell. Keeping it in ``surfaces`` made the renderer draw a floating plate
instead of extruding ``footprint`` by ``height``.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def valid_detailed_shell(building: dict) -> bool:
    surfaces = building.get("surfaces") or []
    if len(surfaces) < 4:
        return False
    y_values = [float(point[1]) for surface in surfaces for point in surface if len(point) >= 3]
    if len(y_values) < 12:
        return False
    low, high = min(y_values), max(y_values)
    expected = max(1.5, float(building.get("height") or 6.0) * 0.3)
    if high - low < expected:
        return False
    vertical = 0
    roof = 0
    for surface in surfaces:
        if len(surface) < 3:
            continue
        ys = [float(point[1]) for point in surface]
        spread = max(ys) - min(ys)
        if spread >= expected * 0.65:
            vertical += 1
        elif spread < 1.2 and sum(ys) / len(ys) > low + expected * 0.6:
            roof += 1
    return vertical >= 2 and roof >= 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path, nargs="?", default=Path("public/world/generated/plateau-buildings.json"))
    args = parser.parse_args()
    document = json.loads(args.path.read_text(encoding="utf-8"))
    retained = 0
    removed = 0
    for building in document.get("features", []):
        if valid_detailed_shell(building):
            retained += 1
        else:
            if building.get("surfaces"):
                removed += 1
            building["surfaces"] = []
        # OSM building matching was diagnostic only. Visible geometry is PLATEAU.
        building.pop("osmMatch", None)
    document.setdefault("statistics", {})["completeDetailedShells"] = retained
    document["statistics"]["incompleteShellsConvertedToExtrusion"] = removed
    args.path.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"features": len(document.get("features", [])), "retainedDetailedShells": retained, "extruded": removed}, ensure_ascii=False))


if __name__ == "__main__":
    main()
