#!/usr/bin/env bash
#
# Registers this repository's skills with a running harness.
#
# TrueForge clones a skill from git at runtime and materialises it in the
# sandbox, so nothing needs copying to the host - but the instance has to know
# the skill exists. A fresh deployment that loads the agent without this ends
# up with an agent referencing a skill the harness has never heard of.
#
# Usage:  ./scripts/load-skills.sh [harness-url]
#
# Environment:
#   OUTSMART_REPO_URL  repository the harness should clone (default: origin)
#   OUTSMART_REPO_REF  git ref to pin (default: main)
#
set -euo pipefail

HARNESS="${1:-http://localhost:8790}"
ROOT="$(dirname "$(readlink -f "$0")")/.."
REF="${OUTSMART_REPO_REF:-main}"

if [[ -n "${OUTSMART_REPO_URL:-}" ]]; then
  URL="$OUTSMART_REPO_URL"
else
  # Normalise the origin remote to the https form the harness expects.
  URL="$(git -C "$ROOT" remote get-url origin)"
  URL="${URL%.git}"
  URL="${URL/git@github.com:/https://github.com/}"
fi

existing="$(curl -fsS "${HARNESS}/api/v1/settings/skills" \
  | python3 -c "import json,sys; print(' '.join(s['name'] for s in json.load(sys.stdin).get('data', [])))")"

shopt -s nullglob
for skill_md in "$ROOT"/skills/*/SKILL.md; do
  dir="$(dirname "$skill_md")"
  rel="skills/$(basename "$dir")"

  read -r name description < <(python3 - "$skill_md" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
block = re.match(r"^---\n(.*?)\n---\n", text, re.S)
if not block:
    raise SystemExit(f"{sys.argv[1]}: missing YAML frontmatter")
fields = dict(
    re.match(r"([A-Za-z_]+):\s*(.+)", line).groups()
    for line in block.group(1).splitlines()
    if re.match(r"([A-Za-z_]+):\s*(.+)", line)
)
if "name" not in fields or "description" not in fields:
    raise SystemExit(f"{sys.argv[1]}: frontmatter needs name and description")
print(fields["name"], fields["description"])
PY
)

  payload="$(python3 -c "
import json, sys
print(json.dumps({'manifest': {
    'type': 'git',
    'name': sys.argv[1],
    'url': sys.argv[2],
    'path': sys.argv[3],
    'ref': sys.argv[4],
    'description': sys.argv[5],
}}))" "$name" "$URL" "$rel" "$REF" "$description")"

  if [[ " $existing " == *" $name "* ]]; then
    echo "Updating skill '${name}' (${rel} @ ${REF})"
    curl -fsS -X PUT "${HARNESS}/api/v1/settings/skills" \
      -H 'Content-Type: application/json' -d "$payload" > /dev/null
  else
    echo "Registering skill '${name}' (${rel} @ ${REF})"
    curl -fsS -X POST "${HARNESS}/api/v1/settings/skills" \
      -H 'Content-Type: application/json' -d "$payload" > /dev/null
  fi
done

echo "Skills loaded from ${URL} @ ${REF}"
