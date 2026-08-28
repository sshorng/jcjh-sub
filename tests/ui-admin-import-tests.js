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
  allSchedules: ref([]),
  leaveReasonOptions: [],
  getHistoryEditDefaultSubFee: () => '自費代課',
  historyEditForm: ref({}),
  showHistoryEditModal: ref(false),
  requestsList: ref([])
});

admin.mappingFields.value = {
  teacherName: 'name',
  subject: 'subject',
  dayOfWeek: 'day',
  period: 'period',
  className: 'className',
  attr: 'attr',
  restriction: '',
  specialTags: ''
};
admin.excelData.value = [{
  name: '教師',
  subject: '國文',
  day: '一',
  period: '早自習',
  className: '701',
  attr: '超鐘點'
}];

admin.runImportPreview();
assert.equal(admin.importPreview.value.ok, 1);
admin.importSchedules().then(() => {
  assert.equal(importPayload.list[0]['節次'], 0);
  assert.equal(importPayload.list[0]['課堂屬性'], '超鐘點');
  console.log('ui-admin import tests PASS');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
