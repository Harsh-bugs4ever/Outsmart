## How it works

1. Pulls real vulnerability advisories for the target repo
2. Spawns one worker per affected package
3. Each worker bumps, installs, and runs the test suite in an isolated sandbox
4. If tests break, the worker reads the failure and repairs it
5. Re-verifies from a clean checkout before opening anything
6. Opens a pull request — and stops. Merging is a human decision.

## Built with

- [TrueForge](https://trueforge.dev) — agent harness (MCP, sandbox, approval gates, subagents)
- Qodo — AI code review on every pull request in this repo