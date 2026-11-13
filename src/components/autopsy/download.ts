/**
 * Browser download helper for the Autopsy exports (UI edge only).
 *
 * Creates a Blob and a temporary object URL on click and revokes it afterwards,
 * so nothing leaks. Everything happens locally; there is no network request.
 * It degrades to a no-op if Blob or URL are unavailable.
 */

export function downloadText(filename: string, mime: string, text: string): void {
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
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

/** A filesystem-friendly file stem from a table name. */
export function fileStem(tableName: string): string {
  const stem = tableName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return stem === "" ? "table" : stem;
}
