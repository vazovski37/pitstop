#!/usr/bin/env bash
# Puts one laptop back at the demo's start state and leaves its daemon running (demo/REHEARSAL.md).
# A imports the slice as the repository's first entry; B joins the same repository and receives it.
# Both end with the agent side wired (MCP tools and the safe-point hook from mcp/) so Claude Code
# can be opened in the work dir right away.
#
# Usage: demo/scripts/rehearse.sh A|B [work-dir] [--foreground]
#   work-dir defaults to ~/pitstop-A or ~/pitstop-B and is replaced. Keep it short: jj breaks under
#   long Windows paths (daemon/CLAUDE.md). --foreground keeps the daemon in this terminal (ctrl-c
#   stops it); by default it runs in the background and logs to <work-dir>/.pitstop/daemon.log.
#
# Environment:
#   PITSTOP_TOKEN      required. The server's shared token: the environment, or the pitstop repo's
#                      git-ignored .env. Never printed, never written anywhere but the work dir's
#                      .pitstop/config.json (which pitstop init writes, as the daemon expects).
#   PITSTOP_SERVER     the server; default the Azure one. A local in-memory server is
#                      PITSTOP_STORE=memory PITSTOP_TOKEN=<t> PORT=8097 npx tsx server/src/index.ts
#                      with PITSTOP_SERVER=http://127.0.0.1:8097.
#   PITSTOP_REPO       default teamdb/demo. The log is append-only, so a second take on the same
#                      server needs a fresh name (teamdb/take-2), the same on both laptops.
#   PITSTOP_DEVELOPER  default: the OS user name. The agent is agent-a or agent-b from the role.
#
# Conventions as in gate1.sh and gate4.sh: the daemon from daemon/dist, started with exec so the
# pid is node's. Never deploys, never runs az.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
azure="https://bravebay-485f06a6.swedencentral.azurecontainerapps.io"

role="${1:-}"
case "$role" in
  A | a) role=A; agent=agent-a ;;
  B | b) role=B; agent=agent-b ;;
  *) echo "usage: rehearse.sh A|B [work-dir] [--foreground]"; exit 2 ;;
esac
shift
foreground=0
work=""
for arg in "$@"; do
  case "$arg" in
    --foreground) foreground=1 ;;
    -*) echo "unknown option $arg"; exit 2 ;;
    *) work="$arg" ;;
  esac
done
work="${work:-$HOME/pitstop-$role}"
server="${PITSTOP_SERVER:-$azure}"
server="${server%/}"
repo="${PITSTOP_REPO:-teamdb/demo}"
developer="${PITSTOP_DEVELOPER:-${USER:-${USERNAME:-$(id -un)}}}"
daemon=(node "$root/daemon/dist/index.js")

# --- the token: environment first, then the repo-root .env; refuse without one ------------------
if [ -z "${PITSTOP_TOKEN:-}" ] && [ -f "$root/.env" ]; then
  PITSTOP_TOKEN="$(grep -E '^PITSTOP_TOKEN=' "$root/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
if [ -z "${PITSTOP_TOKEN:-}" ]; then
  echo "PITSTOP_TOKEN is not set and $root/.env has none: the server refuses every request without it."
  echo "Put it in .env (SETUP.md, \"Server token\") or export it, then run again."
  exit 1
fi
export PITSTOP_TOKEN

# --- tools: jj may be installed but not on PATH (winget puts it under WinGet/Packages) ------------
if ! command -v jj >/dev/null 2>&1; then
  for exe in "${LOCALAPPDATA:-}"/Microsoft/WinGet/Packages/jj-vcs.jj_*/jj.exe "$HOME"/.cargo/bin/jj; do
    if [ -x "$exe" ]; then
      export PATH="$(dirname "$exe"):$PATH"
      break
    fi
  done
fi
for tool in jj git node curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is not installed or not on PATH (jj: winget install jj-vcs.jj / brew install jj)"; exit 1; }
done
case "$work" in
  *" "*) echo "the work dir must not contain spaces: $work"; exit 1 ;;
