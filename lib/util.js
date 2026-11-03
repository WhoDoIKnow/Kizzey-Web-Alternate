'use strict';

const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function mono() {
  return Number(process.hrtime.bigint() / 1000000n) / 1000;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function readDeviceInfo() {
  function prop(name) {
    try {
      return execFileSync('getprop', [name], { timeout: 2000 }).toString().trim();
    } catch {
      return '';
    }
  }
  const manufacturer = prop('ro.product.manufacturer');
  const model = prop('ro.product.model');
  const device = prop('ro.product.device');
  const android = prop('ro.build.version.release');
  const sdk = prop('ro.build.version.sdk');
  let battery = null;
  for (const file of [
    '/sys/class/power_supply/battery/capacity',
    '/sys/class/power_supply/bms/capacity',
  ]) {
    try {
      battery = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
      break;
    } catch {
      // keep looking
    }
  }
  return {
    platform: process.platform,
    python: '',
    node: process.version,
    machine: os.machine ? os.machine() : os.arch(),
    hostname: os.hostname(),
    nodeName: os.hostname(),
    manufacturer: manufacturer || os.arch(),
    model: model || os.hostname(),
    device,
    android,
    sdk,
    is_samsung: (manufacturer + model).toLowerCase().includes('samsung'),
    battery,
  };
}

function cleanDiscordToken(token) {
  let value = String(token || '').trim();
  if (value.toLowerCase().startsWith('bearer ')) value = value.slice(7).trim();
  return value;
}

function tokenSafeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function uuidHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function nonnegInt(value, fallback = 0, cap = 1000000000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(cap, Math.floor(n));
}

function safeInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function parseTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return asNumber < 1e12 ? Math.trunc(asNumber * 1000) : Math.trunc(asNumber);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeText(value, maxLen = 128) {
  if (value == null) return null;
  const text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (!text) return null;
  return text.slice(0, maxLen);
}

function sanitizeLabel(value) {
  let cleaned = String(value || '').replace(/[^A-Za-z0-9 _.-]+/g, '').trim();
  cleaned = cleaned.replace(/\s+/g, '_');
  return cleaned.slice(0, 48) || 'user';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deepMerge(dst, src, depth = 0) {
  if (depth > 8 || !isPlainObject(dst) || !isPlainObject(src)) return dst;
  for (const [key, value] of Object.entries(src)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (isPlainObject(value) && isPlainObject(dst[key])) {
      deepMerge(dst[key], value, depth + 1);
    } else {
      dst[key] = deepClone(value);
    }
  }
  return dst;
}

module.exports = {
  nowMs,
  nowIso,
  mono,
  clamp,
  sleep,
  getLocalIp,
  readDeviceInfo,
  cleanDiscordToken,
  tokenSafeEqual,
  uuidHex,
  randomHex,
  nonnegInt,
  safeInt,
  parseTimestamp,
  sanitizeText,
  sanitizeLabel,
  isPlainObject,
  deepClone,
  deepMerge,
  dns,
  path,
};