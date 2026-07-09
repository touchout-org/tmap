# Basic Open Street Map Experiments

There are a number of questions we need to answer about OSM before we begin earnest specifications or development of TMPAP4Dot.

* What data is associated with each street segment?
* What is that data structure like?
* what are the data values like and what do they mean?
* by looking at the data for known areas, we will be able to infer what the values mean and how to do future filtering.*

## The OSM Experiment site

* Site Name:  OSM Data Mine
* H1 OSM Data Viewer
** includes an edit field and a submit button.
* H2 Results
** Before results populate, this section says "No results. Please submit a location."
** If errors from OSM based on submitted location, display errors in human-readable form.
** If results are returned, display them in an alphabetical list with properties defined below.
* H2 Footer text End of page

## How it works

This HTML and JS site is hosted on GitHub Pages with no backend — all API calls happen client-side, directly from the browser.

**Geocoding:** OSM Nominatim only for this experiment (CORS-friendly for a static site, no API key/billing to manage). Google Geocoding/Places was considered but deferred.

**Street data query:** Overpass API, queried against a bounding box **0.3 miles east and west, and 0.2 miles north and south** of the geocoded point (not a true circular radius, for simplicity) — a 0.6mi × 0.4mi rectangle centered on the target address. This 3:2 aspect ratio is deliberate: it matches DotSVG's 600×400 canvas exactly (see "SVG export" below), so the bbox maps onto that canvas with no distortion.

Query shape:
```
[out:json][timeout:25];
way["highway"]["name"]({{south}},{{west}},{{north}},{{east}});
out tags;
```

