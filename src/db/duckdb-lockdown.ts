/**
 * Defense in depth for the DuckDB instance (security-hardening, commit A).
 *
 * The SQL validator is the first line of defense for model-written SQL. This is
 * the second: once the instance is open, switch off external access (no file or
 * network reads or writes through SQL) and lock the configuration so it cannot
 * be switched back on.
 *
 * Why it is safe for this app: file intake parses in JavaScript (PapaParse and
 * SheetJS) and writes with `CREATE TABLE` and `INSERT ... VALUES`, and the
 * stitch applier, Autopsy and Ask only run `CREATE TABLE AS`, `INSERT`,
 * `DROP` and `SELECT`. None of those touch the file system. The only code that
 * needs a file is the optional `exportFileBytes` (`COPY ... TO`), which no
 * production path calls; it only exists for the Recipes tests, whose harness
 * does not call this function.
 *
 * Verified on DuckDB 1.4.3 (node-blocking bundle): after these two statements
 * `read_csv` on a local file and `COPY ... TO` fail, `enable_external_access`
 * cannot be set back to true, other settings cannot be changed, and
 * `CREATE TABLE`, `INSERT`, `SELECT` and `DROP` still work.
 *
 * It must run once, right after the instance opens and before any user data or
 * model SQL. It fails closed: if a statement fails the caller's init fails.
 */

/** The statements, in order. `lock_configuration` must come last. */
export const LOCKDOWN_SQL = [
  "SET enable_external_access = false",
  "SET lock_configuration = true",
] as const;

/** Run the lockdown statements through `run`, stopping at the first failure. */
export async function lockDownConnection(run: (sql: string) => Promise<unknown>): Promise<void> {
  for (const sql of LOCKDOWN_SQL) {
    await run(sql);
  }
}
