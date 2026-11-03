#!/usr/bin/env node
'use strict';

// Runs the browser-side Node test files in tests/ one by one. Each test is a
// standalone script that exits non-zero when a check fails.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const directory = __dirname;
const files = fs
  .readdirSync(directory)
  .filter((name) => name.endsWith('.js') && name !== 'run.js')
  .sort();

if (!files.length) {
  console.log('No JavaScript tests found.');
  process.exit(0);
}

let failed = 0;
for (const name of files) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(process.execPath, [path.join(directory, name)], {
    cwd: path.join(directory, '..'),
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failed += 1;
    console.log(`--- ${name} failed ---`);
  }
}

console.log(`\n${files.length - failed}/${files.length} test files passed.`);
process.exit(failed ? 1 : 0);