* Requires both a `highway` tag and a `name` tag to be present, with **no restriction on value** — this deliberately casts as wide a net as possible, including lifecycle states like `highway=construction`, `highway=proposed`, and `disused:highway=*`/`abandoned:highway=*`, since the goal is to learn the full tag vocabulary in use.
* Ways with no `name` tag are dropped entirely for this pass (they're not grouped into an "unnamed" bucket) — unnamed footways/crossings are out of scope for this experiment, though they matter for the eventual wayfinding use case.
* `out tags;` returns each way's id and tags only, no geometry — sufficient since this experiment displays text, not a map. Switching to `out geom;` is a one-word change if a later version needs to render geometry.
* Overpass returns only the current state of the database by default (no history/attic query), so "latest version only" requires no extra filtering — it's the default behavior.
* Tag scope is intentionally **unfiltered**: every raw tag key found on any segment is shown, with no curated allowlist. The point of this experiment is discovering what tags/values actually occur in practice.

## Grouping and display logic

* Unique streets = ways grouped by **exact string match** on the `name` tag (e.g. "Main St" and "Main Street" are treated as distinct streets for now — no normalization/fuzzy matching).
* Streets are sorted alphabetically, with duplicates collapsed.
* Streets with more than one way segment show a segment count appended to the listing.
* Each unique street name is an expandable list item, implemented with native `<details>`/`<summary>` HTML elements (not a custom ARIA tree) — chosen because they get correct keyboard support and NVDA expanded/collapsed announcements for free.
* Expanding a street reveals a sub-list of every tag key found on any of its segments (union across segments).
* Expanding a tag key reveals:
  * A single value, if all segments of that street share the same value for that tag.
  * A sorted, deduplicated list of just the distinct values present, if segments differ (e.g. 8 segments with 3 distinct values → show only those 3 values).

## Confirmed

* **Footer text** — "End of page" is the literal intended visible footer text.
* **Ambiguous geocoding matches** — auto-pick Nominatim's first/top-ranked result. Print the matched location's display name at the top of the Results section, above the street list, so it's clear what was actually queried. If it's wrong, the user reruns with a more specific search string.
* **Matched location field scope** — both geocoding calls request `addressdetails=1` to get Nominatim's structured `address` object instead of parsing `display_name`. The Results section's "Matched location" line is built from POI name (if any) + house number + road + city + state + postcode — `neighbourhood`, `county`, and `country` are deliberately excluded as noise for this experiment's purposes.

## Data views (footer tabs)

The footer holds a radio-button group ("Data view") that switches how the already-fetched street data above is rendered, with no re-query against Nominatim/Overpass — switching tabs just re-renders the last result set.

* **Overview** (default, selected on load) — the original behavior described above: expanding a street reveals its full set of tag keys, each expandable to its value(s).
* **Highway** — expanding a street reveals, directly, the distinct values found in the `highway` tag across that street's segments, one per list item, each annotated with a count of how many segments carry that value (e.g. `residential (5)`, `tertiary (3)`). Values are deduplicated and sorted alphabetically; a count of 1 is still shown for consistency.
* **Unique streets** — same street list, but for any street name that has at least one "roadway"-class segment, segments tagged with a "pedestrian/path"-class `highway` value are dropped before display (a sidewalk/footway sharing a road's name is treated as redundant with the road it runs alongside). Street names with no roadway-class segment at all (a standalone path/greenway not paired with any road of the same name) are left untouched. The segment count in the summary line reflects the filtered count, not the original total. Expanding a street shows the same highway-value/count breakdown as the Highway tab, computed from the filtered segments.
  * Roadway classes: `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `unclassified`, `residential`, `living_street`, `service`.
  * Pedestrian/path classes (eligible for suppression when paired with a roadway of the same name): `footway`, `path`, `cycleway`, `pedestrian`, `steps`.

* **Address** — a different nesting shape from the other three tabs:
  1. Street name (expandable, same as other tabs).
  2. A numbered list of that street's individual segments (in whatever order Overpass returned them — not geographically sequenced).
  3. Expanding a segment reveals a 2-item list: the reverse-geocoded address closest to the *first* coordinate in that segment's node chain, and the one closest to the *last* coordinate.
  * Address lookups are done via Nominatim's reverse-geocoding endpoint (`/reverse?...&zoom=18`) and are **lazy** — a segment's two lookups only fire the first time its `<details>` is expanded, not when the tab is selected or the street is expanded. This is a deliberate choice to avoid bursting Nominatim's ~1 request/second usage policy, since a single search can return streets with 100+ segments.
  * All reverse-geocode calls are serialized through a single queue with a ~1.1s minimum gap between requests, and cached by rounded coordinate so that segments sharing an endpoint node (the common case at intersections) don't trigger duplicate lookups.
  * Fetching this view's underlying street/way data now uses `out geom;` instead of `out tags;` (a change shared by all views, since they all pull from the same cached fetch) — needed to get each segment's actual node coordinates for the start/end lookups.
  * Displayed address text is deliberately narrowed to just **house number + road** (e.g. "1901 University Avenue"), dropping everything else from Nominatim's structured `address` object — this tab is only trying to answer "what address is at this endpoint," not display a full address.

More views may be added to this tab set later.

## SVG export ("Copy SVG" button)

A standalone "Copy SVG" button in the footer (not tied to any Data view tab) converts the *entire* last-fetched result set (`lastWays`, unfiltered by any tab-specific logic like Unique streets' pedestrian suppression) into an SVG document and writes it to the clipboard, formatted for DotSVG (the KGS DotPad drawing app at `C:\Users\joshu\Dropbox\DOTPad\`):

* Each way becomes one `<polyline>` (open line, not a closed `<polygon>`) — this matches DotSVG's own convention for open hand-drawn paths (see its `points`-based polyline output when a path is left unclosed).
* `points` coordinates are a linear (equirectangular) projection of each node's lat/lon onto DotSVG's fixed 600×400 canvas, using the bbox edges as the projection bounds: longitude → x (`0`–`600`), latitude → y (`0`–`400`, inverted since latitude increases northward but SVG y increases downward). This is only reasonable because the bbox is small (0.6mi × 0.4mi) and now matches the canvas's 3:2 aspect ratio exactly.
* Each polyline gets `data-name="<street name>"` (plus a unique `id` for DOM validity) — DotSVG's own `shapeName()` reads `data-name` first when deciding what to speak/display on the message line as the cursor crosses a shape, so this makes hovering a segment announce **just the street name**, nothing else.
* Street names are XML-escaped in the `data-name`/attribute output (handles names like "Hearst Avenue & Arch Street").
* Known caveat, not yet addressed: a way that only partially crosses the bbox still comes back from Overpass with its *complete* geometry, so some of its projected points can fall outside the 0–600 / 0–400 viewBox (negative or over-large coordinates). Not clipped for now.
