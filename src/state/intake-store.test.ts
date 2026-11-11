/**
 * Minimal sanity unit tests for {@link IntakeStore} (session state, Req 7.1,
 * 8.2, 8.3, 9.3). Behavioral property tests for the controller/store arrive in
 * tasks 12.3–12.5; these just confirm the basic observable contract.
 */

import { describe, expect, it, vi } from "vitest";
import type { IntakeError, LoadedTable } from "../core/types";
import { IntakeStore } from "./intake-store";

const sampleTable: LoadedTable = {
  // loadId here is a placeholder; the store stamps its own per-session value in
  // addTable, so assertions below compare against the stamped id, not this one.
  loadId: 0,
  tableName: "sales_2024",
  sourceFileName: "Sales 2024.csv",
  schema: [{ name: "amount", type: "number" }],
  rowCount: 3,
};

const sampleError: IntakeError = {
  sourceFileName: "broken.xlsx",
  stage: "parsing",
  kind: "corrupt-file",
  message: 'File "broken.xlsx" could not be read.',
};

describe("IntakeStore", () => {
  it("starts empty", () => {
    const store = new IntakeStore();
    expect(store.getState().tables).toEqual([]);
    expect(store.getState().errors).toEqual([]);
  });

  it("appends tables and errors in order", () => {
    const store = new IntakeStore();
    store.addTable(sampleTable);
    store.addError(sampleError);

    // addTable stamps the authoritative per-session loadId, so the stored table
    // matches sampleTable except for its (first) loadId of 1.
    expect(store.getState().tables).toEqual([{ ...sampleTable, loadId: 1 }]);
    expect(store.getState().errors).toEqual([sampleError]);
  });

  it("produces a new snapshot reference on each mutation", () => {
    const store = new IntakeStore();
    const before = store.getState();
    store.addTable(sampleTable);
    const after = store.getState();

    expect(after).not.toBe(before);
    // The untouched slice keeps its reference.
    expect(after.errors).toBe(before.errors);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const store = new IntakeStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.addTable(sampleTable);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.addError(sampleError);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reset clears tables and errors back to empty", () => {
    const store = new IntakeStore();
    store.addTable(sampleTable);
    store.addError(sampleError);
    store.reset();

    expect(store.getState().tables).toEqual([]);
    expect(store.getState().errors).toEqual([]);
  });

  it("reset is a no-op (no notification) when already empty", () => {
    const store = new IntakeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.reset();
    expect(listener).not.toHaveBeenCalled();
  });

  it("assigns a monotonically increasing loadId to each added table", () => {
    const store = new IntakeStore();
    store.addTable(sampleTable);
    store.addTable(sampleTable);
    store.addTable(sampleTable);

    const ids = store.getState().tables.map((t) => t.loadId);
    expect(ids).toEqual([1, 2, 3]);
  });

  it("gives a re-added same-name/same-rowcount table a strictly greater loadId (Req 3.8)", () => {
    const store = new IntakeStore();

    // Re-dropping the exact same file: identical sourceFileName and rowCount.
    store.addTable(sampleTable);
    store.addTable(sampleTable);

    const [first, second] = store.getState().tables;
    expect(second.sourceFileName).toBe(first.sourceFileName);
    expect(second.rowCount).toBe(first.rowCount);
    // Despite the identical name+rowCount signature, the loadId strictly
    // increases, so Feature 2's datasetVersion still invalidates correctly.
    expect(second.loadId).toBeGreaterThan(first.loadId);
  });

  it("never reuses a loadId after reset (ids keep increasing across sessions)", () => {
    const store = new IntakeStore();
    store.addTable(sampleTable);
    const firstId = store.getState().tables[0].loadId;

    store.reset();
    store.addTable(sampleTable);
    const afterResetId = store.getState().tables[0].loadId;

    expect(afterResetId).toBeGreaterThan(firstId);
  });
});
