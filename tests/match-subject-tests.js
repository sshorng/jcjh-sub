#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'code.gs'), 'utf8');
const start = source.indexOf('function parseSubjectsServer_');
const end = source.indexOf('function buildRequestsDelta_', start);
assert.ok(start >= 0 && end > start, 'match subject helpers must remain discoverable');

const teachers = [
  { '教師Email': 'leave@school.example', '教師姓名': '請假教師', '授課科目': '國文' },
  { '教師Email': 'primary@school.example', '教師姓名': '主要科教師', '授課科目': '輔導' },
  { '教師Email': 'secondary@school.example', '教師姓名': '第二科教師', '授課科目': '國文' },
  { '教師Email': 'schedule-only@school.example', '教師姓名': '課表第二科', '授課科目': '國文' }
];
const schedules = [
  { '教師Email': 'leave@school.example', '教師姓名': '請假教師', '星期': 1, '節次': 2, '班級': '701', '科目': '國文' },
  { '教師Email': 'secondary@school.example', '教師姓名': '第二科教師', '星期': 2, '節次': 3, '班級': '901', '科目': '輔導' },
  { '教師Email': 'schedule-only@school.example', '教師姓名': '課表第二科', '星期': 2, '節次': 4, '班級': '901', '科目': '輔導' }
];

const context = {
  getSemesterTeachersCached_: () => teachers,
  getSemesterSchedulesCached_: () => schedules,
  buildNameKeyDirectory_: () => ({}),
  nameKeyEmailForName_: () => '',
  getActiveSchoolSwapRows_: () => [],
  getSemesterRequestsCached_: () => ({ rows: [] }),
  scheduleActiveOnDate_: () => true,
  resolveSchoolSwapSlotForTeacher_: (rows, date, day, period) => ({ dayOfWeek: day, period: period }),
  Object,
  String,
  Number,
  Array,
  Math,
  parseInt,
  isNaN
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context, { filename: 'code.gs.match-subject' });

assert.deepEqual(
  Array.from(context.parseSubjectsServer_('國文；輔導')),
  ['國文', '輔導'],
  'server parser should accept Chinese semicolons'
);

const result = context.buildMatchCandidates_('2026-1', {
  leaveEmail: 'leave@school.example',
  dateStr: '2026-09-03',
  dayOfWeek: 1,
  period: 1,
  myCourse: '輔導',
  myDomain: '國文',
  myClass: '701',
  limit: 40
});
const primary = result.candidates.find(t => t.teacherName === '主要科教師');
const secondary = result.candidates.find(t => t.teacherName === '第二科教師');
const scheduleOnly = result.candidates.find(t => t.teacherName === '課表第二科');
assert.equal(result.demandDomain, '輔導', 'schedule subjects should be known domains');
assert.equal(primary.isSameSubject, true, 'primary subject teacher should match');
assert.equal(primary.isPrimarySubject, true, 'primary subject teacher should be marked primary');
assert.equal(secondary.isSameSubject, true, 'teacher roster subject plus schedule subject should match');
// 多科請假邏輯：leaveDomains=['國文']，第二科教師名單主科「國文」命中，isPrimarySubject=true 是正確的
assert.equal(secondary.isPrimarySubject, true, 'secondary teacher roster subject matches leaveDomains primary, so isPrimarySubject is true');
assert.equal(scheduleOnly.isSameSubject, true, 'schedule-only secondary subject should match');
assert.ok(
  primary.isSameSubject && secondary.isSameSubject,
  'both primary and secondary teachers should be isSameSubject'
);

teachers.push(
  { '教師Email': 'yingrui@school.example', '教師姓名': '曾瀅芮', '授課科目': '英語資優' },
  { '教師Email': 'eng@school.example', '教師姓名': '英語教師', '授課科目': '英語' },
  { '教師Email': 'eng-gifted@school.example', '教師姓名': '英語資優教師', '授課科目': '英語資優' },
  { '教師Email': 'math@school.example', '教師姓名': '數學教師', '授課科目': '數學' }
);
schedules.push(
  { '教師Email': 'yingrui@school.example', '教師姓名': '曾瀅芮', '星期': 3, '節次': 0, '班級': '8英資A', '科目': '專題探究' }
);

const resultYingRui = context.buildMatchCandidates_('2026-1', {
  leaveEmail: 'yingrui@school.example',
  dateStr: '2026-09-02',
  dayOfWeek: 3,
  period: 0,
  myCourse: '專題探究',
  myDomain: '英語資優',
  myClass: '8英資A',
  limit: 40
});
const candEng = resultYingRui.candidates.find(t => t.teacherName === '英語教師');
const candEngGifted = resultYingRui.candidates.find(t => t.teacherName === '英語資優教師');
const candMath = resultYingRui.candidates.find(t => t.teacherName === '數學教師');

assert.equal(resultYingRui.demandDomain, '英語資優', 'generic course 專題探究 should not hijack demand domain');
assert.ok(candEng && candEng.isSameSubject === true, '英語教師 should be considered same subject for 英語資優');
assert.ok(candEngGifted && candEngGifted.isSameSubject === true, '英語資優教師 should be considered same subject');
assert.ok(candMath && candMath.isSameSubject === false, '數學教師 should not be same subject for 英語資優');
assert.ok(
  resultYingRui.candidates.indexOf(candEngGifted) < resultYingRui.candidates.indexOf(candEng),
  'exact 英語資優 teacher should precede generic 英語 teacher'
);

// ── 多科請假教師：leaveDomains 含多科，候選人命中任一即算同科 ──
// 情境模擬：課表格子科目「資優英語」（非標準名），請假教師同時教「英語資優、英語科」
// 丁于珊授課科目為「英語科」，應被標記同科；數學教師不應標記同科。
teachers.push(
  { '教師Email': 'ding@school.example', '教師姓名': '丁于珊', '授課科目': '英語科' },
  { '教師Email': 'multi-leave@school.example', '教師姓名': '多科請假師', '授課科目': '英語資優' }
);
// 丁于珊這節空堂（無課表列）；數學教師這節也空
const resultMultiSubject = context.buildMatchCandidates_('2026-1', {
  leaveEmail: 'multi-leave@school.example',
  dateStr: '2026-09-04',
  dayOfWeek: 4,
  period: 3,
  myCourse: '資優英語',
  myDomain: '英語資優、英語科',
  myClass: '8英資B',
  limit: 40
});
const candDing = resultMultiSubject.candidates.find(t => t.teacherName === '丁于珊');
const candMathAgain = resultMultiSubject.candidates.find(t => t.teacherName === '數學教師');
assert.ok(candDing, '丁于珊 should appear in candidates');
assert.equal(candDing.isSameSubject, true, '丁于珊（英語科）should be 同科 when leave teacher has 英語資優、英語科');
assert.ok(!candMathAgain || candMathAgain.isSameSubject === false, '數學教師 should not be 同科 for 英語 leave teacher');

console.log('match subject tests PASS');
