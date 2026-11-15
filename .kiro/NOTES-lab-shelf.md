# Lab shelf

Branch `lab-shelf`, cut from `main` (which already includes `little-frank`). Not merged.

## What it is

A decorative shelf in the empty right gutter, rendered only when the viewport is at least 1440px wide. Below that it is not in the DOM at all (the CSS also hides it, as a second guard). It is `position: fixed` beside the 1200px main column (`left: 50% + 610px`, at most 104px wide), so it takes no space in the layout and cannot shift the column.

- **Tesla coil** at the top (SVG, aria-hidden). Powered while tables are loaded (soft cyan glow), unpowered before data and after Reset lab (the glow fades over 900ms). While powered, a faint crackle at most once every 20 seconds (a random 20 to 35 second wait, from `nextCrackleDelayMs`). On Frank's wake strike a big forked arc lands on the coil's top terminal, drawn from the same `generateBolt` generator and with the same flicker keyframes (on, off, on, off, on over 350ms, fade over 250ms). On Confirm & stitch a small spark.
- **Jars**, one per loaded table, then one for the stitched result. Each is an SVG jar with green liquid, rising bubbles, and a paper label with the table name (cut to 12 characters with an ellipsis; the full name and row count are the `title` tooltip) and the row count. The liquid level is a log scale of the row count clamped to 30 to 85 percent, so it rises gently. A stitched result is teal and its label has a dashed stitch line, cross-stitches at two corners and a zigzag seam across the glass. New jars pop in (300ms). On Reset lab (or undo) the liquid falls (600ms), then the jar fades (350ms) and is removed after 1 second.
- **More than 6**: six jars plus one "+N" jar. The stitched jar keeps its place among the six, so with 8 tables and a stitched result you see 5 tables, the stitched jar and "+3".
- **Interaction**: a table or stitched jar is a real button, `aria-label="Go to table <name>, <n> rows"` ("1 row" for one). Click, Enter or Space scrolls that table's card into view (smooth, or at once under reduced motion) and moves no focus. The "+N" jar and a draining jar are decorative. Everything else on the shelf is aria-hidden and `pointer-events: none`.
- **Motion**: under `prefers-reduced-motion` or Calm Frank the shelf gets `lab-shelf--still`: no bubbles are rendered, no arcs are rendered, no pops, drains or fades (jars vanish at once), no transitions. Only transform, opacity and filter animate. CSS and SVG only, no dependency.

## How it hooks into the app (no duplicated state)

- **Tables and stitched result**: `LabShelf` takes the same `tables` list the table cards come from and reads `stitchedTable` from the existing `StitchStore`. The jars are a pure function of those (`src/core/shelf/shelf-model.ts`). The one piece of shelf-owned state is a copy of the jars that just left, kept for about a second so they can drain.
- **Frank's reactions**: the controller already decides what Frank does. `FrankRegion` now publishes the playing Reaction (id and sequence number) and the Calm Frank flag to a tiny read-only store, `src/state/frank-feed.ts`. The shelf subscribes with `useSyncExternalStore`: `wake` makes the big arc and `sew` (Confirm & stitch) the spark. The shelf never works the events out again, and a second wake strike is a second arc because the sequence number keys it.
- **Power**: the coil is powered when at least one table is loaded, not tied to the `reset` reaction, because Frank skips that reaction for a quiet demo replace and the coil should not blink then either.
- The reduced-motion hook moved out of `FrankRegion` into `src/components/frank/useReducedMotion.ts` so both use it.

## Decisions and limits

- **Gutter width**: at exactly 1440px the gutter beside the 1200px column is 120px, so the shelf is 104px wide and the jars are compact (84 by 66). At 1600px it sits next to the column rather than at the screen edge, so it reads as part of the lab.
- **Short windows**: the shelf is top-anchored (72px, or 40px under 780px tall). Seven jars and the coil need about 680px, so at very short windows the lowest jars would be off screen. I did not add an inner scroller for a decorative element.
- **Where "More" counts**: the "+N" counts loaded tables plus the stitched result beyond six.
- **Coil arc**: it reuses the strike generator, ending on the coil, instead of a separate arc generator.
- Row labels use `en-US` thousands separators ("1,234 rows").

## Verification

- `npm test`, `npm run build`, `npm run check:api`, `npm run mcp:build`, `npm run test:e2e`: all pass (202 test files, 1301 tests; 18 e2e tests; lint shows warnings only). New tests: `shelf-model.test.ts` (tables to jars, the +N rule, the stitched jar's place, the level clamp, the crackle gap), `frank-feed.test.ts`, `LabShelf.smoke.test.tsx` (jars, labels and tooltips, stitched jar, +N, scroll, drain, arcs, Calm and reduced motion, crackle spacing), `shelf-css.test.ts`.
- e2e at 1600px: loading the business demo gives 2 jars with the right labels (`crm_customers, 22 rows`, `billing_invoices, 48 rows`), the wake arc, the shelf sitting in the gutter outside the column; stitching gives 3 jars; clicking the stitched jar (and Enter on another) scrolls its card into view; Reset lab leaves 0 jars; reduced motion has no bubbles, arcs or running shelf animation. At 1280px the shelf is not rendered, and it appears when the window grows.
- I looked at screenshots of the coil with its arc and of the three jars (temporary spec, removed).
- No em dash or en dash in any shelf text, code string or in these notes.
