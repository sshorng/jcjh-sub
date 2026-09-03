#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'code.gs'), 'utf8');

new vm.Script(source, { filename: 'code.gs' });
const scheduleKeyStart = source.indexOf('function scheduleSlotKey_');
const scheduleKeyEnd = source.indexOf('function scheduleClassTokens_', scheduleKeyStart);
assert.ok(scheduleKeyStart >= 0 && scheduleKeyEnd > scheduleKeyStart, 'schedule version key helpers must remain discoverable');
const scheduleKeyContext = { String, parseInt };
vm.createContext(scheduleKeyContext);
vm.runInContext(source.slice(scheduleKeyStart, scheduleKeyEnd), scheduleKeyContext, { filename: 'code.gs.schedule-keys' });
const oldScheduleVersion = {
  '教師姓名': '王老師', '星期': 1, '節次': 2, '班級': '902', '科目': '體育', '課堂屬性': '一般'
};
const changedScheduleVersion = Object.assign({}, oldScheduleVersion, { '班級': '903', '科目': '自然' });
assert.equal(
  scheduleKeyContext.scheduleSlotGroupKey_(oldScheduleVersion),
  scheduleKeyContext.scheduleSlotGroupKey_(changedScheduleVersion),
  '課表新版本應允許變更班級與科目'
);
assert.notEqual(
  scheduleKeyContext.scheduleSlotGroupKey_(oldScheduleVersion),
  scheduleKeyContext.scheduleSlotGroupKey_(Object.assign({}, oldScheduleVersion, { '教師姓名': '李老師' })),
  '課表新版本仍須維持相同教師'
);
const saveScheduleStart = source.indexOf('} else if (action === "saveScheduleCell")');
const saveScheduleEnd = source.indexOf('} else if (action === "clearScheduleCell")', saveScheduleStart);
assert.ok(saveScheduleStart >= 0 && saveScheduleEnd > saveScheduleStart, 'save schedule action must remain discoverable');
const saveScheduleSource = source.slice(saveScheduleStart, saveScheduleEnd);
assert.match(saveScheduleSource, /scheduleSlotGroupKey_\(previousRow\) !== scheduleSlotGroupKey_\(reqData\)/, 'new schedule versions should compare stable slot groups');
assert.doesNotMatch(saveScheduleSource, /scheduleSlotKey_\(previousRow\) !== scheduleSlotKey_\(reqData\)/, 'new schedule versions must not require the old class');
assert.match(source, /jobTitle: String\(t\["職務"\] \|\| t\.jobTitle \|\| ""\)\.trim\(\)/, 'match candidates should include teacher job title');
assert.match(source, /\.split\(\/\[、,，;；\/／\|｜\\s\]\+\/\)/, 'server subject parser should accept common multi-subject separators');
assert.match(source, /function subjectDomainsForTeacher_\(teacher\)/, 'match candidates should merge roster and schedule subjects');
assert.match(source, /scheduleSubjectsByTeacher/, 'match candidates should index subjects found in schedules');
assert.match(source, /var isPrimarySubject = !!\(demandDomain && rosterDomains\[0\] === demandDomain\)/, 'match candidates should retain primary-subject priority');
assert.match(source, /\(b\.subjectMatchRank \|\| 0\) - \(a\.subjectMatchRank \|\| 0\)/, 'match candidates should sort primary subject before secondary subject');
const triangleInputStart = source.indexOf('function triangleInputRows_');
const triangleInputEnd = source.indexOf('function triangleGroupRowsForRequest_', triangleInputStart);
assert.ok(triangleInputStart >= 0 && triangleInputEnd > triangleInputStart, 'triangle input builder must remain discoverable');
const triangleInputSource = source.slice(triangleInputStart, triangleInputEnd);
assert.match(triangleInputSource, /payload\.reason \|\| payload\["請假事由"\].*\|\| "請假"/, 'triangle requests should use the entered reason and default to leave');
assert.match(triangleInputSource, /"請假事由": triangleReason/, 'triangle rows should persist the selected reason');
assert.match(triangleInputSource, /"備註": triangleText_\(raw\.note \|\| raw\["備註"\]\) \|\| triangleNote/, 'triangle rows should persist the entered reason note');
const triangleSubmitStart = source.indexOf('action === "submitTriangleRequest"');
const triangleSubmitEnd = source.indexOf('} else if (action === "submitRequest")', triangleSubmitStart);
assert.ok(triangleSubmitStart >= 0 && triangleSubmitEnd > triangleSubmitStart, 'triangle submit action must remain discoverable');
const triangleSubmitSource = source.slice(triangleSubmitStart, triangleSubmitEnd);
assert.doesNotMatch(triangleSubmitSource, /紙本模式暫不提供/, 'paper mode must support triangle submissions');
assert.match(triangleSubmitSource, /var trianglePaperFlow = !isOnlineSubstitutionEnabled_\(\)/, 'triangle paper flow must follow the system mode');
assert.match(triangleSubmitSource, /row\["三角同意狀態"\] = "paper_pending"/, 'paper triangle rows must wait for physical signatures');
assert.match(triangleSubmitSource, /status: trianglePaperFlow \? "pending_admin" : "pending_teacher"/, 'paper triangle rows must go to admin review');
assert.match(triangleSubmitSource, /physicalSignatureRequired: trianglePaperFlow/, 'paper triangle response must identify physical signatures');
const triangleApproveStart = source.indexOf('function approveTriangleRequest_');
const triangleApproveEnd = source.indexOf('function rejectTriangleRequest_', triangleApproveStart);
assert.ok(triangleApproveStart >= 0 && triangleApproveEnd > triangleApproveStart, 'triangle approval helper must remain discoverable');
const triangleApproveSource = source.slice(triangleApproveStart, triangleApproveEnd);
assert.match(triangleApproveSource, /var paperFlow = rows\.every\(function \(row\) \{ return isPaperFlowRow_\(row\); \}\)/, 'paper triangle approval must be recognized');
assert.match(triangleApproveSource, /if \(!paperFlow && !triangleGroupAllAgreed_\(rows\)\)/, 'online triangle approval must still require all digital consents');

