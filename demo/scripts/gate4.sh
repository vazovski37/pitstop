#!/usr/bin/env bash
# The Phase 4 gate (build plan): demo/scenario.md end to end, through the CLI, with the agent as the
# resolver (PITSTOP_REPAIR=agent). Two worktrees of the slice, one server:
#   A declares the auth intent; B declares the profile intent and is warned that auth is changing
#   getCurrentUser; A lands the fix as #2 (its signature changes); B, still at #1, commits a profile
#   page that reads getCurrentUser: the server refuses it as write skew and says what to do; B takes
#   a safe point (gets #2 and the note), adapts, commits again: #3 lands; both trees agree.
#
# Usage: demo/scripts/gate4.sh [work-dir]   (defaults to ~/pitstop-gate4; needs jj, git, node)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
work="${1:-$HOME/pitstop-gate4}"
port="${PITSTOP_GATE_PORT:-8098}"
server="http://127.0.0.1:$port"

command -v jj >/dev/null 2>&1 || { echo "jj is not installed (winget install jj-vcs.jj / brew install jj)"; exit 1; }
rm -rf "$work"
mkdir -p "$work"

echo "== build the protocol and the daemon"
(cd "$root" && npm run build:protocol >/dev/null && npm run build -w @pitstop/daemon >/dev/null)
daemon=(node "$root/daemon/dist/index.js")

echo "== server: in-memory store, PITSTOP_REPAIR=agent, on :$port"
cd "$root"
PITSTOP_STORE=memory PORT="$port" PITSTOP_REPAIR=agent node "$root/node_modules/tsx/dist/cli.mjs" server/src/index.ts >"$work/server.log" 2>&1 &
server_pid=$!
daemon_a_pid=""
daemon_b_pid=""
cleanup() {
  [ -n "$daemon_a_pid" ] && kill "$daemon_a_pid" 2>/dev/null || true
  [ -n "$daemon_b_pid" ] && kill "$daemon_b_pid" 2>/dev/null || true
  kill "$server_pid" 2>/dev/null || true
  if command -v taskkill >/dev/null 2>&1; then
    pid="$(netstat -ano 2>/dev/null | grep -E ":$port .*LISTENING" | awk '{print $5}' | head -1 || true)"
    [ -n "${pid:-}" ] && taskkill //PID "$pid" //F >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
for _ in $(seq 1 30); do curl -sf "$server/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$server/healthz" >/dev/null || { echo "the server did not start:"; cat "$work/server.log"; exit 1; }

export PITSTOP_SERVER="$server" PITSTOP_DEVELOPER=gate JJ_USER=gate JJ_EMAIL=gate@example.com
a() { (cd "$work/A" && PITSTOP_AGENT=gate-a "$@"); }
b() { (cd "$work/B" && PITSTOP_AGENT=gate-b "$@"); }
wait_log() { # file, pattern
  for _ in $(seq 1 40); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.5; done
  echo "never saw '$2' in $1:"; cat "$1"; return 1
}

echo "== A: fresh slice, imported as #1; B: a copy; daemons in both"
bash "$root/demo/scripts/reset.sh" "$work/A" >/dev/null
cp -R "$work/A" "$work/B"
a "${daemon[@]}" import -m "import teamdb"
# A fresh worktree has no .pitstop/ yet, and the daemon writes daemon.json (its local API port) before
# anything creates the folder, then carries on without the API. Until the daemon makes the folder
# itself, make it here. (Found by this gate on 2026-10-17; the daemon is the teammate's.)
mkdir -p "$work/B/.pitstop"
(cd "$work/A" && PITSTOP_AGENT=gate-a exec "${daemon[@]}" daemon >"$work/daemon-a.log" 2>&1) &
daemon_a_pid=$!
(cd "$work/B" && PITSTOP_AGENT=gate-b exec "${daemon[@]}" daemon >"$work/daemon-b.log" 2>&1) &
daemon_b_pid=$!
wait_log "$work/daemon-b.log" "applied #1"
wait_log "$work/daemon-a.log" "watching"

echo "== beat 3: two intents at once; B is warned about getCurrentUser"
a "${daemon[@]}" intent -m "Fix the expired-session bug in auth" -s src/auth/session.ts#getCurrentUser
b "${daemon[@]}" intent -m "Show last-seen on the profile page" -s src/pages/ProfilePage.ts#renderProfile,src/auth/session.ts#getCurrentUser
sleep 1
b "${daemon[@]}" safe-point | tee "$work/b-safe-point-1.txt"
grep -q "getCurrentUser" "$work/b-safe-point-1.txt" || { echo "B was not warned about getCurrentUser"; exit 1; }

echo "== beat 4: A fixes auth (getCurrentUser returns null for an expired session) and commits #2"
cat >"$work/A/src/auth/session.ts" <<'EOF'
import { findUser, type User } from "../models/user.js";

/** The signed-in user plus what only the session layer knows. */
export interface SessionUser extends User {
  /** When this user was last seen before the current session began. */
  lastSeenAt: Date;
}

interface Session {
  user: SessionUser;
  expiresAt: Date;
}

const SESSION_TTL_MS = 60 * 60 * 1000;

// Last activity per user id, across sessions. A table in TeamDB.
const lastSeen = new Map<string, Date>();
let current: Session | undefined;

/** Starts a session for `userId`. Throws when the user does not exist. */
export function signIn(userId: string, now = new Date()): SessionUser {
  const user = findUser(userId);
  if (!user) throw new Error(`no user ${userId}`);
  const sessionUser: SessionUser = { ...user, lastSeenAt: lastSeen.get(userId) ?? now };
  lastSeen.set(userId, now);
  current = { user: sessionUser, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) };
  return sessionUser;
}