esac
if [ "${#work}" -gt 60 ]; then
  echo "note: $work is ${#work} characters; jj fails under long Windows paths, keep it short (~/pitstop-$role)"
fi

# --- the server: up, and the token accepted --------------------------------------------------------
echo "== server $server"
health="$(curl -sf --max-time 10 "$server/healthz" 2>/dev/null || true)"
if [ -z "$health" ]; then
  echo "the server does not answer at $server/healthz."
  echo "Fallback (REHEARSAL.md): a local in-memory server on this laptop,"
  echo "  PITSTOP_STORE=memory PITSTOP_REPAIR=agent PITSTOP_TOKEN=\"\$PITSTOP_TOKEN\" PORT=8097 npx tsx server/src/index.ts"
  echo "then run again with PITSTOP_SERVER=http://127.0.0.1:8097 (the other laptop points at this one's address)."
  exit 1
fi
echo "   healthz: $health"
auth=(-H "authorization: Bearer $PITSTOP_TOKEN")
status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${auth[@]}" "$server/repos")"
if [ "$status" != "200" ]; then
  echo "the server answered $status to GET /repos with this token: PITSTOP_TOKEN is not the server's."
  exit 1
fi
echo "   token accepted"

# --- the repository must be at the start state: empty for A, the import alone for B ---------------
head="$(curl -s --max-time 10 "${auth[@]}" "$server/repos/$repo" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(typeof r.headLsn==="number"?r.headLsn:"none")}catch{console.log("none")}})')"
if [ "$head" = "none" ]; then
  echo "   $repo does not exist yet on this server"
else
  echo "   $repo is at #$head"
fi
limit=0
[ "$role" = "B" ] && limit=1
if [ "$head" != "none" ] && [ "$head" -gt "$limit" ]; then
  echo "$repo already has $head entries and the log is append-only: a daemon starting from the fresh slice"
  echo "would apply them all and leave this laptop at the end state, not the start."
  echo "Pick a fresh name for this take, the same on both laptops:"
  echo "  PITSTOP_REPO=teamdb/take-2 bash demo/scripts/rehearse.sh $role $work"
  exit 1
fi

# --- build what the daemon and the agent side run from ------------------------------------------
echo "== build the protocol, the daemon and the agent side"
(cd "$root" && npm run build:protocol >/dev/null && npm run build -w @pitstop/daemon >/dev/null && npm run build -w @pitstop/mcp >/dev/null)

# --- a fresh copy of the slice; the previous daemon there must die first ------------------------
if [ -f "$work/.pitstop/daemon.json" ]; then
  echo "== stopping the daemon from the last take"
  node -e 'try{process.kill(require(process.argv[1]).pid)}catch{}' "$work/.pitstop/daemon.json" || true
  sleep 1
fi
if [ -e "$work" ] && ! rm -rf "$work" 2>/dev/null; then
  echo "cannot replace $work: something still runs in it. Close Claude Code and any shell there, then run again."
  exit 1
fi
echo "== reset: $work from demo/teamdb (git + jj, dependencies, typecheck and tests)"
bash "$root/demo/scripts/reset.sh" "$work"

# The agent side's files are local configuration, not the slice: jj must not snapshot them into @,
# or the agent's first commit would carry them. .pitstop/ is in the slice's .gitignore already.
mkdir -p "$work/.git/info"
printf '%s\n' "# agent-side configuration written by demo/scripts/rehearse.sh" ".mcp.json" ".claude/" ".env" "CLAUDE.md" >>"$work/.git/info/exclude"

# House rules for the agent that works here, so the stage prompts can stay the scenario's own
# (demo/scenario.md). Claude Code reads CLAUDE.md from the directory it is opened in.
cat >"$work/CLAUDE.md" <<'EOF'
# TeamDB, a Pitstop worktree

Another agent is working on this same code on another laptop. A Pitstop daemon keeps this folder in
sync with the shared log and gives you the `pitstop` tools.

- Before you change anything, call the `declare_intent` tool: one line on what you will do, and the
  symbols you expect to touch as `path#name` (for example `src/auth/session.ts#getCurrentUser`).
