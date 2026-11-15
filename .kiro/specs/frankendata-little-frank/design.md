# Design Document: Little Frank

## Overview

_All requirements._

Little Frank keeps his body, slab and Poses (`Specimen`). What changes is who decides what he plays and what a click does. A small pure core (`src/core/frank/`) turns app events into Reactions and queues them; a thin hook feeds it events from the stores that already exist; the `Specimen` draws the current Reaction; a new `FrankGuide` panel answers questions from a local intent table. React stays at the edges, as in `structure.md`.

## Architecture

_Requirements 1, 7, 12._

```
intake store (table count) ─┐
stitch store (proposals, decisions, plan, stitched, fanOut) ─┤
ask store (loading, outcome) ─┤                     ┌─ pure ─────────────────┐
AI switch ─┤──> useFrankEvents ──FrankEvent──> reactionFor(event) ──> enqueue(queue) ─┐
frankBus (autopsy score, fix all, save/apply recipe, export) ─┘                    │
                                                                                    v
                         FrankRegion: queue state, bubble, calm, idle, guide open ─> Specimen (draws)
                                                                                    └> FrankGuide (panel)
```

- **Held Poses stay props.** Asleep, awake, bandaged, chart sign, stethoscope and clipboard, flask and scroll come from state (`SpecimenProps`), as today. Transient Reactions come from events. This keeps "newest wins" from ever dropping a held item.
- **One event source.** `useFrankEvents` watches the existing stores and props and emits `FrankEvent`s. Things that no store records (the Autopsy score, "Fix all", save and apply recipe, export) are announced with `frankBus.emit(...)`, a tiny synchronous emitter in `src/state/frank-bus.ts`. The emit calls are one-liners added next to existing handlers; the handlers do nothing else new.
- **No timers in the core.** The queue is a pure reducer. The hook owns the timers (reaction end, bubble end, idle).

### Modules

- `src/core/frank/constants.ts`: the named constants.
- `src/core/frank/reactions.ts` (new, pure): `FrankEvent`, `Reaction`, `reactionFor(event)`, the queue (`emptyQueue`, `enqueue`, `finish`), `pokeReaction(count)`, `nextPokeCount(count, lastAt, now)`.
- `src/core/frank/guide.ts` (new, pure): `INTENTS`, `matchIntent(text)`, `answerFor(match)`, `GUIDE_CHIPS`, `contextTip(state)`, `FALLBACK_TEXT`.
- `src/core/frank/calm.ts` (new): `readCalm()`, `writeCalm(on)` with try/catch around `localStorage`.
- `src/state/frank-bus.ts` (new): `frankBus.emit(event)`, `frankBus.subscribe(fn)`.
- `src/components/frank/useFrankEvents.ts`, `useFrankController.ts` (hooks), `FrankRegion.tsx` (replaces `SpecimenRegion` in `App.tsx`), `FrankGuide.tsx`, `FrankGuide.css`.
- `src/components/Specimen.tsx` and `.css` (extend): draw a Reaction, the Effects, the new Poses, the neck bolts, the eye follow.
- Small additive props: `CaseFilePanel` (`onScored`, `onFixedAll`), `ExportButtons` (`onExported`), `download` wrappers in `App.tsx` for the recipe and SQL downloads.

## Events and Reactions

_Requirements 1, 2, 3, 4, 6._

Durations are the animation length (all at most 1500ms). The bubble stays `FRANK_BUBBLE_MS` after its Reaction starts, so text can be read after the animation ends.

