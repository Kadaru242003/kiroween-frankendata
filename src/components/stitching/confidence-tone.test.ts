import { describe, expect, it } from "vitest";
import { confidenceTone } from "./MatchDiff";

describe("confidenceTone", () => {
  it("90 and above is high, 70 to 89 is mid, below 70 is low", () => {
    expect(confidenceTone(1)).toBe("high");
    expect(confidenceTone(0.9)).toBe("high");
    expect(confidenceTone(0.895)).toBe("high"); // rounds to 90%
    expect(confidenceTone(0.89)).toBe("mid");
    expect(confidenceTone(0.7)).toBe("mid");
    expect(confidenceTone(0.69)).toBe("low");
    expect(confidenceTone(0.383)).toBe("low");
  });
});
