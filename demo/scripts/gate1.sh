#!/usr/bin/env bash
# The Phase 1 gate (build plan, "Phase by phase"): two worktrees of the demo slice stay identical
# through one local server. A imports the slice (entry #1), edits a file and commits (entry #2);
# B's daemon applies both; the two trees are compared.
#
# Usage: demo/scripts/gate1.sh [work-dir]
#   work-dir defaults to ~/pitstop-gate1 and is replaced. Keep it short: jj breaks under long
#   Windows paths (daemon/CLAUDE.md). Needs jj, git, node; starts a server on PITSTOP_GATE_PORT
#   (default 8097) with the in-memory store, and stops it at the end.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
work="${1:-$HOME/pitstop-gate1}"
port="${PITSTOP_GATE_PORT:-8097}"
server="http://127.0.0.1:$port"

command -v jj >/dev/null 2>&1 || { echo "jj is not installed (winget install jj-vcs.jj / brew install jj)"; exit 1; }
rm -rf "$work"
mkdir -p "$work"

echo "== build the protocol and the daemon"
(cd "$root" && npm run build:protocol >/dev/null && npm run build -w @pitstop/daemon >/dev/null)
daemon=(node "$root/daemon/dist/index.js")

echo "== server with the in-memory store on :$port"
cd "$root"
PITSTOP_STORE=memory PORT="$port" PITSTOP_VALIDATE=warn node "$root/node_modules/tsx/dist/cli.mjs" server/src/index.ts >"$work/server.log" 2>&1 &
server_pid=$!
daemon_b_pid=""
cleanup() {
  [ -n "$daemon_b_pid" ] && kill "$daemon_b_pid" 2>/dev/null || true
  kill "$server_pid" 2>/dev/null || true
  # Git Bash on Windows: make sure the listener is gone.
  if command -v taskkill >/dev/null 2>&1; then
    pid="$(netstat -ano 2>/dev/null | grep -E ":$port .*LISTENING" | awk '{print $5}' | head -1 || true)"
    [ -n "${pid:-}" ] && taskkill //PID "$pid" //F >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
for _ in $(seq 1 30); do curl -sf "$server/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$server/healthz" >/dev/null || { echo "the server did not start:"; cat "$work/server.log"; exit 1; }

export PITSTOP_SERVER="$server" PITSTOP_DEVELOPER=gate JJ_USER=gate JJ_EMAIL=gate@example.com

echo "== worktree A: a fresh copy of the slice, imported as entry #1"
bash "$root/demo/scripts/reset.sh" "$work/A" >/dev/null
cp -R "$work/A" "$work/B" # the same start state; B has applied nothing yet
(cd "$work/A" && PITSTOP_AGENT=gate-a "${daemon[@]}" import -m "import teamdb")

echo "== worktree B: its daemon catches up"
# exec, so the pid recorded is node's and the cleanup really stops it
(cd "$work/B" && PITSTOP_AGENT=gate-b exec "${daemon[@]}" daemon >"$work/daemon-b.log" 2>&1) &
daemon_b_pid=$!
for _ in $(seq 1 30); do grep -q "applied #1" "$work/daemon-b.log" 2>/dev/null && break; sleep 1; done
grep -q "applied #1" "$work/daemon-b.log" || { echo "B never applied #1:"; cat "$work/daemon-b.log"; exit 1; }

echo "== worktree A: an edit, committed as entry #2"
(cd "$work/A" && printf '\nexport const gate = "phase 1";\n' >>src/utils/timeAgo.ts && PITSTOP_AGENT=gate-a "${daemon[@]}" commit -m "gate: add a marker to timeAgo")

echo "== worktree B: waits for #2"
for _ in $(seq 1 30); do grep -q "applied #2" "$work/daemon-b.log" 2>/dev/null && break; sleep 1; done
grep -q "applied #2" "$work/daemon-b.log" || { echo "B never applied #2:"; cat "$work/daemon-b.log"; exit 1; }

echo "== the log"
curl -s "$server/log" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s))console.log(`  #${e.lsn} ${e.intent} (${e.files.length} files, ${e.writeSet.length} written, ${e.readSet.length} read)`)})'

echo "== compare A and B"
if diff -r --exclude=.git --exclude=.jj --exclude=.pitstop --exclude=node_modules "$work/A" "$work/B"; then
  echo "A and B are identical through the server: Phase 1 gate PASSED"
else
  echo "A and B differ: Phase 1 gate FAILED"
  exit 1
fi
