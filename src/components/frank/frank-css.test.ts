/**
 * Requirement 7 checked against the stylesheet itself: effect layers ignore the
 * pointer, no one-shot animation runs longer than the limit, only cheap
 * properties animate, and reduced motion and Calm Frank switch animation off.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FRANK_REACTION_MAX_MS } from "../../core/frank/constants";

const css = fs.readFileSync(path.resolve(__dirname, "../Specimen.css"), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[},\\s])${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return m ? m[1] : "";
}

describe("Specimen.css motion safety", () => {
  it("every effect layer and the bubble ignore the pointer", () => {
    for (const selector of [".frank-flash", ".frank-lightning", ".specimen__fx", ".specimen__bubble"]) {
      const body = css.split("\n").some((l) => l.includes(selector))
        ? css.match(new RegExp(`[^}]*${selector.replace(".", "\\.")}[^{]*\\{[^}]*pointer-events:\\s*none`, "m"))
        : null;
      expect(body, `${selector} needs pointer-events: none`).not.toBeNull();
    }
    expect(ruleBody(".specimen__fx *")).toMatch(/pointer-events:\s*none/);
    expect(ruleBody(".specimen__smile,\n.specimen__mask,\n.specimen__pumpkin")).toMatch(/pointer-events:\s*none/);
  });

  it("no one-shot animation (duration x count + delay) exceeds the reaction limit", () => {
    const decls = [...css.matchAll(/animation:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(decls.length).toBeGreaterThan(20);
    for (const decl of decls) {
      if (decl === "none !important" || decl === "none" || /infinite/.test(decl)) continue;
      const times = [...decl.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)].map((m) => parseFloat(m[1]) * (m[2] === "s" ? 1000 : 1));
      expect(times.length, decl).toBeGreaterThan(0);
      const [duration, delay = 0] = times;
      const count = /\s(\d+)(?:\s|$)/.exec(decl.replace(/\d+(?:\.\d+)?m?s/g, " "))?.[1];
      const total = duration * (count ? parseInt(count, 10) : 1) + delay;
      expect(total, decl).toBeLessThanOrEqual(FRANK_REACTION_MAX_MS);
    }
  });

  it("only infinite loops are the idle poses (zzz, flask bubbles, breathing, blinking)", () => {
    const infinite = [...css.matchAll(/animation:\s*([^;]+infinite[^;]*);/g)].map((m) => m[1].split(/\s+/)[0]);
    for (const name of infinite) {
      expect(["frank-zzz", "frank-bubble-up", "specimen-breathe", "specimen-blink", "specimen-electrode"]).toContain(name);
    }
  });

  it("animates only transform, opacity, stroke-dashoffset and filter", () => {
    const keyframes = [...css.matchAll(/@keyframes\s+(frank-[\w-]+)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)];
    expect(keyframes.length).toBeGreaterThan(30);
    for (const [, name, body] of keyframes) {
      const props = new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]));
      for (const prop of props) {
        expect(["transform", "opacity", "stroke-dashoffset", "filter", "box-shadow"], `${name} animates ${prop}`).toContain(prop);
      }
    }
  });

  it("Calm Frank and reduced motion switch every animation off", () => {
    expect(css).toMatch(/\.specimen--still,\s*\n\.specimen--still \*\s*\{\s*animation:\s*none !important/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none !important/);
    expect(css).toMatch(/\.frank-flash,\s*\n\s*\.frank-lightning\s*\{\s*display:\s*none/);
  });

  it("is hidden below 640px", () => {
    expect(css).toMatch(/@media \(max-width: 639px\)\s*\{\s*\.specimen-layer\s*\{\s*display:\s*none/);
  });
});
