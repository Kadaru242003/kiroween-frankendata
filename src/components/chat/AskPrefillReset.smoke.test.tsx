import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AskTheLabPanel } from "./AskTheLabPanel";
import { AskStore } from "../../state/ask-store";
import type { AskController } from "../../core/chat/ask-controller";

const controller = { ask: vi.fn(), runSql: vi.fn() } as unknown as AskController;

/** Mirrors the App wiring: prefill request in the owner's state, consumed once. */
function Harness({ store, consume }: { store: AskStore; consume: boolean }) {
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [mounted, setMounted] = useState(true);
  return (
    <div>
      <button onClick={() => setPrefill((p) => ({ text: "In monsters: ", nonce: (p?.nonce ?? 0) + 1 }))}>
        ask-about
      </button>
      <button
        onClick={() => {
          store.reset();
          setPrefill(null);
          setMounted(false); // the panel unmounts when no table is left
        }}
      >
        reset
      </button>
      <button onClick={() => setMounted(true)}>tables-back</button>
      {mounted ? (
        <AskTheLabPanel
          controller={controller}
          store={store}
          chips={[]}
          aiAvailable
          prefill={prefill}
          onPrefillHandled={consume ? () => setPrefill(null) : undefined}
        />
      ) : null}
    </div>
  );
}
const input = () => screen.getByRole("textbox", { name: "Question" }) as HTMLInputElement;

describe("Ask about this then Reset lab", () => {
  it("leaves an empty input, even after the panel remounts", () => {
    render(<Harness store={new AskStore()} consume />);
    fireEvent.click(screen.getByText("ask-about"));
    expect(input().value).toBe("In monsters: ");
    fireEvent.click(screen.getByText("reset"));
    fireEvent.click(screen.getByText("tables-back"));
    expect(input().value).toBe("");
  });
  it("applies a prefill once per click", () => {
    render(<Harness store={new AskStore()} consume />);
    fireEvent.click(screen.getByText("ask-about"));
    fireEvent.change(input(), { target: { value: "edited by the user" } });
    // Unrelated re-render must not re-apply the old request.
    fireEvent.click(screen.getByText("tables-back"));
    expect(input().value).toBe("edited by the user");
    fireEvent.click(screen.getByText("ask-about"));
    expect(input().value).toBe("In monsters: ");
  });
  it("a plainly typed question is cleared by a store reset", () => {
    const store = new AskStore();
    render(<AskTheLabPanel controller={controller} store={store} chips={[]} aiAvailable />);
    fireEvent.change(input(), { target: { value: "typed question" } });
    act(() => store.reset());
    expect(input().value).toBe("");
  });
});
