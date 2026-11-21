#!/usr/bin/env python3
"""Synchronize the Todoist Feriedrømmer section to places.json."""
import json, os, re, time, unicodedata, urllib.parse, urllib.request
from pathlib import Path
from import_gpx import download, parse_gpx, simplify, km
from fetch_images import get_json as wiki_json, photo_data

PROJECT = "6hvJmr29qp2mmf5F"
SECTION = "6j44Hq4M8CFrjj8F"
EXTRA_PROJECT = "6j4679mJqhXv7C5W"
PATH = Path("places.json")
CATEGORIES = ("Fotturer", "Natur og utsikt", "Byer og kultur", "Aktiviteter og opplevelser", "Strender og badeplasser", "Mat og drikke")
TOKEN = os.environ["TODOIST_API_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "User-Agent": "FamiliensFeriedrommer/1.0"}
URL_RE = re.compile(r"https?://[^\s)<>]+")
def get_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or HEADERS)
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)
def tasks_in_project(project):
    cursor = None
    seen = set()
    while True:
        params = {"project_id": project, "limit": "100"}
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
def tasks():
    # Finish fetching both sources before writing places.json.
    yield from tasks_in_project(PROJECT)
    yield from tasks_in_project(EXTRA_PROJECT)

def clean_name(content):
    s = re.sub(r"^[^\w]+", "", content, flags=re.UNICODE).strip()
    if content.startswith(("📷","🎢","🏞️","🏛️","🏖️","🥾","🍽️")):
        return s
    return re.split(r"\s+[–—-]\s+", s, 1)[0].strip()
def extract(desc, label):
    """Read either **Label:** value or **Label**: value."""
    for line in desc.splitlines():
        stripped = line.strip()
        for prefix in (f"**{label}:**", f"**{label}**:"):
            if stripped.casefold().startswith(prefix.casefold()):
                return stripped[len(prefix):].strip()
    return ""

def extract_block(desc, label):
    lines = desc.splitlines()
    for i, line in enumerate(lines):
        stripped = line.strip()
        for prefix in (f"**{label}:**", f"**{label}**:"):
            if stripped.casefold().startswith(prefix.casefold()):
                rest = [stripped[len(prefix):].strip()]
                for next_line in lines[i+1:]:
                    if re.match(r"^\*\*[^\n]+(?:\*\*:|:\*\*)", next_line.strip()):
                        break
                    rest.append(next_line)
                return "\n".join(rest).strip()
    return ""

def first_link(desc, label):
    line = extract(desc, label)
    match = URL_RE.search(line)
    return match.group(0).rstrip(".,") if match else ""
def coordinates_from_description(desc):
    line = extract(desc, "Koordinater") or extract(desc, "Coordinates")
    match = re.search(r"(-?\d{1,2}\.\d+)\s*[,;]\s*(-?\d{1,3}\.\d+)", line)
    if match:
        lat, lng = map(float, match.groups())
        if -90 <= lat <= 90 and -180 <= lng <= 180:
            return lat, lng
    return None

COUNTRY_CODES = {"Spania":"es","Tsjekkia":"cz","Polen":"pl","Frankrike":"fr","Sveits":"ch","Island":"is","Østerrike":"at","Portugal":"pt","Sverige":"se","Italia":"it"}
def geocode(query, country=""):
    """Resolve the explicitly supplied place, within its destination country."""
    params = {"q":query, "format":"json", "limit":3}
    if COUNTRY_CODES.get(country):
        params["countrycodes"] = COUNTRY_CODES[country]
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent":"FamiliensFeriedrommer/1.0 (personal family travel map)"})
    try:
        with urllib.request.urlopen(req, timeout=22) as response:
            result = json.load(response)
        for item in result:
            typ = item.get("type", "")
            # Named attractions or towns are acceptable; coordinates merely locate the destination.
            if typ in ("country", "state", "province"):
                continue
            return float(item["lat"]), float(item["lon"])
    except Exception as exc:
        print(f"Geocoding failed for {query!r}: {exc}")
    return None

