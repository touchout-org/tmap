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
