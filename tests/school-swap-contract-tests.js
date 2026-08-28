#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const context = {
  window: {
    DateUtils: {
      getTimetablePeriods() { return [1, 2, 3]; },
      formatPeriodText(period) { return '第' + period + '節'; }
    }
  },
  console,
  Array,
  Date,
  JSON,
  Math,
  Number,
  Object,
  RegExp,
  Set,
  String,
  isNaN,
  parseInt
};
vm.createContext(context);
['domain-school-swap.js', 'domain-schedule.js', 'ui-timetable.js'].forEach(function (file) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
});

function ref(value) {
  return { value };
}

function computed(fn) {
  return { value: fn() };
}

const allSchedules = ref([
  { teacherEmail: 'teacher@example.edu.tw', dayOfWeek: 2, period: 3, className: '702', subject: '數學', attr: '一般' }
]);
const schoolSwaps = ref([{
  id: 'swap-1', name: '校慶補課', dateA: '2026-08-17', dayA: 1, periodA: 2,
  dateB: '2026-08-18', dayB: 2, periodB: 3, enabled: true
}]);

const api = context.window.UiTimetable.create({
  computed,
  allSchedules,
  schoolSwaps,
  substitutionRecords: ref([]),
  substitutionsLookup: ref({}),
  allPendingRequests: ref([]),
  displayTimetableTeachers: ref([]),
  currentWeekDates: ref([]),
  getTeacherNameByEmail() { return '測試教師'; },
  getTeacherSubjectByEmail() { return '數學'; },
  formatDateMMDD(date) { return date; },
  isSingleWeek() { return true; },
  isClassAwayOnDate() { return false; },
  getWeekDayText(day) { return String(day); },
  batchSelectMode: ref(false),
  isBatchSlotSelected() { return false; },
  isMutualCover: ref(false),
  getMutualDraftAt() { return null; },
  mutualDrafts: ref([]),
  mutualAwayClasses: ref([]),
  mutualActivityStart: ref(''),
  mutualActivityEnd: ref(''),
  DAC: function () { return null; }
});

const swapped = api.getScheduleForDate('teacher@example.edu.tw', '2026-08-17', 2, 1);
assert.equal(swapped.className, '702');
assert.equal(swapped.subject, '數學');
assert.equal(swapped.schoolSwapEndpoint, 'A');
api.clearScheduleCache();

const patrolSchedules = [
  { teacherEmail: 'patrol@example.edu.tw', dayOfWeek: 1, period: 2, attr: '巡堂' },
  { teacherEmail: 'patrol@example.edu.tw', dayOfWeek: 2, period: 3, className: '702', subject: '數學', attr: '一般' }
];
const swapIndex = context.window.DomainSchoolSwap.buildIndex(schoolSwaps.value);
const patrolScheduleIndex = context.window.DomainSchedule.buildScheduleIndex(patrolSchedules);
const patrolAtA = context.window.DomainSchoolSwap.resolveSlotForTeacher(
  swapIndex, '2026-08-17', 1, 2, 'patrol@example.edu.tw', patrolScheduleIndex, patrolSchedules
);
const patrolAtB = context.window.DomainSchoolSwap.resolveSlotForTeacher(
  swapIndex, '2026-08-18', 2, 3, 'patrol@example.edu.tw', patrolScheduleIndex, patrolSchedules
);
assert.equal(patrolAtA.dayOfWeek, 1);
assert.equal(patrolAtA.period, 2);
assert.equal(patrolAtA.row, null);
assert.equal(patrolAtB.dayOfWeek, 2);
assert.equal(patrolAtB.period, 3);
assert.equal(patrolAtB.row, null);

const pendingExchange = {
  type: 'exchange',
  requesterEmail: 'owner@example.edu.tw',
  targetTeacherEmail: 'invitee@example.edu.tw',
  requestDate: '2026-08-31',
  requestPeriod: 4,
  className: '701',
  subject: '文旅享繪',
  targetDate: '2026-09-02',
  targetPeriod: 7,
  targetClassName: '701',
  targetSubject: '數學'
};
const pendingIndex = context.window.DomainSchedule.buildPendingIndex([pendingExchange]);
const ownCourseAtTarget = context.window.DomainSchedule.applyPendingOverlay({
  cell: null,
  teacherEmail: 'owner@example.edu.tw',
  dateStr: '2026-09-02',
  period: 7,
  pendingRequests: [pendingExchange],
  pendingIndex: pendingIndex,
  getWeekDayText: day => String(day),
  allSchedules: [],
  scheduleIndex: context.window.DomainSchedule.buildScheduleIndex([]),
  resolveBaseSlot: (date, day, period) => ({ dayOfWeek: day, period: period })
});
assert.equal(ownCourseAtTarget.subject, '文旅享繪');

const ownCourseAtSource = context.window.DomainSchedule.applyPendingOverlay({
  cell: null,
  teacherEmail: 'invitee@example.edu.tw',
  dateStr: '2026-08-31',
  period: 4,
  pendingRequests: [pendingExchange],
  pendingIndex: pendingIndex,
  getWeekDayText: day => String(day),
  allSchedules: [],
  scheduleIndex: context.window.DomainSchedule.buildScheduleIndex([]),
  resolveBaseSlot: (date, day, period) => ({ dayOfWeek: day, period: period })
});
assert.equal(ownCourseAtSource.subject, '數學');

console.log('school swap contract tests PASS');
