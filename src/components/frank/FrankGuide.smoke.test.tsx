import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { describeEgress } from "../../core/egress-description";
import { FALLBACK_TEXT, GREETING, GUIDE_CHIPS } from "../../core/frank/guide";
import { FrankGuide } from "./FrankGuide";

function Harness(props: { onClose?: () => void; instant?: boolean; onCalmChange?: (on: boolean) => void; tip?: string; open?: boolean }) {
  const toggleRef = createRef<HTMLButtonElement>();
  const [calm, setCalm] = useState(false);
  return (
    <div>
      <button ref={toggleRef} type="button">toggle</button>
      <button type="button">outside</button>
      <FrankGuide
        open={props.open ?? true}
        onClose={props.onClose ?? (() => {})}
        tip={props.tip ?? "Click Stitch tables."}
        instant={props.instant ?? true}
        calm={calm}
        onCalmChange={(on) => {
          setCalm(on);
          props.onCalmChange?.(on);
        }}
        toggleRef={toggleRef}
      />
    </div>
  );
}

const dialog = () => screen.getByRole("dialog", { name: "Ask Little Frank" });

describe("FrankGuide", () => {
  it("shows the tip, then the answer, then the input, then the chips, in that order", () => {
    render(<Harness />);
    const d = dialog();
    const tip = within(d).getByTestId("frank-tip");
    const answer = within(d).getByTestId("frank-answer");
    const input = within(d).getByLabelText("Your question");
    const chips = within(d).getByRole("list", { name: "Suggested questions" });
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(tip, answer)).toBe(true);
    expect(before(answer, input)).toBe(true);
    expect(before(input, chips)).toBe(true);
  });

  it("does not close when Frank himself is pressed, and answers 'what do you eat' with acorns", () => {
    const onClose = vi.fn();
    render(
      <div>
        <button type="button" className="specimen-button">frank</button>
        <Harness onClose={onClose} />
      </div>
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "frank" }));
    expect(onClose).not.toHaveBeenCalled();
    const input = screen.getByLabelText("Your question");
    fireEvent.change(input, { target: { value: "what do you eat" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByTestId("frank-answer")).toHaveTextContent(/acorns and berries/);
  });

  it("types the answer out when motion is allowed, and gives screen readers the whole text at once", () => {
    vi.useFakeTimers();
    try {
      render(<Harness instant={false} />);
      const answer = screen.getByTestId("frank-answer");
      const typed = answer.querySelector(".frank-guide__typed")!;
      expect(typed).toHaveAttribute("aria-hidden", "true");
      expect(typed.querySelector("p span")!.textContent).toBe("");
      // The whole greeting is already there for assistive technology.
      expect(answer.querySelector(".frank-guide__sr")).toHaveTextContent(GREETING);
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(typed.querySelector("p span")!.textContent).toBe(GREETING);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the answer instantly when instant (reduced motion or Calm)", () => {
    render(<Harness instant />);
    expect(screen.getByTestId("frank-answer").querySelector(".frank-guide__typed p span")!.textContent).toBe(GREETING);
  });

  it("is a labelled dialog with the tip, the input, the eight chips and focus on the input", () => {
    render(<Harness tip="Click Stitch tables." />);
    const d = dialog();
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(within(d).getByTestId("frank-tip")).toHaveTextContent("Click Stitch tables.");
    expect(within(d).getByLabelText("Your question")).toHaveFocus();
    const chips = within(d).getByRole("list", { name: "Suggested questions" });
    expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(GUIDE_CHIPS);
    expect(within(d).queryByRole("button", { name: /poke/i })).toBeNull();
    expect(within(d).getByRole("checkbox", { name: "Calm Frank" })).not.toBeChecked();
  });

  it("renders nothing when closed", () => {
    render(<Harness open={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("answers a typed question, in a polite live region, as plain text", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Your question");
    fireEvent.change(input, { target: { value: "is my data safe" } });
    fireEvent.submit(input.closest("form")!);
    const answer = screen.getByTestId("frank-answer");
    expect(answer).toHaveAttribute("role", "status");
    expect(answer).toHaveAttribute("aria-live", "polite");
    const egress = describeEgress();
    for (const line of egress.sent) expect(answer).toHaveTextContent(line);
    expect(answer).toHaveTextContent(egress.neverSent);
  });

  it("answers a chip, and falls back with the chips still on screen", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "How was this built?" }));
    expect(screen.getByTestId("frank-answer")).toHaveTextContent("spec-driven with Kiro");
    expect(screen.getByLabelText("Your question")).toHaveValue("How was this built?");
    const input = screen.getByLabelText("Your question");
    fireEvent.change(input, { target: { value: "capital of France" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByTestId("frank-answer")).toHaveTextContent(FALLBACK_TEXT);
    expect(screen.getAllByRole("button", { name: GUIDE_CHIPS[0] })).toHaveLength(1);
  });

  it("ignores an empty question", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Your question");
    fireEvent.submit(input.closest("form")!);
    // Still the greeting.
    expect(screen.getByTestId("frank-answer")).toHaveTextContent(GREETING);
  });

  it("closes on Esc and on a press outside, but not on a press inside or on his button", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.pointerDown(within(dialog()).getByTestId("frank-tip"));
    fireEvent.pointerDown(screen.getByRole("button", { name: "toggle" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("traps focus: Tab from the last control goes to the first, Shift+Tab from the first to the last", () => {
    render(<Harness />);
    const d = dialog();
    const controls = Array.from(d.querySelectorAll<HTMLElement>('button, input'));
    const first = controls[0];
    const last = controls[controls.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("toggles Calm Frank", () => {
    const onCalmChange = vi.fn();
    render(<Harness onCalmChange={onCalmChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Calm Frank" }));
    expect(onCalmChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("checkbox", { name: "Calm Frank" })).toBeChecked();
  });

  it("does not scroll the page when it opens", () => {
    const scroll = vi.fn();
    const original = window.scrollTo;
    window.scrollTo = scroll as never;
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    act(() => {
      render(<Harness />);
    });
    expect(scroll).not.toHaveBeenCalled();
    expect(into).not.toHaveBeenCalled();
    window.scrollTo = original;
  });
});
