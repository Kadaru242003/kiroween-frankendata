import { describe, expect, it, vi } from "vitest";
import { reactionFor } from "../core/frank/reactions";
import { FrankFeed } from "./frank-feed";

describe("FrankFeed", () => {
  it("starts empty, publishes changes to subscribers, and ignores no-op publishes", () => {
    const feed = new FrankFeed(false);
    const listener = vi.fn();
    const off = feed.subscribe(listener);
    expect(feed.getSnapshot()).toEqual({ reaction: null, seq: 0, calm: false, idle: false });
    const wake = reactionFor({ type: "wake" });
    feed.publish({ reaction: wake, seq: 1, calm: false, idle: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(feed.getSnapshot().reaction?.id).toBe("wake");
    feed.publish({ reaction: wake, seq: 1, calm: false, idle: false });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    feed.publish({ reaction: null, seq: 1, calm: true, idle: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("survives a throwing listener", () => {
    const feed = new FrankFeed(false);
    feed.subscribe(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    feed.subscribe(ok);
    expect(() => feed.publish({ reaction: null, seq: 2, calm: false, idle: false })).not.toThrow();
    expect(ok).toHaveBeenCalled();
  });
});
