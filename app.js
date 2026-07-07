const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const RADIUS_METERS = 804.672; // 0.5 miles
const REVERSE_GEOCODE_DELAY_MS = 1100; // stay under Nominatim's ~1 req/sec usage policy

const ROADWAY_HIGHWAY_VALUES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'service'
]);
const PEDESTRIAN_HIGHWAY_VALUES = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'steps']);

const form = document.getElementById('search-form');
const input = document.getElementById('location-input');
const statusMessage = document.getElementById('status-message');
const matchedLocation = document.getElementById('matched-location');
const streetList = document.getElementById('street-list');
const viewInputs = document.querySelectorAll('input[name="view"]');

let lastWays = [];

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (query) {
    runSearch(query);
  }
});

viewInputs.forEach((viewInput) => {
  viewInput.addEventListener('change', () => {
    if (lastWays.length) {
      renderResults(lastWays);
    }
  });
});

function getSelectedView() {
  return document.querySelector('input[name="view"]:checked').value;
}

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

  matchedLocation.textContent = `Matched location: ${formatMatchedLocation(place)}`;

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
  renderResults(ways);
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
  const url = `${NOMINATIM_URL}?format=json&q=${encodeURIComponent(query)}&limit=1&addressdetails=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('geocode-failed');
  const data = await res.json();
  return data.length ? data[0] : null;
}

function formatMatchedLocation(place) {
  const address = place.address || {};
  const parts = [];

  if (place.name) parts.push(place.name);

  const streetLine = [address.house_number, address.road].filter(Boolean).join(' ');
  if (streetLine) parts.push(streetLine);

  const city = address.city || address.town || address.village;
  if (city) parts.push(city);

  if (address.state) parts.push(address.state);
  if (address.postcode) parts.push(address.postcode);

  return parts.length ? parts.join(', ') : place.display_name;
}

async function fetchWays(bbox) {
  const query = `[out:json][timeout:25];way["highway"]["name"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out geom;`;
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

function renderResults(ways) {
  lastWays = ways;
  streetList.innerHTML = '';

  const view = getSelectedView();
  if (view === 'address') {
    renderAddressView(ways);
  } else {
    renderStandardView(ways, view);
  }
}

function renderStandardView(ways, view) {
  const groups = groupByStreetName(ways);
  const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  const roadwayNames = view === 'unique-streets' ? computeRoadwayNames(ways) : null;

  for (const name of names) {
    let segments = groups.get(name);
    if (view === 'unique-streets') {
      segments = filterPairedPedestrianSegments(name, segments, roadwayNames);
    }

    const li = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = segments.length > 1 ? `${name} (${segments.length} segments)` : name;
    details.appendChild(summary);
    details.appendChild(view === 'overview' ? buildAttributeList(segments) : buildHighwayValueList(segments));
    li.appendChild(details);
    streetList.appendChild(li);
  }
}

function renderAddressView(ways) {
  const groups = groupByStreetName(ways);
  const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

  for (const name of names) {
    const segments = groups.get(name);
    const li = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = segments.length > 1 ? `${name} (${segments.length} segments)` : name;
    details.appendChild(summary);
    details.appendChild(buildSegmentList(segments));
    li.appendChild(details);
    streetList.appendChild(li);
  }
}

function buildSegmentList(segments) {
  const ol = document.createElement('ol');

  segments.forEach((segment, index) => {
    const li = document.createElement('li');
    const segDetails = document.createElement('details');
    const segSummary = document.createElement('summary');
    segSummary.textContent = `Segment ${index + 1}`;
    segDetails.appendChild(segSummary);

    const addressList = document.createElement('ul');
    const startItem = document.createElement('li');
    startItem.textContent = 'Start: (expand to look up)';
    const endItem = document.createElement('li');
    endItem.textContent = 'End: (expand to look up)';
    addressList.appendChild(startItem);
    addressList.appendChild(endItem);
    segDetails.appendChild(addressList);

    let loaded = false;
    segDetails.addEventListener('toggle', () => {
      if (!segDetails.open || loaded) return;
      loaded = true;
      loadSegmentAddresses(segment, startItem, endItem);
    });

    li.appendChild(segDetails);
    ol.appendChild(li);
  });

  return ol;
}

async function loadSegmentAddresses(segment, startItem, endItem) {
  const geometry = segment.geometry || [];
  if (geometry.length === 0) {
    startItem.textContent = 'Start: no geometry available';
    endItem.textContent = 'End: no geometry available';
    return;
  }

  startItem.textContent = 'Start: looking up...';
  endItem.textContent = 'End: looking up...';

  const start = geometry[0];
  const end = geometry[geometry.length - 1];

  const [startAddress, endAddress] = await Promise.all([
    reverseGeocode(start.lat, start.lon),
    reverseGeocode(end.lat, end.lon)
  ]);

  startItem.textContent = `Start: ${startAddress}`;
  endItem.textContent = `End: ${endAddress}`;
}

let geocodeQueue = Promise.resolve();
const reverseGeocodeCache = new Map();

function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  if (reverseGeocodeCache.has(key)) {
    return reverseGeocodeCache.get(key);
  }

  const resultPromise = geocodeQueue.then(async () => {
    try {
      const url = `${NOMINATIM_REVERSE_URL}?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('reverse-geocode-failed');
      const data = await res.json();
      return formatShortAddress(data);
    } catch (err) {
      return 'address lookup failed';
    } finally {
      await wait(REVERSE_GEOCODE_DELAY_MS);
    }
  });

  geocodeQueue = resultPromise;
  reverseGeocodeCache.set(key, resultPromise);
  return resultPromise;
}

function formatShortAddress(data) {
  const address = data && data.address;
  if (!address) return 'no address found';
  const streetLine = [address.house_number, address.road].filter(Boolean).join(' ');
  return streetLine || 'no address found';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRoadwayNames(ways) {
  const names = new Set();
  for (const way of ways) {
    const name = way.tags && way.tags.name;
    const highway = way.tags && way.tags.highway;
    if (name && ROADWAY_HIGHWAY_VALUES.has(highway)) {
      names.add(name);
    }
  }
  return names;
}

function filterPairedPedestrianSegments(name, segments, roadwayNames) {
  if (!roadwayNames.has(name)) return segments;
  return segments.filter((seg) => !PEDESTRIAN_HIGHWAY_VALUES.has(seg.tags && seg.tags.highway));
}

function buildHighwayValueList(segments) {
  const counts = new Map();
  for (const seg of segments) {
    const value = seg.tags && seg.tags.highway;
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const sortedValues = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b));

  const ul = document.createElement('ul');
  for (const value of sortedValues) {
    const li = document.createElement('li');
    li.textContent = `${value} (${counts.get(value)})`;
    ul.appendChild(li);
  }
  return ul;
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
  lastWays = [];
  matchedLocation.textContent = '';
  streetList.innerHTML = '';
}
