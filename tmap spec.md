# TMPAP4Dot Spec

This is the spec for the tactile mapping app itself (TMPAP4Dot) — distinct from `experiment/OSMExperiments.md`, which specs the "OSM Data Mine" experiment site used to explore OSM's data. As of 2026-07-08 that experiment site has been moved into the `experiment/` subdirectory of this repo, freeing up the repo root for DotTMAP's real implementation; the experiment remains live at touchout.org/tmap/experiment/. This file is not part of that site and isn't deployed; it will grow as design decisions are made.

## Overview

This is an accessible tactile street map web app that is highly compatible with the NVDA screen reader and optimized for Chrome. It uses a standard on-screen UI for controlling the experience: controls are displayed on screen, standard focus and screen reader navigation is supported, and hotkeys are offered for most parts of the experience. ARIA live regions ensure that some elements automatically announce themselves when they update.

The Dot Pad is connected via BLE and displays graphics and, sometimes, braille labels on the 60x40-pixel tactile display, as well as relevant text on the 20-cell message display. The 6 keys on the device can be used for certain types of input and control.

### Hardware requirement

The Dot Pad is required to actually view the tactile map, but it is not required to use the app. No feature or function of the site should fail, complain, or block the user if no Dot Pad is connected — a user without a connected device can still search for locations, build up a map, add POIs, and save it to their archives; they just won't be able to feel it until a device is connected.

### Browser check

On load, the app checks whether the browser is Chrome. If it isn't, a warning appears: "This App works best in Chrome. Please switch to Chrome so you can connect to the Dot Pad." This check exists because Dot Pad connectivity depends on Web Bluetooth, which only Chromium-based browsers support. The warning does not block use of the app (per Hardware requirement, above, connecting a Dot Pad is never mandatory) — a non-Chrome user can still search, build, and save maps, they just can't pair a device.

### Data sources

Confirmed by the "OSM Data Mine" experiment site (`experiment/OSMExperiments.md`): DotTMAP uses **Nominatim** for geocoding (turning a searched location into coordinates) and the **Overpass API** for street/way data. The experiment site's exploration of these two APIs was preliminary work specifically to validate this choice for the real app.

