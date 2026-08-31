#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const fieldContext = { window: {}, console, Object, String, Array, Number, RegExp, Math, JSON };
vm.createContext(fieldContext);
vm.runInContext(fs.readFileSync(path.join(root, 'field-map.js'), 'utf8'), fieldContext, { filename: 'field-map.js' });

const uiContext = {
  window: {
    FieldMap: fieldContext.window.FieldMap,
    DateUtils: {
      parsePeriod(value) {
        const raw = String(value || '').trim();
        if (/早自習|早讀|晨間/i.test(raw)) return 0;
        if (/午休|午/i.test(raw)) return 45;
        return parseInt(raw, 10);
      },
      isCombinedClass(value) {
        return String(value || '').split(/[、,，/／|｜\s]+/).filter(Boolean).length > 1;
      }
    }
  },
  console,
  Object,
  String,
  Array,
  Number,
  RegExp,
  Math,
  JSON,
  Set,
  Date,
  Promise,
  parseInt,
  isNaN
};
vm.createContext(uiContext);
vm.runInContext(fs.readFileSync(path.join(root, 'ui-admin.js'), 'utf8'), uiContext, { filename: 'ui-admin.js' });

function ref(value) {
  return { value };
}

let importedPayload = null;
let importedTeacherPayload = null;
let savedSchedulePayload = null;
const schedulesRef = ref([]);
const api = uiContext.window.UiAdmin.create({
  ref,
  callGasApi: async function (action, data) {
    if (action === 'saveScheduleCell') savedSchedulePayload = data;
    return { ok: true };
  },
  callGasApiWithProgress: async function (action, data) {
    if (action === 'importSchedulesBatch') {
      importedPayload = data;
      return { count: data.list.length };
    }
    assert.equal(action, 'importTeachersBatch');
    importedTeacherPayload = data;
    return { count: data.list.length };
  },
  showToast: function () {},
  showConfirm: async function () { return true; },
  loading: ref(false),
  loadingMessage: ref(''),
  loadWeeklyData: async function () {},
  getTeacherNameByEmail: function (email) { return email === 'wang@example.edu.tw' ? '王老師' : ''; },
  currentSemester: ref('115-1'),
  teachersList: ref([
    { email: 'wang@example.edu.tw', name: '王老師' },
    { email: 'patrol@example.edu.tw', name: '巡堂老師' }
  ]),
  allSchedules: schedulesRef,
  leaveReasonOptions: [],
  historyEditForm: ref({}),
  showHistoryEditModal: ref(false),
  requestsList: ref([])
});

api.excelData.value = [
  {
    '教師姓名': '王老師', '教師Email': 'wang@example.edu.tw', '星期': 1, '節次': 2,
    '班級': '701、702', '科目': '體育', '課堂屬性': '一般', '調課限制': '綁課', '特殊標記': '併班、綁課',
    '啟用起日': '2026-08-01', '啟用迄日': '2026-08-31'
  },
  {
    '教師姓名': '王老師', '教師Email': 'wang@example.edu.tw', '星期': 2, '節次': 3,
    '班級': '801', '科目': '數學', '課堂屬性': '超鐘點', '調課限制': '', '特殊標記': '超鐘點'
  },
  {
    '教師姓名': '巡堂老師', '教師Email': 'patrol@example.edu.tw', '星期': 3, '節次': 4,
    '班級': '', '科目': '巡堂', '課堂屬性': '巡堂', '調課限制': '', '特殊標記': ''
  }
];
api.mappingFields.value = {
  teacherName: '教師姓名', teacherEmail: '教師Email', subject: '科目', dayOfWeek: '星期',
  period: '節次', className: '班級', attr: '課堂屬性', restriction: '調課限制', specialTags: '特殊標記',
  activeFrom: '啟用起日', activeTo: '啟用迄日'
};
api.runImportPreview();
assert.equal(api.importPreview.value.ok, 3);
assert.equal(api.importPreview.value.skipped, 0);

(async function () {
  await api.importSchedules();
  assert.ok(importedPayload);
  assert.equal(importedPayload.list.length, 3);
  assert.equal(importedPayload.list[0]['班級'], '701、702');
  assert.equal(importedPayload.list[0]['調課限制'], 'restricted');
  assert.equal(importedPayload.list[0]['特殊標記'], '併班、綁課');
  assert.equal(importedPayload.list[0]['啟用起日'], '2026-08-01');
  assert.equal(importedPayload.list[0]['啟用迄日'], '2026-08-31');
  assert.equal(importedPayload.list[1]['課堂屬性'], '超鐘點');
  assert.equal(importedPayload.list[1]['特殊標記'], '超鐘點');
  assert.equal(importedPayload.list[2]['課堂屬性'], '巡堂');
  assert.equal(importedPayload.list[2]['班級'], '');
  assert.equal(importedPayload.list[2]['科目'], '');

  schedulesRef.value = [{
    id: 'old-version', teacherEmail: 'wang@example.edu.tw', teacherName: '王老師',
    dayOfWeek: 1, period: 2, className: '701', subject: '國文', attr: '一般',
    activeFrom: '', activeTo: ''
  }];
  api.openScheduleEditModal('wang@example.edu.tw', 1, 2);
  api.pickScheduleAttr('old-version');
  api.pickScheduleAttr('__new__');
  api.scheduleForm.value.className = '702';
  api.scheduleForm.value.subject = '數學';
  api.scheduleForm.value.activeFrom = '2026-08-01';
  await api.saveScheduleCell();
  assert.ok(savedSchedulePayload);
  assert.equal(savedSchedulePayload['前課表ID'], 'old-version');
  assert.notEqual(savedSchedulePayload['課表ID'], 'old-version');
  assert.equal(savedSchedulePayload['啟用起日'], '2026-08-01');
  assert.equal(savedSchedulePayload['班級'], '702');
  assert.equal(savedSchedulePayload['科目'], '數學');

  api.teacherExcelData.value = [{ '教師姓名': '行政教師', '教師Email': 'staff@example.edu.tw', '職務': '行政' }];
  api.teacherMappingFields.value = {
    name: '教師姓名', email: '教師Email', subject: '', jobTitle: '職務', baseHours: '', role: ''
  };
  api.runTeacherImportPreview();
  assert.equal(api.teacherImportPreview.value.ok, 1);
  await api.importTeachersBatch();
  assert.ok(importedTeacherPayload);
  assert.equal(importedTeacherPayload.list[0]['教師姓名'], '行政教師');
  assert.equal(importedTeacherPayload.list[0]['授課科目'], '');
  console.log('schedule bridge contract tests PASS');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
