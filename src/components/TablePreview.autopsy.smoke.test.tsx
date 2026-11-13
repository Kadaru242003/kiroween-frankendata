/**
 * Smoke test for the "Autopsy" button on TablePreview cards (Autopsy Req 1.1).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TablePreview } from "./TablePreview";
import type { LoadedTable } from "../core/types";

const table: LoadedTable = {
  loadId: 1,
  tableName: "monsters",
  sourceFileName: "monsters.csv",
  schema: [{ name: "name", type: "string" }],
  rowCount: 1,
};

describe("TablePreview Autopsy button", () => {
  it("shows an Autopsy button per card and reports its table on click", () => {
    const onAutopsy = vi.fn();
    render(<TablePreview tables={[{ table, previewRows: [{ name: "Gorzak" }] }]} onAutopsy={onAutopsy} />);
    fireEvent.click(screen.getByRole("button", { name: "Autopsy of monsters" }));
    expect(onAutopsy).toHaveBeenCalledWith(table);
  });

  it("shows no Autopsy button when no handler is provided", () => {
    render(<TablePreview tables={[{ table, previewRows: [] }]} />);
    expect(screen.queryByRole("button", { name: /Autopsy/ })).toBeNull();
  });
});