Overpass data is fetched for a square region centered on the anchor POI, with a half-side length equal to the current POI distance threshold setting (see [Settings](#settings)). This square is the map's data boundary — see [Pan Behavior](#pan-behavior) for what happens when panning reaches its edge. Fetching a larger region (e.g., to let panning extend further) is a possible future enhancement, not required now.

Any Nominatim/Overpass error (network failure, rate-limiting, no results, etc.) must be surfaced rather than fail silently — reported to the message field per [Message display architecture](#message-display-architecture), so there's enough visibility to debug what went wrong. This is P0: the exact wording/retry behavior can be refined later, but silent failure is never acceptable, even early on.

### Message display architecture

The message field (the on-screen print version of the message display, an ARIA live region) is the single source of truth for anything announced to the user — not the Dot Pad's 20-cell message display or speech output. Whenever something needs to be reported (pan status, scale changes, current-object names under the cursor, label toggle state, etc.), the app updates the message field first; that update then pushes to the Dot Pad message display and separately triggers the ARIA live announcement. The Dot Pad display and speech are downstream reflections of the message field, never independently-driven outputs.

Messages are kept terse by convention (e.g., a found address is truncated to the display's 20 cells at a word boundary, never mid-word) since there's currently no way to see more than what fits in those 20 cells at once. A command for panning the message display to reveal the rest of a longer message is a plausible future addition — not designed yet, flagged here so the terse-message convention isn't mistaken for a hard length limit on what the app can ever report.

### Sound cues

Alongside the message field, a short synthesized tone is a secondary, non-verbal cue for certain events — the first is Edge of Map (see [Pan Behavior](#pan-behavior)), a beep that plays when a pan is rejected. There's no standard way for a web page to trigger the OS/console bell, so cues are short tones generated with the Web Audio API (an oscillator, no external library or audio file needed) — this plays from the computer's own speakers, not the physical Dot Pad, which has no exposed beep/vibrate capability in the vendored SDK.

This is meant as a general pattern, not a one-off for Edge of Map specifically: sound is a plausible secondary cue for a variety of future events (e.g., a save completing, an error, reaching a boundary of some other kind) where a quick non-verbal signal is useful alongside — never instead of — the message field, which remains the single source of truth for what actually happened. Specific additional cues aren't designed yet; this section exists so the pattern (and the "no external library needed" fact) doesn't need rediscovering each time one comes up.

## Screen Layout

The default title is "DotTMAP — Tactile Street Maps for the Dot Pad." When a map has been loaded or created, the title of the current street map replaces the part of the title following the em dash (e.g., "DotTMAP — 123 Main Street, Springfield").

Top to bottom, left to right:

* H1: "Welcome to DotTMAP"
* Edit field: "Enter an address or location to get started:" [edit field], Search button. Once the anchor POI has been set, the label changes to "Enter another nearby address or location (optional)" — reflecting that the field is now for adding [additional POIs](#additional-pois) rather than starting the map.
* Below the search: H2 with the found address (anchor POI). To the right of the H2, the scale combo box.
* Below the H2: the visual representation of the map.
* Immediately below the map: a print version of the message display (live ARIA region).
* Below the message box, set off by a horizontal rule and an H3 "Controls," left to right:
     * "Connect Dot Pad" / "Disconnect Dot Pad" (from the Dot Pad SDK) — only one is ever visible at a time, based on current connection state: "Connect Dot Pad" when no device is connected, "Disconnect Dot Pad" once one is. The other is hidden entirely rather than shown disabled. Connecting or disconnecting reports status through the message field, per [Message display architecture](#message-display-architecture)
     * "Edit map..."
     * "Braille Labels..."
     * "My Archives..."
     * "Account and settings..."
* To the right of the map (and below the scale combo box): a group called "Move Map," arranged in a plus sign, with North, South, East, and West buttons.

### Command / hotkey mapping

The following table specifies the functions that can be accessed from the app or from the device with hotkeys or key combinations.

| Function | App Hotkey | Dot Pad Key Combo |
| --- | --- | --- |
| Cursor Up | Up arrow | dot 2 |
| Cursor Down | Down arrow | dot 5 |
| Cursor Left | Left arrow | dot 3 |
| Cursor Right | Right arrow | dot 6 |
| Pan Up | Ctrl+Up arrow | dots 1+4 |
| Pan Down | Ctrl+Down arrow | dots 3+6 |
| Pan Left | Ctrl+Left arrow | dots 1+3 |
| Pan Right | Ctrl+Right arrow | dots 4+6 |
| Increase Scale (zoom out) | `[` | dots 2+3 |
| Decrease Scale (zoom in) | `]` | dots 5+6 |
| Toggle Labels Top | `i` | none |
| Toggle Labels Bottom | `k` | none |
| Toggle Labels Left | `j` | none |
| Toggle Labels Right | `l` | none |
| Map Complexity: All streets and pathways | `1` | none |
| Map Complexity: Simplified neighborhoods | `2` | none |
| Map Complexity: Major streets | `3` | none |
| Map Complexity: Major highways | `4` | none |
| Toggle cursor-only mode | `0` | none |
| Open Custom POI ("Drop Pin") dialog | `a` | none |

Toggling a label setting from the keyboard reports the new state in the message field, in the form "top labels on/off" (etc.), which is mirrored to the Dot Pad message display. As with all message-display updates, the app-side field is the source of truth: it updates first, then pushes to the Dot Pad and triggers the ARIA live announcement — see [Message display architecture](#message-display-architecture).

The 1-4 hotkeys jump straight to a Map Complexity level (see [Editing the Map](#editing-the-map)) without needing to open the Edit Map dialog, announcing "[level] visible." in the message field. If the dialog happens to be open, its Map Complexity radio button stays in sync no matter which path changed it.

`0` hides every currently-visible street and POI and shows only the cursor, announcing "Cursor only"; pressing it again restores exactly what was showing before (whatever combination of Visible/Hidden Streets, Hidden Features, and Map Complexity was already in effect), announcing "Features restored." This is a display-only override — it never changes any of that underlying state, and the on-screen POI list box keeps working normally throughout, since it's a navigation aid rather than a rendered map feature.

`a` opens the Custom POI dialog described under [Custom POIs](#custom-pois) — same as clicking "Drop Pin."

Cursor rows match the dot mapping already established in [Cursor and hit testing](#cursor-and-hit-testing) (reused from DotSVG). Toggle Labels Top and Bottom are added here to complete the set of 4 label positions (matching the left/right/top/bottom checkboxes in the shared Braille Labels dialog — see [Settings](#settings)).

The `i`/`j`/`k`/`l` hotkeys and the Braille Labels dialog's four checkboxes drive one shared piece of state, not two independent ones. The hotkeys work regardless of whether the dialog is open; whenever the dialog is opened (or reopened), each checkbox simply reflects whatever that shared state currently is — there's no separate sync step, the checkbox display is a live view of the same toggle the hotkeys set.

## SVG Display Requirements

* Use SVG to manage all segments and POIs.
* The full canvas is in the ratio 3x2 to conform to the Dot Pad dimensions. Canvas dimensions change if braille labels are being used.
* Braille labels also stay a fixed size regardless of scale/zoom.
* Street segments are open lines.
* POIs are marked with a few different small, solid shapes — circles, triangles, or squares — defined by a point at their center. They fit into a 4x4 display-pixel patch and do not resize with map scale. Although the markers have visual size and shape, they are treated as point objects in the SVG, not as shapes.
  * **Note (2026-07-10):** for now, every POI marker — anchor and additional alike — is a solid 3x3-dot square with all corners filled, rather than the varied circle/triangle/square shapes above. This is a temporary simplification for legibility/prominence, not a final decision; distinguishing POI types by shape is deferred and will be revisited.
* Line objects can have a line style of solid, dotted, or dashed. These line types may be used to differentiate different types of roadway or pedestrian path. Solid is the default: densely packed dots on the display. Dotted skips approximately every other dot of the solid line; dashed skips approximately every third dot of the solid line (exceptions are OK provided the majority of the line conforms).
* The cursor is a 4x4 circle (a square with corner dots removed).

### Cursor and hit testing

The cursor is a small unfilled circle (a 4x4 square with the corners missing). It can be moved with the arrow keys on the keyboard, or with dots 3, 2, 5, and 6 on the device (corresponding to left, up, down, and right respectively). This is the same interaction pattern already implemented and used across the DotSVG repo (another touchout.org project) for Dot Pad hardware interaction, and will be reused here rather than reinvented. The cursor moves one display pixel per key press.

If the cursor is at the edge of the current view, moving it further in that direction pans the map instead of stopping — including "Edge of Map" if the fetched data's own boundary is reached.

Any object that intersects with the edge of the circle is considered "current." If more than one object intersects the edge, there is more than one current object. Current objects are identified by name.

Current object names are displayed in the message field and on the message display.

We display only unique names for current objects: if several current objects share the same name, we display that name once. If there are multiple names, we join them with an ampersand. For example, if there are 7 current objects with 3 of them called "Main St" and 4 of them called "Spruce St," the message display says "Main St & Spruce St."

We will refine this behavior as we experiment with the UI.

## Scale and Map Filtering

### Scale behavior

The scale appears on the screen as a combo box showing the value of the current scale.

* If Traditional Scale is selected for scale type in settings, scale values are "X = Y," where X is the distance on the display and Y is the distance on the map. For example, "1 in = 300 ft" or "3 cm = 1 km."
* If Display Area is selected for Scale Type in settings, values are of the form "300 feet by 200 feet" or "600 m by 400 m."
* Whenever the scale is adjusted, the new scale appears on the message display.

### Street importance tiers

Each way is tagged with a fixed tier from its `highway` class at fetch time (not recomputed on pan/zoom):

| Tier | Highway classes |
|---|---|
| 1 | motorway, trunk |
| 2 | primary |
| 3 | secondary |
| 4 | tertiary |
| 5 | unclassified, residential, living_street |
| 6 | service |
| 7 | footway, path, cycleway, pedestrian, steps |

POIs are never tiered. Tiers are purely data — nothing hides a tier automatically. They exist to drive the Map Complexity filter (see [Editing the Map](#editing-the-map)) and, later, street-label placement priority (see [Label placement](#label-placement)).

### Map filtering

Streets and POIs are fetched as-is from Overpass, with no automated cleanup, deduplication, or geometric simplification applied. All filtering and decluttering is manual, via the Edit Map dialog — see [Editing the Map](#editing-the-map) for the current design: per-item show/hide (Visible Streets, POIs, and the shared Hidden Features list) plus the Map Complexity tier-cutoff radio group for bulk detail control.

An earlier, fully-automated version of this pipeline (name-based roadway/pedestrian dedup, divided-road carriageway collapse, and density-driven tier decluttering, with no manual override) was designed and built first, then removed after hands-on testing showed it over-decluttered some areas, under-decluttered others, and dropped features the user wanted kept, with no way to correct a bad call. See [Appendix: Retired Automated Data Cleaning Pipeline](#appendix-retired-automated-data-cleaning-pipeline) for the full historical design, kept for reference in case any of it is worth reviving in some form.

## Pan Behavior

Using pan controls (see [command mapping](#command--hotkey-mapping)), the display moves in the specified direction by the amount specified in Pan Amount (settings). The tactile display updates and the on-screen Pan Status announces "[distance] [direction] of [anchor POI]," following the [message display architecture](#message-display-architecture) (message field updates first, then pushes to the Dot Pad and triggers speech).

If a pan would move the view past the edge of the fetched data — the square region bounded by the POI distance threshold from the anchor POI, see [Data sources](#data-sources) — the pan is rejected: a tone plays (see [Sound cues](#sound-cues) — this comes from the computer's speakers, not the Dot Pad itself, which has no exposed beep/vibrate capability) and the message display reports "Edge of Map."

If changing scale would leave the cursor outside the new view, the view shifts to keep the cursor visible, bounded by the edge of the fetched data. If the data doesn't allow enough room, the cursor's on-screen position is clamped to the edge instead.

If a pan would leave the cursor outside the view on the edge opposite the pan direction, the cursor moves with the pan by the same amount, keeping its position relative to the view unchanged.

## POIs

The location edit field at the top of the main window is used to begin the DotTMAP experience. Entering a location returns the anchor POI, generates a map centered on that point, and adds a solid circle marker to that POI (currently a 3x3 square, like every other POI marker — see the note under [SVG Display Requirements](#svg-display-requirements)).

### Additional POIs

Additional POIs can be added to a map by entering additional locations. Each new POI gets a triangle marker (currently a 3x3 square, like every other POI marker — see the note under [SVG Display Requirements](#svg-display-requirements)).

If a subsequent POI location is more than [threshold distance] away from the anchor POI, we get a true modal dialog that says "The new location is [distance] away from [anchor POI]. That's too far away for a single map." Buttons are "Show [new POI]" and "Cancel." If they select the new location, the old map is discarded and the new POI becomes the anchor with a new map generated around it.

If a subsequent POI is less than [threshold distance] away, the new POI is added to the current map and the map pans to center that new POI. Panning behavior automatically happens, announcing the distance and direction from the anchor POI. Multiple additional POIs can be added to a single map.

As POIs are added to the map, the locations are added to a list box on the left of the page. Selecting an item from the list box (or arrowing through the list) pans to that POI and triggers the related panning announcement.

### Custom POIs

A "Drop Pin" button next to the POI list box (hotkey `a`) opens a "Custom POI" dialog: a "POI Name:" edit field plus OK and Cancel buttons. Pressing Enter (or clicking OK) adds a new POI at the cursor's current position, using the entered name; pressing Escape (or clicking Cancel) closes the dialog without adding anything. A blank name is rejected by the field's own required-field validation, without needing a submit.

A custom POI is added through the same path as any other additional POI — it shows up in the POI list box, the Edit Map dialog's POIs group, on-screen rendering, cursor hit-testing, and the tactile raster exactly like an address pulled from OSM, with the same short-address-style POI conventions (see [Additional POIs](#additional-pois)) except its name is whatever the user typed rather than a geocoded address. POI names are not required to be unique — this matches every other POI-naming path in the app, none of which enforce it either.

## Editing the Map

Clicking "Edit map..." opens a dialog with four expandable, collapsible groups (native disclosure widgets, each with an `<h4>`-wrapped label so the group names stay heading-navigable while expanded): **POIs**, **Visible Streets**, **Hidden Features**, and **Map Complexity**. There is no Save/Cancel step — every action in this dialog takes effect immediately and is reflected on the map, the tactile raster, and the message field right away.

**POIs** lists every POI currently visible on the map, sorted in the same order as the POI list box (anchor first, then additional POIs in the order they were added). Each item is a plain clickable button, not a checkbox — clicking a POI removes it from the map (and the POI list box) and moves it into Hidden Features. The message field announces "[POI name] removed."

**Visible Streets** lists every street/pathway name currently on the map, alphabetically, regardless of class (there is no longer a separate Streets/Pedestrian Pathways split). Clicking a street removes it from the map at every scale and moves it into Hidden Features. The message field announces "[street name] removed."

**Hidden Features** is a single shared list for everything currently hidden, whether it was a POI or a street — hidden POIs are listed first (in POI list order), hidden streets alphabetically after. Clicking an item here restores it to the map and moves it back to its home group (POIs or Visible Streets). The message field announces "[name] restored."

Focus handling in all three of the above groups follows the same rule: after a click, focus stays in the group the item was just clicked from, landing on whichever item now occupies that same list position (the next item, or the previous one if it was last). Focus only jumps to the other group — landing on that specific item's button — if the group the click came from is now completely empty.

**Map Complexity** is a mutually-exclusive radio group, not a membership list, with four levels from most to least detail: "All streets and pathways," "Simplified neighborhoods" (hides importance tiers 6–7), "Major streets" (hides tiers 5–7), "Major highways" (tier 1 only). Each level is a strict tier cutoff (every level is a subset of the one before it), and it is a completely independent filter from Visible/Hidden Streets — a street hidden by hand stays hidden at every complexity level, and changing complexity never un-hides or re-hides a manually-toggled street. Picking a level announces "[level] visible." in the message field. The 1-4 app hotkeys (see [Command / hotkey mapping](#command--hotkey-mapping)) jump directly to a level without opening the dialog.

Historical note: an earlier version of this dialog used checkboxes with Save/Cancel staging, and an even earlier iteration of the underlying filtering was a fully automated pipeline (name-based roadway/pedestrian dedup, divided-road carriageway collapse, density-driven tier decluttering) with no manual override at all. Both were replaced during hands-on testing on the `experiment/manual-declutter` branch, in favor of the always-reversible, always-immediate model described above — see that branch's commit history if the earlier designs are ever worth revisiting.

## Braille Resources

### Representing braille on the Dot Pad

We have figured out a lot about how to represent braille on the Dot Pad from the DotSVG project. We will reuse modules for turning text into braille and for reading from the Dot Pad keys.

### Braille labels

Braille labels on the graphics pad itself are a significant effort. There are a number of requirements around label creation and placement. When labels are turned on, they also significantly impact the size and dimensions of the SVG viewbox.

Because the presence or absence of each label zone changes the viewbox's size and position, the toggle infrastructure itself (the four checkboxes, and the viewbox resizing/repositioning that reacts to them — see [Label placement](#label-placement) for the exact dot-column/row math) needs to be built early, alongside core map rendering, rather than deferred to the end. The label *content* — which streets get labeled and where, abbreviation collision handling, the oblique-angle rule, the overflow rule — can keep iterating after that: it's fine for a label zone to render empty, or with a partial/unrefined selection of labels, while that logic matures.

#### Label creation

All labels are unique 3-character abbreviations created from the actual street name. No two streets on the map, even if they're not both being displayed currently, may have the same abbreviation. Labels are always in lowercase 8-dot computer braille, and only include alphanumerics — no punctuation except for a dash if necessary. The 3-character limit is hard and fast, no exceptions; if necessary, pad the end of the label with dashes.

The abbreviation algorithm goes like this:

1. Strip all vowels from the name, unless the vowel is a single-letter word in the name (such as "A Street" or "E. 12th St."). Within each word, also collapse any run of the same letter down to a single occurrence (e.g. "Addison" -> "ddsn" -> "dsn") -- doubled letters are a wasted phonetic cue in a 3-character abbreviation. Only consecutive runs collapse; non-adjacent repeats of the same letter elsewhere in the word are left alone.
2. Strip all spaces and punctuation from the name.
3. Make all letters lowercase.
4. Take the first three letters of the string and check for uniqueness.
5. If not unique, keep the first two letters fixed and walk the third letter forward through the rest of the string, one character at a time, until a unique 3-letter abbreviation is found. This is a deliberate choice, confirmed against real examples during implementation: keeping the shared prefix intact and varying only the one character that actually needs to differ keeps related street names (e.g. "University Avenue"/"University Drive"/"University House Way", or "Virginia Gardens"/"Virginia Street") looking and feeling similar, rather than sliding the whole 3-letter window to a different, unrelated-looking stretch of the name.
6. If step 5 exhausts the string without finding a unique label, try a different anchor: keep the first and last letters fixed and walk the *middle* letter forward through the string's interior characters instead.
7. If step 6 exhausts the string too, keep the first two letters fixed and try single digits 0-9 as the third character instead.

#### Label placement

The Labels dialog has 4 checkboxes to place labels at the top, bottom, left, and/or right of the display. These label regions are like windows adjacent to the SVG viewbox. Wherever a street intersects an active edge of the viewbox is a possible label point, subject to the rules below.

**Some streets will not get a label — that's an accepted outcome of the algorithm below, not an error state.** There is no "some streets not labeled" indicator; a street that doesn't fit is simply omitted. This resolves the label-overflow question (previously open gap #1).

**Rules:**

* Labels must always be centered, either vertically or horizontally, on the point where the street intersects the closest active edge.
* Street label priority uses the same [street importance tiers](#street-importance-tiers) established for large-scale decluttering (motorway/trunk highest, standalone footway/path lowest) as the primary sort. Within a tier, the street with more visible segments on the current display wins — a rough proxy for how substantial a street actually is on screen right now, since a real through-street naturally accumulates more OSM way-segments (split at every intersection) than a short stub does. Position along the edge (left-to-right / top-to-bottom) is the final, deterministic tie-break when tier and segment count both match. (Segment count was the original, sole priority rule early in this project, then replaced entirely by tiers; it's back now as tier's tie-break, not as tier's replacement — a pure edge-crossing-length minimum was tried in between and dropped, since it measured the one segment touching an edge rather than the street's overall presence, wrongly excluding substantial streets whose specific crossing segment happened to be short.)
* Labels should only be applied to streets that intersect the active edge at more than 45 degrees. A street that intersects at 45 degrees or less never gets a label on that edge — it's likely to cross an adjacent edge at a more oblique angle, where a label is more appropriate.
* There must be at least 2 display-pixels of whitespace between a label and the map, and between adjacent labels. This is the same spacing already reflected in the zone-sizing math below (the 2-dot-column and 2-dot-row padding figures).
* The four corners are shared, contested space between the two zones that meet there (e.g. the top-right corner is shared by the top and right zones), not owned outright by either one -- part of the "no wasted space" principle behind this whole algorithm. Each corner holds exactly one label's worth of physical room. Whichever of the two zones is processed first in edge order (see the placement algorithm below) gets first claim on a shared corner if it has a candidate that needs it; if that zone doesn't need the corner, the other zone sharing it is free to use it instead. A corner is only real, physical room when *both* contributing zones are active — with either one off, there's no gap there to share.

**Placement algorithm**, run after the map and its streets are otherwise finalized for the current view:

1. Process the four active edges in a fixed order: top, right, bottom, left. An edge the user has turned off via its checkbox is skipped entirely.
2. Within each edge, walk street-importance tiers from most to least important. Within a tier, place candidate labels in position order — left-to-right along the top/bottom edges, top-to-bottom along the left/right edges.
3. A candidate is skipped on this edge if it can't fit — it violates the 2-pixel whitespace rule against the map or an already-placed label, or it fails the angle or minimum-length rule above.
4. A street already labeled on an earlier-processed edge is skipped on every later edge — the primary pass gives each street at most one label, on whichever eligible edge is processed first.
5. **Final pass:** once all four edges have been walked once, make one more pass around them in the same order, filling any leftover room. This pass isn't limited to duplicating existing labels — it can also give a first label to a street that was skipped everywhere in the primary pass. Any candidate that fits the remaining space is eligible, still worked in tier order.

Since all labels are exactly 3 characters, the left and right label columns need exactly 10 dot columns each: 2 dot columns per character x 3 characters = 6, plus 1 column of kerning between characters 1–2 and 2–3 = 2, plus 2 dot columns of padding between the label and the viewbox = 10 total. The horizontal labels at top and bottom need exactly 5 dot rows: 3 for the braille dots, plus 2 for the padding between the text and the graphic.

When any of the left, right, top, or bottom labels are turned off, the viewbox expands to use that space for the map.

### Braille translator

We will need a braille translator. We don't need any formatting functions. We will start with 8-dot computer braille and add uncontracted and contracted UEB. This will be used for the message display.

## Settings

Default values in [brackets]. Before settings are implemented, we set default values but use variables to ensure settings-ready architecture.

* Metric / [Imperial]
* Map scale options: 1 in = 100, 200, 300, [400], 500, 1000, 1500, 2000, 5000
* Scale type: [Traditional] / Display Area — Display Area's values (e.g., "300 feet by 200 feet") are calculated from this same set of Traditional Scale presets, rounded as needed for simplicity, rather than authored as a separate preset list
* Pan amount: [1/4], 1/2, 3/4, 1 — in units of display height/width. Horizontal and vertical pan amounts are independent settings, and the actual map distance covered by a pan varies with the current scale.
* Braille code: [8-dot computer], US uncontracted, contracted UEB
* Braille labels (4 checkboxes): left, right, top, bottom — [none checked]. These are the same 4 checkboxes exposed by the "Braille Labels..." button in Screen Layout, not a separate control — deliberately kept off the main page and out of the general Settings dialog, in their own dedicated dialog.
* POI distance threshold: [1 mile], 2 miles, 3 miles

## Accounts and Data

### Authentication

Use Google ID via **Firebase Authentication**, chosen specifically because it's the native path for a Google Sign-In decision already made — no separate OAuth app integration beyond what creating the Firebase project already sets up. Associate last settings and saved maps with the unique user.

### Cloud storage

**Firebase (Firestore + Firebase Authentication).** Resolved 2026-07-08 against the project's actual requirements: free/near-free, hundreds-to-thousands of users (not tens of thousands), minimal admin, no highly sensitive data. The deciding factor over the other BaaS options considered (Supabase, Appwrite) is that Firebase's free "Spark" tier is a permanent free tier with no inactivity pause — Supabase and Appwrite both freeze a free project after a week without database activity, a bad failure mode for a niche accessibility tool with sporadic usage, and one that would add exactly the ongoing admin burden this project needs to avoid. Firebase is also fully managed (no servers to run), and its free-tier ceiling (1 GB Firestore storage, 50k reads / 20k writes / 20k deletes per day, 50k monthly active users on auth) is comfortably oversized for what this app actually stores — small per-user JSON settings and SVG map documents, light traffic.

### Saving and exporting

The "My Archives" button opens a dialog with:

* A group named "Save current map," containing:
     * An edit field labeled "Map Name"
     * A "Save" button
     * A list of previously saved maps by map name
     * A "Load map" action, which overwrites the current data with the map from the archive being loaded. This is also the action that happens if you double-click a saved map name, or use focus commands and press Enter or Space bar on a saved map name.
* If opening a saved map without saving the current map, another dialog appears: "If you continue loading this map you will lose your changes to [current map]. Do you want to continue?" Buttons: Continue and Cancel.

When a map in the list is selected, options (as buttons and in the application menu) allow for opening (the default action), deleting, renaming, and downloading. Rename puts up a simple rename dialog. Download saves the selected file to a local file named `[map name].svg`. Delete puts up a confirmation dialog; pressing Del on a selected map also deletes it.

## Open Questions & Critical Gaps

Resolved as of 2026-07-07: data source (Nominatim + Overpass, confirmed), cursor-key mapping (confirmed, reused from DotSVG), Dot Pad hardware requirement (confirmed: required to view, never required to use), "POIs are polygons" wording (confirmed: "shapes" is correct — see [SVG Display Requirements](#svg-display-requirements)), and the Braille Labels dialog vs. Settings checkboxes question (confirmed: one control, mentioned in two places, not a duplicate).

Also resolved, same day: the [Command / hotkey mapping](#command--hotkey-mapping) table now covers cursor movement, panning, scale change, and label toggling (app hotkeys, plus Dot Pad key combos where applicable). The four dialog-opening buttons ("Edit map...", "Braille Labels...", "My Archives...", "Account and settings...") are confirmed to need no hotkeys — standard mouse/screen-reader interaction only.

Also resolved as of 2026-07-08 (see [Data sources](#data-sources), [Pan Behavior](#pan-behavior), [Saving and exporting](#saving-and-exporting)): the pan-past-boundary behavior (reject the pan, beep, message field reports "Edge of Map"), the priority and baseline requirement for OSM error reporting (P0 — must surface to the message field for debugging, wording/retry logic can refine later), and the "saving" vs. "download" distinction (Download = local `.svg` file, no account; Save = cloud archive via My Archives, for returning to in-progress edits — these are two different actions, not a naming ambiguity).

Also resolved as of 2026-07-08 (see [Data ingestion and cleaning pipeline](#data-ingestion-and-cleaning-pipeline-retired), [Divided-road carriageway collapse](#divided-road-carriageway-collapse-retired), [Map density evaluation and tier-based decluttering](#map-density-evaluation-and-tier-based-decluttering-retired) — all since retired, see the linked appendix sections): the street-declutter algorithm — semantic importance tiers plus measured grid density, replacing the placeholder proximity rule — and the divided-road parallel-carriageway handling — candidate-pair detection plus point-correspondence centerline collapse, replacing the earlier "leave it alone" decision — are both now designed, though several thresholds (`densityCellSize`, the density threshold(s), the carriageway max-separation width) remain open for empirical tuning once real data is running on actual hardware.

Also resolved as of 2026-07-08: saved-map versioning is a manageable risk, not a blocking design gap — the app will either migrate legacy archive data if the save format ever changes, or take care not to make changes that would break compatibility with existing saves; no dedicated migration system is required as a feature. Display Area scale presets are calculated from the same Traditional Scale preset list, rounded as needed for simplicity, rather than authored as a separate list — see [Settings](#settings).

Also resolved as of 2026-07-08 (see [Label placement](#label-placement)): the label-overflow rule. Label priority now reuses the [street importance tiers](#street-importance-tiers) from decluttering (replacing "more segments wins"), the angle rule got a hard 45-degree threshold, and a full placement algorithm (fixed edge order, per-tier positional placement, a 2-pixel whitespace/collision rule, and a final leftover-room pass) defines exactly what happens when there isn't room for every candidate: lower-priority streets are silently skipped, with no "some streets not labeled" indicator — an accepted outcome, not an error state.

Also resolved as of 2026-07-08 (see [Authentication](#authentication), [Cloud storage](#cloud-storage)): the auth/cloud-storage backend is Firebase (Firestore + Firebase Authentication), chosen over Supabase and Appwrite specifically because its free tier never pauses for inactivity — the other two both freeze a free project after a week without database activity, a bad failure mode for a niche accessibility tool with sporadic usage. Google-only sign-in (no fallback provider for non-Google users) is kept as the accepted scope, not treated as a blocking gap — revisit only if real user feedback surfaces a need.

**No open gaps remain as of 2026-07-08.** The three empirical parameters flagged in [Divided-road carriageway collapse](#divided-road-carriageway-collapse-retired) and [Map density evaluation and tier-based decluttering](#map-density-evaluation-and-tier-based-decluttering-retired) are still unset, but that's expected to be resolved through hands-on tuning during implementation and testing, not a remaining design question.

## Feature Priorities

Priority tiers as set by the user on 2026-07-08:

* **P0** — Data acquisition, cleaning, and presentation; interaction (pointing, panning, zooming); adding POIs, labels, and their associated toggles.
* **P1** — Settings, map editing, downloading, braille translation, large-scale decluttering.
* **P2** — Identity management, My Archives, saving settings.

### P0

| Feature | Category | Notes |
|---|---|---|
| Address search + Nominatim geocoding | Data acquisition | Entry point for the whole app |
| Overpass fetch (street/way data) | Data acquisition | |
| ~~Same-name street de-duplication filtering~~ | Data cleaning | Built, then retired along with the rest of the automated pipeline in favor of manual filtering — see [Map filtering](#map-filtering) and [Appendix: Retired Automated Data Cleaning Pipeline](#appendix-retired-automated-data-cleaning-pipeline) |
| SVG map rendering (on screen) | Presentation | Must work standalone with no Dot Pad connected, per Hardware requirement |
| Chrome browser check + warning | Presentation | Gates BLE connectivity (Web Bluetooth is Chromium-only); non-blocking |
| Connect/Disconnect Dot Pad buttons (SDK-provided) | Presentation | Sit in the Controls row alongside Edit map/Braille Labels/My Archives/Settings |
| BLE connection + tactile rendering on Dot Pad | Presentation | |
| Cursor movement + hit testing + message display | Interaction — pointing | |
| Pan controls (on-screen buttons + hotkeys) | Interaction — panning | |
| Scale combo box + scale change (Traditional Scale) | Interaction — zooming | Display Area preset *values* are a P1 settings item — see below |
| Command/hotkey mapping table | Interaction | Done |
| Pan-past-boundary behavior ("Edge of Map" beep + message) | Interaction — panning | Resolved: rejecting the pan and reporting "Edge of Map" is sufficient for now; fetching more data to pan further is a later enhancement |
| OSM error reporting (Nominatim/Overpass failures surfaced to the message field) | Data acquisition | Resolved as P0: must be visible for debugging, even before the UX around it is polished |
| Additional POIs + threshold-distance modal + POI list box | Adding POIs | |
| Braille label zone toggles + viewbox resize/reposition | Labels — toggles | Must ship early — label-zone presence/absence changes the viewbox, so this is foundational to map rendering, not a late add-on |
| ~~Braille label abbreviation algorithm~~ | Labels | Done — see [Label creation](#label-creation); prototyped in the OSM Data Mine experiment site first, then ported into DotTMAP |
| ~~Braille label placement geometry + overflow rule~~ | Labels | Done — see [Label placement](#label-placement) (tier-based priority, 45-degree angle rule, 2-pixel whitespace rule, and the full placement algorithm), including the actual braille-dot rendering into the zones on both the on-screen SVG and the tactile raster |
| Braille Labels dialog | Labels — toggles | |

### P1

| Feature | Category | Notes |
|---|---|---|
| Settings dialog (units, pan amount, POI threshold, scale type, Display Area preset values) | Settings | Built against the default-value variables the Settings section already calls for; *persisting* settings across sessions is a P2 item, see below. An earlier, minimal experimental tuning-fields surface for the (now-retired) automated decluttering/collapse parameters existed briefly before this dialog — see [Appendix: Retired Automated Data Cleaning Pipeline](#appendix-retired-automated-data-cleaning-pipeline) |
| ~~Edit Map dialog~~ | Map editing | Done, in a different shape than originally planned here — see [Editing the Map](#editing-the-map) |
| Download to a local `.svg` file | Downloading | Distinct from full My Archives (P2) — no account needed |
| Braille translator (multi-code: US uncontracted, contracted UEB) | Braille translation | Resolved: baseline 8-dot computer output ships early via the reused DotSVG module, no translator needed; building the full multi-code translator is phased into Phase 5 as an external dependency |
| ~~Large-scale street decluttering algorithm~~ | Large-scale decluttering | Built (semantic tiers + measured grid density), then retired in favor of the manual Map Complexity filter — see [Map filtering](#map-filtering) and [Appendix: Retired Automated Data Cleaning Pipeline](#appendix-retired-automated-data-cleaning-pipeline) |
| ~~Divided-road carriageway collapse~~ | Large-scale decluttering | Built, then retired along with the rest of the automated pipeline — see [Appendix: Retired Automated Data Cleaning Pipeline](#appendix-retired-automated-data-cleaning-pipeline) |

### P2

| Feature | Category | Notes |
|---|---|---|
| Google authentication | Identity management | Resolved 2026-07-08: Firebase Authentication (see [Authentication](#authentication)) |
| Cloud storage backend | Identity management / My Archives | Resolved 2026-07-08: Firebase/Firestore, chosen over Supabase and Appwrite because its free tier has no inactivity pause (see [Cloud storage](#cloud-storage)) |
| My Archives (save current map to cloud account; save/load/rename/delete) | My Archives | Distinct from Download (P1, local file only) — Save is for returning to in-progress work like manual POI/street-visibility edits. Format-versioning resolved as a manageable risk (2026-07-08): migrate legacy data if the save format ever changes, or avoid breaking changes in the first place — no dedicated migration system required as a feature |
| Settings persistence across sessions | Saving settings | Distinct from building the P1 settings dialog itself |

## Prioritized Research & Implementation List

**Phase 0 — Research spikes (do before committing to architecture)**

1. ~~Street-declutter algorithm: survey existing approaches~~ — done: replaced the 3-pixel-proximity placeholder with semantic importance tiers plus measured grid density; divided-road parallel-carriageway handling was resolved alongside it. That whole automated design was later built, tested, and retired in favor of manual filtering — see [Map filtering](#map-filtering) and [Appendix: Retired Automated Data Cleaning Pipeline](#appendix-retired-automated-data-cleaning-pipeline).
2. ~~Confirm Dot Pad hardware key numbering against SDK docs~~ — done: dots 3, 2, 5, 6 (left, up, down, right) for cursor movement is the pattern already implemented and reused from the DotSVG repo, not a placeholder.
3. ~~Decide the live-data architecture~~ — done: Nominatim + Overpass, confirmed as the app's data source (the experiment site validated this choice).

**Phase 1 — Core MVP (map up, no accounts, no full label content, no braille translator)**

4. Screen layout + address search → geocode → render SVG map, no BLE yet (validate the on-screen/screen-reader path works standalone — this mode is required, not optional, per Hardware requirement). Include the Chrome browser check/warning here, since it's cheap and gates everything BLE-related that follows.
5. OSM error reporting to the message field (Nominatim/Overpass failures) — build alongside the fetch/render path above, not bolted on later.
6. Connect/Disconnect Dot Pad buttons (SDK-provided) + BLE connection + tactile rendering of the SVG (segments, POI markers, cursor).
7. Cursor movement + hit testing + message display announcements, per [Message display architecture](#message-display-architecture). Writing to the braille message display at this phase uses plain 8-dot computer braille via the module already reused from DotSVG — no translator needed yet; see Phase 5.
8. ~~Command/hotkey mapping table~~ — done: cursor, pan, scale, and label-toggle bindings are all specified in [Command / hotkey mapping](#command--hotkey-mapping).
9. Pan behavior + scale combo box + scale change announcements, including the "Edge of Map" boundary behavior.
10. **Braille label zone toggles + viewbox resize/reposition logic** — moved up from Phase 4. Because label-zone presence/absence changes the viewbox, this needs to exist alongside core rendering; it can ship with empty or unrefined label zones while the content logic below (items 17–18) keeps maturing.

**Phase 2 — Filtering and decluttering**

11. ~~Implement the same-name roadway/pedestrian de-duplication rule.~~ — done, then retired (see [Appendix: Retired Automated Data Cleaning Pipeline](#appendix-retired-automated-data-cleaning-pipeline)).
12. ~~Implement divided-road carriageway-pair detection and centerline collapse.~~ — done, then retired (see [Appendix: Retired Automated Data Cleaning Pipeline](#appendix-retired-automated-data-cleaning-pipeline)).
13. ~~Implement tier assignment, grid-density calculation, and escalating tier-drop rendering.~~ — tier assignment survives (see [Street importance tiers](#street-importance-tiers)); the grid-density/escalation logic was built, then retired in favor of the manual Map Complexity filter (see [Map filtering](#map-filtering) and [Appendix: Retired Automated Data Cleaning Pipeline](#appendix-retired-automated-data-cleaning-pipeline)).

**Phase 3 — POIs, editing, and download**

14. Additional POIs, threshold-distance modal, POI list box and panning-on-select.
15. ~~Edit Map dialog~~ — done, though the final shape diverged substantially from this list's original "feature checkboxes, save/cancel" description during hands-on testing: see [Editing the Map](#editing-the-map) for the current POIs / Visible Streets / Hidden Features / Map Complexity design (clickable list items, no checkboxes, immediate effect, no Save/Cancel).
16. Download to a local `.svg` file — no account dependency, so it doesn't need to wait for Phase 5.

**Phase 4 — Braille label content (builds on the Phase 1 zone infrastructure)**

17. ~~Label abbreviation algorithm + uniqueness tracking.~~ — done: see [Label creation](#label-creation).
18. ~~Label placement geometry and the label-overflow rule~~ — done, including actual rendering (not just design): see [Label placement](#label-placement) for the full algorithm (tier-based priority, 45-degree angle rule, 2-pixel whitespace rule, fixed edge processing order, and the final leftover-room pass) and the braille-dot rendering into both the on-screen SVG and the tactile raster.
19. ~~Reconcile the Braille Labels dialog with the Settings checkboxes~~ — done: confirmed as one control (the dialog), mentioned redundantly in two places in this doc, not two separate controls.

**Phase 5 — Accounts, persistence, polish, and other external dependencies**

20. ~~Decide cloud storage backend~~ — done: Firebase/Firestore (see [Cloud storage](#cloud-storage)). Implementation itself still happens in this phase.
21. Google auth integration via Firebase Authentication (see [Authentication](#authentication)).
22. My Archives (save/load/rename/delete) — distinct from Download, which ships in Phase 3 as a P1 feature needing no account. Format-versioning risk is resolved as a policy (migrate legacy data or avoid breaking format changes), not a system to build — see [Open Questions & Critical Gaps](#open-questions--critical-gaps).
23. Settings persistence across sessions. Display Area scale presets are already fully defined (calculated from the Traditional Scale list, see [Settings](#settings)) — no longer an open item here.
24. Braille translator library selection/build (multi-code: formalizing 8-dot computer plus adding US uncontracted and contracted UEB) — moved from Phase 0. Baseline 8-dot computer output for the message display doesn't need this; it's only needed once the Braille code setting has more than one option.

## Appendix: Retired Automated Data Cleaning Pipeline

Everything in this appendix was designed, implemented, and shipped, then removed on the `experiment/manual-declutter` branch after hands-on testing against real Overpass data (Berkeley and Brooklyn test areas) showed it over-decluttered some areas, under-decluttered others, and silently dropped features (like sidewalks) the user wanted kept — with no way to correct a bad automated call short of adjusting a global tuning parameter and hoping. It was replaced by the fully manual model described in [Map filtering](#map-filtering) and [Editing the Map](#editing-the-map): everything Overpass returns is shown by default, and the user controls what's hidden, per-item and via the Map Complexity tier cutoff, with every action immediately reversible. [Street importance tiers](#street-importance-tiers) is the one piece of this that survived — tiers are still assigned to every way, just as inert data rather than an automatic-hiding trigger.

Kept here for reference in case any part of this design — the tiering scheme, the carriageway-collapse geometry, the density-based decluttering math — is worth reviving in some form, e.g. as an optional "auto-suggest" layer on top of the current manual controls, rather than a mandatory pipeline.

### Data ingestion and cleaning pipeline (retired)

Ran once per fetch (new location, new anchor POI, or panning past the current data boundary):

1. **Geocode** — Nominatim turns the entered address into coordinates for the anchor POI.
2. **Fetch** — Overpass returns named, highway-tagged ways with geometry inside the POI's bounding square.
3. **Group by name** — ways sharing a street name are bundled together for the checks below.
4. **Detect carriageway pairs** — within each name group, flag same-class, oneway, opposite-direction, nearby, overlapping ways as pairs (see [Divided-road carriageway collapse (retired)](#divided-road-carriageway-collapse-retired)).
5. **Roadway/pedestrian dedup** — footway/path ways are dropped when a roadway-class way shares their name (see [Same-name roadway/pedestrian de-duplication (retired)](#same-name-roadway-pedestrian-de-duplication-retired)).
6. **Collapse to centerline** — matched carriageway pairs are resampled and averaged into a single centerline way (see [Divided-road carriageway collapse (retired)](#divided-road-carriageway-collapse-retired)).
7. **Assign tier** — each remaining way gets a fixed importance tier from its highway class (see [Street importance tiers](#street-importance-tiers) — this step is the one part of the old pipeline still current).

### Rendering pipeline (retired)

Reran on every pan, zoom, or scale change — kept cheap by design, since it must never introduce a visible delay:

1. **Compute density** — a grid overlay counts distinct streets per cell across the current view.
2. **Escalate tier-drop** — lowest tiers are hidden and density is rechecked until it clears the threshold.
3. **Render** — a CSS class swap shows/hides ways by tier, with no per-element JS work.

Full detail in [Map density evaluation and tier-based decluttering (retired)](#map-density-evaluation-and-tier-based-decluttering-retired).

### Same-name roadway/pedestrian de-duplication (retired)

Derived from the "Unique streets" view built in the OSM Data Mine experiment (see `experiment/OSMExperiments.md`), which turned out to closely match what TMPAP4Dot itself needs when deciding which OSM ways represent a real, distinct street vs. redundant parallel infrastructure sharing that street's name.

**Rule:** for a given street name, if at least one of its ways is tagged with a "roadway" `highway` value, then ways tagged with a "pedestrian/path" `highway` value under that same name are dropped — treated as a sidewalk/path running alongside the road rather than a separate feature. Street names with no roadway-class way at all (a standalone path/greenway not paired with any road of the same name) are left untouched, keeping all their segments.

* Roadway classes: `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `unclassified`, `residential`, `living_street`, `service`.
* Pedestrian/path classes (suppressed only when paired with a roadway of the same name): `footway`, `path`, `cycleway`, `pedestrian`, `steps`.

**Why it was retired:** this rule is all-or-nothing per street name, with no geometric reasoning — a footway loses its name-match anywhere in the whole fetch box, even blocks away from the road it's nominally "redundant" with. This is exactly what caused the "dropped sidewalks I wanted to keep" complaint that started the manual-declutter branch. A later, tier-based generalization of this same rule was tried again as an explicitly toggle-able (not automatic) filter and was itself retired shortly after in favor of the current Visible/Hidden Streets model — see the `experiment/manual-declutter` branch's commit history (commits around `7324c55` and `05ed1b6`) for that intermediate step.

### Divided-road carriageway collapse (retired)

For divided/dual-carriageway streets (e.g., University Ave, Bancroft Way, MLK Jr. Way in the Berkeley test data), OSM correctly maps each direction of travel as its own separate way rather than one way per block — so a single visual block can produce multiple ways sharing the same name, running parallel and offset by a small distance (the median width). Left unhandled, this both clutters the display with redundant near-duplicate lines and skews the density calculation in [Map density evaluation (retired)](#map-density-evaluation-and-tier-based-decluttering-retired) — a two-way boulevard would count as two streets in a cell instead of one.

This is a named, standard cartographic-generalization operation — ESRI's Cartography toolbox calls it **"Collapse Dual Lines to Centerline,"** scoped explicitly to "regular, near-parallel pairs of lines, such as road casings," and explicitly *not* to multi-lane highways with interchanges, ramps, or merging tracks (that harder case has its own tool, "Merge Divided Roads," and is out of scope here — no interchange handling is planned).

**Candidate-pair detection**, run within each same-name group from the ingestion pipeline, in order of reliability:

1. **Explicit tag** — if both ways carry OSM's `dual_carriageway=yes` tag, treat them as a confirmed pair immediately.
2. **`oneway=yes` + opposite direction** — the standard OSM mapping convention when the explicit tag is absent: a real carriageway pair is each tagged `oneway=yes` and runs roughly antiparallel (the bearing of one way's start→end vector is roughly the reverse of the other's). A same-named way with no `oneway` tag is presumed to be an ordinary single-carriageway block, not a pairing candidate.
3. **Maximum separation** — among oneway/opposite-direction candidates, the perpendicular distance between the two ways must stay under a maximum-width threshold throughout — mirrors the "Maximum Width" parameter ESRI's own tool requires. Never got past "experimentally-tuned, 200ft" before the whole mechanism was retired.
4. **Consistent overlap** — the two ways must overlap substantially along their length with roughly constant separation, not just touch near an endpoint. This is what distinguishes a true parallel pair from two same-named ways that are just sequential blocks (touch, then diverge) or a coincidental name collision elsewhere in the fetch box.

**Collapse method:** for each matched pair, resample both ways to N evenly-spaced points along arc length, pair up corresponding points, and average each pair into one centerline vertex. This point-correspondence method was a deliberately lighter-weight substitute for the Delaunay-triangulation-based approach ESRI/Skeletron/PostGIS implementations use internally — appropriate because the real-world case was narrow (simple parallel pairs, not interchanges), and it avoided adding a geometry-library dependency.

A same-named way that didn't satisfy all of the candidate-pair checks (or carried no tag) was left alone. The shipped implementation went through several rewrites to fix real bugs found via local Node testing against cached real Overpass data — an inverted bearing-comparison formula, a one-directional distance check, and (the big one) naive union-find clustering catastrophically over-merging unrelated blocks into single 4000+ft "streets," fixed with greedy mutual-compatibility clustering. None of that engineering was wasted even though the feature was retired — the same "extract pure functions, test against real cached data in Node before touching the browser" workflow is still how this codebase debugs geometry work.

### Street importance tiers (not retired — see current section)

This part of the old pipeline is still live and unchanged in substance (same tier table) — see the current [Street importance tiers](#street-importance-tiers) section earlier in this doc. It's cross-referenced here only because the retired pipeline steps above depended on it; it was never itself removed.

### Map density evaluation and tier-based decluttering (retired)

Replaced an earlier placeholder rule (remove a street if it's within 3 pixels of another, non-intersecting street) with a density-driven approach: streets were only hidden once the currently-visible network was measurably too dense to distinguish by touch, not based on scale alone.

**Density parameter:** overlay a grid on the current viewbox, sized in `densityCellSize` (a display-pixel span, tuned to 20px — deliberately decoupled from the 3-pixel minimum-feature-separation constant used elsewhere, since this cell needed to be large enough to plausibly contain several distinct features, not just describe the closest two can sit). Rasterize each visible street's geometry into the grid and count **distinct streets per cell** — not raw way-segments, since one named street is often split into many OSM ways at intersections and would otherwise overstate its own density.

**Escalation:** compute the density parameter with all 7 tiers shown. If it's at or under the density threshold (tuned to 2), stop — show everything. If it's over, hide tier 7, recompute density over the remaining tiers, and check again. Repeat, dropping one tier at a time, until density clears the threshold or tier 1 is reached.

**Rendering:** each way was stamped with a `data-tier="N"` attribute at render time. A scale, pan, or zoom change that crossed a density threshold was applied as a single CSS class swap on the map container — the browser's own selector matching did the filtering, with no per-element JS loop.

**Why it was retired:** the user reported the automated tier-drop kicking in too early in some neighborhoods (Park Slope, Brooklyn) and too late in others (West Berkeley) — a single global `densityCellSize`/threshold pair doesn't fit every street pattern, and there was no way to correct a specific bad call without changing the threshold for the whole map. The replacement, Map Complexity, trades automatic density-awareness for a small, predictable set of manually-selected levels plus fully manual per-street override — see [Map filtering](#map-filtering).
