# Requirements Document

## Introduction

FrankenData is a client-side, browser-only web application for the Kiroween 2026 hackathon (Frankenstein category). Little Frank (component `Specimen`) is the decorative lab mascot fixed in the bottom-left corner. Today he reacts to a handful of state changes with 2 second animations driven by transition detection inside the component, and clicking him only pokes him.

This specification covers Feature 8: **Little Frank, reactive companion and offline guide**. Part 1 makes him react to the real events of the lab, one reaction per event, through a small pure state machine (event to reaction) with a queue. Part 2 turns a click on him into "Ask Little Frank", a small speech-bubble panel that answers questions from a local intent table, with no network access of any kind.

He never blocks the UI: every effect ignores the pointer, every animation is short, reactions never pile up, motion is switched off for users who ask for it, and a "Calm Frank" toggle turns the animations off for good.

Out of scope: any change to what data leaves the browser, any new dependency or network endpoint, any change to stitching, cleaning, Autopsy, recipes, Ask the Lab or the proxies, persistence other than the Calm Frank preference.

## Glossary

- **Frank**: The mascot, rendered by the `Specimen` component, shown to users as "Little Frank".
- **FrankEvent**: A plain value describing something that happened in the app (for example `wake`, `approve-all`, `autopsy` with a score).
- **Reaction**: The transient animation plus optional speech-bubble text Frank plays for one FrankEvent. It has an id, a bubble text or none, and a duration.
- **Pose**: A resting look that holds while a state holds (asleep, awake, wearing bandages, holding the chart sign, stethoscope, flask). Poses come from app state, not from events.
- **ReactionQueue**: The pure state `{ current, pending }` that plays one Reaction at a time, keeping only the newest waiting one.
- **Effect**: Any extra element Frank draws for a Reaction (lightning, flash, sparks, thread, smoke, file, cable).
- **Calm Frank**: The preference that switches Reaction animations off while keeping Pose changes and bubble text.
- **Guide**: The "Ask Little Frank" panel opened by clicking Frank.
- **Intent**: One entry of the local intent table: an id, keywords, example questions and an answer.
- **ContextTip**: The one-line hint at the top of the Guide chosen from the app state.
- **EgressText**: The text of the "What leaves the browser?" disclosure, built by `describeEgress()`.

## Named Constants

These SHALL be named values in `src/core/frank/constants.ts` so tests and the UI reference them rather than hard-coding literals.

- **FRANK_REACTION_MAX_MS = 1500** - The longest any Reaction animation may run.
- **FRANK_BUBBLE_MS = 2600** - How long a speech bubble stays after its Reaction starts.
- **FRANK_IDLE_MS = 60000** - Quiet time after which Frank falls asleep.
- **FRANK_EYE_RANGE_PX = 280** - How near the cursor must be for his eyes to follow it.
- **FRANK_POKE_EGG_COUNT = 10** - Pokes in a row that trigger the easter egg.
- **FRANK_POKE_RESET_MS = 6000** - Pause between pokes after which the poke count starts again.
- **FRANK_CALM_STORAGE_KEY = "frankendata.calmFrank"** - The localStorage key of the Calm Frank preference.
- **GUIDE_MIN_INTENTS = 15** - The fewest Intents the table holds.

## Requirements

### Requirement 1: Reactions come from a pure event-to-reaction state machine

**User Story:** As a developer, I want Frank's behavior to be a small pure function of app events, so that every reaction is unit tested without rendering anything.

#### Acceptance Criteria

1. A pure function SHALL map each FrankEvent to at most one Reaction, and the same event SHALL always give the same Reaction (except where the event carries data: the table count, the Autopsy score, the poke count).
2. Every Reaction SHALL have a duration of at most `FRANK_REACTION_MAX_MS`.
3. A pure ReactionQueue SHALL play one Reaction at a time. WHILE a Reaction is playing, a new one SHALL replace any waiting one (newest wins), so at most one Reaction ever waits. WHEN the current Reaction ends, the waiting one SHALL start.
4. Held Poses (asleep, awake, bandaged, chart sign, stethoscope and clipboard, bubbling flask, scroll) SHALL come from app state props and SHALL NOT go through the queue.
5. The app SHALL feed events from the existing stores and handlers (intake table count, stitch store, ask store, AI switch, Autopsy, recipes, exports, reset) through one small event source, and SHALL NOT change what those stores or handlers do.
6. The mapping and the queue SHALL live in `src/core/frank/` with no React and no DOM, and SHALL be covered by unit tests.

