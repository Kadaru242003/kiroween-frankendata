/**
 * Minimal render smoke test for DemoDataControl (task 18.2).
 *
 * Confirms the component renders an accessibly-named "Load demo data" button,
 * invokes `onLoadDemo` on click, shows a loading/disabled state while a returned
 * promise is pending, and guards against double-clicks.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DemoDataControl,
  LOAD_DEMO_DATA_LABEL,
  LOAD_DEMO_DATA_LOADING_LABEL,
} from "./DemoDataControl";

describe("DemoDataControl", () => {
  it("renders an accessibly-named 'Load demo data' button", () => {
    render(<DemoDataControl onLoadDemo={() => {}} />);
    expect(
      screen.getByRole("button", { name: LOAD_DEMO_DATA_LABEL })
    ).toBeInTheDocument();
  });

  it("invokes onLoadDemo when activated", async () => {
    const onLoadDemo = vi.fn();
    render(<DemoDataControl onLoadDemo={onLoadDemo} />);

    fireEvent.click(screen.getByRole("button", { name: LOAD_DEMO_DATA_LABEL }));

    // onLoadDemo is invoked on a microtask (sync/async callbacks are normalized
    // via Promise.resolve().then(...)), so await the flush before asserting.
    await waitFor(() => expect(onLoadDemo).toHaveBeenCalledTimes(1));
  });

  it("shows a loading/disabled state while a returned promise is pending, then re-enables", async () => {
    let resolveLoad: () => void = () => {};
    const onLoadDemo = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );
    render(<DemoDataControl onLoadDemo={onLoadDemo} />);

    const button = screen.getByRole("button", { name: LOAD_DEMO_DATA_LABEL });
    fireEvent.click(button);

    // While pending: disabled + loading label.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: LOAD_DEMO_DATA_LOADING_LABEL })
      ).toBeDisabled();
    });

    // Resolve the load; the button re-enables and returns to its idle label.
    resolveLoad();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: LOAD_DEMO_DATA_LABEL })
      ).toBeEnabled();
    });
  });

  it("guards against double-clicks while a load is in flight", async () => {
    let resolveLoad: () => void = () => {};
    const onLoadDemo = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );
    render(<DemoDataControl onLoadDemo={onLoadDemo} />);

    const button = screen.getByRole("button", { name: LOAD_DEMO_DATA_LABEL });
    fireEvent.click(button);
    // A second rapid click should be ignored while the first load is pending.
    fireEvent.click(button);

    // Only the first click starts a load; the second is rejected by the guard.
    await waitFor(() => expect(onLoadDemo).toHaveBeenCalledTimes(1));

    resolveLoad();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: LOAD_DEMO_DATA_LABEL })
      ).toBeEnabled();
    });
  });
});
