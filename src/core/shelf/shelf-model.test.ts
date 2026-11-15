import { describe, expect, it } from "vitest";
import {
  CRACKLE_MIN_GAP_MS,
  PROGRESS_FILL,
  SECTION_ORDER,
  STATIC_ARC_MAX_MS,
  STATIC_ARC_MIN_MS,
  STATIC_ARC_RADIUS_PX,
  buildSectionJars,
  generateStaticArcs,
  nextCrackleDelayMs,
  nextStaticArcDelayMs,
  pickActiveSection,
  sectionProgress,
  sectionStatus,
  tablesTooltip,
  visibleSections,
  type SectionId,
  type ShelfInput,
} from "./shelf-model";

const crm = { tableName: "crm_customers", rowCount: 22 };
const billing = { tableName: "billing_invoices", rowCount: 48 };
const result = { tableName: "stitch_1_result", rowCount: 48 };
const none: ShelfInput = {
  tables: [],
  stitchOpen: false,
  proposals: null,
  stitched: null,
  recipeDone: false,
  autopsy: null,
  ask: { answered: false, loading: false },
};
const loaded: ShelfInput = { ...none, tables: [crm, billing] };
const pending: ShelfInput = { ...loaded, stitchOpen: true, proposals: { total: 14, approved: 14 } };
const stitched: ShelfInput = { ...pending, stitched: result };
const ids = (input: ShelfInput) => visibleSections(input);

