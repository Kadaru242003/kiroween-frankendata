# Join key: run notes

Branch `join-key`, cut from `main`. Not merged. Gate after the last commit: `npm test`
(181 files, 1168 tests), `npm run build`, `npm run check:api`, `npm run mcp:build`,
`npm run test:e2e` (7 passed) all pass. `npm run lint` reports no errors.

`vendors.csv` and `purchases.xlsx` moved from the repo root to `mcp/fixtures/` (the only
fixtures folder). The MCP tests copy that folder into each temp root, so both files are
also there for them; nothing else reads them.

## What was wrong (two causes, not one)

1. **The ranking.** Default key = highest confidence. Country is 79% (name 100%, type 100%,
   value overlap 30%) and email is 55% (name 47%, type 100%, value overlap 40%).
2. **The join ignored the choice.** `planJoinChain` in `stitch-applier.ts` picked the
   highest-confidence approved match between two tables and never read
   `plan.joinKeysByPair`. So the key shown in the Join dropdown, and any key the user picked
   there, did not change the SQL. That is fixed too (the chosen key ids are tried first);
   without it the new default would have been shown but not used. It was found because the
   new fixture test returned 8 rows instead of 5.

## Items

| # | Item | Status |
| --- | --- | --- |
| 1 | Value overlap compares normalized values | **Skipped, already true.** `valueOverlap` already trims, collapses whitespace and lowercases (`normalizeSampleValue`) before comparing, and never changes the display values. On the fixtures the email overlap is already the raw 100% of the shared values (`INFO@eastgate.example` against `info@eastgate.example` match). The 55% comes from the name score (47%) and the small-set damping (4 distinct values scale the overlap to 40%), not from raw comparison. Pinned with a test (`key-stats.test.ts`, "value overlap compares normalized values"); no code change, and no confidence number moved. |
| 2 | Default key ranked by key-likeness | **Done, with a deviation.** See below. |
| 3 | Default anchor is the "many" side | **Done.** |
| 4 | Fixture test and property test | **Done.** |
| 5 | Goldens only where confidence changes | **Done: none changed.** No confidence number changed, and every existing golden (stitching, Ask, Autopsy, Recipes, MCP) passes unchanged. One non-golden unit test changed, see "Duplicate rows". |
| 6 | Business month-two demo | **Done.** |
| 7 | Load demo menu order | **Done.** |
| 8 | Loading a demo replaces the tables | **Done.** |

### 2. Key-likeness: where I did not follow the formula, and why

The formula `confidence x min(distinct ratio left, distinct ratio right)` picks **country**
on these fixtures, so it cannot be used as written. Distinct ratios on normalized values,
after the proposed duplicate-row cleanup:

| column | left | right | min | confidence | score |
| --- | --- | --- | --- | --- | --- |
| country | vendors 0.8 | purchases 0.6 | 0.6 | 0.790 | 0.474 |
| email | vendors 1.0 | purchases 0.8 | 0.8 | 0.553 | 0.442 |

Email loses because purchases legitimately repeats the Acme address (that is the "many"
side). Any formula on `min` punishes the side that is supposed to repeat. What identifies a
join key is that it is unique on **one** side. The rule that is implemented
(`src/core/stitching/key-stats.ts`), for the candidate matches of one table pair:

1. `keyRatio = max(left ratio, right ratio)`. A candidate where neither side is even half
   distinct (keyRatio < 0.5) is used only when nothing else exists. (Your rule said "either
   side below 0.5". As written it would demote a normal foreign key: in the business demo
   `billing_invoices.email` has 20 distinct values in 48 rows = 0.42, and that pair only
   survives because every other pair is demoted too.)
2. A candidate that is unique on a side (keyRatio = 1) ranks above the rest.
3. Within that group the score is your formula, `confidence x min(left, right)`.
4. Similar-confidence refinement: while a candidate within 0.1 confidence of the pick has a
   higher keyRatio, switch to it. This makes the property in item 4 true by construction.

Without stats (older callers, tests building a `ProposalSet` by hand) the pick is the
highest confidence, as before. The user can still pick any approved match in the dropdown,
and now it takes effect.

How the stats are computed: from the bounded samples (200 distinct values with counts), exact
for columns with up to 200 distinct values. For a longer column, one extra grouped query
(`COUNT(*)` and `SUM(n)` over the grouped raw values, the same shape as the sample query) gives
the exact non-null and distinct-raw totals, and the normalized distinct count is scaled from
the sample. The ratio assumes a *proposed* duplicate-row cleanup (not only an approved one),
so a default does not flip when a user leaves that proposal unapproved. If the user rejects
it the join can still fan out, and the fan-out warning says so.

