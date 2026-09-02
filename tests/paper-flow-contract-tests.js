#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function ref(value) {
  return { value };
}

function teacherName(email) {
  return {
    'owner@school.example': '申請人',
    'invitee@school.example': '受邀人'
  }[String(email || '').toLowerCase()] || String(email || '');
}

function load(sourceName) {
  const context = {
    window: { location: { origin: 'https://school.example', pathname: '/index.html' } },
    console: { log: console.log, warn: console.warn, error: () => {} },
    Date,
    Error,
    Math,
    Object,
    Promise,
    String,
    Number,
    Array,
    RegExp,
    parseInt,
    isNaN,
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, sourceName), 'utf8'), context, {
    filename: sourceName
  });
  return context.window;
}

function loadPaperDraftRecordBuilder(pendingRequestData) {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('const buildPaperDraftRecords =');
  const end = source.indexOf('const buildPaperRecordsForSubmittedRequests =', start);
  assert.ok(start >= 0 && end > start, 'paper draft record builder must remain discoverable');
  const context = {
    pendingRequestData,
    batchSlots: ref([]),
     getTeacherNameByEmail: value => ({
       'month@example.com': '洪筱仙',
       'sheng@example.com': '吳冠萱'
     })[String(value || '').toLowerCase()] || String(value || ''),
     isCombinedReturnRequest: () => false,
     decodePaperTimeKey: value => {
      const parts = String(value || '').split('-');
      return { day: parseInt(parts[0], 10), period: parseInt(parts[1], 10) };
    }
  };
  vm.createContext(context);
  return vm.runInContext(`(() => {
    ${source.slice(start, end)}
    return buildPaperDraftRecords;
  })()`, context);
}

function loadSubmittedPaperRecordBuilder() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('const buildPaperRecordsForSubmittedRequests =');
  const end = source.indexOf('const openPaperPrintDraft =', start);
  assert.ok(start >= 0 && end > start, 'submitted paper record builder must remain discoverable');
  const context = {
     teachersList: ref([
       { loginEmail: 'owner@example.com', email: '申請人', teacherName: '申請人', name: '申請人' },
       { loginEmail: 'invitee@example.com', email: '受邀人', teacherName: '受邀人', name: '受邀人' }
     ]),
     isCombinedReturnRequest: () => false,
     resolveExchangeTargetCell: () => ({ className: '704', subject: '國文' }),
    findBaseScheduleSlot: () => null,
    getTeacherNameByEmail: value => ({
      'owner@example.com': '申請人',
      'invitee@example.com': '受邀人'
    })[String(value || '').toLowerCase()] || String(value || ''),
    isCombinedReturnRequest: request => {
      const raw = request && (request.specialFlow !== undefined
        ? request.specialFlow : request['特殊流程']);
      const value = String(raw == null ? '' : raw).trim().toLowerCase();
      return value === 'combined_return' || value === '合班回原班';
    },
    Date,
    Number,
    String,
    Array,
    Object,
    parseInt,
    isNaN
  };
  vm.createContext(context);
  return vm.runInContext(`(() => {
    ${source.slice(start, end)}
    return buildPaperRecordsForSubmittedRequests;
  })()`, context);
}

function loadApprovedExchangeConverter() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('const convertRequestsToSubstitutions =');
  const end = source.indexOf('const requestsList =', start);
  assert.ok(start >= 0 && end > start, 'approved exchange converter must remain discoverable');
  const context = {
    resolveCellFromBaseAndSubs: () => null,
    findBaseScheduleSlot: () => null,
    getTeacherSubjectByEmail: () => '',
    Date, Number, String, Object, Array, Set, Math, parseInt, isNaN
  };
  vm.createContext(context);
  return vm.runInContext(`(() => {
    ${source.slice(start, end)}
    return convertRequestsToSubstitutions;
  })()`, context);
}

function loadPublicClassRequestMapper() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('const mapPublicClassRequests =');
  const end = source.indexOf('const applyClassPayload =', start);
  assert.ok(start >= 0 && end > start, 'public class request mapper must remain discoverable');
  const context = {
    classViewSchedules: ref([
      { teacherName: '吳冠萱', dayOfWeek: 3, period: 5, className: '904', subject: '輔導' }
    ]),
    Date, Number, String, Object, Array, parseInt, isNaN
  };
  vm.createContext(context);
  return vm.runInContext(`(() => {
    ${source.slice(start, end)}
    return mapPublicClassRequests;
  })()`, context);
}

function runExchangePaperRecordMappingTest() {
  const pendingRequestData = ref({
    mode: 'exchange',
    leaveTeacher: 'month@example.com',
    subTeacher: 'sheng@example.com',
    date: '2026-09-01',
    timeKey: '2-6',
    cls: '703',
    subject: '數學',
    dateB: '2026-09-03',
    timeB: '4-2',
    subBClass: '704',
    subB: '國文',
    reason: '課務調整',
    subFee: '無'
  });
  const records = loadPaperDraftRecordBuilder(pendingRequestData)();
  const targetDateRecord = records.find(record => record.id.endsWith('_1'));
  const sourceDateRecord = records.find(record => record.id.endsWith('_2'));
  assert.equal(targetDateRecord.date, '2026-09-03');
   assert.equal(targetDateRecord.className, '704');
   assert.equal(targetDateRecord.subject, '國文');
   assert.equal(targetDateRecord.originalTeacherEmail, 'sheng@example.com');
   assert.equal(targetDateRecord.actualTeacherEmail, 'month@example.com');
   assert.equal(targetDateRecord.originalTeacherName, '吳冠萱');
   assert.equal(targetDateRecord.actualTeacherName, '洪筱仙');
   assert.equal(sourceDateRecord.date, '2026-09-01');
  assert.equal(sourceDateRecord.className, '703');
  assert.equal(sourceDateRecord.subject, '數學');
   assert.equal(sourceDateRecord.originalTeacherEmail, 'month@example.com');
   assert.equal(sourceDateRecord.actualTeacherEmail, 'sheng@example.com');
   assert.equal(sourceDateRecord.originalTeacherName, '洪筱仙');
   assert.equal(sourceDateRecord.actualTeacherName, '吳冠萱');
}

function runSubmittedExchangePaperRecordMappingTest() {
  const records = loadSubmittedPaperRecordBuilder()([{
    id: 'submitted-1',
    type: 'exchange',
    batchId: 'paper-batch-1',
    requesterName: '申請人',
    targetTeacherName: '受邀人',
    requestDate: '2026-09-01',
    requestPeriod: 6,
    className: '703',
    subject: '數學',
    targetDate: '2026-09-03',
    targetPeriod: 2
  }]);
  const targetDateRecord = records.find(record => record.id.endsWith('_1'));
  const sourceDateRecord = records.find(record => record.id.endsWith('_2'));
   assert.equal(targetDateRecord.className, '704');
   assert.equal(targetDateRecord.subject, '國文');
   assert.equal(targetDateRecord.batchId, 'paper-batch-1');
   assert.equal(targetDateRecord.actualTeacherName, '申請人');
   assert.equal(sourceDateRecord.className, '703');
   assert.equal(sourceDateRecord.subject, '數學');
   assert.equal(sourceDateRecord.batchId, 'paper-batch-1');
   assert.equal(sourceDateRecord.actualTeacherName, '受邀人');
}

function runApprovedExchangeRecordMappingTest() {
  const convert = loadApprovedExchangeConverter();
  const records = convert([{
    id: 'approved-1',
    status: 'approved',
     type: 'exchange',
     serial: 'SWP7759',
     requesterEmail: 'owner@example.com',
    requesterName: '申請人',
    targetTeacherEmail: 'invitee@example.com',
    targetTeacherName: '受邀人',
    requestDate: '2026-09-01',
    requestPeriod: 6,
    className: '703',
    subject: '數學',
    targetDate: '2026-09-03',
    targetPeriod: 2,
    targetClassName: '704',
    targetSubject: '國文'
  }]);
   const targetDateRecord = records.find(record => record.id.endsWith('_1'));
   const sourceDateRecord = records.find(record => record.id.endsWith('_2'));
   assert.equal(targetDateRecord.serial, 'SWP7759');
   assert.equal(sourceDateRecord.serial, 'SWP7759');
   assert.equal(targetDateRecord.className, '703');
   assert.equal(targetDateRecord.subject, '數學');
   assert.equal(targetDateRecord.formClassName, '704');
   assert.equal(targetDateRecord.formSubject, '國文');
   assert.equal(sourceDateRecord.className, '704');
   assert.equal(sourceDateRecord.subject, '國文');
   assert.equal(sourceDateRecord.formClassName, '703');
   assert.equal(sourceDateRecord.formSubject, '數學');
}

