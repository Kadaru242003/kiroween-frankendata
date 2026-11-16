import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBytes } from "./download";

async function capture(mime: string, data: string): Promise<string> {
  let blob: Blob | null = null;
  vi.stubGlobal("URL", {
    createObjectURL: (b: Blob) => {
      blob = b;
      return "blob:x";
    },
    revokeObjectURL: () => {},
  });
  downloadBytes("f", mime, data);
  const buffer = await new Promise<ArrayBuffer>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob!);
  });
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes.slice(0, 3)).map((b) => b.toString(16)).join(" ");
}

afterEach(() => vi.unstubAllGlobals());

describe("downloadBytes", () => {
  it("starts a CSV download with a UTF-8 BOM", async () => {
    expect(await capture("text/csv", "a,b")).toBe("ef bb bf");
  });
  it("leaves SQL scripts and other text without a BOM", async () => {
    expect(await capture("text/plain", "select 1")).toBe("73 65 6c");
  });
});
