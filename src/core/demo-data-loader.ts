/**
 * Bundled demo data (no network access).
 *
 * {@link BundledDemoDataLoader} implements the shared {@link DemoDataLoader}
 * interface. It carries three {@link DemoDataset} fixtures as inline CSV string
 * constants that are bundled with the app, so {@link BundledDemoDataLoader.load}
 * never performs a network request (Req 13.4).
 *
 * The datasets are deliberately messy (Req 13.3). Across the three, they
 * collectively exercise every tolerance of the type-inference pipeline so a
 * demo visibly shows off the lab's parsing:
 *   - currency-formatted numbers ($ and € with thousands separators),
 *   - percent values (e.g. `12%` → `0.12`),
 *   - `NullToken`s in every recognized form (empty cell, `N/A`, `NA`, `null`,
 *     single hyphen `-`),
 *   - dates in more than one format (ISO `YYYY-MM-DD`, `MM/DD/YYYY`, and the
 *     month-name form `Jan 5, 2026`).
 *
 * {@link BundledDemoDataLoader.load} returns exactly three `.csv`
 * {@link File} objects built from the embedded strings. The caller (the demo
 * control, task 18.2 / app wiring, task 19.1) routes them through the same
 * {@link IntakeController} pipeline used for dropped files (Req 13.2); this
 * module only produces the files.
 *
 * ## Second, mismatched dataset (Feature 2, Req 8.1–8.4)
 *
 * {@link BundledDemoDataLoader.loadMismatched} returns a *second*, separately
 * loadable dataset built for the stitching feature. Its two files describe the
 * **same entities** (the lab's captured creatures) but are deliberately
 * mismatched so the stitching engine has something to propose:
 *   - **different column headers across the files** — `monsters."Monster Name"`
 *     vs `experiments.name`, `Species` vs `creature_type`, etc. — so fuzzy
 *     name matching (Req 8.2) is exercised;
 *   - **inconsistent category spellings / casing / whitespace** in the
 *     species and threat columns (e.g. `swamp-wraith`, `Swamp Wraith`,
 *     `swamp  wraith`) so `category-standardize` cleaning (Req 8.3) has
 *     something to propose;
 *   - **some fully-duplicate rows** so `duplicate-rows` cleaning (Req 8.3) has
 *     something to propose.
 * The two files share creature-name values, so the expected
 * `monsters."Monster Name"` ↔ `experiments.name` match surfaces, while the
 * boolean `sedated`/`hazardous` columns are excluded by the engine's boolean
 * gate (a known non-match). This dataset is also bundled inline — no network
 * access (Req 8.1). The App wires it to the same {@link IntakeController}
 * pipeline as a second "Load mismatched demo" action (Req 8.4).
 */

import type { DemoDataLoader } from "./types";

/** One bundled demo dataset: a friendly file name plus its inline CSV text. */
interface DemoDataset {
  /** Friendly `.csv` file name shown in previews (fits the spooky lab theme). */
  fileName: string;
  /** The CSV content, embedded in the bundle — never fetched over the network. */
  csv: string;
}

/**
 * Dataset 1 — the lab's roster of captured monsters.
 *
 * Showcases: currency with thousands separators (`containment_cost`), percent
 * values (`escape_risk`), ISO dates (`captured_on`), booleans as yes/no
 * (`sedated`), and `NullToken`s as empty cells and `N/A`.
 */
const MONSTERS_CSV = `name,species,captured_on,containment_cost,escape_risk,sedated
Gorzak,swamp-wraith,2026-01-05,"$1,234.56",12%,yes
Mothra Jr.,moth-titan,2026-02-18,"$18,900.00",87%,no
Blinky,three-eyed-ooze,2025-11-30,$420.00,3%,yes
Snarl,cave-howler,2026-03-02,"$7,750.25",45%,N/A
Wisp,,2026-04-14,$89.99,,no
Grond,rock-golem,2025-12-25,"$54,000.00",99%,yes
`;

