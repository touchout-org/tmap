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

The on-screen/ARIA side is never length-limited — the full message always shows there and is what speech announces. Only the physical Dot Pad's message display has an actual hardware limit (20 cells), so only its copy is paginated, via the **virtual message window** below.

#### Virtual message window

The Dot Pad's message display can only ever show 20 braille cells at once, but a message can be longer than that once translated (see [Braille translator](#braille-translator) — a given piece of text's cell count depends on which braille code is active, since contractions shrink it and capital/number signs expand it). Rather than truncating, the app keeps the full translated message in a virtual window and pages the device through it:

* Whenever a new message is set, it's translated under the currently active braille code (see [Braille translator](#braille-translator)) and the **first** 20-cell-or-fewer chunk is shown automatically.
* Dots 4+5+6 together show the next chunk; dots 1+2+3 together show the previous one.
* Chunks always break at a word boundary, never mid-word — the same word-boundary-preserving principle the old single-truncation behavior already used, just applied to every chunk in sequence rather than only the first one. (If a single word is itself longer than 20 cells, that one chunk is hard-cut, same graceful degradation the old truncation had.)
* If there's no next/previous chunk (already at the last/first one), the edge tone plays (see [Sound cues](#sound-cues)) but nothing else changes — no message-field update, no device write, the display just keeps showing what it already had.
* Pagination is always computed against the *translated* cell sequence, never the raw source text, since the two can have very different lengths. When the Braille Translation setting changes (see [Settings](#settings)), the currently-displayed message is re-translated under the new code and re-paginated from its first chunk — chunk boundaries don't line up between codes (a contraction-heavy code and a plain one chunk the same text differently), so there's no meaningful "same position" to preserve across a code change.
* There's no keyboard equivalent for paging — the on-screen/ARIA message is never truncated in the first place, so a keyboard/screen-reader user already has the complete message without needing to page through anything; the 20-cell limit is purely a physical-device constraint.

### Sound cues

Alongside the message field, a short synthesized tone is a secondary, non-verbal cue for certain events — Edge of Map (see [Pan Behavior](#pan-behavior), a beep when a pan is rejected) and the message display's own edge (see [Virtual message window](#virtual-message-window) above, a beep when paging past the first/last chunk) share the same tone. There's no standard way for a web page to trigger the OS/console bell, so cues are short tones generated with the Web Audio API (an oscillator, no external library or audio file needed) — this plays from the computer's own speakers, not the physical Dot Pad, which has no exposed beep/vibrate capability in the vendored SDK.

This is meant as a general pattern, not a one-off for Edge of Map specifically: sound is a plausible secondary cue for a variety of future events (e.g., a save completing, an error, reaching a boundary of some other kind) where a quick non-verbal signal is useful alongside — never instead of — the message field, which remains the single source of truth for what actually happened. Specific additional cues aren't designed yet; this section exists so the pattern (and the "no external library needed" fact) doesn't need rediscovering each time one comes up.

## Screen Layout

The default title is "DotTMAP — Tactile Street Maps for the Dot Pad." When a map has been loaded or created, the title of the current street map replaces the part of the title following the em dash (e.g., "DotTMAP — 123 Main Street, Springfield").

Top to bottom, left to right:

* At the very top of the page, before the H1: "Connect Dot Pad" button, then the **Main Menu** button. This pair replaced an earlier bottom-of-page "Controls" row (H3 + a flat row of buttons) as of 2026-07-15, prototyped first on the OSM Data Mine experiment site's own menu-button conversion — see [Main Menu](#main-menu) below for the interaction pattern and why it moved.
* H1: "Welcome to DotTMAP"
* Edit field: "Enter an address or location to get started:" [edit field], Search button. Once the anchor POI has been set, the label changes to "Enter another nearby address or location (optional)" — reflecting that the field is now for adding [additional POIs](#additional-pois) rather than starting the map.
* Below the search: H2 with the found address (anchor POI).
* Below the H2: the visual representation of the map.
* Immediately below the map: a print version of the message display (live ARIA region).
* To the right of the map: a group called "Move Map," arranged in a plus sign, with North, South, East, and West buttons.

### Main Menu

A WAI-ARIA "Actions Menu Button" opened by the "Main Menu" button at the top of the page (see [Screen Layout](#screen-layout)). Selecting an item takes effect immediately and closes the menu — there's no persistent "currently selected" indicator, since every item is an action, not a standing option. Contains, top to bottom:

* **"Customize Map"** — opens the dialog formerly labeled "Edit map..."; unchanged in every other respect, see [Editing the Map](#editing-the-map). Disabled (present but not activatable, `aria-disabled`, not native `disabled` — so it stays keyboard-navigable) until an anchor POI exists, same condition as before the menu conversion.
* **"Download SVG"** — see [Download to Local SVG](#download-to-local-svg). Same disabled-until-anchor condition as Customize Map.
* **"Display Preferences"** — opens the dialog formerly labeled "Settings..."; unchanged in every other respect, see [Settings](#settings). Always enabled.
* *(Planned, not yet built: a "Login" item for the eventual account/sign-in flow — see [Authentication](#authentication) — and, per the existing P2 plan, a "My Archives" item for cloud save/load — see [Saving and exporting](#saving-and-exporting). Neither is scheduled ahead of its existing Phase 5 placement; noted here only so the Main Menu's eventual full shape is clear.)*
* **"Disconnect Dot Pad"** — only present at all while a Dot Pad is connected; entirely absent (not just disabled) while disconnected. This is the counterpart to the main-screen "Connect Dot Pad" button (see below) — the two are never both present, and Disconnect never appears on the main screen itself.

"Connect Dot Pad" (from the Dot Pad SDK) lives on the main screen, not in the Main Menu, and receives keyboard focus automatically when the page first loads. It's shown only while disconnected; once connected, it's removed from the main screen entirely and "Disconnect Dot Pad" appears at the bottom of the Main Menu instead, per above. Connecting or disconnecting reports status through the message field, per [Message display architecture](#message-display-architecture).

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
| Next POI | `.` | dot 4 |
| Previous POI | `,` | dot 1 |
| Next message chunk | none | dots 4+5+6 |
| Previous message chunk | none | dots 1+2+3 |

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

Current object names are displayed in the message field and on the message display. If nothing is current, the message display is simply blanked — no "no street" or similar placeholder text, since an absence isn't worth interrupting/re-announcing over, especially while sweeping the cursor across open space between features.

We display only unique names for current objects: if several current objects share the same name, we display that name once. Names are run through [feature name compacting](#feature-name-compacting) before display, same as braille labels — this applies uniformly to streets and POIs alike, though for POIs specifically the name is already compacted once, at creation time (see [POIs](#pois)), rather than re-compacted here on every cursor move; a freeform name with no recognized type or ordinal word just passes through unchanged either way.

* If there is exactly one current object, the message display shows its compacted stem and type together, e.g. "9th St." or "Sacramento St."
* If there are multiple current objects, only the compacted stem of each is shown (no type), sorted alphabetically and joined by the word "and" — e.g. two current objects "Main Street" and "Spruce Street" always show as "Main and Spruce," never "Spruce and Main," regardless of which one the hit-test scan happens to reach first. This matters in practice: without the sort, the exact same pair of objects could re-announce itself with the names in the opposite order a pixel or two later as the cursor sweeps through an intersection, reading as two different reports for what's actually one unchanged situation. Dropping the type also keeps multi-name messages from growing unwieldy when several features are packed under the cursor at once. (Was joined by a literal ampersand, unsorted, until 2026-07-14; switched to the sorted word "and" once the braille translator made the message display's actual on-device rendering worth being deliberate about.)

We will refine this behavior as we experiment with the UI.

## Scale and Map Filtering

### Scale behavior

The scale appears on the screen as a combo box showing the value of the current scale.

* Scale values are always "X = Y," where X is the distance on the display and Y is the distance on the map. For example, "1 in = 300 ft" or "1 cm = 300 m." (An earlier design considered an alternate Display Area scale format — see [Appendix: Retired Display Area Scale Option](#appendix-retired-display-area-scale-option) — but Traditional Scale is the only format the app will ever offer.)
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

If a pan would leave a POI marker's footprint straddling the boundary between the map and an active label zone — rendering it half in the map, half in the zone — the pan target is nudged by a few pixels along the pan's own axis, just enough to clear the marker to whichever side (fully back inside the map, or fully past the boundary into the zone) is the smaller move. This only applies where a label zone is actually active on that edge; a marker running past the edge of the map on a side with no zone is left alone, since there's no zone for it to visibly invade there.

## POIs

The location edit field at the top of the main window is used to begin the DotTMAP experience. Entering a location returns the anchor POI, generates a map centered on that point, and adds a solid circle marker to that POI (currently a 3x3 square, like every other POI marker — see the note under [SVG Display Requirements](#svg-display-requirements)).

### Additional POIs

Additional POIs can be added to a map by entering additional locations. Each new POI gets a triangle marker (currently a 3x3 square, like every other POI marker — see the note under [SVG Display Requirements](#svg-display-requirements)).

POI names are run through [feature name compacting](#feature-name-compacting) once, at creation time — not left raw and compacted later at each display site. This applies to every way a POI can be created: additional POIs added via search, Drop Pin custom POIs, and the anchor POI itself. The compacted name is what's stored and reused everywhere the POI is later shown or spoken (the POI list box, cursor hit-test messages, the initial "found it" announcement).

If a subsequent POI location is more than [threshold distance] away from the anchor POI, we get a true modal dialog that says "The new location is [distance] away from [anchor POI]. That's too far away for a single map." Buttons are "Show [new POI]" and "Cancel." If they select the new location, the old map is discarded and the new POI becomes the anchor with a new map generated around it.

If a subsequent POI is less than [threshold distance] away, the new POI is added to the current map and the map pans to center that new POI. Panning behavior automatically happens, announcing the distance and direction from the anchor POI. Multiple additional POIs can be added to a single map.

As POIs are added to the map, the locations are added to a list box on the left of the page. Selecting an item from the list box — live while arrowing through the options, or on a click — pans to that POI and moves the cursor there. This holds even when the anchor is the only entry in the list (no additional POIs added yet): focusing the list box in that case snaps straight back to the anchor, the same as selecting it would, since a single-entry list box has nothing to arrow or click *to* that would otherwise trigger the pan.

The `.`/`,` hotkeys (dot 4 / dot 1 alone on the Dot Pad — see [command mapping](#command--hotkey-mapping)) step forward/backward through the same list without needing focus to be in the list box itself — the same as arrowing through it directly, wrapping at either end rather than stopping (advancing past the last entry lands back on the first, and vice versa), and updating the list box's own displayed selection to match.

**Navigating among POIs this way announces just the destination POI's name — not a distance/direction from the anchor.** This is deliberately different from an explicit pan or a newly added POI (both of which do announce "[distance] [direction] of [anchor POI]," per [Pan Behavior](#pan-behavior)): moving among POIs you already know about is a "go to X" action, where the useful information is which POI you're now at, not how far it is from the anchor.

### Custom POIs

A "Drop Pin" button next to the POI list box (hotkey `a`) opens a "Custom POI" dialog: a "POI Name:" edit field plus OK and Cancel buttons. Pressing Enter (or clicking OK) adds a new POI at the cursor's current position, using the entered name; pressing Escape (or clicking Cancel) closes the dialog without adding anything. A blank name is rejected by the field's own required-field validation, without needing a submit.

**Name suggestions from nearby OSM data, added 2026-07-15.** Opening the dialog immediately queries Overpass for every feature within a real-world radius of the cursor's current position, tagged as either an address (`addr:housenumber`, regardless of what else it's tagged) or one of the standard POI tag families (`amenity`, `shop`, `tourism`, `office`, `leisure`) — explicitly not `highway=*` or other street/path features, which are fetched separately (see [Data sources](#data-sources)). The radius is `CURSOR_HIT_RADIUS` (the same fixed-in-dots value used for street hit-testing, see [Cursor and hit testing](#cursor-and-hit-testing)) converted to real-world feet at the current Scale — it shrinks and grows with zoom, independent of which label zones happen to be active (the dot-to-feet ratio itself doesn't change with zone state, only the total visible area does).

Results are sorted alphabetically by display name — a feature's own `name` tag if it has one, else a constructed "[house number] [street]" for an address-only feature with neither. The first result populates the edit field automatically as soon as the query returns; while the dialog is open, Up and Down arrow keys step forward/backward through the full result list **without wrapping** (a no-op at either end), replacing the edit field's contents with each candidate's name in turn. The field can still be freely retyped at any point, overriding whatever a suggestion (or the user's own prior typing) put there. A suggestion is purely a naming aid: confirming with OK **always** places the new POI at the cursor's own current position, per an explicit design decision, never at a suggested candidate's own (possibly slightly different) real-world coordinates — matching the pre-existing Drop Pin placement behavior exactly, unchanged by this addition. If the query is still in flight, returns zero results, or fails outright, the dialog shows an appropriate status message ("Loading nearby places…" / "No nearby places found." / "Could not load nearby places.") and the field is simply left for fully manual entry, same as before this feature existed.

Arrow keys are already prevented from moving the map cursor while this dialog is open, via the existing global hotkey guard that blocks whenever a form control (the edit field, an `INPUT`) has focus — no separate blocking logic was needed for that.

A custom POI is added through the same path as any other additional POI — it shows up in the POI list box, the Edit Map dialog's POIs group, on-screen rendering, cursor hit-testing, and the tactile raster exactly like an address pulled from OSM, with the same short-address-style POI conventions (see [Additional POIs](#additional-pois)) except its name is whatever the user typed rather than a geocoded address. POI names are not required to be unique — this matches every other POI-naming path in the app, none of which enforce it either.

## Editing the Map

Clicking "Customize Map" (in the [Main Menu](#main-menu); formerly its own "Edit map..." button) opens a dialog with four expandable, collapsible groups (native disclosure widgets, each with an `<h4>`-wrapped label so the group names stay heading-navigable while expanded): **POIs**, **Visible Streets**, **Hidden Features**, and **Map Complexity**. There is no Save/Cancel step — every action in this dialog takes effect immediately and is reflected on the map, the tactile raster, and the message field right away.

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

Because the presence or absence of each label zone changes the viewbox's size and position, the toggle infrastructure itself (the four checkboxes, and the viewbox resizing/repositioning that reacts to them — see [Label placement](#label-placement) for the exact dot-column/row math) was built early, alongside core map rendering, rather than deferred to the end. The label *content* — which streets get labeled and where, abbreviation collision handling, the oblique-angle rule, the overflow rule, and the actual braille-dot rendering into the zones on both the on-screen SVG and the tactile raster — is now fully implemented too, following the design below.

#### Feature name compacting

A general-purpose utility, not specific to braille — it also feeds the planned SVG export's per-street metadata (see [Saving and exporting](#saving-and-exporting)). OSM's `name` tag is consistently the fully-expanded, non-abbreviated form of a street name (confirmed empirically against this project's own cached Overpass data: 1073 distinct named ways checked, zero already using an abbreviated suffix). Neither of OSM's other name-related fields reliably fixes this, so compacting is done directly from `name` with two purpose-built lookups, not sourced from an OSM tag:

* `alt_name` is present on very few ways and isn't reserved for compact forms specifically — it can just as easily hold a genuinely different historical/alternate name for the street, not a shorter version of the same one, so it isn't safe to substitute blindly.
* `tiger:name_type` (from the 2007 TIGER/Census import) is present on only around 60% of ways and is measurably inconsistent where it does exist — e.g. some ways named "...Drive" are tagged `Rd`, some named "...Street" are tagged `Blvd`. Useful as a hint, not trustworthy as a source of truth.

Takes a street name, returns `{ stem, type }`:

1. **Type suffix** — if the name's trailing word matches a known street-type word (Street, Avenue, Boulevard, Drive, Road, Lane, Court, Circle, Place, Terrace, Way, Highway, and similar), `type` becomes that word's standard abbreviation (St., Ave, Blvd, Dr, Rd, Ln, Ct, Cir, Pl, Ter, Way, Hwy, ...) and `stem` becomes the name with that trailing word removed. If nothing matches, `type` is empty and `stem` is the full name.
2. **Ordinal numbers** — independently of the type-suffix step, any ordinal number word found within `stem` (First through at least the 90s, including compounds like "Twenty-First") is converted to its digit+suffix form (Ninth -> 9th, Twenty-First -> 21st). If none is found, `stem` is left as-is.

Both steps degrade gracefully: a name with neither a recognized type suffix nor an ordinal word passes through completely unchanged (`stem` = the full name, `type` = empty) — nothing regresses for names this can't help with.

**Feeds directly into [Label creation](#label-creation) below and into [cursor hit-test messages](#cursor-and-hit-testing).** The two consumers join `stem` and `type` differently, deliberately: hit-test messages for a single current object space-join them ("9th" + " " + "St" -> "9th St"), so the vowel-stripping-style word logic that could apply to a spoken/brailled message never spuriously merges the boundary. Label creation instead concatenates them directly with no space, specifically so a doubled letter at that boundary collapses like any other doubled letter rather than being protected — see Label creation's own steps for the full reasoning.

#### Label creation

All labels are unique 3-character abbreviations created from the compacted street name (see [Feature name compacting](#feature-name-compacting) above). No two streets on the map, even if they're not both being displayed currently, may have the same abbreviation. Labels are always in lowercase 8-dot computer braille, and only include alphanumerics — no punctuation except for a dash if necessary. The 3-character limit is hard and fast, no exceptions; if necessary, pad the end of the label with dashes.

The abbreviation algorithm goes like this:

1. Take the compacted name's stem. If its first word is a fully-spelled-out compass direction (North, Northeast, East, Southeast, South, Southwest, West, Northwest), replace that word with its short form (n, ne, e, se, s, sw, w, nw respectively). A street's own descriptive name never legitimately contains a second, independent direction word, so only the stem's leading word is ever checked.
2. Concatenate the (possibly direction-abbreviated) stem directly with the compacted type — no space at the join, unlike the space-joined form used for cursor hit-test messages. Any internal spaces the stem itself has (e.g. "Santa Fe") are still there at this point; only the stem/type boundary itself loses its separator.
3. Strip all vowels, one word at a time (word boundaries are still whatever spaces remain from step 2), unless the word is a single-letter vowel word (such as "A" or "E.") or one of the two-letter direction abbreviations that contains a vowel ("ne", "se") — both are kept whole rather than stripped.
4. Strip all remaining spaces and punctuation, collapsing the name to one continuous string.
5. Collapse every run of 2 or more identical letters (case-insensitive) down to a single occurrence, anywhere in the string — including right at the former stem/type boundary, now that concatenation in step 2 no longer protects it. This is deliberate: a doubled letter there is exactly as wasteful a phonetic cue as a doubled letter anywhere else in the name. Runs of the same *digit* are exempt and always left alone — the "11" in "11th" is real information, not a doubled-letter artifact.
6. Make all letters lowercase.
7. **Digit-anchored labels.** Numbered streets (after [Feature name compacting](#feature-name-compacting)'s ordinal conversion) are common enough, and their digits meaningful enough, that a generic character-window walk over them is exactly the kind of arbitrary, hard-to-interpret result this whole algorithm is meant to avoid — keeping the actual number visible in the label is far more useful than any incidental 3-character window of the surrounding letters. If the string contains a run of 2 or more consecutive digits (there's at most one — ordinal conversion only ever produces a single digit run per name, and neither direction nor street-type abbreviations introduce digits), try a label anchored on those digits before falling through to step 8:
   * Exactly 2 digits: the pair itself is the anchor.
   * 3 or more digits: try the rightmost 3 digits alone, with no letter at all — e.g. "West 130th Street" -> "130". If that's already taken, drop to the rightmost 2 digits and use them as the anchor instead.
   * With a 2-digit anchor (either case above): complete it into 3 characters by adding exactly one adjacent letter from the surrounding string. Try leading characters first, walking forward — left to right, from the very start of the string toward the digits, so the earliest and most identifying characters are tried before whatever happens to sit immediately next to the number. Only once every leading character is exhausted does the search move to trailing characters, nearest-first. (Real example: two ways at the same numbered cross street, distinguished only by an "(upper)"/"(lower)" suffix on one of them — "West 134th Street" claims the bare number "134" first; "West 134th Street (upper)" then drops to the rightmost 2 digits and finds "w34" on its very first leading-letter attempt, from the direction-abbreviated "w" at the start of its own string.)
   * If every digit-anchored attempt collides — or the string has 0 or 1 digits, in which case this step doesn't apply at all — fall through to step 8.
8. Take the first three characters of the string and check for uniqueness.
9. If not unique, keep the first two characters fixed and walk the third character forward through the rest of the string, one character at a time, until a unique 3-character abbreviation is found. This is a deliberate choice, confirmed against real examples during implementation: keeping the shared prefix intact and varying only the one character that actually needs to differ keeps related street names (e.g. "University Avenue"/"University Drive"/"University House Way", or "Virginia Gardens"/"Virginia Street") looking and feeling similar, rather than sliding the whole 3-character window to a different, unrelated-looking stretch of the name.
10. If step 9 exhausts the string without finding a unique label, try a different anchor: keep the first and last characters fixed and walk the *middle* character forward through the string's interior characters instead.
11. If step 10 exhausts the string too, keep the first two characters fixed and try single digits 0-9 as the third character instead.

#### Label placement

The Labels dialog has 4 checkboxes to place labels at the top, bottom, left, and/or right of the display. These label regions are like windows adjacent to the SVG viewbox. Wherever a street intersects an active edge of the viewbox is a possible label point, subject to the rules below.

**Some streets will not get a label — that's an accepted outcome of the algorithm below, not an error state.** There is no "some streets not labeled" indicator; a street that doesn't fit is simply omitted. This resolves the label-overflow question (previously open gap #1).

**Rules:**

* Labels must always be centered, either vertically or horizontally, on the point where the street intersects the closest active edge.
* Street label priority uses the same [street importance tiers](#street-importance-tiers) established for large-scale decluttering (motorway/trunk highest, standalone footway/path lowest) as the primary sort. Within a tier, the street with more visible segments on the current display wins — a rough proxy for how substantial a street actually is on screen right now, since a real through-street naturally accumulates more OSM way-segments (split at every intersection) than a short stub does. Position along the edge (left-to-right / top-to-bottom) is the final, deterministic tie-break when tier and segment count both match. (Segment count was the original, sole priority rule early in this project, then replaced entirely by tiers; it's back now as tier's tie-break, not as tier's replacement — a pure edge-crossing-length minimum was tried in between and dropped, since it measured the one segment touching an edge rather than the street's overall presence, wrongly excluding substantial streets whose specific crossing segment happened to be short.)
* Labels should only be applied to streets that intersect the active edge at more than 45 degrees. A street that intersects at 45 degrees or less never gets a label on that edge — it's likely to cross an adjacent edge at a more oblique angle, where a label is more appropriate.
* There must be at least 2 display-pixels of whitespace between a label and the map, and between adjacent labels. The map-side padding is the fixed 2-dot-column/2-dot-row figure already built into the zone-sizing math below; between two *adjacent labels*, the 2-pixel gap is measured from the edge of one label's actual rendered content to the edge of the next -- 8 dots wide for a top/bottom label (2 dot-columns/character x 3 + 1-dot kerning x 2, the same figure the zone-sizing math below derives), 3 dots tall for a left/right one (just the braille dot rows, no padding) -- not from the wider zone-depth figure (10/5 dots), which already has the map-side padding baked in and would otherwise double-count it as inter-label spacing too.
* The four corners are shared, contested space between the two zones that meet there (e.g. the top-right corner is shared by the top and right zones), not owned outright by either one -- part of the "no wasted space" principle behind this whole algorithm. Each corner holds exactly one label's worth of physical room. Whichever of the two zones is processed first in edge order (see the placement algorithm below) gets first claim on a shared corner if it has a candidate that needs it; if that zone doesn't need the corner, the other zone sharing it is free to use it instead. A corner is only real, physical room when *both* contributing zones are active — with either one off, there's no gap there to share.

**Placement algorithm**, run after the map and its streets are otherwise finalized for the current view:

1. Process the four active edges in a fixed order: top, right, bottom, left. An edge the user has turned off via its checkbox is skipped entirely.
2. Within each edge, walk street-importance tiers from most to least important. Within a tier, place candidate labels ordered by visible segment count (more wins), then by position — left-to-right along the top/bottom edges, top-to-bottom along the left/right edges — as the final, deterministic tie-break.
3. A candidate is skipped on this edge if it can't fit — it violates the angle rule above, or the 2-pixel whitespace rule against the map, an already-placed label on this edge, or a corner already claimed by the adjacent edge sharing it (see the corner-sharing rule above).
4. A street already labeled on an earlier-processed edge is skipped on every later edge — the primary pass gives each street at most one label, on whichever eligible edge is processed first.
5. **Final pass:** once all four edges have been walked once, make one more pass around them in the same order, filling any leftover room. This pass isn't limited to duplicating existing labels — it can also give a first label to a street that was skipped everywhere in the primary pass. Any candidate that fits the remaining space is eligible, still worked in tier and segment-count order.

Since all labels are exactly 3 characters, the left and right label columns need exactly 10 dot columns each: 2 dot columns per character x 3 characters = 6, plus 1 column of kerning between characters 1–2 and 2–3 = 2, plus 2 dot columns of padding between the label and the viewbox = 10 total. The horizontal labels at top and bottom need exactly 5 dot rows: 3 for the braille dots, plus 2 for the padding between the text and the graphic.

When any of the left, right, top, or bottom labels are turned off, the viewbox expands to use that space for the map.

**Rendering differs between the on-screen SVG and the tactile raster sent to the Dot Pad.** The physical device always receives real 8-dot computer braille, per the label-creation/placement design above. The on-screen SVG instead shows each label as plain print text, positioned within the same footprint the braille block would occupy — so a sighted person looking at the screen and a blind person feeling the Dot Pad can discuss the same map using the same labels, each in the form that's actually readable to them.

### Braille translator

Implemented as `braille-ueb.js`, a standalone module used only by the message display — street labels always render as 8-dot computer braille via NABCC regardless of this setting (see [Rendering differs between the on-screen SVG and the tactile raster](#label-placement) above), since they're a separate rendering pipeline with its own uniqueness/collision requirements that has nothing to do with literary braille codes.

**Data source:** [liblouis](https://github.com/liblouis/liblouis) (LGPL 2.1+), the most widely used open-source braille translator. Rather than vendoring liblouis itself or reimplementing its general-purpose translation engine, the specific data DotTMAP needs was hand-extracted from three of its table files:

* `tables/latinLetterDef6Dots.uti` — the 26 lowercase letter dot patterns.
* `tables/en-ueb-chardefs.uti` — digit shapes (the `litdigit` opcode — the classic a-through-j-shaped numeric forms used after the number sign, not the differently-shaped `digit` opcode, which liblouis uses for an unrelated purpose), the number sign, the capital sign, and the handful of punctuation marks this app's own message-display text actually uses (space, `. , ' - … : & = ! ?`).
* `tables/en-ueb-g2.ctb` — Grade 2 contractions, filtered down to the subset expressible as a pure word-position rule (liblouis opcodes `always`/`word`/`begword`/`endword`/`midword`/`midendword`/`sufword`) rather than its context-dependent `match`-opcode rules (regex-like lookaround/quote/emphasis handling this app's plain message text never needs) — plus the 23 "alphabetic wordsigns" (as, but, can, do, every, from, go, have, it, just, knowledge, like, more, not, people, quite, rather, so, that, us, very, will, you), which liblouis only exposes for forward translation via a `match` rule (to additionally handle optional `'d`/`'ll`/`'re`/`'s`/`'t`/`'ve` suffixes this app doesn't need) but are far too common/valuable to drop, so they're pulled back in as their own small category via their simpler back-translation-only counterparts. liblouis's `nofor`-prefixed lines (back-translation only) are excluded entirely, since this app only ever translates forward (print to braille) — **except** where a `nofor` line's own text+position+dots also turns out to match some `match`-opcode line elsewhere in the table (ignoring `match`'s trailing `b` pass2-cleanup marker, itself back-translation-only): that agreement confirms the contraction really is used for forward translation too, just expressed via `match` for reasons that don't matter here, so it's recovered and added using the position liblouis's own `nofor` declaration names. This cross-reference is shape-agnostic — it doesn't require parsing `match`'s pre/post pattern syntax at all — and is how `in`, `en`, `ing`, `tion`, `ment`, `ness`, `ance`, `ence`, `ful`, `ity`, `less`, `ong`, `ound`, `ount`, `sion`, `there`, `those`, and `bb` (a doubled-letter sign that only applies strictly between other letters — its siblings `ea`/`cc`/`ff`/`gg` were checked the same way and have no forward `match` rule at all in this table, i.e. genuinely back-translation-only, correctly left out) were found and added after initially being missed — an early version of this extraction only looked for two specific `match` pattern *shapes* by eye, which missed several real contractions and briefly mis-classified "ing" (which has two different `nofor` declarations for two different uses of "ing," and a same-key-overwrites-previous bug matched the wrong one). liblouis's own `match` rules for these do encode one further, genuine restriction the position-only extraction doesn't capture — most won't fire when the contraction would be a standalone word by itself with nothing else attached (e.g. the literal text "en" on its own) — accepted as a deliberate simplification, since none of these letter groups are real standalone English words that could plausibly appear alone in this app's actual message text.
* A separate, larger category liblouis calls "short-form words" — common whole words (e.g. "about," "after," "him," "his," "out," "said," "such," "your," and hundreds more, many of them longer compound words) that get their own contracted spelling — was found by the same cross-reference method but not yet added: several hundred entries, a bigger scope decision than fixing the missing general contractions above, deferred pending a decision on whether it's worth the added table size for this app's actual content.

**Grade 1 (uncontracted)** handles capitalization, numbers, and punctuation, with no contractions at all: each letter maps directly to its dot pattern; a capital letter is preceded by the capital sign (dot 6), one per capital letter — no capsword-phrase compaction, since this app's message text is never long stretches of capitals; a run of digits is preceded by the number sign (dots 3-4-5-6) and each digit uses its literary (`litdigit`) shape; unmapped characters fall back to a blank cell rather than erroring.

**Grade 2 (contracted)** builds on Grade 1: text is split into words (letter runs), numbers, and other characters (space/punctuation), each handled independently. Within a word, contractions are resolved **longest-match-first**: at each position, the longest candidate substring whose word-position rule is satisfied (whole word, word-initial, word-final, mid-word only, etc.) wins; if nothing matches at a position, that one character falls back to its plain Grade 1 letter. A small number of contraction entries carry no dot pattern at all (liblouis's `=` value) — these are specific-word overrides that force plain spelling to suppress a contraction that would otherwise misfire (e.g. certain "co-" prefixed words where the generic "co" sign is wrong for that particular word); the translator honors these by spelling just the overridden substring in plain letters, same as any other unmatched position. Capitalization is applied once per word (a single capital sign before the whole translated word, if the word's first letter was capitalized) rather than per matched contraction — correct and sufficient for this app's actual content (plain title-case or lowercase words), though not a full implementation of UEB's per-letter capitalization-within-a-contraction rules for arbitrary mixed-case text.

## Settings

Default values in [brackets]. Before settings are implemented, we set default values but use variables to ensure settings-ready architecture.

The Settings dialog (opened via "Display Preferences" in the [Main Menu](#main-menu), formerly its own "Settings..." button) is the first of these to get a real control, and establishes the pattern the rest will follow when built: like Customize Map (fully live-apply, no Save/Cancel step), **every control in this dialog applies immediately on change** — there is no staging, no commit step, and nothing to discard. Opening the dialog only syncs each control's displayed value/checked state to match current app state. The dialog has a single **Done** button that just closes it; there is no OK or Cancel, since a change already took effect the moment it was made.

(Earlier in development, Braille Translation was staged behind OK/Cancel while the other controls were live-apply — a deliberate divergence at the time. That distinction was removed once Braille Translation itself became live-apply, since a staged/live-apply split within one dialog was more confusing than useful. Treat live-apply as the model for any future Settings control, not staged.)

The dialog is organized into sub-sections, each under its own heading:

* **"Braille Options" heading**:
    * Braille Translation: 8-dot computer braille, English Uncontracted, [English Contracted] — implemented, live-apply. Only affects the message display; see [Braille translator](#braille-translator) above for what each option actually does and where the data comes from.
    * The same 4 label-position checkboxes (left, right, top, bottom — [none checked]) previously exposed by a standalone "Braille Labels..." button/dialog in Screen Layout; that separate button and dialog are gone, this is now their only home. Live-apply, same as Braille Translation above.
* **"Distance and Scale" heading**:
    * Units: Metric / [Imperial] — implemented, live-apply. Affects both the Scale control immediately below and every place a distance from the anchor POI is reported (explicit panning, panning to a newly added POI, and the "too far for one map" prompt — see [Pan Behavior](#pan-behavior) and [Additional POIs](#additional-pois)):
        * **Imperial** uses inches (scale), feet, and miles: distances are reported in feet up to 1000 ft, then in miles (rounded to the nearest tenth) beyond that.
        * **Metric** uses centimeters (scale), meters, and kilometers: distances are reported in meters up to 500 m, then in kilometers (rounded to the nearest tenth) beyond that.
    * Scale: implemented, live-apply, same as every other control in this dialog. Presets switch between two 9-entry ladders depending on Units:
        * **Imperial**: 1 in = 100, 200, 300, [400], 500, 1000, 1500, 2000, 5000 ft (the original ladder, moved here from a standalone combo box next to the H2 in Screen Layout).
        * **Metric**: 1 cm = 10, 25, 35, [50], 60, 120, 180, 250, 600 m. Chosen as the closest clean round numbers to each Imperial preset's actual real-world footprint (accounting for the fixed inch-to-cm ratio of the physical display, not a naive number-for-number conversion) — see the code comment above `SCALE_PRESETS_M` in `app.js` for the exact math. **By explicit user decision, the two ladders are independent round-number sets, not exact conversions of each other**: the same preset index can describe a slightly different real-world map footprint depending on which unit system is active, and switching Units while a map is showing re-renders it at the new effective footprint for the current preset index.
    * Pan Amount: [1/4], 1/2, 3/4, 1 — implemented, live-apply. A single value shared by both horizontal and vertical pans (an explicit user decision, not independent per-axis settings), in units of the **current viewbox's** width/height — not the fixed physical display. Since active label zones shrink the viewbox (see [Braille labels](#braille-labels)), the real-world distance covered by a pan shrinks right along with it: e.g. with the Top zone active (reducing the display's usable height), a vertical pan covers proportionally less real-world distance than with no zones active, at the same Pan Amount and Scale setting. The actual real-world distance also still varies with the current Scale, same as before this was configurable. Changing it announces "Pan amount: [value]" through the message field; takes effect on the next pan, nothing on screen changes immediately.
    * POI distance threshold: [1 mile], 2 miles, 3 miles — not yet implemented.

## Download to Local SVG

"Download SVG" (in the [Main Menu](#main-menu)) saves the current map as a local `.svg` file, immediately, no account and no prior save required — distinct from "My Archives" (see [Saving and exporting](#saving-and-exporting)), which is a full cloud-backed save/load system gated behind sign-in.

### Scope

The export represents the *full fetched extent* around the anchor — the same square region [Data sources](#data-sources) fetches, not the current on-screen pan/scale/viewport. Placement, panning, and scale are all properties of how the map happens to be displayed right now, not properties of the underlying map data, so none of them affect what's in the file:

* **Streets and pathways**: every way not explicitly hidden via [Editing the Map](#editing-the-map)'s Hidden Features list. Map Complexity does **not** filter the export — a street hidden only by the current complexity cutoff is still included, since complexity is a display-time simplification, not a statement about what belongs in the data. (This means the export's own street filter checks only `hiddenStreetNames` — it does not reuse the app's `visibleWays()`, which also applies the Map Complexity tier cutoff.)
* **POIs**: every POI not explicitly hidden (the anchor plus any additional POIs), each carrying its name.
* **No label placement, dot patterns, or label-zone geometry** are included at all — a renderer that opens this file later is free to make its own placement decisions for whatever labeling scheme it wants to use, if any. The abbreviated label each street currently resolves to *is* included as metadata (see below) — it's the placement of that label that's excluded, not its existence.

### Coordinate system

The export projects lat/lon the same way the on-screen map does, but scoped to the full fetched square (`lastBbox`) rather than the current viewport, so the file always shows the complete fetched area regardless of whatever's currently panned into view. The canvas is a plain square viewBox in arbitrary round units (`0 0 1000 1000`) — unlike the on-screen SVG, this has no physical Dot Pad audience, so nothing here is tied to the device's dot-grid conventions.

Streets and POIs render with simple default styling (thin gray stroke for streets, small dark squares for POIs, roughly matching the on-screen look) so the file is directly viewable and useful on its own, not just as a data container for a custom renderer.

### Street metadata

Streets are grouped by the combination of **(name, highway class, tier)** — not by name alone — so a name that legitimately spans more than one highway class or tier (e.g. a mix of residential and footway segments sharing a name) gets a separate group per combination, rather than merging data that doesn't actually describe the same kind of way. Each group is a `<g>` element wrapping that group's polylines, carrying:

* `data-name` — the full OSM `name`, unmodified
* `data-stem` — the compacted stem (see [Feature name compacting](#feature-name-compacting))
* `data-type` — the compacted street-type abbreviation
* `data-label` — the abbreviated label this name currently resolves to via [Label creation](#label-creation)'s algorithm. Uniqueness is computed the same way as always — across every name in the full fetch, not just the exported subset — so this always matches whatever label would actually show on screen or on the Dot Pad if braille labels were turned on right now, even for a street that's otherwise excluded from being labeled today for unrelated reasons (e.g. it lost a placement collision).
* `data-highway` — the raw OSM `highway` tag value
* `data-tier` — the numeric [street importance tier](#street-importance-tiers)

### POI metadata

Each visible POI is a marker element carrying `data-name` — its name as stored, which is already compacted (see [feature name compacting](#feature-name-compacting)) as of creation time, not the raw geocoded/OSM name. POIs don't get separate compacted stem/type/label metadata beyond that one stored name — they have no highway class or type suffix concept the way a street does.

### File naming

Saved as `[anchor short address].svg` (sanitized for filesystem-safe characters) — the same short-address style already used for spoken/brailled POI references elsewhere in the app (`formatShortAddress`). There's no user-provided "map name" for this quick-download path, unlike My Archives.

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

Also resolved as of 2026-07-08: saved-map versioning is a manageable risk, not a blocking design gap — the app will either migrate legacy archive data if the save format ever changes, or take care not to make changes that would break compatibility with existing saves; no dedicated migration system is required as a feature. (This entry originally also resolved a since-retired Display Area preset-values question — Display Area itself was dropped entirely in 2026-07-15, see [Appendix: Retired Display Area Scale Option](#appendix-retired-display-area-scale-option).)

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
| Connect/Disconnect Dot Pad buttons (SDK-provided) | Presentation | Connect Dot Pad sits on the main screen; Disconnect Dot Pad sits at the bottom of the Main Menu instead of beside it — see [Main Menu](#main-menu). Superseded the original flat "Controls" row entirely, 2026-07-15 |
| BLE connection + tactile rendering on Dot Pad | Presentation | |
| Cursor movement + hit testing + message display | Interaction — pointing | |
| Pan controls (on-screen buttons + hotkeys) | Interaction — panning | |
| Scale combo box + scale change (Traditional Scale) | Interaction — zooming | Traditional Scale is the only scale format the app will offer — see [Appendix: Retired Display Area Scale Option](#appendix-retired-display-area-scale-option) |
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
| Settings dialog (~~units~~, ~~pan amount~~, POI threshold) | Settings | Units (Imperial/Metric) and Pan Amount both done — see [Settings](#settings). Scale type/Display Area dropped entirely, not just deferred — see [Appendix: Retired Display Area Scale Option](#appendix-retired-display-area-scale-option). Remaining item built against the default-value variable the Settings section already calls for; *persisting* settings across sessions is a P2 item, see below. An earlier, minimal experimental tuning-fields surface for the (now-retired) automated decluttering/collapse parameters existed briefly before this dialog — see [Appendix: Retired Automated Data Cleaning Pipeline](#appendix-retired-automated-data-cleaning-pipeline) |
| ~~Edit Map dialog~~ | Map editing | Done, in a different shape than originally planned here — see [Editing the Map](#editing-the-map) |
| ~~Download to a local `.svg` file~~ | Downloading | Done — distinct from full My Archives (P2), no account needed; see [Download to Local SVG](#download-to-local-svg) |
| ~~Braille translator (multi-code: US uncontracted, contracted UEB)~~ | Braille translation | Done — see [Braille translator](#braille-translator); built ahead of Phase 5 (needed as a prerequisite for the rest of Settings, not gated on accounts/auth) |
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
16. ~~Download to a local `.svg` file~~ — done, see [Download to Local SVG](#download-to-local-svg).

**Phase 4 — Braille label content (builds on the Phase 1 zone infrastructure)**

17. ~~Label abbreviation algorithm + uniqueness tracking.~~ — done: see [Label creation](#label-creation).
18. ~~Label placement geometry and the label-overflow rule~~ — done, including actual rendering (not just design): see [Label placement](#label-placement) for the full algorithm (tier-based priority, 45-degree angle rule, 2-pixel whitespace rule, fixed edge processing order, and the final leftover-room pass) and the braille-dot rendering into both the on-screen SVG and the tactile raster.
19. ~~Reconcile the Braille Labels dialog with the Settings checkboxes~~ — done: confirmed as one control (the dialog), mentioned redundantly in two places in this doc, not two separate controls.

**Phase 5 — Accounts, persistence, polish, and other external dependencies**

20. ~~Decide cloud storage backend~~ — done: Firebase/Firestore (see [Cloud storage](#cloud-storage)). Implementation itself still happens in this phase.
21. Google auth integration via Firebase Authentication (see [Authentication](#authentication)).
22. My Archives (save/load/rename/delete) — distinct from Download, which ships in Phase 3 as a P1 feature needing no account. Format-versioning risk is resolved as a policy (migrate legacy data or avoid breaking format changes), not a system to build — see [Open Questions & Critical Gaps](#open-questions--critical-gaps).
23. Settings persistence across sessions.
24. ~~Braille translator library selection/build (multi-code: formalizing 8-dot computer plus adding US uncontracted and contracted UEB)~~ — done, ahead of the rest of Phase 5 (see [Braille translator](#braille-translator)); built now specifically because it's a prerequisite for the Settings dialog's Braille Translation control, which doesn't depend on accounts/auth.

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

## Appendix: Retired Display Area Scale Option

Never built — dropped at the design stage, 2026-07-15, before any Scale Type control existed in code (Settings' Scale combo box has only ever shown Traditional Scale ratios; see [Scale behavior](#scale-behavior) and [Settings](#settings)).

The original design offered two scale *formats*, chosen via a "Scale Type" setting: **Traditional Scale** ("X = Y," e.g. "1 in = 300 ft" or "1 cm = 300 m" — the display-to-real-world ratio) and **Display Area** ("300 feet by 200 feet" — the real-world size of the whole current viewport). Display Area's values were to be derived arithmetically from the same Traditional Scale preset list, not authored separately.

**Why it was dropped:** on reflection, while designing how [Braille labels](#braille-labels) zones carve space out of the fixed dot grid (see [mapGridBounds and the Braille labels zones](#braille-labels)), the user recognized that the map's actual displayed area is not a fixed quantity — it shrinks and changes aspect ratio whenever a label zone is toggled on or off, independent of the selected scale preset. A "Display Area" reading like "300 feet by 200 feet" would therefore have to change every time a label zone was toggled, even though the scale itself (the display-to-world ratio) hadn't changed — a confusing, constantly-shifting number that doesn't actually describe a stable property of the current scale setting. Traditional Scale's "X = Y" ratio has no such problem: it describes the display-to-world ratio only, which stays constant regardless of which label zones are active. Decision: Traditional Scale is the only scale format this app will ever offer; Scale Type as a setting is dropped entirely, not deferred.