function runApprovedCombinedReturnMappingTest() {
  const convert = loadApprovedExchangeConverter();
  const records = convert([{
    id: 'approved-combined-1',
    status: 'approved',
    type: 'substitution',
    requesterEmail: 'owner@example.com',
    requesterName: '申請人',
    targetTeacherEmail: 'invitee@example.com',
    targetTeacherName: '受邀人',
    requestDate: '2026-09-01',
    requestPeriod: 1,
    className: '701、702',
    subject: '國文',
    specialFlow: 'combined_return'
  }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].originalTeacherName, '申請人');
  assert.equal(records[0].actualTeacherName, '受邀人');
  assert.equal(records[0].actualTeacherEmail, '受邀人');
}

function runApprovedBatchRecordMappingTest() {
  const convert = loadApprovedExchangeConverter();
  const records = convert([
    {
      id: 'approved-batch-1', status: 'approved', type: 'substitution', batchId: 'batch-7',
      requesterEmail: 'owner@example.com', requesterName: '申請人',
      targetTeacherEmail: 'invitee@example.com', targetTeacherName: '受邀人',
      requestDate: '2026-09-01', requestPeriod: 1, className: '701', subject: '國文'
    },
    {
      id: 'approved-batch-2', status: 'approved', type: 'substitution', batchId: 'batch-7',
      requesterEmail: 'owner@example.com', requesterName: '申請人',
      targetTeacherEmail: 'invitee@example.com', targetTeacherName: '受邀人',
      requestDate: '2026-09-02', requestPeriod: 2, className: '702', subject: '國文'
    }
  ]);
  assert.equal(records[0].batchId, 'batch-7');
  assert.equal(records[1].batchId, 'batch-7');
}

function runPublicClassExchangeMappingTest() {
  const map = loadPublicClassRequestMapper();
  const records = map([{
    id: 'public-exchange-1',
    status: 'approved',
    type: 'exchange',
    requesterName: '洪筱仙',
    targetTeacherName: '吳冠萱',
    requestDate: '2026-09-04',
    requestPeriod: 2,
    className: '904',
    subject: '國文',
    targetDate: '2026-09-02',
    targetPeriod: 5
  }], '904');
  const targetDateRecord = records.find(record => record.id.endsWith('_class_1'));
  const sourceDateRecord = records.find(record => record.id.endsWith('_class_2'));
  assert.equal(targetDateRecord.subject, '輔導');
  assert.equal(targetDateRecord.actualTeacherName, '洪筱仙');
  assert.equal(sourceDateRecord.subject, '國文');
  assert.equal(sourceDateRecord.actualTeacherName, '吳冠萱');
}

function runNoSyntheticStudySubjectTest() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const subjectStart = source.indexOf('const getOriginalRequestSubject =');
  const subjectEnd = source.indexOf('const getOriginalRequestClass =', subjectStart);
  const teacherStart = source.indexOf('const getTeacherSubjectByEmail =');
  const teacherEnd = source.indexOf('const getTeacherJobTitleByEmail =', teacherStart);
  assert.ok(subjectStart >= 0 && subjectEnd > subjectStart);
  assert.ok(teacherStart >= 0 && teacherEnd > teacherStart);
  assert.doesNotMatch(source.slice(subjectStart, subjectEnd), /自習/);
  assert.doesNotMatch(source.slice(teacherStart, teacherEnd), /自習/);
}

runSubmittedExchangePaperRecordMappingTest();
runApprovedExchangeRecordMappingTest();
runApprovedCombinedReturnMappingTest();
runApprovedBatchRecordMappingTest();
runPublicClassExchangeMappingTest();
runNoSyntheticStudySubjectTest();

function loadProgressSteps() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('const getRequestProgressSteps = (req) => {');
  const end = source.indexOf('// 今日／本週儀表板', start);
  assert.ok(start >= 0 && end > start, 'progress step function must remain discoverable');
  const expression = source.slice(source.indexOf('=', start) + 1, end).trim().replace(/;$/, '');
  return vm.runInNewContext(`(${expression})`, {
    Date, Math, String, isNaN,
    isPaperFlowRequest: req => !!(req && req.paperFlow === true),
    isProxySubmitRequest: req => !!(req && req.isProxySubmit === true)
  });
}

function loadRequestListSorter() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('const requestTimestampText =');
  const end = source.indexOf('const recomputeRequestBuckets =', start);
  assert.ok(start >= 0 && end > start, 'request list sorter must remain discoverable');
  const context = {
    Date, Math, String, Number, Object, Array, RegExp, parseInt, isFinite
  };
  vm.createContext(context);
  return vm.runInContext(`(() => {
    ${source.slice(start, end)}
    return { sortRequestListDesc, formatRequestApplicationDate };
  })()`, context);
}

function loadLineTemplates() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('const formatLineSlot = (');
  const end = source.indexOf('const copyLineMessageForRequest =', start);
  assert.ok(start >= 0 && end > start, 'LINE template functions must remain discoverable');
  const block = source.slice(start, end);
  return vm.runInNewContext(`(() => {
    const formatDateMMDD = value => String(value || '').slice(5).replace('-', '/');
    const formatPeriodText = value => '第' + value + '節';
    const getWeekDayText = value => ({ 1: '一', 2: '二', 3: '三', 4: '四', 5: '五' })[value] || '';
    const getOriginalRequestClass = row => row.className || '';
    const getOriginalRequestSubject = row => row.subject || '';
    const getOriginalTargetClass = row => row.targetClassName || '';
    const getOriginalTargetSubject = row => row.targetSubject || '';
    ${block}
    return { buildLineInviteText, buildAskFirstLineText, buildLineBatchInviteText, getLineHandledSlot };
  })()`, {
    window: { location: { origin: 'https://school.example', pathname: '/index.html' } },
    String, encodeURIComponent
  });
}

function loadCourseDisplayFormatter() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('const formatCourseDisplayText =');
  const end = source.indexOf('/** 同節先前義務', start);
  assert.ok(start >= 0 && end > start, 'course display formatter must remain discoverable');
  return vm.runInNewContext(`(() => {
    ${source.slice(start, end)}
    return { formatCourseDisplayText, _fmtSlot };
  })()`, {
    String,
    Number,
    getWeekDayText: value => ({ 1: '一', 2: '二', 3: '三', 4: '四', 5: '五' })[value] || '',
    formatPeriodText: value => '第' + value + '節'
  });
}

function loadTriangleLineTemplates() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const lineStart = source.indexOf('const formatLineSlot =');
  const lineEnd = source.indexOf('const copyLineMessageForRequest =', lineStart);
  const triangleStart = source.indexOf('const formatTriangleSlot =');
  const triangleEnd = source.indexOf('const submitTriangleRequest =', triangleStart);
  assert.ok(lineStart >= 0 && lineEnd > lineStart, 'LINE slot formatter must remain discoverable');
  assert.ok(triangleStart >= 0 && triangleEnd > triangleStart, 'triangle LINE formatter must remain discoverable');
  return vm.runInNewContext(`(() => {
    ${source.slice(lineStart, lineEnd)}
    ${source.slice(triangleStart, triangleEnd)}
    return { buildTriangleLineText, formatTriangleSlot };
  })()`, {
    window: { location: { origin: 'https://school.example', pathname: '/index.html' } },
    String,
    Number,
    Array,
    Object,
    Date,
    Math,
    RegExp,
    parseInt,
    isNaN,
    encodeURIComponent,
    formatDateMMDD: value => String(value || '').slice(5).replace('-', '/'),
    getWeekDayText: value => ({ 1: '一', 2: '二', 3: '三', 4: '四', 5: '五' })[value] || '',
    formatPeriodText: value => '第' + value + '節'
  });
}

