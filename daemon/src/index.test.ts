import { readFileSync } from "node:fs";
import { describe as suite, expect, it } from "vitest";
import { ServerMessage } from "@pitstop/protocol";
import { describe } from "./index.js";

// Example of testing the daemon against the shared protocol fixtures.
suite("daemon understands every server message fixture", () => {
  const raw = JSON.parse(
    readFileSync(new URL("../../packages/protocol/fixtures/server-messages.json", import.meta.url), "utf8"),
  ) as unknown[];

  it("describes each message", () => {
    for (const m of raw) expect(describe(ServerMessage.parse(m))).toMatch(/\S/);
  });
});
