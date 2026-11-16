/**
 * A short, non-leaky description of why an apply failed. Raw DuckDB messages
 * quote cell values, so only a fixed category sentence is ever shown.
 */
export const APPLY_FAILED_MESSAGE = "The stitch could not be applied. Nothing was changed.";

export function describeApplyError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  let reason: string;
  if (/convert|cast|conversion|type/i.test(text)) {
    reason = "A join key could not be compared because its values have different types.";
  } else if (/memory|allocat|out of/i.test(text)) {
    reason = "The browser ran out of memory.";
  } else {
    reason = "The database reported an unexpected error.";
  }
  return `${APPLY_FAILED_MESSAGE} ${reason}`;
}