function runLineTemplateTest() {
  const templates = loadLineTemplates();
  const single = templates.buildLineInviteText({
    targetName: '王小明老師',
    requesterName: '陳小華老師',
    dateA: '2026-09-04', dayA: 5, periodA: 1, classA: '904', subjectA: '國文',
    agreeLink: 'https://school.example/?agree',
    declineLink: 'https://school.example/?decline'
  });
  assert.match(single, /小明老師，想問您是否可以協助代課：/);
  assert.match(single, /09\/04\(五\) 第1節 904國文（陳小華老師）/);
  assert.match(single, /✅ 可以/);
  assert.doesNotMatch(single, /詳細如下|非常感謝/);

  const ask = templates.buildAskFirstLineText({
    targetName: '王小明老師', requesterName: '陳小華老師',
    dateA: '2026-09-04', dayA: 5, periodA: 1,
     classA: '904', subjectA: '國文'
  });
  assert.match(ask, /小明老師，想問您是否可以協助代課：/);
  assert.match(ask, /09\/04\(五\) 第1節 904國文（陳小華老師）/);
  assert.match(ask, /如果可以，我再拿代課單給您，感謝/);
  assert.doesNotMatch(ask, /再麻煩您確認一下喔/);

  const askSelf = templates.buildAskFirstLineText({
    targetName: '王小明老師',
    dateA: '2026-09-04', dayA: 5, periodA: 1, classA: '904', subjectA: '國文'
  });
  assert.doesNotMatch(askSelf, /（陳小華老師）/);

  const askExchange = templates.buildAskFirstLineText({
    targetName: '王小明老師',
    dateA: '2026-09-01', dayA: 2, periodA: 2, classA: '707', subjectA: '數學',
    courseTeacherA: '陳小華老師', courseTeacherB: '王小明老師',
    isExchange: true,
    dateB: '2026-09-04', dayB: 5, periodB: 5, classB: '707', subjectB: '健康教育'
  });
  assert.equal(askExchange, [
    '小明老師，想問您是否方便和我調課，',
    '',
    '09/01(二) 第2節 707數學（陳小華老師）<->',
    '09/04(五) 第5節 707健康教育（王小明老師）',
    '',
    '如果可以，我再拿調課單給您，感謝🙏🏻'
  ].join('\n'));
  const askProxyExchange = templates.buildAskFirstLineText({
    targetName: '王小明老師', requesterName: '余月亭老師',
    dateA: '2026-09-01', dayA: 2, periodA: 2, classA: '707', subjectA: '數學',
    courseTeacherA: '余月亭老師', courseTeacherB: '王小明老師',
    isExchange: true,
    dateB: '2026-09-04', dayB: 5, periodB: 5, classB: '707', subjectB: '健康教育'
  });
  assert.match(askProxyExchange, /小明老師，想問您是否方便和月亭老師調課，/);
  assert.doesNotMatch(askProxyExchange, /和我調課/);
  assert.doesNotMatch(askProxyExchange, /和余月亭老師調課/);
  assert.match(askExchange, /如果可以，我再拿調課單給您，感謝/);
  assert.doesNotMatch(askExchange, /簽名/);

  const onlineExchange = templates.buildLineInviteText({
    targetName: '王小明老師', requesterName: '余月亭老師', isExchange: true,
    courseTeacherA: '余月亭老師', courseTeacherB: '王小明老師',
    dateA: '2026-09-01', dayA: 2, periodA: 2, classA: '707', subjectA: '數學',
    dateB: '2026-09-04', dayB: 5, periodB: 5, classB: '707', subjectB: '健康教育'
  });
  assert.equal(onlineExchange, [
    '小明老師，想問您是否方便和月亭老師調課，',
    '',
    '09/01(二) 第2節 707數學（余月亭老師）<->',
    '09/04(五) 第5節 707健康教育（王小明老師）',
    '',
    '感謝🙏🏻'
  ].join('\n'));
  assert.doesNotMatch(onlineExchange, /我的課|您的課/);

  const batch = templates.buildLineBatchInviteText({
    targetName: '王小明老師', requesterName: '陳小華老師', batchId: 'B1', systemUrl: 'https://school.example/',
    slots: [
      { id: '1', date: '2026-09-04', day: 5, period: 1, className: '904', subject: '國文', teacherName: '陳小華老師' },
      { id: '2', date: '2026-09-04', day: 5, period: 2, className: '905', subject: '國文', teacherName: '陳小華老師' }
    ]
  });
  assert.match(batch, /小明老師，想問您是否可以幫忙協助以下代課：/);
  assert.match(batch, /904國文（陳小華老師）/);
  assert.match(batch, /全部可以/);
  assert.match(batch, /感謝/);
  assert.doesNotMatch(batch, /經費來源|調代課系統訊息/);

  const paperBatchInvite = templates.buildLineBatchInviteText({
    targetName: '王小明老師', requesterName: '陳小華老師', batchId: 'B1',
    systemUrl: 'https://school.example/', paperFlow: true,
    slots: [
      { id: '1', date: '2026-09-04', day: 5, period: 1, className: '904', subject: '國文', teacherName: '陳小華老師' },
      { id: '2', date: '2026-09-04', day: 5, period: 2, className: '905', subject: '國文', teacherName: '陳小華老師' }
    ]
  });
  assert.match(paperBatchInvite, /如果可以，我再拿代課單給您，感謝/);
  assert.doesNotMatch(paperBatchInvite, /請回覆：|全部可以|全部不便|https?:\/\/|action=/);

  const paper = templates.buildAskFirstLineText({
    targetName: '王小明老師', requesterName: '陳小華老師',
    dateA: '2026-09-04', dayA: 5, periodA: 1, classA: '904', subjectA: '國文', reason: '事假'
  });
  assert.match(paper, /小明老師，想問您是否可以協助代課：/);
  assert.match(paper, /09\/04\(五\) 第1節 904國文（陳小華老師）/);
  assert.match(paper, /如果可以，我再拿代課單給您，感謝/);
  assert.doesNotMatch(paper, /假別：|紙本調代課通知|簽名後交回教學組|https?:\/\/|action=/);

  const paperBatch = templates.buildAskFirstLineText({
    targetName: '王小明老師', requesterName: '陳小華老師',
    slots: [
      { date: '2026-09-04', day: 5, period: 1, className: '904', subject: '國文', teacherName: '陳小華老師' },
      { date: '2026-09-04', day: 5, period: 2, className: '905', subject: '國文', teacherName: '陳小華老師' }
    ]
  });
  assert.match(paperBatch, /1\. 09\/04\(五\) 第1節 904國文（陳小華老師）/);
  assert.match(paperBatch, /2\. 09\/04\(五\) 第2節 905國文（陳小華老師）/);
  assert.match(paperBatch, /如果可以，我再拿代課單給您，感謝/);

  const pendingSlot = templates.getLineHandledSlot({
    date: '2026-09-07', dayOfWeek: 1, period: 2, cls: '906', subject: '自然'
  });
  assert.equal(pendingSlot.className, '906', '送出前草稿應讀取 cls 班級欄位');
  const pendingAsk = templates.buildAskFirstLineText({
    targetName: '王小明老師', requesterName: '陳小華老師',
    dateA: pendingSlot.date, dayA: pendingSlot.day, periodA: pendingSlot.period,
    classA: pendingSlot.className, subjectA: pendingSlot.subject
  });
  assert.match(pendingAsk, /09\/07\(一\) 第2節 906自然（陳小華老師）/);
}

function runCourseDisplayFormatTest() {
  const formatter = loadCourseDisplayFormatter();
  const notificationCourse = formatter.formatCourseDisplayText('802', '體育', 'OOO老師');
  assert.equal(notificationCourse, '802體育（OOO老師）');
  const tableCourse = formatter.formatCourseDisplayText('802', '體育');
  assert.equal(tableCourse, '802體育');
  assert.equal(formatter._fmtSlot('2026-09-08', '二', 3, tableCourse), '09/08(二) 第3節 802體育');
}

function runTriangleLineFormatTest() {
  const templates = loadTriangleLineTemplates();
  assert.equal(
    templates.formatTriangleSlot(
      { date: '2026-09-08', day: 2, period: 3 },
      { className: '802', subject: '體育' },
      'OOO老師'
    ),
    '09/08(二) 第3節 802體育（OOO老師）'
  );
  const text = templates.buildTriangleLineText({
    targetTeacherName: '王小明',
    reason: '課務調整'
  }, [{
    id: 'triangle-1',
    requesterName: '余明錦',
    targetTeacherName: '王小明',
    requestDate: '2026-09-08',
    requestPeriodDay: 2,
    requestPeriod: 3,
    targetDate: '2026-09-10',
    targetDayOfWeek: 4,
    targetPeriod: 5,
    className: '802',
    subject: '體育'
  }]);
  assert.match(text, /09\/08\(二\) 第3節 802體育（余明錦老師）/);
  assert.match(text, /09\/10\(四\) 第5節 802體育（余明錦老師）/);
}

function loadPaperFlowClassifier() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('const isPaperFlowValue =');
  const end = source.indexOf('/** 目前 UI 身分 Email', start);
  assert.ok(start >= 0 && end > start, 'paper flow classifier must remain discoverable');
  return vm.runInNewContext(`(() => {
    const notificationsSuppressed = { value: true };
    const isProxySubmitRequest = request => !!(request && request.isProxySubmit);
    ${source.slice(start, end)}
    return { isPaperFlowRequest };
  })()`, { Object, String });
}

