---
name: npm-upgrade
description: Upgrade npm dependencies to resolve security advisories and repair what the upgrade breaks. Covers finding advisories in the resolved tree, fixing transitive packages, running the test suite, and verifying the result.
---

# Upgrading npm dependencies

## Find what is actually vulnerable

Advisories live in the **resolved tree**, not in `package.json`. A manifest
declares ranges: `^3.13.1` resolves to whatever the latest 3.x is today, which
is usually patched. Scanning the manifest finds nothing and proves nothing.

Resolve the tree first. This needs no network install and takes seconds:

```bash
npm install --package-lock-only
```

Then collect every `name@version` from `package-lock.json` by walking the
`packages` object. For each entry, the registry package name is the entry's
own `name` field when it has one, and only otherwise the segment after the
last `node_modules/` in its path:

```python
if meta.get("link") or "version" not in meta:
    continue                      # workspace / link placeholder, not a package
real_name = meta.get("name") or path.split("node_modules/")[-1]
```

Skip the root entry (empty path) and any entry with `link: true`. Those are
placeholders pointing at a local directory: npm records no version on them and
lists the link target separately, so there is nothing to query. Including them
produces either an invalid query or a versionless one that returns every
advisory for a name that is not really installed.

This matters for **aliased** dependencies. `"foo": "npm:bar@1.2.3"` installs
`bar` at the path `node_modules/foo`, and npm records the real name in the
entry's `name` field. Taking the name from the path alone queries `foo`,
which is a different package or none at all — so advisories affecting the
package that is actually installed are silently missed.

Expect several hundred entries for a small project; most vulnerabilities are
transitive and appear nowhere in the manifest.

## Query OSV correctly

Batch the queries. Never loop one request per package — hundreds of sequential
requests will exceed command timeouts. A few hundred packages go in a single
request comfortably; chunk very large trees into batches of a few hundred and
merge the results, so one oversized request cannot fail the whole scan.

```
POST https://api.osv.dev/v1/querybatch
{"queries": [{"package": {"name": "js-yaml", "ecosystem": "npm"}, "version": "3.13.1"}]}
```

`version` is a **sibling** of `package`, not a field inside it. Nested inside,
the API silently ignores it and returns every advisory ever filed for that
package — producing a huge false-positive count. If a result set looks
implausibly large, this is why. Cross-check one package against
`POST /v1/query` before trusting a batch.

Results come back in request order, and packages with no advisories return an
empty object `{}` — not a missing entry. Only a non-empty `vulns` array counts.

**Handle pagination or the scan is silently incomplete.** OSV paginates when a
single query returns more than 1,000 vulnerabilities, or the batch returns more
than 3,000 in total. Any result carrying a `next_page_token` has more to give.
Re-submit only those queries with their `page_token` set, omitting the ones
that finished, and merge each page into the result for that package. Ignoring
the token under-reports, which is the failure mode that matters here.

Fetch severity and fixed versions with `GET https://api.osv.dev/v1/vulns/{id}`,
and only for the advisories that matter.

## Choose the fix

Group by what the fix requires:

- **Patch or minor bump** — batch these into one change.
- **Major bump** — one change each. Majors break APIs and need repair.

For a **transitive** dependency there is no manifest line to edit. Prefer an
`overrides` entry:

```json
"overrides": { "braces": "3.0.3" }
```

Write into the **existing** `overrides` object if one is present. Appending a
second `"overrides"` block produces valid-looking JSON with a duplicate key —
parsers keep the last one and the earlier fix silently disappears. This
survives `git merge` without a conflict, so nothing will warn you.

Bumping the parent dependency is the alternative, but old parents often have no
release that pulls a fixed child.

## Verify

Establish a green baseline **before** changing anything. If the suite is
already red, stop and report — the target is unsuitable and any later green is
meaningless.

```bash
npm ci && npm test
```

`npm ci` requires a committed `package-lock.json`. Many libraries do not commit
one; generate it with `npm install --package-lock-only` first. This is normal,
not an error.

After the fix, re-run the suite and confirm the advisory is gone from the
resolved tree — a passing suite does not prove the vulnerability was fixed.

## Repair what breaks

Read the actual error. Node and its libraries usually name the fix:

```
Error: Function yaml.safeLoad is removed in js-yaml 4. Use yaml.load instead.
```

Fix **source** files. If a test must change because it calls a removed API,
say so explicitly and show that hunk in the diff. Never weaken or delete an
assertion to make a suite pass, and never write a custom test runner or
download packages by hand to work around a failing package manager.

Stop after three failed repair attempts and write a report explaining what
broke and what was tried. A report is a valid outcome; a false green is not.

## Verify the merged state, not the branch

When several fixes run in parallel, each branch can be green while the
combination is broken — duplicate `overrides` keys are the common case. Before
opening a pull request, rebase onto the current target, fold the change into
the existing structures, and re-run both the suite and the advisory check from
a clean checkout.
