#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

global.window = global;
global.DateUtils = {
  parsePeriod(value) {
    if (String(value) === '早自習') return 0;
    if (String(value) === '午休') return 45;
    return parseInt(value, 10);
  }
};

require('../ui-admin.js');

const ref = value => ({ value });
let importPayload = null;
const schedules = ref([]);
const admin = window.UiAdmin.create({
  ref,
  callGasApi: async () => ({ count: 1 }),
  callGasApiWithProgress: async (action, payload) => {
    assert.equal(action, 'importSchedulesBatch');
    importPayload = payload;
    return { count: payload.list.length };
  },
  showToast: () => {},
  showConfirm: async () => true,
  loading: ref(false),
  loadingMessage: ref(''),
  loadWeeklyData: async () => {},
  getTeacherNameByEmail: value => value,
  currentSemester: ref('S1'),
  teachersList: ref([{ loginEmail: 'teacher@example.com', email: '教師', name: '教師' }]),
  allSchedules: schedules,
  leaveReasonOptions: [],
  getHistoryEditDefaultSubFee: () => '自費代課',
  historyEditForm: ref({}),
  showHistoryEditModal: ref(false),
  requestsList: ref([])
});
assert.deepEqual(admin.getOvertimeExpenseSourceOptions(), [], '未設定資料時不應提供預設計畫名稱');

schedules.value = [{
  teacherEmail: '教師',
  teacherName: '教師',
  dayOfWeek: 1,
  period: 1,
  className: '701',
  attr: '超鐘點'
}];
admin.openOvertimePlanModal({ loginEmail: 'teacher@example.com', email: '教師', name: '教師' });
assert.equal(admin.overtimePlanRows.value.length, 1, '登入 Email 與課表姓名鍵不同時仍應找到超鐘點課格');
admin.overtimePlanRows.value[0].source = '校務自訂計畫';
assert.ok(admin.getOvertimeExpenseSourceOptions().includes('校務自訂計畫'), '目前輸入的新計畫也應立即成為下拉建議');

admin.mappingFields.value = {
  teacherName: 'name',
  subject: 'subject',
  dayOfWeek: 'day',
  period: 'period',
  className: 'className',
  attr: 'attr',
  restriction: '',
  specialTags: '',
  activeFrom: 'from',
  activeTo: 'to'
};
admin.excelData.value = [{
  name: '教師',
  subject: '國文',
  day: '一',
  period: '早自習',
  className: '701',
   attr: '超鐘點',
  from: '2026/08/01',
  to: '2026/08/15'
}];

admin.runImportPreview();
assert.equal(admin.importPreview.value.ok, 1);
admin.importSchedules().then(() => {
  assert.equal(importPayload.list[0]['節次'], 0);
  assert.equal(importPayload.list[0]['課堂屬性'], '超鐘點');
  assert.equal(importPayload.list[0]['啟用起日'], '2026-08-01');
  assert.equal(importPayload.list[0]['啟用迄日'], '2026-08-15');
  console.log('ui-admin import tests PASS');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
