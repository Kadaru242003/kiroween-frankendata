/**
 * frankendata_apply_stitch (Requirement 6). Applies ONLY the proposal ids the
 * caller passes in, through the existing plan assembly and applier.
 */
import { z } from "zod";
import { assembleStitchPlan } from "../../../src/core/stitching/plan-assembly";
import { computeDatasetVersion } from "../../../src/core/stitching/stitch-controller";
import type { ApprovalDecision, StitchPlan } from "../../../src/core/stitching/types";
import { readTable } from "../../../src/core/recipes/table-exporter";
import { toolError } from "../errors";
import { limitRows, okResult, type ToolResult } from "../results";
import type { Session } from "../session";
import { selectedTables } from "../tables";

export const applyStitchShape = {
  approvedIds: z
    .array(z.string())
    .describe("Proposal ids (from frankendata_propose_stitch) to approve. Only these are applied."),
  anchor: z.string().optional().describe("Optional anchor table name."),
  joinKeys: z
    .record(z.string(), z.string())
    .optional()
    .describe('Optional map of table pair "a|b" (sorted) to an approved match id.'),
};

/** Apply a plan and describe the result (shared with apply_recipe). */
export async function applyPlanAndDescribe(
  session: Session,
  plan: StitchPlan
): Promise<Record<string, unknown>> {
  const controller = await session.stitchController();
  const stitched = await controller.applyPlan(plan);
  const db = await session.db();
  const data = await readTable(db, stitched);
  const state = session.stitchStore.getState();
  const limited = limitRows(
    data.rows.map((r) => Object.fromEntries(data.columns.map((c, i) => [c, r[i]])))
  );
  return {
    resultTable: stitched.tableName,
    rowCount: stitched.rowCount,
    schema: stitched.schema.map((c) => ({ name: c.name, type: c.type })),
    fanOut: state.fanOut,
    createdTables: state.pendingUndo?.createdTableNames ?? [],
    rows: limited.rows,
    truncated: limited.truncated,
  };
}

export async function applyStitch(
  session: Session,
  args: { approvedIds: string[]; anchor?: string; joinKeys?: Record<string, string> }
): Promise<ToolResult> {
  return session.run(async () => {
    const store = session.stitchStore;
    const proposals = store.getState().proposals;
    if (proposals === null) {
      throw toolError("no-proposals", "No proposals yet. Call frankendata_propose_stitch first.");
    }
    const tables = selectedTables(session);
    if (computeDatasetVersion(tables) !== store.getDatasetVersion()) {
      throw toolError(
        "proposals-stale",
        "The loaded tables changed since the proposals were computed. Call frankendata_propose_stitch again."
      );
    }
    const known = new Set([
      ...proposals.matches.map((m) => m.id),
      ...proposals.cleanings.map((c) => c.id),
    ]);
    const unknown = args.approvedIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw toolError(
        "unknown-proposal",
        `Unknown proposal id(s): ${unknown.slice(0, 5).map((u) => u.slice(0, 80)).join(", ")}.`
      );
    }
    if (args.anchor !== undefined && !tables.some((t) => t.tableName === args.anchor)) {
      throw toolError("table-not-found", `The anchor "${args.anchor.slice(0, 80)}" is not a loaded table.`);
    }
    const decisions: Record<string, ApprovalDecision> = {};
    for (const id of new Set(args.approvedIds)) {
      decisions[id] = { proposalId: id, decision: "approved" };
    }
    const approvedMatchIds = new Set(
      proposals.matches.filter((m) => decisions[m.id]).map((m) => m.id)
    );
    for (const [pair, matchId] of Object.entries(args.joinKeys ?? {})) {
      if (!approvedMatchIds.has(matchId)) {
        throw toolError(
          "unknown-proposal",
          `Join key for "${pair.slice(0, 80)}" must name an approved match id.`
        );
      }
    }
    const plan = assembleStitchPlan(proposals, decisions, tables, {
      anchorTableName: args.anchor,
      joinKeysByPair: args.joinKeys,
    });
    return okResult(await applyPlanAndDescribe(session, plan));
  });
}
