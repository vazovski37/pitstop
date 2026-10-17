import { describe, expect, it } from "vitest";
import { timeAgo } from "./timeAgo.js";

const now = new Date("2026-10-17T13:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("timeAgo", () => {
  it("counts hours", () => {
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe("3 hours ago");
  });

  it("uses the singular for one unit", () => {
    expect(timeAgo(ago(60_000), now)).toBe("1 minute ago");
    expect(timeAgo(ago(86_400_000), now)).toBe("1 day ago");
  });

  it("picks the largest unit that fits", () => {
    expect(timeAgo(ago(40 * 86_400_000), now)).toBe("1 month ago");
    expect(timeAgo(ago(2 * 365 * 86_400_000), now)).toBe("2 years ago");
  });

  it("says just now under a minute", () => {
    expect(timeAgo(ago(20_000), now)).toBe("just now");
  });
});
