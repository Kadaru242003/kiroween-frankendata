/**
 * The wake-up lightning bolt generator (pure; no React, no DOM).
 *
 * `generateBolt` builds a jagged main path from the top edge of the viewport
 * (y = 0) down to a target (Frank's head), 2 to 3 short branches that split off
 * vertices of the main path, and a ring of spark directions for the impact. A
 * seeded PRNG draws everything, so the same input always gives the same bolt
 * and a new seed makes each strike differ slightly.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Spark {
  /** Direction in radians. */
  angle: number;
  /** How far it flies, in px. */
  distance: number;
}

export interface Bolt {
  /** 7 to 11 points: 6 to 10 segments, from y = 0 to the target. */
  main: Point[];
  /** 2 to 3 short paths; each starts on an interior vertex of `main`. */
  branches: Point[][];
  /** 8 to 12 impact sparks. */
  sparks: Spark[];
}

export interface BoltInput {
  seed: number;
  targetX: number;
  targetY: number;
  /** Viewport width in px; x stays inside [0, width]. */
  width: number;
}

export const BOLT_MIN_SEGMENTS = 6;
export const BOLT_MAX_SEGMENTS = 10;
export const BOLT_MIN_BRANCHES = 2;
export const BOLT_MAX_BRANCHES = 3;
export const BOLT_MIN_SPARKS = 8;
export const BOLT_MAX_SPARKS = 12;

/** A small, fast, seedable PRNG: returns numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Build the bolt for a seed and a target. Deterministic. */
export function generateBolt(input: BoltInput): Bolt {
  const rand = mulberry32(input.seed);
  const width = Math.max(1, Number.isFinite(input.width) ? input.width : 1);
  const targetX = clamp(Number.isFinite(input.targetX) ? input.targetX : 0, 0, width);
  const targetY = Math.max(60, Number.isFinite(input.targetY) ? input.targetY : 60);

  const segments = BOLT_MIN_SEGMENTS + Math.floor(rand() * (BOLT_MAX_SEGMENTS - BOLT_MIN_SEGMENTS + 1));
  const step = targetY / segments;
  const startX = clamp(targetX + (rand() - 0.5) * 0.3 * width, 0, width);
  const zig = clamp(step * 0.45, 14, 60);

  const main: Point[] = [{ x: round1(startX), y: 0 }];
  for (let i = 1; i < segments; i += 1) {
    const t = i / segments;
    const y = targetY * t + (rand() - 0.5) * 0.5 * step;
    const side = i % 2 === 0 ? 1 : -1;
    const x = startX + (targetX - startX) * t + side * (0.5 + rand() * 0.8) * zig;
    main.push({ x: round1(clamp(x, 0, width)), y: round1(y) });
  }
  main.push({ x: round1(targetX), y: round1(targetY) });

  // Branches split off distinct interior vertices (1 .. segments - 1).
  const branchCount =
    BOLT_MIN_BRANCHES + Math.floor(rand() * (BOLT_MAX_BRANCHES - BOLT_MIN_BRANCHES + 1));
  const candidates: number[] = [];
  for (let i = 1; i < segments; i += 1) candidates.push(i);
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const branches: Point[][] = [];
  for (const index of candidates.slice(0, branchCount)) {
    const origin = main[index];
    const length = 2 + Math.floor(rand() * 3);
    let sign = rand() < 0.5 ? -1 : 1;
    const points: Point[] = [origin];
    let { x, y } = origin;
    for (let k = 0; k < length; k += 1) {
      y = Math.min(targetY - 4, y + step * (0.5 + rand() * 0.6));
      x = clamp(x + sign * (10 + rand() * 28), 0, width);
      points.push({ x: round1(x), y: round1(y) });
      if (rand() < 0.5) sign = -sign;
    }
    branches.push(points);
  }

  const sparkCount = BOLT_MIN_SPARKS + Math.floor(rand() * (BOLT_MAX_SPARKS - BOLT_MIN_SPARKS + 1));
  const sparks: Spark[] = [];
  for (let i = 0; i < sparkCount; i += 1) {
    sparks.push({
      angle: round1(((i / sparkCount) * Math.PI * 2 + (rand() - 0.5) * 0.5) * 100) / 100,
      distance: round1(24 + rand() * 40),
    });
  }

  return { main, branches, sparks };
}

/** An SVG path `d` string through the points. */
export function pointsToPath(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
}
