#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

global.window = global;
require('../field-map.js');
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
assert.equal(schedule.attr, '超鐘點');

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

console.log('billing data shape tests PASS');
