/**
 * Smoke tests for the Ask the Lab panel (Feature 3, task 6).
 *
 * These cover the two task-6 smoke checks at the component edge (the full App
 * cannot render under jsdom because the real DuckDB-WASM worker is unavailable):
 *
 *   1. With AI off, a free-form question makes NO provider/network call and the
 *      panel shows the "AI unavailable → use the starter questions" message
 *      (Req 6.4, 9.4).
 *   2. Clicking a starter chip runs its rule-built SQL through the controller
 *      and renders the SQL block + the result table with the "showing N of M"
 *      note and a working CSV download (Req 2.4, 1.6, 1.7).
 *
 * The AskController is faked so no DuckDB/network is touched; `runSql`/`ask`
 * return canned outcomes. (The real controller + real DuckDB chip execution are
 * exercised end to end by the golden/DuckDB tests in later tasks.)
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AskTheLabPanel,
  AI_UNAVAILABLE_MESSAGE,
  PRIVACY_NOTE,
  ASK_SUBMIT_LABEL,
} from "./AskTheLabPanel";
import { AskStore } from "../../state/ask-store";
import type { AskController } from "../../core/chat/ask-controller";
import type { StarterChip } from "../../core/chat/starter-questions";
import type { AskOutcome } from "../../core/chat/types";

function fakeController(overrides: Partial<AskController> = {}): AskController {
  return {
    ask: vi.fn(async () => ({ kind: "ai-unavailable" }) as AskOutcome),
    runSql: vi.fn(async () => ({ kind: "ai-unavailable" }) as AskOutcome),
    ...overrides,
  };
}

const chip: StarterChip = {
  tableName: "monsters",
  question: "How many rows are in monsters?",
  sql: "SELECT COUNT(*) AS row_count FROM monsters",
};

describe("AskTheLabPanel", () => {
  it("renders the privacy note and the input", () => {
    render(
      <AskTheLabPanel
        controller={fakeController()}
        store={new AskStore()}
        chips={[chip]}
        aiAvailable={false}
      />
    );
    expect(screen.getByText(PRIVACY_NOTE)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Question" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: chip.question })
    ).toBeInTheDocument();
  });

  it("shows the AI-unavailable message for a free-form question with AI off (no provider call shape)", async () => {
    const controller = fakeController({
      ask: vi.fn(async () => ({ kind: "ai-unavailable" }) as AskOutcome),
    });
    render(
      <AskTheLabPanel
        controller={controller}
        store={new AskStore()}
        chips={[chip]}
        aiAvailable={false}
      />
    );

    const input = screen.getByRole("textbox", { name: "Question" });
    fireEvent.change(input, { target: { value: "how many monsters" } });
    fireEvent.click(screen.getByRole("button", { name: ASK_SUBMIT_LABEL }));

    await waitFor(() =>
      expect(screen.getByText(AI_UNAVAILABLE_MESSAGE)).toBeInTheDocument()
    );
    // The controller's ask was invoked (it is the controller — not the panel —
    // that gates the network; with AI off it returns ai-unavailable with no
    // provider call).
    expect(controller.ask).toHaveBeenCalledWith("how many monsters");
  });

  it("runs a starter chip and renders the SQL block + result table", async () => {
    const okOutcome: AskOutcome = {
      kind: "ok",
      sql: chip.sql,
      explanation: chip.question,
      columns: ["row_count"],
      rows: [[12]],
      rowCount: 1,
      capped: false,
    };
    const controller = fakeController({
      runSql: vi.fn(async () => okOutcome),
    });
    render(
      <AskTheLabPanel
        controller={controller}
        store={new AskStore()}
        chips={[chip]}
        aiAvailable={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: chip.question }));

    await waitFor(() =>
      expect(screen.getByLabelText("Query result")).toBeInTheDocument()
    );
    // The chip's SQL was run directly (no LLM).
    expect(controller.runSql).toHaveBeenCalledWith(
      chip.sql,
      chip.question,
      undefined
    );
    // SQL block + a result cell + the "showing N of M" note are shown.
    expect(screen.getByLabelText("Generated SQL")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 1 row/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Download CSV/ })
    ).toBeInTheDocument();
  });

  it("renders a bar chart under the table when the outcome carries a valid bar ChartSpec", async () => {
    const categoryChip: StarterChip = {
      tableName: "monsters",
      question: "How many rows per species in monsters?",
      sql: "SELECT species AS category, COUNT(*) AS count FROM monsters GROUP BY species",
      chart: { type: "bar", x: "category", y: "count" },
    };
    const okOutcome: AskOutcome = {
      kind: "ok",
      sql: categoryChip.sql,
      explanation: categoryChip.question,
      columns: ["category", "count"],
      rows: [
        ["ghost", 3],
        ["vamp", 1],
      ],
      rowCount: 2,
      capped: false,
      chart: { type: "bar", x: "category", y: "count" },
    };
    const controller = fakeController({ runSql: vi.fn(async () => okOutcome) });
    render(
      <AskTheLabPanel
        controller={controller}
        store={new AskStore()}
        chips={[categoryChip]}
        aiAvailable={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: categoryChip.question }));

    await waitFor(() =>
      expect(screen.getByLabelText("Bar chart of count by category")).toBeInTheDocument()
    );
    // The chip carried a chart spec through to runSql.
    expect(controller.runSql).toHaveBeenCalledWith(
      categoryChip.sql,
      categoryChip.question,
      categoryChip.chart
    );
  });
});
