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

**Street data query:** Overpass API, queried against a bounding box of roughly 0.5 miles around the geocoded point (not a true circular radius, for simplicity).

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
