/**
 * Recipe mapper (Feature 5, Requirement 4): maps a validated Recipe onto the
 * currently loaded tables and the current ProposalSet, producing pre-approved
 * decisions of the EXISTING decision type, plus a NotAppliedList.
 *
 * Pure: no DuckDB, no store access, no network. Every recipe match, cleaning,
 * anchor, and join key ends up either mapped (a decision or an override) or in
 * the NotAppliedList with exactly one reason (Requirement 4.8).
 */
import { pairKey, assembleStitchPlan } from "../stitching/plan-assembly";
import type { LoadedTableLike } from "../stitching/plan-assembly";
import type {
  ApprovalDecision,
  CleaningProposal,
  ColumnRef,
  MatchProposal,
  ProposalSet,
  StitchPlan,
} from "../stitching/types";
import type { ColumnSchema, ColumnType } from "../types";
import { cleaningIdFor, matchIdFor } from "./recipe-ids";
import type {
  NotAppliedCode,
  NotAppliedItem,
  Recipe,
  RecipeColumnRef,
  RecipeMapping,
  RecipeOverrides,
} from "./types";

/** The minimal loaded-table shape the mapper needs. */
export interface MapperTable {
  tableName: string;
  schema: readonly ColumnSchema[];
}

export interface TableMapping {
  /** Recipe table name to loaded table name. */
  tableMap: Record<string, string>;
  /** Recipe table name to the reason it could not be mapped. */
  unmapped: Record<string, { code: NotAppliedCode; reason: string }>;
}

function schemaSignature(schema: readonly ColumnSchema[]): string {
  return JSON.stringify(
    schema.map((c) => [c.name, c.type] as [string, string]).sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
    )
  );
}

/**
 * Step 1 (requirement 4.2): map each recipe table by name, then the leftovers
 * by identical column schema when exactly one loaded table fits.
 */
export function mapRecipeTables(
  recipe: Recipe,
  loaded: readonly MapperTable[]
): TableMapping {
  const tableMap: Record<string, string> = Object.create(null) as Record<string, string>;
  const unmapped: TableMapping["unmapped"] = Object.create(null) as TableMapping["unmapped"];
  const loadedNames = new Set(loaded.map((t) => t.tableName));
  const taken = new Set<string>();

  for (const t of recipe.tables) {
    if (loadedNames.has(t.name)) {
      tableMap[t.name] = t.name;
      taken.add(t.name);
    }
  }
  for (const t of recipe.tables) {
    if (t.name in tableMap) continue;
    const sig = schemaSignature(t.columns);
    const candidates = loaded.filter(
      (l) => !taken.has(l.tableName) && schemaSignature(l.schema) === sig
    );
    if (candidates.length === 1) {
      tableMap[t.name] = candidates[0].tableName;
      taken.add(candidates[0].tableName);
    } else if (candidates.length > 1) {
      unmapped[t.name] = {
        code: "table-ambiguous",
        reason: `Several loaded tables look like "${t.name}", so none was chosen.`,
      };
    } else {
      unmapped[t.name] = {
        code: "table-not-found",
        reason: `No loaded table matches "${t.name}" by name or by columns.`,
      };
    }
  }
  return { tableMap, unmapped };
}

type Resolved =
  | { ok: true; ref: ColumnRef }
  | { ok: false; code: NotAppliedCode; reason: string };

function describeRef(r: RecipeColumnRef): string {
  return `${r.table}.${r.column}`;
}