| Event | Reaction id | Bubble | ms | What is drawn |
| --- | --- | --- | --- | --- |
| `wake` | `wake` | IT'S ALIVE! | 1400 | lightning path (dash draw 400ms), screen flash (250ms, peak opacity 0.12), sparks at the neck bolts, jolt upright |
| `files-loaded` n | `catch` | N tables on the slab. | 1100 | a file drops into his hands, arms catch |
| `stitch-open` | `peer` | none | 1200 | magnifying glass swings up to his eye, head tilt |
| `approve` | `nod` | none | 600 | head nod |
| `approve-all` | `thumbs-up` | none | 1000 | right arm up with a thumb |
| `reject` | `shrug` | none | 800 | arms out, shoulders up |
| `confirm-stitch` | `sew` | none | 1400 | needle and thread draw stitches across the body, sparks along the seam |
| `stitch-applied` | `bandage` | Stitched! | 1000 | sparks along the seam, bandage fades in |
| `undo-stitch` | `unravel` | none | 1200 | stitches undraw, loose thread curls |
| `fan-out` | `head-grab` | More rows than you started with! | 1300 | arms to head, shake |
| `autopsy` score >= 85 | `autopsy-happy` | Clean bill of health! | 1100 | smile, hop |
| `autopsy` score < 60 | `autopsy-faint` | Oh no... | 1500 | falls over dramatically, then gets up |
| `autopsy` otherwise | `autopsy-neutral` | Hmm, let me see. | 800 | head tilt |
| `autopsy-fix-all` | `surgeon` | Scalpel, please. | 1400 | surgeon mask fades in over his face |
| `save-recipe` | `write-scroll` | none | 1300 | scroll appears, pen scribbles lines |
| `apply-recipe` | `stamp` | Recipe stamped. | 1100 | scroll up to his eyes, stamp pops on it |
| `ask-error` | `smoke` | none | 1200 | flask with a puff of smoke |
| `export` | `wave-file` | Bye, little file! | 1400 | arm waves, a small file floats away |
| `ai-off` | `unplug` | Fully local. | 1300 | cable plug slides out of the wall |
| `reset` | `reset` | none | 1400 | lights flicker (600ms), then the existing death (X eyes, flop) |
| `poke` count | `poke-1` ... `poke-egg` | see below | 700-1400 | by level |

Held Poses (props): `askPending` shows the bubbling flask (a bubble rises every 1.2s); `askResult` the chart sign; `autopsyOpen` the stethoscope and clipboard (they share the single held-item slot: scroll, then chart sign, then stethoscope and clipboard, then the approval clipboard; this replaces the magnifying glass of the old Autopsy pose, which now belongs to `peer`).

### Event sources (what emits what)

- Table count 0 to n: `wake`, unless the previous drop to 0 was a quiet replace (then `files-loaded`). n up while above 0: `files-loaded`. Above 0 to 0: `reset` unless quiet.
- Stitch store: `proposals` null to a set with items: `stitch-open`. A decision changes to approved or edited: `approve`; if two or more are approved in the same tick (coalesced with a microtask): `approve-all`; to rejected: `reject`. `plan` null to a plan: `confirm-stitch`. `stitchedTable` null to a table: `stitch-applied`; a table to null while tables stay: `undo-stitch`. `fanOut.fannedOut` becomes true: `fan-out`.
- Ask store: a question moves from loading to an `error` outcome: `ask-error`.
- AI switch true to false: `ai-off`.
- `frankBus`: `autopsy` (from the panel when the report is complete), `autopsy-fix-all`, `save-recipe`, `apply-recipe` (successful apply), `export`.

## Queue

_Requirements 1.3, 7.3, 13.1._

```ts
interface QueueState { current: Reaction | null; pending: Reaction | null; seq: number }
enqueue(state, reaction): QueueState   // idle: becomes current (seq+1). Busy: becomes pending, replacing any older pending.
finish(state): QueueState              // current = pending, pending = null (seq+1 if one starts)
```

One rule on top: a `catch` (files-loaded) arriving while `wake` is current or pending is dropped, because the files that arrive with the first load belong to the same wake. `seq` is the React key of the Effects, so the same Reaction twice in a row restarts its animation.

## Poking

_Requirement 6._ The count is `nextPokeCount(count, lastAt, now)` (reset after `FRANK_POKE_RESET_MS`). `pokeReaction(count)`: 1 `poke-1` ("Hi!", wave), 2 `poke-2` ("Hehe", giggle), 3 and 4 `poke-3` ("Hey!", annoyed shake), 5 and 6 `poke-4` ("Stop poking me!", arms crossed shake), 7 to 9 `poke-5` ("I mean it!", steam), 10 `poke-egg` ("Happy Halloween!", a pumpkin pops onto his head; the count resets). The poke button lives in the Guide.

## Motion safety

_Requirement 7._

