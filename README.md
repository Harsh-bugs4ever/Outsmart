# Outsmart

Upgrades your dependencies and fixes what the upgrade breaks.

Dependabot opens the PR and walks away. Outsmart stays until the tests are green.

## What it does

Point it at a repo. It pulls real advisories, spawns one worker per vulnerable
package, and each worker bumps the version, runs the test suite in a sandbox,
and repairs whatever the upgrade broke. Only green branches become pull requests.

Merging stays a human decision.