function runProgressTest() {
  const getProgress = loadProgressSteps();
  const paper = getProgress({
    paperFlow: true,
    status: 'pending_admin',
    targetTeacherName: '黃老師',
    createdAt: '2026-08-27'
  });
  assert.equal(paper.steps.length, 2);
  assert.equal(paper.steps[0].key, 'admin');
  assert.equal(paper.steps[0].label, '等教學組核准');
  assert.equal(paper.summary, '目前：紙本通知已送出，等待教學組核准出單');

  const online = getProgress({
    paperFlow: false,
    status: 'pending_admin',
    targetTeacherName: '黃老師',
    createdAt: '2026-08-27'
  });
  assert.equal(online.steps.length, 3);
  assert.equal(online.steps[0].label, '等 黃老師 同意');
  assert.equal(online.summary, '目前：對方已同意，等待教學組核准出單');

  const proxy = getProgress({
    isProxySubmit: true,
    status: 'pending_admin',
    targetTeacherName: '黃老師',
    createdAt: '2026-08-27'
  });
  assert.equal(proxy.steps.length, 2);
  assert.equal(proxy.summary, '目前：已代送申請，等待教學組核准出單');
}

function runFieldMapTest() {
  const fieldMap = load('field-map.js').FieldMap;
  const teacher = fieldMap.mapTeacher({
    '教師Email': ' New.Teacher@School.Example ',
    '教師姓名': '新教師'
  });
  assert.equal(teacher.loginEmail, 'new.teacher@school.example');

  const paper = fieldMap.mapRequest({
    '申請單ID': 'paper-1', '狀態': 'pending_admin', '紙本流程': ' TRUE '
  });
  assert.equal(paper.paperFlow, true);
  assert.equal(paper.paperFlowSpecified, true);

  const online = fieldMap.mapRequest({
    '申請單ID': 'online-1', '狀態': 'pending_admin', '紙本流程': ' FALSE '
  });
  assert.equal(online.paperFlow, false);
  assert.equal(online.paperFlowSpecified, true);

  const direct = fieldMap.mapRequest({
    '申請單ID': 'direct-1', '直接核准': '是', '備註': '使用者原因'
  });
  assert.equal(direct.directApprove, true);
  assert.equal(direct.note, '使用者原因');

  const legacyTimestamp = fieldMap.mapRequest({
    '申請單ID': 'legacy-1',
    '申請時間': '2026-08-28 11:23:45',
    '更新時間': '2026-08-28 11:25:00'
  });
  assert.equal(legacyTimestamp.createdAt, '2026-08-28 11:23:45');
  assert.equal(legacyTimestamp.updatedAt, '2026-08-28 11:25:00');

  const exchangeFields = fieldMap.mapRequest({
    '異動類型': 'exchange',
    '對調目標班級': '704',
    '對調目標科目': '國文'
  });
  assert.equal(exchangeFields.targetClassName, '704');
  assert.equal(exchangeFields.targetSubject, '國文');

  const classifier = loadPaperFlowClassifier();
  assert.equal(classifier.isPaperFlowRequest({
    status: 'pending_admin', paperFlow: false, paperFlowSpecified: true
  }), true, '紙本模式的非代申請待核准單應使用紙本訊息');
  assert.equal(classifier.isPaperFlowRequest({
    status: 'pending_admin', paperFlow: false, paperFlowSpecified: true, isProxySubmit: true
  }), false, '代申請仍保留線上待行政流程');
  assert.equal(classifier.isPaperFlowRequest({
    status: 'pending_teacher', paperFlow: false, paperFlowSpecified: true
  }), true, '紙本模式的舊待受邀單也應使用紙本訊息');
  assert.equal(classifier.isPaperFlowRequest({
    status: 'pending_teacher', paperFlow: false, paperFlowSpecified: true, isProxySubmit: true
  }), false, '代申請仍保留線上待受邀流程');
}

function runRequestListSortTest() {
  const sorter = loadRequestListSorter();
  const rows = [
    { id: 'old', serial: 'SWP5814', createdAt: '2026-08-28 11:20:09', updatedAt: '2026-08-28 11:59:59', requestDate: '2026-09-01' },
    { id: 'late', serial: 'SWP7604', createdAt: '2026-08-28 11:20:10', requestDate: '2026-09-01' },
    { id: 'legacy', serial: 'SUB1365', createdAt: '', updatedAt: '2026-08-28 11:19:59', requestDate: '2026-09-01' }
  ];
  assert.deepEqual(sorter.sortRequestListDesc(rows).map(row => row.id), ['late', 'old', 'legacy']);
  assert.equal(sorter.formatRequestApplicationDate(rows[2]), '2026-08-28');
  assert.equal(sorter.formatRequestApplicationDate({ requestDate: '2026-09-04' }), '2026-09-04');
}

