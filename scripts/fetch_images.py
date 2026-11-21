#!/usr/bin/env python3
"""Fill missing map photos from Wikimedia Commons with verifiable free licences.

Uses explicit Wikipedia article targets to avoid mixing up similarly named places.
No photo is published unless its Commons licence and attribution can be verified.
Does not replace existing curated images.
Missing or uncertain licences are skipped rather than guessed.
"""
import html
import json
import re
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

PATH = Path("places.json")
ARTICLES = {
    "Uracher Wasserfall": [("de", "Uracher Wasserfall")],
    "Görlitz": [("de", "Görlitz")],
    "Bad Wimpfen": [("de", "Bad Wimpfen")],
    "Kelheim": [("de", "Donaudurchbruch bei Weltenburg"), ("de", "Kelheim")],
    "Spreewald": [("de", "Spreewald")],
    "Dahner Felsenland": [("de", "Dahner Felsenland"), ("de", "Dahn")],
    "Upper Danube Valley": [("de", "Naturpark Obere Donau"), ("de", "Beuron")],
    "Amrum": [("de", "Amrum")],
    "Schwerin": [("de", "Schweriner Schloss"), ("de", "Schwerin")],
    "Quedlinburg": [("de", "Quedlinburg")],
    "Cochem": [("de", "Cochem")],
    "Goslar": [("de", "Goslar")],
    "Lichtenstein Castle": [("en", "Lichtenstein Castle (Württemberg)"), ("de", "Schloss Lichtenstein (Württemberg)")],
    "Kriebstein Castle": [("de", "Burg Kriebstein")],
    "Wetzlar": [("de", "Wetzlar")],
    "Mespelbrunn Castle": [("de", "Schloss Mespelbrunn")],
    "Pico do Arieiro": [("en", "Pico do Arieiro"), ("pt", "Pico do Areeiro")],
    "Congost de Mont-rebei og Pasarelas de Montfalcó": [("ca", "Congost de Mont-rebei"), ("es", "Congost de Mont-rebei")],
    "Castillo de Colomares": [("es", "Castillo de Colomares")],
    "Liechtensteinklamm": [("de", "Liechtensteinklamm")],
}
CURATED_FILES = {
    "Upper Danube Valley": "FFH-Gebiet Oberes Donautal zwischen Beuron und Sigmaringen.jpg",
    "Uracher Wasserfall": "Wasserfall in Bad Urach.jpg",
    "Lichtenstein Castle": "Honau Schloss Lichtenstein 2024 01.jpg",
    "Kriebstein Castle": "20230917 2 Burg Kriebstein.jpg",
    "Castillo de Colomares": "Castillo de Colomares, Benalmádena, Málaga, España, 2023-05-18, DD 75.jpg",
    "Dahner Felsenland": "Dahner Felsenpfad 2025.jpg",
    "Liechtensteinklamm": "Lichtensteinklamm.jpg",
}
USER_AGENT = "FamiliensFeriedrommer/1.0 (https://github.com/frodekristiansen88-cpu/familiens-feriedrommer)"
BAD_NAME = ("coat_of_arms", "wappen", "flagge", "flag_of", "logo", "locator", "location_map", "lage", "karte", "map_", "plan_", "icon")
BAD_LICENSE = ("nc", "nd")

class Plain(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
    def handle_data(self, data):
        self.parts.append(data)

def plaintext(value):
    p = Plain()
    p.feed(html.unescape(value or ""))
    return re.sub(r"\s+", " ", "".join(p.parts)).strip()

def get_json(host, params):
    url = "https://" + host + "/w/api.php?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=12) as resp:
        if resp.status != 200:
            raise RuntimeError("HTTP " + str(resp.status))
        return json.load(resp)

def page_image(lang, title):
    data = get_json(lang + ".wikipedia.org", {
        "action":"query","titles":title,"prop":"pageimages",
        "pithumbsize":"960","format":"json","redirects":"1",
    })
    for page in data.get("query", {}).get("pages", {}).values():
        filename = page.get("pageimage", "")
        if filename and not any(s in filename.lower() for s in BAD_NAME):
            return filename
    return None

def photo_data(filename):
    title = "File:" + filename
    data = get_json("commons.wikimedia.org", {
        "action":"query","titles":title,"prop":"imageinfo",
        "iiprop":"url|extmetadata","iiurlwidth":"960","format":"json",
    })
    pages = list(data.get("query", {}).get("pages", {}).values())
    if not pages or "missing" in pages[0]:
        return None
    details = (pages[0].get("imageinfo") or [None])[0]
    if not details:
        return None
    meta = details.get("extmetadata", {})
    lic = plaintext(meta.get("LicenseShortName", {}).get("value", ""))
    normalized = lic.casefold()
    allowed = ("cc by" in normalized or "cc0" in normalized or
               "public domain" in normalized or normalized == "pd")
    if not allowed or any("cc " + k in normalized for k in BAD_LICENSE):
        return None
    artist = plaintext(meta.get("Artist", {}).get("value", ""))
    if not artist:
        artist = plaintext(meta.get("Credit", {}).get("value", ""))
    if not artist:
        return None
    artist = artist[:135]
    source = "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"), safe=":()")
    image = details.get("thumburl") or details.get("url")
    license_url = meta.get("LicenseUrl", {}).get("value", "")
    if not image or not license_url:
        return None
    return {
        "image": image,
        "imageCredit": artist + " · " + lic,
        "imageSource": source,
        "imageLicense": license_url,
    }

def main():
    places = json.loads(PATH.read_text(encoding="utf-8"))
    updated = 0
    for place in places:
        if place.get("image") or place["name"] not in ARTICLES:
            continue
        if place["name"] in CURATED_FILES:
            try:
                photo = photo_data(CURATED_FILES[place["name"]])
                if photo:
                    place.update(photo)
                    updated += 1
                    print("CURATED PHOTO:", place["name"])
                    continue
            except Exception as exc:
                print("CURATED PHOTO FAILED:", place["name"], str(exc)[:110])
        for lang, title in ARTICLES[place["name"]]:
            try:
                filename = page_image(lang, title)
                if not filename:
                    continue
                photo = photo_data(filename)
                if photo:
                    place.update(photo)
                    updated += 1
                    print("PHOTO:", place["name"], filename, photo["imageCredit"][:70])
                    break
            except Exception as exc:
                print("PHOTO FAILED:", place["name"], str(exc)[:110])
            finally:
                time.sleep(.3)
        if not place.get("image"):
            print("NO LICENSED PHOTO:", place["name"])
    if updated:
        PATH.write_text(json.dumps(places, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print("New Wikimedia images:", updated)

if __name__ == "__main__":
    main()
