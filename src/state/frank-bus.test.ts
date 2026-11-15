import { describe, expect, it, vi } from "vitest";
import { FrankBus } from "./frank-bus";

describe("FrankBus", () => {
  it("delivers events to subscribers and stops after unsubscribe", () => {
    const bus = new FrankBus();
    const a = vi.fn();
    const off = bus.subscribe(a);
    bus.emit({ type: "export" });
    off();
    bus.emit({ type: "reset" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith({ type: "export" });
  });
  it("a throwing listener does not break the emit or the other listeners", () => {
    const bus = new FrankBus();
    const ok = vi.fn();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(ok);
    expect(() => bus.emit({ type: "ai-off" })).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
