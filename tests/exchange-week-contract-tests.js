#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

global.window = global;
require('../date-utils.js');
require('../domain-schedule.js');
require('../domain-match.js');
require('../ui-request.js');

const { DateUtils, DomainMatch, UiSubmitHelpers } = window;

assert.equal(DateUtils.getExchangeTargetDate('2026-09-07', '2-8', 1), '2026-09-15');
assert.equal(DateUtils.getExchangeTargetDate('2026-09-07', '2-8', 2), '2026-09-22');
assert.equal(DateUtils.getExchangeTargetDate('2026-09-07', '2-8', -1), '2026-09-01');
assert.equal(DateUtils.getExchangeTargetDate('2026-09-07', '9-8', 1), '');

const schedules = [
  { teacherEmail: 'target@example.com', dayOfWeek: 2, period: 8, className: '701', subject: '單週課', attr: '單週' },
  { teacherEmail: 'target@example.com', dayOfWeek: 2, period: 8, className: '701', subject: '雙週課', attr: '雙週' }
];

function getScheduleForDate(email, dateStr, period, dayOfWeek) {
  const single = dateStr === '2026-09-15';
  return schedules.find(row => row.teacherEmail === email
    && row.dayOfWeek === Number(dayOfWeek)
    && row.period === Number(period)
    && (row.attr === '單週' ? single : !single)) || null;
}

function listCandidate(isSingleWeek, targetDate) {
  const targetWeek = DateUtils.getWeekDatesFrom(targetDate);
  return DomainMatch.listExchangeCandidates({
    allSchedules: schedules,
    className: '701',
    leaveEmail: 'leave@example.com',
    leaveDate: '2026-09-07',
    leavePeriod: 8,
    leaveDay: 1,
    leaveCell: { className: '701', subject: '課程', attr: '一般' },
    weekDates: targetWeek,
    isSingleWeek: () => isSingleWeek,
    getScheduleForDate,
    getTeacherNameByEmail: () => '目標教師'
  });
}

assert.equal(listCandidate(true, '2026-09-15').length, 1);
assert.equal(listCandidate(true, '2026-09-15')[0].subject, '單週課');
assert.equal(listCandidate(false, '2026-09-22').length, 1);
assert.equal(listCandidate(false, '2026-09-22')[0].subject, '雙週課');

async function runDateAwareValidationTest() {
  const pendingRequestData = ref({
    mode: 'exchange',
    leaveTeacher: 'leave@example.com',
    subTeacher: 'target@example.com',
    date: '2026-09-07',
    timeKey: '1-8',
    dateB: '2026-09-15',
    timeB: '2-8',
    reason: '課務調整',
    subFee: '無'
  });
  const valid = await UiSubmitHelpers.validateSubmitRequest({
    pendingRequestData: ref(pendingRequestData.value),
    showToast: () => {},
    showConfirm: async () => true,
    isAdmin: ref(false),
    getTeacherNameByEmail: () => '測試教師',
    hasSubTeacherConflict: ref(false),
    assertQuotaDeductAllowed: () => true,
    isMutualCover: ref(false),
    activeCell: ref({ classData: { className: '701', subject: '課程', attr: '一般' } }),
    allSchedules: ref([
      { teacherEmail: 'target@example.com', dayOfWeek: 2, period: 8, className: '701', subject: '單週課', attr: '單週' },
      { teacherEmail: 'target@example.com', dayOfWeek: 2, period: 8, className: '701', subject: '雙週抽離', attr: '雙週' }
    ]),
    isSingleWeek: () => true
  });
  assert.equal(valid, true, '目標日應只使用該週有效的單／雙週課');
}

function ref(value) {
  return { value };
}

const sourceWeek = ref(DateUtils.getWeekDatesFrom('2026-09-07'));
const targetWeek = ref(DateUtils.getWeekDatesFrom('2026-09-15'));
const compareDeps = {
  pendingRequestData: ref({
    mode: 'exchange',
    leaveTeacher: 'leave@example.com',
    subTeacher: 'target@example.com',
    date: '2026-09-07',
    timeKey: '1-8',
    cls: '701',
    dateB: '2026-09-15',
    timeB: '2-8',
    subBClass: '702'
  }),
  currentWeekDates: sourceWeek,
  compareWeekDatesA: sourceWeek,
  compareWeekDatesB: targetWeek,
  resolveCompareBEmail: () => 'target@example.com',
  getScheduleForDate: () => null,
  isClassAwayOnDate: () => false,
  isSlotConflict: () => false,
  isBatchSlotAt: () => false,
  getBatchSlotForCompareB: () => null
};

assert.equal(UiSubmitHelpers.getCompareCellClass(compareDeps, 'A', 1, 8), 'mini-cell-out');
assert.equal(UiSubmitHelpers.getCompareCellClass(compareDeps, 'A', 2, 8), '');
assert.equal(UiSubmitHelpers.getCompareCellClass(compareDeps, 'B', 2, 8), 'mini-cell-out');
assert.equal(UiSubmitHelpers.getCompareCellClass(compareDeps, 'B', 1, 8), '');

runDateAwareValidationTest()
  .then(() => console.log('exchange week contract tests PASS'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