- **Layers.** Effects inside Frank are SVG groups inside `.specimen` with `pointer-events: none`. The two full-viewport Effects (`.frank-flash`, `.frank-lightning`) are `position: fixed`, `pointer-events: none`, outside the page flow, and have `aria-hidden`.
- **Time.** Each CSS animation is at most 1.5s, `animation-fill-mode: both`, and `animation-iteration-count: 1`, except the flask bubbles (a 1.2s loop that only runs while a question is pending).
- **Reduced motion and Calm.** `motionOff = prefersReducedMotion || calm`. When true, the Effects are not rendered (so no lightning element exists), and the Reaction only sets a Pose class (for example `specimen--react-wake` shows the neck bolts glowing, `specimen--react-autopsy-faint` shows lids closed) that fades with an opacity transition of 150ms. The old `@media (prefers-reduced-motion: reduce)` block stays as a second guard. Calm also stops eye following. Bubble text always shows.
- **Idle.** `FRANK_IDLE_MS` after the last `pointermove`, `pointerdown`, `keydown` or `wheel`, he sleeps (the existing asleep Pose and Zzz) until the next activity.
- **Eyes.** One passive `pointermove` listener, throttled with `requestAnimationFrame`, sets `--eye-x` and `--eye-y` (at most 1.4 SVG units) on `.specimen` when the cursor is within `FRANK_EYE_RANGE_PX` of his head. Off when asleep, idle, calm or reduced.
- **Calm Frank.** `readCalm()` at start, `writeCalm()` on toggle, both inside try/catch.

## Guide

_Requirements 8, 9, 10, 11._

- **Panel.** `role="dialog"`, `aria-label="Ask Little Frank"`, `aria-modal="true"`, fixed above Frank at the bottom-left (`max-height: 60vh`, scrolls inside), shaped as a speech bubble with a tail pointing at him. It never moves or scrolls the page. Opening focuses the input; Tab and Shift+Tab cycle inside; Esc and a `pointerdown` outside the panel and the Frank button close it and return focus to the Frank button. The Frank button has `aria-expanded` and `aria-haspopup="dialog"`.
- **Content order.** Title, close button, ContextTip, form (label, input, Ask), chips, answer (`role="status"`, `aria-live="polite"`), footer with "Poke Frank" and "Calm Frank".
- **Matching.** `normalize(text)` lower-cases, replaces anything that is not a letter or digit with a space and collapses spaces. A keyword (normalized, one or more words) matches when ` keyword ` is found in ` text `. An Intent's score is the sum of its matching keywords' word counts. The best score above 0 wins; ties go to the earlier Intent in the table; 0 is the fallback.
- **Intents (17).** `start`, `files`, `demos`, `stitching`, `matches` (confidence and approving), `cleanup`, `join` (key, anchor, fan-out), `undo-reset`, `autopsy`, `recipes`, `ask-lab`, `privacy`, `ai`, `export`, `built`, `who` (who is Frank), `calm` (motion). Each has 2 to 4 example questions; the eight chips are the first example of `start`, `stitching`, `privacy`, `autopsy`, `recipes`, `ask-lab`, `ai`, `built`.
- **Answers** are `string[]` paragraphs in Frank's voice. `privacy` is built at call time from `describeEgress()`: an opening ("Yes. Your files are read and kept only in this browser tab. Nothing is uploaded and nothing is saved, so a refresh clears the lab."), then "When AI is On, only this is sent:" followed by each `sent` line, then the `neverSent` sentence, then "With AI off, nothing is sent at all.". `built` says: spec-driven with Kiro, with specs for every feature, steering docs, hooks and an MCP server, and names nothing else.
- **No network.** `guide.ts` imports only `describeEgress` (pure). A test replaces `globalThis.fetch` with a spy, runs every example and gibberish through the matcher and answer builder, and expects no call. A second test scans the source of `src/core/frank/*.ts` for `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` and `import(`.
- **ContextTip.** `contextTip({ tableCount, proposalsPending, stitched })` as in Requirement 11, where `proposalsPending` is "proposals exist, nothing stitched yet".

## Error handling

`localStorage` failures are swallowed (Calm falls back to off for the session). A throwing `frankBus` listener never breaks an emit (each call is wrapped). The hooks never throw into the app: a failed event is dropped.

## Correctness properties and tests

_Requirement 13._

| Property | Test file |
| --- | --- |
| 1 queue (13.1) | `src/core/frank/reactions.queue.property.test.ts` |
| 2 reaction bounds (13.2) | `src/core/frank/reactions.bounds.property.test.ts` |
| 3 guide matching (13.3) | `src/core/frank/guide.matching.property.test.ts` |
| 4 poke escalation (13.4) | `src/core/frank/reactions.poke.property.test.ts` |
| 5 no network (13.5) | `src/core/frank/guide.nonetwork.test.ts` |

