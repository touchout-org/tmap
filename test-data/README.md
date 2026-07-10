# Local test data cache

Cached real Nominatim + Overpass responses for a handful of addresses used
repeatedly during local development, so testing doesn't hammer the public
Overpass/Nominatim instances (which rate-limit and time out under heavy
same-session use).

## Using the cache while testing locally

In `app.js`, set:

```js
const USE_LOCAL_TEST_DATA_CACHE = true;
```

Then search for one of the addresses listed in `LOCAL_TEST_DATA_FILES`
(same file, right below the flag) -- matched by exact text, case/whitespace
insensitive. Both geocoding and the street fetch are served from the cached
JSON file instead of the network. A loud red banner appears on the page
whenever the flag is on, as a reminder.

**Always set the flag back to `false` before committing/deploying/pushing.**
The banner is there specifically so this is hard to miss in a screenshot.

## Adding a new cached address

1. Add a `{ query, file }` entry to the `cases` list in `fetch-test-data.mjs`.
2. Run `node test-data/fetch-test-data.mjs` (Node 18+, needs network access --
   this is the one time this data-gathering step actually hits the real
   Nominatim/Overpass endpoints).
3. Add a matching entry to `LOCAL_TEST_DATA_FILES` in `app.js`, mapping the
   same query string (lowercased) to the new file's path.

Each cached file is `{ query, geocode, ways }`: `geocode` is the raw
Nominatim result (as `geocode()` would normally return), `ways` is the raw
Overpass `elements` array (as `fetchWays()` would normally return) for the
exact bounding box `squareBoundingBox()` computes for that address. The
cache is keyed by the *search query text*, not by geography, so re-running
a search with the exact same text is what serves the cached copy.

## Cached address catalog

Three anchors, each with a couple of confirmed near-POIs (within the 0.5mi
POI distance threshold -- joins the current map) and a couple of confirmed
too-far POIs (beyond it -- triggers the "too far for one map" dialog).
Every entry has full `ways` data, not just `geocode`, so a too-far POI can
also be used to test "Show new location" (promotes it to a new anchor)
entirely from cache. Distances are real, measured with the same formula
`app.js` itself uses (`feetOffsetFrom`), not estimated from house numbers --
a couple of "should be close" addresses turned out to be just over the
threshold in practice (Pacific Heights blocks in particular run wider than
they look from street numbering alone).

| Anchor | Near-POIs (joins map) | Too-far POIs (dialog) |
|---|---|---|
| `2318 Fillmore St, San Francisco, CA` | `2323 Fillmore St, San Francisco, CA` (187 ft)<br>`2199 Sacramento St, San Francisco, CA` (1474 ft) | `2400 Fillmore St, San Francisco, CA` (4833 ft)<br>`1801 California St, San Francisco, CA` (2881 ft) |
| `1516 Hearst Ave, Berkeley, CA` | `1600 Hearst Ave, Berkeley, CA` (439 ft)<br>`1400 Hearst Ave, Berkeley, CA` (907 ft) | `1520 Walnut St, Berkeley, CA` (4710 ft) |
| `2000 University Ave, Berkeley, CA` | `2100 University Ave, Berkeley, CA` (697 ft)<br>`2224 Shattuck Ave, Berkeley, CA` (1251 ft) | -- |

The three anchors are also all >0.5mi from *each other* (Fillmore↔Hearst
53048 ft, Fillmore↔University 55570 ft, Hearst↔University 3088 ft), so any
anchor doubles as a too-far POI relative to either of the other two --
useful when you want the too-far target to itself already have a
fully-populated, familiar map rather than one of the single-purpose
too-far-only addresses above.

(POI threshold = 0.5 miles = 2640 ft, per `POI_DISTANCE_THRESHOLD_MILES` in
`app.js`. If that constant ever changes, these distances -- and possibly
which column an address belongs in -- should be re-checked.)
