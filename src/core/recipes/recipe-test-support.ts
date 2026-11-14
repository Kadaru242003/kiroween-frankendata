/** Test support for the recipe tests: small fixtures. Imported only by tests. */
import type {
  CleaningProposal,
  MatchProposal,
  ProposalSet,
  StitchPlan,
} from "../stitching/types";
import type { LoadedTable } from "../types";
import { matchIdFor } from "./recipe-ids";
import { RECIPE_FORMAT, RECIPE_VERSION } from "./types";
import type { Recipe } from "./types";

export function table(
  tableName: string,
  schema: LoadedTable["schema"],
  rowCount = 10,
  loadId = 1
): LoadedTable {
  return { loadId, tableName, sourceFileName: `${tableName}.csv`, schema, rowCount };
}

export const MONSTERS = table("monsters", [
  { name: "Monster_Name", type: "string" },
  { name: "Species", type: "string" },
  { name: "Threat_Level", type: "string" },
]);
export const EXPERIMENTS = table(
  "experiments",
  [
    { name: "monster_name", type: "string" },
    { name: "species", type: "string" },
    { name: "danger_level", type: "string" },
  ],
  8,
  2
);

export function match(
  lt: string,
  lc: string,
  rt: string,
  rc: string,
  confidence = 0.9
): MatchProposal {
  const left = { tableName: lt, columnName: lc, type: "string" as const };
  const right = { tableName: rt, columnName: rc, type: "string" as const };
  return {
    id: matchIdFor({ table: lt, column: lc }, { table: rt, column: rc }),
    left,
    right,
    confidence,
    reason: "test",
    source: "rules",
    components: { nameSim: 1, typeCompat: 1, valueOverlap: 1 },
  };
}

export function cleaning(
  kind: CleaningProposal["kind"],
  tableName: string,
  columnName?: string,
  extra: Partial<CleaningProposal> = {}
): CleaningProposal {
  const sub =
    kind === "duplicate-rows"
      ? "duplicate-rows"
      : kind === "category-standardize"
        ? "category"
        : kind === "outliers"
          ? "outliers"
          : extra.variantMap
            ? "case"
            : "whitespace";
  return {
    id:
      kind === "duplicate-rows"
        ? `clean:duplicate-rows:${tableName}`
        : `clean:${sub}:${tableName}.${columnName}`,
    target: { tableName, columnName },
    kind,
    before: "a",
    after: "b",
    reason: "test",
    ...extra,
  };
}

export const NAME_MATCH = match(
  "monsters",
  "Monster_Name",
  "experiments",
  "monster_name",
  0.95
);
export const SPECIES_CATEGORY = cleaning(
  "category-standardize",
  "monsters",
  "Species",
  { canonical: "Swamp Wraith", variantMap: { "swamp wraith": "Swamp Wraith" } }
);
export const MONSTER_DUPES = cleaning("duplicate-rows", "monsters");

export function proposalSet(): ProposalSet {
  return {
    matches: [NAME_MATCH],
    cleanings: [SPECIES_CATEGORY, MONSTER_DUPES],
    aiUsed: false,
  };
}

export function planOf(): StitchPlan {
  return {
    anchorTableName: "monsters",
    joinKeysByPair: { "experiments|monsters": NAME_MATCH.id },
    approvedMatches: [NAME_MATCH],
    approvedCleanings: [SPECIES_CATEGORY, MONSTER_DUPES],
  };
}

export function validRecipe(): Recipe {
  return {
    format: RECIPE_FORMAT,
    version: RECIPE_VERSION,
    createdAt: "2026-11-11T10:00:00.000Z",
    tables: [
      {
        name: "monsters",
        columns: [
          { name: "Monster_Name", type: "string" },
          { name: "Species", type: "string" },
          { name: "Threat_Level", type: "string" },
        ],
      },
      {
        name: "experiments",
        columns: [
          { name: "monster_name", type: "string" },
          { name: "species", type: "string" },
          { name: "danger_level", type: "string" },
        ],
      },
    ],
    matches: [
      {
        left: { table: "monsters", column: "Monster_Name" },
        right: { table: "experiments", column: "monster_name" },
        confidence: 0.95,
        edited: false,
      },
    ],
    cleanings: [
      { rule: "category", table: "monsters", column: "Species", canonical: "Swamp Wraith", edited: false },
      { rule: "duplicate-rows", table: "monsters" },
    ],
    join: {
      anchor: "monsters",
      keys: [
        {
          left: { table: "monsters", column: "Monster_Name" },
          right: { table: "experiments", column: "monster_name" },
        },
      ],
    },
  };
}
