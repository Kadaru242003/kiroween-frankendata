/**
 * Client request payload budgeting for the AI refinement call (Feature 2, task
 * 19; design: "Client request payload budgeting").
 *
 * Before the client ever POSTs to the proxy it bounds the request
 * deterministically so it stays small and under {@link AI_PROXY_MAX_PAYLOAD_BYTES}.
 * The AI may only *refine existing, already-visible matches* (Req 11.5), so the
 * budget starts from the rules-engine {@link MatchProposal}s and the per-column
 * {@link TableSample}s and produces an {@link AiRequest} (or a decision to skip
 * the call). Budgeting rules, in order:
 *
 *   1. Candidate eligibility — only matches with
 *      `confidence >= MATCH_DISPLAY_THRESHOLD` (0.5) become candidates. A match
 *      below the display threshold is never sent, so the AI can never resurrect
 *      a hidden match (Req 11.5).
 *   2. Candidate cap — keep at most {@link MAX_CANDIDATES} (30), dropping the
 *      LOWEST `ruleConfidence` first (highest-confidence matches are the ones
 *      most worth refining).
 *   3. Column cap — include only the columns referenced by the surviving
 *      candidates, at most {@link MAX_COLUMNS} (40). If more columns are
 *      referenced than the cap, candidates are dropped (again lowest-confidence
 *      first) until the referenced-column set fits.
 *   4. Sample cap — at most {@link MAX_SAMPLES_PER_COLUMN} (5) values per column,
 *      each truncated to {@link MAX_SAMPLE_CHARS} (40) characters, taken from the
 *      frequency-ordered samples (most common first) and excluding nulls.
 *   5. Byte cap — serialize and measure. If the body STILL exceeds
 *      {@link AI_PROXY_MAX_PAYLOAD_BYTES}, the client skips the call entirely and
 *      uses the rules result (no error; `aiUsed = false`). A huge schema never
 *      produces a user-facing error — it mirrors the normal fallback path.
 *
 * Also exposes {@link isAiEnabled}, the `VITE_AI_ENABLED` build-time kill
 * switch: when it is not the string `"true"`, the controller runs rules-only
 * and never constructs/calls the provider (no network attempt at all).
 *
 * All functions here are pure (no network, no DOM) and deterministic, so they
 * are fully unit-testable.
 */

import type { MatchProposal, SampleValue, TableSample } from "./types";
import {
  AI_PROXY_MAX_PAYLOAD_BYTES,
  MATCH_DISPLAY_THRESHOLD,
  type AiCandidateMatch,
  type AiRequest,
  type AiSampleColumn,
} from "./types";

// ── Payload budget caps (design: "Client request payload budgeting") ─────────
/** Max distinct sample values sent per column. */
export const MAX_SAMPLES_PER_COLUMN = 5;
/** Max characters per sample value (longer values are truncated). */
export const MAX_SAMPLE_CHARS = 40;
/** Max columns included in the request. */
export const MAX_COLUMNS = 40;
/** Max candidate matches included in the request. */
export const MAX_CANDIDATES = 30;

/**
 * Read the `VITE_AI_ENABLED` build-time flag (design: "Dev-mode behavior and
 * feature flag"). AI is enabled ONLY when the flag is exactly the string
 * `"true"`; unset, `false`, or anything else means rules-only (no provider
 * constructed, no network attempt). The flag value is injected for testability;
 * production passes `import.meta.env.VITE_AI_ENABLED`.
 */
export function isAiEnabled(flag: unknown): boolean {
  return flag === "true";
}

/** A stable `"tableName.columnName"` key for the referenced-columns set. */
function columnKey(tableName: string, columnName: string): string {
  return `${tableName}.${columnName}`;
}

/** Look up a column's {@link ColumnSchema}-level type from the table samples. */
function findColumnType(
  samplesByTable: Map<string, TableSample>,
  tableName: string,
  columnName: string
): TableSample["schema"][number]["type"] | undefined {
  const table = samplesByTable.get(tableName);
  if (!table) {
    return undefined;
  }
  const col = table.schema.find((c) => c.name === columnName);
  return col?.type;
}

/**
 * Build the bounded sample list for one column: the top
 * {@link MAX_SAMPLES_PER_COLUMN} non-null values (already frequency-ordered by
 * the SampleReader), each truncated to {@link MAX_SAMPLE_CHARS} characters.
 */