describe("which jars are shown, and in what order", () => {
  it("shows only Intake on the landing page", () => {
    expect(ids(none)).toEqual(["intake"]);
  });
  it("adds Tables and Ask when tables are loaded", () => {
    expect(ids(loaded)).toEqual(["intake", "ask", "tables"]);
  });
  it("adds Stitching while proposals exist and the stitching table is open", () => {
    expect(ids(pending)).toEqual(["intake", "stitching", "ask", "tables"]);
    expect(ids({ ...pending, stitchOpen: false })).toEqual(["intake", "ask", "tables"]);
    expect(ids({ ...loaded, stitchOpen: true })).toEqual(["intake", "ask", "tables"]);
  });
  it("adds Result and Recipes once a stitch exists", () => {
    expect(ids(stitched)).toEqual(["intake", "stitching", "result", "recipes", "ask", "tables"]);
  });
  it("adds Autopsy only while one is open", () => {
    const withAutopsy = { ...stitched, autopsy: { tableName: "crm_customers", score: null } };
    expect(ids(withAutopsy)).toEqual(["intake", "stitching", "result", "recipes", "ask", "autopsy", "tables"]);
    expect(ids(loaded)).not.toContain("autopsy");
  });
  it("always keeps page order, whatever is shown (intake, stitching, result, recipes, ask, autopsy, tables)", () => {
    const all = { ...stitched, autopsy: { tableName: "x", score: 90 } };
    expect(ids(all)).toEqual(["intake", "stitching", "result", "recipes", "ask", "autopsy", "tables"]);
    expect(ids(all)).toEqual([...SECTION_ORDER]);
    const order = ids(all).map((id) => SECTION_ORDER.indexOf(id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it("has no per-table jars: two tables or ten, the jars are the same sections", () => {
    const many = { ...loaded, tables: Array.from({ length: 10 }, (_, i) => ({ tableName: `t${i}`, rowCount: i })) };
    expect(ids(many)).toEqual(ids(loaded));
  });
});

describe("progress rules", () => {
  const p = (id: SectionId, input: ShelfInput) => sectionProgress(id, input);
  it("Intake and Tables: full when tables are loaded, empty before", () => {
    expect(p("intake", none)).toBe("empty");
    expect(p("intake", loaded)).toBe("full");
    expect(p("tables", loaded)).toBe("full");
  });
  it("Stitching: half while proposals are pending, full when stitched", () => {
    expect(p("stitching", pending)).toBe("half");
    expect(p("stitching", stitched)).toBe("full");
  });
  it("Result: full when stitched", () => {
    expect(p("result", stitched)).toBe("full");
    expect(p("result", pending)).toBe("empty");
  });
  it("Recipes: full after Save recipe or Apply recipe", () => {
    expect(p("recipes", stitched)).toBe("empty");
    expect(p("recipes", { ...stitched, recipeDone: true })).toBe("full");
  });
  it("Ask the Lab: half while a question is pending, full after the first answer", () => {
    expect(p("ask", loaded)).toBe("empty");
    expect(p("ask", { ...loaded, ask: { answered: false, loading: true } })).toBe("half");
    expect(p("ask", { ...loaded, ask: { answered: true, loading: false } })).toBe("full");
  });
  it("Autopsy: half while it examines, full when the panel shows a score", () => {
    expect(p("autopsy", { ...loaded, autopsy: { tableName: "crm_customers", score: null } })).toBe("half");
    expect(p("autopsy", { ...loaded, autopsy: { tableName: "crm_customers", score: 81 } })).toBe("full");
  });
  it("maps progress to empty, half and full liquid", () => {
    expect(PROGRESS_FILL).toEqual({ empty: 0, half: 0.5, full: 1 });
    const jars = buildSectionJars(stitched);
    expect(jars.find((j) => j.id === "result")).toMatchObject({ progress: "full", fill: 1 });
    expect(jars.find((j) => j.id === "recipes")).toMatchObject({ progress: "empty", fill: 0 });
  });
});

describe("labels, names and tooltips", () => {
  it("names each jar with short labels and 'Go to <section>'", () => {
    const jars = buildSectionJars({ ...stitched, autopsy: { tableName: "x", score: 1 } });
    expect(jars.map((j) => j.label)).toEqual(["Intake", "Stitching", "Result", "Recipes", "Ask", "Autopsy", "Tables"]);
    expect(jars.map((j) => j.ariaLabel)).toEqual([
      "Go to Intake", "Go to Stitching", "Go to Result", "Go to Recipes", "Go to Ask the Lab", "Go to Autopsy", "Go to Tables",
    ]);
  });
  it("puts the table names and row counts in the Tables tooltip", () => {
    expect(tablesTooltip([crm, billing])).toBe("Tables: crm_customers 22 rows, billing_invoices 48 rows");
    expect(tablesTooltip([{ tableName: "one", rowCount: 1 }])).toBe("Tables: one 1 row");
    const nine = Array.from({ length: 9 }, (_, i) => ({ tableName: `t${i + 1}`, rowCount: 5 }));
    expect(tablesTooltip(nine)).toMatch(/t6 5 rows, and 3 more$/);
    expect(sectionStatus("tables", loaded)).toBe("Tables: crm_customers 22 rows, billing_invoices 48 rows");
  });
  it("gives a one-line status for the other sections", () => {
    expect(sectionStatus("result", stitched)).toBe("Result: 48 rows");
    expect(sectionStatus("stitching", pending)).toBe("Stitching: 14 of 14 approved");
    expect(sectionStatus("intake", loaded)).toBe("Intake: 2 tables loaded");
    expect(sectionStatus("autopsy", { ...loaded, autopsy: { tableName: "crm_customers", score: 81 } })).toBe(
      "Autopsy: crm_customers, health score 81"
    );
    expect(sectionStatus("recipes", { ...stitched, recipeDone: true })).toBe("Recipes: saved or applied");
  });
  it("uses no em dash or en dash", () => {
    const all = { ...stitched, recipeDone: true, autopsy: { tableName: "x", score: 9 } };
    for (const j of buildSectionJars(all)) expect(`${j.label}${j.ariaLabel}${j.status}`).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("the active section", () => {
  it("picks the one crossing the middle, and prefers the nested result over its stitching table", () => {
    expect(pickActiveSection([])).toBeNull();
    expect(pickActiveSection(["ask"])).toBe("ask");
    expect(pickActiveSection(["stitching", "result"])).toBe("result");
    expect(pickActiveSection(["ask", "tables"], ["intake", "stitching", "ask", "tables"])).toBe("ask");
  });
});

describe("timing and static arcs", () => {
  it("never crackles sooner than every 20 seconds", () => {
    for (const roll of [0, 0.5, 1, -2, NaN]) expect(nextCrackleDelayMs(roll)).toBeGreaterThanOrEqual(CRACKLE_MIN_GAP_MS);
  });
  it("redraws the static arcs every 300 to 600ms", () => {
    for (const roll of [0, 0.3, 0.999, 7, -1, NaN]) {
      const ms = nextStaticArcDelayMs(roll);
      expect(ms).toBeGreaterThanOrEqual(STATIC_ARC_MIN_MS);
      expect(ms).toBeLessThanOrEqual(STATIC_ARC_MAX_MS);
    }
  });
  it("makes 2 to 3 tiny jagged arcs within 40px of the ball, the same for a seed", () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const arcs = generateStaticArcs(seed);
      expect(arcs.length).toBeGreaterThanOrEqual(2);
      expect(arcs.length).toBeLessThanOrEqual(3);
      expect(generateStaticArcs(seed)).toEqual(arcs);
      for (const arc of arcs) {
        expect(arc.length).toBeGreaterThanOrEqual(4);
        for (const p of arc) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(STATIC_ARC_RADIUS_PX);
      }
    }
    expect(generateStaticArcs(1)).not.toEqual(generateStaticArcs(2));
  });
});
