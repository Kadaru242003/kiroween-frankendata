/**
 * The lab shelf model (pure; no React, no DOM). The shelf is page navigation: one
 * jar per page section, shown only while that section exists, in workflow order.
 * Each jar's liquid shows how far that step has got (empty, half, full), and its
 * tooltip gives a one-line status. This holds no state of its own: it is a
 * function of what the app already knows.
 */
import { mulberry32, type Point } from "../frank/lightning.js";

/** The shelf shows at this viewport width and above (the right gutter is empty). */
export const SHELF_MIN_WIDTH_PX = 1440;
/** The shelf never scales below this fraction when it does not fit the window. */
export const SHELF_MIN_SCALE = 0.7;
/** The idle coil crackle waits at least this long between crackles. */
export const CRACKLE_MIN_GAP_MS = 20000;
export const CRACKLE_MAX_GAP_MS = 35000;
/** The static dancing on the coil's ball is redrawn every 300 to 600ms. */
export const STATIC_ARC_MIN_MS = 300;
export const STATIC_ARC_MAX_MS = 600;
/** The static arcs stay within this distance (px) of the ball's centre. */
export const STATIC_ARC_RADIUS_PX = 40;
/** How many tables the Tables tooltip names before it says "and N more". */
export const TOOLTIP_MAX_TABLES = 6;

/** Workflow order, which is the order of the jars. */
export const SECTION_ORDER = ["intake", "tables", "stitching", "result", "recipes", "autopsy", "ask"] as const;
export type SectionId = (typeof SECTION_ORDER)[number];

/** The short name printed under each jar (never truncated). */
export const SECTION_LABEL: Record<SectionId, string> = {
  intake: "Intake",
  tables: "Tables",
  stitching: "Stitching",
  result: "Result",
  recipes: "Recipes",
  autopsy: "Autopsy",
  ask: "Ask",
};

/** The full name, for the accessible name and the tooltip. */
export const SECTION_NAME: Record<SectionId, string> = {
  ...SECTION_LABEL,
  ask: "Ask the Lab",
};

/** A section that sits inside another one on the page (the result is inside the stitching table). */
export const SECTION_PARENT: Partial<Record<SectionId, SectionId>> = { result: "stitching" };

export type Progress = "empty" | "half" | "full";
/** How full the liquid is for each progress (fraction of the jar's inside height). */
export const PROGRESS_FILL: Record<Progress, number> = { empty: 0, half: 0.5, full: 1 };

export interface ShelfTable {
  tableName: string;
  rowCount: number;
}

/** What the shelf needs to know. Every field comes from state the app already has. */
export interface ShelfInput {
  tables: readonly ShelfTable[];
  /** The stitching table is open on the page. */
  stitchOpen: boolean;
  /** Stitch proposals: how many, and how many are approved. Null when there are none. */
  proposals: { total: number; approved: number } | null;
  /** The stitched result, once a stitch exists. */
  stitched: ShelfTable | null;
  /** A recipe was saved or applied (this session). */
  recipeDone: boolean;
  /** The open Autopsy panel, with its health score once it shows one. */
  autopsy: { tableName: string; score: number | null } | null;
  /** The Ask the Lab panel: has it given an answer, is a question pending. */
  ask: { answered: boolean; loading: boolean };
}

export interface SectionJar {
  id: SectionId;
  /** The short name under the jar. */
  label: string;
  /** "Go to <section>". */
  ariaLabel: string;
  progress: Progress;
  /** 0, 0.5 or 1. */
  fill: number;
  /** The tooltip: the section name and a one-line status. */
  status: string;
}

