/**
 * Feature: frankendata-security-hardening, Property 2: a redacted DuckDB error
 * never contains a quoted value or a long number from the input, and never
 * exceeds the cap.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ASK_REPAIR_ERROR_MAX_CHARS } from "./types";
import { redactDuckDbError } from "./redact-error";

// A secret that cannot appear in the fixed message text.
const secret = fc
  .string({ minLength: 3, maxLength: 24, unit: fc.constantFrom(..."QXZJKWV0123456789-_ ".split("")) })
  .filter((s) => /[QXZJKWV]{3}/.test(s) && !s.includes("'") && !s.includes('"'));

describe("Feature: frankendata-security-hardening, Property 2: redacted repair errors", () => {
  it("never leaks a quoted value and stays within the cap", () => {
    fc.assert(
      fc.property(
        secret,
        fc.constantFrom("'", '"'),
        fc.constantFrom("Conversion Error", "Binder Error", "Invalid Input Error"),
        fc.string({ maxLength: 40 }).map((s) => s.replace(/['"\n]/g, "")),
        (value, quote, type, tail) => {
          const raw = `${type}: Could not convert string ${quote}${value}${quote} to INT32 ${tail}\nLINE 1: SELECT ${value}`;
          const out = redactDuckDbError(raw);
          expect(out).not.toContain(value.trim() === "" ? "\u0000" : value);
          expect(out.length).toBeLessThanOrEqual(ASK_REPAIR_ERROR_MAX_CHARS);
          expect(out).not.toContain("\n");
          expect(out.startsWith(type)).toBe(true);
        }
      ),
      { numRuns: 300 }
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const once = redactDuckDbError(s);
        expect(redactDuckDbError(once)).toBe(once);
      }),
      { numRuns: 300 }
    );
  });
});
