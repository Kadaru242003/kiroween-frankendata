import { describe, expect, it } from "vitest";
import { generateBolt, mulberry32, pointsToPath } from "./lightning";

const input = { seed: 42, targetX: 59, targetY: 700, width: 1280 };

describe("generateBolt", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    expect(generateBolt(input)).toEqual(generateBolt(input));
    expect(generateBolt({ ...input, seed: 43 })).not.toEqual(generateBolt(input));
  });

  it("starts at the top edge, ends at the target, with 6 to 10 segments and 2 to 3 branches", () => {
    const bolt = generateBolt(input);
    expect(bolt.main[0].y).toBe(0);
    expect(bolt.main[bolt.main.length - 1]).toEqual({ x: 59, y: 700 });
    expect(bolt.main.length - 1).toBeGreaterThanOrEqual(6);
    expect(bolt.main.length - 1).toBeLessThanOrEqual(10);
    expect(bolt.branches.length).toBeGreaterThanOrEqual(2);
    expect(bolt.branches.length).toBeLessThanOrEqual(3);
    expect(bolt.sparks.length).toBeGreaterThanOrEqual(8);
    expect(bolt.sparks.length).toBeLessThanOrEqual(12);
  });

  it("zigzags: consecutive segments alternate the sideways direction", () => {
    const { main } = generateBolt(input);
    let flips = 0;
    for (let i = 2; i < main.length - 1; i += 1) {
      const a = main[i - 1].x - main[i - 2].x;
      const b = main[i].x - main[i - 1].x;
      if (a * b < 0) flips += 1;
    }
    expect(flips).toBeGreaterThanOrEqual(2);
  });

  it("makes a path string and a repeatable random stream", () => {
    expect(pointsToPath([{ x: 1, y: 0 }, { x: 2.5, y: 10 }])).toBe("M1 0 L2.5 10");
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