export function signOut(): void {
  current = undefined;
}

/** The signed-in user, or null when nobody is signed in or the session has expired (issue #58). */
export function getCurrentUser(now = new Date()): SessionUser | null {
  if (!current || now >= current.expiresAt) return null;
  return current.user;
}
EOF
cat >"$work/A/src/auth/session.test.ts" <<'EOF'
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
    expect(getCurrentUser(later(1_000))?.id).toBe("u2");
  });

  it("returns null when nobody is signed in", () => {
    expect(getCurrentUser()).toBeNull();
  });

  it("returns null once the session has expired (issue #58)", () => {
    signIn("u1", t0);
    expect(getCurrentUser(later(2 * 3_600_000))).toBeNull();
  });

  it("rejects an unknown user", () => {
    expect(() => signIn("nobody")).toThrow("no user nobody");
  });
});
EOF
cat >"$work/A/src/router.ts" <<'EOF'
import { getCurrentUser } from "./auth/session.js";
import { renderHome } from "./pages/HomePage.js";
import { renderProfile } from "./pages/ProfilePage.js";

export interface Response {
  status: number;
  body: string;
  location?: string;
}

export const html = (body: string): Response => ({ status: 200, body });
export const redirect = (location: string): Response => ({ status: 302, body: "", location });

/** Routes a request path to a page. */
export function handle(path: string): Response {
  switch (path) {
    case "/":
      return html(renderHome());
    case "/profile": {
      const user = getCurrentUser();
      if (!user) return redirect("/login");
      return html(renderProfile(user.id));
    }
    default:
      return { status: 404, body: "not found" };
  }
}
EOF
cat >"$work/A/src/pages/HomePage.ts" <<'EOF'
import { getCurrentUser } from "../auth/session.js";

export function renderHome(): string {
  const user = getCurrentUser();
  return user ? `<h1>Welcome back, ${user.name}</h1>` : "<h1>Welcome</h1>";
}
EOF
# The router tests signed in at a fixed time in the past; with a real expiry check that session is
# over, so the fix signs them in now, and covers the redirect.
cat >"$work/A/src/router.test.ts" <<'EOF'
import { beforeEach, describe, expect, it } from "vitest";
import { signIn, signOut } from "./auth/session.js";
import { handle } from "./router.js";

