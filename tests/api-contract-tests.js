#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const storageMap = new Map();
const sessionStorage = {
  get length() { return storageMap.size; },
  key(index) { return Array.from(storageMap.keys())[index] || null; },
  getItem(key) { return storageMap.has(String(key)) ? storageMap.get(String(key)) : null; },
  setItem(key, value) { storageMap.set(String(key), String(value)); },
  removeItem(key) { storageMap.delete(String(key)); },
  clear() { storageMap.clear(); }
};

const calls = [];
const responses = [];
const validToken = [
  Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    email: 'teacher@school.example',
    hd: 'school.example',
    exp: Math.floor(Date.now() / 1000) + 3600
  })).toString('base64url'),
  'fixture-signature'
].join('.');

const context = {
  window: {
    location: { origin: 'http://localhost:8000', pathname: '/' },
    atob(value) { return Buffer.from(value, 'base64').toString('binary'); },
    FieldMap: { formatGasError(error) { return String(error && error.message || error); } }
  },
  sessionStorage,
  fetch: async function (url, options) {
    calls.push({ url, options });
    const fixture = responses.shift() || { status: 200, body: { success: true } };
    return {
      ok: fixture.status >= 200 && fixture.status < 300,
      status: fixture.status,
      statusText: fixture.statusText || '',
      json: async function () {
        if (fixture.parseError) throw new Error('invalid JSON');
        return fixture.body;
      }
    };
  },
  AbortController,
  clearInterval,
  clearTimeout,
  console,
  decodeURIComponent,
  encodeURIComponent,
  Error,
  Math,
  Promise,
  setInterval,
  setTimeout,
  Date,
  JSON,
  Object,
  String,
  Number,
  Array,
  RegExp,
  parseInt,
  isNaN
};

vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'gas-api.js'), 'utf8'), context, {
  filename: 'gas-api.js'
});

function createClient(apiUrl) {
  return context.window.GasApi.createClient({
    getApiUrl: function () { return apiUrl; },
    getSemesterId: function () { return '115-1'; },
    refreshIdToken: async function () { return validToken; },
    onAuthExpired: function () {},
    showToast: function () {}
  });
}

function lastPayload() {
  return JSON.parse(calls[calls.length - 1].options.body);
}

(async function run() {
  const client = createClient('https://gas.example.test/exec');
  responses.push({ status: 200, body: { success: true, public: true, schedules: [] } });
  const publicResult = await client.fetchPublicClassData({ className: '701', semesterId: '115-1' });
  assert.equal(publicResult.public, true);
  assert.equal(lastPayload().action, 'getPublicClassData');
  assert.equal(lastPayload().idToken, '');
  assert.deepEqual(lastPayload().data, { className: '701', class: '701' });
  assert.equal(calls[0].options.headers['Content-Type'], 'text/plain;charset=utf-8');

  sessionStorage.setItem('jcjh_google_id_token', validToken);
  responses.push({ status: 200, body: {
    success: true,
    semesters: [{ '學期代號': '115-1' }],
    teachers: [],
    settings: {}
  } });
  const metaResult = await client.fetchMetaData({ semesterId: '115-1' });
  assert.equal(metaResult.success, true);
  assert.equal(lastPayload().action, 'getMetaData');
  assert.equal(lastPayload().idToken, validToken);
  assert.ok(Array.from(storageMap.keys()).some(key => /_meta$/.test(key)));

  responses.push({ status: 200, body: {
    success: true,
    semesterId: '115-1',
    userRole: 'teacher',
    teachers: []
  } });
  await client.fetchMetaData({ semesterId: '115-1', force: true });
  assert.deepEqual(lastPayload().data, { scope: 'fresh' });

  const swrPrefix = 'jcjh_swr_' + context.window.GasApi.APP_VERSION + '_115-1';
  responses.push({ status: 200, body: {
    success: true,
    semesters: [{ '學期代號': '115-1' }],
    teachers: [],
    schedules: [],
    schoolSwaps: [{ '對調ID': 'swap-1', '事件名稱': '校慶補課' }],
    settings: {}
  } });
  const initialResult = await client.fetchInitialData({ force: true });
  assert.equal(initialResult.schoolSwaps[0]['對調ID'], 'swap-1');
  const structureCache = JSON.parse(storageMap.get(swrPrefix + '_structure'));
  assert.equal(structureCache.data.schoolSwaps[0]['事件名稱'], '校慶補課');

  sessionStorage.setItem(swrPrefix + '_requests', 'fixture');
  sessionStorage.setItem(swrPrefix, 'fixture');
  responses.push({ status: 200, body: { success: true } });
  await client.callGasApi('submitRequest', { request: { '申請單ID': 'req-1' } });
  assert.equal(lastPayload().action, 'submitRequest');
  assert.equal(storageMap.has(swrPrefix + '_requests'), false);
  assert.equal(storageMap.has(swrPrefix), false);
  assert.equal(Array.from(storageMap.keys()).some(key => /_meta$/.test(key)), true);

  const missingUrlClient = createClient('');
  await assert.rejects(
    missingUrlClient.fetchMetaData(),
    /主要資料庫 GAS API 網址尚未設定/
  );

  responses.push({ status: 503, statusText: 'Unavailable', body: { success: false } });
  await assert.rejects(client.fetchPendingOnly(), /網路連線失敗：HTTP 503/);

  responses.push({ status: 200, parseError: true });
  await assert.rejects(client.fetchPendingOnly(), /伺服器回應格式錯誤/);

  console.log('api contract tests PASS');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