const flowStart = source.indexOf('var SPECIAL_FLOW_COMBINED_RETURN_');
const flowEnd = source.indexOf('// ----------------- 姓名鍵資料契約 -----------------', flowStart);
assert.ok(flowStart >= 0 && flowEnd > flowStart, 'special flow contract must remain discoverable');
const flowContext = {
  isPaperFlowValue_: value => value === true || value === 1
    || ['true', '1', '是', '紙本'].includes(String(value == null ? '' : value).trim().toLowerCase()),
  nameKeyNorm_: value => String(value == null ? '' : value).trim().toLowerCase()
};
vm.createContext(flowContext);
vm.runInContext(source.slice(flowStart, flowEnd), flowContext, { filename: 'code.gs.special-flow' });
const validCombined = {
  '特殊流程': 'combined_return',
  '異動類型': 'substitution',
  '受邀人姓名': '受邀人',
  '受邀人Email': 'invitee@school.example',
  '異動節次': 1,
  '請假事由': '公假',
  '經費來源': '公費代課'
};
assert.doesNotThrow(() => flowContext.validateCombinedReturnRequest_(validCombined));
assert.doesNotThrow(() => flowContext.validateCombinedReturnRequest_(Object.assign({}, validCombined, {
  '異動節次': 8,
  '經費來源': '第8節代課'
})));
assert.equal(flowContext.combinedReturnExpectedFee_(validCombined), '公費代課');
assert.equal(flowContext.combinedReturnExpectedFee_(Object.assign({}, validCombined, {
  '請假事由': '事假'
})), '自費代課');
assert.throws(() => flowContext.validateCombinedReturnRequest_(Object.assign({}, validCombined, {
  '經費來源': '自費代課'
})), /依假別使用公費代課/);
assert.throws(() => flowContext.validateCombinedReturnRequest_(Object.assign({}, validCombined, {
  '請假事由': '合班回原班',
  '經費來源': '自費代課'
})), /選擇實際的請假假別/);
assert.throws(() => flowContext.validateCombinedReturnRequest_(Object.assign({}, validCombined, {
  '受邀人姓名': '',
  '受邀人Email': ''
})), /請指定同節併班代課教師/);

const start = source.indexOf('function _resolveExchangeSides_');
const end = source.indexOf('function _googleCalendarUrl_', start);
assert.ok(start >= 0 && end > start, 'exchange notification helpers must remain discoverable');

const context = {
  _dayFromDateStr_: value => {
    const date = new Date(String(value || '').replace(/-/g, '/'));
    if (Number.isNaN(date.getTime())) return '';
    return date.getDay() === 0 ? 7 : date.getDay();
  },
  _lookupScheduleClassSubject_: () => ({ className: '', subject: '' }),
  _isExchangeReq_: req => !!(req && (req.targetDate || req['對調目標日期'])),
  isCombinedReturnRequest_: req => !!(req && String(req.specialFlow || req['特殊流程'] || '').trim().toLowerCase() === 'combined_return'),
  _shortDay_: value => ({ 1: '一', 2: '二', 3: '三', 4: '四', 5: '五' })[String(value)] || '',
  _periodTimeSpan_: () => '08:00-08:45',
  escapeHtml_: value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context, { filename: 'code.gs.exchange' });

const request = {
  requesterName: '月幸',
  targetTeacherName: '英勝',
  requestDate: '2026-09-01',
  requestPeriod: 1,
  className: '703',
  subject: '數學',
  targetDate: '2026-09-03',
  targetPeriod: 2,
  targetClassName: '704',
  targetSubject: '國文'
};

const sides = context._resolveExchangeSides_(request);
assert.equal(sides.leaveClass, '703');
assert.equal(sides.leaveSubject, '數學');
assert.equal(sides.targetClass, '704');
assert.equal(sides.targetSubject, '國文');

const allRoles = context._buildApproveSlotListHtml_([request], { itemsOnly: true });
const leaveRole = context._buildApproveSlotListHtml_([request], { role: 'leave', itemsOnly: true });
const coverRole = context._buildApproveSlotListHtml_([request], { role: 'cover', itemsOnly: true });
assert.equal(context._fmtSlotLine_('2026-09-02', 3, 5, '904', '國文'), '09/02(三) 第5節 904國文');
assert.equal(context._fmtSlotLine_('2026-09-02', '三', 5, '904', '國文'), '09/02(三) 第5節 904國文');
assert.match(allRoles, /703數學/);
assert.match(allRoles, /704國文/);
assert.match(leaveRole, /不用上 09\/01.*703數學.*改上 09\/03.*703數學/);
assert.match(coverRole, /不用上 09\/03.*704國文.*改上 09\/01.*704國文/);

const leaveCalendar = context._calendarDetailsForRole_(request, 'leave');
const coverCalendar = context._calendarDetailsForRole_(request, 'cover');
assert.match(leaveCalendar.title, /703\s+數學/);
assert.equal(leaveCalendar.startIso.slice(0, 8), '20260903');
assert.match(coverCalendar.title, /704\s+國文/);
assert.equal(coverCalendar.startIso.slice(0, 8), '20260901');

console.log('code.gs exchange contract tests PASS');
