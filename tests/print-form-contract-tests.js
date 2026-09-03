#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const context = {
  window: { DateUtils: { getTimetablePeriods: () => [1, 2, 3] } },
  console: { log: () => {}, warn: () => {}, error: () => {} },
  Date,
  Math,
  Object,
  Promise,
  String,
  Number,
  Array,
  RegExp,
  Set,
  parseInt,
  isNaN
};
vm.createContext(context);
const printHelperSource = fs.readFileSync(path.join(root, 'print-helper.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const mobileSource = fs.readFileSync(path.join(root, 'mobile.css'), 'utf8');
vm.runInContext(printHelperSource, context, {
  filename: 'print-helper.js'
});

const names = {
  'owner@school.example': '陳小華',
  'invitee@school.example': '王小明',
  'third@school.example': '林小美'
};
const fixtureContext = {
  getTeacherNameByEmail: email => names[String(email || '').toLowerCase()] || String(email || ''),
  getTeacherJobTitleByEmail: () => '國文教師',
  isAdmin: false
};

const substitution = {
  isExchange: false,
  requestId: 'request-1',
  serials: ['SUB-1'],
  requesterEmail: 'owner@school.example',
  requesterName: '陳小華',
  records: [{
    id: 'request-1',
    serial: 'SUB-1',
    type: 'substitution',
    originalTeacherEmail: 'owner@school.example',
    actualTeacherEmail: 'invitee@school.example',
    originalTeacherName: '陳小華',
    actualTeacherName: '王小明',
    date: '2026-09-07',
    period: 1,
    className: '802',
    subject: '生活科技',
    reason: '事假',
     leaveTime: '08:00~16:00',
     note: '臨時行政原因'
  }]
};

const output = context.window.generateFormHtml(substitution, 'NoticeTeacher', fixtureContext);
assert.match(output, /臺北市立建成國民中學代（調、補）課請示單暨班級通知單/);
assert.match(output, /國文教師/);
assert.match(output, /陳小華老師/);
assert.match(output, /職<br>別/);
assert.match(output, /姓<br>名/);
assert.match(output, /處理<br>方式/);
assert.match(output, /■代課/);
assert.match(output, /□調課/);
assert.match(output, /□補課/);
assert.match(output, /■請假/);
assert.match(output, /□僅課務申請\(非請假\)/);
assert.match(output, /假別：事假/);
assert.match(output, /原因：臨時行政原因/);
assert.doesNotMatch(output, /假別：[^<]*[□■]/);
assert.match(output, /115年9月7日8時/);
assert.match(output, /official-day-date">9\/7<\/span>/);
assert.match(output, /生活科技/);
assert.match(output, /802/);
assert.match(output, /單號：SUB-1/);
assert.match(output, /class="official-signature-cell"/);
assert.match(output, /class="official-signature-name">王小明/);
assert.doesNotMatch(output, /official-signature-hint/);
assert.doesNotMatch(output, /official-signature-cell[^>]*rowspan/);
assert.equal((output.match(/class="official-signature-cell"/g) || []).length, 16);
assert.equal((output.match(/class="official-date-cell"/g) || []).length, 1);
assert.match(output, /rowspan="2" colspan="5" class="official-date-cell"/);
assert.equal((output.match(/<col style=/g) || []).length, 17);
assert.equal((output.match(/class="official-subject-row"/g) || []).length, 8);
const packed = context.window.packPrintForms(['<div class="official-substitution-form">copy me</div>']);
assert.equal((packed.match(/copy me/g) || []).length, 4, 'each original form must print as four distributed copies');
assert.equal((packed.match(/class="print-page"/g) || []).length, 2, 'each original form must print as two A4 pages');
const labeledForms = ['<div class="official-substitution-form">labeled form</div>'];
labeledForms.audienceLabelSets = [[
  '教學組留存',
  '請假教師：陳小華',
  '代課/調課教師：王小明',
  '班級：802'
]];
const labeledPacked = context.window.packPrintForms(labeledForms);
assert.equal((labeledPacked.match(/\bofficial-audience-label(?=\s|")/g) || []).length, 4);
assert.match(labeledPacked, /official-audience-label official-audience-label-retain/);
assert.match(labeledPacked, /教學組留存/);
assert.match(labeledPacked, /請假教師：陳小華/);
assert.match(labeledPacked, /代課\/調課教師：王小明/);
assert.match(labeledPacked, /班級：802/);
const defaultPacked = context.window.packPrintForms(['<div class="official-substitution-form">default labels</div>']);
const defaultLabelOrder = [
  '教學組留存',
  '請假教師：',
  '代課/調課教師：',
  '班級：'
].map(label => defaultPacked.indexOf(label));
assert.ok(defaultLabelOrder.every((position, index) => position >= 0 && (index === 0 || position > defaultLabelOrder[index - 1])));
assert.match(printHelperSource, /\.print-page \+ \.print-page/);
assert.doesNotMatch(printHelperSource, /\.print-page \{[\s\S]*?page-break-after:\s*always/);
assert.doesNotMatch(styleSource, /\.print-page \{[\s\S]*?page-break-after:\s*always/);
assert.doesNotMatch(printHelperSource, /content:\s*["']補發["']/);
assert.doesNotMatch(styleSource, /content:\s*["']補發["']/);
const preview = context.window.buildPrintPreview(Object.assign({}, fixtureContext, {
  selectedRecordIds: { value: ['request-1'] },
  substitutionRecords: { value: substitution.records }
}), { records: substitution.records, allSubs: substitution.records });
assert.equal(preview.formCount, 2, 'preview should render teacher and class recipient forms');
assert.equal(preview.staffFormCount, 1);
assert.equal(preview.classCopyCount, 1);
assert.equal(preview.pageCount, 2);
assert.equal(preview.copyCount, 4);
assert.match(preview.documentHtml, /print-preview-stack/);
assert.match(preview.documentHtml, /教學組留存/);
const classLeaveOutput = context.window.generateFormHtml(substitution, 'NoticeClass', fixtureContext);
assert.match(classLeaveOutput, /假別：請假/);
assert.doesNotMatch(classLeaveOutput, /假別：事假/);
assert.doesNotMatch(classLeaveOutput, /原因：/);
assert.match(classLeaveOutput, /class="official-signature-name">王小明/);
const targetOnlyRecord = {
  id: 'target-only-1',
  requestId: 'target-only-1',
  type: 'substitution',
  originalTeacherEmail: 'owner@school.example',
  targetTeacherEmail: 'invitee@school.example',
  targetTeacherName: '王小明',
  date: '2026-09-07',
  period: 1,
  className: '802',
  subject: '生活科技',
  reason: '事假'
};
const targetOnlyForms = context.window.buildPrintForms([targetOnlyRecord], [], fixtureContext);
assert.match(targetOnlyForms[1], /class="official-signature-name">王小明/);
const retainOutput = context.window.generateFormHtml(substitution, 'Official', fixtureContext);
assert.match(retainOutput, /class="official-signature-hint">請簽名/);
assert.doesNotMatch(retainOutput, /class="official-signature-name">王小明/);
assert.match(context.window.getPrintPreviewCss(), /official-audience-label \{[^}]*top: -5\.8mm[^}]*left: 0[^}]*padding: \.8mm 2mm[^}]*border: none[^}]*background: #e5e7eb[^}]*font-size: 10pt/);
assert.match(context.window.getPrintPreviewCss(), /official-audience-label-retain \{[^}]*border: none; background: #e5e7eb;/);
assert.match(context.window.getPrintPreviewCss(), /official-signature-hint \{[^}]*color: #9ca3af/);
assert.match(styleSource, /\.official-audience-label \{[^}]*top: -5\.8mm[^}]*padding: \.8mm 2mm[^}]*border: none[^}]*background: #e5e7eb[^}]*font-size: 10pt/);
assert.match(styleSource, /\.official-audience-label-retain \{[^}]*border: none;[^}]*background: #e5e7eb;/);
assert.match(styleSource, /\.official-signature-hint \{[^}]*color: #9ca3af/);
assert.match(context.window.getPrintPreviewCss(), /\.official-subject-row \.official-slot-value \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-all;/);
assert.match(styleSource, /\.official-subject-row \.official-slot-value \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-all;/);
assert.match(indexSource, /title="列印此筆通知單"[^>]*@click="printSingleRequest\(\{ id: (?:rec|row)\.requestId \|\| (?:rec|row)\.id \}, 'Notice'\)"/);
assert.match(context.window.getPrintPreviewCss(), /official-serial-mark \{[^}]*right: 4\.78mm;[^}]*bottom: -4\.5mm[^}]*text-align: right/);
assert.match(styleSource, /\.official-serial-mark \{[^}]*right: 4\.78mm;[^}]*bottom: -4\.5mm[^}]*text-align: right/);
assert.match(appSource, /data:image\/svg\+xml;charset=utf-8,['"] \+ encodeURIComponent\(svg\)/);
assert.doesNotMatch(appSource, /createObjectURL\(svgBlob\)/);
const combinedCandidateStart = appSource.indexOf('const findCombinedReturnCandidates =');
const combinedCandidateEnd = appSource.indexOf('const weekScheduleGrid = computed', combinedCandidateStart);
assert.ok(combinedCandidateStart >= 0 && combinedCandidateEnd > combinedCandidateStart, 'combined-return candidate finder must remain discoverable');
const combinedCandidateContext = {
  window: { DomainSchedule: { isActiveOnDate: () => true } },
  allSchedules: { value: [
    { teacherEmail: 'owner@school.example', teacherName: '陳小華', dayOfWeek: 1, period: 2, className: '音樂班', subject: '音樂', specialTags: '併班' },
    { teacherEmail: 'invitee@school.example', teacherName: '王小明', dayOfWeek: 1, period: 2, className: '801、802', subject: '英文', specialTags: '併班' },
    { teacherEmail: 'unrelated@school.example', teacherName: '林小美', dayOfWeek: 1, period: 2, className: '901、902', subject: '數學', specialTags: '併班' },
    { teacherEmail: 'plain@school.example', teacherName: '李小美', dayOfWeek: 1, period: 2, className: '801', subject: '自然' },
    { teacherEmail: 'busy@school.example', teacherName: '張小美', dayOfWeek: 1, period: 2, className: '801、802', subject: '自然', specialTags: '併班' }
  ] },
  inputRequestDate: { value: '2026-09-07' },
  currentWeekDates: { value: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'] },
  parseScheduleClasses: raw => String(raw || '').split(/[、,，/／|｜\s]+/).filter(Boolean),
  getScheduleSpecialTags: schedule => String(schedule.specialTags || '').split('、').filter(Boolean),
  isCombinedClass: raw => String(raw || '').split(/[、,，/／|｜\s]+/).filter(Boolean).length > 1,
  isSingleWeek: () => true,
  getScheduleForDate: email => String(email) === 'busy@school.example' ? { isPending: true } : null,
  lookupTeacher: email => ({
    'owner@school.example': { email: 'owner@school.example', name: '陳小華' },
    'invitee@school.example': { email: 'invitee@school.example', name: '王小明' },
    'unrelated@school.example': { email: 'unrelated@school.example', name: '林小美' },
    'plain@school.example': { email: 'plain@school.example', name: '李小美' },
    'busy@school.example': { email: 'busy@school.example', name: '張小美' }
  })[String(email)] || null,
  getTeacherNameByEmail: email => ({
    'owner@school.example': '陳小華',
    'invitee@school.example': '王小明',
    'unrelated@school.example': '林小美',
    'plain@school.example': '李小美',
    'busy@school.example': '張小美'
  })[String(email)] || String(email || ''),
  Object,
  Array,
  String,
  Number,
  parseInt
};
vm.createContext(combinedCandidateContext);
const findCombinedReturnCandidates = vm.runInContext(`(() => {
  ${appSource.slice(combinedCandidateStart, combinedCandidateEnd)}
  return findCombinedReturnCandidates;
})()`, combinedCandidateContext);
const combinedCandidates = findCombinedReturnCandidates({
  teacherEmail: 'owner@school.example',
  dayOfWeek: 1,
  period: 2,
  classData: { className: '音樂班' }
});
assert.equal(combinedCandidates.map(candidate => candidate.email).sort().join(','), 'invitee@school.example,unrelated@school.example', '併班代課候選人應依同節併班課列入，不應要求班名重疊');
assert.match(indexSource, /app\.js\?v=20260903-paper-line2/);
assert.doesNotMatch(preview.documentHtml, /<script\b/i, '列印預覽 srcdoc 不應注入腳本');
assert.doesNotMatch(appSource, /seedClassKey/, 'single-request batch printing should include the same recipient across classes');
assert.match(appSource, /teacherKey\(record, 'actual'\) === targetKey/, 'single-request batch printing should group by recipient teacher');
assert.match(printHelperSource, /const signatureSide = group && group\.isExchange \? 'original' : 'actual';/);
assert.match(printHelperSource, /function getOfficialArrowMarkerHtml\(markerId\)/);
assert.match(indexSource, /print-helper\.js\?v=20260902-course-signature1/);
assert.match(indexSource, /:disabled="loading" @click="saveOvertimePlan"/);
assert.doesNotMatch(indexSource, /overtimePlanRows\.some\(row => !row\.source\)/);
assert.match(indexSource, /class="teacher-email-cell"/);
assert.match(styleSource, /\.teacher-email-cell \{[^}]*overflow-wrap: anywhere/);
assert.match(mobileSource, /\.teacher-email-cell \{[^}]*overflow-wrap: anywhere/);
assert.match(indexSource, /<title>建成國中線上課表系統<\/title>/);
assert.match(indexSource, /application-name" content="JCJH Timetable"/);
assert.equal((indexSource.match(/class="mini-grid-date"/g) || []).length, 12, '對照頁一般與左右兩張跨週課表都應顯示日期');
assert.match(styleSource, /\.mini-grid-header \{[^}]*height: 38px[^}]*flex-direction: column/);
assert.match(indexSource, /isCrossWeekExchange/);
assert.match(indexSource, /exchange-week-grid/);
assert.match(indexSource, /exchange-two-table-panels/);
assert.match(indexSource, /compareWeekSelectionA/);
assert.match(indexSource, /compareWeekSelectionB/);
assert.match(indexSource, /batch-compare-week-nav/);
assert.match(indexSource, /shiftBatchCompareWeek\(-1\)/);
assert.match(indexSource, /shiftBatchCompareWeek\(1\)/);
assert.match(appSource, /getBatchCompareWeeks/);
assert.match(appSource, /batchCompareWeekSlotCount/);
const leaveHistorySlotStart = indexSource.search(/\{\{ formatHistoryLeaveSlot\((?:rec|row)\) \}\}/);
const leaveHistorySlotEnd = indexSource.indexOf('</td>', leaveHistorySlotStart);
assert.ok(leaveHistorySlotStart >= 0 && leaveHistorySlotEnd > leaveHistorySlotStart);
assert.match(indexSource.slice(leaveHistorySlotStart, leaveHistorySlotEnd), /isHistoryLeaveRechanged\((?:rec|row)\)/);
assert.doesNotMatch(indexSource.slice(leaveHistorySlotStart, leaveHistorySlotEnd), /isHistoryExchangeRechanged\((?:rec|row)\)/);
const exchangeHistorySlotStart = indexSource.search(/\{\{ formatHistoryExchangeSlot\((?:rec|row)\) \}\}/);
const exchangeHistorySlotEnd = indexSource.indexOf('</td>', exchangeHistorySlotStart);
assert.ok(exchangeHistorySlotStart >= 0 && exchangeHistorySlotEnd > exchangeHistorySlotStart);
assert.match(indexSource.slice(exchangeHistorySlotStart, exchangeHistorySlotEnd), /isHistoryExchangeRechanged\((?:rec|row)\)/);
assert.equal((indexSource.match(/isRequestLeaveRechanged\((?:req|row)\)/g) || []).length, 3, 'all request lists must mark the original endpoint independently');
assert.equal((indexSource.match(/isRequestExchangeRechanged\((?:req|row)\)/g) || []).length, 3, 'all request lists must mark the target endpoint independently');
const triangleUiStart = indexSource.indexOf("matchMode === 'triangle'");
const triangleUiEnd = indexSource.indexOf('<!-- 調課模式列表 -->', triangleUiStart);
assert.ok(triangleUiStart >= 0 && triangleUiEnd > triangleUiStart, 'triangle UI block must remain discoverable');
const triangleUiSource = indexSource.slice(triangleUiStart, triangleUiEnd);
assert.match(triangleUiSource, /v-model="triangleReason"/);
assert.match(triangleUiSource, /leaveReasonOptions/);
assert.match(triangleUiSource, /未填寫時預設請假/);
assert.match(triangleUiSource, /事由/);
assert.match(indexSource, /紙本模式：請確認三位教師都已在調課單簽名/);
assert.doesNotMatch(triangleUiSource, /#7c3aed|#6d28d9|#5b21b6|#faf5ff|#ddd6fe|#f5f3ff/);
assert.match(indexSource, /併班任課教師不支領代課費；請假教師仍依所選假別計算鐘點扣減/);
assert.match(indexSource, /v-model="pendingRequestData\.reason" :disabled="pendingRequestData\.courseAdjustmentOnly"/);
assert.doesNotMatch(indexSource, /<option v-if="pendingRequestData\.specialFlow === 'combined_return'" value="合班回原班">/);
assert.match(indexSource, /被代教師扣減類別/);
assert.match(indexSource, /getApproveRiskFlags\((?:req|row)\)\.filter\(f => \(f\.level === 'warn' \|\| f\.level === 'danger'\) && f\.key !== 'chain'\)/);
assert.match(appSource, /const returnTo = showDetailModal\.value \? 'detail' : '';/);
assert.match(styleSource, /\.hist-actions \{[^}]*flex-wrap:\s*nowrap/);
assert.match(mobileSource, /\.hist-actions \{[^}]*flex-direction:\s*row/);
const previewSvg = context.window.buildPrintPreviewImageSvg(preview);
assert.match(previewSvg, /foreignObject/);
assert.match(previewSvg, /<br \/>/, 'preview image SVG should use XHTML-compatible line breaks');

const adminOutput = context.window.generateFormHtml(substitution, 'Admin', Object.assign({}, fixtureContext, { isAdmin: true }));
assert.match(adminOutput, /class="official-signature-name">王小明/);

const administrativeProxyOutput = context.window.generateFormHtml(Object.assign({}, substitution, {
  records: [Object.assign({}, substitution.records[0], {
    note: '[行政代申請：王小明 代 陳小華]'
  })]
}), 'NoticeTeacher', fixtureContext);
assert.doesNotMatch(administrativeProxyOutput, /行政代申請/);
assert.doesNotMatch(administrativeProxyOutput, /原因：/);

const adjustmentLeaveOutput = context.window.generateFormHtml(Object.assign({}, substitution, {
  records: [Object.assign({}, substitution.records[0], { reason: '身心調適假', note: '' })]
}), 'NoticeTeacher', fixtureContext);
assert.match(adjustmentLeaveOutput, /■請假/);
assert.match(adjustmentLeaveOutput, /假別：身心調適假/);
assert.doesNotMatch(adjustmentLeaveOutput, /原因：身心調適假/);

const combinedReturnOutput = context.window.generateFormHtml(Object.assign({}, substitution, {
  records: [Object.assign({}, substitution.records[0], {
    specialFlow: 'combined_return',
    reason: '合班回原班'
  })]
}), 'NoticeTeacher', fixtureContext);
assert.match(combinedReturnOutput, /■請假/);
assert.match(combinedReturnOutput, /□僅課務申請\(非請假\)/);
assert.match(combinedReturnOutput, /假別：請假/);
assert.doesNotMatch(combinedReturnOutput, /假別：合班回原班/);
const combinedPublicReturnOutput = context.window.generateFormHtml(Object.assign({}, substitution, {
  records: [Object.assign({}, substitution.records[0], {
    specialFlow: 'combined_return',
    reason: '公假'
  })]
}), 'NoticeTeacher', fixtureContext);
assert.match(combinedPublicReturnOutput, /假別：公假/);

const exchange = {
  isExchange: true,
  requesterEmail: 'owner@school.example',
  requesterName: '陳小華',
  serials: ['EX-1'],
  records: [
    { id: 'EX-1_2', type: 'exchange', originalTeacherEmail: 'owner@school.example', actualTeacherEmail: 'invitee@school.example', date: '2026-09-04', period: 1, className: '803', subject: '國文', formClassName: '802', formSubject: '生活科技', reason: '課務調整' },
    { id: 'EX-1_1', type: 'exchange', originalTeacherEmail: 'invitee@school.example', actualTeacherEmail: 'owner@school.example', date: '2026-09-04', period: 2, className: '802', subject: '生活科技', formClassName: '803', formSubject: '國文', reason: '課務調整' }
  ]
};
const exchangeOutput = context.window.generateFormHtml(exchange, 'NoticeClass', fixtureContext);
assert.equal(context.window.getPrintAudienceLabels(exchange, fixtureContext).join('\n'), [
  '教學組留存',
  '請假教師：陳小華',
  '代課/調課教師：王小明',
  '班級：802、803'
].join('\n'));
assert.match(exchangeOutput, /■調課/);
assert.match(exchangeOutput, /■僅課務申請\(非請假\)/);
assert.doesNotMatch(exchangeOutput, /原因：/);
assert.match(exchangeOutput, /生活科技/);
assert.match(exchangeOutput, /803/);
const exchangeGridSubjectRows = [...exchangeOutput.matchAll(/<tr class="official-subject-row">([\s\S]*?)<\/tr>/g)].map(match => match[1]);
const exchangeGridClassRows = [...exchangeOutput.matchAll(/<tr class="official-class-row">([\s\S]*?)<\/tr>/g)].map(match => match[1]);
assert.match(exchangeGridSubjectRows[0], /生活科技/);
assert.match(exchangeGridSubjectRows[1], /國文/);
assert.match(exchangeGridSubjectRows[0], /class="official-signature-name">陳小華/);
assert.doesNotMatch(exchangeGridSubjectRows[0], /class="official-signature-name">王小明/);
assert.match(exchangeGridSubjectRows[1], /class="official-signature-name">王小明/);
assert.doesNotMatch(exchangeGridSubjectRows[1], /class="official-signature-name">陳小華/);
assert.match(exchangeGridClassRows[0], /802/);
assert.match(exchangeGridClassRows[1], /803/);
assert.equal((exchangeOutput.match(/class="official-day-date"/g) || []).length, 1, '調課單同一天只顯示一個異動日期');
assert.match(exchangeOutput, /class="official-exchange-overlay"/);
assert.match(exchangeOutput, /marker-start="url\(#exchange-arrow-/);
assert.match(exchangeOutput, /marker-end="url\(#exchange-arrow-/);
assert.doesNotMatch(exchangeOutput, /official-exchange-arrow-underlay/);
assert.match(context.window.getPrintPreviewCss(), /official-exchange-arrow-line[^}]*stroke-width: \.25/);
assert.match(styleSource, /\.timetable-grid \.grid-cell-time,[\s\S]*?\.timetable-grid \.grid-cell-class \{[\s\S]*?height: auto;[\s\S]*?max-height: none;[\s\S]*?overflow: visible;/);
const closeExchange = {
  isExchange: true,
  requestId: 'EX-CLOSE',
  records: [
    { id: 'EX-CLOSE_2', type: 'exchange', originalTeacherEmail: 'owner@school.example', actualTeacherEmail: 'invitee@school.example', date: '2026-09-08', period: 3, className: '802', subject: '生活科技', reason: '課務調整' },
    { id: 'EX-CLOSE_1', type: 'exchange', originalTeacherEmail: 'invitee@school.example', actualTeacherEmail: 'owner@school.example', date: '2026-09-08', period: 4, className: '803', subject: '國文', reason: '課務調整' }
  ]
};
const closeExchangeOutput = context.window.generateFormHtml(closeExchange, 'NoticeClass', fixtureContext);
const closeArrow = closeExchangeOutput.match(/<line class="official-exchange-arrow-line"[^>]*y1="([\d.-]+)"[^>]*y2="([\d.-]+)"/);
assert.ok(closeArrow, '相鄰課節應產生調課箭頭');
assert.ok(Math.abs(Number(closeArrow[2]) - Number(closeArrow[1])) > 4, '相鄰課節箭頭端點應保留清楚間距');
const exchangePreview = context.window.buildPrintPreview(Object.assign({}, fixtureContext, {
  selectedRecordIds: { value: exchange.records.map(record => record.id) },
  substitutionRecords: { value: exchange.records }
}), { records: exchange.records, allSubs: exchange.records });
const exchangePreviewSvg = context.window.buildPrintPreviewImageSvg(exchangePreview);
assert.match(exchangePreviewSvg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, 'nested exchange SVG must declare its namespace');
const exchangeAdminOutput = context.window.generateFormHtml(exchange, 'NoticeClass', Object.assign({}, fixtureContext, { isAdmin: true }));
assert.match(exchangeAdminOutput, /official-subject-row/);
assert.match(exchangeAdminOutput, /official-class-row/);
assert.match(exchangeAdminOutput, /生活科技[\s\S]*class="official-signature-name">陳小華/);
assert.match(exchangeAdminOutput, /國文[\s\S]*class="official-signature-name">王小明/);

const crossWeekExchange = {
  isExchange: true,
  requesterEmail: 'owner@school.example',
  requesterName: '陳小華',
  records: [
    Object.assign({}, exchange.records[0], { id: 'EX-WEEK_2', requestId: 'EX-WEEK', date: '2026-08-31', period: 3 }),
    Object.assign({}, exchange.records[1], { id: 'EX-WEEK_1', requestId: 'EX-WEEK', date: '2026-09-11', period: 2 })
  ]
};
const crossWeekPreview = context.window.buildPrintPreview(Object.assign({}, fixtureContext, {
  selectedRecordIds: { value: crossWeekExchange.records.map(record => record.id) },
  substitutionRecords: { value: crossWeekExchange.records }
}), { records: crossWeekExchange.records, allSubs: crossWeekExchange.records });
assert.equal(crossWeekPreview.formCount, 2, '跨週調課應預覽教師與班級兩種收件版本');
const crossWeekOutput = context.window.generateFormHtml(
  context.window.buildPrintGroups(crossWeekExchange.records, [])[0],
  'NoticeClass',
  fixtureContext
);
assert.match(crossWeekOutput, /8\/31/);
assert.match(crossWeekOutput, /9\/11/);
assert.equal((crossWeekOutput.match(/class="official-day-date"/g) || []).length, 2, '跨週調課單只顯示兩個異動日期');
assert.match(crossWeekOutput, /class="official-exchange-overlay"/);

const groups = context.window.buildPrintGroups([
  substitution.records[0],
  Object.assign({}, substitution.records[0], { id: 'request-2', requestId: 'request-2', date: '2026-09-05' })
], []);
assert.equal(groups.length, 2, 'different request IDs must remain separate official forms');

const mergedSerialGroup = context.window.buildPrintGroups([
  substitution.records[0],
  Object.assign({}, substitution.records[0], { id: 'request-2', requestId: 'request-2', serial: 'SUB-2', date: '2026-09-08', period: 2 })
], []);
const mergedSerialOutput = context.window.generateFormHtml(mergedSerialGroup[0], 'Official', fixtureContext);
assert.match(mergedSerialOutput, /單號：SUB-1、SUB-2/);

const sameWeekGroups = context.window.buildPrintGroups([
  substitution.records[0],
  Object.assign({}, substitution.records[0], { id: 'request-2', requestId: 'request-2', date: '2026-09-08', period: 2 })
], []);
assert.equal(sameWeekGroups.length, 1, 'same teacher/class/requester in one week must merge across request IDs');
assert.equal(sameWeekGroups[0].periods.length, 2);

const batchRecords = [
  Object.assign({}, substitution.records[0], {
    id: 'batch-row-1', requestId: 'batch-row-1', batchId: 'batch-1', serial: 'BATCH-1',
    date: '2026-09-01', period: 1, className: '801'
  }),
  Object.assign({}, substitution.records[0], {
    id: 'batch-row-2', requestId: 'batch-row-2', batchId: 'batch-1', serial: 'BATCH-2',
    date: '2026-09-02', period: 2, className: '801', subject: '健康教育'
  })
];
const batchGroups = context.window.buildPrintGroups(batchRecords, [], fixtureContext);
assert.equal(batchGroups.length, 1, 'same batch and class must merge across periods');
assert.equal(batchGroups[0].periods.length, 2);
const batchPreview = context.window.buildPrintPreview(Object.assign({}, fixtureContext, {
  selectedRecordIds: { value: batchRecords.map(record => record.id) },
  substitutionRecords: { value: batchRecords }
}), { records: batchRecords, allSubs: batchRecords });
assert.equal(batchPreview.formCount, 2, 'same batch and teacher pair should preview teacher and class forms');
assert.equal(batchPreview.staffFormCount, 1);
assert.equal(batchPreview.classCopyCount, 1);
assert.match(batchPreview.documentHtml, /801/);
assert.match(batchPreview.documentHtml, /健康教育/);

const batchDifferentClassGroups = context.window.buildPrintGroups([
  batchRecords[0],
  Object.assign({}, batchRecords[1], { id: 'batch-row-2-different-class', requestId: 'batch-row-2-different-class', className: '802' })
], [], fixtureContext);
assert.equal(batchDifferentClassGroups.length, 2, 'same batch with different classes must remain separate');

const audienceBatchRecords = [
  batchRecords[0],
  Object.assign({}, batchRecords[1], {
    id: 'batch-row-2-audience', requestId: 'batch-row-2-audience', className: '802'
  })
];
const audienceForms = context.window.buildPrintForms(audienceBatchRecords, [], fixtureContext);
assert.equal(audienceForms.length, 3, 'teacher preview plus one preview per class');
assert.equal(audienceForms.staffFormCount, 1, 'same recipient teachers should share one merged form');
assert.equal(audienceForms.classCopyCount, 2, 'each class should receive its own copy');
assert.equal(audienceForms.copyCount, 5, 'three staff copies plus one copy per class');
assert.equal(audienceForms.pageCount, 3, 'five recipient copies should use three A4 pages');
assert.match(audienceForms[0], /假別：事假/);
assert.doesNotMatch(audienceForms[0], /class="official-signature-name">王小明/);
assert.match(audienceForms[0], /class="official-signature-hint">請簽名/);
assert.ok(audienceForms.slice(1).every(form => /假別：請假/.test(form)
  && !/假別：事假/.test(form)
  && !/原因：/.test(form)), '班級副本不得列出實際假別與原因');
assert.ok(audienceForms.slice(1).some(form => /class="official-signature-name">王小明/.test(form)), '班級聯應顯示實際代課教師');
assert.match(audienceForms[0], /801/);
assert.match(audienceForms[0], /802/);
assert.ok(audienceForms.slice(1).some(form => /班級：801/.test(form)));
assert.ok(audienceForms.slice(1).some(form => /班級：802/.test(form)));
const audiencePacked = context.window.packPrintForms(audienceForms);
assert.equal((audiencePacked.match(/\bofficial-audience-label(?=\s|")/g) || []).length, 5);
assert.equal((audiencePacked.match(/class="print-page"/g) || []).length, 3);
assert.match(audiencePacked, /教學組留存/);
assert.match(audiencePacked, /請假教師：陳小華/);
assert.match(audiencePacked, /代課\/調課教師：王小明/);
assert.match(audiencePacked, /班級：801/);
assert.match(audiencePacked, /班級：802/);
assert.doesNotMatch(audienceForms.printCopies[0], /class="official-signature-name">王小明/);
assert.match(audienceForms.printCopies[0], /class="official-signature-hint">請簽名/);
assert.match(audienceForms.printCopies[1], /class="official-signature-name">王小明/);
assert.match(audienceForms.printCopies[2], /class="official-signature-name">王小明/);
const adminAudienceForms = context.window.buildPrintForms(audienceBatchRecords, [], Object.assign({}, fixtureContext, { isAdmin: true }));
assert.match(adminAudienceForms[0], /class="official-signature-name">王小明/);
assert.match(adminAudienceForms.printCopies[0], /class="official-signature-name">王小明/);
const audiencePreview = context.window.buildPrintPreview(Object.assign({}, fixtureContext, {
  selectedRecordIds: { value: audienceBatchRecords.map(record => record.id) },
  substitutionRecords: { value: audienceBatchRecords }
}), { records: audienceBatchRecords, allSubs: audienceBatchRecords });
assert.equal(audiencePreview.staffFormCount, 1);
assert.equal(audiencePreview.classCopyCount, 2);
assert.equal(audiencePreview.pageCount, 3);
assert.equal(audiencePreview.copyCount, 5);

const sameClassDifferentSubRecords = [
  Object.assign({}, substitution.records[0], {
    id: 'class-merge-1', requestId: 'class-merge-1', serial: 'CLASS-MERGE-1',
    date: '2026-09-01', period: 1, className: '802', subject: '生活科技',
    actualTeacherEmail: 'invitee@school.example', actualTeacherName: '王小明'
  }),
  Object.assign({}, substitution.records[0], {
    id: 'class-merge-2', requestId: 'class-merge-2', serial: 'CLASS-MERGE-2',
    date: '2026-09-02', period: 2, className: '802', subject: '健康教育',
    actualTeacherEmail: 'third@school.example', actualTeacherName: '林小美'
  })
];
const sameClassDifferentSubForms = context.window.buildPrintForms(
  sameClassDifferentSubRecords,
  sameClassDifferentSubRecords,
  fixtureContext
);
assert.equal(sameClassDifferentSubForms.staffFormCount, 2, '不同代課教師仍應各自保留教師版');
assert.equal(sameClassDifferentSubForms.classCopyCount, 1, '同班同週不同代課教師應合併班級副本');
assert.equal(sameClassDifferentSubForms.length, 3, '兩份教師版加一份班級通知單');
const sameClassMergedForm = sameClassDifferentSubForms.find(form => /班級：802/.test(form));
assert.ok(sameClassMergedForm, '應產生合併後的班級通知單');
const sameClassMergedSubjectRows = [...sameClassMergedForm.matchAll(/<tr class="official-subject-row">([\s\S]*?)<\/tr>/g)].map(match => match[1]);
assert.match(sameClassMergedSubjectRows[0], /生活科技/);
assert.match(sameClassMergedSubjectRows[1], /健康教育/);

const batchDifferentTargetGroups = context.window.buildPrintGroups([
  batchRecords[0],
  Object.assign({}, batchRecords[1], {
    id: 'batch-row-3', requestId: 'batch-row-3', actualTeacherEmail: 'third@school.example', actualTeacherName: '林小美'
  })
], [], fixtureContext);
assert.equal(batchDifferentTargetGroups.length, 2, 'different batch invitees must remain separate');

const differentBatchGroups = context.window.buildPrintGroups([
  batchRecords[0],
  Object.assign({}, batchRecords[1], { id: 'batch-row-4', requestId: 'batch-row-4', batchId: 'batch-2', className: '803' })
], [], fixtureContext);
assert.equal(differentBatchGroups.length, 2, 'different batch applications must remain separate');

const combinedBatchRecords = [
  Object.assign({}, substitution.records[0], {
    id: 'combined-1', requestId: 'combined-1', date: '2026-09-01', period: 4,
    actualTeacherEmail: '', actualTeacherName: '', specialFlow: 'combined_return', reason: '合班回原班'
  }),
  Object.assign({}, substitution.records[0], {
    id: 'combined-2', requestId: 'combined-2', date: '2026-09-01', period: 3,
    actualTeacherEmail: '', actualTeacherName: '', specialFlow: 'combined_return', reason: '合班回原班'
  })
];
const combinedBatchGroups = context.window.buildPrintGroups(combinedBatchRecords, []);
assert.equal(combinedBatchGroups.length, 1, '同週併班上課資料即使缺少舊資料代課欄位也應合併');
assert.equal(combinedBatchGroups[0].periods.length, 2);
const combinedBatchPreview = context.window.buildPrintPreview(Object.assign({}, fixtureContext, {
  selectedRecordIds: { value: combinedBatchRecords.map(record => record.id) },
  substitutionRecords: { value: combinedBatchRecords }
}), { records: combinedBatchRecords, allSubs: combinedBatchRecords });
assert.equal(combinedBatchPreview.formCount, 2, '批次列印應預覽教師與班級兩種收件版本');

const differentRequesterGroups = context.window.buildPrintGroups([
  substitution.records[0],
  Object.assign({}, substitution.records[0], { id: 'request-3', requestId: 'request-3', date: '2026-09-08', originalTeacherEmail: 'other@school.example' })
], []);
assert.equal(differentRequesterGroups.length, 2, 'different leave teachers must remain separate');

const differentClassGroups = context.window.buildPrintGroups([
  substitution.records[0],
  Object.assign({}, substitution.records[0], { id: 'request-4', requestId: 'request-4', date: '2026-09-08', className: '803' })
], []);
assert.equal(differentClassGroups.length, 2, 'different classes must remain separate');

const differentModeGroups = context.window.buildPrintGroups([
  substitution.records[0],
  Object.assign({}, substitution.records[0], { id: 'request-5', requestId: 'request-5', date: '2026-09-08', reason: '課務調整' })
], []);
assert.equal(differentModeGroups.length, 2, 'leave and course-adjustment rows must remain separate');

const triangleRecords = [
  { id: 'TRI-1-1', triangleId: 'TRI-1', triangleLegIndex: 1, triangleInitiatorEmail: 'owner@school.example', triangleInitiatorName: '陳小華', type: 'triangle', serial: 'TRI-1', originalTeacherEmail: 'invitee@school.example', originalTeacherName: '王小明', actualTeacherEmail: 'owner@school.example', actualTeacherName: '陳小華', date: '2026-09-07', period: 1, triangleSourceDate: '2026-09-07', triangleSourcePeriod: 1, triangleTargetDate: '2026-09-08', triangleTargetPeriod: 2, className: '801', subject: '國文', reason: '課務調整' },
  { id: 'TRI-1-2', triangleId: 'TRI-1', triangleLegIndex: 2, triangleInitiatorEmail: 'owner@school.example', triangleInitiatorName: '陳小華', type: 'triangle', serial: 'TRI-1', originalTeacherEmail: 'third@school.example', originalTeacherName: '林小美', actualTeacherEmail: 'invitee@school.example', actualTeacherName: '王小明', date: '2026-09-08', period: 2, triangleSourceDate: '2026-09-08', triangleSourcePeriod: 2, triangleTargetDate: '2026-09-09', triangleTargetPeriod: 3, className: '802', subject: '英文', reason: '課務調整' },
  { id: 'TRI-1-3', triangleId: 'TRI-1', triangleLegIndex: 3, triangleInitiatorEmail: 'owner@school.example', triangleInitiatorName: '陳小華', type: 'triangle', serial: 'TRI-1', originalTeacherEmail: 'owner@school.example', originalTeacherName: '陳小華', actualTeacherEmail: 'third@school.example', actualTeacherName: '林小美', date: '2026-09-09', period: 3, triangleSourceDate: '2026-09-09', triangleSourcePeriod: 3, triangleTargetDate: '2026-09-07', triangleTargetPeriod: 1, className: '803', subject: '數學', reason: '課務調整' }
];
const triangleGroups = context.window.buildPrintGroups([triangleRecords[0]], triangleRecords);
assert.equal(triangleGroups.length, 1, '同一 triangleId 應合併成一張三角調課單');
assert.equal(triangleGroups[0].isTriangle, true);
assert.equal(triangleGroups[0].records.length, 3);
assert.equal(triangleGroups[0].periods.length, 3);
const triangleOutput = context.window.generateFormHtml(triangleGroups[0], 'NoticeClass', fixtureContext);
assert.match(triangleOutput, /陳小華老師/);
assert.match(triangleOutput, /■調課/);
assert.match(triangleOutput, /■僅課務申請\(非請假\)/);
assert.doesNotMatch(triangleOutput, /■請假/);
assert.match(triangleOutput, /801/);
assert.match(triangleOutput, /英文/);
assert.match(triangleOutput, /class="official-exchange-overlay"/);
assert.equal((triangleOutput.match(/class="official-exchange-arrow-line"/g) || []).length, 3);
assert.match(triangleOutput, /orient="auto-start-reverse"/);
assert.match(triangleOutput, /fill="none" stroke="#111827" stroke-width="\.25"/);
assert.equal(context.window.getPrintAudienceLabels(triangleGroups[0], fixtureContext).slice(1, 3).join('\n'), '三角調教師：王小明、林小美、陳小華\n實際授課教師：陳小華、王小明、林小美');

const triangleLeaveRecords = triangleRecords.map(record => Object.assign({}, record, { reason: '公假' }));
const triangleLeaveGroup = context.window.buildPrintGroups([triangleLeaveRecords[0]], triangleLeaveRecords)[0];
const triangleLeaveOutput = context.window.generateFormHtml(triangleLeaveGroup, 'NoticeClass', fixtureContext);
assert.match(triangleLeaveOutput, /■請假/);
assert.match(triangleLeaveOutput, /□僅課務申請\(非請假\)/);
assert.match(triangleLeaveOutput, /假別：請假/);
assert.doesNotMatch(triangleLeaveOutput, /假別：公假/);
assert.doesNotMatch(triangleLeaveOutput, /原因：公假/);
assert.match(triangleLeaveOutput, /自115年9月7日/);

const triangleDefaultRecords = triangleRecords.map(record => Object.assign({}, record, { reason: '' }));
const triangleDefaultGroup = context.window.buildPrintGroups([triangleDefaultRecords[0]], triangleDefaultRecords)[0];
const triangleDefaultOutput = context.window.generateFormHtml(triangleDefaultGroup, 'NoticeClass', fixtureContext);
assert.match(triangleDefaultOutput, /■請假/);
assert.match(triangleDefaultOutput, /□僅課務申請\(非請假\)/);
assert.match(triangleDefaultOutput, /假別：請假/);
assert.doesNotMatch(triangleDefaultOutput, /■僅課務申請\(非請假\)/);

const merged = context.window.buildPrintGroups([
  substitution.records[0],
  Object.assign({}, substitution.records[0], { id: 'request-1-2', requestId: 'request-1', date: '2026-09-08', period: 2 })
], []);
assert.equal(merged.length, 1);
assert.equal(merged[0].periods.length, 2);

const split = context.window.splitPrintGroupByWeek(Object.assign({}, merged[0], {
  periods: merged[0].periods.concat([Object.assign({}, merged[0].periods[0], { date: '2026-09-14' })])
}));
assert.equal(split.length, 2, 'records from different weeks must render separate original-form pages');

(async () => {
  const markedIds = [];
  const gasCalls = [];
  const printDoc = { open() {}, write() {}, close() {} };
  await context.window.printSelectedForms('Notice', Object.assign({}, fixtureContext, {
    selectedRecordIds: { value: ['request-1'] },
    substitutionRecords: { value: substitution.records },
    printRecords: substitution.records,
    printWin: { document: printDoc },
    loading: { value: false },
    loadingMessage: { value: '' },
    markLocalPrinted: ids => markedIds.push(...ids),
    callGasApi: async (action, payload) => gasCalls.push({ action, payload }),
    showToast: () => {}
  }));
  assert.deepEqual(markedIds, ['request-1'], '正式列印後應更新本地已列印狀態');
  assert.equal(gasCalls.length, 1, '正式列印後應同步一次後端已列印狀態');
  assert.equal(gasCalls[0].action, 'batchMarkPrinted');
  assert.deepEqual(Array.from(gasCalls[0].payload.ids), ['request-1'], '後端同步應包含列印資料 ID');
  console.log('print form contract tests PASS');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