# Madeira PR tracks: catalogue GPX data is derived from OSM (ODbL).
# Validate geography, length and continuity; do not invent missing tracks.
def madeira_track(desc, name):
    if "Madeira" not in [x.strip() for x in extract(desc, "Emneknagger").split(",")]:
        return None
    url = first_link(desc, "GPX")
    is_pr = bool(re.fullmatch(r"https://hikemadeira\.com/tracks/pr-\d+(?:-\d+)?\.gpx",url))
    is_tripmadeira = bool(re.fullmatch(r"https://www\.tripmadeira\.com/v1/en/resources/gps/[a-z0-9]+\.gpx",url))
    if not (is_pr or is_tripmadeira):
        return None
    try:
        points = parse_gpx(download(url))
        if len(points)<5 or any(not (32.60 <= p[0] <= 32.91 and -17.28 <= p[1] <= -16.65) for p in points):
            raise ValueError("Track outside Madeira or insufficient points")
        distances = [km(a,b) for a,b in zip(points,points[1:])]
        length = sum(distances)
        if is_pr:
            expected = float(extract(desc,"PR-lengde"))
        else:
            match = re.search(r"Lengde:\s*(?:ca\.\s*)?(\d+(?:[,.]\d+)?)\s*km",desc)
            if not match: raise ValueError("Missing distance for source check")
            expected = float(match.group(1).replace(",","."))
        if not expected*.65 <= length <= expected*(2.35 if is_pr else 1.35) or max(distances) > .65:
            raise ValueError(f"Track length or continuity suspicious: {length:.2f} km vs official {expected:.2f} km")
        print("MADEIRA GPX:",name,len(points),round(length,2))
        return {"coordinates":simplify(points),"distanceKm":round(length,1),"confidence":("OSM-basert GPX" if is_pr else "GPX fra Tripmadeira")+" – ikke kvalitetssikret for navigasjon"}, points[0]
    except Exception as exc:
        print("MADEIRA GPX FAILED:",name,exc)
        return None

# Restrict Commons search to route-specific name; never invent images or licence.
def madeira_photo(name):
    match = re.match(r"^PR \d+(?:\.\d+)? (.+)",name)
    title = match.group(1) if match else re.sub(r"\s*\([^)]*\)","",name).strip()
    short = re.sub(r"^(?:Vereda (?:do|da|dos|das) |Levada (?:do|da|das|dos) |Caminho (?:Real )?(?:do|da) )","",title,flags=re.I)
    if short in ("Ilha","Monte","Moinho","Rei","Norte","Risco","Barreiro","Burro"):
        terms = [title]
    else: terms = [title,short]
    if not match:
        photo_terms = {
            "Levada Nova og Levada do Moinho": ["Levada Nova", "Levada do Moinho"],
            "Vereda do Larano og Boca do Risco": ["Vereda do Larano", "Boca do Risco"],
            "Levada do Caniçal og Pico do Facho": ["Levada do Caniçal", "Pico do Facho"],
            "Levada do Seixal og Chão da Ribeira": ["Chão da Ribeira"],
            "Vereda da Trompica og Chão dos Terreiros": ["Chão dos Terreiros", "Vereda da Trompica"],
            "Vereda da Rocha do Navio": ["Rocha do Navio"],
        }
        terms = photo_terms.get(name,[title])
    for term in dict.fromkeys(terms):
        try:
            result=wiki_json("commons.wikimedia.org",{
                "action":"query","list":"search","srnamespace":"6",
                "srsearch":'intitle:"'+term+'" Madeira',"srlimit":"8","format":"json"
            })
            for candidate in result.get("query",{}).get("search",[]):
                filename=candidate.get("title","").removeprefix("File:")
                if not filename.lower().endswith((".jpg",".jpeg",".png",".webp")): continue
                if any(bad in filename.casefold() for bad in ("transformer","substation","power pole","electricity pole","coat of arms","locator map","logo")): continue
                # Search results must match the specific geographic subject in filename.
                if term.casefold() not in filename.replace("_"," ").casefold(): continue
                photo=photo_data(filename)
                if photo:
                    print("MADEIRA PHOTO:",name,filename)
                    return photo
        except Exception as exc:
            print("MADEIRA PHOTO FAILED:",name,str(exc)[:150])
        time.sleep(.4)
    print("NO ROUTE-SPECIFIC LICENSED PHOTO:",name)
    return None

