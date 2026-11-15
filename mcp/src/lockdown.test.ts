// @vitest-environment node
/**
 * Defense in depth (security-hardening, commit A): the MCP DuckDB runs with
 * external access disabled and the configuration locked, so a query that slips
 * past the validator still cannot read or write files or the network. Intake
 * style SQL (CREATE TABLE, INSERT, SELECT) must keep working.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeDuckDB, type NodeDuckDB } from "./node-duckdb";

let db: NodeDuckDB;
let dir: string;

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "frankendata-lock-")));
  db = await createNodeDuckDB();
}, 60000);

afterEach(() => {
  db.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("MCP DuckDB lockdown", () => {
  it("cannot read a local file or write one", async () => {
    const input = path.join(dir, "in.csv");
    const output = path.join(dir, "out.csv");
    fs.writeFileSync(input, "a\n1\n2\n");
    await db.service.query("CREATE TABLE t AS SELECT 1 AS a");
    await expect(db.service.query(`SELECT * FROM read_csv('${input}')`)).rejects.toThrow();
    await expect(db.service.query(`COPY t TO '${output}' (FORMAT CSV)`)).rejects.toThrow();
    expect(fs.existsSync(output)).toBe(false);
  }, 60000);

  it("cannot be re-enabled and the configuration is locked", async () => {
    await expect(db.service.query("SET enable_external_access=true")).rejects.toThrow();
    await expect(db.service.query("SET threads=1")).rejects.toThrow();
  }, 60000);

  it("still runs intake-style SQL", async () => {
    await db.service.query("CREATE TABLE t AS SELECT 1 AS a");
    await db.service.query("INSERT INTO t VALUES (2)");
    const rows = await db.service.query<{ n: number | bigint }>("SELECT count(*) AS n FROM t");
    expect(Number(rows[0].n)).toBe(2);
    await db.service.query("CREATE TABLE stitch_1_result AS SELECT * FROM t");
    await db.service.query("DROP TABLE stitch_1_result");
  }, 60000);
});
