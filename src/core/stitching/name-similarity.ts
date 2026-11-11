/**
 * Fuzzy column-name similarity (Feature 2, task 5).
 *
 * A pure, deterministic, framework-agnostic building block used by the
 * deterministic matching engine to decide how similar two column *names* are
 * (Req 1.2 — match columns referring to the same thing even when their names
 * differ, e.g. "Monster Name" ↔ "name", "scientist" ↔ "lead_scientist").
 *
 * The score blends a token-set score with a character-level score, so it
 * rewards both shared words ("monster name" vs "name") and near-spellings
 * ("scientist" vs "scientst"). It is symmetric by construction
 * (`nameSim(a, b) === nameSim(b, a)`, Req 1.4).
 *
 * ## Name normalization (design: "Name normalization")
 *
 * Before comparison, each column name is normalized deterministically:
 *   1. Unicode NFKC normalize, then lowercase.
 *   2. Split into tokens on non-alphanumeric boundaries *and* camelCase /
 *      snake_case boundaries (`"Monster Name"` → `["monster","name"]`,
 *      `"lead_scientist"` → `["lead","scientist"]`,
 *      `"leadScientist"` → `["lead","scientist"]`).
 *   3. Drop empty tokens; keep token order.
 *
 * ## nameSim(a, b) ∈ [0, 1] (design: "nameSim(a, b)")
 *
 *   - Token-set score `T` = |A ∩ B| / |A ∪ B|  (Jaccard over the normalized
 *     token *sets*). Both token sets empty → `T = 1` (two empty names are
 *     identical).
 *   - Character score `C` = 1 - (levenshtein(ja, jb) / max(|ja|, |jb|)), where
 *     `ja`/`jb` are the tokens joined without separators. Both joined strings
 *     empty → `C = 1`.
 *   - nameSim = clamp(0.6 · T + 0.4 · C, 0, 1).
 *
 * All functions are pure and order-independent given their inputs.
 */

/**
 * Normalize a column name into an ordered list of lowercase alphanumeric
 * tokens (design: "Name normalization").
 *
 * Splits on:
 *   - any run of non-alphanumeric characters (spaces, punctuation, `_`, `-`, …);
 *   - a lowercase/digit → uppercase boundary (camelCase: `leadScientist`);
 *   - a letter → digit or digit → letter boundary (`col2name` → `col`,`2`,`name`).
 *
 * NFKC normalization runs first so compatibility code points (e.g. full-width
 * or ligature forms) fold to their canonical equivalents before tokenizing.
 */
export function normalizeName(name: string): string[] {
  // 1. Unicode NFKC normalize, then lowercase.
  //    NFKC is applied before lowercasing so compatibility forms collapse
  //    first; lowercasing afterwards is deterministic for the Latin ranges we
  //    tokenize on (the \p{Lu} boundary below is detected on the *pre*-lowered
  //    original, see step 2).
  const nfkc = name.normalize("NFKC");

  // 2. Insert explicit split markers at camelCase and letter/digit boundaries
  //    on the NFKC (still original-case) string, so the uppercase boundary is
  //    visible. Then lowercase.
  const withBoundaries = nfkc
    // lower-or-digit followed by an uppercase letter: camelCase boundary.
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1\u0000$2")
    // a run of uppercase followed by Upper+lower (acronym → word): "HTTPServer".
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1\u0000$2")
    // letter → digit and digit → letter boundaries.
    .replace(/(\p{L})(\p{N})/gu, "$1\u0000$2")
    .replace(/(\p{N})(\p{L})/gu, "$1\u0000$2");

  const lowered = withBoundaries.toLowerCase();

  // 3. Split on the inserted markers and on any run of characters that are not
  //    letters or digits, then drop empties. Order is preserved.
  return (
    lowered
      // The \u0000 marker is the deliberate boundary we inserted above; the
      // alternative matches any run of non-alphanumerics.
      // oxlint-disable-next-line no-control-regex
      .split(/\u0000|[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0)
  );
}

/**
 * Jaccard similarity over two token *sets*: |A ∩ B| / |A ∪ B|.
 * Two empty sets are treated as identical (returns 1). Pure and symmetric.
 */
function tokenSetScore(tokensA: string[], tokensB: string[]): number {
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  // union is > 0 here because at least one set is non-empty.
  return intersection / union;
}

/**
 * Standard Levenshtein edit distance (insert/delete/substitute, unit cost)
 * between two strings. Uses a rolling single-row DP, O(|a|·|b|) time and
 * O(min) space. Pure and symmetric in the sense that d(a, b) === d(b, a).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  // Keep the shorter string as the inner (column) dimension to bound memory.
  let source = a;
  let target = b;
  if (source.length > target.length) {
    [source, target] = [target, source];
  }

  const prev = new Array<number>(source.length + 1);
  for (let i = 0; i <= source.length; i += 1) {
    prev[i] = i;
  }

  for (let j = 1; j <= target.length; j += 1) {
    let diagonal = prev[0]; // prev[j-1] before this column overwrites prev[0]
    prev[0] = j;
    const targetChar = target.charCodeAt(j - 1);
    for (let i = 1; i <= source.length; i += 1) {
      const above = prev[i];
      const cost = source.charCodeAt(i - 1) === targetChar ? 0 : 1;
      prev[i] = Math.min(
        prev[i] + 1, // deletion
        prev[i - 1] + 1, // insertion
        diagonal + cost, // substitution
      );
      diagonal = above;
    }
  }

  return prev[source.length];
}

/**
 * Normalized Levenshtein similarity over two already-joined strings:
 * 1 - (levenshtein(a, b) / max(|a|, |b|)). Both strings empty → 1.
 * Result is in [0, 1] (edit distance never exceeds the longer length).
 */
function characterScore(joinedA: string, joinedB: string): number {
  const longest = Math.max(joinedA.length, joinedB.length);
  if (longest === 0) {
    return 1;
  }
  return 1 - levenshtein(joinedA, joinedB) / longest;
}

/** Clamp a number to the inclusive range [0, 1]. */
function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/** Weight on the token-set (Jaccard) component. */
const TOKEN_WEIGHT = 0.6;
/** Weight on the character-level (normalized Levenshtein) component. */
const CHARACTER_WEIGHT = 0.4;

/**
 * Fuzzy similarity between two column names in the inclusive range [0, 1]
 * (design: "nameSim(a, b)"; Req 1.2, 1.4).
 *
 * `nameSim = clamp(0.6 · Jaccard(tokens) + 0.4 · (1 − normalizedLevenshtein(joined)), 0, 1)`.
 *
 * Symmetric by construction: both sub-scores are computed from the unordered
 * pair, so `nameSim(a, b) === nameSim(b, a)`.
 */
export function nameSim(a: string, b: string): number {
  const tokensA = normalizeName(a);
  const tokensB = normalizeName(b);

  const tokenScore = tokenSetScore(tokensA, tokensB);
  const charScore = characterScore(tokensA.join(""), tokensB.join(""));

  return clamp01(TOKEN_WEIGHT * tokenScore + CHARACTER_WEIGHT * charScore);
}
