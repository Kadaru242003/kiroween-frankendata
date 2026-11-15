/** The shelf stylesheet keeps the shelf out of the way and motion-safe. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.resolve(__dirname, "LabShelf.css"), "utf8");

describe("LabShelf.css", () => {
  it("is fixed beside the 1200px column and ignores the pointer except on jar buttons", () => {
    expect(css).toMatch(/\.lab-shelf\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/\.lab-shelf\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.lab-shelf\s*\{[^}]*top:\s*50%/);
    expect(css).toMatch(/\.lab-shelf\s*\{[^}]*translate\(-50%, -50%\) scale\(var\(--shelf-scale/);
    expect(css).toMatch(/\.lab-shelf \*\s*\{\s*pointer-events:\s*none/);
    expect(css).toMatch(/\.lab-shelf button\.shelf-jar,[^{]*\{\s*pointer-events:\s*auto/);
  });
  it("prints the section name as real text of at least 12px under each jar", () => {
    const m = /\.shelf-jar__text\s*\{([^}]*)\}/.exec(css);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/font-size:\s*(1[2-9]|[2-9]\d)px/);
    expect(m![1]).not.toMatch(/text-overflow|overflow:\s*hidden/);
  });
  it("shows the tooltip to the left on hover and keyboard focus", () => {
    expect(css).toMatch(/\.shelf-tip\s*\{[^}]*right:\s*calc\(100% \+ 8px\)/);
    expect(css).toMatch(/button\.shelf-jar:hover \+ \.shelf-tip,\s*\nbutton\.shelf-jar:focus-visible \+ \.shelf-tip/);
  });
  it("is hidden below 1440px", () => {
    expect(css).toMatch(/@media \(max-width: 1439px\)\s*\{\s*\.lab-shelf\s*\{\s*display:\s*none/);
  });
  it("turns every animation and transition off for Calm Frank and reduced motion", () => {
    expect(css).toMatch(/\.lab-shelf--still,\s*\n\.lab-shelf--still \*\s*\{\s*animation:\s*none !important/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none !important/);
  });
  it("animates only transform, opacity and filter", () => {
    const keyframes = [...css.matchAll(/@keyframes\s+(shelf-[\w-]+)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)];
    expect(keyframes.length).toBeGreaterThanOrEqual(7);
    for (const [, name, body] of keyframes) {
      for (const prop of new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]))) {
        expect(["transform", "opacity", "filter"], `${name} animates ${prop}`).toContain(prop);
      }
    }
  });
});
