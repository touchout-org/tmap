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

// Retries on 429/504 with growing backoff -- the public Overpass instance
// rate-limits hard under the kind of repeated same-session requests this
// script itself makes (the same flakiness the whole local-cache feature
// exists to avoid during actual app testing).
async function fetchWays(bbox, attempt = 1) {
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
    if ((res.status === 429 || res.status === 504) && attempt < 4) {
      const waitMs = attempt * 15000;
      console.log(`  got ${res.status}, retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/4)`);
      await new Promise((r) => setTimeout(r, waitMs));
      return fetchWays(bbox, attempt + 1);
    }
    const text = await res.text().catch(() => '');
    throw new Error('overpass failed: ' + res.status + ' ' + text.slice(0, 300));
  }
  const data = await res.json();
  return data.elements || [];
}

const cases = [
  // Anchors -- each also fetched with full ways data, so any of them can
  // stand in as a "too far" promotion target for another. See
  // test-data/README.md for the measured distances between every pair below
  // (near-POI vs. too-far), since Nominatim's actual house-number spacing
  // turned out much wider/narrower than expected in a few cases.
  { query: '2318 Fillmore St, San Francisco, CA', file: '2318-fillmore-st-san-francisco-ca.json' },
  { query: '1516 Hearst Ave, Berkeley, CA', file: '1516-hearst-ave-berkeley-ca.json' },
  { query: '2000 University Ave, Berkeley, CA', file: '2000-university-ave-berkeley-ca.json' },
  { query: '261 6th Ave, Brooklyn, NY', file: '261-6th-ave-brooklyn-ny.json' },
  // Standalone -- no near/too-far POIs cached for this one. Added for its
  // real numbered "West Nth Street" + direction-word names, useful for
  // label-abbreviation regression testing.
  { query: '560 Riverside Dr, New York, NY', file: '560-riverside-dr-new-york-ny.json' },

  // Near-POIs -- confirmed within 0.5mi of their anchor above (see README),
  // for testing "add an additional POI to the current map."
  { query: '2323 Fillmore St, San Francisco, CA', file: '2323-fillmore-st-san-francisco-ca.json' },
  { query: '2199 Sacramento St, San Francisco, CA', file: '2199-sacramento-st-san-francisco-ca.json' },
  { query: '1600 Hearst Ave, Berkeley, CA', file: '1600-hearst-ave-berkeley-ca.json' },
  { query: '1400 Hearst Ave, Berkeley, CA', file: '1400-hearst-ave-berkeley-ca.json' },
  { query: '2100 University Ave, Berkeley, CA', file: '2100-university-ave-berkeley-ca.json' },
  { query: '2224 Shattuck Ave, Berkeley, CA', file: '2224-shattuck-ave-berkeley-ca.json' },
  // All three fit within 0.5mi of the 261 6th Ave anchor (see README) --
  // together they make a real multi-POI map without a single too-far case.
  { query: '592 Carroll St, Brooklyn, NY', file: '592-carroll-st-brooklyn-ny.json' },
  { query: '26 Garfield Pl, Brooklyn, NY', file: '26-garfield-pl-brooklyn-ny.json' },
  { query: '851 President St, Brooklyn, NY', file: '851-president-st-brooklyn-ny.json' },

  // Too-far POIs -- confirmed beyond 0.5mi of their anchor above (see
  // README), for testing the "that's too far for one map" dialog and (via
  // "Show new location") promoting one to a brand-new anchor. Any of the
  // four anchors above also works as a too-far case for any of the others
  // (Brooklyn is obviously >0.5mi from all three CA anchors too).
  { query: '2400 Fillmore St, San Francisco, CA', file: '2400-fillmore-st-san-francisco-ca.json' },
  { query: '1801 California St, San Francisco, CA', file: '1801-california-st-san-francisco-ca.json' },
  { query: '1520 Walnut St, Berkeley, CA', file: '1520-walnut-st-berkeley-ca.json' }
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
  // Delay between requests, well past the ~1 req/sec Nominatim/Overpass
  // usage policies ask for -- this script only runs a handful of times
  // total, so there's no reason to push the limit and risk the 429/504
  // backoff above.
  await new Promise((r) => setTimeout(r, 4000));
}

console.log('Done.');
