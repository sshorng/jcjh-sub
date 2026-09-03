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
assert.equal(secondary.isPrimarySubject, false, 'secondary schedule subject should not be marked primary');
assert.equal(scheduleOnly.isSameSubject, true, 'schedule-only secondary subject should match');
assert.ok(
  result.candidates.indexOf(primary) < result.candidates.indexOf(secondary),
  'primary subject teacher should precede a secondary subject teacher'
);

console.log('match subject tests PASS');
