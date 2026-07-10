// Dev-only helper: fetches real Nominatim + Overpass data for the addresses
// listed in `cases` below and writes each as a combined JSON file in this
// directory, in exactly the shape app.js's local test data cache expects:
// { query, geocode, ways }.
//
// Run with: node test-data/fetch-test-data.mjs
// (requires Node 18+ for global fetch; run from anywhere, paths below are
// relative to this file's own directory.)
//
// To add a new cached test address:
//   1. Add { query: '...', file: '....json' } to the `cases` list below.
//   2. Run this script -- it only needs to be run once per address (the
//      cached file doesn't change until you delete it and re-run).
//   3. Add a matching entry to LOCAL_TEST_DATA_FILES in app.js.
//
// squareBoundingBox here must stay an exact copy of app.js's own version --
// the whole point of caching is that the bbox in the cached file matches
// exactly what the real app would compute for that address.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const MILES_TO_METERS = 1609.344;
const POI_DISTANCE_THRESHOLD_MILES = 0.5;

function squareBoundingBox(lat, lon, halfSideMiles) {
  const halfSideMeters = halfSideMiles * MILES_TO_METERS;
  const metersPerDegreeLat = 111320;
  const latDelta = halfSideMeters / metersPerDegreeLat;
  const lonDelta = halfSideMeters / (metersPerDegreeLat * Math.cos((lat * Math.PI) / 180));
  return {
    south: lat - latDelta,
    north: lat + latDelta,
    west: lon - lonDelta,
    east: lon + lonDelta
  };
}

async function geocode(query) {
  const url = `${NOMINATIM_URL}?format=json&q=${encodeURIComponent(query)}&limit=1&addressdetails=1`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'DotTMAP-dev-cache-fetch/1.0 (touchout.org)' }
  });
  if (!res.ok) throw new Error('geocode failed: ' + res.status);
  const data = await res.json();
  return data[0];
}

async function fetchWays(bbox) {
  const query = `[out:json][timeout:25];way["highway"]["name"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out geom;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: '*/*',
      'User-Agent': 'DotTMAP-dev-cache-fetch/1.0 (touchout.org)'
    },
    body: 'data=' + encodeURIComponent(query)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('overpass failed: ' + res.status + ' ' + text.slice(0, 300));
  }
  const data = await res.json();
  return data.elements || [];
}

const cases = [
  { query: '2318 Fillmore St, San Francisco, CA', file: '2318-fillmore-st-san-francisco-ca.json' },
  { query: '1516 Hearst Ave, Berkeley, CA', file: '1516-hearst-ave-berkeley-ca.json' },
  { query: '2000 University Ave, Berkeley, CA', file: '2000-university-ave-berkeley-ca.json' }
];

for (const c of cases) {
  console.log('Fetching', c.query);
  let place;
  try {
    place = await geocode(c.query);
  } catch (err) {
    console.error('  geocode error:', err.message);
    continue;
  }
  if (!place) {
    console.error('  no geocode result');
    continue;
  }
  const lat = parseFloat(place.lat), lon = parseFloat(place.lon);
  const bbox = squareBoundingBox(lat, lon, POI_DISTANCE_THRESHOLD_MILES);
  let ways;
  try {
    ways = await fetchWays(bbox);
  } catch (err) {
    console.error('  overpass error:', err.message);
    continue;
  }
  console.log('  got', ways.length, 'ways for', place.display_name);
  fs.writeFileSync(path.join(OUT_DIR, c.file), JSON.stringify({ query: c.query, geocode: place, ways }));
  console.log('  wrote', c.file);
  // Polite delay between requests -- both Nominatim's and Overpass's usage
  // policies ask for max ~1 req/sec; this script only ever runs a handful
  // of times total, so there's no reason to push that.
  await new Promise((r) => setTimeout(r, 2000));
}

console.log('Done.');