Other tests: `reactions.test.ts` (each event to the right Reaction, the wake/catch rule, the queue examples), `guide.test.ts` (chips, privacy answer equals `describeEgress()`, built answer names only Kiro, context tips), `calm.test.ts` (throwing storage), `Specimen.smoke.test.tsx` (updated), `FrankGuide.smoke.test.tsx` (open, Esc, outside click, focus trap, aria, answers), `frank-bus.test.ts`, and the Playwright spec (lightning and "IT'S ALIVE!", the privacy answer, Esc, reduced motion, clicks pass through).

## Implementation notes and deviations

Recorded in `NOTES.md` next to this file.

## Revision 2 design

### Bolt generator (`src/core/frank/lightning.ts`, pure)

`generateBolt({ seed, targetX, targetY, width })` returns `{ main, branches, sparks }`. A mulberry32 PRNG seeded from `seed` draws everything, so the same input gives the same bolt.

- Main path: `n = 6 + floor(rand * 5)` segments, so 7 to 11 points. The first point is `(startX, 0)` with `startX` near the target and inside the viewport. The last point is exactly `(targetX, targetY)`. Interior points step down by `targetY / n` with a vertical jitter of at most a quarter step (so y never decreases) and a sideways zigzag that alternates sign, clamped to `[0, width]`.
- Branches: 2 or 3, each on a distinct interior vertex of the main path, 2 to 4 short segments heading down and sideways, never below the target.
- Sparks: 8 to 12 `{ angle, distance }` pairs for the impact burst.
- `pointsToPath(points)` turns points into an SVG path string (one decimal).

The strike is rendered by `FrankViewportFx` (`FrankFx.tsx`). It measures Frank's head once, when the strike mounts, builds the bolt from a seed taken from the clock and the reaction sequence number, and draws a full-viewport, `pointer-events: none` SVG: a glow stroke (blur filter, green and cyan), a 2px white core, the ring and the sparks. The flash is a separate fixed div. The keyframes use hard stops (no per-keyframe timing function) to flicker on, off, on, off, on over 350ms and fade over 250ms.

The page shake adds a class to `#lab` for 150ms. The CSS selects `#lab.frank-shaking > :not(.specimen-layer)`, because a transform on an ancestor of a fixed element would re-anchor it.

Under reduced motion or Calm Frank the strike is not rendered at all (no element, no class). The static wake pose is a soft glow on Frank.

### Interaction

`Specimen` renders two sibling buttons inside `.specimen-layer`: the creature (`aria-label="Poke Little Frank"`, calls `onPoke`) and the "?" (`aria-label="Ask Little Frank"`, calls `onToggleGuide`). Buttons cannot nest, so the "?" is positioned over his head with CSS. `FrankGuide` ignores pointer presses that land on either button, so poking with the guide open does not close it.

Guide layout, top to bottom: tip, answer, form, chips, footer (Calm toggle). The answer is a `role="status"` region holding the full text in a visually hidden element and the typed text in an `aria-hidden` element, so assistive tech reads it once. The typewriter reveals a fixed number of characters per tick so any answer finishes within about 1.2 seconds, and is skipped (full text at once) under reduced motion or Calm Frank.

### Personality

Answers and bubbles live in `guide.ts` and `reactions.ts`. `GuideIntent.answer(now)` takes a `Date` so the November line is testable. `quips.ts` holds the pure scheduler (`quipDue`, `pickQuip`); `useFrankController` runs a coarse interval, asks the scheduler, and emits a `quip` event. New events: `autopsy-open` (bubble "Let me examine the patient.") and `quip`.

### Look

The body keeps its coordinates and class hooks (head group, arms, legs, stitches, neck bolts, electrode) so all poses and effects still line up. Patches use four local custom properties on `.specimen` (`--patch-1` to `--patch-4`) plus a seam color. The right sleeve is a coat-colored group longer than the arm, with the hand peeking out. A satchel with a book hangs at the left hip on a strap. `stitched` draws a new seam (a path with `pathLength=1` drawn in over 700ms, held after).

### Correctness properties added

6. Bolt structure (`lightning.property.test.ts`). 7. Quip scheduler gap (`quips.property.test.ts`). 8. Voice has no dashes (`voice.property.test.ts`).
