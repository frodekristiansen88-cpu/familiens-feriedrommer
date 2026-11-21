#!/usr/bin/env python3
"""Download selected public GPX tracks and store compact Leaflet polylines.

Tracks are unverified travel inspiration, not navigation advice.
Existing routes are retained if a download fails.
"""
import json
import math
import os
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

DATA = Path("places.json")
SOURCES = {
    "Leutascher Geisterklamm": [
        "https://tirol.mapservices.eu/nefos_app/api/gpx/imx_xR7kIE5LaSrqNTM6/de/generate/32118038",
    ],
    "Congost de Mont-rebei og Pasarelas de Montfalcó": [
        "https://turismoribagorza.org/en/wp-content/Uploads/2025/06/natural_path_footbridges.gpx",
    ],
}
# Each source must contain a GPS track, not arbitrary coordinates or a straight line.
MAX_BYTES = 6_000_000
MAX_RADIUS_KM = 35
MAX_POINTS = 1000


def km(a, b):
    la1, lo1 = a
    la2, lo2 = b
    r1, r2 = math.radians(la1), math.radians(la2)
    dlat = r2-r1
    dlon = math.radians(lo2-lo1)
    h = math.sin(dlat/2)**2 + math.cos(r1)*math.cos(r2)*math.sin(dlon/2)**2
    return 6371 * 2 * math.asin(min(1, math.sqrt(h)))


def download(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "FamiliensFeriedrommer/1.0 (personal noncommercial trail map)",
        "Accept": "application/gpx+xml, application/xml, text/xml, */*",
    })
    with urllib.request.urlopen(req, timeout=25) as response:
        if response.status != 200:
            raise ValueError("HTTP " + str(response.status))
        data = response.read(MAX_BYTES+1)
        if len(data) > MAX_BYTES:
            raise ValueError("GPX exceeds file size limit")
        return data


def parse_gpx(data):
    root = ET.fromstring(data)
    if not root.tag.lower().endswith("gpx"):
        raise ValueError("Not a GPX file")
    tracks = []
    for segment in root.iter():
        if segment.tag.split("}")[-1] not in ("trkseg", "rte"):
            continue
        points = []
        for pt in segment:
            if pt.tag.split("}")[-1] not in ("trkpt", "rtept"):
                continue
            try:
                a, b = float(pt.attrib["lat"]), float(pt.attrib["lon"])
            except (ValueError, KeyError):
                continue
            if -90 <= a <= 90 and -180 <= b <= 180:
                points.append([a, b])
        if len(points) > 1:
            tracks.append(points)
    if not tracks:
        raise ValueError("No track points")
    return max(tracks, key=len)


def simplify(points):
    if len(points) <= MAX_POINTS:
        return points
    stride = math.ceil((len(points)-1)/(MAX_POINTS-1))
    selected = points[::stride]
    if selected[-1] != points[-1]:
        selected.append(points[-1])
    return selected


def main():
    places = json.loads(DATA.read_text(encoding="utf-8"))
    updated = 0
    for place in places:
        candidates = SOURCES.get(place["name"], [])
        if not candidates:
            continue
        if len((place.get("route") or {}).get("coordinates", [])) >= 2:
            print("ALREADY IMPORTED:", place["name"])
            continue
        for url in candidates:
            try:
                points = parse_gpx(download(url))
                reference = (float(place["lat"]), float(place["lng"]))
                nearest = min(km(reference, p) for p in points)
                if nearest > MAX_RADIUS_KM:
                    raise ValueError(f"Trail is {nearest:.1f} km away from place pin")
                length = sum(km(a, b) for a, b in zip(points, points[1:]))
                if not (0.15 <= length <= 85):
                    raise ValueError(f"Suspicious trail length: {length:.1f} km")
                points = simplify(points)
                place["route"] = {
                    "coordinates": points,
                    "distanceKm": round(length, 1),
                    "confidence": "Foreløpig GPX – ikke kvalitetssikret",
                }
                place["routeUrl"] = url
                place["routeNote"] = ((place.get("routeNote") or "") +
                    " GPS-sporet er hentet automatisk og er ikke kontrollert mot gjeldende tilkomst, stengninger eller skilting.").strip()
                updated += 1
                print(f"IMPORTED {place['name']}: {len(points)} points, {length:.1f} km")
                break
            except Exception as exc:
                print(f"FAILED {place['name']}: {url}: {exc}")
    if updated:
        DATA.write_text(json.dumps(places, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(f"GPX imports: {updated}")


if __name__ == "__main__":
    main()
