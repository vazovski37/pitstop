/** Shared by the daemon's tests only; excluded from the build. */
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommitRequest, ServerMessage, type Changeset, type FileChange } from "@pitstop/protocol";
import type { Applier, ApplyResult } from "./jj.js";

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../packages/protocol/fixtures/${name}`, import.meta.url), "utf8"));

export const fixtureMessages = (): ServerMessage[] =>
  (fixture("server-messages.json") as unknown[]).map((m) => ServerMessage.parse(m));

/** The one `entry` in the shared fixture (#122). */
export const fixtureEntry = (): Changeset => {
  const m = fixtureMessages().find((x) => x.type === "entry");
  if (m?.type !== "entry") throw new Error("the fixture has no entry");
  return m.changeset;
};

/** The fixture entry moved to another LSN. */
export const entryAt = (lsn: number, patch: Partial<Changeset> = {}): Changeset => ({
  ...fixtureEntry(),
  lsn,
  baseLsn: Math.max(0, lsn - 2),
  intent: `entry #${lsn}`,
  ...patch,
});

export const fixtureCommitFiles = (): FileChange[] => CommitRequest.parse(fixture("commit-request.json")).files;

/** Records what the daemon asked it to do instead of touching a repository. */
export class FakeApplier implements Applier {
  applied: Changeset[] = [];
  /** Throw when asked to apply this LSN. */
  failOn: number | undefined;
  /** What `diffAgainstMain` reports. */
  files: FileChange[] = [];

  async apply(changeset: Changeset): Promise<ApplyResult> {
    if (changeset.lsn === this.failOn) throw new Error(`cannot apply #${changeset.lsn}`);
    this.applied.push(changeset);
    return { commit: `commit-${changeset.lsn}`, conflicted: [] };
  }

  async diffAgainstMain(): Promise<FileChange[]> {
    return this.files;
  }

  get lsns(): number[] {
    return this.applied.map((c) => c.lsn);
  }
}

export async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pitstop-"));