/**
 * Dataset 2 — results from last week's experiments.
 *
 * Showcases: euro currency (`reagent_cost`), percent yields (`yield`),
 * `MM/DD/YYYY` dates (`run_date`), a plain-number column (`sample_count`), and
 * `NullToken`s as `-` and `null`.
 */
const EXPERIMENTS_CSV = `experiment,lead_scientist,run_date,reagent_cost,yield,sample_count
Reanimation Alpha,Dr. Frank,01/05/2026,"€9.99",62%,42
Glow Serum,Dr. Vole,02/11/2026,"€1,050.00",8%,7
Ooze Stabilizer,Dr. Frank,12/20/2025,€250.50,-,13
Lightning Capacitor,Dr. Mesmer,03/09/2026,"€12,340.75",150%,1
Memory Transfer,null,04/01/2026,€0.00,0%,99
Bone Regrowth,Dr. Vole,11/17/2025,"€3,300.00",73%,21
`;

/**
 * Dataset 3 — current stock in the supply closet.
 *
 * Showcases: month-name dates (`restocked`, e.g. `Jan 5, 2026`), currency unit
 * price (`unit_price`), a plain integer quantity (`quantity`), a boolean
 * hazardous flag (true/false), and `NullToken`s as `NA`, empty cell, and `-`.
 */
const LAB_INVENTORY_CSV = `item,quantity,unit_price,restocked,hazardous
Formaldehyde,24,"$15.00","Jan 5, 2026",true
Copper wire,500,$0.12,"Feb 20, 2026",false
Brain jar,8,"$125.00","Dec 1, 2025",true
Lightning rod,3,"$2,400.00",,false
Mystery powder,NA,$9.99,"Mar 15, 2026",true
Rubber tubing,120,$3.25,"Jan 30, 2026",-
`;

/** The three bundled demo datasets, in display order. */
const DEMO_DATASETS: readonly DemoDataset[] = [
  { fileName: "monsters.csv", csv: MONSTERS_CSV },
  { fileName: "experiments.csv", csv: EXPERIMENTS_CSV },
  { fileName: "lab_inventory.csv", csv: LAB_INVENTORY_CSV },
];

// ─────────────────────────────────────────────────────────────────────────────
// Second, mismatched dataset (Feature 2, Req 8.1–8.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mismatched file A — the containment roster of captured creatures.
 *
 * Headers: `Monster Name`, `Species`, `Threat Level`, `Sedated`. Shares its
 * creature names with {@link MISMATCH_EXPERIMENTS_CSV} (via that file's
 * `monster_name` column) so `Monster Name` ↔ `monster_name` matches on both
 * the fuzzy name (identical tokens) AND full value overlap over 12 distinct
 * names — driving the headline match's confidence to high-confidence so
 * "Approve all high-confidence" is enabled. The `Species` column carries
 * inconsistent spellings/casing/whitespace of the same categories
 * (`swamp-wraith`, `Swamp Wraith`, `swamp  wraith`) for `category-standardize`,
 * and the last two rows are exact duplicates of the Gorzak row for
 * `duplicate-rows` (2 duplicate rows).
 */
const MISMATCH_MONSTERS_CSV = `Monster Name,Species,Threat Level,Sedated
Gorzak,Swamp Wraith,High,yes
Mothra Jr.,Moth Titan,High,no
Blinky,Three-Eyed Ooze,Low,yes
Snarl,Cave Howler,High,no
Wisp,swamp  wraith,Low,no
Grond,Rock Golem,Medium,yes
Vex,moth titan,High,no
Thornak,Cave Howler,Medium,yes
Bellow,Rock Golem,High,no
Drip,Three-Eyed Ooze,Low,yes
Marrow,Bone Shambler,High,no
Fizz,Swamp Wraith,Low,yes
Gorzak,Swamp Wraith,High,yes
Gorzak,Swamp Wraith,High,yes
`;

