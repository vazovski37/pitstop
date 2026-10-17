#!/usr/bin/env bash
# Makes a fresh copy of the TeamDB slice as its own git (and jj) repository, with dependencies
# installed and typecheck and tests green, so every rehearsal starts from the same state.
#
# Usage: demo/scripts/reset.sh <target-dir>      (the directory is replaced)
set -euo pipefail

src="$(cd "$(dirname "$0")/../teamdb" && pwd)"
dest="${1:?usage: reset.sh <target-dir>}"

rm -rf "$dest"
mkdir -p "$dest"
cp -R "$src"/. "$dest"
cd "$dest"
rm -rf node_modules .pitstop

npm install --silent --no-fund --no-audit
git init -q -b main
git add -A
git -c user.name=teamdb -c user.email=teamdb@example.com commit -q -m "TeamDB slice at the demo's start state"
if command -v jj >/dev/null 2>&1; then
  jj git init --colocate >/dev/null 2>&1 && echo "jj: colocated with git"
else
  echo "jj is not installed: git only (the daemon needs jj, see SETUP.md)"
fi

npx tsc -p tsconfig.json --noEmit
npx vitest run --silent >/dev/null
echo "ready: $dest (typecheck and tests green)"
