# TMPAP4Dot Spec

This is the spec for the tactile mapping app itself (TMPAP4Dot) — distinct from `OSMExperiments.md`, which specs the "OSM Data Mine" experiment site used to explore OSM's data. This file is not part of that site and isn't deployed; it will grow as design decisions are made.

## Preliminary default filtering approach

Derived from the "Unique streets" view built in the OSM Data Mine experiment (see `OSMExperiments.md`), which turned out to closely match what TMPAP4Dot itself will need when deciding which OSM ways represent a real, distinct street vs. redundant parallel infrastructure sharing that street's name.

**Rule:** for a given street name, if at least one of its ways is tagged with a "roadway" `highway` value, then ways tagged with a "pedestrian/path" `highway` value under that same name are dropped — treated as a sidewalk/path running alongside the road rather than a separate feature. Street names with no roadway-class way at all (a standalone path/greenway not paired with any road of the same name) are left untouched, keeping all their segments.

* Roadway classes: `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `unclassified`, `residential`, `living_street`, `service`.
* Pedestrian/path classes (suppressed only when paired with a roadway of the same name): `footway`, `path`, `cycleway`, `pedestrian`, `steps`.

This is a starting point, not a final decision — to be revisited as more of the app's actual requirements (e.g. whether sidewalks need to be represented separately for wayfinding purposes even when paired with a road) become clear.
