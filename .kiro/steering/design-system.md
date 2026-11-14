---
inclusion: fileMatch
fileMatchPattern: 'src/components/**'
---
# Design system

Conventions for UI components and their CSS. This covers `src/components/**` including the `.css` files that sit next to each component.

## Colors

- The theme is a dark mad-scientist lab. The single source of truth is `src/theme/tokens.ts`. `src/index.css` mirrors it as `:root` custom properties. Keep the two in sync when changing a color.
- Use the variables, not raw hex: `--background`, `--surface`, `--surface-raised`, `--border`, `--text-primary`, `--text-secondary`, `--lab-green`, `--lab-green-deep`, `--lab-purple`, `--amber-accent`. Convenience aliases also exist: `--text`, `--text-h`, `--bg`, `--code-bg`, `--accent`, `--accent-bg`, `--accent-border`.
- Body text pairs are contrast-tested against the tokens (WCAG AA, 4.5:1). Do not introduce a text color that is not one of the tested pairs.

## Visual language

- The lab green (`--lab-green`) is the accent. The brief green glow (box-shadow keyframes) is the established "it worked" effect, used for the stitched result, the Join panel appearing, and a freshly added proposal card. Reuse that style instead of inventing a new one.
- The Autopsy panel is themed as a case file (stamp, verdict, status badges with text, not color alone).
- Little Frank (`Specimen`) is decorative. Held items share one hand with a fixed priority: magnifying glass, recipe scroll, chart sign, clipboard. New accessories must follow that single-slot rule.

## Motion

- Every animation or transition must be switched off under `@media (prefers-reduced-motion: reduce)`. Existing components do this in their own CSS file (App, DropZone, TablePreview, LabIntro, Specimen, ApprovalScreen, JoinControls, Autopsy).
- Entrance effects such as the row sew-in are CSS only and wrapped in `prefers-reduced-motion: no-preference`.
- Programmatic scrolling must use `behavior: "auto"` when reduced motion is requested.

## Accessibility

- Use real `<button>`, `<label>` and `<input>` elements. Every control needs an accessible name; icon-only or ambiguous buttons get an `aria-label` that includes the table or item name (for example `Export monsters as CSV`).
- Status and feedback text goes in a polite live region (`role="status"` with `aria-live="polite"`). Errors that need attention use `role="alert"`.
- Keep a visible `:focus-visible` outline on every interactive element.
- Everything must work from the keyboard. Decorative SVG is `aria-hidden`.
- AI-provided and recipe-provided text is rendered as plain text, never as markup.

## Feedback in place, never auto-scroll

- A UI action gives feedback next to the control that triggered it (a message, a disabled "Added" state, a count). It must not scroll the page or move focus away from where the user is.
- Navigation to another part of the screen happens only from an explicit button (for example "Review in stitching table"), and that button scrolls instantly under reduced motion.
- Sticky bars (the approval action bar, the Autopsy review bar) stay inside their own container.
