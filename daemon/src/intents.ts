import { Intent, type Author, type IntentRequest, type SymbolId } from "@pitstop/protocol";
import { serverHeaders } from "./config.js";
import { readState, writeState } from "./state.js";

export interface IntentOptions {
  serverUrl: string;
  token?: string;
  /** The repository on the server; absent means its default one. */
  repo?: string;
  worktree: string;
  author: Author;
  text: string;
  /** Symbols the agent expects to touch; the server warns about overlapping intents. */
  declaredSymbols?: SymbolId[];
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * Opens a transaction on the server (design doc 6.2, step 1) and remembers it: the daemon's
 * heartbeats keep it alive and the next commit closes it. Declaring marks where the task began,
 * so `readBaseLsn` is set to the applied LSN of this moment unless one is already recorded.
 */
export async function declareIntent(opts: IntentOptions): Promise<Intent> {
  const state = await readState(opts.worktree);
  const request: IntentRequest = {
    ...(opts.repo === undefined ? {} : { repo: opts.repo }),
    author: opts.author,
    baseLsn: state.appliedLsn,
    text: opts.text,
    declaredSymbols: opts.declaredSymbols ?? [],
  };
  const res = await (opts.fetch ?? fetch)(new URL("/intents", opts.serverUrl), {
    method: "POST",
    headers: serverHeaders(opts.token, true),
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`POST /intents answered ${res.status}: ${await res.text().catch(() => "")}`);
  const intent = Intent.parse(await res.json());
  await writeState(opts.worktree, {
    ...state,
    intentId: intent.id,
    readBaseLsn: state.readBaseLsn ?? state.appliedLsn,
  });
  opts.log?.(`intent ${intent.id} open at #${state.appliedLsn}: ${intent.text}`);
  return intent;
}
