/**
 * Unit tests for fuzzy column-name similarity (Feature 2, task 5).
 *
 * Covers the design's "Name normalization" and "nameSim(a, b)" sections and
 * Requirements 1.2 (name-based matching) and 1.4 (symmetry):
 *   - normalization: camelCase, snake_case, kebab/punctuation splits, NFKC,
 *     and case folding;
 *   - nameSim bounds [0, 1];
 *   - nameSim symmetry: nameSim(a, b) === nameSim(b, a);
 *   - identical names score exactly 1;
 *   - a few known worked pairs from the design.
 */

import { describe, expect, it } from "vitest";
import { levenshtein, nameSim, normalizeName } from "./name-similarity";

describe("normalizeName", () => {
  it("splits on whitespace and lowercases (design example)", () => {
    expect(normalizeName("Monster Name")).toEqual(["monster", "name"]);
  });

  it("splits snake_case into tokens (design example)", () => {
    expect(normalizeName("lead_scientist")).toEqual(["lead", "scientist"]);
  });

  it("splits camelCase into tokens", () => {
    expect(normalizeName("leadScientist")).toEqual(["lead", "scientist"]);
    expect(normalizeName("monsterNameId")).toEqual(["monster", "name", "id"]);
  });

  it("splits kebab-case and arbitrary punctuation", () => {
    expect(normalizeName("swamp-wraith")).toEqual(["swamp", "wraith"]);
    expect(normalizeName("a.b/c:d")).toEqual(["a", "b", "c", "d"]);
  });

  it("splits letter/digit boundaries", () => {
    expect(normalizeName("col2name")).toEqual(["col", "2", "name"]);
    expect(normalizeName("v2")).toEqual(["v", "2"]);
  });

  it("handles acronym-to-word boundaries", () => {
    expect(normalizeName("HTTPServer")).toEqual(["http", "server"]);
    expect(normalizeName("parseXMLFile")).toEqual(["parse", "xml", "file"]);
  });

  it("drops empty tokens from leading/trailing/repeated separators", () => {
    expect(normalizeName("  __Monster__  ")).toEqual(["monster"]);
    expect(normalizeName("---")).toEqual([]);
    expect(normalizeName("")).toEqual([]);
  });

  it("applies Unicode NFKC normalization before tokenizing", () => {
    // Full-width Latin letters (U+FF2E 'Ｎ' …) fold to ASCII under NFKC.
    expect(normalizeName("\uFF2E\uFF41\uFF4D\uFF45")).toEqual(["name"]);
    // The ﬁ ligature (U+FB01) folds to "fi" under NFKC.
    expect(normalizeName("\uFB01eld")).toEqual(["field"]);
  });

  it("lowercases regardless of input case", () => {
    expect(normalizeName("NAME")).toEqual(["name"]);
    expect(normalizeName("Name")).toEqual(["name"]);
  });
});

describe("levenshtein", () => {
  it("is zero for identical strings", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("equals the other length when one string is empty", () => {
    expect(levenshtein("", "abcd")).toBe(4);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("counts single edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("scientist", "scientst")).toBe(1);
  });

  it("is symmetric", () => {
    expect(levenshtein("abc", "axc")).toBe(levenshtein("axc", "abc"));
  });
});

describe("nameSim", () => {
  it("scores identical names as exactly 1", () => {
    expect(nameSim("name", "name")).toBe(1);
    expect(nameSim("Monster Name", "monster name")).toBe(1);
    expect(nameSim("lead_scientist", "leadScientist")).toBe(1);
  });

  it("treats two empty / all-separator names as identical (1)", () => {
    expect(nameSim("", "")).toBe(1);
    expect(nameSim("---", "   ")).toBe(1);
  });

  it("stays within [0, 1] for arbitrary inputs", () => {
    const pairs: Array<[string, string]> = [
      ["Monster Name", "name"],
      ["scientist", "lead_scientist"],
      ["abc", "xyz"],
      ["", "something"],
      ["a very long column header", "short"],
    ];
    for (const [a, b] of pairs) {
      const s = nameSim(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("is symmetric: nameSim(a, b) === nameSim(b, a)", () => {
    const pairs: Array<[string, string]> = [
      ["Monster Name", "name"],
      ["scientist", "lead_scientist"],
      ["swamp-wraith", "Swamp Wraith"],
      ["abc", "xyz"],
      ["col2name", "name2col"],
      ["", "x"],
    ];
    for (const [a, b] of pairs) {
      expect(nameSim(a, b)).toBe(nameSim(b, a));
    }
  });

  it("matches the design's worked token example: 'Monster Name' vs 'name'", () => {
    // Tokens {monster,name} vs {name} → Jaccard T = 1/2 = 0.5.
    // Joined "monstername" (11) vs "name" (4): levenshtein = 7,
    //   C = 1 - 7/11 = 4/11.
    // nameSim = 0.6*0.5 + 0.4*(4/11) = 0.3 + 0.1454545… = 0.4454545…
    const expected = 0.6 * 0.5 + 0.4 * (1 - 7 / 11);
    expect(nameSim("Monster Name", "name")).toBeCloseTo(expected, 12);
  });

  it("scores a single-word typo high (shared character structure)", () => {
    // "scientist" vs "scientst": token Jaccard = 0 (different single tokens),
    // char score = 1 - 1/9. nameSim = 0.4*(8/9) ≈ 0.3556.
    const expected = 0.4 * (1 - 1 / 9);
    expect(nameSim("scientist", "scientst")).toBeCloseTo(expected, 12);
  });

  it("scores unrelated names low", () => {
    expect(nameSim("abc", "xyz")).toBeLessThan(0.2);
  });

  it("ranks a closer name above a more distant one", () => {
    const closer = nameSim("lead_scientist", "scientist");
    const distant = nameSim("lead_scientist", "monster");
    expect(closer).toBeGreaterThan(distant);
  });
});
