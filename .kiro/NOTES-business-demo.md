# Business demo and local mode: notes

## Item 1: business demo

- **Files** (`src/core/business-demo.ts`, bundled strings, no network): `crm_customers.csv` (22 rows: 20 customers plus 2 exact duplicate rows; "Northwind Analytics", "northwind analytics " and "NORTHWIND Analytics" are three different contacts at one company; `emea` and `pro` casing variants; mixed date formats `2025-01-15`, `03/22/2025`, `Jun 5, 2025`; currency strings like `$1,200.00`, one empty and one `N/A` revenue; one empty plan) and `billing_invoices.csv` (48 invoices from Jan to Jun 2026, plain amounts, email casing variants, status casing variants, a billing `region`).
- **Headers** were chosen by measuring the real engine; no engine code or threshold was changed. CRM: `Customer Name, Email, Region, Plan, Customer Since, Monthly Revenue`. Billing: `client_name, email, invoice_date, amount, status, region`. The CRM date column is "Customer Since" because "Signup Date" scored 0.37 against `invoice_date`, a meaningless candidate.
- **Measured scores (`matchAll`):** `billing_invoices.email = crm_customers.Email` 1.000 (nameSim 1.00, valueOverlap 1.00, above the 0.85 high-confidence line), `billing_invoices.region = crm_customers.Region` 0.790 (nameSim 1.00, valueOverlap 0.30), and the borderline `billing_invoices.client_name = crm_customers.Customer_Name` 0.383 (nameSim 0.37, valueOverlap 0.00), which sits between the 0.25 candidate floor and the 0.5 display threshold, so with AI on it can show as "AI found this". The first run with the header `contact_email` scored 0.733, so `email` was used to make the key confident.
- **Stitch result** with every proposal approved: anchor `billing_invoices` (most rows), key `email`, 2 matches and 12 cleanups, 48 rows, no fan-out (anchor 48, result 48), no unmatched CRM columns (the billing email case cleanup makes the casing variants join). Result columns: `client_name, email, invoice_date, amount, status, region, Customer_Name, Region_1, Plan, Customer_Since, Monthly_Revenue`.
- **Autopsy of crm_customers:** score 79, 2 duplicate rows, breakdown duplicates 9, nulls 1, whitespace 2, variants 9.
- **Starter chips** (`src/core/chat/business-chips.ts`, only for tables named `crm_customers` and `billing_invoices`, shown first): "What is the monthly revenue by region in crm_customers?" (bar; `SELECT DISTINCT` rows first) answers North America 34220, EMEA 17850, APAC 9430, emea 1750 (the lowercase `emea` row is deliberately visible mess); "What is the invoiced amount by month (from invoice_date)?" (line, `date_trunc('month', ...)`) answers 25982.5, 34368.6, 27623.5, 36472.8, 29264.5, 38577 for Jan to Jun. Existing chip generation is unchanged, so no monster demo behavior changed.
- **UI:** "Load business demo" is listed first with the "Start here" tag and the caption "A CRM export and a billing export that never agree". The other three demos keep their behavior. `DemoId` gained `"business"`.
- **Golden test:** `src/core/business-demo.duckdb.test.ts` pins the above.

## Item 2: AI off toggle

- `AiSwitch` (`src/state/ai-switch.ts`, session only, default On), `gateAiProvider` and `gateSqlProvider` (`src/core/ai-gate.ts`). The gates throw before the real provider is called, so `fetch` is never reached. Stitching falls back to rules (`aiUsed` false), Ask returns the existing `ai-unavailable` outcome. No core controller or proxy code changed.
- Header: `AiToggle` shows a `role="switch"` "AI: On" / "AI: Off (fully local)" only when `VITE_AI_ENABLED` is "true"; otherwise a static "Fully local" label. With the switch Off the Ask panel note reads "AI is off. Starter questions still work." (the build-off note keeps its original comma wording).
- "What leaves the browser?" text comes from `describeEgress()`, built from the real constants. The actual limits differ by path: stitching sends up to 5 samples per column (40 characters, at most 40 columns), Ask sends up to 3 samples (30 characters), so the text states both instead of the single "3" in the brief.
- Tests: `src/core/ai-off.duckdb.test.ts` (spied fetch never called for stitching or Ask when Off, called when On; disclosure strings match constants; real payloads contain only the described fields), `AiToggle.smoke.test.tsx`, and a panel test.

## Item 3: docs and e2e

- README: "Try it in 60 seconds" uses the business demo, a short "Try the monster demo" section, the recipe flow now starts from the monster demo, Features mention the switch, "By the numbers" updated.
- `e2e/demo.spec.ts` has a second test for the business demo (stitch to 48 rows, revenue by region chip, Autopsy 79); the monster and recipe test is unchanged.

## Results

`npm test` 159 files, 975 tests passing; `npm run build`, `npm run check:api`, `npm run mcp:build` pass; lint has no errors; `npm run test:e2e` 2 passed.

## Known limits

- The AI-found pair `client_name` and `Customer_Name` is only a candidate; whether the model lifts it above 0.5 on the live site was not run here.
- The line chart chip is covered by the golden SQL answer and the chart choice tests, not by a browser assertion.

## Credits used

About 60 of the 80 budget (an estimate).

## Follow-up: invented names and cleaned-region chip

- Every company and contact in the business demo is now invented (for example Northwind Analytics, Bluepeak Logistics, Cedar & Pine Health, Harborline Foods) with first.last style emails on invented `.example` domains. Messiness patterns, row counts (22 and 48) and every numeric value are unchanged. No old names remain in the repo (searched demo data, tests, README, notes, e2e).
- Re-measured scores are unchanged because scoring uses header similarity and value overlap, which the renames did not touch: email 1.000, region 0.790, borderline `client_name` vs `Customer_Name` 0.383 (between the 0.25 floor and the 0.5 display threshold; asserted in the golden test).
- New chip, listed first once a stitched result exists: "What is the invoiced revenue by region in stitch_1_result?" (bar, `SUM(amount)` grouped by the cleaned CRM region `Region_1`). Pinned answer: North America 105200.4, EMEA 59100, APAC 27988.5 (no stray `emea`). The raw-table chip "What is the monthly revenue by region in crm_customers?" stays and still answers North America 34220, EMEA 17850, APAC 9430, emea 1750.