function runApplicationFormContractTest() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /data-tour="compare-fee"/);
  assert.doesNotMatch(html, /代課鐘點費結算方式/);
  assert.match(html, /id="course-adjustment-only"/);
  assert.match(html, /@change="toggleCourseAdjustmentOnly"/);
   assert.match(html, /\(pendingRequestData\.mode === 'substitution' \|\| pendingRequestData\.mode === 'exchange'\) && pendingRequestData\.specialFlow !== 'combined_return'/);
  assert.ok((html.match(/預覽調代課單/g) || []).length >= 3, 'compare modal must expose preview in every footer branch');
  assert.ok((html.match(/@click="openPaperPrintDraftFromCompare"/g) || []).length >= 3, 'preview buttons must use the shared preview flow');
  assert.doesNotMatch(html, /🖨️ 列印紙本通知/, 'compare modal must not expose the standalone paper notice button');
   assert.doesNotMatch(html, /送出並列印紙本通知|確認送出，通知相關人員/, 'submit button must not use the retired paper notice label');
   assert.match(html, /paperFlow \? '送出申請並列印調代課單' : '確認送出'/, 'paper flow submit button must send then print');
   assert.doesNotMatch(html, /送出前不可列印/, 'preview button should not expose the lock note in its label');
   assert.match(html, /v-if="printPreview && printPreview\.canPrint !== false" class="print-preview-image-actions"/, 'pre-submit image actions should be hidden');
    assert.match(html, /v-if="printPreview && printPreview\.canPrint !== false" type="button" class="btn btn-primary"(?: data-tour="print-confirm")? @click="confirmPrintPreview"/, 'pre-submit print action should be hidden');
  assert.match(html, /data-tour="success-followup-actions"/);
  assert.match(html, /@click="openSuccessPrintPreview"/);
  assert.match(html, /@click="addSuccessToCalendar"/);
  assert.match(html, /@click="closeSuccessGoRecords"/);
    const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const activitySource = fs.readFileSync(path.join(root, 'ui-activity.js'), 'utf8');
    const onboardingSource = fs.readFileSync(path.join(root, 'onboarding-tour.js'), 'utf8');
    assert.match(appSource, /const paperFlow = computed\(\(\) =>\s*!isMutualCover\.value\s*&&\s*notificationsSuppressed\.value\s*&&\s*!isProxySubmitActive\.value\s*\);/, '關閉線上申請時應優先走紙本流程');
    assert.match(html, /v-if="isAdmin && !notificationsSuppressed && pendingRequestData\.specialFlow !== 'combined_return'/, '紙本模式不應顯示直接核准選項');
    assert.equal((html.match(/getBatchGroupTeacherSummary\(row\)/g) || []).length, 3, '三個批次主列都應顯示全部代課教師');
    const batchTeacherStart = appSource.indexOf('const getBatchGroupTeacherSummary =');
    const batchTeacherEnd = appSource.indexOf('const getBatchGroupStatusValues =', batchTeacherStart);
    assert.ok(batchTeacherStart >= 0 && batchTeacherEnd > batchTeacherStart, '批次教師摘要函式必須存在');
    const getBatchGroupTeacherSummary = vm.runInNewContext(`(() => {
      ${appSource.slice(batchTeacherStart, batchTeacherEnd)}
      return getBatchGroupTeacherSummary;
    })()`, { String, Set });
    assert.equal(getBatchGroupTeacherSummary({ items: [
      { targetTeacherName: '黃健忠' },
      { targetTeacherName: '余明錦' },
      { targetTeacherName: '黃健忠' }
    ] }), '黃健忠、余明錦', '批次主列應去重顯示全部教師');
    assert.match(appSource, /if \(p\.mode !== 'substitution' && p\.mode !== 'exchange'\) return;/, '課務調整切換應支援調課模式');
   assert.match(appSource, /const d = p\.mode === 'substitution'\s*\? getLeaveTimeDefaults\(p\.leaveTeacher\)\s*:\s*\{ type: '', start: '', end: '', range: '' \};/, '調課取消課務調整時不應套用請假時間');
   const batchPanelStart = activitySource.indexOf('window.UiBatchPanel =');
  assert.ok(batchPanelStart >= 0, 'batch panel module must remain discoverable');
  const batchPanelSource = activitySource.slice(batchPanelStart);
  assert.match(batchPanelSource, /var successActionRequests = deps\.successActionRequests/);
  assert.match(batchPanelSource, /showSuccessModal, successActionRequests, showCompareModal/);
  assert.match(appSource, /successActionRequests: successActionRequests/);
   assert.match(appSource, /returnTo === 'compare'\) showCompareModal\.value = true/);
   assert.match(html, /getClassChangeTypeLabel\(item\.type\)/, 'class change badges should use compact labels');
   assert.match(html, /isHomeroomTeacher\(t, activeCell\.classData && activeCell\.classData\.className\)/, 'substitution candidates should show class-specific homeroom status');
   assert.match(appSource, /const getClassChangeTypeLabel =/);
   assert.match(appSource, /const isHomeroomTeacher =/);
   assert.match(appSource, /const getHomeroomClassCodes =/);
   const helperStart = appSource.indexOf('const chineseClassNumber =');
   const helperEnd = appSource.indexOf('const getRealTeacherName =', helperStart);
   assert.ok(helperStart >= 0 && helperEnd > helperStart, 'class-specific homeroom helper must remain discoverable');
   const helperContext = {
     activeCell: { value: { classData: { className: '904' } } },
     getTeacherJobTitleByEmail: () => ''
   };
   vm.createContext(helperContext);
   const homeroomHelpers = vm.runInContext(`(() => {
     ${appSource.slice(helperStart, helperEnd)}
     return { isHomeroomTeacher };
   })()`, helperContext);
   assert.equal(homeroomHelpers.isHomeroomTeacher({ jobTitle: '904導師' }, '904'), true);
   assert.equal(homeroomHelpers.isHomeroomTeacher({ jobTitle: '901導師' }, '904'), false);
   assert.equal(homeroomHelpers.isHomeroomTeacher({ jobTitle: '導師' }, '904'), false);
   assert.match(appSource, /openPaperPrintDraft\(null, \{ returnTo: 'compare', canPrint: false \}\)/);
  assert.match(appSource, /canPrint: options\.canPrint === true/);
  assert.match(appSource, /openPaperPrintDraft\(buildPaperRecordsForSubmittedRequests\(requests\), \{ canPrint: true \}\)/);
  assert.match(appSource, /snapshot\.canPrint === false/);
  assert.match(appSource, /returnTo: draft\.returnTo \|\| ''/);
  assert.match(appSource, /successActionRequests/);
   assert.match(appSource, /mode: notificationsSuppressed\.value \? 'paper' : 'online'/, 'onboarding should follow the global paper mode');
   assert.match(appSource, /openExchangeModeDemo: \(\) => openExchangeModeDemoForTour\(\)/, 'tour should demonstrate exchange mode');
    assert.match(appSource, /ONBOARDING_SCRIPT = 'onboarding-tour\.js\?v=20260831-combined3'/, 'onboarding cache must refresh with the exchange tour');
    assert.match(html, /ui-activity\.js\?v=20260901-batch-display2/);
     assert.match(html, /app\.js\?v=20260901-expense-default1/);
     assert.match(appSource, /openPaperPrintDemo: \(\) => openPaperPrintDemoForTour\(\)/, 'paper tour should open a print preview demo');
     assert.match(appSource, /openExchangeModeDemo: \(\) => openExchangeModeDemoForTour\(\)/, 'tour should demonstrate exchange mode');
    assert.match(appSource, /source: 'paperTour'/, 'paper tour preview must use an isolated source');
    assert.match(appSource, /snapshot\.source === 'paperTour'/, 'paper tour print actions must not print real data');
   assert.match(appSource, /const shouldAutoStartOnboarding =/);
  assert.match(appSource, /ONBOARDING_PAPER_STORAGE_KEY/);
  assert.match(onboardingSource, /var PAPER_STORAGE_KEY = 'jcjh_onboarding_paper_v1'/);
   assert.match(onboardingSource, /var PAPER_STEP_OVERRIDES =/);
   assert.match(onboardingSource, /step\.id !== 'line-success' && step\.id !== 'pending-invite'/);
   assert.doesNotMatch(onboardingSource, /鐘點費/, 'onboarding must not mention the retired hourly-fee field');
   assert.match(onboardingSource, /id: 'match-mode'/, 'tour should include the exchange mode step');
   assert.match(onboardingSource, /id: 'exchange-controls'/, 'tour should include exchange controls');
   assert.match(onboardingSource, /_storageKey = opts\.mode === 'paper' \? PAPER_STORAGE_KEY : STORAGE_KEY/);
   assert.match(html, /notificationsSuppressed \? '紙本流程操作教學' : '線上簽核操作教學'/, 'help button label should follow the global mode');
   assert.match(html, /data-tour="exchange-mode-btn"/, 'exchange mode button should be a tour target');
   assert.match(html, /data-tour="exchange-controls"/, 'exchange controls should be a tour target');
     assert.match(onboardingSource, /paper-print-preview/, 'paper tour should include the print preview step');
     assert.match(onboardingSource, /paper-print-button/, 'paper tour should include the confirm-print step');
     assert.match(onboardingSource, /compare-submit-paper/, 'paper tour should target the paper submit button');
     assert.match(html, /paperMode \? '紙本申請進度' : '待辦簽核'/, 'pending navigation should follow the active mode');
   assert.match(html, /data-tour="print-preview-modal"/, 'print preview should be a tour target');
   assert.match(html, /data-tour="print-confirm"/, 'confirm print button should be a tour target');
}

function runHistoryEditTeacherValueTest() {
  const historyEditForm = ref({});
  const showHistoryEditModal = ref(false);
  const teachersList = ref([
    { email: '申請人', loginEmail: 'owner@school.example', name: '申請人', teacherName: '申請人' },
    { email: '受邀人', loginEmail: 'invitee@school.example', name: '受邀人', teacherName: '受邀人' }
  ]);
  const api = load('ui-admin.js').UiAdmin.create({
    ref,
    callGasApi: async () => ({ success: true }),
    showToast: () => {},
    showConfirm: async () => true,
    loading: ref(false),
    loadingMessage: ref(''),
    currentSemester: ref('115-1'),
    getTeacherNameByEmail: teacherName,
    teachersList,
    allSchedules: ref([]),
    leaveReasonOptions: ['公假', '事假', '其他'],
    getHistoryEditDefaultSubFee: (reason, period) => Number(period) === 8
      ? '第8節代課'
      : reason === '公假' ? '公費代課' : '自費代課',
    historyEditForm,
    showHistoryEditModal,
    requestsList: ref([{
      id: 'request-edit-1',
      requesterEmail: 'owner@school.example',
      targetTeacherEmail: 'invitee@school.example',
      requesterName: '申請人',
      targetTeacherName: '受邀人',
      requestDate: '2026-08-28',
      requestPeriod: 1,
       reason: '公假',
       subFee: '自費代課'
    }])
  });
  api.openHistoryEditModal({
    id: 'sub-edit-1',
    requestId: 'request-edit-1',
    originalTeacherName: '申請人',
    actualTeacherName: '受邀人',
    date: '2026-08-28',
    period: 1,
    className: '701',
    subject: '國文'
  });
  assert.equal(historyEditForm.value.requesterEmail, '申請人');
  assert.equal(historyEditForm.value.targetTeacherEmail, '受邀人');
  assert.equal(historyEditForm.value.subFee, '公費代課');
  assert.equal(showHistoryEditModal.value, true);
  historyEditForm.value.reason = '事假';
  api.onHistoryEditReasonChange();
  assert.equal(historyEditForm.value.subFee, '自費代課');
  historyEditForm.value.requestPeriod = 8;
  api.onHistoryEditPeriodChange();
  assert.equal(historyEditForm.value.subFee, '第8節代課');
  historyEditForm.value.type = 'exchange';
  api.onHistoryEditTypeChange();
  assert.equal(historyEditForm.value.subFee, '無');
}

