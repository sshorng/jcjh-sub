#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const context = { console, Object, String, Array, Number, RegExp, Math, JSON };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'code.gs'), 'utf8'), context, { filename: 'code.gs' });

function patrolRow(id, email, name, extra) {
  return Object.assign({
    '學期代號': '115-1',
    '課表ID': id,
    '教師Email': email,
    '教師姓名': name,
    '星期': 2,
    '節次': 3,
    '班級': '',
    '科目': '',
    '課堂屬性': '巡堂',
    '調課限制': ''
  }, extra || {});
}

assert.doesNotThrow(function () {
  context.validateScheduleImportRows_([patrolRow('P1', 'a@school.example', '甲')], '115-1');
});

assert.throws(function () {
  context.validateScheduleImportRows_([
    patrolRow('P1', 'a@school.example', '甲'),
    patrolRow('P2', 'b@school.example', '乙')
  ], '115-1');
}, /只能安排一位巡堂教師/);

const legacy = patrolRow('P3', 'a@school.example', '甲', {
  '班級': '巡堂',
  '科目': '巡堂',
  '課堂屬性': ''
});
const legacyList = [legacy];
context.validateScheduleImportRows_(legacyList, '115-1');
assert.equal(legacyList[0]['班級'], '');
assert.equal(legacyList[0]['科目'], '');
assert.equal(legacyList[0]['課堂屬性'], '巡堂');

function courseRow(id, extra) {
  return Object.assign({
    '學期代號': '115-1',
    '課表ID': id,
    '教師姓名': '甲',
    '星期': 2,
    '節次': 3,
    '班級': '701',
    '科目': '國文',
    '課堂屬性': '一般',
    '啟用起日': '',
    '啟用迄日': ''
  }, extra || {});
}

assert.doesNotThrow(function () {
  context.validateScheduleImportRows_([
    courseRow('S1', { '啟用起日': '2026-08-01', '啟用迄日': '2026-08-15' }),
    courseRow('S2', { '啟用起日': '2026-08-16' })
  ], '115-1', { semesterRange: { start: '2026-08-01', end: '2027-01-31' } });
});
assert.doesNotThrow(function () {
  context.validateScheduleImportRows_([
    courseRow('S-single', { '節次': 8, '課堂屬性': '單週' }),
    courseRow('S-double', { '節次': 8, '課堂屬性': '雙週' })
  ], '115-1');
});
assert.throws(function () {
  context.validateScheduleImportRows_([
    courseRow('S1', { '啟用起日': '2026-08-01', '啟用迄日': '2026-08-15' }),
    courseRow('S2', { '啟用起日': '2026-08-15' })
  ], '115-1');
}, /啟用期間重疊/);
assert.throws(function () {
  context.validateScheduleImportRows_([courseRow('S3', {
    '啟用起日': '2026-07-31', '啟用迄日': '2026-08-01'
  })], '115-1', { semesterRange: { start: '2026-08-01', end: '2027-01-31' } });
}, /不在學期範圍內/);
assert.doesNotThrow(function () {
  context.validateScheduleImportRows_([courseRow('S4')], '115-1', {
    existingRows: [courseRow('S4')],
    ignoreIds: ['S4']
  });
});

const fieldContext = { window: {} };
vm.createContext(fieldContext);
vm.runInContext(fs.readFileSync(path.join(root, 'field-map.js'), 'utf8'), fieldContext, { filename: 'field-map.js' });
const mapped = fieldContext.window.FieldMap.mapSchedule({
  '班級': '', '科目': '', '課堂屬性': '巡堂', '教師姓名': '甲', '教師Email': 'a@school.example', '星期': 2, '節次': 3
});
assert.equal(mapped.className, '');
assert.equal(mapped.subject, '');
assert.equal(mapped.attr, '巡堂');
assert.equal(mapped.teacherName, '甲');
assert.equal(mapped.teacherEmail, '甲');
assert.equal(Object.keys(mapped).some(function (key) { return /email/i.test(key); }), false);

const specialMapped = fieldContext.window.FieldMap.mapSchedule({
  '課表ID': 'S2',
  '班級': '701',
  '科目': '體育',
  '課堂屬性': '超鐘點',
  '調課限制': '綁課',
  '特殊標記': '併班、綁課、預排',
  '啟用起日': '2026/08/01',
  '啟用迄日': '2026/08/31',
  '教師姓名': '乙',
  '教師Email': 'b@school.example',
  '星期': 1,
  '節次': 2
});
assert.equal(specialMapped.attr, '超鐘點');
assert.equal(specialMapped.restriction, 'restricted');
assert.equal(specialMapped.specialTags, '併班、綁課、預排');
assert.equal(specialMapped.isPreplanned, true);
assert.equal(specialMapped.activeFrom, '2026-08-01');
assert.equal(specialMapped.activeTo, '2026-08-31');

const scheduleConflictMessage = fieldContext.window.FieldMap.formatGasError(
  new Error('課表匯入資料驗證失敗：第1列：同一星期與節次只能安排一位巡堂教師（啟用期間重疊）'),
  'saveScheduleCell'
);
assert.match(scheduleConflictMessage, /巡堂教師/);
assert.doesNotMatch(scheduleConflictMessage, /登入憑證/);

const slimDated = context.slimScheduleRows_([{
  '學期代號': '115-1', '課表ID': 'dated', '教師姓名': '乙', '星期': 1, '節次': 2,
  '班級': '701', '科目': '數學', '課堂屬性': '一般',
  '啟用起日': '2026-08-01', '啟用迄日': '2026-08-15'
}])[0];
assert.equal(slimDated['啟用起日'], '2026-08-01');
assert.equal(slimDated['啟用迄日'], '2026-08-15');

const mappedRequest = fieldContext.window.FieldMap.mapRequest({
  '申請人姓名': '甲', '受邀人姓名': '乙', '代申請人姓名': '丙', '狀態': '待受邀人簽核'
});
assert.equal(mappedRequest.requesterEmail, '甲');
assert.equal(mappedRequest.targetTeacherEmail, '乙');
assert.equal(Object.keys(mappedRequest).some(function (key) { return /email/i.test(key); }), false);

const mappedHomeroom = fieldContext.window.FieldMap.mapHomeroomRecord({
  '原導師姓名': '甲', '代導教師姓名': '乙', '操作者': '丙'
});
assert.equal(mappedHomeroom.originalTeacherEmail, '甲');
assert.equal(mappedHomeroom.actualTeacherEmail, '乙');
assert.equal(Object.keys(mappedHomeroom).some(function (key) { return /email/i.test(key); }), false);

assert.doesNotThrow(function () {
  context.validateScheduleImportRows_([{
    '學期代號': '115-1',
    '課表ID': 'S2',
    '教師Email': 'b@school.example',
    '教師姓名': '乙',
    '星期': 1,
    '節次': 2,
    '班級': '701、702',
    '科目': '體育',
    '課堂屬性': '超鐘點',
    '調課限制': 'restricted',
    '特殊標記': '併班、綁課'
  }], '115-1');
});

console.log('patrol contract tests PASS');