# Accept named mapped coastal features only, never a municipality or hotel
# centroid as a verified beach. Missing pins remain available in Todoist.
def norm_name(value):
    value=unicodedata.normalize("NFKD",value.casefold())
    return " ".join(re.findall(r"[a-z0-9]+","".join(c for c in value if not unicodedata.combining(c))))

def beach_geocode(name, desc):
    main = re.sub(r"\s*\([^)]*\)","",name).strip()
    aliases=[main]+re.findall(r"\(([^)]+)\)",name)
    aliases=[a for a in aliases if len(a)>4 and a.casefold() not in ("badeplass","badebukt","badeanlegg")]
    loc=extract(desc,"Kartlokasjon")
    variants=[loc,main+", Madeira, Portugal"]
    variants.extend(a+", Madeira, Portugal" for a in aliases[1:])
    for query in dict.fromkeys(q for q in variants if q):
        params={"q":query,"format":"jsonv2","limit":8,"countrycodes":"pt","namedetails":"1","viewbox":"-17.30,32.90,-16.63,32.60","bounded":"1"}
        try:
            req=urllib.request.Request("https://nominatim.openstreetmap.org/search?"+urllib.parse.urlencode(params),headers={"User-Agent":"FamiliensFeriedrommer/1.0 (personal family travel map)","Accept":"application/json"})
            with urllib.request.urlopen(req,timeout=18) as response:
                results=json.load(response)
            for item in results:
                lat,lng=float(item["lat"]),float(item["lon"])
                if not (32.60<=lat<=32.90 and -17.30<=lng<=-16.63): continue
                cat=item.get("category",item.get("class",""));typ=item.get("type","")
                if cat in ("boundary","place","highway","railway","building","office","shop") or typ in ("hotel","restaurant","viewpoint","peak","village","town","city","hamlet","locality","cable_car","station"): continue
                names=[item.get("name",""),*item.get("namedetails",{}).values()]
                keys={norm_name(x) for x in names if isinstance(x,str)}
                akeys={norm_name(a) for a in aliases}
                # Accept exact feature name, including official multilingual alternate names.
                if not (keys&akeys): continue
                print("BEACH GEO:",name,lat,lng)
                return lat,lng
        except Exception as exc:
            print("BEACH GEOCODE FAILED:",name,str(exc)[:120])
        finally:
            time.sleep(1.2)
    print("BEACH PIN NOT VERIFIED:",name)
    return None

