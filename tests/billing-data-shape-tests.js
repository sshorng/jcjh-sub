#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

global.window = global;
require('../field-map.js');
require('../domain-school-swap.js');
require('../domain-billing.js');

const schedule = window.FieldMap.mapSchedule({
  '教師姓名': 'Billing',
  '星期': 1,
  '節次': 1,
  '班級': '701',
  '科目': '國文',
  '課堂屬性': '',
  '特殊標記': '超鐘點'
});
assert.equal(schedule.attr, '一般');
assert.equal(schedule.isOvertime, true);

const request = window.FieldMap.mapRequest({
  '狀態': '已核准',
  '申請人姓名': 'Billing',
  '受邀人姓名': 'Cover',
  '異動日期': '2026/07/13',
  '異動節次': '1',
  '異動類型': '代課',
  '班級': '701',
  '經費來源': '公費代課'
});
assert.equal(request.requestDate, '2026-07-13');

const row = window.DomainBilling.buildMonthlyReportRows({
  teachers: [{ email: 'Billing', name: 'Billing', baseHours: 0 }],
  allSchedules: [schedule],
  substitutionRecords: [{
    date: request.requestDate,
    period: request.requestPeriod,
    className: request.className,
    type: 'substitution',
    originalTeacherName: request.requesterName,
    actualTeacherName: request.targetTeacherName,
    subFee: request.subFee
  }],
  reportMonth: '2026-07',
  reportWeeksCount: 1
})[0];

assert.equal(row.publicOvertimeUsed, 1);
assert.equal(row.schoolPublicPayout, 0);
assert.equal(row.actualOvertime, 0);

const swappedSchedule = window.FieldMap.mapSchedule({
  '教師姓名': 'Billing',
  '星期': 2,
  '節次': 3,
  '班級': '701',
  '科目': '數學',
  '課堂屬性': '一般',
  '特殊標記': '超鐘點'
});
const swappedRow = window.DomainBilling.buildMonthlyReportRows({
  teachers: [{ email: 'Billing', name: 'Billing', baseHours: 0 }],
  allSchedules: [swappedSchedule],
  schoolSwaps: [{
    id: 'swap-billing',
    name: '補課',
    dateA: '2026-07-13',
    periodA: 1,
    dateB: '2026-07-14',
    periodB: 3,
    enabled: true
  }],
  substitutionRecords: [{
    date: '2026-07-13',
    period: 1,
    className: '701',
    type: 'substitution',
    originalTeacherName: 'Billing',
    actualTeacherName: 'Cover',
    subFee: '公費代課'
  }],
  reportMonth: '2026-07',
  reportWeeksCount: 1
})[0];
assert.equal(swappedRow.publicOvertimeUsed, 1, 'school swap must resolve the original overtime slot');
assert.equal(swappedRow.actualOvertime, 0);

const configuredPlan = JSON.stringify([
  { day: 1, period: 1, className: '701', source: '計畫A' },
  { day: 1, period: 2, className: '702', source: '計畫B' }
]);
const configuredRow = window.DomainBilling.buildMonthlyReportRows({
  teachers: [{ email: 'Billing', name: 'Billing', baseHours: 0, expensePlan: configuredPlan }],
  allSchedules: [
    window.FieldMap.mapSchedule({ '教師姓名': 'Billing', '星期': 1, '節次': 1, '班級': '701', '課堂屬性': '一般', '特殊標記': '超鐘點' }),
    window.FieldMap.mapSchedule({ '教師姓名': 'Billing', '星期': 1, '節次': 2, '班級': '702', '課堂屬性': '一般', '特殊標記': '超鐘點' })
  ],
  substitutionRecords: [
    { date: '2026-07-13', period: 1, className: '701', type: 'substitution', originalTeacherName: 'Billing', actualTeacherName: 'Cover', subFee: '公費代課' },
    { date: '2026-07-13', period: 2, className: '702', type: 'substitution', originalTeacherName: 'Billing', actualTeacherName: 'Cover', subFee: '公費代課' }
  ],
  reportMonth: '2026-07',
  reportWeeksCount: 1
})[0];
assert.equal(configuredRow.expensePlanSummary, '計畫A（1節）、計畫B（1節）');
assert.deepEqual(configuredRow.expensePlanAllocations.map(row => [row.source, row.rawHours, row.deduction, row.actualHours]), [
  ['計畫A', 1, 1, 0],
  ['計畫B', 1, 1, 0]
]);

const partiallyConfiguredPlan = JSON.stringify([
  { day: 1, period: 1, className: '701', source: '計畫A' }
]);
const partiallyConfiguredRow = window.DomainBilling.buildMonthlyReportRows({
  teachers: [{ email: 'Billing', name: 'Billing', baseHours: 0, expensePlan: partiallyConfiguredPlan }],
  allSchedules: [
    window.FieldMap.mapSchedule({ '教師姓名': 'Billing', '星期': 1, '節次': 1, '班級': '701', '課堂屬性': '一般', '特殊標記': '超鐘點' }),
    window.FieldMap.mapSchedule({ '教師姓名': 'Billing', '星期': 1, '節次': 2, '班級': '702', '課堂屬性': '一般', '特殊標記': '超鐘點' })
  ],
  substitutionRecords: [],
  reportMonth: '2026-07',
  reportWeeksCount: 1
})[0];
assert.equal(partiallyConfiguredRow.expensePlanSummary, '計畫A（1節）、預設（1節）');
assert.deepEqual(partiallyConfiguredRow.expensePlanAllocations.map(row => [row.source, row.rawHours]), [
  ['計畫A', 1],
  ['預設', 1]
]);

const coEmployedRow = window.DomainBilling.buildMonthlyReportRows({
  teachers: [{ email: 'CoEmployed', name: '共聘教師', jobTitle: '共聘', baseHours: 0 }],
  allSchedules: [],
  substitutionRecords: [],
  reportMonth: '2026-07',
  reportWeeksCount: 1
})[0];
assert.equal(coEmployedRow.jobTitle, '共聘');
assert.equal(window.DomainBilling.toExcelRows([coEmployedRow])[0]['職務'], '共聘');

const defaultJobRow = window.DomainBilling.buildMonthlyReportRows({
  teachers: [{ email: 'DefaultJob', name: '未填職務', baseHours: 0 }],
  allSchedules: [],
  substitutionRecords: [],
  reportMonth: '2026-07',
  reportWeeksCount: 1
})[0];
assert.equal(defaultJobRow.jobTitle, '教師');
assert.equal(window.DomainBilling.toExcelRows([defaultJobRow])[0]['職務'], '教師');

console.log('billing data shape tests PASS');
