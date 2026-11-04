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

    // A real (file://) remote: a new commit must be pulled on the next run.
    const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (gitVersion.status !== 0) {
      console.log('skip: git is not installed; the pull path is not exercised');
    } else {
      const runGit = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
      const origin = path.join(WORK, 'origin.git');
      const seed = path.join(WORK, 'seed');
      runGit(['init', '-q', '--bare', origin]);
      runGit(['clone', '-q', origin, seed]);
      const commit = (message) => {
        runGit(['add', '-A'], seed);
        runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message], seed);
      };
      fs.writeFileSync(path.join(seed, 'server.js'), '// v1\n');
      commit('v1');
      runGit(['branch', '-M', 'main'], seed);
      runGit(['push', '-q', 'origin', 'main'], seed);

      const pulled = path.join(WORK, 'pulled');
      const cloneUrl = `file://${origin}`;
      result = runLauncher(['--update-only', '--no-install', '--dir', pulled, '--repo', cloneUrl, '--branch', 'main'], binDir);
      check(result.status === 0 && fs.existsSync(path.join(pulled, 'server.js')), 'the launcher clones a fresh checkout', `${result.status} ${result.stderr}`);
      const firstHead = runGit(['rev-parse', 'HEAD'], pulled).stdout.trim();

      fs.writeFileSync(path.join(seed, 'server.js'), '// v2\n');
      commit('v2');
      runGit(['push', '-q', 'origin', 'main'], seed);

      result = runLauncher(['--update-only', '--no-install', '--dir', pulled, '--repo', cloneUrl, '--branch', 'main'], binDir);
      const secondHead = runGit(['rev-parse', 'HEAD'], pulled).stdout.trim();
      check(result.status === 0 && secondHead && secondHead !== firstHead, 'a new commit is pulled on the next run', `${result.status} ${result.stdout}`);
      check(/Updated to the latest sources/.test(result.stdout), 'a new commit is reported as pulled', result.stdout);
      check(fs.readFileSync(path.join(pulled, 'server.js'), 'utf8').includes('v2'), 'the checkout advances to the new commit', fs.readFileSync(path.join(pulled, 'server.js'), 'utf8'));

      result = runLauncher(['--update-only', '--no-install', '--dir', pulled, '--repo', cloneUrl, '--branch', 'main'], binDir);
      check(result.status === 0 && /Already up to date/.test(result.stdout), 'an unchanged checkout reports up to date', result.stdout);
    }

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    check(readme.includes('--no-install'), 'README documents --no-install');

    console.log(`\n${checks.filter(Boolean).length}/${checks.length} Node launcher checks passed`);
    return checks.every(Boolean) ? 0 : 1;
  } finally {
    fs.rmSync(WORK, { recursive: true, force: true });
  }
}

process.exit(main());
