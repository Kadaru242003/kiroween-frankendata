/**
 * Explicit navigation helper for the recipe flow (Feature 5, Requirement 8.2).
 * Only called from the "Review in stitching table" button: scrolls the
 * stitching section into view, instantly under prefers-reduced-motion.
 */
export function scrollToStitchScreen(): void {
  const reduce =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const started = Date.now();
  const attempt = () => {
    const el = document.querySelector(".lab-stitch");
    if (el === null) {
      if (Date.now() - started < 2000) window.setTimeout(attempt, 50);
      return;
    }
    el.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };
  window.setTimeout(attempt, 0);
}
