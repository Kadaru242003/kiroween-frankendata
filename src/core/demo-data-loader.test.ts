/**
 * Sanity tests for {@link BundledDemoDataLoader}.
 *
 * These confirm the loader's contract from task 18.1: `load()` returns exactly
 * three `.csv` `File` objects built from bundled data with no network access.
 * The dedicated demo-content and bundling tests are the optional tasks 18.3 /
 * 18.4; this file only covers the loader's basic shape.
 */

import { describe, expect, it } from "vitest";
import { BundledDemoDataLoader, demoDataLoader } from "./demo-data-loader";

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
