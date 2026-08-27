#!/usr/bin/env python3
"""Report npm packages in a lockfile that have known OSV advisories.

Usage:  python3 scan_lockfile.py [path/to/package-lock.json]

Prints one line per vulnerable package, then a summary. Exit status is 0 when
the scan completes, whether or not anything was found - a non-empty result is
data, not an error.
"""
import json
import sys
import urllib.request

OSV_BATCH = "https://api.osv.dev/v1/querybatch"
CHUNK = 300


def collect(lock):
    """Distinct (name, version) pairs actually installed, per the lockfile.

    Skips the root project (empty path), workspace/link placeholders (which
    carry `link: true` and no version), and anything without a version.
    Aliased entries record their real registry name in `name`; the path holds
    the alias, so the field wins when present.
    """
    found = set()
    for path, meta in (lock.get("packages") or {}).items():
        if not path or meta.get("link") or "version" not in meta:
            continue
        name = meta.get("name") or path.split("node_modules/")[-1]
        if name:
            found.add((name, meta["version"]))
    # lockfile v1 fallback
    for name, meta in (lock.get("dependencies") or {}).items():
        if isinstance(meta, dict) and "version" in meta:
            found.add((name, meta["version"]))
    return sorted(found)


def post(payload):
    req = urllib.request.Request(
        OSV_BATCH,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def query(pkgs):
    """Query OSV in chunks, following pagination until every query is done."""
    out = {}
    for i in range(0, len(pkgs), CHUNK):
        batch = pkgs[i:i + CHUNK]
        # `version` is a sibling of `package`. Nested inside, OSV ignores it
        # and returns every advisory ever filed for the package.
        pending = [
            {"package": {"name": n, "ecosystem": "npm"}, "version": v}
            for n, v in batch
        ]
        index = list(range(len(batch)))
        while pending:
            results = post({"queries": pending}).get("results", [])
            nxt, nxt_index = [], []
            for slot, res in zip(index, results):
                name, version = batch[slot]
                ids = [v["id"] for v in (res.get("vulns") or [])]
                if ids:
                    out.setdefault((name, version), []).extend(ids)
                token = res.get("next_page_token")
                if token:
                    q = dict(pending[index.index(slot)])
                    q["page_token"] = token
                    nxt.append(q)
                    nxt_index.append(slot)
            pending, index = nxt, nxt_index
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "package-lock.json"
    with open(path, encoding="utf-8") as fh:
        lock = json.load(fh)

    pkgs = collect(lock)
    vulnerable = query(pkgs)

    for (name, version), ids in sorted(vulnerable.items()):
        print(f"{name}@{version}  {', '.join(sorted(set(ids)))}")
    print(f"\nscanned {len(pkgs)} packages, {len(vulnerable)} vulnerable")


if __name__ == "__main__":
    main()
