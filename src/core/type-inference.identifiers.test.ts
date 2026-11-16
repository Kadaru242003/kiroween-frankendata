import { describe, expect, it } from "vitest";
import { typeInferenceLayer } from "./type-inference";

function typeOf(values: string[]): string {
  return typeInferenceLayer.infer(["c"], values.map((v) => [v]))[0]!.type;
}

describe("type inference keeps identifier-like digit strings as text", () => {
  it("keeps zip codes, phone numbers and ids with leading zeros as string", () => {
    expect(typeOf(["01234", "90210"])).toBe("string");
    expect(typeOf(["0044123", "0044999"])).toBe("string");
    expect(typeOf(["007", "008"])).toBe("string");
    expect(typeOf(["-007", "5"])).toBe("string");
  });

  it("keeps digit-only values of 16 or more digits as string (no precision loss)", () => {
    expect(typeOf(["12345678901234567890", "12345678901234567891"])).toBe("string");
    expect(typeOf(["1234567890123456"])).toBe("string");
  });

  it("still infers ordinary numbers", () => {
    expect(typeOf(["0", "1", "2"])).toBe("number");
    expect(typeOf(["0.5", "-0.5", "0.25"])).toBe("number");
    expect(typeOf(["10", "-3", "4.5"])).toBe("number");
    expect(typeOf(["123456789012345"])).toBe("number");
    expect(typeOf(["1,234", "5,678"])).toBe("number");
  });
});
