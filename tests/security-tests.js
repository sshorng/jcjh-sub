#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { resolvePublicFile } = require('../dev-server');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const gasApiSource = fs.readFileSync(path.join(root, 'gas-api.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const devServerSource = fs.readFileSync(path.join(root, 'dev-server.js'), 'utf8');
const invigilationSource = fs.readFileSync(path.join(root, 'export-invigilation.js'), 'utf8');
const printHelperSource = fs.readFileSync(path.join(root, 'print-helper.js'), 'utf8');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

assert.strictEqual(resolvePublicFile('/'), path.join(root, 'index.html'));
assert.strictEqual(resolvePublicFile('/app.js?v=security1'), path.join(root, 'app.js'));
assert.strictEqual(resolvePublicFile('/code.gs'), null);
assert.strictEqual(resolvePublicFile('/docs/A-%E7%B3%BB%E7%B5%B1%E4%BB%8B%E7%B4%B9.html'), null);
assert.strictEqual(resolvePublicFile('/templates/invigilation-template.xlsx'), path.join(root, 'templates', 'invigilation-template.xlsx'));
assert.strictEqual(resolvePublicFile('/templates/test_out.xlsx'), null);
assert.strictEqual(resolvePublicFile('/%2e%2e%2fcode.gs'), null);
assert.strictEqual(resolvePublicFile('/.git/config'), null);
assert.match(devServerSource, /googleusercontent\.com/);
assert.match(devServerSource, /accounts\.google\.com/);
assert.match(invigilationSource, /copySheetValuesAndStyles/);
assert.match(invigilationSource, /copySheetValuesAndStyles\(tempSheet, targetSheet, master\)/);
assert.match(invigilationSource, /mergeCellsWithoutStyle/);
assert.match(invigilationSource, /setCellFontPreservingStyle/);
assert.match(printHelperSource, /function escapePrintHtml/);
const printXssPayload = '<img src=x onerror="alert(1)"><script>alert(2)</script>&"';
const printContext = {
  window: {
    DateUtils: { getTimetablePeriods: () => [1] }
  }
};
vm.createContext(printContext);
vm.runInContext(printHelperSource, printContext, { filename: 'print-helper.js' });
const printFixtureContext = {
  getTeacherNameByEmail: () => printXssPayload,
  getTeacherSubjectByEmail: () => printXssPayload,
  getWeekDayText: day => ['日', '一', '二', '三', '四', '五', '六'][day] || '',
  allSchedules: { value: [] }
};
const printOutput = printContext.window.generateFormHtml({
  isExchange: false,
  serials: [printXssPayload],
  leaveEmails: ['leave@example.com'],
  subEmail: 'sub@example.com',
  reasons: [printXssPayload],
  subFee: printXssPayload,
  note: printXssPayload,
  periods: [{
    date: '2026-08-17',
    num: 1,
    cls: printXssPayload,
    sub: printXssPayload,
    leaveEmail: 'leave@example.com',
    reason: printXssPayload,
    subFee: printXssPayload
  }]
}, 'Admin', printFixtureContext);
const exchangeOutput = printContext.window.generateFormHtml({
  isExchange: true,
  serials: [printXssPayload],
  reason: printXssPayload,
  note: printXssPayload,
  records: [
    {
      originalTeacherEmail: 'teacher-a@example.com',
      actualTeacherEmail: 'teacher-b@example.com',
      date: '2026-08-17',
      period: 1,
      className: printXssPayload,
      subject: printXssPayload
    },
    {
      originalTeacherEmail: 'teacher-b@example.com',
      actualTeacherEmail: 'teacher-a@example.com',
      date: '2026-08-18',
      period: 2,
      className: printXssPayload,
      subject: printXssPayload
    }
  ]
}, 'Admin', printFixtureContext);
const routeOutput = printContext.window.buildExchangeRouteHtml({
  nameA: printXssPayload,
  nameB: printXssPayload,
  dateA: printXssPayload,
  dateB: printXssPayload,
  classA: printXssPayload,
  classB: printXssPayload,
  subjectA: printXssPayload,
  subjectB: printXssPayload
});
const executablePrintMarkup = /<(?:script|img)\b|<[^>]+\bon(?:error|load)\s*=/i;
assert.ok(printOutput.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
assert.ok(printOutput.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
assert.strictEqual(executablePrintMarkup.test(printOutput), false);
assert.strictEqual(executablePrintMarkup.test(exchangeOutput), false);
assert.strictEqual(executablePrintMarkup.test(routeOutput), false);
const vercelCsp = vercelConfig.headers[0].headers.find(h => h.key === 'Content-Security-Policy');
assert.ok(vercelCsp && vercelCsp.value.includes('googleusercontent.com'));
assert.match(gasApiSource, /AbortController/);
assert.match(gasApiSource, /ACTION_TIMEOUT_MS/);
assert.match(gasApiSource, /cancelAllInflight/);
assert.match(appSource, /const _dataLoadSeq|let _dataLoadSeq/);
assert.match(appSource, /const optimisticPatchRequestStatuses\s*=\s*\(updates\)/);
assert.match(appSource, /ensureExportAccounting/);
assert.strictEqual(/<script\s+defer\s+src=["']export-accounting\.js/i.test(indexSource), false);
assert.strictEqual(indexSource.includes('20260814-p2'), false);
assert.strictEqual(new Set(Array.from(indexSource.matchAll(/(?:src|href)="[^"]+\?v=([^"']+)/g), m => m[1])).size, 1);

const scriptProperties = {};
global.PropertiesService = {
  getScriptProperties() {
    return {
      getProperty(key) {
        return Object.prototype.hasOwnProperty.call(scriptProperties, key) ? scriptProperties[key] : null;
      }
    };
  }
};
const activeSpreadsheet = {};
let activeSpreadsheetCalls = 0;
global.SpreadsheetApp = {
  getActiveSpreadsheet() {
    activeSpreadsheetCalls += 1;
    return activeSpreadsheet;
  }
};
const cacheStore = new Map();
const cacheStats = { putAll: 0, getAll: 0, removeAll: 0 };
const fakeCache = {
  get(key) { return cacheStore.has(key) ? cacheStore.get(key) : null; },
  put(key, value) { cacheStore.set(key, String(value)); },
  getAll(keys) {
    cacheStats.getAll += 1;
    const out = {};
    keys.forEach(key => { if (cacheStore.has(key)) out[key] = cacheStore.get(key); });
    return out;
  },
  putAll(values) {
    cacheStats.putAll += 1;
    Object.keys(values).forEach(key => cacheStore.set(key, String(values[key])));
  },
  remove(key) { cacheStore.delete(key); },
  removeAll(keys) {
    cacheStats.removeAll += 1;
    keys.forEach(key => cacheStore.delete(key));
  }
};
global.CacheService = { getScriptCache() { return fakeCache; } };
vm.runInThisContext(fs.readFileSync(path.join(root, 'code.gs'), 'utf8'), { filename: 'code.gs' });

assert.strictEqual(getSpreadsheet(), activeSpreadsheet);
assert.strictEqual(getSpreadsheet(), activeSpreadsheet);
assert.strictEqual(activeSpreadsheetCalls, 1);
_requestSpreadsheet_ = null;
_requestSpreadsheetKey_ = '';
scriptProperties.DEPLOYMENT_ENV = 'production';
assert.throws(() => getSpreadsheet(), /找不到可用的試算表/);
scriptProperties.ALLOW_ACTIVE_SPREADSHEET_FALLBACK = 'true';
assert.strictEqual(getSpreadsheet(), activeSpreadsheet);
delete scriptProperties.ALLOW_ACTIVE_SPREADSHEET_FALLBACK;
delete scriptProperties.DEPLOYMENT_ENV;
_requestSpreadsheet_ = null;
_requestSpreadsheetKey_ = '';
assert.strictEqual(getSpreadsheet(), activeSpreadsheet);
assert.strictEqual(getActiveSpreadsheetFallbackDefault_(), 'true');
const generationBefore = getCacheGeneration_('data', '115-1');
assert.strictEqual(getCacheGeneration_('data', '115-1'), generationBefore);
const generationAfter = bumpCacheGeneration_('data', '115-1');
assert.notStrictEqual(generationAfter, generationBefore);
const generationBeforeInvalidation = getCacheGeneration_('data', '115-1');
invalidateRequestCaches_('115-1');
assert.notStrictEqual(getCacheGeneration_('data', '115-1'), generationBeforeInvalidation);
setScheduleImportState_('115-1', 'writing');
assert.strictEqual(getScheduleImportState_('115-1'), 'writing');
clearScheduleImportState_('115-1');
assert.strictEqual(getScheduleImportState_('115-1'), '');
const largeCacheValue = 'x'.repeat(180 * 1024);
putCacheChunked('security-cache', largeCacheValue, 60);
assert.strictEqual(getCacheChunked('security-cache'), largeCacheValue);
assert.ok(cacheStats.putAll > 0);
assert.ok(cacheStats.getAll > 0);
removeCacheChunkedMany_(['security-cache']);
assert.strictEqual(getCacheChunked('security-cache'), null);
assert.ok(cacheStats.removeAll > 0);
assert.strictEqual(resolveTeacherRole_('unknown@school.example', []), '');
assert.strictEqual(rowKeyForSheet_('教師名單', { '學期代號': '115-1', '教師Email': 'Teacher@School.Example' }, '教師Email'), '115-1|teacher@school.example');
assert.strictEqual(translateStatusToEn('已核准'), 'approved');
assert.throws(() => assertRequestState_({ '狀態': 'approved' }, 'adminApprove'), /無法執行/);
assert.strictEqual(escapeHtml_('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
assert.strictEqual(trustedSystemUrl_('https://attacker.example/phishing'), 'https://jcjh-sub.vercel.app/');

getTableData = function (sheetName) {
  if (sheetName === '學期設定') return [{ '學期代號': '115-1', '是否預設': 'TRUE' }];
  return [];
};
scanRequestsFromSheet_ = function () { return { allCount: 0, rows: [] }; };
getSemesterRequestsCached_('115-1', false, 15);
assert.ok(Array.from(cacheStore.keys()).some(key => /^jcjh_req_115-1_.*_w15/.test(key)));
setScheduleImportState_('115-1', 'writing');
assert.throws(() => getSemesterSchedulesCached_('115-1'), /課表匯入處理中/);
clearScheduleImportState_('115-1');
getSemesterSchedulesCached_ = function () {
  return [{ '課表ID': 'real-schedule', '教師Email': 'teacher@school.example', '教師姓名': '王老師', '星期': 1, '節次': 1, '班級': '701', '科目': '國文' }];
};
getSemesterTeachersCached_ = function () {
  return [{ '學期代號': '115-1', '教師Email': 'teacher@school.example', '教師姓名': '王老師', '授課科目': '國文' }];
};
getSemesterRequestsCached_ = function () {
  return { rows: [{ '學期代號': '115-1', '申請單ID': 'real-request', '狀態': 'approved', '申請人Email': 'leave@school.example', '申請人姓名': '李老師', '受邀人Email': 'teacher@school.example', '受邀人姓名': '王老師', '班級': '701', '科目': '國文', '異動日期': '2026-08-17', '異動星期': 1, '異動節次': 1, '異動類型': 'substitution' }] };
};
getSemesterClassAwayCached_ = function () { return []; };
const publicPayload = buildPublicClassPayload_('115-1', '701');
const publicJson = JSON.stringify(publicPayload);
assert.strictEqual(publicJson.includes('@'), false);
assert.strictEqual(publicJson.includes('real-request'), false);
assert.strictEqual(publicPayload.schedules[0]['教師Email'], undefined);

console.log('security tests PASS');
