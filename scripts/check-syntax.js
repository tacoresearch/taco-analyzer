#!/usr/bin/env node
/**
 * Parse every JavaScript file in the project and report syntax errors.
 *
 * There is no build step and no type checker here, so nothing would otherwise
 * catch a typo in a file that only runs on a rare code path. `node --check`
 * parses a file without executing it, which is exactly what we want: importing
 * these modules for real would open the database and bind a port.
 *
 * Cheap enough to run on every deploy, and the installer does.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'data', 'coverage']);

/**
 * @param {string} directory
 * @returns {string[]}
 */
function collectJsFiles(directory) {
  /** @type {string[]} */
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Syntax-check one file.
 *
 * `node --check` decides script versus module the same way `node` itself does,
 * via the nearest package.json "type". That should already be "module" here, but
 * if a Node version disagrees and rejects an `import` statement, retry through a
 * temporary `.mjs` copy, where module parsing is unambiguous. That keeps this
 * check honest instead of reporting false failures on every file.
 *
 * @param {string} file
 * @returns {{ok: true} | {ok: false, message: string}}
 */
function checkFile(file) {
  const first = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (first.status === 0) return { ok: true };

  const stderr = `${first.stderr ?? ''}`;
  const looksLikeModuleConfusion =
    stderr.includes('Cannot use import statement outside a module') ||
    stderr.includes('Unexpected token \'export\'') ||
    stderr.includes('await is only valid');

  if (!looksLikeModuleConfusion) {
    return { ok: false, message: stderr.trim() || `exit ${first.status}` };
  }

  const temporary = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'taco-syntax-')),
    `${path.basename(file, '.js')}.mjs`,
  );
  try {
    fs.copyFileSync(file, temporary);
    const second = spawnSync(process.execPath, ['--check', temporary], {
      encoding: 'utf8',
    });
    if (second.status === 0) return { ok: true };
    return {
      ok: false,
      // Report the original path, not the temp copy, or the message is useless.
      message: `${second.stderr ?? ''}`.replaceAll(temporary, file).trim(),
    };
  } finally {
    fs.rmSync(path.dirname(temporary), { recursive: true, force: true });
  }
}

const files = collectJsFiles(ROOT).sort();
/** @type {Array<{file: string, message: string}>} */
const failures = [];

for (const file of files) {
  const result = checkFile(file);
  if (!result.ok) {
    failures.push({ file: path.relative(ROOT, file), message: result.message });
  }
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} file(s) failed to parse:\n\n`);
  for (const failure of failures) {
    process.stderr.write(`  ${failure.file}\n${failure.message}\n\n`);
  }
  process.exit(1);
}

process.stdout.write(`Parsed ${files.length} JavaScript files with no syntax errors.\n`);
