#!/usr/bin/env python3
"""Synchronize the Todoist Feriedrømmer section to places.json."""
import json, os, re, time, urllib.parse, urllib.request
from pathlib import Path

PROJECT = "6hvJmr29qp2mmf5F"
SECTION = "6j44Hq4M8CFrjj8F"
PATH = Path("places.json")
CATEGORIES = ("Fotturer", "Natur og utsikt", "Byer og kultur", "Aktiviteter og opplevelser")
TOKEN = os.environ["TODOIST_API_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "User-Agent": "FamiliensFeriedrommer/1.0"}
URL_RE = re.compile(r"https?://[^\s)<>]+")
def get_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or HEADERS)
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)
def tasks():
    cursor = None
    seen = set()
    while True:
        params = {"project_id": PROJECT, "limit": "100"}
        if cursor: params["cursor"] = cursor
        payload = get_json("https://api.todoist.com/api/v1/tasks?" + urllib.parse.urlencode(params))
        if isinstance(payload, list):
            yield from payload
            break
        for task in payload.get("results", []):
            if task.get("id") not in seen:
                seen.add(task.get("id"))
                yield task
        cursor = payload.get("next_cursor")
        if not cursor: break
def clean_name(content):
    s = re.sub(r"^[^\w]+", "", content, flags=re.UNICODE).strip()
    return re.split(r"\s+[–—-]\s+", s, 1)[0].strip()
def extract(desc, label):
    match = re.search(r"(?im)^\*\*" + re.escape(label) + r"\*\*:\s*(.+)$", desc)
    return match.group(1).strip() if match else ""
def extract_block(desc, label):
    """Return multiline body between **Label:** and next **Label:**."""
    lines = desc.splitlines()
    for i, line in enumerate(lines):
        if re.match(r"^\\*\\*" + re.escape(label) + r"\\*\\*:", line, re.I):
            first = re.sub(r"^\\*\\*" + re.escape(label) + r"\\*\\*:[ \\t]*", "", line, flags=re.I).strip()
            rest = []
            for next_line in lines[i+1:]:
                if re.match(r"^\\*\\*[^\\n]+\\*\\*:", next_line):
                    break
                rest.append(next_line)
            return "\\n".join(([first] if first else []) + rest).strip()
    return ""

def first_link(desc, label):
    line = extract(desc, label)
    match = URL_RE.search(line)
    return match.group(0).rstrip(".,") if match else ""
def coordinates_from_description(desc):
    match = re.search(r"(?im)^(?:\*\*)?(?:Koordinater|Coordinates)(?:\*\*)?:\s*(-?\d{1,2}\.\d+)\s*[,;]\s*(-?\d{1,3}\.\d+)", desc)
    if match:
        lat, lng = map(float, match.groups())
        if -90 <= lat <= 90 and -180 <= lng <= 180: return lat, lng
    return None
def geocode(query):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q":query, "format":"json", "limit":1})
    req = urllib.request.Request(url, headers={"User-Agent":"FamiliensFeriedrommer/1.0 (GitHub Pages family map)"})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            result = json.load(response)
        if result: return float(result[0]["lat"]), float(result[0]["lon"])
    except Exception as exc:
        print(f"Geocoding failed for {query!r}: {exc}")
    return None

old = json.loads(PATH.read_text(encoding="utf-8")) if PATH.exists() else []
by_id = {str(p.get("id")):p for p in old if p.get("id")}
by_name = {p.get("name","").casefold():p for p in old}
new = []
for t in tasks():
    if str(t.get("section_id")) != SECTION or t.get("is_completed") or t.get("is_uncompletable") or "Familiens feriekart" in t.get("content", ""):
        continue
    name = clean_name(t.get("content",""))
    desc = t.get("description","")
    previous = by_id.get(str(t["id"])) or by_name.get(name.casefold(), {})
    labels = t.get("labels", [])
    category = next((c for c in CATEGORIES if c in labels), previous.get("category","Natur og utsikt"))
    country = extract(desc, "Land") or previous.get("country","") or extract(desc, "Sted")
    video = first_link(desc,"Inspirasjonsvideo") or first_link(desc,"Video som inspirerte") or first_link(desc,"Video") or previous.get("video","")
    info = first_link(desc,"Offisiell side / billetter") or first_link(desc,"Mer informasjon") or previous.get("info","")
    coords = coordinates_from_description(desc)
    if not coords and previous.get("lat") is not None and previous.get("lng") is not None:
        coords = previous["lat"], previous["lng"]
    if not coords:
        # New places are geocoded once; ambiguous results should be checked manually.
        coords = geocode(name + (", " + country if country else ""))
        time.sleep(1.1)
    if not coords:
        print(f"SKIPPED: No verified coordinates for {name}")
        continue
    summary = extract(desc,"Kort fortalt") or extract(desc,"Opplevelse") or previous.get("description","")
    image = first_link(desc,"Bilde") or previous.get("image","")
    detail_text = extract_block(desc,"Utfyllende informasjon") or previous.get("details","")
    route_type = extract(desc,"Turtype") or previous.get("routeType", "Enkeltsted")
    if route_type not in ("Enkeltsted", "Dagstur", "Flerdagstur"):
        route_type = "Enkeltsted"
    if route_type == "Enkeltsted" and category == "Fotturer":
        route_type = "Dagstur"
    route_url = first_link(desc,"GPX") or previous.get("routeUrl","")
    route_source = first_link(desc,"Rutekilde") or previous.get("routeSource","")
    tags = sorted(set(previous.get("tags", [])) | {label for label in labels if label not in CATEGORIES})
    # Route geometry is curated separately. Never infer a walking trail from straight-line coordinates.
    route = previous.get("route",{})
    stops = previous.get("stops",[])
    new.append({"id":str(t["id"]),"name":name,"country":country,"category":category,"lat":coords[0],"lng":coords[1],"description":summary,"video":video,"todoist":"https://app.todoist.com/app/task/"+str(t["id"]),"info":info,"details":detail_text,"image":image,"imageCredit":previous.get("imageCredit",""),"imageSource":previous.get("imageSource",""),"imageLicense":previous.get("imageLicense",""),"routeType":route_type,"routeUrl":route_url,"routeSource":route_source,"tags":tags,"routeNote":previous.get("routeNote",""),"route":route,"stops":stops})
if not new:
    raise SystemExit("No mapped places; preserving existing data.")
PATH.write_text(json.dumps(new,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(f"Updated {len(new)} places.")
