# TMPAP4Dot Spec

This is the spec for the tactile mapping app itself (TMPAP4Dot) — distinct from `OSMExperiments.md`, which specs the "OSM Data Mine" experiment site used to explore OSM's data. This file is not part of that site and isn't deployed; it will grow as design decisions are made.

## Preliminary default filtering approach

Derived from the "Unique streets" view built in the OSM Data Mine experiment (see `OSMExperiments.md`), which turned out to closely match what TMPAP4Dot itself will need when deciding which OSM ways represent a real, distinct street vs. redundant parallel infrastructure sharing that street's name.

**Rule:** for a given street name, if at least one of its ways is tagged with a "roadway" `highway` value, then ways tagged with a "pedestrian/path" `highway` value under that same name are dropped — treated as a sidewalk/path running alongside the road rather than a separate feature. Street names with no roadway-class way at all (a standalone path/greenway not paired with any road of the same name) are left untouched, keeping all their segments.

* Roadway classes: `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `unclassified`, `residential`, `living_street`, `service`.
* Pedestrian/path classes (suppressed only when paired with a roadway of the same name): `footway`, `path`, `cycleway`, `pedestrian`, `steps`.

This is a starting point, not a final decision — to be revisited as more of the app's actual requirements (e.g. whether sidewalks need to be represented separately for wayfinding purposes even when paired with a road) become clear.

## Known open observation: divided-road segments are drawn as separate parallel ways

For divided/dual-carriageway streets (e.g. University Ave, Bancroft Way, MLK Jr. Way in the Berkeley test data), OSM correctly maps each direction of travel as its own separate way rather than one way per block — so a single visual block can produce multiple ways sharing the same name, running parallel and offset by a small distance (the median width).

**Decision for now: leave this alone.** Unlike the sidewalk/footway case, these parallel ways aren't being filtered or merged. It's not yet clear this causes a real problem for a tactile map — the redundant parallel lines may simply render as a slightly thicker/doubled line at low zoom, and at higher zoom could actually be a useful feature (revealing that a street is physically divided). A candidate low-effort fix was discussed if it does turn out to be a problem: snap each segment's midpoint to a coarse grid (using geometry already fetched via `out geom;`) and treat same-named segments with matching rounded midpoints as one block — purely client-side, no new queries, but a heuristic (can misfire on sharp curves or unusually wide medians). Revisit once we can see how this actually renders on a tactile display.
