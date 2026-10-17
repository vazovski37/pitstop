import { beforeEach, describe, expect, it } from "vitest";
import { signIn, signOut } from "./auth/session.js";
import { handle } from "./router.js";

describe("router", () => {
  beforeEach(() => {
    signOut();
    signIn("u1", new Date("2026-10-17T10:00:00Z"));
  });

  it("greets the signed-in user on the home page", () => {
    expect(handle("/")).toMatchObject({ status: 200, body: "<h1>Welcome back, Nino</h1>" });
  });

  it("shows the signed-in user's profile", () => {
    const res = handle("/profile");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<h1>Nino</h1>");
    expect(res.body).toContain("nino@teamdb.example");
  });

  it("answers 404 for anything else", () => {
    expect(handle("/nope").status).toBe(404);
  });
});
