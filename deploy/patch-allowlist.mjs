#!/usr/bin/env node
/**
 * TrueForge 0.1.4 ships a sandbox egress allowlist containing only PyPI and
 * GitHub domains (`LOCAL_SANDBOX_ALLOWED_DOMAINS` in dist/main.js). Anything
 * else is refused by the sandbox proxy with a 403, which means `npm install`
 * cannot run inside the sandbox and osv.dev cannot be queried.
 *
 * Outsmart needs both, so this appends the domains it depends on.
 * Idempotent: re-running is a no-op. Keeps a .bak of the original.
 *
 * Usage: node deploy/patch-allowlist.mjs [installDir]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const installDir = process.argv[2] ?? process.cwd();
const target = join(installDir, 'node_modules/@truefoundry/trueforge/dist/main.js');

const ADDED = [
  'registry.npmjs.org',
  '*.npmjs.org',
  'registry.yarnpkg.com',
  '*.yarnpkg.com',
  'api.osv.dev',
  'osv.dev',
  '*.osv.dev',
];

if (!existsSync(target)) {
  console.error(`Not found: ${target}`);
  process.exit(1);
}

const source = readFileSync(target, 'utf8');
const missing = ADDED.filter((d) => !source.includes(`"${d}"`));

if (missing.length === 0) {
  console.log('allowlist: already patched');
  process.exit(0);
}

const anchor = '"*.githubusercontent.com"\n    ];';
if (!source.includes(anchor)) {
  console.error('allowlist: anchor not found - TrueForge internals changed, patch needs updating');
  process.exit(1);
}

const replacement = `"*.githubusercontent.com",\n      ${missing.map((d) => `"${d}"`).join(',\n      ')}\n    ];`;

if (!existsSync(`${target}.bak`)) copyFileSync(target, `${target}.bak`);
writeFileSync(target, source.replace(anchor, replacement), 'utf8');
console.log(`allowlist: added ${missing.length} domain(s)`);