old = json.loads(PATH.read_text(encoding="utf-8")) if PATH.exists() else []
by_id = {str(p.get("id")):p for p in old if p.get("id")}
by_name = {p.get("name","").casefold():p for p in old}
new = []
requested_stops = {}
for t in tasks():
    if (str(t.get("section_id")) != SECTION and str(t.get("project_id")) != EXTRA_PROJECT) or t.get("is_completed") or t.get("is_uncompletable") or "Familiens feriekart" in t.get("content", ""):
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
    is_madeira_hike = "Madeira" in [x.strip() for x in extract(desc,"Emneknagger").split(",")] and category == "Fotturer"
    is_madeira = "Madeira" in [x.strip() for x in extract(desc,"Emneknagger").split(",")]
    is_madeira_pr = is_madeira_hike and bool(re.match(r"^PR \d",name))
    is_madeira_beach = category=="Strender og badeplasser" and "Madeira" in [x.strip() for x in extract(desc,"Emneknagger").split(",")]
    imported = None
    if is_madeira_hike and not len((previous.get("route") or {}).get("coordinates",[]))>=2:
        imported = madeira_track(desc,name)
        if imported:
            coords = imported[1]
    if not coords and previous.get("lat") is not None and previous.get("lng") is not None:
        coords = previous["lat"], previous["lng"]
    if not coords and is_madeira_beach:
        coords=beach_geocode(name,desc)
        if not coords:
            continue
    if not coords:
        # Try the specific map location before the task name; never invent coordinates.
        location = extract(desc, "Kartlokasjon") or extract(desc, "Sted")
        candidates = [location, name + (", Madeira, Portugal" if is_madeira else ", " + country if country else "")]
        if is_madeira and category in ("Natur og utsikt", "Byer og kultur", "Aktiviteter og opplevelser", "Mat og drikke"):
            specific = re.sub(r"\s*\([^)]*\)","",name).strip()
            # For a landmark, do not use a general town as a fallback; queries must
            # identify the attraction. Guided activities intentionally use an area.
            if "Guidet aktivitet" not in extract(desc,"Emneknagger"):
                candidates = [location, specific + ", Madeira, Portugal"]
        for query in dict.fromkeys(q for q in candidates if q):
            coords = geocode(query, country)
            time.sleep(1.15)
            if coords and is_madeira and not (32.60 <= coords[0] <= 32.91 and -17.28 <= coords[1] <= -16.65):
                coords = None
            if coords:
                break
    if not coords:
        print(f"SKIPPED: No verified coordinates for {name}")
        continue
    summary = extract(desc,"Kort fortalt") or extract(desc,"Opplevelse") or previous.get("description","")
    image = first_link(desc,"Bilde") or previous.get("image","")
    detail_text = extract_block(desc,"Utfyllende informasjon") or previous.get("details","")
    explicit_route_type = extract(desc,"Turtype")
    route_type = explicit_route_type or previous.get("routeType", "")
    if route_type not in ("Enkeltsted", "Dagstur", "Flerdagstur"):
        route_type = "Dagstur" if category == "Fotturer" else "Enkeltsted"
    route_url = first_link(desc,"GPX") or previous.get("routeUrl","")
    route_source = first_link(desc,"Rutekilde") or previous.get("routeSource","")
    own_tags = [x.strip() for x in extract(desc, "Emneknagger").split(",") if x.strip()]
    # Admission tags are authoritative from Todoist. Do not retain stale fee labels.
    # Future entries: use Gratis or Avgiftsbelagt for non-obvious admission; omit
    # obvious cities, beaches, shops/restaurants etc. Optional parking/transport
    # is not an admission fee. If uncertain, use Sjekk avgift rather than guess.
    fee_tags = {"Gratis", "Avgiftsbelagt", "Sjekk avgift", "Reservasjon påkrevd"}
    tags = sorted((set(previous.get("tags", [])) - fee_tags) | set(own_tags) | {label for label in labels if label not in CATEGORIES})
    admission = extract(desc, "Adgang og avgift")
    if admission:
        admission_text = "ADGANG OG AVGIFT\n" + admission
        # Strip a prior generated admission section when falling back to old details.
        detail_text = detail_text.split("\n\nADGANG OG AVGIFT\n", 1)[0].strip()
        detail_text = (detail_text + "\n\n" + admission_text).strip()
    # Route geometry is curated separately. Never infer a walking trail from straight-line coordinates.
    route = imported[0] if imported else previous.get("route",{})
    route_note = previous.get("routeNote","")
    if is_madeira_pr:
        route_note = "Kartbasert GPX © OpenStreetMap contributors (ODbL), via Hike Madeira. Kan omfatte stengte etapper. Sjekk IFCN før turen; følg lokale skilt. https://www.openstreetmap.org/copyright"
    if is_madeira_hike and not is_madeira_pr:
        route_note = "Uklassifisert sti. Kontroller lokal adgang, stengninger og eventuelle avgiftsbelagte PR-delstrekninger. GPX-kilde: Tripmadeira eller oppgitt rutekilde; ikke kvalitetssikret for navigasjon."
    if is_madeira_hike and not (route or {}).get("coordinates"):
        route_note += " Kartnålen viser omtrentlig område; GPS-spor er ikke importert."
    photo = madeira_photo(name) if is_madeira and not image else None
    if photo: image=photo["image"]
    photo_fields = photo or previous
    stops = previous.get("stops",[])
    requested = extract(desc, "Kartstopp")
    if requested:
        requested_stops[str(t["id"])] = [part.strip() for part in requested.split("|") if part.strip()]
    new.append({"id":str(t["id"]),"name":name,"country":country,"category":category,"lat":coords[0],"lng":coords[1],"description":summary,"video":video,"todoist":"https://app.todoist.com/app/task/"+str(t["id"]),"info":info,"details":detail_text,"image":image,"imageCredit":photo_fields.get("imageCredit",""),"imageSource":photo_fields.get("imageSource",""),"imageLicense":photo_fields.get("imageLicense",""),"routeType":route_type,"routeUrl":route_url,"routeSource":route_source,"tags":tags,"routeNote":route_note,"route":route,"stops":stops})

