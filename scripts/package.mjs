#!/usr/bin/env node
/**
 * Build the extension and package it as a VSIX.
 *
 * Usage:
 *   node scripts/package.mjs            # compile + package
 *   node scripts/package.mjs --skip-compile   # package only (assumes out/ is fresh)
 *
 * Steps:
 *   1. (Optional) npm run compile — build the TypeScript output into out/.
 *   2. Ensure the dist/ directory exists.
 *   3. Run `vsce package` writing the VSIX into dist/. vsce automatically uses
 *      the root README.md as the marketplace readme. We intentionally do NOT
 *      pass --readme-path with a custom file: vsce maps that file to
 *      extension/readme.md, which collides with the root README.md on
 *      case-insensitive paths and fails packaging.
 *   4. Print the generated artifact path.
 *
 * Cross-platform (Windows / macOS / Linux). Pure Node.js built-ins, no deps.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');

const skipCompile = process.argv.includes('--skip-compile');

function quote(arg) {
  return /^[a-zA-Z0-9_\-./\\:]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

function run(cmd, args, cwd) {
  console.log(`\n> ${[cmd, ...args].join(' ')}`);
  // On Windows, npm/npx are .cmd shims and must run through cmd.exe.
  // Passing a single command string (not an args array with shell:true)
  // avoids the DEP0190 security warning.
  if (process.platform === 'win32') {
    const commandLine = [cmd, ...args].map(quote).join(' ');
    return spawnSync('cmd.exe', ['/d', '/s', '/c', commandLine], { cwd, stdio: 'inherit' });
  }
  return spawnSync(cmd, args, { cwd, stdio: 'inherit' });
}

function readPackageJson() {
  return JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
}

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function main() {
  const pkg = readPackageJson();
  console.log(`Packaging ${pkg.name} v${pkg.version}`);

  // ---- 1. Compile (unless skipped) ----
  if (!skipCompile) {
    const compileResult = run('npm', ['run', 'compile'], ROOT);
    if (compileResult.status !== 0) {
      fail('Compilation failed — fix the errors above before packaging.');
    }
  } else {
    console.log('Skipping compile (--skip-compile).');
  }

  // ---- 2. Ensure dist/ exists ----
  mkdirSync(DIST, { recursive: true });

  // ---- 3. vsce package ----
  const packageResult = run('npx', ['vsce', 'package', '-o', DIST], ROOT);
  if (packageResult.status !== 0) {
    fail('vsce package failed — see output above.');
  }

  // ---- 4. Report artifacts ----
  const vsixFiles = readdirSync(DIST)
    .filter((name) => name.endsWith('.vsix'))
    .sort();

  if (vsixFiles.length === 0) {
    fail('Packaging reported success but no .vsix file was found in dist/.');
  }

  console.log('\n✔ Packaging complete. Artifacts:');
  for (const file of vsixFiles) {
    console.log(`  - ${resolve(DIST, file)}`);
  }
  console.log('\nInstall in VS Code via Extensions: Install from VSIX.');
}

main();
