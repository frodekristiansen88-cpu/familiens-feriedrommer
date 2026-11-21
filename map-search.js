/* Stedsnavnsøk er uavhengig av feriedrømmene i Todoist.
   Komoot Photon/OSM: søk kun på Enter/knapp, ingen automatisk forespørsel per tastetrykk. */
(() => {
  "use strict";
  function setupPlaceSearch() {
    const map = window.ferieMap;
    if (!map || !window.L) return;
    const resultLayer = L.layerGroup().addTo(map);
    const cache = new Map();
    let lastRequestAt = 0;
    let busy = false;
    const kindNames = {
      city: "By", town: "By", village: "Landsby", hamlet: "Grend",
      country: "Land", state: "Region", county: "Område",
      river: "Elv", stream: "Bekk", lake: "Innsjø", water: "Vann",
      mountain: "Fjell", peak: "Fjelltopp", island: "Øy",
      reservoir: "Innsjø", canal: "Kanal"
    };
    const control = L.control({ position: "topright" });
    control.onAdd = function () {
      const box = L.DomUtil.create("div", "map-place-control leaflet-bar");
      box.setAttribute("role", "search");
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      box.addEventListener("keydown", e => e.stopPropagation());

      const title = document.createElement("label");
      title.htmlFor = "map-place-input";
      title.className = "map-place-title";
      title.textContent = "🔎 Søk i kartet";

      const form = document.createElement("form");
      form.className = "map-place-form";
      const input = document.createElement("input");
      input.id = "map-place-input";
      input.type = "search";
      input.placeholder = "By, elv, innsjø, land …";
      input.autocomplete = "off";
      input.setAttribute("aria-label", "Søk etter geografisk sted på kartet");
      input.minLength = 2;
      input.maxLength = 120;

      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "map-place-submit";
      submit.textContent = "Finn";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "map-place-clear";
      clear.title = "Fjern karttreff";
      clear.setAttribute("aria-label", "Fjern søk og kartmarkør");
      clear.textContent = "×";
      form.append(input, submit, clear);

      const status = document.createElement("div");
      status.className = "map-place-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      const results = document.createElement("div");
      results.className = "map-place-results";

      const credit = document.createElement("div");
      credit.className = "map-place-credit";
      credit.append(document.createTextNode("Søk via Photon · "));
      const attr = document.createElement("a");
      attr.href = "https://www.openstreetmap.org/copyright";
      attr.target = "_blank";
      attr.rel = "noopener noreferrer";
      attr.textContent = "© OpenStreetMap";
      credit.append(attr);

      function labelFor(feature) {
        const p = feature.properties || {};
        const main = p.name || p.street || "Kartsted";
        const context = [...new Set([p.city, p.county, p.state, p.country].filter(v => v && v !== main))];
        const kind = kindNames[p.osm_value] || p.osm_value || "Sted";
        return { main, sub: [kind, ...context].join(" · ") };
      }
      function focusPlace(feature, selectedButton) {
        const xy = feature.geometry && feature.geometry.coordinates;
        if (!Array.isArray(xy) || xy.length < 2) return;
        const lon = Number(xy[0]), lat = Number(xy[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const p = feature.properties || {};
        const info = labelFor(feature);
        resultLayer.clearLayers();
        const pin = L.marker([lat, lon]).addTo(resultLayer);
        const popup = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = info.main;
        const secondary = document.createElement("div");
        secondary.textContent = info.sub;
        popup.append(strong, secondary);
        pin.bindPopup(popup);

        // Photon-boksen bruker [vest, sør, øst, nord], mens Leaflet bruker [lat, lng].
        const ext = Array.isArray(p.extent) ? p.extent.map(Number) : null;
        if (ext && ext.length === 4 && ext.every(Number.isFinite) &&
            ext[0] < ext[2] && ext[1] < ext[3]) {
          map.fitBounds([[ext[1], ext[0]], [ext[3], ext[2]]], {
            padding: [35, 35], maxZoom: 13
          });
        } else {
          const z = p.osm_value === "country" ? 6 :
                    p.osm_value === "river" ? 9 :
                    p.osm_value === "lake" ? 11 : 12;
          map.setView([lat, lon], z);
        }
        pin.openPopup();
        results.querySelectorAll(".map-place-result").forEach(btn => {
          const active = btn === selectedButton;
          btn.classList.toggle("active", active);
          btn.setAttribute("aria-pressed", String(active));
        });
      }
      function showMatches(features) {
        results.replaceChildren();
        if (!features.length) {
          status.textContent = "Ingen treff. Prøv et mer presist stedsnavn, gjerne med land.";
          return;
        }
        status.textContent = features.length + " karttreff – velg et annet treff ved behov";
        let firstButton = null;
        for (const f of features) {
          const label = labelFor(f);
          const button = document.createElement("button");
          button.type = "button";
          button.className = "map-place-result";
          button.setAttribute("aria-pressed", "false");
          const heading = document.createElement("strong");
          heading.textContent = label.main;
          const sub = document.createElement("span");
          sub.textContent = label.sub;
          button.append(heading, sub);
          button.addEventListener("click", () => focusPlace(f, button));
          results.append(button);
          if (!firstButton) firstButton = button;
        }
        // Den beste matchen velges med én gang, men de andre blir stående.
        focusPlace(features[0], firstButton);
      }
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const query = input.value.trim();
        if (busy) return;
        if (query.length < 2) {
          status.textContent = "Skriv minst to tegn.";
          return;
        }
        const key = query.toLocaleLowerCase("nb-NO");
        if (cache.has(key)) {
          showMatches(cache.get(key));
          return;
        }
        busy = true;
        submit.disabled = true;
        submit.textContent = "…";
        status.textContent = "Søker etter geografiske steder …";
        results.replaceChildren();
        try {
          const remaining = 1100 - (Date.now() - lastRequestAt);
          if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
          lastRequestAt = Date.now();
          const url = "https://photon.komoot.io/api/?q=" +
            encodeURIComponent(query) + "&limit=6&lang=en";
          const response = await fetch(url, { headers: { Accept: "application/json" } });
          if (!response.ok) throw new Error("Karttjenesten svarte med HTTP " + response.status);
          const data = await response.json();
          const features = Array.isArray(data.features) ? data.features.filter(f =>
            Array.isArray(f.geometry && f.geometry.coordinates) &&
            f.geometry.coordinates.length >= 2) : [];
          cache.set(key, features);
          if (cache.size > 25) cache.delete(cache.keys().next().value);
          showMatches(features);
        } catch (err) {
          status.textContent = "Karttjenesten er utilgjengelig akkurat nå. Prøv igjen senere.";
        } finally {
          busy = false;
          submit.disabled = false;
          submit.textContent = "Finn";
        }
      });
      clear.addEventListener("click", () => {
        input.value = "";
        results.replaceChildren();
        status.textContent = "";
        resultLayer.clearLayers();
        input.focus();
        // Rører verken zoom, feriedrømfilter eller importerte GPS-spor.
      });
      box.append(title, form, status, results, credit);
      return box;
    };
    control.addTo(map);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupPlaceSearch, { once: true });
  } else {
    setupPlaceSearch();
  }
})();