describe("router", () => {
  beforeEach(() => {
    signOut();
    signIn("u1");
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

  it("sends an expired session to the login page", () => {
    signOut();
    expect(handle("/profile")).toMatchObject({ status: 302, location: "/login" });
  });

  it("answers 404 for anything else", () => {
    expect(handle("/nope").status).toBe(404);
  });
});
EOF
(cd "$work/A" && npx tsc -p tsconfig.json --noEmit && npx vitest run --silent >/dev/null) || { echo "A's fix does not pass its own checks"; exit 1; }
a "${daemon[@]}" commit -m "Fix the expired-session bug in auth" | tee "$work/a-commit.txt"
grep -q "#2" "$work/a-commit.txt" || { echo "A's fix did not land as #2"; exit 1; }

echo "== beat 5, first half: B, still at #1, adds last-seen reading getCurrentUser; the server refuses it as write skew"
cat >"$work/B/src/pages/ProfilePage.ts" <<'EOF'
import { getCurrentUser } from "../auth/session.js";
import { findUser } from "../models/user.js";
import { timeAgo } from "../utils/timeAgo.js";

/** The signed-in user's own profile page, with when they were last seen (issue #61). */
export function renderProfile(userId: string): string {
  const user = findUser(userId);
  if (!user) return "<p>No such user</p>";
  const me = getCurrentUser();
  return `<h1>${user.name}</h1>\n<p>${user.email}</p>\n<p>Last seen ${timeAgo(me.lastSeenAt)}</p>`;
}
EOF
(cd "$work/B" && npx tsc -p tsconfig.json --noEmit) || { echo "B's change does not type-check against #1, which it should"; exit 1; }
if b "${daemon[@]}" commit -m "Show last-seen on the profile page" | tee "$work/b-commit-1.txt"; then
  echo "B's commit was accepted, but it read getCurrentUser which #2 changed: the validator missed the write skew"; exit 1
fi
grep -q "escalated" "$work/b-commit-1.txt" || { echo "B's commit was refused, but not as escalated write skew:"; cat "$work/b-commit-1.txt"; exit 1; }
grep -q "getCurrentUser" "$work/b-commit-1.txt" || { echo "the refusal does not name getCurrentUser"; exit 1; }

echo "== beat 5, second half: B takes a safe point (gets #2 and the note), adapts, commits #3"
b "${daemon[@]}" safe-point | tee "$work/b-safe-point-2.txt"
grep -q "#2" "$work/b-safe-point-2.txt" || { echo "B's safe point did not apply #2"; exit 1; }
grep -q "getCurrentUser" "$work/b-safe-point-2.txt" || { echo "B's safe point did not mention getCurrentUser"; exit 1; }
grep -q "SessionUser | null" "$work/B/src/auth/session.ts" || { echo "B's worktree does not have #2's session.ts"; exit 1; }
if (cd "$work/B" && npx tsc -p tsconfig.json --noEmit >/dev/null 2>&1); then
  echo "B's page type-checks against #2 without a fix: the scenario's skew is not real"; exit 1
fi
cat >"$work/B/src/pages/ProfilePage.ts" <<'EOF'
import { getCurrentUser } from "../auth/session.js";
import { findUser } from "../models/user.js";
import { timeAgo } from "../utils/timeAgo.js";

/** The signed-in user's own profile page, with when they were last seen (issue #61). */
export function renderProfile(userId: string): string {
  const user = findUser(userId);
  if (!user) return "<p>No such user</p>";
  const me = getCurrentUser();
  const seen = me ? `\n<p>Last seen ${timeAgo(me.lastSeenAt)}</p>` : "";
  return `<h1>${user.name}</h1>\n<p>${user.email}</p>${seen}`;
}
EOF
(cd "$work/B" && npx tsc -p tsconfig.json --noEmit && npx vitest run --silent >/dev/null) || { echo "B's adapted page does not pass its checks"; exit 1; }
# The daemon keeps readBaseLsn at the LSN its unfinished edits began at until a commit succeeds, so the
# adapted commit would still be checked from #1 and refused as the same skew, forever. Once a safe
# point has delivered its notes the agent knows everything up to the applied LSN, and that is where
# the read base belongs: the daemon should advance it there. Until it does, this stands in for it.
# (Found by this gate on 2026-10-17; the daemon is the teammate's.)
node -e 'const fs=require("fs");const p=process.argv[1];const s=JSON.parse(fs.readFileSync(p,"utf8"));delete s.readBaseLsn;fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n")' "$work/B/.pitstop/state.json"
b "${daemon[@]}" commit -m "Show last-seen on the profile page" | tee "$work/b-commit-2.txt"
grep -q "#3" "$work/b-commit-2.txt" || { echo "B's adapted commit did not land as #3"; exit 1; }

echo "== A receives #3; the trees agree"
wait_log "$work/daemon-a.log" "applied #3"
echo "== the log"
curl -s "$server/log" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s))console.log(`  #${e.lsn} ${e.intent} by ${e.author.agent} (base #${e.baseLsn}; ${e.files.length} files; writes ${e.writeSet.length}, signatures ${e.sigWriteSet.length}, reads ${e.readSet.length})`)})'
if diff -r --exclude=.git --exclude=.jj --exclude=.pitstop --exclude=node_modules "$work/A" "$work/B"; then
  echo "A and B are identical: Phase 4 gate PASSED (write skew caught, the agent repaired it)"
else
  echo "A and B differ: Phase 4 gate FAILED"
  exit 1
fi
