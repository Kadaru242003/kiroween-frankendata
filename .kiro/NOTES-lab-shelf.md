# Lab shelf (page navigation)

Branch `lab-shelf`, cut from `main` (which already includes `little-frank`). Not merged.

The shelf began as a decorative row of per-table jars. It is now page navigation: a Tesla coil over one jar per page section, in the empty right gutter. The first commit (per-table jars) is superseded; this note describes the current design.

## What it is

- **Where**: a `<nav aria-label="Lab sections">`, `position: fixed`, centred in the right gutter (`left: 75vw + 300px`, the middle of the space right of the 1200px column) and in the window (`top: 50%`, `translate(-50%, -50%)`). It is rendered only at 1440px and wider; below that it is not in the DOM (the CSS hides it as a second guard). It takes no space in the layout, so it cannot shift the main column. If the jars do not fit the window height it scales down to as little as 70% (`--shelf-scale`, measured on resize and when jars come and go) instead of clipping.
- **Jars are sections**, in top-to-bottom page order, each shown only while its section exists:

  | Jar | Section it scrolls to | Shown when | Liquid |
  |---|---|---|---|
  | Intake | the drop zone or the toolbar | always | full when tables are loaded, else empty |
  | Stitching | the stitching table | proposals exist and the stitching table is open | half while pending, full when stitched |
  | Result | the stitched result card | a stitch exists (and the stitching table is open) | full |
  | Recipes | the recipes panel | a stitch exists (the panel's own rule) | full after Save recipe or Apply recipe |
  | Ask | Ask the Lab | tables loaded | half while a question is pending, full after the first answer |
  | Autopsy | the open Autopsy panel | an Autopsy is open | half while it examines, full once it shows a score |
  | Tables | the loaded table cards | tables loaded | full |

  There are no per-table jars. Table names and row counts live in the Tables tooltip ("Tables: crm_customers 22 rows, billing_invoices 48 rows", listing up to six tables then "and N more").
- **Readable**: the short name (Intake, Tables, Stitching, Result, Recipes, Autopsy, Ask) is real text under each jar, 12px, high contrast, `nowrap`, never truncated. Hovering or focusing a jar shows a tooltip to the left with the section name and a one-line status ("Result: 48 rows", "Stitching: 14 of 14 approved"). The tooltip is wired to the button with `aria-describedby` and `role="tooltip"`.
- **Navigation**: each jar is a button, `aria-label="Go to <section>"` ("Go to Ask the Lab" for Ask). Click, Enter or Space scrolls the section into view (smooth, instant under reduced motion) and moves keyboard focus to its heading (the intake and the table list have none, so the section itself takes the focus).
- **Active section**: an IntersectionObserver on the sections' `data-lab-section` markers watches a thin band across the middle of the window. The jar of the section in it gets a brighter glow, an accent-coloured label and `aria-current="true"`. The result card sits inside the stitching table, so when both cross the band the inner one (Result) wins.
- **Progress**: the liquid is a full-height rectangle scaled to 0, 0.5 or 1, so it rises smoothly (700ms, transform only). A jar's `data-progress` is `empty`, `half` or `full`.
- **Coil**: powered (soft glow) while tables are loaded and fading out after Reset lab. While Frank is alive (tables loaded and not asleep from idling) 2 to 3 tiny jagged static arcs dance on the top ball, redrawn every 300 to 600ms at low opacity and never farther than 40px from the ball. A faint crackle at most once every 20 seconds. The big forked arc on Frank's wake strike and the small spark on Confirm & stitch are unchanged. All of these are off for Calm Frank and reduced motion, and the static is off when Frank sleeps.
- **Motion**: under reduced motion or Calm Frank the shelf gets `lab-shelf--still`: no bubbles, arcs or static arcs are rendered, and no pops, rises, drains, fades or transitions run (jars appear and vanish at once, liquid is drawn at its level). Only transform, opacity and filter animate. CSS and SVG only, no dependency.

## How it hooks into the app (no duplicated state)

- **Page markers**: the sections carry `data-lab-section` (intake, tables, stitching, result, recipes, autopsy, ask). Added to the existing roots in `App.tsx`, `RecipePanel.tsx`, and an optional `sectionId` on `TablePreview` (which also makes the loaded table list a labelled region, "Loaded tables"). Nothing else on the page changes.
- **State**: `LabShelf` is given the loaded tables, `stitchOpen` and the open Autopsy's table name, and reads the stitch store (proposals, decisions, stitched result) and the ask store (pending, first answer). The jars are a pure function of that (`src/core/shelf/shelf-model.ts`).
- **Events with no store**: "recipe saved or applied" and "Autopsy score" come from the existing `frankBus` events (`save-recipe`, `apply-recipe`, `autopsy`), the same ones Little Frank already uses.
- **Frank**: `FrankRegion` publishes the playing Reaction, Calm Frank and idle to a tiny read-only store (`src/state/frank-feed.ts`; `idle` was added in this rework). The coil listens to it.
- The only state the shelf owns is a copy of the jars that just left (kept for 1 second so they can drain), the section in view, the clicked jar, a recipe-done flag and the first-answer flag, which reset with Reset lab.

## Decisions and limits

- **Jar order follows the page.** The first version used the brief's workflow order (Intake, Tables, Stitching, Result, Recipes, Autopsy, Ask), which is not how the page is laid out. The order was then read from the page itself, with every section open (loaded demo, stitched, Autopsy open), from each `data-lab-section` element's DOM position and its vertical position (they agree): Intake, Stitching, Result (inside Stitching), Recipes, Ask, Autopsy, Tables. The table cards are rendered last, below Ask the Lab and the Autopsy panel. That is `SECTION_ORDER`; an e2e check compares the jar order with the sections' real top-to-bottom order, so a layout change that reorders the page fails the test and the constant is the one place to fix.
- **Stitching and Result need the stitching table open.** They live inside it, so if the user closes it the jars go (a jar with nothing to scroll to would be dead). The brief said "when proposals exist" and "when a stitch exists"; that is the same except while the stitching table is closed.
- **A clicked jar stays current** until the user scrolls by hand (wheel, touch, or a scroll key). Without that, a section the page cannot bring to the middle of the window (Ask, right above the table cards) loses the highlight as soon as the smooth scroll ends. I found this in a screenshot; the e2e test now waits for the scroll to settle before checking.
- **Tooltips overlap the main column** while open, since they open to the left of a jar that sits in the gutter. They are transient and ignore the pointer.
- **Very short windows**: at 70% the shelf still needs about 440px; below that it would clip. No inner scroller for a navigation aid.
- Row labels use `en-US` thousands separators.

## Verification

- Unit: `shelf-model.test.ts` (jar visibility and order, the progress rules, the Tables tooltip text, the active-section pick, the crackle gap, the static arcs), `frank-feed.test.ts`, `LabShelf.smoke.test.tsx` (jars, tooltips, navigation and focus, `aria-current`, pinned jar, progress, drain, arcs, static, Calm and reduced motion), `shelf-css.test.ts` (centring, 12px text, tooltip on the left, 1440px rule, motion off).
- e2e at 1600px: landing shows only the Intake jar, centred in the gutter and the window; loading the business demo shows Intake, Tables and Ask (and the wake arc), names at 12px or more and not clipped, the Tables tooltip to the left of the jar; stitching adds Stitching, Result and Recipes with Result and Stitching full and Recipes empty; clicking the Ask jar scrolls Ask the Lab into view, focuses its heading, and the jar is `aria-current` after the scroll settles, until a manual scroll; Enter on the Result jar goes to the result card; Save recipe fills the Recipes jar; a 500px-tall window scales the shelf (70% or more) inside the window; Reset lab leaves only Intake. Reduced motion: no bubbles, arcs or static arcs and no running shelf animation. The static dances only while Frank is alive. At 1280px the shelf is not rendered.
- Full gate: `npm test` 202 files and 1318 tests, `npm run build`, `npm run check:api`, `npm run mcp:build` and `npm run test:e2e` (20 tests) all pass; lint shows warnings only. No em dash or en dash in any shelf text, code string or in this note.
