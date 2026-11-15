import { describe, expect, it } from "vitest";
import { LOCKDOWN_SQL, lockDownConnection } from "./duckdb-lockdown";

describe("lockDownConnection", () => {
  it("disables external access first, then locks the configuration", async () => {
    const seen: string[] = [];
    await lockDownConnection(async (sql) => {
      seen.push(sql);
    });
    expect(seen).toEqual([...LOCKDOWN_SQL]);
    expect(seen[0]).toMatch(/enable_external_access\s*=\s*false/i);
    expect(seen[1]).toMatch(/lock_configuration\s*=\s*true/i);
  });

  it("fails closed: a failing statement rejects and later statements do not run", async () => {
    const seen: string[] = [];
    await expect(
      lockDownConnection(async (sql) => {
        seen.push(sql);
        throw new Error("nope");
      })
    ).rejects.toThrow(/nope/);
    expect(seen).toHaveLength(1);
  });
});