### 3. Anchor

For each chosen key, the side where it repeats while it is unique on the other side gets a
vote. The anchor is the table with the most votes; ties and the case with no votes fall back
to the table with the most rows (the old rule). Vendors + purchases: anchor `purchases`.
Business demo: still `billing_invoices` (CRM email is unique after the duplicate cleanup).
The anchor follows the keys in the plan including overrides, and an explicit anchor
override or a recipe anchor still wins.

### Duplicate rows now fold case (needed for the 5-row result)

`vendors.csv` has a case-only duplicate (`Acme Supplies` / `ACME Supplies`, `USA` / `usa`,
`active` / `Active`). The duplicate-rows detection compared text after trim and whitespace
collapse only, so it found no duplicate, the vendors email stayed repeated, and purchases
joined to it gave 7 rows. A case-only duplicate becomes an exact duplicate after the case
cleanups anyway, so detection (`cleaning-rules.ts`) and the keep-first dedupe
(`stitch-applier.ts`) now also lowercase text cells. This is a behavior change, not only a
number change: `cleaning-rules.duckdb.test.ts` pinned the opposite on purpose ("ghoul"
stayed distinct from "Ghoul") and was updated (6 rows go to 3, not 4). The module header
already said "after the whitespace/case normalization". The stitching spec only asks to flag
"likely duplicate rows". Decide whether you want this; reverting it makes the fixture result
7 rows with a fan-out warning.

### 4. Tests

- `join-key.fixtures.duckdb.test.ts`: both fixtures, the key stats, the duplicate row, default
  key = email, anchor = purchases, 5 rows, `{anchor 5, result 5, fannedOut false}`; a picked
  country key is honored (and fans out).
- `join-key.business.duckdb.test.ts`: business demo keeps email, `billing_invoices`, 48 rows.
- `key-stats.property.test.ts` (Feature: frankendata-join-key, Property 1): the chosen default
  never has a lower key ratio than a candidate within 0.1 confidence; independent of candidate
  order; highest confidence when columns are equally key-like; confidence-only without stats.
  I checked it fails when the chooser is replaced by "highest confidence".
- `key-stats.test.ts`: stats, the foreign-key case, tie-breaks, anchor votes.

### 6. Business month two

`src/core/recipes/business-next-month-demo.ts`: `crm_customers.csv` (22 customers incl. 2 new,
plus 2 exact duplicate rows; casing variants, a whitespace issue, mixed dates, currency strings,
a blank and an `N/A` revenue) and `billing_invoices_2026_04.csv` (24 April 2026 invoices; mixed
`Paid`/`paid`, emails in other casings). Same headers and types as March, so the recipe maps the
renamed billing table by schema. `business-recipe.duckdb.test.ts`: March stitch, recipe, reset,
load, apply: `notApplied` is empty and every recipe step has a decision; the result has 24 rows
with no fan-out. `e2e/demo.spec.ts` "business month two" does the same in a real browser (load
business demo, stitch, save recipe, reset lab, load next month's business files, apply,
confirm, expects "0 not applied" and "24 rows"). The landing page has a fifth button, "Load
next month's business files"; I tightened the demo button padding, gap and caption width so all
five stay on one row at 1280px (the existing landing baseline test now lists five).

### 7. Menu order

Business, Business: next month, Lab, Mismatched, Lab: next month (the last was "Next month's
files"). Landing button labels are unchanged except the new fifth. e2e checks the order.

### 8. Demos replace

`loadDemo` in `App.tsx` now clears the lab with the same code as Reset lab (`clearLab`, shared)
and loads the demo inside the reset lock. Little Frank skips the reset animation through a
ref (`quietResetRef` on `Specimen`); he still plays "alive" when the new tables arrive. The
status line reads "Loading the demo..." instead of "Resetting the lab...". Add files still adds
on top (e2e: a demo replaces, then `extra.csv` is added next to the demo tables). The menu still
shows the loaded demo as disabled. One visible side effect: for a moment the landing page shows
between the clear and the new tables.

## Not done / to know

- The Join dropdown still lists matches by confidence; only the preselected key changed.
- `columnStats` is a new optional field on `ProposalSet` (additive). The recipe mapper copies it.
- No Vercel, API or proxy change.
