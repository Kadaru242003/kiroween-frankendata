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
