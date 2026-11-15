/**
 * Display-only formatting for Ask the Lab answers. The SQL, the CSV download
 * and the underlying values keep their raw names and numbers; only what is
 * shown on screen is humanized and formatted.
 */
import type { DisplayValue } from "./types.js";

/** Thousands separators; whole numbers as is, otherwise exactly 2 decimals (105,200.40). */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  const whole = Number.isInteger(n);
  return n.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
}

/** A cell as shown: numbers formatted, everything else as text. */
export function formatCell(value: DisplayValue): string {
  return typeof value === "number" ? formatNumber(value) : String(value);
}

/**
 * snake_case or Capital_Snake to sentence case: "invoiced_revenue" becomes
 * "Invoiced revenue". Short ALL CAPS tokens (EMEA, ID) are kept.
 */
export function humanize(name: string): string {
  const words = name.replace(/_+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return name;
  const out = words.map((w, i) => {
    const keep = w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w);
    const base = keep ? w : w.toLowerCase();
    return i === 0 ? base.charAt(0).toUpperCase() + base.slice(1) : base;
  });
  return out.join(" ");
}

/** True when the column's first non-empty value is a number (right-aligned in tables). */
export function isNumericColumnAt(rows: DisplayValue[][], index: number): boolean {
  for (const row of rows) {
    const v = row[index];
    if (v === "" || v === null || v === undefined) continue;
    return typeof v === "number";
  }
  return false;
}

/** Wrap a label into at most two lines of `max` characters, truncating the second. */
export function wrapLabel(label: string, max: number): string[] {
  const limit = Math.max(4, max);
  if (label.length <= limit) return [label];
  let cut = label.lastIndexOf(" ", limit);
  if (cut < Math.floor(limit / 2)) cut = limit;
  const first = label.slice(0, cut).trimEnd();
  let second = label.slice(cut).trimStart();
  if (second.length > limit) second = `${second.slice(0, limit - 1)}…`;
  return second ? [first, second] : [first];
}