async function runCombinedHistoryEditContractTest() {
  const historyEditForm = ref({});
  const showHistoryEditModal = ref(false);
  const teachersList = ref([
    { email: '申請人', loginEmail: 'owner@school.example', name: '申請人', teacherName: '申請人' },
    { email: '受邀人', loginEmail: 'invitee@school.example', name: '受邀人', teacherName: '受邀人' }
  ]);
  let sent = null;
  const api = load('ui-admin.js').UiAdmin.create({
    ref,
    callGasApi: async (action, payload) => { sent = { action, payload }; return { success: true }; },
    showToast: () => {},
    showConfirm: async () => true,
    loading: ref(false),
    loadingMessage: ref(''),
    loadWeeklyData: async () => {},
    currentSemester: ref('115-1'),
    getTeacherNameByEmail: teacherName,
    teachersList,
    allSchedules: ref([]),
    leaveReasonOptions: ['公假', '事假', '其他'],
   getHistoryEditDefaultSubFee: (reason, period) => Number(period) === 8
     ? '第8節代課'
     : (reason === '公假' ? '公費代課' : '自費代課'),
    historyEditForm,
    showHistoryEditModal,
    requestsList: ref([{
      id: 'combined-req-1',
      requesterEmail: 'owner@school.example',
      requesterName: '申請人',
       targetTeacherEmail: '受邀人',
       targetTeacherName: '受邀人',
      specialFlow: 'combined_return',
      requestDate: '2026-08-28',
      requestPeriod: 1,
      className: '701、702',
      subject: '國文',
       reason: '公假',
      subFee: '公費代課'
    }])
  });

  api.openHistoryEditModal({
    id: 'sub-combined-1',
    requestId: 'combined-req-1',
    originalTeacherName: '申請人',
     actualTeacherName: '受邀人',
    specialFlow: 'combined_return',
    date: '2026-08-28',
    period: 1,
    className: '701、702',
    subject: '國文'
  });
  assert.equal(historyEditForm.value.specialFlow, 'combined_return');
   assert.equal(historyEditForm.value.targetTeacherEmail, '受邀人');
   assert.equal(historyEditForm.value.reason, '公假');
  historyEditForm.value.requestPeriod = 8;
  api.onHistoryEditPeriodChange();
   assert.equal(historyEditForm.value.subFee, '第8節代課');
  await api.saveHistoryEdit();
  assert.equal(sent.action, 'saveHistoryEdit');
   assert.equal(sent.payload.targetTeacherEmail, '受邀人');
   assert.equal(sent.payload.targetTeacherName, '受邀人');
  assert.equal(sent.payload.specialFlow, 'combined_return');
  assert.equal(sent.payload.requestPeriod, 8);
   assert.equal(sent.payload.reason, '公假');
}

function singleDeps() {
  const pendingRequestData = ref({
    mode: 'substitution',
    leaveTeacher: 'owner@school.example',
    subTeacher: 'invitee@school.example',
    cls: '701',
    subject: '國文',
    date: '2026-08-17',
    timeKey: '1-1',
    reason: '事假',
    subFee: '自費代課',
    leaveTimeType: '全天',
    leaveTimeStart: '08:00',
    leaveTimeEnd: '16:00',
    leaveTime: '08:00~16:00',
    submitRequestId: '',
    submitSerial: ''
  });
  return {
    pendingRequestData,
    currentSemester: ref('115-1'),
    getTeacherNameByEmail: teacherName,
    isAdmin: ref(false),
    directApproveMode: ref(false),
    paperFlow: ref(true),
    isMutualCover: ref(false),
    PERIOD8_FEE: '第8節代課',
    ACTIVITY_PUBLIC_FEE: '活動公費',
    defaultSubFeeForReason: () => '自費代課',
    activeCell: ref(null),
    inputRequestDate: ref('2026-08-17'),
    DAC: () => null,
    isProxySubmitActive: () => false,
    canStaffProxySubmit: () => false,
    shouldProxySubmitForLeave: () => false,
    getProxyActor: () => ({ email: 'owner@school.example', name: '申請人' }),
    userEmail: () => 'owner@school.example'
  };
}

function runConsecutiveWarningTest() {
  const api = load('ui-request.js').UiSubmitHelpers;
  const date = '2026-08-17';
  let existingPeriods = [1, 2];
  const getScheduleForDate = (email, dateStr, period) => {
    if (email !== '受邀人' || dateStr !== date) return null;
    return existingPeriods.includes(Number(period))
      ? { teacherName: email }
      : null;
  };

  const reachesThree = api.getConsecutiveStatus(
    getScheduleForDate, '受邀人', date, 3, null
  );
  assert.equal(reachesThree.beforeMaxConsec, 2);
  assert.equal(reachesThree.maxConsec, 3);
  assert.equal(reachesThree.shouldWarn, true, '變成連三須警示');

  existingPeriods = [1, 2, 3];
  const extendsExistingRun = api.getConsecutiveStatus(
    getScheduleForDate, '受邀人', date, 4, null
  );
  assert.equal(extendsExistingRun.maxConsec, 4);
  assert.equal(extendsExistingRun.shouldWarn, false, '已連三不因變成連四重複警示');

  const addsOutsideRun = api.getConsecutiveStatus(
    getScheduleForDate, '受邀人', date, 6, null
  );
  assert.equal(addsOutsideRun.maxConsec, 3);
  assert.equal(addsOutsideRun.shouldWarn, false, '非連堂新增不應重複警示');
}

async function runSingleTest() {
  const api = load('ui-request.js').UiSubmitHelpers;
  const deps = singleDeps();
  const built = api.buildSubmitPayload(deps, 'req-paper-single', 'SUB1234');
  assert.equal(built.newRequest['狀態'], 'pending_admin');
  assert.equal(built.newRequest['紙本流程'], 'TRUE');
  assert.equal(built.newRequest.paperFlow, true);
  assert.equal(built.newRequest['申請人Email'], 'owner@school.example');
  assert.equal(built.newRequest['受邀人Email'], 'invitee@school.example');

  const exchangeDeps = singleDeps();
  exchangeDeps.pendingRequestData.value = {
    mode: 'exchange',
    leaveTeacher: 'owner@school.example',
    subTeacher: 'invitee@school.example',
    cls: '703',
    subject: '數學',
    date: '2026-09-01',
    timeKey: '2-6',
    dateB: '2026-09-03',
    timeB: '4-2',
    subBClass: '704',
    subB: '國文',
    reason: '課務調整',
    subFee: '無'
  };
  const exchangeBuilt = api.buildSubmitPayload(exchangeDeps, 'req-exchange', 'SWP1234');
  assert.equal(exchangeBuilt.newRequest['對調目標班級'], '704');
  assert.equal(exchangeBuilt.newRequest['對調目標科目'], '國文');

  const combinedDeps = singleDeps();
  combinedDeps.isAdmin.value = true;
  combinedDeps.pendingRequestData.value = Object.assign({}, combinedDeps.pendingRequestData.value, {
    specialFlow: 'combined_return',
    subTeacher: 'invitee@school.example',
    subFee: '公費代課',
    courseAdjustmentOnly: false,
     reason: '事假'
  });
  const combinedBuilt = api.buildSubmitPayload(combinedDeps, 'req-combined', 'SUB5679');
  assert.equal(combinedBuilt.newRequest['狀態'], 'pending_admin');
  assert.equal(combinedBuilt.newRequest['特殊流程'], 'combined_return');
  assert.equal(combinedBuilt.newRequest['受邀人Email'], 'invitee@school.example');
  assert.equal(combinedBuilt.newRequest['紙本流程'], 'FALSE');
  assert.equal(combinedBuilt.newRequest.directApprove, false);
  assert.equal(combinedBuilt.newRequest.courseAdjustmentOnly, false);
   assert.equal(combinedBuilt.newRequest['經費來源'], '自費代課');
  Object.assign(combinedDeps, {
    showToast: () => {},
    showConfirm: async () => true,
    hasSubTeacherConflict: ref(false),
    assertQuotaDeductAllowed: () => true
  });
  assert.equal(await api.validateSubmitRequest(combinedDeps), true);
  combinedDeps.pendingRequestData.value.courseAdjustmentOnly = true;
  assert.equal(await api.validateSubmitRequest(combinedDeps), false);

  const sentPayloads = [];
  let attempts = 0;
  let printedRows = null;
  Object.assign(deps, {
    validate: async () => true,
    validateSubmitRequest: async () => true,
    loading: ref(false),
    loadingMessage: ref(''),
    isSubmitting: ref(false),
    mutualSkipNotify: ref(false),
    directApproveSkipNotify: ref(false),
    notificationsSuppressed: ref(true),
    callGasApi: async (action, payload) => {
      assert.equal(action, 'submitRequest');
      sentPayloads.push(payload);
      attempts += 1;
      if (attempts === 1) throw new Error('simulated timeout after request write');
      return { success: true };
    },
    showCompareModal: ref(true),
    showMatchModal: ref(false),
    optimisticUpsertRequest: () => {},
    sheetRequestToFront: row => row,
    deductMutualQuotaForRows: async () => {},
    softRefreshInBackground: () => {},
    isQuotaDeductFee: () => false,
    buildLineInviteText: () => '',
    successModalTitle: ref(''),
    successModalMessage: ref(''),
     lineCopyText: ref('舊的線上訊息'),
     hasLineTemplate: ref(true),
      showSuccessModal: ref(true),
     successActionRequests: ref([]),
     showToast: () => {},
    openPaperPrintDraft: rows => { printedRows = rows; },
    buildSubmitPayload: (requestId, serial) => api.buildSubmitPayload(deps, requestId, serial),
    getProxyActor: deps.getProxyActor,
    getTeacherNameByEmail: teacherName,
    userEmail: deps.userEmail
  });

  await api.executeSubmitRequest(deps);
  await api.executeSubmitRequest(deps);
  assert.equal(attempts, 2);
  assert.equal(sentPayloads[0].request['申請單ID'], sentPayloads[1].request['申請單ID']);
  assert.equal(sentPayloads[0].paperFlow, true);
  assert.equal(sentPayloads[1].request['狀態'], 'pending_admin');
    assert.equal(printedRows.length, 1);
    assert.equal(printedRows[0]['紙本流程'], 'TRUE');
    assert.equal(deps.successActionRequests.value.length, 1);
    assert.equal(deps.hasLineTemplate.value, false);
    assert.equal(deps.lineCopyText.value, '');
    assert.equal(deps.showSuccessModal.value, false);
}

