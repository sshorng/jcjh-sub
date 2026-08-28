#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'code.gs'), 'utf8');

new vm.Script(source, { filename: 'code.gs' });

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
