const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const REVERSE_GEOCODE_DELAY_MS = 1100; // stay under Nominatim's ~1 req/sec usage policy

const MILES_TO_METERS = 1609.344;
const HALF_WIDTH_METERS = 0.3 * MILES_TO_METERS; // east/west of the target address
const HALF_HEIGHT_METERS = 0.2 * MILES_TO_METERS; // north/south of the target address

const SVG_WIDTH = 600; // matches DotSVG's 600x400 canvas (10:1 over the 60x40 dot grid)
const SVG_HEIGHT = 400;

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
const copySvgBtn = document.getElementById('copy-svg-btn');
const copySvgStatus = document.getElementById('copy-svg-status');

let lastWays = [];
let lastBbox = null;

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

copySvgBtn.addEventListener('click', async () => {
  if (!lastWays.length || !lastBbox) {
    copySvgStatus.textContent = 'No street data to copy yet -- run a search first.';
    return;
  }

  const svgText = buildSvgDocument(lastWays, lastBbox);
  try {
    await navigator.clipboard.writeText(svgText);
    copySvgStatus.textContent = 'SVG copied to clipboard.';
  } catch (err) {
    copySvgStatus.textContent = 'Could not copy SVG to clipboard.';
  }
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
    const bbox = boundingBox(parseFloat(place.lat), parseFloat(place.lon));
    lastBbox = bbox;
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

function boundingBox(lat, lon) {
  const metersPerDegreeLat = 111320;
  const latDelta = HALF_HEIGHT_METERS / metersPerDegreeLat;
  const lonDelta = HALF_WIDTH_METERS / (metersPerDegreeLat * Math.cos((lat * Math.PI) / 180));
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
  } else if (view === 'braille-labels') {
    renderBrailleLabelsView(ways);
  } else {
    renderStandardView(ways, view);
  }
}

// § Label creation — testbed for tmap spec.md's abbreviation algorithm
// ("Braille labels" > "Label creation"), ahead of building it into DotTMAP
// itself. One flat list, "[street name] — [label]" per distinct street
// name in the current fetch, so uniqueness/collision handling can be
// checked against real Overpass data before the real placement/rendering
// work starts.
function renderBrailleLabelsView(ways) {
  const groups = groupByStreetName(ways);
  const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  const labels = assignBrailleLabels(names);

  for (const name of names) {
    const li = document.createElement('li');
    li.textContent = `${name} — ${labels.get(name)}`;
    streetList.appendChild(li);
  }
}

const LABEL_VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'A', 'E', 'I', 'O', 'U']);

// § Label creation, step 1 — strip vowels from each word of the name,
// except when a word (once its own punctuation is stripped) is a single
// vowel letter on its own, e.g. "A Street" or "E. 12th St." -- those words
// are kept whole. Runs on the original whitespace-separated words, since
// word boundaries still need to exist for this check; spaces themselves
// aren't removed until the next step.
function stripVowelsPreservingSingleLetterWords(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lettersOnly = word.replace(/[^A-Za-z]/g, '');
      if (lettersOnly.length === 1 && LABEL_VOWELS.has(lettersOnly)) return word;
      return [...word].filter((ch) => !LABEL_VOWELS.has(ch)).join('');
    })
    .join(' ');
}

// § Label creation, steps 1-3 — the full candidate string a street's label
// is drawn from: vowels stripped (per the single-letter-word exception),
// every space and punctuation character removed, lowercased.
function labelCandidateString(name) {
  const vowelsStripped = stripVowelsPreservingSingleLetterWords(name);
  return vowelsStripped.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

// § Label creation, steps 4-6 — assigns every street name a unique
// 3-character label. Processes names in the given order (alphabetical, so
// output is stable/reproducible run to run) -- uniqueness resolution is
// first-come-first-served, so earlier names in the list get first claim
// on their natural 3-letter window.
function assignBrailleLabels(names) {
  const used = new Set();
  const labels = new Map();

  for (const name of names) {
    const candidate = labelCandidateString(name);
    const label = findUniqueLabel(candidate, used) || findUniqueDigitSuffix(candidate, used);
    used.add(label);
    labels.set(name, label);
  }

  return labels;
}

// § Label creation, steps 4-5 — try the candidate string's first three
// characters; on collision, keep the first two characters fixed and walk
// only the third character forward through the rest of the candidate
// string, rather than sliding the whole 3-character window. This keeps
// same-prefix streets (e.g. "University Avenue"/"University Walk", or
// "Virginia Gardens"/"Virginia Street") looking and feeling as similar as
// the data allows -- only the one character that actually needs to differ
// changes, instead of the whole label shifting to a different, unrelated
// stretch of the name. A candidate shorter than 3 characters is padded
// with dashes (the label's only allowed punctuation, per the Label
// creation intro) rather than skipped -- there's nothing to walk through
// in that case. Returns null if every remaining character collides too,
// so the caller can fall through to the digit-suffix step.
function findUniqueLabel(candidate, used) {
  if (candidate.length < 3) {
    const label = padLabel(candidate);
    return used.has(label) ? null : label;
  }
  const prefix = candidate.slice(0, 2);
  for (let i = 2; i < candidate.length; i++) {
    const label = prefix + candidate[i];
    if (!used.has(label)) return label;
  }
  return null;
}

function padLabel(s) {
  return (s + '---').slice(0, 3);
}

// § Label creation, step 6 — every natural window collided, so fall back
// to the candidate's first two characters (padded with a dash if the
// candidate itself is shorter than 2 characters) plus a single trailing
// digit, trying 0-9 in order until one is unique.
function findUniqueDigitSuffix(candidate, used) {
  const prefix = (candidate.slice(0, 2) + '-').slice(0, 2);
  for (let digit = 0; digit <= 9; digit++) {
    const label = prefix + String(digit);
    if (!used.has(label)) return label;
  }
  // All 10 digits already taken by this exact prefix -- vanishingly
  // unlikely for any real street list, but return a guaranteed-unique
  // placeholder rather than a duplicate label.
  let n = 0;
  while (used.has(`?${n}`)) n++;
  return `?${n}`;
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
  lastBbox = null;
  matchedLocation.textContent = '';
  streetList.innerHTML = '';
  copySvgStatus.textContent = '';
}

function projectToSvg(lat, lon, bbox) {
  const x = ((lon - bbox.west) / (bbox.east - bbox.west)) * SVG_WIDTH;
  const y = ((bbox.north - lat) / (bbox.north - bbox.south)) * SVG_HEIGHT;
  return { x, y };
}

function wayToPolylinePoints(way, bbox) {
  return (way.geometry || [])
    .map((point) => {
      const { x, y } = projectToSvg(point.lat, point.lon, bbox);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

function escapeXmlAttribute(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSvgDocument(ways, bbox) {
  const polylines = ways
    .filter((way) => (way.geometry || []).length >= 2)
    .map((way, index) => {
      const name = (way.tags && way.tags.name) || '';
      const id = `segment${String(index + 1).padStart(3, '0')}`;
      const points = wayToPolylinePoints(way, bbox);
      return `  <polyline data-name="${escapeXmlAttribute(name)}" id="${id}" points="${points}" fill="none" stroke="black" stroke-width="10"/>`;
    });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" width="${SVG_WIDTH}" height="${SVG_HEIGHT}">`,
    ...polylines,
    '</svg>'
  ].join('\n');
}
