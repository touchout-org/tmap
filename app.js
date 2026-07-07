const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const RADIUS_METERS = 804.672; // 0.5 miles

const form = document.getElementById('search-form');
const input = document.getElementById('location-input');
const statusMessage = document.getElementById('status-message');
const matchedLocation = document.getElementById('matched-location');
const streetList = document.getElementById('street-list');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (query) {
    runSearch(query);
  }
});

async function runSearch(query) {
  clearResults();
  setStatus(`Searching for "${query}"...`);

  let place;
  try {
    place = await geocode(query);
  } catch (err) {
    setStatus('There was a problem looking up that location. Please try again.');
    return;
  }

  if (!place) {
    setStatus(`No location found for "${query}". Try a more specific search.`);
    return;
  }

  matchedLocation.textContent = `Matched location: ${place.display_name}`;

  let ways;
  try {
    const bbox = boundingBox(parseFloat(place.lat), parseFloat(place.lon), RADIUS_METERS);
    ways = await fetchWays(bbox);
  } catch (err) {
    setStatus('There was a problem retrieving street data from OpenStreetMap. Please try again.');
    return;
  }

  if (ways.length === 0) {
    setStatus('No named streets found within this area.');
    return;
  }

  setStatus('');
  renderStreets(ways);
}

function boundingBox(lat, lon, radiusMeters) {
  const metersPerDegreeLat = 111320;
  const latDelta = radiusMeters / metersPerDegreeLat;
  const lonDelta = radiusMeters / (metersPerDegreeLat * Math.cos((lat * Math.PI) / 180));
  return {
    south: lat - latDelta,
    north: lat + latDelta,
    west: lon - lonDelta,
    east: lon + lonDelta
  };
}

async function geocode(query) {
  const url = `${NOMINATIM_URL}?format=json&q=${encodeURIComponent(query)}&limit=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('geocode-failed');
  const data = await res.json();
  return data.length ? data[0] : null;
}

async function fetchWays(bbox) {
  const query = `[out:json][timeout:25];way["highway"]["name"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out tags;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error('overpass-failed');
  const data = await res.json();
  return data.elements || [];
}

function groupByStreetName(ways) {
  const groups = new Map();
  for (const way of ways) {
    const name = way.tags && way.tags.name;
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(way);
  }
  return groups;
}

function renderStreets(ways) {
  const groups = groupByStreetName(ways);
  const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

  for (const name of names) {
    const segments = groups.get(name);
    const li = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = segments.length > 1 ? `${name} (${segments.length} segments)` : name;
    details.appendChild(summary);
    details.appendChild(buildAttributeList(segments));
    li.appendChild(details);
    streetList.appendChild(li);
  }
}

function buildAttributeList(segments) {
  const keys = new Set();
  for (const seg of segments) {
    for (const key of Object.keys(seg.tags || {})) {
      if (key === 'name') continue;
      keys.add(key);
    }
  }
  const sortedKeys = Array.from(keys).sort((a, b) => a.localeCompare(b));

  const ul = document.createElement('ul');
  for (const key of sortedKeys) {
    const values = new Set();
    for (const seg of segments) {
      if (seg.tags && Object.prototype.hasOwnProperty.call(seg.tags, key)) {
        values.add(seg.tags[key]);
      }
    }
    const sortedValues = Array.from(values).sort((a, b) => a.localeCompare(b));

    const li = document.createElement('li');
    const attrDetails = document.createElement('details');
    const attrSummary = document.createElement('summary');
    attrSummary.textContent = key;
    attrDetails.appendChild(attrSummary);

    const valueText = document.createElement('p');
    valueText.textContent = sortedValues.join(', ');
    attrDetails.appendChild(valueText);

    li.appendChild(attrDetails);
    ul.appendChild(li);
  }
  return ul;
}

function setStatus(text) {
  statusMessage.textContent = text;
}

function clearResults() {
  matchedLocation.textContent = '';
  streetList.innerHTML = '';
}
