#!/usr/bin/env node
/**
 * Domain 純邏輯單元測試（Node CLI）
 * 與 tests/domain-tests.html 共用同一份測試體（讀取自 HTML 內嵌 script），
 * 改測試邏輯只需編輯 domain-tests.html。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// browser globals shim：domain-*.js 以 window.X = IIFE 掛載
global.window = global;

const DIR = path.join(__dirname, '..');
const FILES = [
  'domain-match.js',
  'domain-schedule.js',
  'domain-class-away.js',
  'domain-activity-cover.js',
  'domain-billing.js',
  'fee-utils.js'
];
for (const f of FILES) {
  try {
    require(path.join(DIR, f));
  } catch (e) {
    console.error('載入失敗: ' + f + ' → ' + e.message);
    process.exit(1);
  }
}

const html = fs.readFileSync(path.join(__dirname, 'domain-tests.html'), 'utf8');
const m = html.match(/<script>\s*\(function \(\) \{[\s\S]*?\}\)\(\);\s*<\/script>\s*<\/body>/);
if (!m) {
  console.error('domain-tests.html 內找不到測試體（IIFE script）');
  process.exit(1);
}
let body = m[0]
  .replace(/^<script>\s*/, '')
  .replace(/<\/script>\s*<\/body>$/, '');

// 把 DOM 輸出段換成 Node 輸出（含 exit code）
body = body.replace(/document\.getElementById\('summary'\)[\s\S]*$/, `
      console.log('── domain tests ──');
      console.log(failed === 0 ? '全部通過 ' + passed + ' 項' : '失敗 ' + failed + ' / 通過 ' + passed);
      log.forEach(function (l) { if (l.indexOf('✗') === 0) console.log(l); });
      if (failed === 0) console.log('PASS');
      process.exit(failed === 0 ? 0 : 1);
    })();`);

try {
  (0, eval)(body);
} catch (e) {
  console.error('測試執行錯誤: ' + e.message);
  console.error(e.stack);
  process.exit(1);
}