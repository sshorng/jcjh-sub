#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'code.gs'), 'utf8');
const cacheStore = new Map();
let liveTeacherRows = [];

const fakeCache = {
  get(key) { return cacheStore.has(key) ? cacheStore.get(key) : null; },
  put(key, value) { cacheStore.set(key, String(value)); },
  getAll(keys) {
    const out = {};
    keys.forEach(key => {
      if (cacheStore.has(key)) out[key] = cacheStore.get(key);
    });
    return out;
  },
  putAll(values) {
    Object.keys(values).forEach(key => cacheStore.set(key, String(values[key])));
  },
  remove(key) { cacheStore.delete(key); },
  removeAll(keys) { keys.forEach(key => cacheStore.delete(key)); }
};

global.PropertiesService = {
  getScriptProperties() {
    return { getProperty() { return null; } };
  }
};
global.SpreadsheetApp = { getActiveSpreadsheet() { return {}; } };
global.CacheService = { getScriptCache() { return fakeCache; } };
global.ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput(content) {
    return {
      content: String(content),
      getContent() { return this.content; },
      setMimeType() { return this; }
    };
  }
};

vm.runInThisContext(source, { filename: 'code.gs' });

getTableData = function (sheetName) {
  if (sheetName === '教師名單') return liveTeacherRows;
  if (sheetName === '學期設定') {
    return [
      { '學期代號': '114-1', '是否預設': 'FALSE' },
      { '學期代號': '115-1', '是否預設': 'TRUE' }
    ];
  }
  return [];
};
buildSettingsMap_ = function () { return {}; };
verifyGoogleIdToken = function () { return { email: 'new.teacher@school.example' }; };
sanitizeTeacherRowsForReader_ = function (rows) { return rows; };
sanitizeSettingsForReader_ = function (settings) { return settings; };

liveTeacherRows = [
  { '學期代號': '115-1', '教師Email': 'old.teacher@school.example', '教師姓名': '舊教師', '系統角色': 'teacher' }
];
const firstRows = getSemesterTeachersCached_('115-1');
assert.equal(firstRows.length, 1);

liveTeacherRows = firstRows.concat([
  { '學期代號': '115-1', '教師Email': ' New.Teacher@School.Example ', '教師姓名': '新教師', '系統角色': 'teacher' }
]);
const staleRows = getSemesterTeachersCached_('115-1');
assert.equal(staleRows.length, 1, 'normal reads may use the short-lived roster cache');
const freshRows = getSemesterTeachersCached_('115-1', true);
assert.equal(freshRows.length, 2, 'forceFresh must bypass the roster cache');

const loginMeta = handleReadAction_({
  action: 'getMetaData',
  idToken: 'fixture-token',
  semesterId: '114-1',
  data: { scope: 'fresh' }
});
const loginPayload = JSON.parse(loginMeta.getContent());
assert.equal(loginPayload.success, true);
assert.equal(loginPayload.userRole, 'teacher');
assert.equal(loginPayload.semesterId, '115-1', 'login must recover from a stale client-side semester');
assert.equal(loginPayload.teachers.length, 2);

verifyGoogleIdToken = function () { return { email: 'outsider@school.example' }; };
cacheStore.clear();
const outsider = () => handleReadAction_({
  action: 'getMetaData',
  idToken: 'fixture-token',
  semesterId: '114-1',
  data: { scope: 'fresh' }
});
assert.throws(outsider, /不在目前學期教師名單/);

console.log('teacher login cache tests PASS');
