#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const semesterId = '115-1';
const ADMIN_EMAIL = 'admin@school.example';
const STAFF_EMAIL = 'staff@school.example';
const TEACHER_EMAIL = 'teacher@school.example';
const OWNER_EMAIL = 'owner@school.example';
const INVITEE_EMAIL = 'invitee@school.example';
const OUTSIDER_EMAIL = 'outsider@school.example';

const teachers = [
  { '學期代號': semesterId, '教師Email': ADMIN_EMAIL, '教師姓名': '管理員', '系統角色': 'admin' },
  { '學期代號': semesterId, '教師Email': STAFF_EMAIL, '教師姓名': '行政', '系統角色': 'staff' },
  { '學期代號': semesterId, '教師Email': TEACHER_EMAIL, '教師姓名': '教師', '系統角色': 'teacher' },
  { '學期代號': semesterId, '教師Email': OWNER_EMAIL, '教師姓名': '申請人', '系統角色': 'teacher' },
  { '學期代號': semesterId, '教師Email': INVITEE_EMAIL, '教師姓名': '受邀人', '系統角色': 'teacher' }
];

let activeEmail = TEACHER_EMAIL;
let proxyAllowed = false;
let lockAcquires = 0;
let mutationCalls = 0;
let persistedRows = [];
let requestRow = {
  '學期代號': semesterId,
  '申請單ID': 'req-permission-1',
  '申請人Email': OWNER_EMAIL,
  '受邀人Email': INVITEE_EMAIL,
  '狀態': 'pending_teacher'
};

const cacheStore = new Map();
const fakeCache = {
  get(key) { return cacheStore.has(key) ? cacheStore.get(key) : null; },
  put(key, value) { cacheStore.set(key, String(value)); },
  getAll(keys) {
    const out = {};
    keys.forEach(key => { if (cacheStore.has(key)) out[key] = cacheStore.get(key); });
    return out;
  },
  putAll(values) { Object.keys(values).forEach(key => cacheStore.set(key, String(values[key]))); },
  remove(key) { cacheStore.delete(key); },
  removeAll(keys) { keys.forEach(key => cacheStore.delete(key)); }
};

