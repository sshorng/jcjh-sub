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
  'invitee@school.example': '王小明'
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
assert.doesNotMatch(output, /official-signature-name/);
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
  '教學組留存（請簽名）',
  '請假教師：陳小華',
  '代課/調課教師：王小明',
  '班級：802'
]];
const labeledPacked = context.window.packPrintForms(labeledForms);
assert.equal((labeledPacked.match(/\bofficial-audience-label(?=\s|")/g) || []).length, 4);
assert.match(labeledPacked, /official-audience-label official-audience-label-retain/);
assert.match(labeledPacked, /教學組留存（請簽名）/);
assert.match(labeledPacked, /請假教師：陳小華/);
assert.match(labeledPacked, /代課\/調課教師：王小明/);
assert.match(labeledPacked, /班級：802/);
const defaultPacked = context.window.packPrintForms(['<div class="official-substitution-form">default labels</div>']);
const defaultLabelOrder = [
  '教學組留存（請簽名）',
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
assert.equal(preview.formCount, 1, 'preview should render one merged form in a single column');
assert.equal(preview.pageCount, 2);
assert.equal(preview.copyCount, 4);
assert.match(preview.documentHtml, /print-preview-stack/);
assert.match(preview.documentHtml, /教學組留存（請簽名）/);
assert.match(context.window.getPrintPreviewCss(), /official-audience-label \{[^}]*top: -5\.8mm[^}]*left: 0[^}]*padding: \.8mm 2mm[^}]*border: none[^}]*background: #e5e7eb[^}]*font-size: 10pt/);
assert.match(context.window.getPrintPreviewCss(), /official-audience-label-retain \{[^}]*border: none; background: #e5e7eb;/);
assert.match(styleSource, /\.official-audience-label \{[^}]*top: -5\.8mm[^}]*padding: \.8mm 2mm[^}]*border: none[^}]*background: #e5e7eb[^}]*font-size: 10pt/);
assert.match(styleSource, /\.official-audience-label-retain \{[^}]*border: none;[^}]*background: #e5e7eb;/);
assert.match(indexSource, /title="列印此筆通知單"[^>]*@click="printSingleRequest\(\{ id: rec\.requestId \|\| rec\.id \}, 'Notice'\)"/);
assert.match(context.window.getPrintPreviewCss(), /official-serial-mark \{[^}]*right: 4\.78mm;[^}]*bottom: -4\.5mm[^}]*text-align: right/);
assert.match(styleSource, /\.official-serial-mark \{[^}]*right: 4\.78mm;[^}]*bottom: -4\.5mm[^}]*text-align: right/);
assert.match(appSource, /data:image\/svg\+xml;charset=utf-8,['"] \+ encodeURIComponent\(svg\)/);
assert.doesNotMatch(appSource, /createObjectURL\(svgBlob\)/);
assert.match(printHelperSource, /const signatureSide = group && group\.isExchange \? 'original' : 'actual';/);
assert.match(indexSource, /print-helper\.js\?v=20260829-patrol-empty1/);
assert.match(indexSource, /<title>建成國中線上課表系統<\/title>/);
assert.match(indexSource, /application-name" content="JCJH Timetable"/);
const leaveHistorySlotStart = indexSource.indexOf('{{ formatHistoryLeaveSlot(rec) }}');
const leaveHistorySlotEnd = indexSource.indexOf('</td>', leaveHistorySlotStart);
assert.ok(leaveHistorySlotStart >= 0 && leaveHistorySlotEnd > leaveHistorySlotStart);
assert.match(indexSource.slice(leaveHistorySlotStart, leaveHistorySlotEnd), /isHistoryLeaveRechanged\(rec\)/);
assert.doesNotMatch(indexSource.slice(leaveHistorySlotStart, leaveHistorySlotEnd), /isHistoryExchangeRechanged\(rec\)/);
const exchangeHistorySlotStart = indexSource.indexOf('{{ formatHistoryExchangeSlot(rec) }}');
const exchangeHistorySlotEnd = indexSource.indexOf('</td>', exchangeHistorySlotStart);
assert.ok(exchangeHistorySlotStart >= 0 && exchangeHistorySlotEnd > exchangeHistorySlotStart);
assert.match(indexSource.slice(exchangeHistorySlotStart, exchangeHistorySlotEnd), /isHistoryExchangeRechanged\(rec\)/);
assert.equal((indexSource.match(/isRequestLeaveRechanged\(req\)/g) || []).length, 3, 'all request lists must mark the original endpoint independently');
assert.equal((indexSource.match(/isRequestExchangeRechanged\(req\)/g) || []).length, 3, 'all request lists must mark the target endpoint independently');
assert.match(indexSource, /getApproveRiskFlags\(req\)\.filter\(f => \(f\.level === 'warn' \|\| f\.level === 'danger'\) && f\.key !== 'chain'\)/);
assert.match(appSource, /const returnTo = showDetailModal\.value \? 'detail' : '';/);
assert.match(styleSource, /\.hist-actions \{[^}]*flex-wrap:\s*nowrap/);
assert.match(mobileSource, /\.hist-actions \{[^}]*flex-direction:\s*row/);
const previewSvg = context.window.buildPrintPreviewImageSvg(preview);
assert.match(previewSvg, /foreignObject/);
assert.match(previewSvg, /<br \/>/, 'preview image SVG should use XHTML-compatible line breaks');

const adminOutput = context.window.generateFormHtml(substitution, 'Admin', Object.assign({}, fixtureContext, { isAdmin: true }));
assert.match(adminOutput, /class="official-signature-name">王小明/);

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

const exchange = {
  isExchange: true,
  requesterEmail: 'owner@school.example',
  requesterName: '陳小華',
  serials: ['EX-1'],
  records: [
    { id: 'EX-1_2', type: 'exchange', originalTeacherEmail: 'owner@school.example', actualTeacherEmail: 'invitee@school.example', date: '2026-09-04', period: 1, className: '802', subject: '生活科技', reason: '課務調整' },
    { id: 'EX-1_1', type: 'exchange', originalTeacherEmail: 'invitee@school.example', actualTeacherEmail: 'owner@school.example', date: '2026-09-04', period: 2, className: '803', subject: '國文', reason: '課務調整' }
  ]
};
const exchangeOutput = context.window.generateFormHtml(exchange, 'NoticeClass', fixtureContext);
assert.equal(context.window.getPrintAudienceLabels(exchange, fixtureContext).join('\n'), [
  '教學組留存（請簽名）',
  '請假教師：陳小華',
  '代課/調課教師：王小明',
  '班級：802、803'
].join('\n'));
assert.match(exchangeOutput, /■調課/);
assert.match(exchangeOutput, /■僅課務申請\(非請假\)/);
assert.match(exchangeOutput, /生活科技/);
assert.match(exchangeOutput, /803/);
const exchangeGridSubjectRows = [...exchangeOutput.matchAll(/<tr class="official-subject-row">([\s\S]*?)<\/tr>/g)].map(match => match[1]);
const exchangeGridClassRows = [...exchangeOutput.matchAll(/<tr class="official-class-row">([\s\S]*?)<\/tr>/g)].map(match => match[1]);
assert.match(exchangeGridSubjectRows[0], /生活科技/);
assert.match(exchangeGridSubjectRows[1], /國文/);
assert.match(exchangeGridClassRows[0], /802/);
assert.match(exchangeGridClassRows[1], /803/);
assert.doesNotMatch(exchangeOutput, /official-exchange-route/);
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
const exchangeSubjectRows = [...exchangeAdminOutput.matchAll(/<tr class="official-subject-row">([\s\S]*?)<\/tr>/g)].map(match => match[1]);
assert.match(exchangeSubjectRows[0], /陳小華/);
assert.match(exchangeSubjectRows[1], /王小明/);

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
assert.equal(combinedBatchPreview.formCount, 1, '批次列印的兩筆併班上課資料應只產生一張表單');

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
