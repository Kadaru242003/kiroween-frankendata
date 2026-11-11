/**
 * Spooky mad-scientist lab theme color tokens.
 *
 * This module is the single source of truth for the theme's colors (Req 12.1,
 * 12.2). The tokens are consumed two ways that must stay in sync:
 *
 * 1. CSS: `src/index.css` defines matching `:root` custom properties whose hex
 *    values mirror {@link themeTokens}. The CSS variable names are derived from
 *    the token names (camelCase → kebab-case, prefixed with `--`), e.g.
 *    `background` → `--background`, `textPrimary` → `--text-primary`.
 * 2. Tests: the contrast unit test (optional task 14.4) reads
 *    {@link contrastCheckedPairs} and asserts each foreground/background pair
 *    meets the WCAG AA body-text contrast ratio of at least 4.5:1 (Req 12.2).
 *
 * The theme is presentation-only; nothing here is imported by the pure core
 * parsing/typing/loading modules.
 */

/**
 * The palette: a dark laboratory background with a restrained set of lab
 * greens, purples, and amber accents, plus high-contrast light body text.
 *
 * All values are 7-character `#RRGGBB` hex strings so they can be parsed
 * directly by the WCAG contrast computation used in tests.
 */
export const themeTokens = {
  /** Deep near-black lab background used for the page body. */
  background: "#0B0F0C",
  /** Slightly lifted dark-green surface for cards, panels, and previews. */
  surface: "#121A14",
  /** Raised surface for elements that sit on top of {@link surface}. */
  surfaceRaised: "#182218",
  /** Borders and column separators against the dark surfaces. */
  border: "#2C3A2E",

  /** Primary body text: a high-contrast light green-tinted tone. */
  textPrimary: "#E8F5E9",
  /** Secondary/muted body text, still meeting 4.5:1 against the dark bg. */
  textSecondary: "#A9C4AE",

  /** Toxic laboratory green accent (highlights, active states). */
  labGreen: "#39FF14",
  /** A calmer, deeper green accent. */
  labGreenDeep: "#1B7F3B",
  /** Eerie laboratory purple accent. */
  labPurple: "#B388FF",
  /** Warning/attention amber accent. */
  amberAccent: "#FFB300",
} as const;

/** A theme color token name. */
export type ThemeTokenName = keyof typeof themeTokens;

/** A foreground/background color pairing to be contrast-checked. */
export interface ContrastPair {
  /** Human-readable label for diagnostics in tests. */
  readonly label: string;
  /** Foreground (text) token name. */
  readonly fg: ThemeTokenName;
  /** Background token name. */
  readonly bg: ThemeTokenName;
}

/**
 * The body-text foreground/background pairs that MUST meet a contrast ratio of
 * at least 4.5:1 (Req 12.2).
 *
 * Only body-text pairs are registered here. The lab green, purple, and amber
 * accents are used for non-body-text decoration (borders, highlights, icons)
 * and are intentionally excluded from the 4.5:1 requirement.
 */
export const contrastCheckedPairs: readonly ContrastPair[] = [
  { label: "primary body text on background", fg: "textPrimary", bg: "background" },
  { label: "primary body text on surface", fg: "textPrimary", bg: "surface" },
  { label: "secondary body text on background", fg: "textSecondary", bg: "background" },
  { label: "secondary body text on surface", fg: "textSecondary", bg: "surface" },
];

/** Minimum WCAG AA contrast ratio required for normal body text. */
export const MIN_BODY_TEXT_CONTRAST = 4.5;

/**
 * Relative luminance of a single 8-bit sRGB channel, per the WCAG 2.x
 * definition.
 */
function channelLuminance(value8bit: number): number {
  const c = value8bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Relative luminance of a `#RRGGBB` hex color, per WCAG 2.x.
 *
 * @param hex A 7-character `#RRGGBB` string (the token format).
 */
export function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/**
 * WCAG contrast ratio between two `#RRGGBB` colors. The result is in the range
 * `[1, 21]` and is symmetric in its arguments.
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const lighter = Math.max(relativeLuminance(hexA), relativeLuminance(hexB));
  const darker = Math.min(relativeLuminance(hexA), relativeLuminance(hexB));
  return (lighter + 0.05) / (darker + 0.05);
}
