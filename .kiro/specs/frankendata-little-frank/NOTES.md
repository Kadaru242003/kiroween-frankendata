# Little Frank: notes

Branch `little-frank`, cut from `main`. Not merged.

## What was built

- A pure event-to-reaction state machine (`src/core/frank/reactions.ts`) with a one-current, one-pending queue (newest wins), plus the poke escalation and easter egg.
- An offline guide, "Ask Little Frank" (`src/core/frank/guide.ts`, `FrankGuide.tsx`): 17 intents, keyword and synonym matching, 8 chips, a fallback, and a context tip. No network calls.
- Reactions drawn in CSS and SVG only (`Specimen.tsx`, `Specimen.css`, `FrankFx.tsx`). No new dependencies.
- Calm Frank toggle, stored in localStorage inside try/catch (`calm.ts`).
- Wiring: `FrankRegion`, `useFrankEvents`, `useFrankController`, and a small `frankBus` for events no store records (export, save and apply recipe, autopsy).

## Decisions and deviations

- Held poses (asleep, awake, bandaged, chart sign, stethoscope and clipboard, flask, scroll) still come from props. Only transient reactions go through the queue, so "newest wins" can never drop a held pose.
- One table loaded: the tip reads "Add another file, then click Stitch tables." (the brief's "Click Stitch tables." would point at a button that is not shown yet).
- `sew` fires when the plan is confirmed. `bandage` fires when the stitched table appears. `undo-stitch` fires when it goes away while tables remain.
- The magnifying glass is no longer an Autopsy pose. It is the `peer` reaction on Stitch tables. Autopsy uses the stethoscope and clipboard.
- The old "Poke me!" hint and the three-dot thinking bubble were removed. The bubbling flask replaces the dots.
- Neck bolts were added (the sparks need them).
- The Frank button is now labelled "Ask Little Frank" (was "Poke Little Frank"). Poke lives inside the panel.
- A files-loaded reaction arriving while `wake` is current or pending is dropped, since it belongs to the same load. A quiet demo replace (tables already loaded) emits files-loaded, not wake.
- `stitch-open` is driven by the `stitchOpen` prop, because applying a recipe also sets proposals.
- `join-key` is now merged into `main`. The guide still keeps join and anchor wording general ("I suggest a default").
- Viewport effects (flash, lightning) are siblings of `.specimen`, because `filter` on the Frank body would make `position: fixed` relative to him.
- Calm Frank and reduced motion both set `specimen--still`: no animation, no effect elements (so no lightning element exists), static poses and 150ms fades. Bubble text always shows.
- A real bug found by the eye-follow test: the rAF scheduling flag could be overwritten when the callback ran synchronously. Fixed with a `pending` flag.
- A 60s idle e2e is not feasible. Idle and eye-follow are covered by jsdom smoke tests with an injectable `idleMs`.

## Verification

- `npm test`: 193 files, 1240 tests passed (before the final FrankRegion smoke file, which adds 5, all passing).
- `npm run build`, `npm run check:api`, `npm run mcp:build`: pass.
- `npm run test:e2e`: 12 passed (8 existing, 4 new: wake lightning and bubble, privacy answer and Esc, reduced motion, click not intercepted).
- `npm run lint`: warnings only (none new except the existing `only-export-components` style on Specimen exports).
- No em dashes in Frank code or user-facing text.

## Revision 2 (lightning, interaction, personality, look)

Spec first (requirements 14 to 17, design Revision 2, tasks 12 to 18), then the code.

### What changed

- **Lightning.** `src/core/frank/lightning.ts` builds the bolt from a seed: 6 to 10 zigzag segments from y = 0 to his electrode, 2 to 3 branches on interior vertices, 8 to 12 impact sparks. Each strike takes a new seed from the clock and the reaction number. It is drawn as a 2px white core inside a blurred green and cyan glow. CSS flickers it on, off, on, off, on over 350ms and fades it over 250ms (hard keyframe stops, so no per-keyframe timing property). An 80ms white flash at 25% opacity, a glow ring, the spark burst and a 150ms, 3px shake of the page content follow. Then he turns from gray to color, his eyes open, he jolts upright, and the bubble "It's alive!" arrives. Reduced motion and Calm Frank render none of it (no element, no class), only a soft glow and the bubble.
- **Shake without breaking Frank.** The shake class goes on `#lab`, but the CSS animates only `#lab > :not(.specimen-layer)`. A transform on an ancestor of a fixed element would move Frank.
- **Interaction.** Tapping or clicking Frank pokes him (a real button, "Poke Little Frank", so Enter and Space work). The Poke button is gone from the guide. A round "?" button by his head ("Ask Little Frank") opens the guide. A press on Frank or on the "?" is not an outside click, so poking with the bubble open keeps it open.
- **Guide as a comic bubble.** Tail pointing at his head, at most 360px wide, scrolls inside itself (the scroller is an inner wrapper so the tail is not clipped). Order: tip, answer, input, chips, Calm Frank. The answer is Georgia 16px with a typewriter reveal of about 1.2s whatever the length; it is instant under reduced motion or Calm Frank. Screen readers get the whole answer once from a visually hidden copy; the typed copy is `aria-hidden`.
- **Personality.** All answers and bubbles were rewritten in the voice of the 1818 creature. New intents: Frankenstein (gentle correction), eat, read, born (dreary night of November; "That's this month!" when the month is November, passed in as a `Date` so it is testable). "Who are you?" was reworded. The privacy answer opens with the crack-in-the-wall lines and keeps the exact EgressText. Bubbles: stitching peer line, "Now neither of them is alone." on a stitch, "Let me examine the patient." when an Autopsy opens (new `autopsy-open` event), "Even I keep notes in a journal." on saving a recipe. Poke lines were rewritten too.
- **Idle quips.** `quips.ts` is a pure scheduler (never busy or asleep, user quiet for 15s, at least 2 minutes since the last quip, never the same quip twice). The controller asks it every 10s and rolls a 40% die. Quips: a tiny book, nibbling an acorn, a look at his stitches.
- **Look.** A patchwork SVG: four patch colors (3 greens, 2 grays in all) on torso, head, legs and left arm, dashed lighter seams, left eye bigger than the right, temple and neck nubs plus a short top electrode, a satchel with a book on a strap, and a coat sleeve a little too long with the fingertips showing. All coordinates and class hooks of the old body were kept, so every pose and accessory still lines up (the old test for leg-to-body contact still passes). A stitch adds a new glowing seam with ticks across his torso (drawn in over 700ms, then held).

### Deviations and limits

- **The bubble can cover the page.** At 1200px the main column leaves almost no gutter at 1280px, so a bubble anchored to Frank at the bottom-left overlaps the column while it is open. It is a transient popover: at most 360px wide, scrollable, closed by Esc or an outside click, and it never covers Frank (the e2e test checks that). A bubble that never touches the column would need a side panel, which is not a speech bubble. I chose the speech bubble.
- **"IT'S ALIVE!" became "It's alive!"**, as asked. The poke texts changed, so the escalation levels are the same but the words are new ("Oh! Good day to you.", and so on). "Happy Halloween!" stays for the 10-poke egg.
- **Novel facts.** Cottage chink, the three books, acorns and berries, Victor as maker and "a dreary night of November" are all from the novel. The only quotation is that five-word phrase. The creature has no name in the novel, which the Frankenstein answer does not claim to settle beyond "in this lab people call me Little Frank". Idle quips are an invention in the creature's spirit, not quotes.
- **Seeded randomness.** The strike seed comes from the clock, so no two strikes are alike. Tests pass seeds explicitly.

### Verification

- `npm test`: 198 files, 1269 tests pass. New: `lightning.test.ts`, `lightning.property.test.ts` (Property 6), `quips.property.test.ts` (Property 7), `voice.property.test.ts` (Property 8); extended: the guide matching property now covers 21 intents (every example maps to its own intent), reactions bounds, guide, Specimen, FrankGuide and FrankRegion smoke tests.
- `npm run build`, `npm run check:api`, `npm run mcp:build`: pass. `npm run lint`: warnings only.
- `npm run test:e2e`: 14 pass. New or changed: bolt structure (a main path and 2 to 3 branches, 8 to 12 sparks, a flash), tapping and Enter poke, the "?" opens the bubble, "what do you eat" answers about acorns with the answer above the input above the chips and the bubble at most 360px wide and clear of Frank, poking with the bubble open keeps it open, reduced motion shows no bolt, flash or running Frank animation, and a click on Stitch tables works while the wake plays.
- I looked at screenshots of the strike, Frank close up and the open bubble (temporary spec, removed). That is how I found the clipped tail.
- No em dash or en dash in any Frank text, code string or in these notes.
