#!/usr/bin/env node
'use strict';

// Small install-time compatibility shim for the DAVE native binding.
//
// 1. @snazzah/davey's generated loader has a bug in its
//    NAPI_RS_NATIVE_LIBRARY_PATH branch: it assigns the binding but never
//    returns it, so the env override is silently ignored. Adding the return
//    lets the binding be loaded from a path the platform can actually dlopen.
// 2. On Android, native modules installed under shared storage cannot be
//    dlopen'ed at all, so the prebuilt binding is copied into the app-private
//    home directory. The voice service also does this at runtime as a fallback.
//
// Both steps are no-ops when they are not needed, and the script never fails
// the install.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function patchDaveyLoader() {
  const file = path.join(ROOT, 'node_modules', '@snazzah', 'davey', 'index.js');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const needle = 'nativeBinding = require(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);';
  const at = text.indexOf(needle);
  if (at < 0) return false;
  if (text.slice(at + needle.length, at + needle.length + 64).includes('return nativeBinding;')) {
    return false;
  }
  try {
    fs.writeFileSync(file, text.replace(needle, `${needle}\n      return nativeBinding;`));
    return true;
  } catch {
    return false;
  }
}

function androidBinding() {
  if (process.platform !== 'android') return null;
  const arm64 = process.arch === 'arm64';
  const pkg = arm64 ? '@snazzah/davey-android-arm64' : '@snazzah/davey-android-arm-eabi';
  const file = arm64 ? 'davey.android-arm64.node' : 'davey.android-arm-eabi.node';
  const source = path.join(ROOT, 'node_modules', ...pkg.split('/'), file);
  if (!fs.existsSync(source)) return null;
  const destination = path.join(os.homedir(), '.cache', 'kizzey', file);
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return destination;
  } catch {
    return null;
  }
}

const patched = patchDaveyLoader();
const copied = androidBinding();
if (patched) console.log('  @snazzah/davey loader patched for NAPI_RS_NATIVE_LIBRARY_PATH.');
if (copied) console.log(`  DAVE native binding copied to ${copied}.`);
