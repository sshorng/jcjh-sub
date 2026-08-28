#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

global.window = global;
require('../export-accounting.js');

const period = { start: '2026-07-01', end: '2026-07-31' };
const schedules = [
  { teacherEmail: 'bill@x', dayOfWeek: 1, period: 1, className: '701', attr: '超鐘點' },
  { teacherEmail: 'bill@x', dayOfWeek: 1, period: 0, className: '702', attr: '超鐘點' },
  { teacherEmail: 'bill@x', dayOfWeek: 1, period: 45, className: '703', attr: '超鐘點' }
];

function build(records, baseHours, scheduleRows) {
  return window.ExportAccounting.buildExportData({
    reportMonth: '2026-07',
    reportWeeksCount: 1,
    periods: { period: period },
    teachers: [{ email: 'bill@x', name: 'Billing', baseHours: baseHours === undefined ? 2 : baseHours }],
    allSchedules: scheduleRows || schedules,
    substitutionRecords: records
  });
}

const publicOvertime = build([{
  date: '2026-07-13', period: 1, className: '701', type: 'substitution',
  originalTeacherEmail: 'bill@x', actualTeacherEmail: 'cover@x', subFee: '公費代課', status: 'approved'
}]);
assert.equal(publicOvertime.sheets.overtime[0].deduction, 1);
assert.equal(publicOvertime.sheets.overtime[0].actualHours, 0);

const publicSpecial = build([
  {
    date: '2026-07-13', period: 0, className: '702', type: 'substitution',
    originalTeacherEmail: 'bill@x', actualTeacherEmail: 'cover@x', subFee: '公費代課', status: 'approved'
  },
  {
    date: '2026-07-13', period: 45, className: '703', type: 'substitution',
    originalTeacherEmail: 'bill@x', actualTeacherEmail: 'cover@x', subFee: '公費代課', status: 'approved'
  }
], 1);
assert.equal(publicSpecial.sheets.overtime[0].deduction, 2);

const selfSpecial = build([
  {
    date: '2026-07-13', period: 0, className: '702', type: 'substitution',
    originalTeacherEmail: 'bill@x', actualTeacherEmail: 'cover@x', subFee: '自費代課', status: 'approved'
  },
  {
    date: '2026-07-13', period: 45, className: '703', type: 'substitution',
    originalTeacherEmail: 'bill@x', actualTeacherEmail: 'cover@x', subFee: '自費代課', status: 'approved'
  }
]);
assert.equal(selfSpecial.sheets.overtime[0].deduction, 2);
assert.deepEqual(selfSpecial.sheets.selfSub.map(row => row.period), ['早自習', '午休']);

console.log('export accounting tests PASS');
