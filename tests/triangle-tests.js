#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'domain-triangle.js'), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'domain-triangle.js' });
const Triangle = context.window.DomainTriangle;

const participants = [
  { teacher: '甲', slot: { date: '2026-09-01', day: 2, period: 1 }, course: { className: '701', subject: '國文' } },
  { teacher: '乙', slot: { date: '2026-09-02', day: 3, period: 2 }, course: { className: '701', subject: '數學' } },
  { teacher: '丙', slot: { date: '2026-09-03', day: 4, period: 3 }, course: { className: '701', subject: '英文' } }
];
const legs = Triangle.buildCycleLegs(participants);

const occupied = [
  { teacher: '甲', date: '2026-09-01', period: 1, className: '701', subject: '國文' },
  { teacher: '乙', date: '2026-09-02', period: 2, className: '701', subject: '數學' },
  { teacher: '丙', date: '2026-09-03', period: 3, className: '701', subject: '英文' }
];
const valid = Triangle.validateTriangle({ legs }, { occupiedByTeacher: occupied });
assert.equal(valid.ok, true);
assert.equal(valid.assignments.length, 3);
assert.equal(valid.assignments[0].addSlot.date, '2026-09-02');

const intermediateConflict = Triangle.validateTriangle({ legs }, {
  occupiedByTeacher: occupied.concat([
    { teacher: '甲', date: '2026-09-02', period: 2, className: '704', subject: '自然' }
  ])
});
assert.equal(intermediateConflict.ok, false);
assert.match(intermediateConflict.errors.join('、'), /最終時段衝堂/);

const brokenCycle = Triangle.validateTriangle({ legs: legs.map((leg, index) => index === 1
  ? Object.assign({}, leg, { targetTeacher: '甲', targetSlot: participants[0].slot, targetCourse: participants[0].course })
  : leg) }, { occupiedByTeacher: occupied });
assert.equal(brokenCycle.ok, false);
assert.match(brokenCycle.errors.join('、'), /閉環|原課|時段/);

const patrol = Triangle.validateTriangle({ legs: legs.map((leg, index) => index === 0
  ? Object.assign({}, leg, { sourceCourse: { className: '巡堂', subject: '巡堂', attr: '巡堂' } })
  : leg) }, { occupiedByTeacher: occupied });
assert.equal(patrol.ok, false);
assert.match(patrol.errors.join('、'), /有效一般課程/);

const crossClass = Triangle.validateTriangle({ legs: legs.map((leg, index) => index === 1
  ? Object.assign({}, leg, { sourceCourse: { className: '702', subject: leg.sourceCourse.subject } })
  : leg) }, { occupiedByTeacher: occupied });
assert.equal(crossClass.ok, false);
assert.match(crossClass.errors.join('、'), /同一班/);

console.log('triangle domain tests PASS');
