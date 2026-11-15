import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AskTheLabPanel } from "./AskTheLabPanel";
import { AskStore } from "../../state/ask-store";
import type { AskController } from "../../core/chat/ask-controller";
import type { AskOutcome } from "../../core/chat/types";

type Ok = Extract<AskOutcome, { kind: "ok" }>;
const ok = (n: number, extra: Partial<Ok> = {}): Ok => ({
  kind: "ok",
  sql: `SELECT ${n} AS v`,
  explanation: `answer ${n}`,
  columns: ["v"],
  rows: [[`VALUE-${n}`]],
  rowCount: 1,
  capped: false,
  ...extra,
});
function controller(outcomes: Ok[]): AskController & { ask: ReturnType<typeof vi.fn> } {
  let i = 0;
  return {
    ask: vi.fn(async () => outcomes[i++]),
    runSql: vi.fn(async () => outcomes[i++]),
  } as never;
}
const submit = async (text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
};

describe("Ask thread view", () => {
  it("sends a thread of names and counts only, shows earlier turns as cards, and focuses the newest answer", async () => {
    const c = controller([ok(1), ok(2)]);
    render(<AskTheLabPanel controller={c} store={new AskStore()} chips={[]} aiAvailable />);
    await submit("first question");
    await waitFor(() => expect(screen.getByLabelText("Latest answer")).toBeInTheDocument());
    expect(c.ask.mock.calls[0][1] ?? []).toEqual([]);
    await waitFor(() => expect(screen.getByLabelText("Latest answer")).toHaveFocus());
    expect(screen.queryByLabelText("Earlier question 1")).toBeNull();

    await submit("now only the High ones");
    await waitFor(() => expect(screen.getByLabelText("Earlier question 1")).toBeInTheDocument());
    const thread = c.ask.mock.calls[1][1];
    expect(thread).toEqual([{ question: "first question", sql: "SELECT 1 AS v", columns: ["v"], rowCount: 1 }]);
    expect(JSON.stringify(thread)).not.toContain("VALUE-1");
    const card = screen.getByLabelText("Earlier question 1");
    expect(card).toHaveTextContent("first question");
    expect(card).toHaveTextContent("1 row");
    expect(card.querySelector("details")).not.toHaveAttribute("open");
  });

  it("does not steal focus when a chip is used", async () => {
    const c = controller([ok(1)]);
    render(
      <AskTheLabPanel
        controller={c}
        store={new AskStore()}
        chips={[{ tableName: "t", question: "How many rows are in t?", sql: "SELECT 1", kind: "row-count" }]}
        aiAvailable
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "How many rows are in t?" }));
    await waitFor(() => expect(screen.getByLabelText("Latest answer")).toBeInTheDocument());
    expect(screen.getByLabelText("Latest answer")).not.toHaveFocus();
  });

  it("New topic clears the thread, announces it, and keeps the answer on screen", async () => {
    const c = controller([ok(1), ok(2)]);
    const store = new AskStore();
    render(<AskTheLabPanel controller={c} store={store} chips={[]} aiAvailable />);
    expect(screen.queryByRole("button", { name: "New topic" })).toBeNull();
    await submit("q1");
    await waitFor(() => expect(screen.getByRole("button", { name: "New topic" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New topic" }));
    expect(store.getState().turns).toHaveLength(0);
    expect(screen.getByText("Started a new topic")).toBeInTheDocument();
    expect(screen.getByLabelText("Latest answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New topic" })).toBeNull();
    await submit("q2");
    await waitFor(() => expect(c.ask).toHaveBeenCalledTimes(2));
    expect(c.ask.mock.calls[1][1] ?? []).toEqual([]);
  });

  it("renders a line chart for a line outcome", async () => {
    const line = ok(1, {
      columns: ["day", "n"],
      rows: [["2026-01-01", 1], ["2026-01-02", 3]],
      rowCount: 2,
      chart: { type: "line", x: "day", y: "n" },
    });
    render(<AskTheLabPanel controller={controller([line])} store={new AskStore()} chips={[]} aiAvailable />);
    await submit("trend");
    await waitFor(() => expect(screen.getByLabelText("Line chart of n over day")).toBeInTheDocument());
  });

  it("prefills, focuses the input, and does not submit for Ask about this", () => {
    const c = controller([]);
    const { rerender } = render(<AskTheLabPanel controller={c} store={new AskStore()} chips={[]} aiAvailable prefill={null} />);
    rerender(<AskTheLabPanel controller={c} store={new AskStore()} chips={[]} aiAvailable prefill={{ text: "In monsters: ", nonce: 1 }} />);
    const input = screen.getByRole("textbox", { name: "Question" }) as HTMLInputElement;
    expect(input.value).toBe("In monsters: ");
    expect(input).toHaveFocus();
    rerender(<AskTheLabPanel controller={c} store={new AskStore()} chips={[]} aiAvailable prefill={{ text: "In experiments: ", nonce: 2 }} />);
    expect(input.value).toBe("In experiments: ");
    expect(c.ask).not.toHaveBeenCalled();
    void act;
  });

  it("New topic also clears the input and focuses it", async () => {
    const c = controller([ok(1)]);
    render(<AskTheLabPanel controller={c} store={new AskStore()} chips={[]} aiAvailable />);
    await submit("q1");
    await waitFor(() => expect(screen.getByRole("button", { name: "New topic" })).toBeInTheDocument());
    const input = screen.getByRole("textbox", { name: "Question" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "half typed" } });
    fireEvent.click(screen.getByRole("button", { name: "New topic" }));
    expect(input.value).toBe("");
    expect(input).toHaveFocus();
  });

  it("a store reset (Reset lab) clears input, thread, outcome and recent questions", async () => {
    const c = controller([ok(1)]);
    const store = new AskStore();
    render(<AskTheLabPanel controller={c} store={store} chips={[]} aiAvailable />);
    await submit("q1");
    await waitFor(() => expect(screen.getByLabelText("Latest answer")).toBeInTheDocument());
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "leftover" } });
    expect(screen.getByLabelText("Recent questions")).toBeInTheDocument();
    act(() => store.reset());
    expect((screen.getByRole("textbox", { name: "Question" }) as HTMLInputElement).value).toBe("");
    expect(screen.queryByLabelText("Latest answer")).toBeNull();
    expect(screen.queryByLabelText("Recent questions")).toBeNull();
    expect(screen.queryByRole("button", { name: "New topic" })).toBeNull();
    expect(store.getState().turns).toHaveLength(0);
    expect(store.getState().history).toHaveLength(0);
    // Resetting an already empty store still bumps the epoch.
    const e = store.getState().epoch;
    store.reset();
    expect(store.getState().epoch).toBe(e + 1);
  });
});


describe("AI switched off by the user", () => {
  it("shows the fully local note and keeps starter chips working", async () => {
    const c = controller([ok(1)]);
    render(
      <AskTheLabPanel
        controller={c}
        store={new AskStore()}
        chips={[{ tableName: "t", question: "How many rows are in t?", sql: "SELECT 1", kind: "row-count" }]}
        aiAvailable={false}
        aiUserOff
      />
    );
    expect(screen.getByText("AI is off. Starter questions still work.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "How many rows are in t?" }));
    await waitFor(() => expect(screen.getByLabelText("Latest answer")).toBeInTheDocument());
  });
});
