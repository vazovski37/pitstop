#!/usr/bin/env bash
# Waits until the deployed server reports the expected version and a working database.
# Usage: infra/smoke.sh https://<fqdn> <git-sha>
set -euo pipefail

URL="${1:?base URL}"
SHA="${2:?expected version}"
TRIES="${TRIES:-30}"

for i in $(seq 1 "$TRIES"); do
  BODY="$(curl -fsS --max-time 5 "$URL/healthz" 2>/dev/null || true)"
  if echo "$BODY" | jq -e --arg sha "$SHA" '.version == $sha and .db == true' >/dev/null 2>&1; then
    echo "Healthy: $BODY"
    exit 0
  fi
  echo "Attempt $i/$TRIES: ${BODY:-no response}"
  sleep 10
done

echo "::error::$URL/healthz never reported version $SHA with a working database"
exit 1