/**
 * Mismatched file B — field observations of the same creatures.
 *
 * Headers: `monster_name`, `species`, `threat_level`, `hazardous` — cased and
 * separated differently from file A's headers, so cross-table matching bridges
 * them by similarity. `monster_name` normalizes to the same tokens as file A's
 * `Monster Name`, and its values overlap file A's, so the headline match is
 * high-confidence. `species` repeats the same messy spellings (`Swamp Wraith`,
 * `swamp wraith`) for `category-standardize`, and the Blinky observation is
 * duplicated once for `duplicate-rows` (1 duplicate row). The boolean
 * `hazardous` column (like file A's `Sedated`) must NOT match — the engine's
 * boolean hard-gate excludes it.
 */
const MISMATCH_EXPERIMENTS_CSV = `monster_name,species,threat_level,hazardous
Gorzak,Swamp Wraith,High,true
Mothra Jr.,Moth Titan,High,true
Blinky,Three-Eyed Ooze,Low,false
Snarl,Cave Howler,High,true
Wisp,swamp wraith,Low,false
Grond,Rock Golem,Medium,true
Vex,Moth Titan,High,false
Thornak,cave howler,Medium,true
Bellow,Rock Golem,High,false
Drip,three-eyed ooze,Low,true
Marrow,Bone Shambler,High,false
Fizz,Swamp Wraith,Low,false
Blinky,Three-Eyed Ooze,Low,false
`;

/** The second, mismatched demo dataset's files, in display order (Req 8.1–8.3). */
const MISMATCHED_DEMO_DATASETS: readonly DemoDataset[] = [
  { fileName: "monsters.csv", csv: MISMATCH_MONSTERS_CSV },
  { fileName: "experiments.csv", csv: MISMATCH_EXPERIMENTS_CSV },
];

/**
 * A {@link DemoDataLoader} backed entirely by bundled, inline CSV strings.
 *
 * No network access occurs: {@link load} synchronously materializes the three
 * embedded datasets into `File` objects. The returned promise exists only to
 * satisfy the interface contract (and to match the async pipeline), not because
 * any I/O is performed.
 */
export class BundledDemoDataLoader implements DemoDataLoader {
  async load(): Promise<File[]> {
    return materialize(DEMO_DATASETS);
  }

  /**
   * Load the second, mismatched dataset (Req 8.1–8.4). Returns two `.csv`
   * {@link File} objects built from the bundled {@link MISMATCHED_DEMO_DATASETS}
   * strings — no network access. The caller routes them through the same
   * {@link IntakeController} pipeline; with two tables loaded, the stitching
   * stage becomes reachable (Req 8.4).
   */
  async loadMismatched(): Promise<File[]> {
    return materialize(MISMATCHED_DEMO_DATASETS);
  }
}

/**
 * Materialize a list of inline datasets into `.csv` `File` objects. Synchronous
 * in substance (no I/O); the datasets are embedded in the bundle.
 */
function materialize(datasets: readonly DemoDataset[]): File[] {
  return datasets.map(
    ({ fileName, csv }) => new File([csv], fileName, { type: "text/csv" })
  );
}

/**
 * Shared singleton instance of the bundled demo-data loader.
 *
 * Typed as the concrete {@link BundledDemoDataLoader} (not the base
 * {@link DemoDataLoader} interface) so callers can reach the second,
 * mismatched dataset via {@link BundledDemoDataLoader.loadMismatched} as well
 * as the original {@link DemoDataLoader.load}.
 */
export const demoDataLoader: BundledDemoDataLoader = new BundledDemoDataLoader();

/**
 * The second, mismatched dataset's file names in display order (Req 8.1). The
 * golden-example test (task 17) uses these to route the same bundled files
 * through the real pipeline.
 */
export const MISMATCHED_DEMO_FILE_NAMES: readonly string[] =
  MISMATCHED_DEMO_DATASETS.map((d) => d.fileName);