# Link ordered day-trip stops to the individual mapped attractions. If any
# coordinates are missing, keep the verified stops and don't draw a fake path.
by_new_name = {p["name"].casefold(): p for p in new}
for place in new:
    requested = requested_stops.get(place["id"])
    if not requested:
        continue
    stops = [{"name":"Start", "lat":place["lat"], "lng":place["lng"], "note":"Utgangspunkt i Schöneberg"}]
    for name in requested:
        stop = by_new_name.get(name.casefold())
        if stop:
            stops.append({"name":stop["name"], "lat":stop["lat"], "lng":stop["lng"], "note":stop["description"]})
        else:
            print("ROUTE STOP NOT MAPPED:", name)
    place["stops"] = stops
    place["route"] = {}
    place["routeNote"] = "Nummererte stopp; se navigasjonslenkene i beskrivelsen for gangrute. Ingen GPS-linje uten verifisert gangnett."
    if len(stops) != len(requested) + 1:
        continue
    try:
        positions = ";".join(f'{s["lng"]},{s["lat"]}' for s in stops)
        url = "https://routing.openstreetmap.de/routed-foot/route/v1/driving/" + positions + "?overview=full&geometries=geojson&steps=false"
        result = get_json(url, {"User-Agent":"FamiliensFeriedrommer/1.0 (personal travel map)"})
        route = result["routes"][0]
        pts = [[float(y),float(x)] for x,y in route["geometry"]["coordinates"]]
        distance = float(route["distance"])/1000
        if result.get("code") != "Ok" or not (2 < distance < 12) or len(pts)<10:
            raise ValueError("Unexpected walking route")
        if any(not (52.45<y<52.57 and 13.29<x<13.46) for y,x in pts):
            raise ValueError("Outside central Berlin")
        place["route"] = {"coordinates":pts,"distanceKm":round(distance,1),"confidence":"OSM fotgjengerruting – kontroller lokal adkomst"}
        place["routeNote"] = "Gangrute fra OpenStreetMap (FOSSGIS/OSRM), © OpenStreetMap contributors. Følger de nummererte stoppene; eventuell retur og alternative restauranter fremgår av beskrivelsen."
        print("WALKING ROUTE:",place["name"],round(distance,1))
    except Exception as exc:
        print("WALKING ROUTE UNAVAILABLE:",place["name"],str(exc)[:150])

if not new:
    raise SystemExit("No mapped places; preserving existing data.")
PATH.write_text(json.dumps(new,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(f"Updated {len(new)} places.")
