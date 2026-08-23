#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const context = { console, Object, String, Array, Number, RegExp, Math, JSON };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'code.gs'), 'utf8'), context, { filename: 'code.gs' });

function patrolRow(id, email, name, extra) {
  return Object.assign({
    '學期代號': '115-1',
    '課表ID': id,
    '教師Email': email,
    '教師姓名': name,
    '星期': 2,
    '節次': 3,
    '班級': '',
    '科目': '',
    '課堂屬性': '巡堂',
    '調課限制': ''
  }, extra || {});
}

assert.doesNotThrow(function () {
  context.validateScheduleImportRows_([patrolRow('P1', 'a@school.example', '甲')], '115-1');
});

assert.throws(function () {
  context.validateScheduleImportRows_([
    patrolRow('P1', 'a@school.example', '甲'),
    patrolRow('P2', 'b@school.example', '乙')
  ], '115-1');
}, /只能安排一位巡堂教師/);

const legacy = patrolRow('P3', 'a@school.example', '甲', {
  '班級': '巡堂',
  '科目': '巡堂',
  '課堂屬性': ''
});
const legacyList = [legacy];
context.validateScheduleImportRows_(legacyList, '115-1');
assert.equal(legacyList[0]['班級'], '');
assert.equal(legacyList[0]['科目'], '');
assert.equal(legacyList[0]['課堂屬性'], '巡堂');

const fieldContext = { window: {} };
vm.createContext(fieldContext);
vm.runInContext(fs.readFileSync(path.join(root, 'field-map.js'), 'utf8'), fieldContext, { filename: 'field-map.js' });
const mapped = fieldContext.window.FieldMap.mapSchedule({
  '班級': '', '科目': '', '課堂屬性': '巡堂', '教師Email': 'a@school.example', '星期': 2, '節次': 3
});
assert.equal(mapped.className, '');
assert.equal(mapped.subject, '');
assert.equal(mapped.attr, '巡堂');

const specialMapped = fieldContext.window.FieldMap.mapSchedule({
  '課表ID': 'S2',
  '班級': '701',
  '科目': '體育',
  '課堂屬性': '超鐘點',
  '調課限制': '綁課',
  '特殊標記': '併班、綁課、預排',
  '教師Email': 'b@school.example',
  '星期': 1,
  '節次': 2
});
assert.equal(specialMapped.attr, '超鐘點');
assert.equal(specialMapped.restriction, 'restricted');
assert.equal(specialMapped.specialTags, '併班、綁課、預排');
assert.equal(specialMapped.isPreplanned, true);

assert.doesNotThrow(function () {
  context.validateScheduleImportRows_([{
    '學期代號': '115-1',
    '課表ID': 'S2',
    '教師Email': 'b@school.example',
    '教師姓名': '乙',
    '星期': 1,
    '節次': 2,
    '班級': '701、702',
    '科目': '體育',
    '課堂屬性': '超鐘點',
    '調課限制': 'restricted',
    '特殊標記': '併班、綁課'
  }], '115-1');
});

console.log('patrol contract tests PASS');
