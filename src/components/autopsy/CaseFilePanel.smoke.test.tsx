/**
 * Smoke tests for the Autopsy CaseFilePanel (Feature 4, task 7).
 *
 * The engine is faked (no DuckDB): the panel is a view over a runner that
 * reports progress and then a final report. Covers progressive rendering, the
 * too-large and error states, the exports, and the Fix it button.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseFilePanel, verdictFor } from "./CaseFilePanel";
import { assembleReport, buildColumnFinding } from "../../core/autopsy/autopsy-engine";
import type { AutopsyReport, AutopsyTarget, FixAction } from "../../core/autopsy/types";
import type { DuckDBService } from "../../core/types";

const target: AutopsyTarget = {
  tableName: "monsters",
  schema: [{ name: "Species", type: "string" }],
  rowCount: 14,
};

const db = {} as DuckDBService;

const wsFix: FixAction = {
  proposalId: "clean:whitespace:monsters.Species",
  kind: "whitespace-case",
  columnName: "Species",
  label: "Trim and collapse whitespace in Species",
  proposal: {
    id: "clean:whitespace:monsters.Species",
    target: { tableName: "monsters", columnName: "Species" },
    kind: "whitespace-case",
    before: "a  b",
    after: "a b",
    reason: "x",
  },
};
const dupFix: FixAction = {
  proposalId: "clean:duplicate-rows:monsters",
  kind: "duplicate-rows",
  label: "Remove duplicate rows",
  proposal: {
    id: "clean:duplicate-rows:monsters",
    target: { tableName: "monsters" },
    kind: "duplicate-rows",
    before: { rowCount: 14 },
    after: { rowCount: 12 },
    reason: "x",
  },
};

function report(complete: boolean, fixes: FixAction[] = [wsFix, dupFix]): AutopsyReport {
  return assembleReport({
    target,
    rows: 14,
    columns: [
      buildColumnFinding({ name: "Species", type: "string" }, 14, { nonNull: 14, distinct: 6 }, {
        topValues: [{ value: "Swamp Wraith", count: 4 }],
        whitespaceRows: 1,
        caseVariantGroups: 2,
      }),
    ],
    duplicateRows: 2,
    fixes,
    complete,
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("CaseFilePanel", () => {
  it("renders partial results, then the complete report", async () => {
    const d = deferred<AutopsyReport>();
    const runner = vi.fn(async (_db, _t, opts) => {
      opts?.onProgress?.(report(false));
      return d.promise;
    });
    render(
      <CaseFilePanel db={db} target={target} fixable onClose={() => {}} onFixIt={() => {}} runner={runner} />
    );

    await waitFor(() => expect(screen.getByText("Analyzing columns...")).toBeInTheDocument());
    // Partial: the column is already visible, exports are not yet enabled.
    expect(screen.getByText("Species")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download Markdown" })).toBeDisabled();

    await act(async () => d.resolve(report(true)));
    expect(screen.getByText("Autopsy complete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download Markdown" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download JSON" })).toBeEnabled();
  });

  it("shows the health score stamp, breakdown, and status text", async () => {
    const runner = vi.fn(async () => report(true));
    render(
      <CaseFilePanel db={db} target={target} fixable onClose={() => {}} onFixIt={() => {}} runner={runner} />
    );
    await waitFor(() => expect(screen.getByLabelText(/Health score \d+ out of 100/)).toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Score breakdown" })).toBeInTheDocument();
    // Status is conveyed by text, not color alone.
    expect(screen.getByText("WARNING")).toBeInTheDocument();
  });

  it("shows the too-large message and no findings", async () => {
    const tooLarge: AutopsyReport = {
      ...report(true),
      status: "too-large",
      message: "This table has 2,000,000 rows. The Autopsy analyzes tables of up to 1,000,000 rows.",
      columns: [],
    };
    const runner = vi.fn(async () => tooLarge);
    render(
      <CaseFilePanel db={db} target={target} fixable onClose={() => {}} onFixIt={() => {}} runner={runner} />
    );
    await waitFor(() => expect(screen.getByText(/up to 1,000,000 rows/)).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Column findings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows an error with a working Retry", async () => {
    const failed: AutopsyReport = { ...report(true), status: "error", message: "The lab could not read this table's statistics.", columns: [] };
    const runner = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(report(true));
    render(
      <CaseFilePanel db={db} target={target} fixable onClose={() => {}} onFixIt={() => {}} runner={runner} />
    );
    await waitFor(() => expect(screen.getByText(/could not read/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Autopsy complete")).toBeInTheDocument());
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("downloads Markdown and JSON with the same findings", async () => {
    const download = vi.fn();
    const runner = vi.fn(async () => report(true));
    render(
      <CaseFilePanel db={db} target={target} fixable onClose={() => {}} onFixIt={() => {}} runner={runner} download={download} />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Download JSON" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Download Markdown" }));
    fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
    expect(download).toHaveBeenCalledTimes(2);
    const [mdName, mdMime, mdText] = download.mock.calls[0];
    expect(mdName).toBe("autopsy-monsters.md");
    expect(mdMime).toBe("text/markdown");
    expect(mdText).toContain("# Autopsy case file: monsters");
    const [jsonName, , jsonText] = download.mock.calls[1];
    expect(jsonName).toBe("autopsy-monsters.json");
    expect(JSON.parse(jsonText).tableName).toBe("monsters");
  });

  it("calls onFixIt with the table and existing proposal id for a column and for duplicates", async () => {
    const onFixIt = vi.fn();
    const runner = vi.fn(async () => report(true));
    render(
      <CaseFilePanel db={db} target={target} fixable onClose={() => {}} onFixIt={onFixIt} runner={runner} />
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Fix it: Remove duplicate rows" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "Fix it: Remove duplicate rows" }));
    expect(onFixIt).toHaveBeenLastCalledWith("monsters", "clean:duplicate-rows:monsters");
    fireEvent.click(screen.getByRole("button", { name: "Fix it: Trim and collapse whitespace in Species" }));
    expect(onFixIt).toHaveBeenLastCalledWith("monsters", "clean:whitespace:monsters.Species");
  });

  it("offers no Fix it and explains why for a stitched result", async () => {
    const runner = vi.fn(
      async (_db: DuckDBService, _t: AutopsyTarget, _o?: { allowFixes?: boolean }) =>
        report(true)
    );
    render(
      <CaseFilePanel
        db={db}
        target={{ ...target, tableName: "stitch_1_result" }}
        fixable={false}
        onClose={() => {}}
        onFixIt={() => {}}
        runner={runner}
      />
    );
    await waitFor(() => expect(screen.getByText(/shown read-only/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Fix it/ })).toBeNull();
    // The runner was told not to compute fixes.
    expect(runner.mock.calls[0][2]).toMatchObject({ allowFixes: false });
  });

  it("closes and renders hostile names as plain text", async () => {
    const onClose = vi.fn();
    const hostile = "<img src=x onerror=alert(1)>";
    const runner = vi.fn(async () => report(true));
    const { container } = render(
      <CaseFilePanel db={db} target={{ ...target, tableName: hostile }} fixable onClose={onClose} onFixIt={() => {}} runner={runner} />
    );
    await waitFor(() => expect(screen.getByText("Autopsy complete")).toBeInTheDocument());
    expect(container.querySelector("img")).toBeNull();
    expect(within(container).getByRole("heading", { level: 2 }).textContent).toBe(hostile);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("verdictFor", () => {
  it("maps score bands to verdict words", () => {
    expect(verdictFor(100)).toBe("Clean bill of health");
    expect(verdictFor(89)).toBe("Minor ailments");
    expect(verdictFor(69)).toBe("Serious condition");
    expect(verdictFor(39)).toBe("Critical condition");
  });
});

describe("Fix it feedback", () => {
  it("turns the button into a disabled Added state, announces it, and calls the handler once", async () => {
    const onFixIt = vi.fn();
    const runner = vi.fn(async () => report(true));
    render(
      <CaseFilePanel db={db} target={target} fixable onClose={() => {}} onFixIt={onFixIt} runner={runner} />
    );
    const btn = await screen.findByRole("button", { name: "Fix it: Remove duplicate rows" });
    fireEvent.click(btn);
    const added = screen.getByRole("button", { name: "Added: Remove duplicate rows" });
    expect(added).toBeDisabled();
    expect(added.textContent).toContain("\u2713");
    fireEvent.click(added);
    expect(onFixIt).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("fixit-live").textContent).toBe("Added to the stitching table");
  });
});
