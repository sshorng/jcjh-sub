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
    window: {},
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
    return { buildLineInviteText, buildAskFirstLineText, buildLineBatchInviteText };
  })()`, {
    window: { location: { origin: 'https://school.example', pathname: '/index.html' } },
    String, encodeURIComponent
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
  assert.match(single, /小明老師，想問您是否可以幫忙協助代課：/);
  assert.match(single, /09\/04（週五） 第1節｜904 國文（陳小華老師）/);
  assert.match(single, /✅ 可以/);
  assert.doesNotMatch(single, /詳細如下|非常感謝/);

  const ask = templates.buildAskFirstLineText({
    targetName: '王小明老師', requesterName: '陳小華老師',
    dateA: '2026-09-04', dayA: 5, periodA: 1,
     classA: '904', subjectA: '國文'
  });
  assert.match(ask, /小明老師，想問您是否可以幫忙協助代課：/);
  assert.match(ask, /09\/04（週五） 第1節｜904 國文（陳小華老師）/);
  assert.match(ask, /如果可以，我再拿代課單給您，感謝/);
  assert.doesNotMatch(ask, /再麻煩您確認一下喔/);

  const askSelf = templates.buildAskFirstLineText({
    targetName: '王小明老師',
    dateA: '2026-09-04', dayA: 5, periodA: 1, classA: '904', subjectA: '國文'
  });
  assert.doesNotMatch(askSelf, /（陳小華老師）/);

  const askExchange = templates.buildAskFirstLineText({
    targetName: '王小明老師',
    dateA: '2026-08-28', dayA: 5, periodA: 2, classA: '904', subjectA: '國文',
    isExchange: true,
    dateB: '2026-08-26', dayB: 3, periodB: 5, classB: '904', subjectB: '輔導'
  });
  assert.match(askExchange, /小明老師，想問您是否方便和我調課：/);
  assert.match(askExchange, /如果可以，我再拿調課單給您，感謝/);
  assert.doesNotMatch(askExchange, /簽名/);

  const batch = templates.buildLineBatchInviteText({
    targetName: '王小明老師', requesterName: '陳小華老師', batchId: 'B1', systemUrl: 'https://school.example/',
    slots: [
      { id: '1', date: '2026-09-04', day: 5, period: 1, className: '904', subject: '國文' },
      { id: '2', date: '2026-09-04', day: 5, period: 2, className: '905', subject: '國文' }
    ]
  });
  assert.match(batch, /小明老師，想問您是否可以幫忙協助以下代課：/);
  assert.match(batch, /904 國文（陳小華老師）/);
  assert.match(batch, /全部可以/);
  assert.match(batch, /感謝/);
  assert.doesNotMatch(batch, /經費來源|調代課系統訊息/);

  const paper = templates.buildAskFirstLineText({
    targetName: '王小明老師', requesterName: '陳小華老師',
    dateA: '2026-09-04', dayA: 5, periodA: 1, classA: '904', subjectA: '國文', reason: '事假'
  });
  assert.match(paper, /小明老師，想問您是否可以幫忙協助代課：/);
  assert.match(paper, /09\/04（週五） 第1節｜904 國文（陳小華老師）/);
  assert.match(paper, /如果可以，我再拿代課單給您，感謝/);
  assert.doesNotMatch(paper, /假別：|紙本調代課通知|簽名後交回教學組|https?:\/\/|action=/);

  const paperBatch = templates.buildAskFirstLineText({
    targetName: '王小明老師', requesterName: '陳小華老師',
    slots: [
      { date: '2026-09-04', day: 5, period: 1, className: '904', subject: '國文' },
      { date: '2026-09-04', day: 5, period: 2, className: '905', subject: '國文' }
    ]
  });
  assert.match(paperBatch, /1\. 09\/04（週五） 第1節｜904 國文（陳小華老師）/);
  assert.match(paperBatch, /2\. 09\/04（週五） 第2節｜905 國文（陳小華老師）/);
  assert.match(paperBatch, /如果可以，我再拿代課單給您，感謝/);
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
}

function runApplicationFormContractTest() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /data-tour="compare-fee"/);
  assert.doesNotMatch(html, /代課鐘點費結算方式/);
  assert.match(html, /id="course-adjustment-only"/);
  assert.match(html, /@change="toggleCourseAdjustmentOnly"/);
  assert.match(html, /pendingRequestData\.mode === 'substitution' && !pendingRequestData\.courseAdjustmentOnly/);
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
    leaveReasonOptions: ['事假'],
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
      reason: '事假'
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
  assert.equal(showHistoryEditModal.value, true);
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
    DAC: () => null,
    isProxySubmitActive: () => false,
    canStaffProxySubmit: () => false,
    shouldProxySubmitForLeave: () => false,
    getProxyActor: () => ({ email: 'owner@school.example', name: '申請人' }),
    userEmail: () => 'owner@school.example'
  };
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
    lineCopyText: ref(''),
    hasLineTemplate: ref(false),
    showSuccessModal: ref(false),
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

async function runBatchTest(courseAdjustmentOnly = false) {
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
    isAdmin: ref(false),
    isQuotaDeductFee: () => false,
    QUOTA_DEDUCT_FEE: '扣額度',
    ACTIVITY_PUBLIC_FEE: '活動公費',
    PERIOD8_FEE: '第8節代課',
    defaultSubFeeForReason: () => '自費代課',
    assertQuotaDeductAllowed: () => true,
    loading: ref(false),
    loadingMessage: ref(''),
    currentSemester: ref('115-1'),
    directApproveMode: ref(false),
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
    hasLineTemplate: ref(false),
    lineBatchParts: ref([]),
    lineCopyText: ref(''),
    showSuccessModal: ref(false),
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
  assert.equal(sent[0].skipNotify, true);
  assert.ok(sent[0].requests.every(row => row['狀態'] === 'pending_admin' && row['紙本流程'] === 'TRUE'));
  assert.equal(printedRows.length, 2, 'paper records must be built before batch slots are cleared');
  if (courseAdjustmentOnly) {
    assert.ok(sent[0].requests.every(row => row['請假時間類型'] === '' && row['請假時間'] === ''));
  }
  assert.equal(batchSlots.value.length, 0);
}

Promise.resolve()
  .then(() => runLineTemplateTest())
  .then(() => runProgressTest())
  .then(() => runFieldMapTest())
  .then(() => runApplicationFormContractTest())
  .then(() => runHistoryEditTeacherValueTest())
  .then(runSingleTest)
  .then(runCourseAdjustmentTest)
  .then(runBatchTest)
  .then(() => runBatchTest(true))
  .then(() => console.log('paper flow contract tests PASS'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
