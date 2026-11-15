/**
 * Feature: frankendata-little-frank, Property 6: bolt structure. For any seed
 * and target the bolt is deterministic, has 6 to 10 main segments and 2 to 3
 * branches, starts at y = 0 and ends at the target, never goes upward, and each
 * branch starts on a vertex of the main path.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateBolt } from "./lightning";

describe("Feature: frankendata-little-frank, Property 6: bolt structure", () => {
  it("holds for any seed and target", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 32 - 1 }),
        fc.integer({ min: 640, max: 3000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 100, max: 1600 }),
        (seed, width, xPct, targetY) => {
          const targetX = Math.round((xPct / 100) * width);
          const input = { seed, targetX, targetY, width };
          const bolt = generateBolt(input);
          expect(generateBolt(input)).toEqual(bolt);
          const segments = bolt.main.length - 1;
          expect(segments).toBeGreaterThanOrEqual(6);
          expect(segments).toBeLessThanOrEqual(10);
          expect(bolt.branches.length).toBeGreaterThanOrEqual(2);
          expect(bolt.branches.length).toBeLessThanOrEqual(3);
          expect(bolt.main[0].y).toBe(0);
          expect(bolt.main[segments]).toEqual({ x: targetX, y: targetY });
          for (let i = 1; i < bolt.main.length; i += 1) {
            expect(bolt.main[i].y).toBeGreaterThanOrEqual(bolt.main[i - 1].y);
          }
          for (const p of bolt.main) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(width);
          }
          for (const branch of bolt.branches) {
            const onMain = bolt.main.findIndex((m) => m.x === branch[0].x && m.y === branch[0].y);
            expect(onMain).toBeGreaterThan(0);
            expect(onMain).toBeLessThan(segments);
            for (const p of branch) expect(p.y).toBeLessThanOrEqual(targetY);
          }
        }
      ),
      { numRuns: 300 }
    );
  });
});
