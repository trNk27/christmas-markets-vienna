# Vienna Christmas Market Tracker

A small static website for scoping out Vienna's Christmas markets before you head out: where each market is, whether it's open now (or at the date and time you plan to go), photos, the vibe, what's on sale, a typical-busyness estimate and a stylised 3D sketch of the layout.

All opening-hours logic runs in **Europe/Vienna** time, whatever the visitor's time zone.

## Run / host

There's no build step and nothing to install, and no CDNs are used: everything is plain files with classic `<script>` tags.

- **Open directly:** double-click `index.html`. It works over `file://`; the map tiles still need an internet connection.
- **Local server:** `python3 -m http.server 8000` in the repo root, then open http://localhost:8000/.
- **Any static host:** upload the folder as is. For **GitHub Pages**, choose "Deploy from a branch" with the repository root. All paths are relative, so serving from a sub-path such as `/christmas-markets-vienna/` works.

`diorama-demo.html` is the 3D showcase page and renders every market's model side by side.

## Files

```
index.html            app shell (list, map, detail panel, lightbox)
css/styles.css        all styling; evening (dark) + daytime (light) themes via CSS custom properties
js/status.js          window.MarketStatus — pure opening-hours logic (also loads in Node for tests)
js/crowd.js           window.Crowd — typical busyness estimate + hook for future live data
js/diorama.js         window.Diorama — procedural three.js dioramas
js/app.js             UI: map, list, filters, "When are you going?" planner, detail panel, gallery
data/markets.js       the market data: window.MARKETS = [ … ]
img/markets/<id>/     photos: N.jpg (long edge ≤ 1280px) and N-thumb.jpg (480px wide)
vendor/               Leaflet 1.9.4, three.js r170 (+ OrbitControls), Fraunces font
diorama-demo.html     3D showcase of all models
```

`vendor/three.min.js` (~700 KB) and `js/diorama.js` are not in `index.html`. `app.js` injects them the first time a detail panel's 3D section scrolls into view.

Deep links: `#/market/<id>` opens a market's detail panel, e.g. `index.html#/market/rathausplatz`.

## Updating a market (`data/markets.js`)

Each entry in `window.MARKETS` is one market object. Key fields:

| field | meaning |
|---|---|
| `id` | fixed slug, used in URLs and image paths (`[a-z0-9-]`) |
| `name`, `nameEn` | official/common (German) name and a short English gloss |
| `location`, `district`, `address`, `lat`, `lng` | place label (text before the first comma, " / " or "(" becomes the short map/card label), Bezirk number, street address, coordinates of the market centre |
| `season` | `{ start, end }` — inclusive ISO dates (`YYYY-MM-DD`) |
| `hours` | opening-hour rules (see below) |
| `hoursNote`, `hoursConfidence` | optional short note; `"confirmed"` or `"likely"` (shows "Hours not officially confirmed — check the website") |
| `website`, `transit`, `sources`, `verified` | official site, list of transit hints, source URLs, date last checked |
| `size`, `stalls`, `popularity`, `priceLevel` | `small`/`medium`/`large`, approx. stall count or `null`, 1–5 (drives the crowd estimate), 1–3 (€–€€€) |
| `summary`, `bestFor`, `vibe`, `sells`, `specials` | text and keyword lists; cards show the first `vibe` words, the detail panel shows all of them |
| `tags` | filter tags, only from: `ice-skating kids crafts foodie art quiet romantic views alternative organic after-christmas new-year rides live-music imperial` |
| `photos` | 4–5 entries `{ src, thumb, w, h, caption, author, license, licenseUrl, sourceUrl }`; the first one is the card thumbnail |
| `diorama` | `{ landmark, layout, stalls, features }` for the 3D model (see the header of `js/diorama.js`) |

**Hour rules.** Rules are evaluated in Vienna local time, and the **first matching rule wins**. A rule matches a day by exactly one of the following:

- `"dates": ["2026-12-24", …]`
- `"from"` / `"to"`: an inclusive date range
- `"days": [0…6]`, where 0 = Sunday

It then has either `"open"` + `"close"` (`"HH:MM"`, 24 h) or `"closed": true`. An optional `"label"` (e.g. "Christmas Eve") appears in the hours table.

- Put special dates first, then ranges, then weekday rules.
- Days outside `season` are always closed; a day in season that matches no rule is closed.
- A `close` earlier than `open` means after midnight (e.g. `"12:00"`–`"02:00"`). The market then shows as open into the next morning.

```js
"hours": [
  { "dates": ["2026-12-24"], "open": "10:00", "close": "16:00", "label": "Christmas Eve" },
  { "from": "2026-12-25", "to": "2027-01-06", "open": "10:00", "close": "19:00" },
  { "days": [0, 1, 2, 3, 4, 5, 6], "open": "10:00", "close": "21:00" }
]
```

Quick check in Node: `node -e "global.window={}; require('./data/markets.js'); const S=require('./js/status.js'); console.log(S.statusAt(window.MARKETS[0], new Date()))"`.

## Live crowd data (later)

The site has no live crowd data today. `Crowd.estimate()` gives a typical-busyness guess from popularity, time of day and day of week, and the UI always labels it "Typical for this time — estimate, not live data".

To add a real source, register a provider after `js/crowd.js` has loaded, for example in a small extra script placed before `js/app.js`:

```js
Crowd.registerProvider(async function (market) {
  const r = await fetch('https://example.org/crowds/' + market.id);   // your API
  if (!r.ok) return null;                                               // null → fall back to estimate
  const d = await r.json();
  return { level: d.level /* 0 quiet … 4 packed */, updatedAt: d.timestamp };
});
```

When the provider returns data and the planner is set to **Now**, the detail panel shows it with a **Live** badge. Otherwise it falls back to the labelled estimate.

## Credits & licences

- **Map:** tiles and map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL), shown with the attribution on the map. Heavy traffic should move to a tile provider of your own, per the OSM tile usage policy.
- **Leaflet** 1.9.4: BSD-2-Clause (`vendor/leaflet/LICENSE`).
- **three.js** r170: MIT (`vendor/three.LICENSE`).
- **Fraunces** font: SIL Open Font License 1.1 (`vendor/fonts/LICENSE`).
- **Photos:** Wikimedia Commons, each under its own licence (CC BY / CC BY-SA / CC0 / public domain). Author, licence and source link for every photo are stored in `data/markets.js` and shown in the photo viewer.

## Caveat

Opening dates and hours were researched on **2026-11-14** for the 2026/27 season. Markets marked `"hoursConfidence": "likely"` couldn't be confirmed from an official source. Hours change, so always check the official website before travelling.
