#!/usr/bin/env bash
#
# Loads agents/outsmart.json into a running harness.
#
# The agent definition - model, instructions, approval policy, disabled tools -
# is the core of Outsmart, and TrueForge keeps it in a per-instance SQLite
# database. Version-controlling it here means a fresh deployment can be brought
# up to a known state instead of being reconfigured by hand.
#
# Creates the agent, or replaces it if one with the same name already exists.
#
# Usage:  ./scripts/load-agent.sh [harness-url]
#
set -euo pipefail

HARNESS="${1:-http://localhost:8790}"
DEF="$(dirname "$(readlink -f "$0")")/../agents/outsmart.json"

if [[ ! -f "$DEF" ]]; then
  echo "Agent definition not found: $DEF" >&2
  exit 1
fi

NAME="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['name'])" "$DEF")"

existing="$(curl -fsS "${HARNESS}/api/v1/agents" \
  | python3 -c "
import json,sys
name=sys.argv[1]
for a in json.load(sys.stdin).get('data', []):
    if a.get('name') == name:
        print(a['id']); break
" "$NAME")"

if [[ -n "$existing" ]]; then
  echo "Replacing existing agent '${NAME}' (${existing})"
  curl -fsS -X PUT "${HARNESS}/api/v1/agents/${existing}" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
print(json.dumps({'manifest': d['manifest']}))
" "$DEF")" >/dev/null
else
  echo "Creating agent '${NAME}'"
  curl -fsS -X POST "${HARNESS}/api/v1/agents" \
    -H 'Content-Type: application/json' \
    -d @"$DEF" >/dev/null
fi

echo "Loaded. Model and connectors must already be configured in Settings."
