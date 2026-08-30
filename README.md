# Outsmart

Upgrades your dependencies and fixes what the upgrade breaks.

Dependabot opens the PR and walks away. Outsmart stays until the tests are green.

---

## The problem

A security advisory lands on a package three levels deep in your tree. The fix
is a major version bump. The bump breaks your build. Now it's your afternoon.

Detection is solved — Dependabot, `npm audit` and OSV all find the advisory.
**Repair is not.** The differentiator here is that Outsmart runs the tests,
reads the failure, patches the source, and re-verifies before it asks you for
anything.

## The flow

```mermaid
flowchart TD
    A[Target repository] --> B[Resolve the lockfile<br/>not the manifest]
    B --> C[Scan every package<br/>against OSV.dev]
    C --> D{Advisories?}
    D -->|none| E[Report: clean]
    D -->|yes| F[Plan by semver<br/>batch minor · split major]
    F --> G[One subagent per advisory<br/>own branch · own sandbox]
    G --> H[Bump · install · test<br/>read failures and patch the source<br/>up to 3 attempts]
    H -->|still failing| L[Write a report<br/>not a pull request]
    H -->|green| M[Re-verify from a clean checkout<br/>of the MERGED state]
    M -->|fails| L
    M -->|green| O[Open a pull request]
    O --> P[/Human approval gate/]
    P --> R[Merge — human only<br/>the agent has no merge tool]

    style P fill:#a855f7,stroke:#7e22ce,color:#fff
    style L fill:#f59e0b,stroke:#b45309,color:#000
    style R fill:#22c55e,stroke:#15803d,color:#000
```

Two steps in that diagram are the ones that matter, and both are about not
trusting the agent: the **retry cap** (a report is a valid outcome, a false
green is not) and the **re-verify against the merged state**, explained below.

## How it works

1. **Resolve the real tree.** Advisories live in the lockfile, not the
   manifest — `^3.13.1` resolves to a patched version and finds nothing.
   Outsmart resolves the tree and scans every package in it, including
   transitive ones, against OSV.dev.
2. **Plan by semver.** Patch and minor fixes batch into one change; every major
   gets its own, because majors break APIs.
3. **Fan out.** One subagent per advisory, each on its own branch in its own
   sandbox.
4. **Repair.** Bump, install, run the suite. If it breaks, read the actual
   error and fix the source. After three failed attempts the worker stops and
   writes a report — a report is a valid outcome, a false green is not.
5. **Re-verify from clean.** The worker's claim of success is discarded. The
   suite and the advisory scan are re-run from a fresh checkout of what `main`
   will look like *after* the merge.
6. **Stop.** A pull request is opened and the agent waits. It cannot merge —
   `merge_pull_request` is not in its toolset.

### Why "after the merge" and not "on the branch"

Three subagents each produced a green branch. Git merged two of them with no
conflict, and the result had two `"overrides"` keys in `package.json`. JSON
keeps the last one, so a HIGH-severity fix silently disappeared — with passing
tests and a clean diff.

Three correct agents, one wrong result. No per-branch check can catch that,
which is why verification runs against the merged state.

## Best Use of TrueForge — where each capability is exercised

The track names six things. Here is where each one lives, so you can check
rather than take my word for it.

| Capability | Where | Verify it |
|---|---|---|
| **MCP** | GitHub connector: reads manifests, forks, creates branches, opens PRs | `agents/outsmart.json` → `mcp_servers` |
| **Sandbox** | every install, test run and repair executes in a bubblewrap sandbox; model and MCP credentials never enter it | `config.sandbox.enabled` |
| **Approval gate** | writes pause for a human, and `merge_pull_request` is removed from the agent's toolset entirely | `require_approval_for_tools`, `disable_tools` |
| **Subagents** | one worker per advisory, running in parallel on isolated branches | `config.dynamic_sub_agents` |
| **Session durability** | runs continue server-side with no client attached — close the browser mid-run and reopen | the reconnect clip in the demo |
| **Skills** | `skills/npm-upgrade` ships a *tested scanner*, cloned into the sandbox only when the model finds it relevant | `skills/npm-upgrade/scripts/scan_lockfile.py` |

The agent isn't asked politely not to merge. **The tool is not there** — 43 of
GitHub's 44 MCP tools are enabled, and `merge_pull_request` is the exception.

## Quick start

Requires a Linux host (or WSL2) with Node 22+. The sandbox uses bubblewrap,
which needs unprivileged user namespaces — managed container platforms block
these, so a real VM is required.

```bash
git clone https://github.com/Harsh-bugs4ever/Outsmart.git
cd Outsmart
sudo ./deploy/setup.sh          # host deps, TrueForge, sandbox allowlist patch
```

Start the harness, then configure a model provider and the GitHub connector in
Settings, and load this repo's agent and skills:

```bash
./scripts/load-skills.sh
./scripts/load-agent.sh
```

The queue board runs as its own process:

```bash
node ui/server.mjs --port 8791
```

Full deployment instructions, including TLS and authentication, are in
[`deploy/README.md`](deploy/README.md).

## The queue board

One row per run: **queued · running · fixing · awaiting approval · done ·
failed**. State is derived from the harness event stream rather than a status
field, because the harness doesn't have one — so the board reports what a run
actually did.

Approve and reject post a real `user.tool_approval` turn input. The buttons
drive the gate; they are not a mock.

## Repository layout

```
agents/outsmart.json        the agent: model, instructions, approval policy, disabled tools
skills/npm-upgrade/         Skill: how to upgrade npm deps, plus a tested lockfile scanner
ui/                         queue board and its same-origin API proxy
deploy/                     provisioning, systemd unit, Caddy config, allowlist patch
scripts/                    load the agent and skills into a running harness
```

## Limitations

Stated plainly, because they affect anyone who runs this.

- **Single tenant.** There are no user accounts. Credentials belong to whoever
  deploys it, and anyone who reaches the instance acts as them. Run your own;
  don't share one. TrueForge's OIDC login only works in hosted mode, and hosted
  mode disables the local sandbox — the two are mutually exclusive.
- **The harness has no authentication.** It must stay on loopback with Caddy in
  front. Never expose port 8790.
- **GitHub access is a classic PAT scoped to `public_repo`**, so the agent
  cannot reach private repositories. Forking requires a classic token;
  fine-grained tokens cannot fork repos you don't own.
- **Commits pushed via the GitHub API are authored by the token account**, not
  the agent identity, because the sandbox holds no git credentials.
- **npm only.** pip and cargo skills are the obvious next step and are not
  written.
- **`fixing` is a heuristic** over the event stream; the harness has no such
  state.

## Notes on the harness

Two patches to TrueForge 0.1.4 are applied by `deploy/setup.sh`, both reported
upstream:

- The sandbox egress allowlist ships with PyPI and GitHub but **not npm**, so
  `npm install` returns 403 inside the sandbox — fatal for a tool that upgrades
  npm packages. `deploy/patch-allowlist.mjs` adds the npm registry and osv.dev.
- On Linux the sandbox proxy socket lands outside the paths bind-mounted into
  the sandbox, so every sandbox init fails during its bootstrap. Running with
  `TMPDIR=/tmp/claude` works around it.

## Built with

- [TrueForge](https://trueforge.dev) — the agent harness
- [OSV.dev](https://osv.dev) — vulnerability data
- Qodo — AI code review on every pull request in this repo