### Requirement 2: Waking up

**User Story:** As a user, I want a dramatic wake-up the first time data arrives, so that the lab feels alive.

#### Acceptance Criteria

1. WHEN the first data is loaded (table count goes from 0 to 1 or more), THE Reaction `wake` SHALL play: a lightning bolt drawn as an SVG path from the top of the viewport down onto Frank (a stroke-dash draw of about 400ms), a brief and subtle screen flash, sparks at his neck bolts, he jolts upright, and a speech bubble says "IT'S ALIVE!".
2. The lightning element and the flash SHALL ignore the pointer and SHALL NOT cover or intercept any control.
3. A table count that rises while `wake` is playing or waiting SHALL NOT replace it (the files that arrive with it are part of the same load).
4. WHEN a demo replaces the loaded tables (the quiet replace), THE next load SHALL play `catch` (files loaded) and not `wake`, because Frank did not die.
5. Under reduced motion or Calm Frank the lightning element SHALL NOT be rendered and no flash SHALL run; the bubble and the awake pose SHALL still appear.

### Requirement 3: Reactions to loading and stitching

**User Story:** As a user, I want Frank to react to what I do while I stitch.

#### Acceptance Criteria

1. WHEN files or a demo are loaded after he is awake, THE Reaction `catch` SHALL play (he catches the files) with the bubble "N tables on the slab." (N is the table count; "1 table on the slab." for one).
2. WHEN stitch proposals appear, THE Reaction `peer` SHALL play: he peers through the magnifying glass.
3. WHEN one proposal is approved, THE Reaction `nod` SHALL play. WHEN "Approve all suggestions" approves several at once, THE Reaction `thumbs-up` SHALL play. WHEN a proposal is rejected, THE Reaction `shrug` SHALL play.
4. WHEN the user confirms the plan ("Confirm & stitch"), THE Reaction `sew` SHALL play: a needle and thread sew stitches across his body with small sparks along the seam.
5. WHEN the stitched result appears, THE Reaction `bandage` SHALL play (sparks along the seam, then the existing bandage appears). The existing bandage Pose SHALL stay.
6. WHEN the stitch is undone, THE Reaction `unravel` SHALL play: the stitches unravel.
7. WHEN the fan-out warning appears (the result has more rows than the anchor), THE Reaction `head-grab` SHALL play: he grabs his head and the bubble says "More rows than you started with!".

### Requirement 4: Reactions to Autopsy, recipes, Ask the Lab, export, AI and reset

**User Story:** As a user, I want Frank to react to the rest of the lab too.

#### Acceptance Criteria

1. WHILE an Autopsy case file is open, THE Pose SHALL show a stethoscope and a clipboard (the single held-item slot rule of the design system applies). WHEN its health score is known: 85 or above SHALL play `autopsy-happy`; below 60 SHALL play `autopsy-faint` (he faints dramatically, then gets up); anything between SHALL play `autopsy-neutral`. WHEN "Fix all" is used, THE Reaction `surgeon` SHALL play (he puts on a surgeon mask).
2. WHEN a recipe is saved, THE Reaction `write-scroll` SHALL play (he writes on the existing scroll). WHEN a recipe is applied, THE Reaction `stamp` SHALL play (he reads the scroll and stamps it). The existing scroll Pose SHALL stay.
3. WHILE an Ask the Lab question is pending, THE Pose SHALL show a bubbling flask. WHEN an answer with a chart is shown, THE existing chart sign Pose SHALL show. WHEN the question fails, THE Reaction `smoke` SHALL play (a puff of smoke from the flask).
4. WHEN a table, the stitched result or the SQL script is exported, THE Reaction `wave-file` SHALL play (he waves goodbye to a little file).
5. WHEN the AI switch is turned off, THE Reaction `unplug` SHALL play (he unplugs a cable) with the bubble "Fully local.".
6. WHEN the lab is reset (the tables go to zero, not as a quiet replace), THE Reaction `reset` SHALL play: the lights flicker, then the existing death animation.
7. Every user-facing string of these Reactions SHALL contain no em dash.

