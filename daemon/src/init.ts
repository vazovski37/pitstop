import { DEFAULT_REPO, Repo, type Author } from "@pitstop/protocol";
import { importWorktree } from "./commit.js";
import { readFileConfig, serverHeaders, writeFileConfig } from "./config.js";
import type { Applier } from "./jj.js";
import { readState } from "./state.js";

export interface InitOptions {
  serverUrl: string;
  token?: string;
  repo?: string;
  worktree: string;
  applier: Applier;
  author: Author;
  /** Skip the import of the worktree as the repository's first entry. */
  noImport?: boolean;
  /** The tree the import sends (commit.ts, ImportOptions.from); default `@`. */
  importFrom?: "main" | "@";
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/** A worktree already configured for another repository or server: init leaves it as it is. */
export class OtherCheckout extends Error {}

const sameServer = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

export interface InitResult {
  /** The repository as the server knows it (the default one when none was named). */
  repo: Repo;
  /** The LSN of the import, when one was made. */
  importedAs: number | undefined;
}

/**
 * `pitstop init <server-url> [--repo owner/name] [--token t]`: remembers the server in
 * `.pitstop/config.json`, creates the repository on the server when one is named (`POST /repos`,
 * idempotent), and, when that repository's log is empty and this worktree has applied nothing,
 * imports every tracked file as its first entry. Start `pitstop daemon` afterwards.
 */
export async function init(opts: InitOptions): Promise<InitResult> {
  const serverUrl = opts.serverUrl.replace(/\/+$/, "");
  // Never re-point a checkout of one repository at another: its state, its main and its daemon
  // belong to the log it was set up for.
  const current = await readFileConfig(opts.worktree);
  if (current.serverUrl !== undefined) {
    const was = current.repo ?? DEFAULT_REPO;
    const wanted = opts.repo ?? DEFAULT_REPO;
    if (was !== wanted || !sameServer(current.serverUrl, serverUrl)) {
      throw new OtherCheckout(
        `${opts.worktree} is already a Pitstop checkout of ${was} on ${current.serverUrl}; its .pitstop/config.json was left as it is. Set up ${wanted} on ${serverUrl} from a directory outside it.`,
      );
    }
  }
  // What else the file holds (the agent's name from setup) stays.
  await writeFileConfig(opts.worktree, {
    ...current,
    serverUrl,
    ...(opts.token === undefined ? {} : { token: opts.token }),
    ...(opts.repo === undefined ? {} : { repo: opts.repo }),
  });
  opts.log?.(`server ${serverUrl}${opts.repo === undefined ? "" : `, repository ${opts.repo}`} written to .pitstop/config.json`);

  // Idempotent: 201 creates, 200 finds; the server seeds its default repository, so the call also
  // answers where the log stands when no repository was named.
  const id = opts.repo ?? DEFAULT_REPO;
  const res = await (opts.fetch ?? fetch)(new URL("/repos", serverUrl), {
    method: "POST",
    headers: serverHeaders(opts.token, true),
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`POST /repos answered ${res.status}: ${await res.text().catch(() => "")}`);
  const repo = Repo.parse(await res.json());
  opts.log?.(`${res.status === 201 ? "created" : "found"} ${repo.id} at #${repo.headLsn}`);

  let importedAs: number | undefined;
  const state = await readState(opts.worktree);
  if (!opts.noImport && repo.headLsn === 0 && state.appliedLsn === 0) {
    const changeset = await importWorktree({
      serverUrl,
      ...(opts.token === undefined ? {} : { token: opts.token }),
      ...(opts.repo === undefined ? {} : { repo: opts.repo }),
      worktree: opts.worktree,
      applier: opts.applier,
      author: opts.author,
      ...(opts.importFrom === undefined ? {} : { from: opts.importFrom }),
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
      ...(opts.log === undefined ? {} : { log: opts.log }),
    });
    importedAs = changeset.lsn;
  } else if (!opts.noImport) {
    opts.log?.(
      state.appliedLsn > 0
        ? `this worktree is at #${state.appliedLsn}; nothing imported`
        : `${repo.id} already has ${repo.headLsn} entries; nothing imported, the daemon will fetch them`,
    );
  }
  return { repo, importedAs };
}