function boundedSamples(values: SampleValue[] | undefined): string[] {
  const out: string[] = [];
  for (const sample of values ?? []) {
    if (out.length >= MAX_SAMPLES_PER_COLUMN) {
      break;
    }
    if (sample.value === null) {
      continue;
    }
    out.push(sample.value.slice(0, MAX_SAMPLE_CHARS));
  }
  return out;
}

/** The outcome of budgeting: either send this request, or skip the AI call. */
export type BudgetResult =
  | { skip: true; reason: "no-candidates" | "over-byte-budget" }
  | { skip: false; request: AiRequest };

/**
 * Deterministically budget an {@link AiRequest} from the rules-engine matches
 * and per-column samples (design: "Client request payload budgeting"). Returns
 * either the request to send or a decision to skip the call (which the
 * controller treats exactly like any other fallback: `aiUsed = false`, no
 * error).
 */
export function budgetAiRequest(
  matches: readonly MatchProposal[],
  tables: readonly TableSample[]
): BudgetResult {
  const samplesByTable = new Map<string, TableSample>();
  for (const t of tables) {
    samplesByTable.set(t.tableName, t);
  }

  // 1 + 2. Eligible candidates, highest ruleConfidence first, capped to
  // MAX_CANDIDATES (so the drops are the lowest-confidence ones).
  const eligible = matches
    .filter((m) => m.confidence >= MATCH_DISPLAY_THRESHOLD)
    .slice()
    .sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      // Stable tie-break by id so budgeting is deterministic.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  let kept = eligible.slice(0, MAX_CANDIDATES);

  // 3. Column cap. The referenced-column set must fit within MAX_COLUMNS; if it
  // does not, drop the lowest-confidence candidate (last in the sorted list)
  // and retry until the referenced columns fit (or no candidates remain).
  const referencedColumns = (
    candidates: readonly MatchProposal[]
  ): Set<string> => {
    const set = new Set<string>();
    for (const m of candidates) {
      set.add(columnKey(m.left.tableName, m.left.columnName));
      set.add(columnKey(m.right.tableName, m.right.columnName));
    }
    return set;
  };

  while (kept.length > 0 && referencedColumns(kept).size > MAX_COLUMNS) {
    kept = kept.slice(0, kept.length - 1);
  }

  if (kept.length === 0) {
    return { skip: true, reason: "no-candidates" };
  }

  // Build the candidate list in the AiRequest shape.
  const candidates: AiCandidateMatch[] = kept.map((m) => ({
    id: m.id,
    left: { tableName: m.left.tableName, columnName: m.left.columnName },
    right: { tableName: m.right.tableName, columnName: m.right.columnName },
    ruleConfidence: m.confidence,
  }));

  // 4. Columns: only those referenced by the kept candidates, with bounded
  // samples. Order is deterministic (sorted by the referenced-column key).
  const columnKeys = Array.from(referencedColumns(kept)).sort();
  const columns: AiSampleColumn[] = [];
  for (const key of columnKeys) {
    const sepIndex = key.indexOf(".");
    const tableName = key.slice(0, sepIndex);
    const columnName = key.slice(sepIndex + 1);
    const type = findColumnType(samplesByTable, tableName, columnName);
    if (type === undefined) {
      // A referenced column with no sample metadata is skipped; the candidate
      // still goes (validation on return is name-based).
      continue;
    }
    const table = samplesByTable.get(tableName);
    columns.push({
      tableName,
      columnName,
      type,
      samples: boundedSamples(table?.samplesByColumn[columnName]),
    });
  }

  const request: AiRequest = { columns, candidates };

  // 5. Byte cap. Measure the serialized body; if it is still over budget, skip
  // the call entirely (mirrors the normal fallback path, no user-facing error).
  const byteLength = serializedByteLength(request);
  if (byteLength > AI_PROXY_MAX_PAYLOAD_BYTES) {
    return { skip: true, reason: "over-byte-budget" };
  }

  return { skip: false, request };
}

/** Byte length of the JSON-serialized request (UTF-8), used for the byte cap. */
export function serializedByteLength(request: AiRequest): number {
  const json = JSON.stringify(request);
  // TextEncoder gives the true UTF-8 byte count (multi-byte chars included).
  return new TextEncoder().encode(json).length;
}