### Requirement 5: Falling asleep and eyes that follow

**User Story:** As a user, I want Frank to feel present when I am here and asleep when I am not.

#### Acceptance Criteria

1. WHEN there has been no pointer, keyboard or scroll activity for `FRANK_IDLE_MS`, Frank SHALL fall asleep (the asleep Pose with Zzz). ANY activity SHALL wake him again, with no Reaction.
2. WHILE awake and not idle, his eyes SHALL follow the cursor when it is within `FRANK_EYE_RANGE_PX` of him. The movement SHALL be a small, bounded offset of the pupils only.
3. Eye following SHALL be off under reduced motion and Calm Frank, and SHALL NOT attach more than one throttled pointer listener.

### Requirement 6: Poking, with escalating annoyance

**User Story:** As a user, I want poking Frank to be funny, and finding the easter egg to be a treat.

#### Acceptance Criteria

1. Poking SHALL move into the Guide as a "Poke Frank" button; clicking Frank himself opens the Guide.
2. Pokes SHALL escalate by count: friendly at first, then annoyed, then "Stop poking me!", then fed up. The count SHALL start again after `FRANK_POKE_RESET_MS` without a poke.
3. At `FRANK_POKE_EGG_COUNT` pokes in a row a harmless easter egg SHALL play (a pumpkin pops onto his head with the bubble "Happy Halloween!"), and the count SHALL start again.
4. The poke Reaction for a given count SHALL be a pure function, unit tested.

### Requirement 7: Motion safety

**User Story:** As a user, I want Frank to be fun but never in my way.

#### Acceptance Criteria

1. Every Effect element SHALL have `pointer-events: none` and SHALL NOT cover a control. Full-viewport Effects (flash, lightning) SHALL be fixed, non-interactive, and outside the control layout.
2. No Reaction animation SHALL run longer than `FRANK_REACTION_MAX_MS`. Only transform, opacity, stroke-dashoffset, filter and box-shadow SHALL animate.
3. Reactions SHALL queue as in 1.3; the UI SHALL never wait on an animation.
4. Under `prefers-reduced-motion: reduce`, no Reaction animation SHALL run: Frank swaps to a static Pose and fades (opacity only), and the bubble text still shows.
5. A "Calm Frank" toggle in the Guide SHALL switch Reaction animations and eye following off while keeping Pose changes and bubble text. The choice SHALL be remembered in `localStorage` under `FRANK_CALM_STORAGE_KEY`, with every read and write wrapped in try/catch so a blocked or full storage never throws.
6. Effects SHALL be CSS and SVG only. No dependency SHALL be added.
7. Frank SHALL stay hidden below 640px, as today.

### Requirement 8: The Ask Little Frank panel

**User Story:** As a user, I want to click Frank and ask him how the lab works.

#### Acceptance Criteria

1. Clicking Frank (or pressing Enter or Space on him) SHALL open a small speech-bubble panel anchored to him with an accessible name ("Ask Little Frank"). Clicking him again SHALL close it.
2. The panel SHALL close on Esc and on a click outside it, and focus SHALL return to Frank.
3. WHILE open, keyboard focus SHALL be trapped inside the panel (Tab and Shift+Tab cycle), and focus SHALL start on the question input.
4. The panel SHALL hold: the ContextTip, a text input with an Ask button, the suggested-question chips ("How do I start?", "What does stitching do?", "Is my data safe?", "What is an Autopsy?", "How do recipes work?", "What can I ask the Lab?", "What does AI do here?", "How was this built?"), the answer area (a polite live region), a "Poke Frank" button, and the "Calm Frank" toggle.
5. Opening the panel SHALL NOT scroll the page, and the panel SHALL NOT cover Frank.
6. All answer text SHALL be rendered as plain text.

### Requirement 9: Local intent table and matching

**User Story:** As a user, I want useful answers with no network and no account.

#### Acceptance Criteria

