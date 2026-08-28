#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const NameKey = require('../name-key-contract.js');

const teachers = [
  { '學期代號': '115-1', '教師Email': 'a@example.test', '教師姓名': '王老師' },
  { '學期代號': '115-1', '教師Email': 'b@example.test', '教師姓名': '李老師' },
  { '學期代號': '114-2', '教師Email': 'a@example.test', '教師姓名': '王老師' }
];

for (const sheetName of ['教師課表', '申請單', '代導紀錄', '額度帳本']) {
  assert.equal(
    NameKey.canonicalHeaders(sheetName).some(header => /email|電子郵件|e-mail/i.test(header)),
    false,
    `${sheetName} canonical schema must not contain Email fields`
  );
}

assert.equal(NameKey.resolveName('a@example.test', NameKey.buildDirectory(teachers), '115-1'), '王老師');
assert.equal(NameKey.resolveName('李老師', NameKey.buildDirectory(teachers), '115-1'), '李老師');

assert.throws(
  () => NameKey.buildDirectory(teachers.concat({ '學期代號': '115-1', '教師Email': 'c@example.test', '教師姓名': '王老師' })),
  error => error.code === 'DUPLICATE_TEACHER_NAME'
);

assert.throws(
  () => NameKey.buildDirectory(teachers.concat({ '學期代號': '113-1', '教師Email': 'c@example.test', '教師姓名': '王老師' })),
  error => error.code === 'DUPLICATE_GLOBAL_TEACHER_NAME'
);

const request = NameKey.migrateRow('申請單', {
  '學期代號': '115-1',
  '申請單ID': 'req-1',
  '申請人Email': 'a@example.test',
  '受邀人Email': 'b@example.test',
  '代申請人Email': '',
  '班級': '701',
  '特殊標記': '保留此欄'
}, NameKey.buildDirectory(teachers), '115-1');
assert.equal(request['申請人姓名'], '王老師');
assert.equal(request['受邀人姓名'], '李老師');
assert.equal(request['特殊標記'], '保留此欄');
assert.equal(Object.keys(request).some(key => /Email|email/i.test(key)), false);

const combinedReturn = NameKey.migrateRow('申請單', {
  '學期代號': '115-1',
  '申請單ID': 'req-combined',
  '申請人Email': 'a@example.test',
  '特殊流程': 'combined_return',
  '受邀人Email': '',
  '受邀人姓名': '',
  '班級': '701、702'
}, NameKey.buildDirectory(teachers), '115-1');
assert.equal(combinedReturn['申請人姓名'], '王老師');
assert.equal(combinedReturn['受邀人姓名'], '');
assert.equal(combinedReturn['特殊流程'], '合班回原班');
assert.equal(Object.keys(combinedReturn).some(key => /Email|email/i.test(key)), false);

assert.throws(
  () => NameKey.migrateRow('申請單', {
    '學期代號': '115-1',
    '申請單ID': 'req-combined-invalid',
    '申請人Email': 'a@example.test',
    '受邀人Email': 'b@example.test',
    '特殊流程': '合班回原班'
  }, NameKey.buildDirectory(teachers), '115-1'),
  error => error.code === 'INVALID_COMBINED_RETURN'
);

const ledger = NameKey.migrateRow('額度帳本', {
  '學期代號': '115-1',
  '教師Email': 'a@example.test',
  '異動': 1,
  '操作者': 'b@example.test'
}, NameKey.buildDirectory(teachers));
assert.equal(ledger['教師姓名'], '王老師');
assert.equal(ledger['操作者'], '李老師');
assert.equal(ledger['索引鍵'], '115-1|王老師');

assert.throws(
  () => NameKey.migrateRow('教師課表', {
    '學期代號': '115-1',
    '教師Email': 'missing@example.test',
    '教師姓名': '王老師'
  }, NameKey.buildDirectory(teachers)),
  error => error.code === 'UNMAPPED_TEACHER'
);

const renamed = NameKey.renameRows([
  { '學期代號': '115-1', '教師姓名': '王老師', '索引鍵': '115-1|王老師' },
  { '學期代號': '115-1', '申請人姓名': '王老師', '受邀人姓名': '李老師' },
  { '學期代號': '115-1', '原導師姓名': '李老師', '代導教師姓名': '王老師' },
  { '學期代號': '115-1', '教師姓名': '王老師', '操作者': '王老師' },
  { '學期代號': '114-2', '教師姓名': '王老師' }
], '115-1', '王老師', '王大明');
assert.equal(renamed[0]['教師姓名'], '王大明');
assert.equal(renamed[0]['索引鍵'], '115-1|王大明');
assert.equal(renamed[1]['申請人姓名'], '王大明');
assert.equal(renamed[2]['代導教師姓名'], '王大明');
assert.equal(renamed[3]['操作者'], '王大明');
assert.equal(renamed[4]['教師姓名'], '王老師');

console.log('name-key contract tests PASS');