function cleanCount(n: number): number {
  if (n === Infinity) return Number.MAX_SAFE_INTEGER;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** "1 row" or "1,234 rows". */
export function rowsText(rowCount: number): string {
  const n = cleanCount(rowCount);
  return `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;
}

/** Which jars are shown, in order. Intake always; the rest only while their section exists. */
export function visibleSections(input: ShelfInput): SectionId[] {
  const has = input.tables.length > 0;
  const stitchingShown = input.stitchOpen && input.proposals !== null;
  const resultShown = input.stitchOpen && input.stitched !== null;
  const shown: Record<SectionId, boolean> = {
    intake: true,
    tables: has,
    stitching: stitchingShown,
    result: resultShown,
    recipes: input.stitched !== null,
    autopsy: input.autopsy !== null,
    ask: has,
  };
  return SECTION_ORDER.filter((id) => shown[id]);
}

/** Step completion for a section: not started, in progress, done. */
export function sectionProgress(id: SectionId, input: ShelfInput): Progress {
  const loaded = input.tables.length > 0;
  switch (id) {
    case "intake":
    case "tables":
      return loaded ? "full" : "empty";
    case "stitching":
      if (input.stitched !== null) return "full";
      return input.proposals !== null ? "half" : "empty";
    case "result":
      return input.stitched !== null ? "full" : "empty";
    case "recipes":
      return input.recipeDone ? "full" : "empty";
    case "autopsy":
      if (input.autopsy === null) return "empty";
      return input.autopsy.score !== null ? "full" : "half";
    case "ask":
      if (input.ask.answered) return "full";
      return input.ask.loading ? "half" : "empty";
  }
}

/** "Tables: crm_customers 22 rows, billing_invoices 48 rows" (long lists end "and N more"). */
export function tablesTooltip(tables: readonly ShelfTable[]): string {
  if (tables.length === 0) return "Tables: none loaded";
  const named = tables.slice(0, TOOLTIP_MAX_TABLES).map((t) => `${t.tableName} ${rowsText(t.rowCount)}`);
  const rest = tables.length - named.length;
  return `Tables: ${named.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
}

/** The one-line tooltip status for a section. */
export function sectionStatus(id: SectionId, input: ShelfInput): string {
  const n = input.tables.length;
  switch (id) {
    case "intake":
      return n > 0
        ? `Intake: ${n} ${n === 1 ? "table" : "tables"} loaded`
        : "Intake: drop CSV or XLSX files, or load a demo";
    case "tables":
      return tablesTooltip(input.tables);
    case "stitching": {
      const p = input.proposals ?? { total: 0, approved: 0 };
      return `Stitching: ${p.approved} of ${p.total} approved${input.stitched !== null ? ", stitched" : ""}`;
    }
    case "result":
      return `Result: ${rowsText(input.stitched?.rowCount ?? 0)}`;
    case "recipes":
      return input.recipeDone ? "Recipes: saved or applied" : "Recipes: not saved yet";
    case "autopsy": {
      const a = input.autopsy;
      if (a === null) return "Autopsy: none open";
      return a.score !== null ? `Autopsy: ${a.tableName}, health score ${a.score}` : `Autopsy: ${a.tableName}, examining`;
    }
    case "ask":
      if (input.ask.loading) return "Ask the Lab: thinking";
      return input.ask.answered ? "Ask the Lab: answered" : "Ask the Lab: ask anything about your tables";
  }
}

/** The jars for the page right now. */
export function buildSectionJars(input: ShelfInput): SectionJar[] {
  return visibleSections(input).map((id) => {
    const progress = sectionProgress(id, input);
    return {
      id,
      label: SECTION_LABEL[id],
      ariaLabel: `Go to ${SECTION_NAME[id]}`,
      progress,
      fill: PROGRESS_FILL[progress],
      status: sectionStatus(id, input),
    };
  });
}

/**
 * Which section is "current" from the ones crossing the middle of the window. A
 * section that contains another crossing one yields to it (the result, inside
 * the stitching table), and ties go to the earlier one on the page.
 */
export function pickActiveSection(
  crossing: readonly SectionId[],
  domOrder: readonly SectionId[] = SECTION_ORDER
): SectionId | null {
  const set = new Set(crossing);
  const parents = new Set<SectionId>();
  for (const id of set) {
    const parent = SECTION_PARENT[id];
    if (parent !== undefined) parents.add(parent);
  }
  const candidates = [...set].filter((id) => !parents.has(id));
  if (candidates.length === 0) return null;
  const rank = (id: SectionId) => {
    const i = domOrder.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return candidates.sort((a, b) => rank(a) - rank(b))[0];
}

/** How long to wait before the next idle crackle, from a number in [0, 1). */
export function nextCrackleDelayMs(roll: number): number {
  const r = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  return Math.round(CRACKLE_MIN_GAP_MS + r * (CRACKLE_MAX_GAP_MS - CRACKLE_MIN_GAP_MS));
}

/** How long the static arcs on the coil's ball last before they are redrawn. */
export function nextStaticArcDelayMs(roll: number): number {
  const r = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  return Math.round(STATIC_ARC_MIN_MS + r * (STATIC_ARC_MAX_MS - STATIC_ARC_MIN_MS));
}

/**
 * 2 to 3 tiny jagged arcs leaving the coil's ball, relative to the ball's
 * centre, each ending within STATIC_ARC_RADIUS_PX of it. Deterministic per seed.
 */
export function generateStaticArcs(seed: number, ballRadius = 7): Point[][] {
  const rand = mulberry32(seed);
  const count = 2 + Math.floor(rand() * 2);
  const arcs: Point[][] = [];
  for (let i = 0; i < count; i += 1) {
    // Spread the arcs around the ball, mostly upward and sideways.
    const angle = -Math.PI * (0.1 + 0.8 * ((i + rand() * 0.8) / count));
    const segments = 3 + Math.floor(rand() * 2);
    const reach = 18 + rand() * (STATIC_ARC_RADIUS_PX - 18 - 2);
    const points: Point[] = [];
    for (let k = 0; k <= segments; k += 1) {
      const t = k / segments;
      const dist = ballRadius + (reach - ballRadius) * t;
      const wobble = k === 0 || k === segments ? 0 : (k % 2 === 0 ? 1 : -1) * (2 + rand() * 3);
      const a = angle + wobble / Math.max(8, dist);
      points.push({
        x: Math.round(Math.cos(a) * dist * 10) / 10,
        y: Math.round(Math.sin(a) * dist * 10) / 10,
      });
    }
    arcs.push(points);
  }
  return arcs;
}