async function runLineHandledSlotTest() {
  const api = load('ui-request.js').UiSubmitHelpers;
  const linePayloads = [];
  const deps = singleDeps();
  deps.paperFlow.value = false;
  deps.inputRequestDate.value = '2026-08-25';
  deps.activeCell.value = {
    dayOfWeek: 2,
    period: 4,
    classData: { className: '803', subject: '體育' }
  };
  Object.assign(deps, {
    validateSubmitRequest: async () => true,
    loading: ref(false),
    loadingMessage: ref(''),
    isSubmitting: ref(false),
    mutualSkipNotify: ref(false),
    directApproveSkipNotify: ref(false),
    notificationsSuppressed: ref(false),
    callGasApi: async () => ({ success: true }),
    showCompareModal: ref(true),
    showMatchModal: ref(false),
    optimisticUpsertRequest: () => {},
    sheetRequestToFront: row => row,
    deductMutualQuotaForRows: async () => {},
    softRefreshInBackground: () => {},
    isQuotaDeductFee: () => false,
    buildLineInviteText: payload => { linePayloads.push(payload); return ''; },
    successModalTitle: ref(''),
    successModalMessage: ref(''),
    lineCopyText: ref(''),
    hasLineTemplate: ref(false),
    showSuccessModal: ref(false),
    successActionRequests: ref([]),
    showToast: () => {},
    buildSubmitPayload: () => ({
      payload: { request: {} },
      isExchange: false,
      newRequest: {
        '狀態': 'pending_teacher',
        '申請人姓名': '黃俊升',
        '受邀人姓名': '健忠',
        '異動日期': '2026-08-01',
        '異動星期': 6,
        '異動節次': 1,
        '班級': '錯誤班級',
        '科目': '錯誤科目',
        isProxySubmit: true
      }
    })
  });

  await api.executeSubmitRequest(deps);
  assert.equal(linePayloads.length, 1);
  assert.equal(linePayloads[0].dateA, '2026-08-25');
  assert.equal(linePayloads[0].dayA, 2);
  assert.equal(linePayloads[0].periodA, 4);
  assert.equal(linePayloads[0].classA, '803');
  assert.equal(linePayloads[0].subjectA, '體育');
}

async function runCourseAdjustmentTest() {
  const api = load('ui-request.js').UiSubmitHelpers;
  const deps = singleDeps();
  deps.pendingRequestData.value = Object.assign({}, deps.pendingRequestData.value, {
    reason: '課務調整',
    courseAdjustmentOnly: true,
    leaveTimeType: '',
    leaveTimeStart: '',
    leaveTimeEnd: '',
    leaveTime: ''
  });
  const built = api.buildSubmitPayload(deps, 'req-course-only', 'SUB5678');
  assert.equal(built.newRequest['請假事由'], '課務調整');
  assert.equal(built.newRequest['請假時間類型'], '');
  assert.equal(built.newRequest['請假時間'], '');
  assert.equal(built.newRequest['僅課務調整'], '是');
  assert.equal(built.newRequest.courseAdjustmentOnly, true);

  Object.assign(deps, {
    showToast: () => {},
    showConfirm: async () => true,
    hasSubTeacherConflict: ref(false),
    assertQuotaDeductAllowed: () => true,
    allSchedules: ref([])
  });
  assert.equal(await api.validateSubmitRequest(deps), true);

  const exchangeDeps = singleDeps();
  exchangeDeps.pendingRequestData.value = Object.assign({}, exchangeDeps.pendingRequestData.value, {
    mode: 'exchange',
    date: '2026-09-01',
    timeKey: '2-6',
    dateB: '2026-09-03',
    timeB: '4-2',
    subBClass: '704',
    subB: '國文',
    reason: '課務調整',
    courseAdjustmentOnly: true,
    leaveTimeType: '',
    leaveTimeStart: '',
    leaveTimeEnd: '',
    leaveTime: ''
  });
  const exchangeCourseOnly = api.buildSubmitPayload(exchangeDeps, 'req-exchange-course-only', 'SWP5678');
  assert.equal(exchangeCourseOnly.newRequest.courseAdjustmentOnly, true);
  assert.equal(exchangeCourseOnly.newRequest['僅課務調整'], '是');
  assert.equal(exchangeCourseOnly.newRequest['請假時間類型'], '');
  assert.equal(exchangeCourseOnly.newRequest['請假時間'], '');
  assert.equal(exchangeCourseOnly.newRequest['對調目標班級'], '704');
  assert.equal(exchangeCourseOnly.newRequest['對調目標科目'], '國文');

  Object.assign(exchangeDeps, {
    showToast: () => {},
    showConfirm: async () => true,
    hasSubTeacherConflict: ref(false),
    assertQuotaDeductAllowed: () => true,
    allSchedules: ref([])
  });
  assert.equal(await api.validateSubmitRequest(exchangeDeps), true, '調課課務調整不需填請假時間');

  const directDeps = singleDeps();
  directDeps.isAdmin.value = true;
  directDeps.directApproveMode.value = true;
  directDeps.paperFlow.value = false;
  directDeps.pendingRequestData.value.note = '使用者原因';
  const direct = api.buildSubmitPayload(directDeps, 'req-direct', 'SUB9012');
  assert.equal(direct.newRequest['備註'], '使用者原因');
  assert.equal(direct.newRequest['直接核准'], '是');
  assert.equal(direct.newRequest.directApprove, true);
  assert.doesNotMatch(direct.newRequest['備註'], /直接核准/);
}

