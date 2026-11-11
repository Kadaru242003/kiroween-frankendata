/**
 * Unit test for table-name de-duplication ACROSS sequential intake calls
 * (Feature 2 polish, bug fix).
 *
 * Bug: loading a file (e.g. the demo data's `monsters.csv`) and THEN loading
 * another file whose name sanitizes to the same table name (e.g. the mismatched
 * demo's `monsters.csv`, or a second dropped `monsters.csv`) crashed the second
 * load with "Catalog Error: Table with name monsters already exists". The
 * controller de-duplicated names only WITHIN a single `intake()` call, so a
 * clash with a table loaded by an EARLIER call was never suffixed.
 *
 * Fix: the controller seeds its per-call `existingTableNames` with the names of
 * the tables already present in the session store (which mirrors the DuckDB
 * catalog), so a later clash gets the usual numeric suffix (`monsters_2`).
 *
 * The fake DuckDBService below mimics DuckDB's catalog: `createTable` throws if
 * asked to create a name that already exists. A passing test therefore proves
 * the controller never re-requests an already-taken name.
 */

import { describe, expect, it } from "vitest";
import { createIntakeController } from "./intake-controller";
import type {
  CellValue,
  ColumnSchema,
  DuckDBService,
  LoadedTable,
} from "./types";
import { IntakeStore } from "../state/intake-store";

/** A valid single-column CSV that loads successfully. */
function csvFile(name: string): File {
  return new File(["a,b\n1,2"], name, { type: "text/csv" });
}

/**
 * A fake {@link DuckDBService} that models DuckDB's catalog: creating a table
 * with a name that already exists throws, exactly like the real engine's
 * "Catalog Error: Table with name <n> already exists".
 */
function createCatalogFakeDuckDBService(): DuckDBService {
  const existing = new Set<string>();
  return {
    async init(): Promise<void> {},
    async createTable(
      tableName: string,
      schema: ColumnSchema[],
      rows: CellValue[][]
    ): Promise<LoadedTable> {
      if (existing.has(tableName)) {
        throw new Error(
          `Catalog Error: Table with name ${tableName} already exists`
        );
      }
      existing.add(tableName);
      return {
        loadId: 0,
        tableName,
        sourceFileName: tableName,
        schema,
        rowCount: rows.length,
      };
    },
    async getRowCount(): Promise<number> {
      return 0;
    },
    async getPreviewRows(): Promise<Record<string, unknown>[]> {
      return [];
    },
    async query<T = Record<string, unknown>>(): Promise<T[]> {
      return [] as T[];
    },
  };
}

describe("IntakeController — table-name de-duplication across sequential intake calls", () => {
  it("suffixes a same-named file loaded in a LATER intake call (monsters → monsters_2)", async () => {
    const duckDBService = createCatalogFakeDuckDBService();
    const store = new IntakeStore();
    const controller = createIntakeController({ duckDBService, store });

    // First load: a clean `monsters` table.
    await controller.intake([csvFile("monsters.csv")]);
    // Second load: the SAME file name again — must not clash with the existing
    // table, and must not record an intake error.
    await controller.intake([csvFile("monsters.csv")]);

    const { tables, errors } = store.getState();
    expect(errors).toEqual([]);
    expect(tables.map((t) => t.tableName)).toEqual(["monsters", "monsters_2"]);
  });

  it("continues suffixing across three sequential loads (monsters, monsters_2, monsters_3)", async () => {
    const duckDBService = createCatalogFakeDuckDBService();
    const store = new IntakeStore();
    const controller = createIntakeController({ duckDBService, store });

    await controller.intake([csvFile("monsters.csv")]);
    await controller.intake([csvFile("monsters.csv")]);
    await controller.intake([csvFile("monsters.csv")]);

    const { tables, errors } = store.getState();
    expect(errors).toEqual([]);
    expect(tables.map((t) => t.tableName)).toEqual([
      "monsters",
      "monsters_2",
      "monsters_3",
    ]);
  });

  it("still de-duplicates WITHIN a single call as before", async () => {
    const duckDBService = createCatalogFakeDuckDBService();
    const store = new IntakeStore();
    const controller = createIntakeController({ duckDBService, store });

    await controller.intake([csvFile("monsters.csv"), csvFile("monsters.csv")]);

    const { tables, errors } = store.getState();
    expect(errors).toEqual([]);
    expect(tables.map((t) => t.tableName)).toEqual(["monsters", "monsters_2"]);
  });
});
