#!/usr/bin/env node
'use strict';

// Checks the Node pull-and-run launcher without touching git or the network.
// A fake `npm` is placed first on PATH so nothing is actually installed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'kizzey-node-launcher-'));

const checks = [];
function check(condition, label, extra = '') {
  checks.push(Boolean(condition));
  if (condition) {
    console.log(`ok: ${label}`);
  } else {
    console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

function makeCheckout(name) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), '// stub\n');
  return dir;
}

// A fake npm that records its arguments, so the test never installs anything.
function makeFakeNpm(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const marker = path.join(binDir, 'npm-args.txt');
  fs.writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\necho "$@" > "${marker}"\nexit 0\n`, {
    mode: 0o755,
  });
  return marker;
}

function runLauncher(args, binDir) {
  const env = { ...process.env };
  if (binDir) env.PATH = `${binDir}${path.delimiter}${env.PATH || ''}`;
  return spawnSync(process.execPath, [path.join(ROOT, 'script_pull.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });
}

function main() {
  try {
    const binDir = path.join(WORK, 'bin');
    const marker = makeFakeNpm(binDir);
    const checkout = makeCheckout('checkout');

    // --update-only must still install, so an update job leaves a runnable tree.
    let result = runLauncher(['--no-pull', '--update-only', '--dir', checkout], binDir);
    check(result.status === 0, '--update-only exits cleanly', `${result.status} ${result.stderr}`);
    check(fs.existsSync(marker), '--update-only runs npm install');
    const recorded = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
    check(recorded.startsWith('install'), '--update-only invokes npm install', recorded);
    check(/Sources are ready/.test(result.stdout), '--update-only reports the checkout as ready', result.stdout);
    check(!/Starting:/.test(result.stdout), '--update-only does not start the server', result.stdout);

    // --no-install opts out of the npm step entirely.
    fs.rmSync(marker, { force: true });
    result = runLauncher(['--no-pull', '--update-only', '--no-install', '--dir', checkout], binDir);
    check(result.status === 0, '--no-install exits cleanly', `${result.status} ${result.stderr}`);
    check(!fs.existsSync(marker), '--no-install skips npm install');

    // A missing server.js still fails before any install work.
    const empty = path.join(WORK, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    fs.rmSync(marker, { force: true });
    result = runLauncher(['--no-pull', '--update-only', '--dir', empty], binDir);
    check(result.status === 1, 'a missing server.js fails clearly', String(result.status));
    check(!fs.existsSync(marker), 'a missing server.js is caught before install');

    // A non-git folder with a server.js is started as-is (no clone attempted).
    result = runLauncher(['--update-only', '--dir', checkout, '--repo', 'https://example.invalid/x'], binDir);
    check(result.status === 0, 'a non-git checkout is used as-is', `${result.status} ${result.stderr}`);
    check(/not a git checkout/.test(result.stdout), 'a non-git checkout is reported as-is', result.stdout);

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    check(readme.includes('--no-install'), 'README documents --no-install');

    console.log(`\n${checks.filter(Boolean).length}/${checks.length} Node launcher checks passed`);
    return checks.every(Boolean) ? 0 : 1;
  } finally {
    fs.rmSync(WORK, { recursive: true, force: true });
  }
}

process.exit(main());