async function runBatchTest(courseAdjustmentOnly = false, adminPaperMode = false) {
  const api = load('ui-activity.js').UiBatchSubmit;
  const batchSlots = ref([
    { teacherEmail: 'owner@school.example', subTeacherEmail: 'invitee@school.example', subTeacherName: '受邀人', dateStr: '2026-08-17', dayOfWeek: 1, period: 1, className: '701', subject: '國文' },
    { teacherEmail: 'owner@school.example', subTeacherEmail: 'invitee@school.example', subTeacherName: '受邀人', dateStr: '2026-08-17', dayOfWeek: 1, period: 2, className: '702', subject: '國文' }
  ]);
  const pendingRequestData = ref({
    isBatch: true,
    isPerSlot: false,
    reason: courseAdjustmentOnly ? '課務調整' : '事假',
    courseAdjustmentOnly,
    note: '',
    subTeacher: 'invitee@school.example',
    subFee: '自費代課',
    leaveTimeType: '全天',
    leaveTimeStart: '08:00',
    leaveTimeEnd: '16:00',
    leaveTime: '08:00~16:00',
    submitBatchId: 'bat-paper-contract',
    submitSerial: 'SUB4321'
  });
  const sent = [];
  let printedRows = null;
  const deps = {
    batchSlots,
    pendingRequestData,
    batchAssignMode: ref('same'),
    batchReason: ref(courseAdjustmentOnly ? '課務調整' : '事假'),
    batchNote: ref(''),
    batchSubTeacher: ref('invitee@school.example'),
    batchSubFee: ref('自費代課'),
    showToast: () => {},
    showConfirm: async () => true,
    getScheduleForDate: () => null,
    getTeacherNameByEmail: teacherName,
    getLeaveTimeDefaults: () => ({ type: '全天', start: '08:00', end: '16:00', range: '08:00~16:00' }),
    isMutualCover: ref(false),
    mutualAwayClasses: ref([]),
    mutualSkipNotify: ref(false),
     isAdmin: ref(adminPaperMode),
    isQuotaDeductFee: () => false,
    QUOTA_DEDUCT_FEE: '扣額度',
    ACTIVITY_PUBLIC_FEE: '活動公費',
    PERIOD8_FEE: '第8節代課',
    defaultSubFeeForReason: () => '自費代課',
    assertQuotaDeductAllowed: () => true,
    loading: ref(false),
    loadingMessage: ref(''),
    currentSemester: ref('115-1'),
     directApproveMode: ref(adminPaperMode),
    directApproveSkipNotify: ref(false),
    paperFlow: ref(true),
    paperMode: ref(true),
    notificationsSuppressed: ref(true),
    callGasApi: async (action, payload) => {
      assert.equal(action, 'submitRequestBatch');
      sent.push(payload);
      return { success: true };
    },
    optimisticUpsertRequest: () => {},
    sheetRequestToFront: row => row,
    deductMutualQuotaForRows: async () => {},
    softRefreshInBackground: () => {},
    activityBalanceCtx: () => ({}),
    successModalTitle: ref(''),
    successModalMessage: ref(''),
   hasLineTemplate: ref(true),
   lineBatchParts: ref([{ text: '舊的線上分卡' }]),
   lineCopyText: ref('舊的線上訊息'),
   showSuccessModal: ref(true),
    successActionRequests: ref([]),
    showCompareModal: ref(true),
    showMatchModal: ref(false),
    batchSelectMode: ref(true),
    clearBatchSlots: () => { batchSlots.value = []; },
    buildLineBatchInviteText: () => '',
    DAC: () => null,
    openPaperPrintDraft: rows => { printedRows = rows; },
    isSubmitting: ref(false)
  };

  await api.executeBatchSubmit(deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].paperFlow, true);
  assert.equal(sent[0].directApprove, false);
  assert.equal(sent[0].skipNotify, true);
  assert.ok(sent[0].requests.every(row => row['狀態'] === 'pending_admin' && row['紙本流程'] === 'TRUE'));
  assert.equal(printedRows.length, 2, 'paper records must be built before batch slots are cleared');
  assert.equal(deps.successActionRequests.value.length, 2);
  assert.equal(deps.hasLineTemplate.value, false, '紙本批次不應產生 LINE 範本');
  assert.equal(deps.lineBatchParts.value.length, 0, '紙本批次不應產生 LINE 分卡');
  assert.equal(deps.showSuccessModal.value, false, '紙本批次不應顯示線上成功 Modal');
  if (courseAdjustmentOnly) {
    assert.ok(sent[0].requests.every(row => row['請假時間類型'] === '' && row['請假時間'] === ''));
  }
  assert.equal(batchSlots.value.length, 0);
}

function runRechangeLabelTest() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('const findPriorDutyAtSlot =');
  const end = source.indexOf('const formatHistoryLeaveSlot =', start);
  assert.ok(start >= 0 && end > start, 'rechange detector block must remain discoverable');
  const context = {
     substitutionRecords: ref([{
        id: 'exchange-1_2',
        requestId: 'exchange-1',
       date: '2026-09-04',
       period: 2,
       originalTeacherEmail: '申請人',
       actualTeacherEmail: '受邀人',
       className: '904'
     }, {
       id: 'exchange-1_1',
       requestId: 'exchange-1',
       date: '2026-09-02',
       period: 5,
       originalTeacherEmail: '受邀人',
        actualTeacherEmail: '申請人',
        className: '904'
      }]),
     requestsList: ref([{
       id: 'admin-rejected-prior',
       status: 'admin_rejected'
     }]),
    String,
    Number,
    Array,
    Math,
    parseInt,
     isNaN,
     isExchangeLikeRequest: req => {
       const type = String(req && req.type || '').trim().toLowerCase();
       return type === 'exchange' || type === '對調' || type === 'triangle'
         || type === '三角調' || !!(req && req.triangleId);
     }
  };
  vm.createContext(context);
  const detector = vm.runInContext(`(() => {
    ${source.slice(start, end)}
    return { isHistoryLeaveRechanged, isHistoryExchangeRechanged, isRequestLeaveRechanged, isRequestExchangeRechanged };
  })()`, context);
  const request = {
    id: 'exchange-1',
    type: 'exchange',
    requesterEmail: '申請人',
    requestDate: '2026-09-04',
    requestPeriod: 2,
    targetTeacherEmail: '受邀人',
    targetDate: '2026-09-02',
    targetPeriod: 5
  };
  const history = {
    id: 'exchange-1_2',
    requestId: 'exchange-1',
    type: 'exchange',
    originalTeacherEmail: '申請人',
    actualTeacherEmail: '受邀人',
    date: '2026-09-04',
    period: 2,
    targetDate: '2026-09-02',
    targetPeriod: 5
  };
  assert.equal(detector.isRequestLeaveRechanged(request), false, 'current source edge must not be marked rechanged');
  assert.equal(detector.isRequestExchangeRechanged(request), false, 'current target edge must not be marked rechanged');
   assert.equal(detector.isHistoryLeaveRechanged(history), false, 'current history source edge must not be marked rechanged');
   assert.equal(detector.isHistoryExchangeRechanged(history), false, 'current history target edge must not be marked rechanged');
   context.substitutionRecords.value.push({
     requestId: 'admin-rejected-prior',
     status: 'approved',
     date: '2026-09-04',
     period: 2,
     originalTeacherEmail: '申請人',
     actualTeacherEmail: '其他教師',
     className: '701'
   }, {
     requestId: 'withdrawn-prior',
     status: 'withdrawn',
     date: '2026-09-02',
     period: 5,
     originalTeacherEmail: '受邀人',
     actualTeacherEmail: '其他教師',
     className: '702'
   });
   assert.equal(detector.isRequestLeaveRechanged(request), false, 'an admin-rejected prior change must not mark the source endpoint');
   assert.equal(detector.isRequestExchangeRechanged(request), false, 'a withdrawn prior change must not mark the target endpoint');
   context.substitutionRecords.value.push({
     requestId: 'exchange-0',
    date: '2026-09-04',
    period: 2,
    originalTeacherEmail: '申請人',
    actualTeacherEmail: '其他教師',
    className: '701'
  });
  assert.equal(detector.isRequestLeaveRechanged(request), true, 'a prior source change must mark the original endpoint');
  assert.equal(detector.isRequestExchangeRechanged(request), false, 'a prior source change must not mark the target endpoint');
  assert.equal(detector.isHistoryLeaveRechanged(history), true, 'history must mark a prior source change on the original endpoint');
  assert.equal(detector.isHistoryExchangeRechanged(history), false, 'history must not mark the untouched target endpoint');
  context.substitutionRecords.value.push({
    requestId: 'exchange-2',
    date: '2026-09-02',
    period: 5,
    originalTeacherEmail: '受邀人',
    actualTeacherEmail: '其他教師',
    className: '702'
  });
  assert.equal(detector.isRequestLeaveRechanged(request), true, 'both endpoints must remain independently marked');
  assert.equal(detector.isRequestExchangeRechanged(request), true, 'a prior target change must mark the target endpoint');
  assert.equal(detector.isHistoryLeaveRechanged(history), true, 'history must keep the source marker when both endpoints changed');
  assert.equal(detector.isHistoryExchangeRechanged(history), true, 'history must mark the target endpoint when both endpoints changed');
}

Promise.resolve()
  .then(() => runLineTemplateTest())
  .then(() => runCourseDisplayFormatTest())
  .then(() => runTriangleLineFormatTest())
  .then(() => runProgressTest())
  .then(() => runFieldMapTest())
  .then(() => runRequestListSortTest())
  .then(() => runExchangePaperRecordMappingTest())
  .then(() => runApplicationFormContractTest())
  .then(() => runHistoryEditTeacherValueTest())
  .then(() => runCombinedHistoryEditContractTest())
  .then(runConsecutiveWarningTest)
  .then(runSingleTest)
  .then(runLineHandledSlotTest)
  .then(runCourseAdjustmentTest)
  .then(runRechangeLabelTest)
  .then(runBatchTest)
  .then(() => runBatchTest(true))
  .then(() => runBatchTest(false, true))
  .then(() => console.log('paper flow contract tests PASS'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
