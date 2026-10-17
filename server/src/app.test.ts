import { describe, expect, it } from "vitest";
import { Health } from "@pitstop/protocol";
import { buildApp } from "./app.js";

const deps = (dbUp: boolean) => ({
  version: "test-sha",
  pingDb: async () => {
    if (!dbUp) throw new Error("connection refused");
    return true;
  },
  headLsn: async () => 0,
});

describe("GET /healthz", () => {
  it("returns 200 with the version when the database answers", async () => {
    const app = await buildApp(deps(true));
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(Health.parse(res.json())).toEqual({ ok: true, version: "test-sha", db: true });
    await app.close();
  });

  it("returns 503 when the database is down", async () => {
    const app = await buildApp(deps(false));
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, db: false });
    await app.close();
  });
});

describe("POST /commit", () => {
  it("is a placeholder until Phase 1", async () => {
    const app = await buildApp(deps(true));
    const res = await app.inject({ method: "POST", url: "/commit", payload: {} });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
});
