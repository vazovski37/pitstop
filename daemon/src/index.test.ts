import { readFileSync } from "node:fs";
import { describe as suite, expect, it } from "vitest";
import { ServerMessage } from "@pitstop/protocol";
import { describe } from "./index.js";

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../packages/protocol/fixtures/${name}`, import.meta.url), "utf8"));

// Example of testing the daemon against the shared protocol fixtures.
suite("daemon understands every server message fixture", () => {
  it("describes each message", () => {
    for (const m of load("server-messages.json") as unknown[]) expect(describe(ServerMessage.parse(m))).toMatch(/\S/);
  });

  it("describes the head that answers a subscribe", () => {
    expect(describe(ServerMessage.parse(load("head.json")))).toBe("teamdb/demo is at #121");
  });
});
