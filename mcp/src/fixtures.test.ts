// @vitest-environment node
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { demoDataLoader } from "../../src/core/demo-data-loader";
import { FIXTURES } from "./test-support";

describe("fixtures", () => {
  it("equal the bundled mismatched demo files", async () => {
    for (const f of await demoDataLoader.loadMismatched()) {
      expect(fs.readFileSync(path.join(FIXTURES, f.name), "utf8")).toBe(await f.text());
    }
  });
});
