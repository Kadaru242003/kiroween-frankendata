/**
 * Sanity tests for {@link BundledDemoDataLoader}.
 *
 * These confirm the loader's contract from task 18.1: `load()` returns exactly
 * three `.csv` `File` objects built from bundled data with no network access.
 * The dedicated demo-content and bundling tests are the optional tasks 18.3 /
 * 18.4; this file only covers the loader's basic shape.
 */

import { describe, expect, it } from "vitest";
import {
  BundledDemoDataLoader,
  demoDataLoader,
  MISMATCHED_DEMO_FILE_NAMES,
} from "./demo-data-loader";

/** Parse a CSV string into header + data rows (simple, no quoted commas here). */
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.trim().split("\n");
  const header = lines[0].split(",");
  const rows = lines.slice(1).map((line) => line.split(","));
  return { header, rows };
}

describe("BundledDemoDataLoader.load", () => {
  it("returns exactly three File objects", async () => {
    const files = await new BundledDemoDataLoader().load();
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect(file).toBeInstanceOf(File);
    }
  });

  it("returns CSV files with friendly names and the text/csv type", async () => {
    const files = await demoDataLoader.load();
    const names = files.map((f) => f.name);
    expect(names).toEqual(["monsters.csv", "experiments.csv", "lab_inventory.csv"]);
    for (const file of files) {
      expect(file.name.endsWith(".csv")).toBe(true);
      expect(file.type).toBe("text/csv");
    }
  });

  it("builds non-empty files from bundled data", async () => {
    const files = await demoDataLoader.load();
    for (const file of files) {
      const text = await file.text();
      expect(text.length).toBeGreaterThan(0);
      // Each dataset has a header row plus several data rows.
      expect(text.trim().split("\n").length).toBeGreaterThan(1);
    }
  });
});

describe("BundledDemoDataLoader.loadMismatched (Req 8.1–8.4)", () => {
  it("returns at least two CSV File objects with no network access", async () => {
    // Guard against accidental network use: fail loudly if fetch is touched.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args: Parameters<typeof fetch>): never => {
      throw new Error(
        `demo loader attempted a network request: ${String(args[0])}`
      );
    };
    try {
      const files = await new BundledDemoDataLoader().loadMismatched();
      expect(files.length).toBeGreaterThanOrEqual(2);
      for (const file of files) {
        expect(file).toBeInstanceOf(File);
        expect(file.name.endsWith(".csv")).toBe(true);
        expect(file.type).toBe("text/csv");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes the mismatched file names in display order", async () => {
    const files = await demoDataLoader.loadMismatched();
    expect(files.map((f) => f.name)).toEqual([...MISMATCHED_DEMO_FILE_NAMES]);
    expect(MISMATCHED_DEMO_FILE_NAMES.length).toBeGreaterThanOrEqual(2);
  });

  it("describes the same entities with DIFFERENT column headers across files (Req 8.2)", async () => {
    const files = await demoDataLoader.loadMismatched();
    const headers = await Promise.all(
      files.map(async (f) => parseCsv(await f.text()).header)
    );
    const [headerA, headerB] = headers;

    // The two files must not share their raw header set — matching has to
    // bridge them by fuzzy similarity, not exact equality.
    const shared = headerA.filter((h) => headerB.includes(h));
    expect(shared).toEqual([]);

    // But a creature-name header exists on each side so a name<->name match can
    // surface (e.g. "Monster Name" <-> "name").
    const nameLikeA = headerA.find((h) => /name/i.test(h));
    const nameLikeB = headerB.find((h) => /name/i.test(h));
    expect(nameLikeA).toBeDefined();
    expect(nameLikeB).toBeDefined();
  });

  it("shares entity (creature-name) VALUES across the two files so overlap exists", async () => {
    const files = await demoDataLoader.loadMismatched();
    const [a, b] = files;
    const parsedA = parseCsv(await a.text());
    const parsedB = parseCsv(await b.text());

    const nameColA = parsedA.header.findIndex((h) => /name/i.test(h));
    const nameColB = parsedB.header.findIndex((h) => /name/i.test(h));
    const namesA = new Set(parsedA.rows.map((r) => r[nameColA]));
    const namesB = new Set(parsedB.rows.map((r) => r[nameColB]));

    const overlap = [...namesA].filter((n) => namesB.has(n));
    // Most creatures appear in both files (a strong, expected match signal).
    expect(overlap.length).toBeGreaterThanOrEqual(3);
  });

  it("contains INCONSISTENT category spellings/casing/whitespace (Req 8.3)", async () => {
    const files = await demoDataLoader.loadMismatched();
    const [a, b] = files;
    const parsedA = parseCsv(await a.text());
    const parsedB = parseCsv(await b.text());

    // Collect every species/creature-type value across both files, then fold
    // it the way category-standardize does (lowercase, strip punctuation,
    // collapse whitespace). A category is "inconsistent" when one folded form
    // has two or more distinct raw surface forms.
    const speciesColA = parsedA.header.findIndex((h) => /species/i.test(h));
    const speciesColB = parsedB.header.findIndex((h) => /creature/i.test(h));
    const rawValues = [
      ...parsedA.rows.map((r) => r[speciesColA]),
      ...parsedB.rows.map((r) => r[speciesColB]),
    ];
    const fold = (v: string) =>
      v
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");

    const surfacesByFold = new Map<string, Set<string>>();
    for (const value of rawValues) {
      const key = fold(value);
      const set = surfacesByFold.get(key) ?? new Set<string>();
      set.add(value);
      surfacesByFold.set(key, set);
    }
    const hasInconsistency = [...surfacesByFold.values()].some(
      (surfaces) => surfaces.size >= 2
    );
    expect(hasInconsistency).toBe(true);
  });

  it("contains SOME duplicate rows (Req 8.3)", async () => {
    const files = await demoDataLoader.loadMismatched();
    for (const file of files) {
      const { rows } = parseCsv(await file.text());
      const seen = new Set<string>();
      const hasDuplicate = rows.some((row) => {
        const key = row.join("\u0001");
        if (seen.has(key)) {
          return true;
        }
        seen.add(key);
        return false;
      });
      if (hasDuplicate) {
        // At least one file carries a fully-duplicate row — enough for the
        // duplicate-rows cleaning proposal to have something to propose.
        expect(hasDuplicate).toBe(true);
        return;
      }
    }
    throw new Error("expected at least one duplicate row across the mismatched files");
  });

  it("does NOT reuse the first demo dataset's content (it is a distinct set)", async () => {
    const [firstSet, mismatched] = await Promise.all([
      demoDataLoader.load(),
      demoDataLoader.loadMismatched(),
    ]);
    const firstTexts = await Promise.all(firstSet.map((f) => f.text()));
    const mismatchedTexts = await Promise.all(mismatched.map((f) => f.text()));
    for (const text of mismatchedTexts) {
      expect(firstTexts).not.toContain(text);
    }
  });
});