global.PropertiesService = {
  getScriptProperties() {
    return {
      getProperty() { return null; },
      getProperties() { return {}; },
      setProperty() {}
    };
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
global.LockService = {
  getScriptLock() {
    return {
      waitLock() { lockAcquires += 1; },
      releaseLock() {}
    };
  }
};

vm.runInThisContext(fs.readFileSync(path.join(root, 'code.gs'), 'utf8'), { filename: 'code.gs' });

// Replace external services and data access with deterministic fixtures.
resetRequestContext_ = function () {};
ensureInit_ = function () {};
verifyGoogleIdToken = function () { return { email: activeEmail }; };
getSemesterTeachersCached_ = function () { return teachers; };
resolveIsAdmin_ = function (email) { return String(email).toLowerCase() === ADMIN_EMAIL; };
resolveIsStaff_ = function (email) { return String(email).toLowerCase() === STAFF_EMAIL; };
canUserProxySubmit_ = function (email) { return proxyAllowed && String(email).toLowerCase() === STAFF_EMAIL; };
beginDeferredMails_ = function () {};
flushDeferredMails_ = function () {};
queueMail_ = function () {};
assertNotTooFrequent_ = function () {};
saveRows = function () { mutationCalls += 1; };
invalidateScheduleCaches_ = function () {};
invalidateSemesterCaches_ = function () {};
syncHomeroomRecordForRequest_ = function () {};
restoreMutualQuotaForRequests_ = function () {};
persistRequestRowsWithQuota_ = function (rows) {
  persistedRows = rows.map(row => Object.assign({}, row));
};
findSemesterTeacher_ = function (sid, email) {
  return String(sid) === semesterId
    ? teachers.find(t => String(t['教師Email']).toLowerCase() === String(email).toLowerCase())
    : null;
};
validateRequestRow_ = function () {};
assertNewRequestId_ = function () { return null; };
assertRequestState_ = function () {};
findRowByKey_ = function (sheet, key, id, sid) {
  if (sheet !== '申請單' || key !== '申請單ID' || String(sid) !== semesterId) return null;
  return String(id) === String(requestRow['申請單ID']) ? requestRow : null;
};
buildSettingsMap_ = function () { return {}; };
sanitizeTeacherRowsForReader_ = function (rows) { return rows; };
sanitizeSettingsForReader_ = function (settings) { return settings; };
getTableData = function () { return []; };
getCacheChunked = function () { return null; };
putCacheChunked = function () {};
assertPublicClassRateLimit_ = function () {};
buildPublicClassPayload_ = function () { return { success: true, public: true }; };
rememberPublicCacheKey_ = function () {};

function invoke({ email, action, data = {}, sid = semesterId }) {
  activeEmail = email;
  const output = doPost({
    postData: {
      contents: JSON.stringify({
        action,
        idToken: 'fixture-token',
        semesterId: sid,
        data
      })
    }
  });
  return JSON.parse(output.getContent());
}

function resetMutationState() {
  lockAcquires = 0;
  mutationCalls = 0;
  persistedRows = [];
}

function makeRequest(overrides = {}) {
  return Object.assign({
    '申請單ID': 'req-permission-' + Date.now(),
    '申請人Email': OWNER_EMAIL,
    '受邀人Email': INVITEE_EMAIL,
    '申請人姓名': '申請人',
    '受邀人姓名': '受邀人',
    '班級': '701',
    '科目': '國文',
    '異動日期': '2026-08-17',
    '異動星期': 1,
    '異動節次': 1,
    '異動類型': 'substitution',
    '經費來源': '自費代課'
  }, overrides);
}

const adminOnlyActions = [
  'saveSemester', 'deleteSemester', 'setDefaultSemester',
  'saveClassAwayEvent', 'deleteClassAwayEvent',
  'saveSchoolSwap', 'deleteSchoolSwap',
  'saveTeacher', 'deleteTeacher', 'importTeachersBatch', 'updateMutualQuotas',
  'earnMutualQuotaFromActivity', 'saveScheduleCell', 'clearScheduleCell',
  'importSchedulesBatch', 'adminApprove', 'adminReject', 'adminApproveBatch',
  'adminRejectBatch', 'saveHomeroomCoverTeacher', 'deleteSubstitutionRecord',
  'saveHistoryEdit', 'batchMarkPrinted', 'saveMailSettings', 'sendBatchNotices',
  'migrateNameKeySchema', 'renameTeacherNameKey'
];

for (const [email, label] of [[STAFF_EMAIL, 'staff'], [TEACHER_EMAIL, 'teacher']]) {
  for (const action of adminOnlyActions) {
    resetMutationState();
    const result = invoke({ email, action });
    assert.strictEqual(result.success, false, `${label} must be denied: ${action}`);
    assert.match(result.error, /權限不足|僅限教學組管理員/, `${label} error: ${action}`);
    assert.strictEqual(lockAcquires, 0, `${action} acquired a write lock before authorization`);
    assert.strictEqual(mutationCalls, 0, `${action} mutated data before authorization`);
  }
}

resetMutationState();
const adminSave = invoke({
  email: ADMIN_EMAIL,
  action: 'saveTeacher',
  data: { '教師Email': 'new-teacher@school.example', '教師姓名': '新教師' }
});
assert.strictEqual(adminSave.success, true);
assert.strictEqual(mutationCalls, 1, 'admin action did not reach its write path');
assert.ok(lockAcquires > 0, 'authorized admin action did not acquire the write lock');

const outsiderRead = invoke({ email: OUTSIDER_EMAIL, action: 'getMetaData' });
assert.strictEqual(outsiderRead.success, false);
assert.match(outsiderRead.error, /不在目前學期教師名單/);
const teacherRead = invoke({ email: TEACHER_EMAIL, action: 'getMetaData' });
assert.strictEqual(teacherRead.success, true);
const publicRead = invoke({ email: OUTSIDER_EMAIL, action: 'getPublicClassData', data: { className: '701' } });
assert.strictEqual(publicRead.success, true);
assert.strictEqual(publicRead.public, true);

proxyAllowed = false;
resetMutationState();
const unauthorizedStaffProxy = invoke({
  email: STAFF_EMAIL,
  action: 'submitRequest',
  data: { request: makeRequest() }
});
assert.strictEqual(unauthorizedStaffProxy.success, false);
assert.match(unauthorizedStaffProxy.error, /尚未被教學組授權代申請/);
assert.strictEqual(persistedRows.length, 0);

proxyAllowed = true;
resetMutationState();
const authorizedStaffProxy = invoke({
  email: STAFF_EMAIL,
  action: 'submitRequest',
  data: { request: makeRequest() }
});
assert.strictEqual(authorizedStaffProxy.success, true);
assert.strictEqual(persistedRows[0]['狀態'], 'pending_admin');
assert.strictEqual(persistedRows[0]['代申請人Email'], STAFF_EMAIL);

proxyAllowed = false;
resetMutationState();
const teacherSelfRequest = invoke({
  email: TEACHER_EMAIL,
  action: 'submitRequest',
  data: { request: makeRequest({ '申請人Email': TEACHER_EMAIL, '申請人姓名': '教師' }) }
});
assert.strictEqual(teacherSelfRequest.success, true);
assert.strictEqual(persistedRows[0]['狀態'], 'pending_teacher');

const teacherProxy = invoke({
  email: TEACHER_EMAIL,
  action: 'submitRequest',
  data: { request: makeRequest() }
});
assert.strictEqual(teacherProxy.success, false);
assert.match(teacherProxy.error, /無權代表他人/);

requestRow = Object.assign({}, requestRow, {
  '申請人Email': OWNER_EMAIL,
  '受邀人Email': INVITEE_EMAIL,
  '狀態': 'pending_teacher'
});
const unauthorizedCancel = invoke({ email: TEACHER_EMAIL, action: 'cancelRequest', data: { requestId: requestRow['申請單ID'] } });
assert.strictEqual(unauthorizedCancel.success, false);
assert.match(unauthorizedCancel.error, /無權撤回他人的申請單/);
const ownerCancel = invoke({ email: OWNER_EMAIL, action: 'cancelRequest', data: { requestId: requestRow['申請單ID'] } });
assert.strictEqual(ownerCancel.success, true);

const unauthorizedWithdraw = invoke({ email: TEACHER_EMAIL, action: 'withdrawRequest', data: { requestId: requestRow['申請單ID'] } });
assert.strictEqual(unauthorizedWithdraw.success, false);
assert.match(unauthorizedWithdraw.error, /無權撤回此申請單/);
const ownerWithdraw = invoke({ email: OWNER_EMAIL, action: 'withdrawRequest', data: { requestId: requestRow['申請單ID'] } });
assert.strictEqual(ownerWithdraw.success, true);

const unauthorizedRespond = invoke({
  email: OWNER_EMAIL,
  action: 'respondToRequest',
  data: { requestId: requestRow['申請單ID'], response: 'agree' }
});
assert.strictEqual(unauthorizedRespond.success, false);
assert.match(unauthorizedRespond.error, /無權對此邀請單/);
const inviteeRespond = invoke({
  email: INVITEE_EMAIL,
  action: 'respondToRequest',
  data: { requestId: requestRow['申請單ID'], response: 'agree' }
});
assert.strictEqual(inviteeRespond.success, true);

const wrongSemester = invoke({
  email: OWNER_EMAIL,
  sid: '115-2',
  action: 'cancelRequest',
  data: { requestId: requestRow['申請單ID'] }
});
assert.strictEqual(wrongSemester.success, false);
assert.match(wrongSemester.error, /找不到該申請單/);

console.log('permission tests PASS');
