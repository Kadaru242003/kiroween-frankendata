import { csvWithBom } from "../../core/chat/csv-export";

/**
 * Browser download helper for binary exports (Feature 5, UI edge only).
 * Creates a Blob URL, clicks a temporary link, and revokes the URL, like the
 * Autopsy text helper. Nothing is uploaded. A blocked download never throws.
 */
export function downloadBytes(
  filename: string,
  mime: string,
  data: Uint8Array | string
): void {
  try {
    // CSV text gets a UTF-8 BOM so Excel reads accents; SQL scripts and the
    // rest of the text downloads are left exactly as built.
    const part: BlobPart =
      typeof data === "string"
        ? mime.startsWith("text/csv")
          ? csvWithBom(data)
          : data
        : (data as BlobPart);
    const blob = new Blob([part], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch {
    /* a blocked download must never crash the app */
  }
}
