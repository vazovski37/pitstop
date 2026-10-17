import { beforeEach, describe, expect, it } from "vitest";
import { getCurrentUser, signIn, signOut } from "./session.js";

const t0 = new Date("2026-10-17T10:00:00Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

describe("session", () => {
  beforeEach(() => signOut());

  it("signs a user in and remembers when they were last seen", () => {
    const first = signIn("u1", t0);
    expect(first.name).toBe("Nino");
    expect(first.lastSeenAt).toEqual(t0);

    signOut();
    const second = signIn("u1", later(3 * 3_600_000));
    expect(second.lastSeenAt).toEqual(t0);
  });

  it("returns the signed-in user", () => {
    signIn("u2", t0);
    expect(getCurrentUser(later(1_000)).id).toBe("u2");
  });

  it("throws when nobody is signed in", () => {
    expect(() => getCurrentUser()).toThrow("not signed in");
  });

  it("rejects an unknown user", () => {
    expect(() => signIn("nobody")).toThrow("no user nobody");
  });

  // TeamDB issue #58: the session has an expiry, but getCurrentUser ignores it.
  it.todo("returns nothing once the session has expired");
});