function unorderedKey(a: ColumnRef, b: ColumnRef): string {
  const ka = JSON.stringify([a.tableName, a.columnName]);
  const kb = JSON.stringify([b.tableName, b.columnName]);
  return ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function sameCol(a: ColumnRef, b: ColumnRef): boolean {
  return a.tableName === b.tableName && a.columnName === b.columnName;
}

/**
 * Step 2: map the recipe's matches, cleanings, anchor, and keys onto the
 * current proposals.
 */
export function mapRecipeItems(
  recipe: Recipe,
  loaded: readonly MapperTable[],
  tableMapping: TableMapping,
  proposals: ProposalSet
): RecipeMapping {
  const { tableMap, unmapped } = tableMapping;
  const loadedByName = new Map(loaded.map((t) => [t.tableName, t]));
  const recipeColType = new Map<string, ColumnType>();
  for (const t of recipe.tables) {
    for (const c of t.columns) recipeColType.set(JSON.stringify([t.name, c.name]), c.type);
  }

  const resolveCol = (ref: RecipeColumnRef): Resolved => {
    const bad = unmapped[ref.table];
    if (bad) return { ok: false, code: bad.code, reason: bad.reason };
    const loadedName = tableMap[ref.table];
    const table = loadedName === undefined ? undefined : loadedByName.get(loadedName);
    if (!table) {
      return { ok: false, code: "table-not-found", reason: `Table "${ref.table}" is not loaded.` };
    }
    const col = table.schema.find((c) => c.name === ref.column);
    if (!col) {
      return {
        ok: false,
        code: "column-missing",
        reason: `Column "${ref.column}" is not in table "${table.tableName}".`,
      };
    }
    const was = recipeColType.get(JSON.stringify([ref.table, ref.column]));
    if (was !== undefined && was !== col.type) {
      return {
        ok: false,
        code: "type-changed",
        reason: `Column "${ref.column}" was ${was} in the recipe and is ${col.type} now.`,
      };
    }
    return {
      ok: true,
      ref: { tableName: table.tableName, columnName: col.name, type: col.type },
    };
  };

  const decisions: ApprovalDecision[] = [];
  const notApplied: NotAppliedItem[] = [];
  const addedMatches: MatchProposal[] = [];
  const currentMatches = proposals.matches;
  const matchIds = new Set(currentMatches.map((m) => m.id));
  // Unordered mapped pair to the proposal id that stands for it (for join keys).
  const proposalForPair = new Map<string, string>();
  let mappedCount = 0;

  // Matches (4.4)
  for (const m of recipe.matches) {
    const description = `Match ${describeRef(m.left)} with ${describeRef(m.right)}`;
    const L = resolveCol(m.left);
    const R = resolveCol(m.right);
    const fail = !L.ok ? L : !R.ok ? R : null;
    if (fail && !fail.ok) {
      notApplied.push({ kind: "match", description, code: fail.code, reason: fail.reason });
      continue;
    }
    if (!L.ok || !R.ok) continue;
    const lref = L.ref;
    const rref = R.ref;
    const id = matchIdFor(
      { table: lref.tableName, column: lref.columnName },
      { table: rref.tableName, column: rref.columnName }
    );
    const pairId = unorderedKey(lref, rref);

    if (m.edited && !matchIds.has(id)) {
      // Re-paired by the user: find the proposal sharing exactly one endpoint.
      const base = currentMatches.find((p) => {
        const sharesA =
          (sameCol(p.left, lref) && p.right.tableName === rref.tableName) ||
          (sameCol(p.right, lref) && p.left.tableName === rref.tableName);
        const sharesB =
          (sameCol(p.left, rref) && p.right.tableName === lref.tableName) ||
          (sameCol(p.right, rref) && p.left.tableName === lref.tableName);
        return sharesA || sharesB;
      });
      if (base) {
        const editedId = `${lref.tableName}.${lref.columnName}~${rref.tableName}.${rref.columnName}`;
        decisions.push({
          proposalId: base.id,
          decision: "edited",
          edit: { left: lref, right: rref, id: editedId },
        });
        proposalForPair.set(pairId, editedId);
        mappedCount += 1;
        continue;
      }
    }

    if (!matchIds.has(id)) {
      addedMatches.push({
        id,
        left: lref,
        right: rref,
        confidence: m.confidence,
        reason: "From recipe",
        source: "rules",
        components: { nameSim: 0, typeCompat: 0, valueOverlap: 0 },
      });
      matchIds.add(id);
    }
    decisions.push({ proposalId: id, decision: "approved" });
    proposalForPair.set(pairId, id);
    mappedCount += 1;
  }

  // Cleanings (4.5)
  for (const c of recipe.cleanings) {
    const where = c.column ? `${c.table}.${c.column}` : c.table;
    const description = `Cleanup "${c.rule}" on ${where}`;
    let mappedTable: string;
    let mappedColumn: string | undefined;
    if (c.rule === "duplicate-rows") {
      const bad = unmapped[c.table];
      const name = tableMap[c.table];
      if (bad || name === undefined) {
        notApplied.push({
          kind: "cleaning",
          description,
          code: bad?.code ?? "table-not-found",
          reason: bad?.reason ?? `Table "${c.table}" is not loaded.`,
        });
        continue;
      }
      mappedTable = name;
    } else {
      const r = resolveCol({ table: c.table, column: c.column ?? "" });
      if (!r.ok) {
        notApplied.push({ kind: "cleaning", description, code: r.code, reason: r.reason });
        continue;
      }
      mappedTable = r.ref.tableName;
      mappedColumn = r.ref.columnName;
    }
    const id = cleaningIdFor(c.rule, mappedTable, mappedColumn);
    const current = proposals.cleanings.find((p) => p.id === id);
    if (!current) {
      notApplied.push({
        kind: "cleaning",
        description,
        code: "no-longer-detected",
        reason: "Nothing to clean here in the current data.",
      });
      continue;
    }
    if (
      c.rule === "category" &&
      c.edited === true &&
      c.canonical !== undefined &&
      c.canonical !== current.canonical
    ) {
      const edit: Partial<CleaningProposal> = { canonical: c.canonical };
      decisions.push({ proposalId: id, decision: "edited", edit });
    } else {
      decisions.push({ proposalId: id, decision: "approved" });
    }
    mappedCount += 1;
  }

  // Join anchor and keys (4.6)
  const overrides: RecipeOverrides = { joinKeysByPair: {} };
  if (recipe.join.anchor !== "") {
    const bad = unmapped[recipe.join.anchor];
    const name = tableMap[recipe.join.anchor];
    if (bad || name === undefined) {
      notApplied.push({
        kind: "anchor",
        description: `Anchor table "${recipe.join.anchor}"`,
        code: "anchor-unmapped",
        reason: bad?.reason ?? `Table "${recipe.join.anchor}" is not loaded.`,
      });
    } else {
      overrides.anchor = name;
    }
  }
  for (const k of recipe.join.keys) {
    const description = `Join key ${describeRef(k.left)} with ${describeRef(k.right)}`;
    const L = resolveCol(k.left);
    const R = resolveCol(k.right);
    if (!L.ok || !R.ok) {
      const f = !L.ok ? L : (R as Extract<Resolved, { ok: false }>);
      notApplied.push({
        kind: "key",
        description,
        code: "key-unmapped",
        reason: f.reason,
      });
      continue;
    }
    const proposalId = proposalForPair.get(unorderedKey(L.ref, R.ref));
    if (proposalId === undefined) {
      notApplied.push({
        kind: "key",
        description,
        code: "key-unmapped",
        reason: "The match used as this key was not applied.",
      });
      continue;
    }
    overrides.joinKeysByPair[pairKey(L.ref.tableName, R.ref.tableName)] = proposalId;
  }

  const augmented: ProposalSet = {
    matches: [...currentMatches, ...addedMatches].sort((a, b) =>
      b.confidence !== a.confidence ? b.confidence - a.confidence : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    ),
    cleanings: proposals.cleanings,
    aiUsed: proposals.aiUsed,
  };
  return {
    proposals: augmented,
    decisions,
    overrides,
    notApplied,
    mappedCount,
    tableMap: { ...tableMap },
  };
}

/** Compose both mapping steps. */
export function mapRecipe(
  recipe: Recipe,
  loaded: readonly MapperTable[],
  proposals: ProposalSet
): RecipeMapping {
  return mapRecipeItems(recipe, loaded, mapRecipeTables(recipe, loaded), proposals);
}

/**
 * Apply the recipe's anchor and join keys to a plan the user has just confirmed
 * (UI path). The anchor is only used when it is one of `tableNames` (when
 * given); a key only when its match is in the plan.
 */
export function applyRecipeOverrides(
  plan: StitchPlan,
  overrides: RecipeOverrides,
  tableNames?: readonly string[]
): StitchPlan {
  const planMatchIds = new Set(plan.approvedMatches.map((m) => m.id));
  const joinKeysByPair = { ...plan.joinKeysByPair };
  for (const [pair, id] of Object.entries(overrides.joinKeysByPair)) {
    if (planMatchIds.has(id)) joinKeysByPair[pair] = id;
  }
  const anchorOk =
    overrides.anchor !== undefined &&
    (tableNames === undefined || tableNames.includes(overrides.anchor));
  return {
    ...plan,
    anchorTableName: anchorOk ? (overrides.anchor as string) : plan.anchorTableName,
    joinKeysByPair,
  };
}

/** The plan the mapping stands for, assembled with the existing assembler. */
export function assemblePlanFromMapping(
  mapping: RecipeMapping,
  tables: readonly LoadedTableLike[]
): StitchPlan {
  const byId: Record<string, ApprovalDecision> = {};
  for (const d of mapping.decisions) byId[d.proposalId] = d;
  const base = assembleStitchPlan(mapping.proposals, byId, tables);
  return applyRecipeOverrides(
    base,
    mapping.overrides,
    tables.map((t) => t.tableName)
  );
}