1. The Guide SHALL answer from a local table of at least `GUIDE_MIN_INTENTS` Intents, each with an id, keywords (words and phrases, including synonyms), example questions and an answer in Frank's voice (short, friendly, a little spooky).
2. Matching SHALL be case-insensitive keyword and synonym matching on the normalized question (lower case, punctuation removed, spaces collapsed). The Intent with the highest score SHALL win; ties go to the earlier Intent. A question that matches no keyword SHALL get the fallback "I only know about this lab. Try one of these:" followed by the suggested-question chips.
3. The Guide module SHALL make no network call of any kind: no `fetch`, no `XMLHttpRequest`, no `WebSocket`, no `sendBeacon`, no import of a provider or proxy module.
4. Every suggested chip SHALL be an example question of some Intent and SHALL map to that Intent.

### Requirement 10: Answers that must be right

**User Story:** As a user, I want Frank to tell me the truth about my data and about how this was made.

#### Acceptance Criteria

1. The answer to "Is my data safe?" SHALL match the real behavior and SHALL contain every line of the EgressText (`describeEgress()`: each `sent` line and the `neverSent` sentence) verbatim, built from the same function so it cannot drift. It SHALL also say that files are read and stored only in the browser, nothing is uploaded, and a refresh clears everything.
2. The answer to "How was this built?" SHALL say FrankenData was built spec-driven with Kiro (specs, steering, hooks, an MCP server) and SHALL mention no other AI tool.
3. The answer about AI SHALL say it is optional, that it only nudges match scores and helps write questions as SQL, that the app works fully offline without it, and that the switch is in the header. It SHALL name no vendor.
4. The answers about stitching, Autopsy, recipes and the Ask the Lab SHALL describe the features as they behave today (approval before anything is applied, undo, originals never changed, a recipe has no row values, queries are read-only).

### Requirement 11: Context-aware tip

**User Story:** As a user, I want the next step suggested to me.

#### Acceptance Criteria

1. The Guide SHALL show one ContextTip chosen by a pure function of the app state: no tables: "Click Load business demo to wake me up."; tables loaded and no stitch: "Click Stitch tables." (with one table only: "Add another file, then click Stitch tables."); proposals pending: "Approve the matches you trust, then Confirm & stitch."; stitched: "Save a recipe, or ask the Lab a question.".
2. The more advanced state SHALL win: stitched over proposals pending over tables over none.
3. The tip SHALL update while the panel is open.

### Requirement 12: Privacy and non-interference

**User Story:** As a user, I want Frank to change nothing about my data.

#### Acceptance Criteria

1. Frank and the Guide SHALL make no network request and SHALL send nothing anywhere.
2. Frank SHALL read app state only. The only writes SHALL be the Calm Frank preference in `localStorage` and the event emitter used by the app to tell him what happened.
3. The existing stitching, cleaning, recipe, Autopsy, Ask the Lab and MCP behavior SHALL be unchanged, and `npm run check:api` SHALL pass.
4. The feature SHALL add no runtime dependency.

### Requirement 13: Correctness properties for property-based tests

**User Story:** As a developer, I want the safety properties checked by property-based tests.

#### Acceptance Criteria

1. **Property 1 (queue)**: FOR ANY sequence of enqueue and finish actions, THE ReactionQueue SHALL have at most one current and one waiting Reaction, the waiting one SHALL be the newest enqueued since the current started, and no Reaction SHALL be played twice for one enqueue.
2. **Property 2 (reaction bounds)**: FOR ANY FrankEvent, THE Reaction, if any, SHALL last at most `FRANK_REACTION_MAX_MS` and its bubble text SHALL contain no em dash.
3. **Property 3 (guide matching)**: FOR EVERY Intent and EVERY one of its example questions (in any letter case and with extra punctuation), THE matcher SHALL return that Intent. FOR ANY text that contains no keyword, THE matcher SHALL return the fallback.
4. **Property 4 (poke escalation)**: FOR ANY poke count, THE poke Reaction SHALL be defined; the escalation SHALL never go back to a friendlier level while the count rises without a pause; the egg SHALL play exactly at `FRANK_POKE_EGG_COUNT`.
5. **Property 5 (no network)**: THE Guide module SHALL not call `fetch` while answering any question.
6. EACH property test SHALL reference its design property by tag in its header comment (**Feature: frankendata-little-frank, Property {n}: {title}**).