- Check your work with `npx tsc -p tsconfig.json --noEmit` and `npx vitest run`.
- When both pass, commit with the `commit` tool (one line), unless you were told to wait for the
  word. Never run git or jj yourself.
- If the commit is rejected, do exactly what the rejection says: re-read the files it names (this
  folder already has them at head), adapt your change, check again, commit again.
- A note that starts with "Pitstop" tells you what landed here meanwhile. Act on it.
- Reuse what exists: `src/utils/timeAgo.ts` formats relative times.
EOF

# --- pitstop init: the server, the repository; A imports, B only joins ----------------------------
export PITSTOP_SERVER="$server" PITSTOP_REPO="$repo" PITSTOP_DEVELOPER="$developer" PITSTOP_AGENT="$agent"
export JJ_USER="${JJ_USER:-$developer}" JJ_EMAIL="${JJ_EMAIL:-$developer@pitstop.local}"
echo "== pitstop init as $agent ($developer)"
if [ "$role" = "A" ]; then
  (cd "$work" && "${daemon[@]}" init "$server" --repo "$repo")
else
  (cd "$work" && "${daemon[@]}" init "$server" --repo "$repo" --no-import)
fi

# --- the agent side: MCP tools and the safe-point hook into the worktree's Claude Code config -----
echo "== agent side: .mcp.json and .claude/settings.json"
node "$root/mcp/dist/setup.js" "$work" | grep -v '^Start '
cat >"$work/.env" <<EOF
# Written by demo/scripts/rehearse.sh. The daemon got these from its environment; a shell that runs
# the pitstop CLI here by hand gets them with:  set -a; . ./.env; set +a
# PITSTOP_TOKEN is not here on purpose: the CLI reads it from .pitstop/config.json.
PITSTOP_SERVER=$server
PITSTOP_REPO=$repo
PITSTOP_AGENT=$agent
PITSTOP_DEVELOPER=$developer
JJ_USER=$JJ_USER
JJ_EMAIL=$JJ_EMAIL
EOF
if [ -n "$(cd "$work" && jj diff --summary 2>/dev/null)" ]; then
  echo "jj sees changes in the fresh worktree; the agent's commit would carry them:"
  (cd "$work" && jj diff --summary)
  exit 1
fi

# --- the daemon ------------------------------------------------------------------------------------
if [ "$foreground" = "1" ]; then
  echo "== daemon for $agent in the foreground (ctrl-c stops it); open Claude Code in $work from another terminal"
  cd "$work"
  exec "${daemon[@]}" daemon
fi
log="$work/.pitstop/daemon.log"
echo "== daemon for $agent in the background, log $log"
(cd "$work" && exec "${daemon[@]}" daemon >"$log" 2>&1) &
wanted="watching"
[ "$role" = "B" ] && [ "$head" = "1" ] && wanted="applied #1"
for _ in $(seq 1 60); do
  grep -q "$wanted" "$log" 2>/dev/null && break
  grep -qE "stopped at|ECONNREFUSED|\] Error|unauthorized" "$log" 2>/dev/null && break
  sleep 0.5
done
if ! grep -q "$wanted" "$log" 2>/dev/null; then
  echo "the daemon did not reach '$wanted':"
  cat "$log"
  exit 1
fi
pid="$(node -e 'console.log(require(process.argv[1]).pid)' "$work/.pitstop/daemon.json")"
applied="$(node -e 'console.log(require(process.argv[1]).appliedLsn)' "$work/.pitstop/state.json" 2>/dev/null || echo 0)"

echo
echo "ready: laptop $role is $agent ($developer) in $work at #$applied, on $server ($repo)"
echo "  daemon: pid $pid, log $log"
echo "  stop it: node -e \"process.kill(require(process.argv[1]).pid)\" $work/.pitstop/daemon.json"
echo "  next: cd $work && claude      (the pitstop tools and the safe-point hook are configured there)"
echo "  live view: $server/#$(printf '%s' "$repo" | sed 's,/,%2F,g')"
